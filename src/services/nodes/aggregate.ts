// The master's devices in its payload (#500, docs/design/nodes 5, 6.5, 7.1): each node's last
// payload, from its link (services/nodes/links.ts), made into the remote part of the board's
// payload (core/node-items.ts nodePart: checked field by field, keys prefixed, a `device` on each)
// and the `devices` row of each device. Made by server/app.ts only once `nodes` is on; the board's
// own item list never holds what this gives (server/board-state.ts publish and findAny).
//
// Nothing of a node's payload but its items, launches and schedule entries leaves the link: its
// fsToken, profiles' folders, setup and limits stay in the link, inside this process, for the proxy.
//
// The offline copy: each node's part, checked and with the node's own keys, is written to
// `<state>/nodes/<id>/snapshot.json` (adapters/node-store.ts) at most every SNAPSHOT_MS after a new
// payload, and read when a device's link has brought none since the board started: an offline node's
// cards show after a restart, with the time they are from.
//
// Each device's status in its row is the one whose shown figures (core/nodes.ts statusShown) were
// last seen to move: a status every 30 s that rounds the same leaves the payload as it was, so no
// page gets the board again for it. This computer's own (`local`) is asked every status interval
// by the code a node answers with (`ownStatus`), and publishes when its figures move.
import { hostname } from 'node:os'
import { createDeviceStore, type DeviceStore } from '../../adapters/node-store.ts'
import { pace } from '../../adapters/pacing.ts'
import { type NodePart, nodePart } from '../../core/node-items.ts'
import {
  type DeviceConfig,
  type DeviceUpdate,
  type DeviceView,
  LOCAL,
  type NodeStatus,
  nodesConfig,
  parseNodeKey,
  statusShown,
} from '../../core/nodes.ts'
import type { BoardDevice } from '../../core/payload.ts'
import type { Config, Item } from '../../core/types.ts'
import { type Clock, realClock } from '../tunnel.ts'
import { STATUS_MS } from './link.ts'
import type { NodeLinks } from './links.ts'

/** What the master's payload adds while `nodes` is on. */
export interface RemotePart extends NodePart {
  devices: BoardDevice[]
}

export interface NodeAggregate {
  /** The devices' part of the payload; null while `nodes` is off. */
  part(): RemotePart | null
  /** A single device's checked part (from its live payload or offline copy); null when unknown or `nodes` is off. */
  devicePart(id: string): NodePart | null
  /** A remote item by its prefixed key (core/nodes.ts nodeKey), from the last payload or the offline copy. */
  find(key: string): Item | undefined
  /** The offline copies still due are written, and nothing more is. Synchronous, so an exit handler may call it. */
  close(): void
}

export interface NodeAggregateOptions {
  links: Pick<NodeLinks, 'on' | 'view' | 'link' | 'onChange'>
  /** The live config. */
  cfg: Config
  log(text: string): void
  /** A device's payload changed, its link's state, or the shown figures of a status: the board publishes again. */
  onChange(): void
  /** This computer's own status (services/node/status.ts), asked every `statusMs` while this lives. */
  ownStatus?: () => Promise<NodeStatus | null>
  /** How often `ownStatus` is asked (links.ts linkTimes: 30 s, paced in tests). */
  statusMs?: number
  store?: DeviceStore
  clock?: Clock
  hostName?: string
  /** A device's update to this board's commit (#590, services/nodes/update.ts), for its row. */
  update?: (id: string) => DeviceUpdate | null
  /** Whether a node item is allowed to set `call.parent` to another device's card (#730). */
  allowCallParent?: (device: string, parentKey: string) => boolean
}

/** The offline copy is written at most this often (paced in tests). */
export const SNAPSHOT_MS = 5000

const NONE: NodePart = { items: [], launches: [], schedules: [] }
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A device's row: its view without what ssh said, with what config.json sets for it. */
function boardDevice(
  view: DeviceView,
  device: DeviceConfig | undefined,
  at: number | null,
  status: NodeStatus | null,
): BoardDevice {
  // When the link last heard a byte, to the minute the page shows: a ping alone does not send the
  // whole board to every page and phone again.
  let link: BoardDevice['link'] = null
  if (view.link) {
    const { detail, heardAt, ...rest } = view.link
    link = { ...rest, heardAt: heardAt === null ? null : heardAt - (heardAt % 60_000) }
  }
  return {
    ...view,
    ...(device?.color && { color: device.color }),
    link,
    status,
    payloadAt: at ?? view.payloadAt,
    paused: device?.paused ?? false,
    drain: device?.drain ?? false,
    ...(device?.giveSecrets === false && { giveSecrets: false as const }),
    ...(device?.pilotBridge === false && { pilotBridge: false as const }),
    ...(device?.ownProfiles && { ownProfiles: true as const }),
    maxSessions: device?.maxSessions ?? null,
    minFreeMemMb: device?.minFreeMemMb ?? null,
    maxLoad: device?.maxLoad ?? null,
  }
}

export function createNodeAggregate(o: NodeAggregateOptions): NodeAggregate {
  const clock = o.clock ?? realClock
  const store = o.store ?? createDeviceStore()
  const host = o.hostName ?? hostname()
  /** Per device, the payload last checked and its part; a new payload is a new object. */
  const live = new Map<string, { raw: unknown; part: NodePart; at: number }>()
  /** Per device, its offline copy as read once (null: none). */
  const disk = new Map<string, { part: NodePart; at: number } | null>()
  /** The payload each device's offline copy was last written from. */
  const written = new Map<string, unknown>()
  const due = new Set<string>()
  let timer: unknown = null
  let closed = false
  /** Per device, the status last shown and its figures. */
  const shown = new Map<string, { key: string; status: NodeStatus }>()
  let own: NodeStatus | null = null
  let asking = false

  /** The status a row shows: the one held while the figures round the same. */
  function steady(id: string, status: NodeStatus | null): NodeStatus | null {
    if (!status) return null
    const key = statusShown(status)
    const held = shown.get(id)
    if (held?.key === key) return held.status
    shown.set(id, { key, status })
    return status
  }

  function publish(why: string): void {
    // Called from inside the link's stream: a publish that throws must not end it.
    try {
      o.onChange()
    } catch (err) {
      o.log(`${why}: publish: ${messageOf(err)}`)
    }
  }

  /** This computer's status, asked once; a publish when its figures moved. */
  async function askOwn(): Promise<void> {
    // `nodes` taken out of config.json while the board runs: nothing is asked.
    if (!o.ownStatus || asking || closed || !o.links.on()) return
    asking = true
    try {
      const got = await o.ownStatus()
      if (closed || !got) return
      const moved = statusShown(got) !== statusShown(own)
      own = got
      if (moved) publish('this computer')
    } catch (err) {
      o.log(`this computer's status: ${messageOf(err)}`)
    } finally {
      asking = false
    }
  }
  const ownTimer = o.ownStatus ? clock.setInterval(() => void askOwn(), o.statusMs ?? STATUS_MS) : null
  void askOwn()

  /** A device's part now: from its link's last payload, else from its offline copy; null with neither. */
  function current(id: string): { part: NodePart; at: number } | null {
    const partOpts = { allowParent: (parentKey: string) => o.allowCallParent?.(id, parentKey) ?? false }
    const link = o.links.link(id)
    const raw = link?.payload() ?? null
    if (link && raw) {
      let held = live.get(id)
      if (held?.raw !== raw) {
        held = { raw, part: nodePart(raw, id, partOpts) ?? NONE, at: link.view().payloadAt ?? clock.now() }
        live.set(id, held)
        // A link made again (its config changed) shows this, not the copy read at the start.
        disk.set(id, { part: held.part, at: held.at })
      }
      return held
    }
    if (!disk.has(id)) {
      const copy = store.snapshot(id)
      disk.set(id, copy ? { part: nodePart(copy.part, id, partOpts) ?? NONE, at: copy.at } : null)
    }
    return disk.get(id) ?? null
  }

  function write(): void {
    timer = null
    for (const id of due) {
      const link = o.links.link(id)
      const raw = link?.payload() ?? null
      if (!link || !raw || written.get(id) === raw) continue
      try {
        store.setSnapshot(id, { at: link.view().payloadAt ?? clock.now(), part: nodePart(raw, null) ?? NONE })
        written.set(id, raw)
      } catch (err) {
        o.log(`node ${id}: the offline copy: ${messageOf(err)}`)
      }
    }
    due.clear()
  }

  const off = o.links.onChange(id => {
    if (closed) return
    const raw = o.links.link(id)?.payload() ?? null
    if (raw && written.get(id) !== raw) {
      due.add(id)
      timer ??= clock.setTimeout(write, Math.round(SNAPSHOT_MS * pace()))
    }
    publish(`node ${id}`)
  })

  const remoteOf = (id: string): boolean => {
    if (id === LOCAL) return false
    const cfg = nodesConfig(o.cfg.nodes, host)
    return !!cfg?.devices[id]?.link
  }

  return {
    part() {
      if (closed || !o.links.on()) return null
      const cfg = nodesConfig(o.cfg.nodes, host)
      if (!cfg) return null
      const out: RemotePart = { items: [], launches: [], schedules: [], devices: [] }
      for (const view of o.links.view().devices) {
        const device = cfg.devices[view.id]
        const got = view.id !== LOCAL && device?.link ? current(view.id) : null
        const status = view.id === LOCAL ? own : view.status
        const update = view.id === LOCAL ? null : (o.update?.(view.id) ?? null)
        out.devices.push({
          ...boardDevice(view, device, got?.at ?? null, steady(view.id, status)),
          ...(update && { update }),
          // Its lanes as it has them (#923), for the device switch on it.
          ...(got?.part.lanes && { lanes: got.part.lanes }),
        })
        if (!got) continue
        out.items.push(...got.part.items)
        out.launches.push(...got.part.launches)
        out.schedules.push(...got.part.schedules)
      }
      return out
    },
    devicePart(id) {
      if (closed || !o.links.on() || !remoteOf(id)) return null
      return current(id)?.part ?? null
    },
    find(key) {
      const at = parseNodeKey(key)
      if (closed || !at || !o.links.on() || !remoteOf(at.device)) return undefined
      return current(at.device)?.part.items.find(i => i.key === key)
    },
    close() {
      if (closed) return
      closed = true
      off()
      if (ownTimer !== null) clock.clearInterval(ownTimer)
      if (timer !== null) clock.clearTimeout(timer)
      write()
    },
  }
}
