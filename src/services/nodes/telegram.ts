// Master-side Telegram routing across connected nodes (#701): resolves candidate devices using
// cached payloads (live items, sleeping items, machine hints), asks online nodes over their door
// (`POST /api/node/telegram`), and holds messages in the master's scheduler (`kind: 'telegram'`,
// `why: 'node-offline'`) when the owning node is offline.
import { isRecord } from '../../adapters/json-store.ts'
import { addEntry, type NewEntry } from '../../adapters/schedule-store.ts'
import { LOCAL, nodesConfig } from '../../core/nodes.ts'
import { MAX_TELEGRAM_HOLD_CHARS, NODE_OFFLINE_WHY, type ScheduleEntry } from '../../core/schedule-rules.ts'
import type { Config } from '../../core/types.ts'
import { wakeConfig } from '../../core/wake/config.ts'
import {
  hintMachine,
  isRouteResult,
  matchNodeItem,
  type NodeRouteCandidate,
  offlineHeldNote,
  offlineRetryNote,
  orderNodeDevices,
  parseRouteItemsBody,
  type RouteResult,
} from '../../core/wake/node-route.ts'
import { formatPrompt } from '../../core/wake/route.ts'
import type { Answer } from '../node/bundle.ts'
import type { RemoteDeviceState } from '../scheduler.ts'
import type { NodeAggregate } from './aggregate.ts'
import type { NodeLinks } from './links.ts'

export interface NodesTelegram {
  route(body: unknown): Promise<Answer>
}

export interface NodesTelegramDeps {
  cfg: Config
  links: Pick<NodeLinks, 'link'>
  aggregate: Pick<NodeAggregate, 'devicePart'>
  deviceState(device: string): RemoteDeviceState
  holdEntry?(entry: NewEntry): ScheduleEntry
  onHeld?(): void
  log(text: string): void
  now?(): number
}

const MAX_HOLD_PROMPT_BYTES = 128 * 1024

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createNodesTelegram(deps: NodesTelegramDeps): NodesTelegram {
  const holdEntry = deps.holdEntry ?? (entry => addEntry(entry))
  const now = deps.now ?? Date.now

  return {
    async route(body) {
      const parsed = parseRouteItemsBody(body)
      if (!parsed) return { status: 400, body: { ok: false, error: 'body' } }
      const { items, liveOnly } = parsed
      const first = items[0]
      if (!first) return { status: 200, body: { matched: true, result: { ok: true } } }

      const conf = nodesConfig(deps.cfg.nodes)
      if (!conf) return { status: 404, body: { error: 'nodes' } }

      const candidates: NodeRouteCandidate[] = []
      for (const id of conf.order) {
        if (id === LOCAL) continue
        const dev = conf.devices[id]
        if (!dev?.link || dev.revoked) continue
        const state = deps.deviceState(id)
        if (state === 'revoked' || state === 'forgotten') continue
        const part = deps.aggregate.devicePart(id)
        candidates.push({
          id,
          title: dev.title || id,
          online: state === 'online',
          ...(part?.machine && { machine: part.machine }),
          items: part?.items ?? [],
        })
      }

      const ordered = orderNodeDevices(first, candidates)
      const fellOffline = new Set<string>()
      const timeoutMs = (wakeConfig(deps.cfg.wake).wakeTimeoutSec + 60) * 1000

      async function askDevice(id: string, bodyLiveOnly: boolean): Promise<RouteResult | null> {
        const link = deps.links.link(id)
        if (!link) {
          fellOffline.add(id)
          return null
        }
        try {
          const res = await link.fetch('/api/node/telegram', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items, ...(bodyLiveOnly && { liveOnly: true }) }),
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (!res.ok) {
            if (res.status === 503) fellOffline.add(id)
            return null
          }
          const data: unknown = await res.json().catch(() => null)
          if (isRecord(data) && data.matched === true && isRouteResult(data.result)) return data.result
          return null
        } catch {
          fellOffline.add(id)
          return null
        }
      }

      const online = ordered.filter(d => d.online)
      const pinned = first.pane ? hintMachine(first.pane) : null
      const pinnedMatch = !!(pinned && online[0]?.machine?.toLowerCase() === pinned.toLowerCase())
      // When an explicit <machine>:<pane> hint pins a known offline device, never let an unpinned
      // online device wake or steal the message; fall straight to the offline hold/retry path.
      const pinnedOffline = Boolean(
        pinned && ordered.some(d => !d.online && d.machine?.toLowerCase() === pinned.toLowerCase()),
      )

      if (!pinnedOffline) {
        if (!liveOnly && online.length > 1 && !pinnedMatch) {
          for (const d of online) {
            const r = await askDevice(d.id, true)
            if (r !== null) return { status: 200, body: { matched: true, result: r } }
          }
          for (const d of online) {
            if (fellOffline.has(d.id)) continue
            const r = await askDevice(d.id, false)
            if (r !== null) return { status: 200, body: { matched: true, result: r } }
          }
        } else {
          for (const d of online) {
            const r = await askDevice(d.id, liveOnly)
            if (r !== null) return { status: 200, body: { matched: true, result: r } }
          }
        }
      }

      if (!liveOnly) {
        const offline = ordered.filter(d => !d.online || fellOffline.has(d.id))
        for (const d of offline) {
          const state = deps.deviceState(d.id)
          if (state === 'revoked' || state === 'forgotten') continue
          const hit = matchNodeItem(first, d.items, d.machine)
          if (hit) {
            const at = now()
            const totalChars = items.reduce((sum, it) => sum + String(it.text ?? '').length, 0)
            const formatted = formatPrompt(items, at)
            if (totalChars > MAX_TELEGRAM_HOLD_CHARS || Buffer.byteLength(formatted, 'utf8') > MAX_HOLD_PROMPT_BYTES) {
              deps.log(
                `telegram: held batch exceeds offline limit (${totalChars} text chars, ${formatted.length} formatted chars) for ${hit.key}; asking tg-mcp to retry`,
              )
              return { status: 200, body: { matched: true, result: { retry: 60, note: offlineRetryNote(d.title) } } }
            }
            try {
              holdEntry({
                key: hit.key,
                name: hit.name,
                text: formatted,
                kind: 'telegram',
                telegramItems: items,
                at,
                next: at,
                pendingSince: at,
                why: NODE_OFFLINE_WHY,
                by: 'telegram',
              })
              deps.onHeld?.()
              deps.log(`telegram: held ${items.length} message(s) for ${hit.key} while ${d.id} is offline`)
              return { status: 200, body: { matched: true, result: { ok: true, note: offlineHeldNote(d.title) } } }
            } catch (err) {
              deps.log(`telegram: could not hold message for ${hit.key}: ${messageOf(err)}`)
              return { status: 200, body: { matched: true, result: { retry: 60, note: offlineRetryNote(d.title) } } }
            }
          }
          if (pinned && d.machine && d.machine.toLowerCase() === pinned.toLowerCase()) {
            return { status: 200, body: { matched: true, result: { retry: 60, note: offlineRetryNote(d.title) } } }
          }
        }
      }

      return { status: 200, body: { matched: false } }
    },
  }
}
