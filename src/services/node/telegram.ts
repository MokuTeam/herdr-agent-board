// Node-side Telegram delivery (#701): served only on the node's master door (server/routes/node.ts).
// Delegates to the node's own wake process (`POST /route`) when wake is up so wake's session file,
// locks, and profile state stay consistent; falls back to direct local delivery via herdr when wake
// is off or unreachable.
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { isRecord } from '../../adapters/json-store.ts'
import { peekWakeSessions } from '../../adapters/wake-files.ts'
import { cliWakeHerdr, type WakeHerdr } from '../../adapters/wake-herdr.ts'
import type { ProfileSet } from '../../core/profiles.ts'
import type { Config } from '../../core/types.ts'
import { wakeConfig } from '../../core/wake/config.ts'
import { isRouteResult, nodeWakeTimeoutMs, parseRouteItemsBody } from '../../core/wake/node-route.ts'
import { resolve } from '../../core/wake/route.ts'
import type { WakeSessions } from '../../core/wake/sessions.ts'
import { type Follow, followFiles } from '../wake/follow.ts'
import { type Timing, wakeClaudeEntry } from '../wake/pane-ops.ts'
import { defaultTabOps, type TabOps } from '../wake/tabs.ts'
import { deliverTarget, routeSnapshot } from '../wake/telegram.ts'
import type { Answer } from './bundle.ts'

export interface NodeTelegram {
  route(body: unknown): Promise<Answer>
}

export interface NodeTelegramDeps {
  cfg: Config
  profiles(): ProfileSet
  herdr?: WakeHerdr
  readSessions?: () => WakeSessions
  tabs?: TabOps
  follow?: Follow
  machine?: string
  platform?: string
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  askWake?: boolean
  log(text: string): void
  refresh?(): void
  sleep?(ms: number): Promise<void>
  now?(): number
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createNodeTelegram(deps: NodeTelegramDeps): NodeTelegram {
  const herdr = deps.herdr ?? cliWakeHerdr
  const readSessions = deps.readSessions ?? (() => peekWakeSessions())
  const tabs = deps.tabs ?? defaultTabOps(path => existsSync(path))
  const follow = deps.follow ?? followFiles
  const machine = deps.machine ?? (process.env.COMPUTERNAME || hostname())
  const platform = deps.platform ?? process.platform
  const fetchFn = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const timing: Timing = {
    log: text => deps.log(text),
    ...(deps.sleep && { sleep: deps.sleep }),
    ...(deps.now && { now: deps.now }),
  }

  return {
    async route(body) {
      const parsed = parseRouteItemsBody(body)
      if (!parsed) return { status: 400, body: { ok: false, error: 'body' } }
      const { items, liveOnly } = parsed
      const first = items[0]
      if (!first) return { status: 200, body: { matched: true, result: { ok: true } } }

      const wake = wakeConfig(deps.cfg.wake)
      if (wake.enabled && deps.askWake !== false) {
        try {
          const res = await fetchFn(`http://127.0.0.1:${wake.port}/route`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items, ...(liveOnly && { liveOnly: true }) }),
            signal: AbortSignal.timeout(nodeWakeTimeoutMs(wake.wakeTimeoutSec)),
          })
          if (res.status === 503) return { status: 200, body: { matched: true, result: { retry: 15 } } }
          if (res.ok) {
            const ans: unknown = await res.json().catch(() => null)
            if (isRecord(ans) && ans.matched === false) return { status: 200, body: { matched: false } }
            if (isRecord(ans) && ans.matched === true && isRouteResult(ans.result)) {
              if ('ok' in ans.result) deps.refresh?.()
              return { status: 200, body: { matched: true, result: ans.result } }
            }
          }
        } catch {}
      }

      // Fallback when wake is off or unreachable: route directly via local herdr and wake-sessions.json.
      try {
        const snap = await herdr.snapshot()
        const sessions = readSessions()
        const target = resolve(first, routeSnapshot(snap), sessions, machine)
        if (!target || (liveOnly && target.session)) return { status: 200, body: { matched: false } }

        const result = await deliverTarget(target, items, {
          herdr,
          timing,
          log: deps.log,
          wakePane: t =>
            wakeClaudeEntry(t.pane, sessions[t.pane], t.session ?? '', {
              herdr,
              profiles: deps.profiles(),
              tabs,
              follow,
              timeoutMs: wake.wakeTimeoutSec * 1000,
              platform,
              timing,
              reuseLive: true,
              onAwake: async (pane, wasFreed) => {
                if (!wasFreed) await herdr.rename(pane, null).catch(() => {})
              },
            }),
        })
        if ('ok' in result) deps.refresh?.()
        return { status: 200, body: { matched: true, result } }
      } catch (err) {
        deps.log(`node telegram delivery failed: ${messageOf(err)}`)
        return { status: 200, body: { matched: true, result: { retry: 30 } } }
      }
    },
  }
}
