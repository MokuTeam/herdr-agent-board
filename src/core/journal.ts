// The away journal (#489): what changed on the board while the owner was away, with no model.
// The board notes each card's change of state (services/journal.ts, adapters/journal-store.ts);
// this module is the pure part: the config, a card's state as the journal keeps it, what one
// refresh changed against the states on record, the list the owner reads (`board journal`, the
// page's "While you were away" strip, the phone), and when the owner went away.
//
// config.json's `journal` turns it on: `true`, or { "returnMinutes": 15 } (how long an absence
// lasts before the page shows the strip). Without it nothing is recorded, read or shown.
import type { Presence } from './presence.ts'
import type { Item, Translator } from './types.ts'

/** What a card's state is to the journal: its column, with "stopped on an error" told apart. */
export type JournalKind = 'owner' | 'error' | 'done' | 'ext' | 'work' | 'idle'
/** The kinds a row of the list stands for; work and idle are only counted. */
export type RowKind = 'owner' | 'error' | 'done' | 'ext'
/** The groups in the order the owner needs them. */
export const ROW_ORDER: readonly RowKind[] = ['owner', 'error', 'done', 'ext']

export interface JournalConfig {
  /** Minutes an absence lasts at least before a return shows the strip. */
  returnMinutes: number
}
export const DEFAULT_RETURN_MINUTES = 15
/** Moves and the states of cards gone from the board are kept this long. */
export const KEEP_MS = 30 * 24 * 60 * 60_000
/** Rows of the list at most; the rest is "and N more". */
export const MAX_ROWS = 20
/** A line kept at most this long. */
export const LINE_MAX = 200

/** config.json's `journal`, or null while it is off (absent, false, anything but true or an object). */
export function journalConfig(raw: unknown): JournalConfig | null {
  if (raw === true) return { returnMinutes: DEFAULT_RETURN_MINUTES }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const m = (raw as Record<string, unknown>).returnMinutes
  const ok = typeof m === 'number' && Number.isFinite(m) && m >= 1 && m <= 24 * 60
  return { returnMinutes: ok ? m : DEFAULT_RETURN_MINUTES }
}

/** A card's state as the journal keeps it. `at`: when it went to this kind. */
export interface CardState {
  kind: JournalKind
  line: string
  name: string
  lane: string
  at: number
}
/** A card's state on record: `gone`, when it left the board (null while on it). */
export interface StateRow extends CardState {
  gone: number | null
}
/** One change of state. */
export interface Move extends CardState {
  key: string
}

// Control characters (an agent's text may carry escapes) become spaces, format characters (a
// right-to-left override, a zero-width space) go, then runs of space become one: the lines reach
// the owner and any agent that runs `board journal`.
const clean = (s: unknown): string =>
  String(s ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
const clipLine = (s: unknown): string => {
  const one = clean(s)
  return one.length > LINE_MAX ? `${one.slice(0, LINE_MAX - 1)}…` : one
}

/** The journal's kind of a card. "Stopped on an error": its last words are Claude Code's API error message (Item.apiError). */
export function kindOf(item: Pick<Item, 'column' | 'lastText' | 'apiError'>): JournalKind {
  switch (item.column) {
    case 'me':
      return 'owner'
    case 'ext':
      return 'ext'
    case 'work':
      return 'work'
    default:
      if (item.apiError && clean(item.lastText)) return 'error'
      return item.column === 'done' ? 'done' : 'idle'
  }
}

/** The line a card carries for its kind: what it asks, waits for, finished, or the error. */
export function lineOf(item: Item, kind: JournalKind): string {
  switch (kind) {
    case 'owner':
      return clipLine(item.question || item.doing)
    case 'ext':
      return clipLine(item.wait)
    case 'done':
      return clipLine(item.result || item.doing || (item.title !== item.name ? item.title : ''))
    case 'error':
      return clipLine(item.lastText)
    default:
      return ''
  }
}

const nameOf = (item: Item): string => clean(item.name || item.autoName) || item.key.slice(0, 8)

/**
 * What one refresh changed: the moves to record and the states to write. `seed`: nothing on
 * record yet (the journal just turned on): the cards are noted, no move recorded. A card seen for
 * the first time afterwards is a move (a session started). A changed line in the same kind is
 * written to its state, no move; a card gone from the board keeps its state, marked gone, so one
 * that comes back unchanged records nothing.
 *
 * A card's key is its Claude session id, or `pane-<id>` while herdr has not reported one for its
 * pane (services/board.ts): a session just started can be seen under the pane key first. When a
 * card with a session id appears and its pane's key is on record, still on the board, that is the
 * same session: `renames` moves its history to the new key, so the list has one row, not two.
 * Two limits: a strip already cached at a return keeps its `pane-<id>` row (a dead link) until it
 * is dismissed, when the card gets its session id after that return; and a pane whose agent never
 * reported a session id, replaced between two refreshes by a Claude session in the same pane,
 * hands its moves to that session.
 */
export function diffStates(
  before: ReadonlyMap<string, StateRow>,
  items: readonly Item[],
  at: number,
  seed = false,
): { moves: Move[]; states: Map<string, StateRow>; renames: [string, string][] } {
  const moves: Move[] = []
  const states = new Map<string, StateRow>()
  const renames: [string, string][] = []
  const seen = new Set<string>()
  const keys = new Set(items.map(i => i?.key))
  for (const item of items) {
    if (!item?.key || seen.has(item.key)) continue
    seen.add(item.key)
    const kind = kindOf(item)
    const now = { kind, line: lineOf(item, kind), name: nameOf(item), lane: item.category || 'other' }
    let old = before.get(item.key)
    const paneKey = item.session && item.pane ? `pane-${item.pane}` : ''
    const was = paneKey && !old && !keys.has(paneKey) ? before.get(paneKey) : undefined
    if (was && was.gone === null) {
      renames.push([paneKey, item.key])
      seen.add(paneKey)
      old = was
      if (old.kind === kind) {
        states.set(item.key, { ...now, at: old.at, gone: null })
        continue
      }
    }
    if (!old || old.kind !== kind) {
      const state: StateRow = { ...now, at, gone: null }
      states.set(item.key, state)
      if (!seed) moves.push({ key: item.key, ...now, at })
    } else if (old.line !== now.line || old.name !== now.name || old.lane !== now.lane || old.gone !== null)
      states.set(item.key, { ...now, at: old.at, gone: null })
  }
  for (const [key, old] of before) if (!seen.has(key) && old.gone === null) states.set(key, { ...old, gone: at })
  return { moves, states, renames }
}

/** Whether anything moved in the list's window: a row, or a session only counted. */
export const moved = (list: JournalList): boolean => list.rows.length + list.more + list.rest.work + list.rest.idle > 0

/** One row of the list: a session and the state it is listed under. */
export interface JournalRow {
  key: string
  name: string
  lane: string
  kind: RowKind
  line: string
  at: number
}

/** The list: since when, its rows in order, how many more, and what is only counted. */
export interface JournalList {
  since: number
  rows: JournalRow[]
  /** Rows past MAX_ROWS. */
  more: number
  /** Sessions that moved and are only counted: working now, idle now. */
  rest: { work: number; idle: number }
  /** Cards that waited on the owner before `since` and still do: no move, no row, counted. */
  before: number
  /** When the journal began recording, when that is after `since`: nothing before it is known. */
  recordedFrom?: number
}

/**
 * The list with when recording began, when the list asks for earlier. `start` null: nothing
 * recorded yet (no file), so nothing before `now` is known; undefined: not on record, nothing said.
 */
export const withRecord = (list: JournalList, start: number | null | undefined, now = Date.now()): JournalList =>
  start === undefined ? list : start === null || start > list.since ? { ...list, recordedFrom: start ?? now } : list

/**
 * The list since `since`: one row per session that moved, under its state now when that waits on
 * the owner or on someone else; else under the last "finished" or "stopped on an error" it had in
 * the window (one that finished and was woken for the next task is still "finished"); else only
 * counted, working or idle. Groups in ROW_ORDER, each in the order its rows came. `moves`: those
 * at or after `since`, in order; `states`: every state on record. `until`: moves after it are
 * left out (a return's window).
 */
export function journalList(
  moves: readonly Move[],
  states: ReadonlyMap<string, StateRow>,
  since: number,
  until = Number.POSITIVE_INFINITY,
  max = MAX_ROWS,
): JournalList {
  const byKey = new Map<string, Move[]>()
  for (const m of moves) {
    if (m.at < since || m.at > until) continue
    const list = byKey.get(m.key)
    if (list) list.push(m)
    else byKey.set(m.key, [m])
  }
  const rows: JournalRow[] = []
  const rest = { work: 0, idle: 0 }
  for (const [key, list] of byKey) {
    const last = list.at(-1) as Move
    const state = states.get(key)
    // The state now, unless the window ends before it was reached.
    const now = state && state.at <= until && state.kind === last.kind ? state : last
    // A card that left the board by the window's end waits on no one any more.
    const gone = state?.gone != null && state.gone <= until
    if ((now.kind === 'owner' || now.kind === 'ext') && !gone) {
      rows.push({ key, name: now.name, lane: now.lane, kind: now.kind, line: now.line, at: now.at })
      continue
    }
    const end = [...list].reverse().find(m => m.kind === 'done' || m.kind === 'error')
    if (end) {
      const current = end === last && state && state.kind === end.kind ? state : end
      rows.push({
        key,
        name: current.name,
        lane: current.lane,
        kind: end.kind as RowKind,
        line: current.line,
        at: end.at,
      })
    } else if (!gone) rest[now.kind === 'work' ? 'work' : 'idle']++
  }
  rows.sort((a, b) => ROW_ORDER.indexOf(a.kind) - ROW_ORDER.indexOf(b.kind) || a.at - b.at)
  let before = 0
  for (const [key, s] of states) if (s.kind === 'owner' && s.gone === null && s.at < since && !byKey.has(key)) before++
  return { since, rows: rows.slice(0, max), more: Math.max(0, rows.length - max), rest, before }
}

/** Marks the board keeps of the owner's absences: when they last went away and came back. */
export interface AwayMarks {
  left?: number
  back?: number
}

/**
 * Since when `board journal --away` lists: with presence on, the moment it went to away (now, or
 * the last time; a call inside the absence is part of it); without, the last time the page went
 * off show. Null: no absence on record.
 */
export function awaySince(presence: Presence | null, marks: AwayMarks): number | null {
  const state = presence?.state === 'call' ? presence.before : presence?.state
  const markedAway = marks.left !== undefined && (marks.back === undefined || marks.left > marks.back)
  // Away now: since the absence began, which a call taken and ended in it does not move.
  if (presence && state === 'away' && presence.since)
    return markedAway && marks.left !== undefined && marks.left <= presence.since ? marks.left : presence.since
  return marks.left ?? null
}

const two = (n: number): string => String(n).padStart(2, '0')
/** 23:56, or 20.11 23:56 when not today. */
export function clockText(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`
  return new Date(now).toDateString() === d.toDateString()
    ? time
    : `${two(d.getDate())}.${two(d.getMonth() + 1)} ${time}`
}

/** One entry of the list as it reads: a row, or a count line. */
export type JournalEntry =
  | { row: JournalRow }
  | { note: 'before' | 'more'; n: number }
  | { note: 'rest'; n: number; work: number; idle: number }

/**
 * The list in reading order, the same for `board journal` and the page: the rows by group, the
 * cards that waited on the owner before closing the first group (first of all with no new wait),
 * then how many more rows, then what moved and is only counted. Empty: nothing changed.
 */
export function journalEntries(list: JournalList): JournalEntry[] {
  const out: JournalEntry[] = []
  let closed = false
  const close = (): void => {
    if (!closed && list.before) out.push({ note: 'before', n: list.before })
    closed = true
  }
  for (const row of list.rows) {
    if (row.kind !== 'owner') close()
    out.push({ row })
  }
  close()
  if (list.more) out.push({ note: 'more', n: list.more })
  const rest = list.rest.work + list.rest.idle
  if (rest) out.push({ note: 'rest', n: rest, work: list.rest.work, idle: list.rest.idle })
  return out
}

/** A count line's words. */
export const noteText = (e: Exclude<JournalEntry, { row: JournalRow }>, t: Translator): string =>
  e.note === 'rest' ? t('journal.rest', { n: e.n, work: e.work, idle: e.idle }) : t(`journal.${e.note}`, { n: e.n })

/** The list as `board journal` prints it, a line each. */
export function journalLines(
  list: JournalList,
  t: Translator,
  now = Date.now(),
  laneTitle: (id: string) => string = id => id,
): string[] {
  const head = [
    t('journal.since', { when: clockText(list.since, now) }),
    ...(list.recordedFrom !== undefined
      ? [t('journal.recordedFrom', { when: clockText(list.recordedFrom, now) })]
      : []),
  ]
  const entries = journalEntries(list)
  if (!entries.length) return [...head, t('journal.nothing')]
  return [
    ...head,
    ...entries.map(e => {
      if (!('row' in e)) return noteText(e, t)
      const { row } = e
      const lane = row.lane ? ` (${laneTitle(row.lane)})` : ''
      const line = row.line ? `: ${row.line}` : ''
      return `${t(`journal.kind.${row.kind}`)} · ${row.name}${lane} ${clockText(row.at, now)}${line}`
    }),
  ]
}
