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
import { hostname } from 'node:os'
import { createDeviceStore, type DeviceStore } from '../../adapters/node-store.ts'
import { pace } from '../../adapters/pacing.ts'
import { type NodePart, nodePart } from '../../core/node-items.ts'
import { type DeviceConfig, type DeviceView, LOCAL, nodesConfig, parseNodeKey } from '../../core/nodes.ts'
import type { BoardDevice } from '../../core/payload.ts'
import type { Config, Item } from '../../core/types.ts'
import { type Clock, realClock } from '../tunnel.ts'
import type { NodeLinks } from './links.ts'

/** What the master's payload adds while `nodes` is on. */
export interface RemotePart extends NodePart {
  devices: BoardDevice[]
}

export interface NodeAggregate {
  /** The devices' part of the payload; null while `nodes` is off. */
  part(): RemotePart | null
  /** A remote item by its prefixed key (core/nodes.ts nodeKey), from the last payload or the offline copy. */
  find(key: string): Item | undefined
  /** The offline copies still due are written, and nothing more is. */
  close(): void
}

export interface NodeAggregateOptions {
  links: Pick<NodeLinks, 'on' | 'view' | 'link' | 'onChange'>
  /** The live config. */
  cfg: Config
  log(text: string): void
  /** A device's payload changed, or its link's state: the board publishes again. */
  onChange(): void
  store?: DeviceStore
  clock?: Clock
  hostName?: string
}

/** The offline copy is written at most this often (paced in tests). */
export const SNAPSHOT_MS = 5000

const NONE: NodePart = { items: [], launches: [], schedules: [] }
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A device's row: its view without what ssh said, with what config.json sets for it. */
function boardDevice(view: DeviceView, device: DeviceConfig | undefined, at: number | null): BoardDevice {
  const link = view.link ? (({ detail, ...rest }) => rest)(view.link) : null
  return {
    ...view,
    link,
    payloadAt: at ?? view.payloadAt,
    paused: device?.paused ?? false,
    drain: device?.drain ?? false,
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

  /** A device's part now: from its link's last payload, else from its offline copy; null with neither. */
  function current(id: string): { part: NodePart; at: number } | null {
    const link = o.links.link(id)
    const raw = link?.payload() ?? null
    if (link && raw) {
      let held = live.get(id)
      if (held?.raw !== raw) {
        held = { raw, part: nodePart(raw, id) ?? NONE, at: link.view().payloadAt ?? clock.now() }
        live.set(id, held)
      }
      return held
    }
    if (!disk.has(id)) {
      const copy = store.snapshot(id)
      disk.set(id, copy ? { part: nodePart(copy.part, id) ?? NONE, at: copy.at } : null)
    }
    return disk.get(id) ?? null
  }

  function write(): void {
    timer = null
    for (const id of due) {
      const link = o.links.link(id)
      const raw = link?.payload() ?? null
      if (!link || !raw || written.get(id) === raw) continue
      written.set(id, raw)
      try {
        store.setSnapshot(id, { at: link.view().payloadAt ?? clock.now(), part: nodePart(raw, null) ?? NONE })
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
    o.onChange()
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
        out.devices.push(boardDevice(view, device, got?.at ?? null))
        if (!got) continue
        out.items.push(...got.part.items)
        out.launches.push(...got.part.launches)
        out.schedules.push(...got.part.schedules)
      }
      return out
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
      if (timer !== null) clock.clearTimeout(timer)
      write()
    },
  }
}
