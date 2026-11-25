// The payload's master-run parts a node's page shows as its master has them (#780, epic #763 T4a):
// time, calendar, journal and presence; since T4b (#786) also the Team panel's revision and unread
// count, and the master's devices. The master gives them over the relay (GET /api/board-slices,
// core/master-relay.ts); the node keeps the last ones and puts them in its own payload, whose
// config.json no longer has these features (the handover took them out). No I/O.
import { BOARD_SLICE_KEYS } from './master-relay.ts'
import type { BoardDevice, BoardPayload } from './payload.ts'

/** The Team panel's numbers (#786): its revision and what is unread. What waits for the passkey stays on the master's screen. */
export const BOARD_SLICE_TEAM_KEYS = ['teamRev', 'teamUnread'] as const

export type BoardSlices = Partial<
  Pick<BoardPayload, (typeof BOARD_SLICE_KEYS)[number] | (typeof BOARD_SLICE_TEAM_KEYS)[number] | 'devices'>
>

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
  return out as BoardSlices
}

/** The parts as a master's answer carries them, or null when it is not an answer of that kind. */
export function boardSlicesOf(raw: unknown): BoardSlices | null {
  if (!isObject(raw) || raw.ok !== true || !isObject(raw.slices)) return null
  return slicesOf(raw.slices as Partial<BoardPayload>)
}

/**
 * The master's devices as node `self`'s page shows them (#786): this computer is the row with no
 * link (`local`), as a master's page shows its own, and the master's own row is named by its id,
 * heard while its relay stream is up (`online`). Null when the master does not list this node.
 */
export function devicesForNode(devices: readonly BoardDevice[], self: string, online: boolean): BoardDevice[] | null {
  const mine = devices.find(d => d.id === self)
  const master = devices.find(d => d.id === 'local')
  if (!mine || !master) return null
  const masterId = master.selfId || master.status?.id || ''
  if (!masterId || masterId === self) return null
  const now = Date.now()
  return devices.map(d => {
    if (d === mine) {
      const { selfId: _s, revoked: _r, update: _u, held: _h, ...rest } = d
      return { ...rest, id: 'local', selfId: self, kind: null, link: null }
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
      }
    }
    return d
  })
}

/**
 * The parts as they go into node `self`'s payload (#786): Team's numbers only while this board
 * runs no Team of its own, the devices only on a node that is no master itself (its own devices
 * stay), rebased by devicesForNode and marked `relayedDevices` for the page.
 */
export function nodeSlicesView(
  slices: BoardSlices,
  o: { self: string; ownTeam: boolean; ownDevices: boolean; online: boolean },
): Partial<BoardPayload> {
  const { devices, teamRev, teamUnread, ...rest } = slices
  const out: Partial<BoardPayload> = { ...rest }
  if (!o.ownTeam) {
    if (teamRev !== undefined) out.teamRev = teamRev
    if (teamUnread !== undefined) out.teamUnread = teamUnread
  }
  if (!o.ownDevices && devices) {
    const mine = devicesForNode(devices, o.self, o.online)
    if (mine) {
      out.devices = mine
      out.relayedDevices = true
    }
  }
  return out
}
