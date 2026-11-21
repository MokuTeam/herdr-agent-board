// The master's devices for `board nodes` and Settings, Devices (#499, #510, docs/design/nodes 12,
// 13): the devices in order with their links (services/nodes/links.ts), a link tried again at once,
// a profile's bundle synced to a device now (#506, services/nodes/bundle-sync.ts), a secret the
// owner gives one of a device's sinks (#507, design 10 item 3), and the panel's edits of
// config.json's `nodes`. On the local board only, and only while config.json's `nodes` is on:
// app.ts picks these routes for /api/nodes itself, so the board's route table, which every remote
// listener and a node's door serve, is the same as without `nodes`.
import type { EditResult } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import {
  applyNodesEdit,
  defaultThresholds,
  type NodeStatus,
  type NodesConfig,
  type NodesPanelSettings,
  nodesConfig,
  nodesEditOf,
} from '../../core/nodes.ts'
import { FIELD_NAME, MAX_FIELDS, SINK_ID } from '../../core/secrets.ts'
import type { BundleSync } from '../../services/nodes/bundle-sync.ts'
import type { NodeLinks } from '../../services/nodes/links.ts'
import { auditForwarded } from '../../services/secrets.ts'
import { json, type Route } from '../http.ts'

/**
 * `{ op: 'secret', id, sink, values, fingerprint }`: the values to the device's
 * `POST /api/node/sink/<sink>`, which checks the fingerprint against the sinks the bundle wrote there
 * and writes; its answer back, which never holds a value. The values cross this process's memory
 * only: not logged, not kept, and the audit line names the sink and the fields.
 */
async function secretToDevice(links: NodeLinks, body: Record<string, unknown>, id: string): Promise<Response> {
  const sink = body.sink
  if (typeof sink !== 'string' || !SINK_ID.test(sink)) return json(400, { error: 'sink' })
  const link = links.link(id)
  if (!link) return json(404, { error: 'device' })
  const s = link.state()
  if (s.state === 'refused' && s.reason === 'api') return json(503, { error: 'node-api', device: id })
  if (s.state !== 'online') return json(503, { error: 'node-offline', device: id })
  // A node that stops answering, or a link that goes down meanwhile, ends the wait: the values are
  // not held here longer than that.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), GIVE_MS)
  const offState = link.onState(now => {
    if (now.state !== 'online') ac.abort()
  })
  let res: Response
  let answer: unknown
  try {
    res = await link.fetch(`/api/node/sink/${sink}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: body.values, fingerprint: body.fingerprint }),
      signal: ac.signal,
    })
    answer = await res.json().catch(() => null)
  } catch {
    return ac.signal.aborted && link.state().state === 'online'
      ? json(504, { error: 'node-timeout', device: id })
      : json(503, { error: 'node-offline', device: id })
  } finally {
    clearTimeout(timer)
    offState()
  }
  const a = isRecord(answer) ? answer : {}
  // The names of what was sent, as a field may be named: the audit takes no other text from the caller.
  const fields = (isRecord(body.values) ? Object.keys(body.values) : [])
    .filter(f => FIELD_NAME.test(f))
    .slice(0, MAX_FIELDS)
  auditForwarded({ device: id, sink, fields, status: res.status })
  return json(res.status, {
    ok: a.ok === true,
    ...(typeof a.error === 'string' && { error: a.error }),
    ...(typeof a.target === 'string' && { target: a.target }),
    ...(typeof a.httpStatus === 'number' && { httpStatus: a.httpStatus }),
  })
}

/** How long a given secret waits for the node's answer. */
const GIVE_MS = 60_000

/** What Settings, Devices reads and writes besides the links (#510); app.ts hands in the real ones. */
export interface NodesPanel {
  /** config.json's `nodes` as the live config has it now. */
  config(): NodesConfig | null
  /** config-file.ts editNodes: refuses a config.json that does not parse. */
  edit(change: (nodes: Record<string, unknown>) => boolean): EditResult
  /** node-store.ts readLanesSeen and writeLanesSeen. */
  seen(): string[] | null
  keepSeen(ids: string[]): void
  /** This computer's own status, for its thresholds' placeholders; null while unknown. */
  ownStatus(): Promise<NodeStatus | null>
  /**
   * The device the next plain start would go to (services/nodes/placer.ts next) by `cfg`, the
   * section as written; null while it would wait.
   */
  next(cfg: NodesConfig | null): Promise<string | null>
}

export function nodesRoutes(links: NodeLinks, bundles?: BundleSync, panel?: NodesPanel): Route[] {
  const off = () => json(404, { error: 'nodes' })

  /** What the panel shows beside the devices: the section's own keys and the board's figures. */
  async function settingsOf(cfg: NodesConfig | null, devices = links.view().devices): Promise<NodesPanelSettings> {
    const defaults: NodesPanelSettings['defaults'] = {}
    for (const d of devices) if (d.status) defaults[d.id] = defaultThresholds(d.status)
    const own = await panel?.ownStatus().catch(() => null)
    if (own) defaults.local = defaultThresholds(own)
    return {
      whenFull: cfg?.whenFull ?? 'local',
      lanes: cfg?.lanes ?? [],
      seen: panel?.seen() ?? null,
      defaults,
      next: (await panel?.next(cfg).catch(() => null)) ?? null,
    }
  }

  return [
    {
      method: 'GET',
      path: '/api/nodes',
      async handle() {
        if (!links.on()) return off()
        const view = links.view()
        return json(200, panel ? { ...view, settings: await settingsOf(panel.config(), view.devices) } : view)
      },
    },
    {
      method: 'POST',
      path: '/api/nodes',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        if (!links.on()) return off()
        const body = await ctx.body()
        // Settings, Devices (#510): each edit held to nodesConfig's rules, written by editNodes.
        const edit = panel ? nodesEditOf(body) : null
        if (panel && edit) {
          if ('error' in edit) return json(400, { error: edit.error })
          let refused: string | null = null
          let after: NodesConfig | null = null
          const r = panel.edit(nodes => {
            const done = applyNodesEdit(nodes, edit)
            if ('error' in done) {
              refused = done.error
              return false
            }
            after = nodesConfig(nodes)
            return done.changed
          })
          if (refused) return json(400, { error: refused })
          if (!r.ok) return json(409, r)
          if (edit.op === 'lanes' && edit.shown) panel.keepSeen(edit.shown)
          return json(200, { ok: true, settings: await settingsOf(after) })
        }
        if (typeof body.id !== 'string') return json(400, { error: 'op' })
        if (body.op === 'sync' && bundles) {
          if (body.profile !== undefined && typeof body.profile !== 'string') return json(400, { error: 'profile' })
          return json(200, await bundles.syncIfBehind(body.id, body.profile))
        }
        if (body.op === 'secret') return secretToDevice(links, body, body.id)
        if (body.op !== 'retry') return json(400, { error: 'op' })
        return links.retry(body.id) ? json(200, { ok: true }) : json(404, { error: 'device' })
      },
    },
  ]
}
