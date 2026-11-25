// Decisions on a node's page as its master holds them (#784, epic #763; #781 put the node sessions'
// questions with options on the master). The master gives the node its part of the queue and of what
// went by default with the payload's other master-run parts (GET /api/board-slices, core/board-slices.ts):
// only the node's own sessions, their keys as the node names them. The node shows a question its
// master holds as the master has it (Hold, when the default goes), and only while both agree it is
// open: its card still carries it and the master still lists it. No I/O.
import {
  type CardDecision,
  cardDecisionOf,
  type DecisionsPayload,
  type DecisionView,
  type DefaultedView,
  heldByMaster,
  orderQueue,
} from './decisions.ts'
import { parseNodeKey } from './nodes.ts'
import { hasUnprintable } from './team.ts'
import type { Card, Item } from './types.ts'

/**
 * The master's side: its queue and what went by default, cut to node `device`'s sessions with their
 * keys as the node names them (bare). Every other machine's questions stay on the master.
 */
export function decisionsForNode(p: DecisionsPayload, device: string): DecisionsPayload {
  const bare = (key: string): string | null => {
    const k = parseNodeKey(key)
    return k && k.device === device ? k.key : null
  }
  const items: DecisionView[] = []
  for (const d of p.items) {
    const key = bare(d.key)
    if (key) items.push({ ...d, key })
  }
  const defaulted: DefaultedView[] = []
  for (const d of p.defaulted) {
    const key = bare(d.key)
    if (key) defaulted.push({ ...d, key })
  }
  return { items, defaulted, defaults: p.defaults }
}

// What a node takes from its master's answer: at most this many rows, and characters in a field.
const ROWS_MAX = 200
const KEY_MAX = 1024
const ID_MAX = 64
const NAME_MAX = 256
const TEXT_MAX = 4000
const OPTIONS_MAX = 10
const OPTION_MAX = 500

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const word = (v: unknown, max: number): v is string => text(v, max) && v !== '' && !hasUnprintable(v)
const when = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const orNull = <T>(v: unknown, ok: (v: unknown) => v is T): v is T | null => v === null || ok(v)

function viewOf(raw: unknown): DecisionView | null {
  if (!isObject(raw)) return null
  const { key, id, who, lane, question, options, recommend, askedAt, defaultAt, held, thread, board } = raw
  if (!word(key, KEY_MAX) || !orNull(id, (v): v is string => word(v, ID_MAX))) return null
  if (!text(who, NAME_MAX) || !text(question, TEXT_MAX) || typeof held !== 'boolean') return null
  if (!Array.isArray(options) || options.length > OPTIONS_MAX || !options.every(o => text(o, OPTION_MAX))) return null
  if (!orNull(recommend, when) || !orNull(askedAt, when) || !orNull(defaultAt, when)) return null
  if (lane !== undefined && !word(lane, NAME_MAX)) return null
  if (thread !== undefined && !word(thread, NAME_MAX)) return null
  return {
    key,
    id,
    who,
    ...(lane !== undefined && { lane }),
    question,
    options: [...options],
    recommend,
    askedAt,
    defaultAt,
    held,
    ...(thread !== undefined && { thread }),
    ...(board === true && { board: true }),
  }
}

function defaultedOf(raw: unknown): DefaultedView | null {
  if (!isObject(raw)) return null
  const { id, key, who, question, answer, at } = raw
  if (!word(id, ID_MAX) || !word(key, KEY_MAX) || !text(who, NAME_MAX)) return null
  if (!text(question, TEXT_MAX) || !text(answer, TEXT_MAX) || !when(at)) return null
  return { id, key, who, question, answer, at }
}

/** The node's side: the part as its master's answer carries it, read field by field; null when it is none. */
export function decisionsSliceOf(raw: unknown): DecisionsPayload | null {
  if (!isObject(raw) || typeof raw.defaults !== 'boolean') return null
  const { items, defaulted } = raw
  if (!Array.isArray(items) || items.length > ROWS_MAX) return null
  if (!Array.isArray(defaulted) || defaulted.length > ROWS_MAX) return null
  const rows = items.map(viewOf)
  const went = defaulted.map(defaultedOf)
  if (rows.some(r => r === null) || went.some(d => d === null)) return null
  return { items: rows as DecisionView[], defaulted: went as DefaultedView[], defaults: raw.defaults }
}

/** A question its master holds as the node's card shows it: the master's Hold and default over the card's. */
function asMasterHolds(d: CardDecision, row: DecisionView): CardDecision {
  const { defaultAt: _at, held: _held, ...rest } = d
  return {
    ...rest,
    ...(row.defaultAt !== null && !row.held && { defaultAt: row.defaultAt }),
    // The page reads only whether it is held; the master keeps when.
    ...(row.held && { held: d.held ?? 0 }),
  }
}

/** A row of the node's own queue for a question it can no longer answer by button: a plain ask. */
const plainRow = (r: DecisionView): DecisionView => ({
  ...r,
  id: null,
  options: [],
  recommend: null,
  defaultAt: null,
  held: false,
})

/**
 * The node's side: its cards and its payload's queue with the master's part (`master`, from
 * decisionsSliceOf). A question its master holds shows as the master has it while its card still
 * carries it and the master still lists it; otherwise neither shows it (the card keeps its ask). A
 * decision of the node's own database (asked before #781) shows as a plain ask: the page's answers
 * go to the master, the session's terminal still closes it here. What went by default is the master's.
 * `cards`: this computer's cards, which say whose a decision is (core/decisions.ts masterHeld).
 */
export function withMasterDecisions<T extends Pick<Item, 'key' | 'decision'>>(
  items: readonly T[],
  own: DecisionsPayload | null,
  master: DecisionsPayload,
  cards: ReadonlyMap<string, Card>,
): { items: T[]; decisions: DecisionsPayload | null } {
  const carried = new Map<string, { id: string; master: boolean }>()
  for (const [key, card] of cards) {
    const d = card.ask ? cardDecisionOf(card.decision) : null
    if (d) carried.set(key, { id: d.id, master: heldByMaster(card.decision) })
  }
  const open = new Map<string, DecisionView>()
  for (const r of master.items) {
    const c = carried.get(r.key)
    if (r.id && c?.master && c.id === r.id) open.set(r.key, r)
  }
  const shown = items.map(item => {
    if (item.decision === undefined) return item
    const { decision, ...rest } = item
    const row = open.get(item.key)
    return (row && row.id === decision.id ? { ...rest, decision: asMasterHolds(decision, row) } : rest) as T
  })
  if (!own) return { items: shown, decisions: null }
  const mine = own.items.flatMap(r => {
    const c = r.id ? carried.get(r.key) : undefined
    if (!c) return [r]
    return c.master ? [] : [plainRow(r)]
  })
  return {
    items: shown,
    decisions: { ...own, items: orderQueue([...mine, ...open.values()]), defaulted: master.defaulted },
  }
}

/** The questions this computer's cards carry for its master (core/decisions.ts masterHeld), as one line to compare. */
export function masterHeldIds(cards: ReadonlyMap<string, Card>): string {
  const out: string[] = []
  for (const [key, card] of cards) {
    const d = card.ask && heldByMaster(card.decision) ? cardDecisionOf(card.decision) : null
    if (d) out.push(`${key}:${d.id}`)
  }
  return out.sort().join(' ')
}
