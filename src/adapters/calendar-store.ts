// The board's own calendar in its database (#328, db-schema.ts step 4): events agents and the owner
// put on it, each change with its journal row (store `calendar`: who, the event before and after).
// A write to a provider's calendar leaves its journal row here too (`provider-create`,
// `provider-update`, `provider-delete`, ref `<source>/<id>`, the owner's words that asked for it in
// `after`), so who changed what is in one place whatever calendar it was in.
import { randomBytes } from 'node:crypto'
import { BOARD_SOURCE, type CalEvent, inWindow, isInstant } from '../core/calendar.ts'
import { t } from '../core/lang.ts'
import { addDays, cleanText, isDate } from '../core/time.ts'
import type { BoardDb } from './db.ts'

/** Who changes it: a session, or the owner (on the board, or a command outside a session). */
export type CalActor = { key: string; name: string } | 'user'

const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000)

/** A refusal in words (cal.err.<code>), its code under --json and in an answer's `code`. */
export class CalError extends Error {
  constructor(
    readonly key: string,
    readonly vars: Record<string, string | number> = {},
  ) {
    super(t(key, vars))
    this.name = 'CalError'
  }
  get code(): string {
    return this.key.split('.').at(-1) ?? 'failed'
  }
}

interface Row {
  id: string
  title: string
  start: string
  end: string
  all_day: number
  location: string | null
  join_url: string | null
  note: string | null
  by: string
  at: number
  changed: number
  changed_by: string
  rev: number
  deleted: number | null
}

const COLUMNS = 'id, title, start, end, all_day, location, join_url, note, by, at, changed, changed_by, rev, deleted'

export const actorText = (a: CalActor): string => (a === 'user' ? 'user' : JSON.stringify({ key: a.key, name: a.name }))
export function actorOf(s: string): CalActor {
  if (s === 'user') return s
  try {
    const v = JSON.parse(s) as { key?: unknown; name?: unknown }
    if (typeof v.key === 'string') return { key: v.key, name: typeof v.name === 'string' ? v.name : '' }
  } catch {}
  return 'user'
}
/** An actor as a line says it: the session's name, or "user". */
export const actorName = (a: CalActor): string => (a === 'user' ? 'user' : a.name || a.key)

function eventOfRow(r: Row): CalEvent {
  return {
    source: BOARD_SOURCE,
    id: r.id,
    title: r.title,
    start: r.start,
    end: r.end,
    allDay: r.all_day === 1,
    status: 'confirmed',
    ...(r.location && { location: r.location }),
    ...(r.join_url && { join: r.join_url }),
    ...(r.note && { note: r.note }),
    by: actorName(actorOf(r.by)),
    at: r.at,
    changedBy: actorName(actorOf(r.changed_by)),
    changed: r.changed,
    rev: r.rev,
  }
}

/** A board event as it is written: what a command or the panel gives. */
export interface BoardEventInput {
  title: string
  /** An instant (ms) for a timed event; a date for an all-day one. */
  start: number | string
  end: number | string
  location?: string | null
  join?: string | null
  note?: string | null
}

/** An instant as the table keeps it: UTC to the second, so that text sorts as time does. */
const iso = (at: number): string => new Date(Math.floor(at / 1000) * 1000).toISOString().replace('.000Z', 'Z')

/** The row's times: an all-day event's dates (its end the day after its last), a timed one's UTC instants. */
function timesOf(input: Pick<BoardEventInput, 'start' | 'end'>): { start: string; end: string; allDay: boolean } {
  if (typeof input.start === 'string') {
    if (!isDate(input.start)) throw new CalError('cal.err.when', { value: input.start })
    const end = typeof input.end === 'string' && isDate(input.end) ? input.end : addDays(input.start, 1)
    if (end <= input.start) throw new CalError('cal.err.endBeforeStart')
    return { start: input.start, end, allDay: true }
  }
  if (typeof input.end !== 'number') throw new CalError('cal.err.when', { value: String(input.end) })
  if (input.end < input.start) throw new CalError('cal.err.endBeforeStart')
  return { start: iso(input.start), end: iso(input.end), allDay: false }
}

const textOr = (v: string | null | undefined, max: number): string | null => {
  const s = v ? cleanText(v, max) : ''
  return s || null
}

export function getBoardEvent(db: BoardDb, id: string, o: { deleted?: boolean } = {}): CalEvent | null {
  const r = db.db.query(`SELECT ${COLUMNS} FROM cal_events WHERE id = ?`).get(id) as Row | null
  if (!r || (r.deleted !== null && !o.deleted)) return null
  return eventOfRow(r)
}

/** The live events that touch [from, to), by start; all-day ones read in `zone`. */
export function listBoardEvents(db: BoardDb, from: number, to: number, zone: string): CalEvent[] {
  // a day's margin each side in text, then exactly: an all-day row's dates and a timed one's instants sort together
  const lo = new Date(from - 2 * 86_400_000).toISOString().slice(0, 10)
  const hi = new Date(to + 2 * 86_400_000).toISOString().slice(0, 10)
  const rows = db.db
    .query(`SELECT ${COLUMNS} FROM cal_events WHERE deleted IS NULL AND start < ? AND end >= ? ORDER BY start`)
    .all(`${hi}~`, lo) as Row[]
  return rows.map(eventOfRow).filter(e => inWindow(e, from, to, zone))
}

const newId = (db: BoardDb): string => {
  for (;;) {
    const id = randomBytes(4).toString('hex')
    if (!db.db.query('SELECT 1 FROM cal_events WHERE id = ?').get(id)) return id
  }
}

function checked(input: BoardEventInput): {
  title: string
  start: string
  end: string
  allDay: boolean
  location: string | null
  join: string | null
  note: string | null
} {
  const title = cleanText(input.title, 500)
  if (!title) throw new CalError('cal.err.noTitle')
  const join = input.join ? cleanText(input.join, 2000) : null
  if (join) {
    let ok = false
    try {
      ok = ['https:', 'http:'].includes(new URL(join).protocol)
    } catch {}
    if (!ok) throw new CalError('cal.err.join', { value: join })
  }
  return {
    title,
    ...timesOf(input),
    location: textOr(input.location, 500),
    join,
    note: textOr(input.note, 2000),
  }
}

export function addBoardEvent(db: BoardDb, by: CalActor, input: BoardEventInput, now = Date.now()): CalEvent {
  const v = checked(input)
  return db.write(actorText(by), tx => {
    const id = newId(db)
    tx.db
      .query(`INSERT INTO cal_events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`)
      .run(
        id,
        v.title,
        v.start,
        v.end,
        v.allDay ? 1 : 0,
        v.location,
        v.join,
        v.note,
        actorText(by),
        now,
        now,
        actorText(by),
      )
    const e = getBoardEvent(db, id) as CalEvent
    tx.journal({ store: 'calendar', op: 'add', ref: id, after: e })
    return e
  })
}

/** A change of a board event: only what is given changes; `null` clears a text. */
export interface BoardEventChange {
  title?: string
  start?: number | string
  end?: number | string
  location?: string | null
  join?: string | null
  note?: string | null
}

/**
 * The event changed; `expect`: the revision the caller read (refused when it changed since). An
 * all-day event given a time becomes a timed one, and back: start and end then come together.
 */
export function editBoardEvent(
  db: BoardDb,
  by: CalActor,
  id: string,
  change: BoardEventChange,
  o: { expect?: number; now?: number } = {},
): CalEvent {
  const now = o.now ?? Date.now()
  return db.write(actorText(by), tx => {
    const before = getBoardEvent(db, id)
    if (!before) throw new CalError('cal.err.notFound', { id })
    if (o.expect !== undefined && o.expect !== before.rev)
      throw new CalError('cal.err.changed', { id, rev: before.rev ?? 0 })
    // a time keeps its kind unless both change; a start alone keeps the event's length
    const was = before.allDay
      ? { start: before.start as number | string, end: before.end as number | string }
      : { start: Date.parse(before.start), end: Date.parse(before.end) }
    const sameKind = (v: number | string): boolean => typeof v === typeof was.start
    const start = change.start ?? was.start
    let end = change.end
    if (end === undefined) {
      if (change.start === undefined) end = was.end
      else if (!sameKind(change.start)) throw new CalError('cal.err.bothTimes')
      else if (typeof start === 'number') end = start + ((was.end as number) - (was.start as number))
      else end = addDays(start, daysBetween(was.start as string, was.end as string))
    } else if (change.start === undefined && !sameKind(end)) throw new CalError('cal.err.bothTimes')
    const v = checked({
      title: change.title ?? before.title,
      start,
      end,
      location: change.location === undefined ? (before.location ?? null) : change.location,
      join: change.join === undefined ? (before.join ?? null) : change.join,
      note: change.note === undefined ? (before.note ?? null) : change.note,
    })
    tx.db
      .query(
        'UPDATE cal_events SET title = ?, start = ?, end = ?, all_day = ?, location = ?, join_url = ?, note = ?, changed = ?, changed_by = ?, rev = rev + 1 WHERE id = ?',
      )
      .run(v.title, v.start, v.end, v.allDay ? 1 : 0, v.location, v.join, v.note, now, actorText(by), id)
    const after = getBoardEvent(db, id) as CalEvent
    tx.journal({ store: 'calendar', op: 'edit', ref: id, before, after })
    return after
  })
}

export function removeBoardEvent(db: BoardDb, by: CalActor, id: string, now = Date.now()): CalEvent {
  return db.write(actorText(by), tx => {
    const before = getBoardEvent(db, id)
    if (!before) throw new CalError('cal.err.notFound', { id })
    tx.db
      .query('UPDATE cal_events SET deleted = ?, changed = ?, changed_by = ?, rev = rev + 1 WHERE id = ?')
      .run(now, now, actorText(by), id)
    tx.journal({ store: 'calendar', op: 'remove', ref: id, before })
    return before
  })
}

/**
 * A write to a provider's calendar, as the journal keeps it: who, which event, what it was and is
 * to become, the owner's words that asked for it, and its phase: `asked` before the provider is
 * called (the database is open and writable, or nothing is called), `done` after, with the id the
 * provider gave.
 */
export function journalProviderWrite(
  db: BoardDb,
  by: CalActor,
  row: {
    source: string
    op: 'create' | 'update' | 'delete'
    id: string
    before?: unknown
    after?: unknown
    asked: string
    phase: 'asked' | 'done'
  },
): void {
  db.write(actorText(by), tx => {
    tx.journal({
      store: 'calendar',
      op: `provider-${row.op}`,
      ref: `${row.source}/${row.id}`,
      before: row.before,
      after: {
        ...(typeof row.after === 'object' && row.after !== null ? row.after : {}),
        asked: row.asked,
        phase: row.phase,
      },
    })
  })
}

/** The calendar's last change in the journal (0: none), for the payload's line. */
export function lastCalendarChange(db: BoardDb): number {
  const r = db.db.query("SELECT MAX(seq) AS seq FROM journal WHERE store = 'calendar'").get() as { seq: number | null }
  return r?.seq ?? 0
}

/** Whether a time a command or the page gives reads as one: an ISO instant, or a date for all day. */
export const timeOk = (s: string): boolean => isInstant(s) || isDate(s)
