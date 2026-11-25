// The master's devices for `board nodes` and Settings, Devices (#499, #510, docs/design/nodes 12,
// 13): the devices in order with their links (services/nodes/links.ts), a link tried again at once,
// a profile's bundle synced to a device now (#506, services/nodes/bundle-sync.ts), a secret the
// owner gives one of a device's sinks (#507, design 10 item 3), the panel's edits of
// config.json's `nodes`, a device revoked (#510, design 11.4, services/nodes/revoke.ts), and this
// board's commit shipped to a device (#590, services/nodes/update.ts). On
// the local board only, and only while config.json's `nodes` is on: app.ts picks these routes for
// /api/nodes itself, so the board's route table, which every remote listener and a node's door
// serve, is the same as without `nodes`.
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
import type { ComputerSetup } from '../../services/nodes/computer-setup.ts'
import type { MasterHandover } from '../../services/nodes/handover.ts'
import type { NodeLinks } from '../../services/nodes/links.ts'
import type { RelaySetup } from '../../services/nodes/relay-setup.ts'
import type { Revoker } from '../../services/nodes/revoke.ts'
import type { NodeSetup } from '../../services/nodes/setup.ts'
import type { NodeUpdater } from '../../services/nodes/update.ts'
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

/**
 * "Add a server" (#509, services/nodes/setup.ts): the form's view, and Look, Apply, Continue, Undo
 * and Cancel. app.ts picks these for /api/nodes/setup itself, on the local board only and with or
 * without `nodes` (a board's first device makes it a master), so the route table every remote
 * listener and a node's door serve is the same as before; `setup` is made the first time one of
 * them is asked. Writes as the panel's own: X-Board and no other site's Origin.
 */
export function nodeSetupRoutes(setup: () => NodeSetup): Route[] {
  return [
    { method: 'GET', path: '/api/nodes/setup', handle: () => json(200, setup().view()) },
    {
      method: 'POST',
      path: '/api/nodes/setup',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const body = await ctx.body()
        const s = setup()
        const a =
          body.op === 'look'
            ? await s.look(body)
            : body.op === 'apply'
              ? await s.apply(body)
              : body.op === 'finish'
                ? await s.finish()
                : body.op === 'undo-look'
                  ? await s.undoLook(body)
                  : body.op === 'undo'
                    ? await s.undo(body)
                    : body.op === 'cancel'
                      ? s.cancel()
                      : { status: 400, body: { ok: false, error: 'op' } }
        return json(a.status, a.body)
      },
    },
  ]
}

/**
 * "Relay on the server" (#511, services/nodes/relay-setup.ts): local board only, lazy, keeping
 * the shared route table untouched.
 */
export function relaySetupRoutes(setup: () => RelaySetup): Route[] {
  return [
    { method: 'GET', path: '/api/nodes/relay/setup', handle: () => json(200, setup().view()) },
    {
      method: 'POST',
      path: '/api/nodes/relay/setup',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const body = await ctx.body()
        const s = setup()
        const a =
          body.op === 'look'
            ? await s.look(body)
            : body.op === 'apply'
              ? await s.apply(body)
              : body.op === 'finish'
                ? await s.finish()
                : body.op === 'undo-look'
                  ? await s.undoLook(body)
                  : body.op === 'undo'
                    ? await s.undo(body)
                    : body.op === 'cancel'
                      ? s.cancel()
                      : { status: 400, body: { ok: false, error: 'op' } }
        return json(a.status, a.body)
      },
    },
  ]
}

/**
 * "Add a computer" (#513, services/nodes/computer-setup.ts): local board only, lazy, keeping
 * the shared route table untouched.
 */
export function computerSetupRoutes(setup: () => ComputerSetup): Route[] {
  return [
    { method: 'GET', path: '/api/nodes/computer/setup', handle: () => json(200, setup().view()) },
    {
      method: 'POST',
      path: '/api/nodes/computer/setup',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const body = await ctx.body()
        const s = setup()
        const a =
          body.op === 'start'
            ? await s.start(body)
            : body.op === 'approve'
              ? await s.approve(body)
              : body.op === 'cancel'
                ? await s.cancel()
                : { status: 400, body: { ok: false, error: 'op' } }
        return json(a.status, a.body)
      },
    },
  ]
}

/**
 * Guided master handover (#697, services/nodes/handover.ts): local board only, lazy, keeping
 * the shared route table untouched.
 */
export function handoverRoutes(handover: () => MasterHandover): Route[] {
  return [
    { method: 'GET', path: '/api/nodes/handover', handle: () => json(200, handover().view()) },
    {
      method: 'POST',
      path: '/api/nodes/handover',
      guard: ['board-header', 'origin'],
      async handle(_req, ctx) {
        const body = await ctx.body()
        const h = handover()
        let sudoPassword: string | undefined
        if (body.sudoPassword !== undefined) {
          if (
            typeof body.sudoPassword !== 'string' ||
            /[\r\n]/.test(body.sudoPassword) ||
            body.sudoPassword.length > 1024
          ) {
            return json(400, { ok: false, error: 'sudoPassword' })
          }
          if (body.sudoPassword) sudoPassword = body.sudoPassword
        }
        if (body.op === 'check') {
          if (typeof body.to !== 'string' || !body.to) return json(400, { ok: false, error: 'missing target device' })
          try {
            const plan = await h.check({
              to: body.to,
              ...(typeof body.reverseLink === 'string' && { reverseLink: body.reverseLink }),
              ...(typeof body.nodePort === 'number' && { nodePort: body.nodePort }),
              ...(body.allowOfflineNodes === true && { allowOfflineNodes: true }),
              ...(sudoPassword !== undefined && { sudoPassword }),
            })
            const view = h.view()
            return json(200, { ok: true, plan, ...(view.need && { need: view.need }), view })
          } catch (err) {
            return json(409, { ok: false, error: err instanceof Error ? err.message : String(err), view: h.view() })
          }
        }
        if (body.op === 'run') {
          if (typeof body.to !== 'string' || !body.to) return json(400, { ok: false, error: 'missing target device' })
          const res = await h.run({
            to: body.to,
            ...(typeof body.reverseLink === 'string' && { reverseLink: body.reverseLink }),
            ...(typeof body.nodePort === 'number' && { nodePort: body.nodePort }),
            ...(body.allowOfflineNodes === true && { allowOfflineNodes: true }),
            ...(sudoPassword !== undefined && { sudoPassword }),
          })
          return json(res.ok ? 200 : 409, { ...res, view: h.view() })
        }
        if (body.op === 'rollback') {
          const res = await h.rollback({
            ...(typeof body.id === 'string' && { id: body.id }),
            ...(body.localOnly === true && { localOnly: true }),
            ...(body.discardSinceCommit === true && { discardSinceCommit: true }),
            ...(sudoPassword !== undefined && { sudoPassword }),
          })
          return json(res.ok ? 200 : 409, { ...res, view: h.view() })
        }
        if (body.op === 'cancel') {
          return json(200, { ok: true, view: h.cancel() })
        }
        return json(400, { ok: false, error: 'op' })
      },
    },
  ]
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
  /** Whether the device store holds a token for the device (node-store.ts), never the token. */
  hasToken(id: string): boolean
  /**
   * The device the next plain start would go to (services/nodes/placer.ts next) by `cfg`, the
   * section as written; null while it would wait.
   */
  next(cfg: NodesConfig | null): Promise<string | null>
}

export function nodesRoutes(
  links: NodeLinks,
  bundles?: BundleSync,
  panel?: NodesPanel,
  revoker?: Revoker,
  updater?: Pick<NodeUpdater, 'view' | 'ship'>,
  held?: () => Record<string, number>,
): Route[] {
  const off = () => json(404, { error: 'nodes' })
  /** The devices with each one's update (#590) and held entry count (#695) beside its link. */
  const viewWithUpdates = (): ReturnType<NodeLinks['view']> => {
    const view = links.view()
    const counts = held?.()
    if (!updater && !counts) return view
    return {
      ...view,
      devices: view.devices.map(d => {
        const update = updater && d.kind !== null ? updater.view(d.id) : null
        const n = d.kind !== null ? (counts?.[d.id] ?? 0) : 0
        return update || n > 0 ? { ...d, ...(update && { update }), ...(n > 0 && { held: n }) } : d
      }),
    }
  }

  /** What the panel shows beside the devices: the section's own keys and the board's figures. */
  async function settingsOf(cfg: NodesConfig | null, devices = links.view().devices): Promise<NodesPanelSettings> {
    const defaults: NodesPanelSettings['defaults'] = {}
    for (const d of devices) if (d.status) defaults[d.id] = defaultThresholds(d.status)
    const own = await panel?.ownStatus().catch(() => null)
    if (own) defaults.local = defaultThresholds(own)
    const hosts: NonNullable<NodesPanelSettings['hosts']> = {}
    for (const [id, d] of Object.entries(cfg?.devices ?? {}))
      if (d.link?.kind === 'ssh') hosts[id] = { host: d.link.host, sshPort: d.link.sshPort }
    return {
      hosts,
      whenFull: cfg?.whenFull ?? 'local',
      lanes: cfg?.lanes ?? [],
      seen: panel?.seen() ?? null,
      defaults,
      noToken: panel ? devices.filter(d => d.kind !== null && !panel.hasToken(d.id)).map(d => d.id) : [],
      next: (await panel?.next(cfg).catch(() => null)) ?? null,
      ...secretsOf(devices),
      ...(cfg?.relay && { relay: { host: cfg.relay.host, sshPort: cfg.relay.sshPort } }),
    }
  }
  /** Per linked device with any, the secrets given and to give (#604), from the last syncs: names only. */
  function secretsOf(devices: readonly { id: string; kind: unknown }[]): Pick<NodesPanelSettings, 'secrets'> {
    if (!bundles) return {}
    const out: NonNullable<NodesPanelSettings['secrets']> = {}
    for (const d of devices) {
      if (d.kind === null) continue
      const s = bundles.secrets(d.id)
      if (s.given.length || s.toGive.length) out[d.id] = s
    }
    return Object.keys(out).length ? { secrets: out } : {}
  }

  return [
    {
      method: 'GET',
      path: '/api/nodes',
      async handle() {
        if (!links.on()) return off()
        const view = viewWithUpdates()
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
        // `{ op: 'update', id }` (#590): this board's commit shipped to the device now.
        if (body.op === 'update' && updater) {
          if (!links.link(body.id)) return json(404, { error: 'device' })
          const r = await updater.ship(body.id)
          // Refused here (one under way, nothing to send, the device away or revoked): 409; the node's own failures: 502.
          const here = ['busy', 'no-checkout', 'offline', 'revoked'].includes(r.error ?? '')
          return json(r.ok ? 200 : here ? 409 : 502, r)
        }
        // `{ op: 'revoke', id, sleep?, forget? }`: sleep unless false, forget only when true.
        if (body.op === 'revoke' && revoker) {
          if (body.sleep !== undefined && typeof body.sleep !== 'boolean') return json(400, { error: 'sleep' })
          if (body.forget !== undefined && typeof body.forget !== 'boolean') return json(400, { error: 'forget' })
          const r = await revoker.revoke(body.id, { sleep: body.sleep !== false, forget: body.forget === true })
          return json(r.status, r.body)
        }
        if (body.op !== 'retry') return json(400, { error: 'op' })
        return links.retry(body.id) ? json(200, { ok: true }) : json(404, { error: 'device' })
      },
    },
  ]
}
