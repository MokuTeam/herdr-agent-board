// The payload's master-run parts a node's page shows as its master has them (#780, epic #763 T4a):
// time, calendar, journal and presence. The master gives them over the relay (GET /api/board-slices,
// core/master-relay.ts); the node keeps the last ones and puts them in its own payload, whose
// config.json no longer has these features (the handover took them out). No I/O.
import { BOARD_SLICE_KEYS } from './master-relay.ts'
import type { BoardPayload } from './payload.ts'

export type BoardSlices = Partial<Pick<BoardPayload, (typeof BOARD_SLICE_KEYS)[number]>>

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A payload's master-run parts: only those it has. */
export function slicesOf(payload: Partial<BoardPayload> | null): BoardSlices {
  const out: Record<string, unknown> = {}
  if (!payload) return out
  for (const key of BOARD_SLICE_KEYS) if (isObject(payload[key])) out[key] = payload[key]
  return out as BoardSlices
}

/** The parts as a master's answer carries them, or null when it is not an answer of that kind. */
export function boardSlicesOf(raw: unknown): BoardSlices | null {
  if (!isObject(raw) || raw.ok !== true || !isObject(raw.slices)) return null
  return slicesOf(raw.slices as Partial<BoardPayload>)
}
