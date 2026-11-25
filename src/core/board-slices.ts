// The payload's master-run parts a node's page shows as its master has them (#780, epic #763 T4a):
// time, calendar, journal and presence (threads' revision and count since #797); since T4b (#786) also the Team panel's revision and unread
// count, and the master's devices. The master gives them over the relay (GET /api/board-slices,
// core/master-relay.ts); the node keeps the last ones and puts them in its own payload, whose
// config.json no longer has these features (the handover took them out). No I/O.
import type { DecisionsPayload } from './decisions.ts'
import { deviceMarkerOf } from './device-marker.ts'
import { BOARD_SLICE_KEYS } from './master-relay.ts'
import { decisionsForNode, decisionsSliceOf } from './node-decisions.ts'
import type { BoardDevice, BoardPayload } from './payload.ts'

/** What devicesForNode reads of a device row: the payload's and GET /api/nodes' rows both have it. */
type DeviceRow = Pick<BoardDevice, 'id' | 'kind' | 'link' | 'status' | 'selfId' | 'revoked' | 'update' | 'held'>

/** The Team panel's numbers (#786): its revision and what is unread. What waits for the passkey stays on the master's screen. */
export const BOARD_SLICE_TEAM_KEYS = ['teamRev', 'teamUnread'] as const

export type BoardSlices = Partial<
  Pick<
    BoardPayload,
    (typeof BOARD_SLICE_KEYS)[number] | (typeof BOARD_SLICE_TEAM_KEYS)[number] | 'devices' | 'deviceMarker'
  >
> & {
  /**
   * The master's queue and what went by default for the asking node's sessions only, their keys as
   * the node names them (#784, core/node-decisions.ts): only in the answer to a node (withNodeDecisions).
   */
  decisions?: DecisionsPayload
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A payload's master-run parts: only those it has. */
export function slicesOf(payload: Partial<BoardPayload> | null): BoardSlices {
  const out: Record<string, unknown> = {}
  if (!payload) return out
  for (const key of BOARD_SLICE_KEYS) if (isObject(payload[key])) out[key] = payload[key]
  for (const key of BOARD_SLICE_TEAM_KEYS)
    if (typeof payload[key] === 'number' && Number.isFinite(payload[key])) out[key] = payload[key]
  if (Array.isArray(payload.devices) && payload.devices.every(d => isObject(d) && typeof d.id === 'string'))
    out.devices = payload.devices
  // How cards show their machine (#789): a node's page draws its master's, so they look alike.
  const marker = payload.deviceMarker === undefined ? null : deviceMarkerOf(payload.deviceMarker)
  if (marker) out.deviceMarker = marker
  return out as BoardSlices
}

/** The parts as a master's answer carries them, or null when it is not an answer of that kind. */
export function boardSlicesOf(raw: unknown): BoardSlices | null {
  if (!isObject(raw) || raw.ok !== true || !isObject(raw.slices)) return null
  const out = slicesOf(raw.slices as Partial<BoardPayload>)
  // A master since #784 gives the node's part of its decisions; an older one none (the node's own stay).
  const decisions = raw.slices.decisions === undefined ? null : decisionsSliceOf(raw.slices.decisions)
  return decisions ? { ...out, decisions } : out
}

/**
 * The master's answer to node `device`'s GET /api/board-slices (#784): the parts, with its decisions
 * (the latest payload's) cut to that node's sessions. A master with decisions off sends none.
 */
export function withNodeDecisions(
  slices: BoardSlices,
  decisions: DecisionsPayload | null,
  device: string,
): BoardSlices {
  return decisions ? { ...slices, decisions: decisionsForNode(decisions, device) } : slices
}

/**
 * The master's devices as node `self`'s page shows them (#786): this computer is the row with no
 * link (`local`), as a master's page shows its own, and the master's own row is named by its id,
 * heard while its relay stream is up (`online`). Null when the master does not list this node.
 */
export function devicesForNode<T extends DeviceRow>(devices: readonly T[], self: string, online: boolean): T[] | null {
  const mine = devices.find(d => d.id === self)
  const master = devices.find(d => d.id === 'local')
  if (!mine || !master) return null
  const masterId = master.selfId || master.status?.id || ''
  if (!masterId || masterId === self) return null
  const now = Date.now()
  return devices.map((d): T => {
    if (d === mine) {
      const { selfId: _s, revoked: _r, update: _u, held: _h, ...rest } = d
      return { ...rest, id: 'local', selfId: self, kind: null, link: null } as T
    }
    if (d === master) {
      const { selfId: _s, ...rest } = d
      return {
        ...rest,
        id: masterId,
        kind: mine.kind,
        link: {
          state: online ? 'online' : 'offline',
          since: now,
          heardAt: online ? now : (mine.link?.heardAt ?? null),
        },
      } as T
    }
    return d
  })
}

/**
 * The parts as they go into node `self`'s payload (#786): Team's numbers only while this board
 * runs no Team of its own, the devices only on a node that is no master itself (its own devices
 * stay), rebased by devicesForNode and marked `relayedDevices` (with the master's id) for the page;
 * the master's `deviceMarker` (#789) goes with them.
 */
export function nodeSlicesView(
  slices: BoardSlices,
  o: { self: string; ownTeam: boolean; ownDevices: boolean; online: boolean },
): Partial<BoardPayload> {
  // Decisions (#784) go with the node's own queue and cards (core/node-decisions.ts withMasterDecisions).
  const { devices, deviceMarker, teamRev, teamUnread, decisions: _decisions, ...rest } = slices
  const out: Partial<BoardPayload> = { ...rest }
  if (!o.ownTeam) {
    if (teamRev !== undefined) out.teamRev = teamRev
    if (teamUnread !== undefined) out.teamUnread = teamUnread
  }
  if (!o.ownDevices && devices) {
    const mine = devicesForNode(devices, o.self, o.online)
    const master = devices.find(d => d.id === 'local')
    if (mine && master) {
      out.devices = mine
      out.relayedDevices = { master: master.selfId || master.status?.id || '' }
      if (deviceMarker) out.deviceMarker = deviceMarker
    }
  }
  return out
}

/**
 * Devices' answer (GET or POST /api/nodes) as node `device`'s page and terminal read it (#786), in
 * the same terms as its payload: the rows by devicesForNode, the settings' per-device keys (`defaults`,
 * `hosts`, `secrets`, `noToken`, `next`) renamed the same way (`device` is `local`, the master's
 * `local` its id `selfId`), and `master`: that id. Anything that is no such answer as it came.
 */
export function nodesAnswerForNode(raw: unknown, device: string, selfId: string): unknown {
  if (!isObject(raw) || !device || !selfId) return raw
  const id = (v: string): string => (v === device ? 'local' : v === 'local' ? selfId : v)
  const keyed = (v: unknown): unknown =>
    isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [id(k), x])) : v
  const out: Record<string, unknown> = { ...raw, master: selfId }
  if (Array.isArray(raw.devices)) {
    const rows = devicesForNode(raw.devices as DeviceRow[], device, true)
    if (rows) out.devices = rows
  }
  if (isObject(raw.settings)) {
    const s = raw.settings
    out.settings = {
      ...s,
      ...(s.defaults !== undefined && { defaults: keyed(s.defaults) }),
      ...(s.hosts !== undefined && { hosts: keyed(s.hosts) }),
      ...(s.secrets !== undefined && { secrets: keyed(s.secrets) }),
      ...(Array.isArray(s.noToken) && { noToken: s.noToken.map(v => (typeof v === 'string' ? id(v) : v)) }),
      ...(typeof s.next === 'string' && { next: id(s.next) }),
    }
  }
  return out
}
