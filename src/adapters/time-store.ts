// Time entries in the board's database (#233, core/time.ts): add, change, move, remove and bring
// back, list, and the import's batch. Every change is one transaction with its journal row
// (adapters/db.ts write), so the web board, a session's `board time` and a billing agent writing
// at once never lose each other's change.
//
// Whose entries: a session changes its own entries; another session's, the owner's or the
// import's only with `force` (the owner asked for it; the master session while billing). The
// owner, on the board, changes any. A change can say which revision it read (`expect`): it is
// refused when the entry changed since.
import { randomBytes } from 'node:crypto'
import { t } from '../core/lang.ts'
import {
  type Actor,
  cleanTag,
  cleanText,
  clientDay,
  clientOf,
  clockIn,
  dateIn,
  instantIn,
  isoOf,
  problemsText,
  secondsOf,
  type TimeConfig,
  type TimeEntry,
  zoneOf,
} from '../core/time.ts'
import type { BoardDb, Tx } from './db.ts'

export class TimeError extends Error {
  constructor(
    readonly key: string,
    readonly vars: Record<string, string | number> = {},
  ) {
    super(t(key, vars))
    this.name = 'TimeError'
  }
}

/** A row as SQLite gives it. */
interface Row {
  id: string
  client: string
  project: string
  description: string
  tags: string
  start: string
  stop: string
  date: string
  by: string
  at: number
  changed: number
  changed_by: string
  rev: number
  deleted: number | null
  toggl: string | null
}

const actorOf = (s: string): Actor => {
  if (s === 'user' || s === 'import') return s
  try {
    const v = JSON.parse(s) as { key?: unknown; name?: unknown }
    if (typeof v.key === 'string') return { key: v.key, name: typeof v.name === 'string' ? v.name : '' }
  } catch {}
  return 'user'
}
const actorText = (a: Actor): string => (typeof a === 'string' ? a : JSON.stringify({ key: a.key, name: a.name }))

function entryOf(r: Row): TimeEntry {
  let tags: string[] = []
  try {
    const v = JSON.parse(r.tags)
    if (Array.isArray(v)) tags = v.filter((x): x is string => typeof x === 'string')
  } catch {}
  return {
    id: r.id,
    client: r.client,
    project: r.project,
    description: r.description,
    tags,
    start: r.start,
    stop: r.stop,
    date: r.date,
    by: actorOf(r.by),
    at: r.at,
    changed: r.changed,
    changedBy: actorOf(r.changed_by),
    rev: r.rev,
    ...(r.deleted !== null && { deleted: r.deleted }),
    ...(r.toggl !== null && { toggl: r.toggl }),
  }
}

const COLUMNS =
  'id, client, project, description, tags, start, stop, date, by, at, changed, changed_by, rev, deleted, toggl'

export function getEntry(db: BoardDb, id: string): TimeEntry | null {
  const r = db.db.query(`SELECT ${COLUMNS} FROM time_entries WHERE id = ?`).get(id) as Row | null
  return r ? entryOf(r) : null
}

export interface ListQuery {
  from: string
  to: string
  client?: string | undefined
  tag?: string | undefined
  /** Removed ones too. */
  deleted?: boolean | undefined
}

/** Entries whose work date is in [from, to], by start. */
export function listEntries(db: BoardDb, q: ListQuery): TimeEntry[] {
  const where = ['date >= ?', 'date <= ?']
  const args: (string | number)[] = [q.from, q.to]
  if (q.client) {
    where.push('client = ?')
    args.push(q.client)
  }
  if (!q.deleted) where.push('deleted IS NULL')
  const rows = db.db
    .query(`SELECT ${COLUMNS} FROM time_entries WHERE ${where.join(' AND ')} ORDER BY start, id`)
    .all(...args) as Row[]
  const list = rows.map(entryOf)
  const tag = q.tag ? cleanTag(q.tag) : ''
  return tag ? list.filter(e => e.tags.includes(tag)) : list
}

// ------------------------------------------------------------------ checks

/** No entry is written while config.json's `time` does not check out: its dates and rules would be guesses. */
function checkConfig(c: TimeConfig): void {
  if (c.problems.length) throw new TimeError('time.err.config', { problems: problemsText(c.problems, t) })
}

/** The client takes time, and the project is one of its own (unless `newProject`). */
function checkClientProject(c: TimeConfig, client: string, project: string, newProject: boolean): void {
  const own = clientOf(c, client)
  if (!own.ok) {
    const known = Object.keys(c.clients ?? {}).join(', ')
    throw new TimeError('time.err.client', { client, known })
  }
  if (!project) throw new TimeError('time.err.noProject')
  const projects = own.client.projects
  if (projects && !projects.includes(project) && !newProject)
    throw new TimeError('time.err.project', { project, client, known: projects.join(', ') })
}

function checkTimes(start: number, stop: number): void {
  if (!(stop > start)) throw new TimeError('time.err.stopBeforeStart')
  if (stop - start > 24 * 3600_000) throw new TimeError('time.err.tooLong')
}

/** May `actor` change this entry? The owner may change any; a session its own, or any with `force`. */
function mayChange(e: TimeEntry, actor: Actor, force: boolean): void {
  if (actor === 'user' || actor === 'import' || force) return
  const own = typeof e.by !== 'string' && e.by.key === actor.key
  if (!own)
    throw new TimeError('time.err.notYours', {
      id: e.id,
      by: typeof e.by === 'string' ? t(`time.by.${e.by}`) : e.by.name || e.by.key,
    })
}

const newId = (db: BoardDb): string => {
  for (;;) {
    const id = randomBytes(4).toString('hex')
    if (!db.db.query('SELECT 1 FROM time_entries WHERE id = ?').get(id)) return id
  }
}

function insert(tx: Tx, e: TimeEntry): void {
  tx.db
    .query(`INSERT INTO time_entries (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      e.id,
      e.client,
      e.project,
      e.description,
      JSON.stringify(e.tags),
      e.start,
      e.stop,
      e.date,
      actorText(e.by),
      e.at,
      e.changed,
      actorText(e.changedBy),
      e.rev,
      e.deleted ?? null,
      e.toggl ?? null,
    )
}

function update(tx: Tx, e: TimeEntry): void {
  tx.db
    .query(
      'UPDATE time_entries SET client = ?, project = ?, description = ?, tags = ?, start = ?, stop = ?, date = ?, changed = ?, changed_by = ?, rev = ?, deleted = ? WHERE id = ?',
    )
    .run(
      e.client,
      e.project,
      e.description,
      JSON.stringify(e.tags),
      e.start,
      e.stop,
      e.date,
      e.changed,
      actorText(e.changedBy),
      e.rev,
      e.deleted ?? null,
      e.id,
    )
}

/** The live entry alike in client, project, description, start and stop, if there is one. */
function sameLive(
  db: BoardDb,
  e: Pick<TimeEntry, 'client' | 'project' | 'description' | 'start' | 'stop'>,
): TimeEntry | null {
  const r = db.db
    .query(
      `SELECT ${COLUMNS} FROM time_entries WHERE client = ? AND project = ? AND description = ? AND start = ? AND stop = ? AND deleted IS NULL`,
    )
    .get(e.client, e.project, e.description, e.start, e.stop) as Row | null
  return r ? entryOf(r) : null
}

const unique = (err: unknown): boolean =>
  String((err as { code?: unknown })?.code ?? '').startsWith('SQLITE_CONSTRAINT')

// ------------------------------------------------------------------ changes

export interface NewEntry {
  client: string
  project: string
  description: string
  tags?: string[]
  start: number
  stop: number
  /** The start was not given (it is the stop less the duration): a repeat within 15 minutes is found by its duration. */
  startGiven: boolean
  newProject?: boolean
  toggl?: string
}

/** How long a repeat of an `add` without a start is taken for the first one. */
export const REPEAT_MS = 15 * 60_000

/** An `add` that wrote nothing: the live entry alike (`same`), or the session's call within REPEAT_MS (`repeat-window`). */
export type ExistingReason = 'same' | 'repeat-window'

/**
 * A new entry; or the live one alike (client, project, description, start and stop), with
 * `existing`: a repeated call after a failure writes nothing. Without a given start, the same
 * session's entry (by its key: its name may have changed) alike in all but its start, made in the
 * last REPEAT_MS, is the one, and `reason` says so.
 */
export function addEntry(
  db: BoardDb,
  c: TimeConfig,
  n: NewEntry,
  actor: Actor,
  now: number = Date.now(),
): { entry: TimeEntry; existing: boolean; reason?: ExistingReason } {
  checkConfig(c)
  const description = cleanText(n.description)
  const project = cleanText(n.project, 120)
  if (!description) throw new TimeError('time.err.noDescription')
  checkClientProject(c, n.client, project, !!n.newProject)
  checkTimes(n.start, n.stop)
  const entry: TimeEntry = {
    id: '',
    client: n.client,
    project,
    description,
    tags: [...new Set((n.tags ?? []).map(cleanTag).filter(Boolean))],
    start: isoOf(n.start),
    stop: isoOf(n.stop),
    date: dateIn(n.start, zoneOf(c, n.client)),
    by: actor,
    at: now,
    changed: now,
    changedBy: actor,
    rev: 1,
    ...(n.toggl && { toggl: n.toggl }),
  }
  const before = sameLive(db, entry)
  if (before) return { entry: before, existing: true, reason: 'same' }
  if (!n.startGiven && typeof actor !== 'string') {
    const seconds = secondsOf(entry)
    const rows = db.db
      .query(
        `SELECT ${COLUMNS} FROM time_entries WHERE client = ? AND project = ? AND description = ? AND json_valid(by) AND json_extract(by, '$.key') = ? AND at >= ? AND deleted IS NULL`,
      )
      .all(entry.client, entry.project, entry.description, actor.key, now - REPEAT_MS) as Row[]
    const repeat = rows.map(entryOf).find(e => secondsOf(e) === seconds)
    if (repeat) return { entry: repeat, existing: true, reason: 'repeat-window' }
  }
  try {
    return db.write(actorText(actor), tx => {
      // another process may have written it since the look above: the index tells
      const again = sameLive(db, entry)
      if (again) return { entry: again, existing: true, reason: 'same' as const }
      const made = { ...entry, id: newId(db) }
      insert(tx, made)
      tx.journal({ store: 'time', op: 'add', ref: made.id, after: made })
      return { entry: made, existing: false }
    })
  } catch (err) {
    // another process wrote the same entry between the look and the insert: that one is it
    const found = unique(err) ? sameLive(db, entry) : null
    if (found) return { entry: found, existing: true, reason: 'same' }
    throw err
  }
}

export interface EntryChange {
  client?: string
  project?: string
  description?: string
  start?: number
  stop?: number
  /** A new duration, kept from the (new) start. */
  seconds?: number
  addTags?: string[]
  removeTags?: string[]
  /** The whole set of tags instead (the panel sends what its field holds). */
  tags?: string[]
  newProject?: boolean
}

function changed(
  db: BoardDb,
  id: string,
  actor: Actor,
  o: { force?: boolean; expect?: number },
  fn: (e: TimeEntry) => TimeEntry,
  op: string,
): TimeEntry {
  return db.write(actorText(actor), tx => {
    const e = getEntry(db, id)
    if (!e) throw new TimeError('time.err.gone', { id })
    mayChange(e, actor, !!o.force)
    if (o.expect !== undefined && o.expect !== e.rev) throw new TimeError('time.err.changedSince', { id, rev: e.rev })
    const next = fn(e)
    if (
      JSON.stringify({ ...next, changed: 0, changedBy: 0, rev: 0 }) ===
      JSON.stringify({ ...e, changed: 0, changedBy: 0, rev: 0 })
    )
      return e // nothing to change: a repeat changes nothing
    const saved = { ...next, changed: Date.now(), changedBy: actor, rev: e.rev + 1 }
    try {
      update(tx, saved)
    } catch (err) {
      if (unique(err)) throw new TimeError('time.err.sameAs', { id })
      throw err
    }
    tx.journal({ store: 'time', op, ref: id, before: e, after: saved })
    return saved
  })
}

/** An entry changed: its fields, its times (the work date stamped again from the start), its tags. */
export function editEntry(
  db: BoardDb,
  c: TimeConfig,
  id: string,
  ch: EntryChange,
  actor: Actor,
  o: { force?: boolean; expect?: number } = {},
): TimeEntry {
  checkConfig(c)
  return changed(
    db,
    id,
    actor,
    o,
    e => {
      if (e.deleted) throw new TimeError('time.err.removed', { id })
      const client = ch.client ?? e.client
      const project = ch.project !== undefined ? cleanText(ch.project, 120) : e.project
      if (ch.client !== undefined || ch.project !== undefined) checkClientProject(c, client, project, !!ch.newProject)
      const description = ch.description !== undefined ? cleanText(ch.description) : e.description
      if (!description) throw new TimeError('time.err.noDescription')
      const start = ch.start ?? Date.parse(e.start)
      let stop = ch.stop ?? Date.parse(e.stop)
      if (ch.seconds !== undefined) stop = start + ch.seconds * 1000
      else if (ch.start !== undefined && ch.stop === undefined) stop = start + secondsOf(e) * 1000
      checkTimes(start, stop)
      const tags = new Set(ch.tags ? ch.tags.map(cleanTag).filter(Boolean) : e.tags)
      for (const tag of ch.addTags ?? []) if (cleanTag(tag)) tags.add(cleanTag(tag))
      for (const tag of ch.removeTags ?? []) tags.delete(cleanTag(tag))
      // the work date is stamped again only when the start or the client changes: a trim of the
      // stop moves no day already billed, whatever the zone says now
      const moved = (ch.start !== undefined && isoOf(ch.start) !== e.start) || client !== e.client
      return {
        ...e,
        client,
        project,
        description,
        tags: [...tags],
        start: isoOf(start),
        stop: isoOf(stop),
        date: moved ? dateIn(start, zoneOf(c, client)) : e.date,
      }
    },
    'edit',
  )
}

/**
 * A line billed over its time worked (rounded up, or to the nearest) raised to its billed figure:
 * its last entry lengthened by the gap, the day read under the write lock (an entry another process
 * added to the line just before counts).
 */
export function raiseEntry(
  db: BoardDb,
  c: TimeConfig,
  id: string,
  actor: Actor,
  o: { force?: boolean; expect?: number; billed?: number } = {},
): TimeEntry {
  checkConfig(c)
  return changed(
    db,
    id,
    actor,
    o,
    e => {
      if (e.deleted) throw new TimeError('time.err.removed', { id })
      const day = clientDay(c, e.client, e.date, listEntries(db, { from: e.date, to: e.date, client: e.client }))
      const line = day.lines.find(l => l.entries.includes(id))
      if (!line || line.entries.at(-1) !== id || line.billedSeconds <= line.seconds)
        throw new TimeError('time.err.noRaise')
      billedAsSeen(line, o.billed, e)
      const stop = Date.parse(e.stop) + (line.billedSeconds - line.seconds) * 1000
      checkTimes(Date.parse(e.start), stop)
      return { ...e, stop: isoOf(stop) }
    },
    'raise',
  )
}

/**
 * The line bills what the change was asked for (`billed`, the figure its button said): refused as a
 * change since otherwise, the line's last entry named (another entry of it changed, or one joined).
 */
function billedAsSeen(line: { billedSeconds: number }, billed: number | undefined, e: TimeEntry): void {
  if (billed !== undefined && billed !== line.billedSeconds)
    throw new TimeError('time.err.changedSince', { id: e.id, rev: e.rev })
}

/**
 * A line billed under its time worked (rounded down, or to the nearest) trimmed to its billed
 * figure: the gap taken from its last entry, then the one before, each kept a minute at least; the
 * day read under the write lock, as for a raise. Refused when the line cannot get there. `id` is
 * the line's last entry, the one whose revision the change read; each entry it shortens goes up a
 * revision, the one named given back.
 */
export function trimLine(
  db: BoardDb,
  c: TimeConfig,
  id: string,
  actor: Actor,
  o: { force?: boolean; expect?: number; billed?: number } = {},
): TimeEntry {
  checkConfig(c)
  return db.write(actorText(actor), tx => {
    const e = getEntry(db, id)
    if (!e) throw new TimeError('time.err.gone', { id })
    mayChange(e, actor, !!o.force)
    if (o.expect !== undefined && o.expect !== e.rev) throw new TimeError('time.err.changedSince', { id, rev: e.rev })
    if (e.deleted) throw new TimeError('time.err.removed', { id })
    const entries = listEntries(db, { from: e.date, to: e.date, client: e.client })
    const line = clientDay(c, e.client, e.date, entries).lines.find(l => l.entries.includes(id))
    if (!line || line.entries.at(-1) !== id || line.billedSeconds >= line.seconds)
      throw new TimeError('time.err.noTrim')
    billedAsSeen(line, o.billed, e)
    const byId = new Map(entries.map(x => [x.id, x]))
    const cuts: [TimeEntry, number][] = []
    let gap = line.seconds - line.billedSeconds
    for (const lid of [...line.entries].reverse()) {
      const x = byId.get(lid)
      if (!x || gap <= 0) continue
      const take = Math.min(gap, secondsOf(x) - 60)
      if (take <= 0) continue
      cuts.push([x, take])
      gap -= take
    }
    if (gap > 0) throw new TimeError('time.err.cannotTrim')
    const now = Date.now()
    let named = e
    for (const [x, take] of cuts) {
      mayChange(x, actor, !!o.force)
      const saved = {
        ...x,
        stop: isoOf(Date.parse(x.stop) - take * 1000),
        changed: now,
        changedBy: actor,
        rev: x.rev + 1,
      }
      try {
        update(tx, saved)
      } catch (err) {
        if (unique(err)) throw new TimeError('time.err.sameAs', { id: x.id })
        throw err
      }
      tx.journal({ store: 'time', op: 'trim', ref: x.id, before: x, after: saved })
      if (x.id === id) named = saved
    }
    return named
  })
}

/** The tags entries have, the most used first (live entries only): what the page offers to add. */
export function usedTags(db: BoardDb, limit = 30): string[] {
  const rows = db.db
    .query(
      // a row whose tags are not a JSON list has none, as entryOf reads it: one such row fails no day
      `SELECT j.value AS tag, COUNT(*) AS n FROM time_entries,
         json_each(CASE WHEN json_valid(time_entries.tags) AND json_type(time_entries.tags) = 'array'
           THEN time_entries.tags ELSE '[]' END) AS j
       WHERE time_entries.deleted IS NULL GROUP BY j.value ORDER BY n DESC, j.value LIMIT ?`,
    )
    .all(limit) as { tag: unknown }[]
  return rows.map(r => r.tag).filter((x): x is string => typeof x === 'string')
}

/** An entry to another work date: the same wall clock in the client's zone on that date, the same duration. */
export function moveEntry(
  db: BoardDb,
  c: TimeConfig,
  id: string,
  date: string,
  actor: Actor,
  o: { force?: boolean; expect?: number } = {},
): TimeEntry {
  checkConfig(c)
  return changed(
    db,
    id,
    actor,
    o,
    e => {
      if (e.deleted) throw new TimeError('time.err.removed', { id })
      if (e.date === date) return e
      const zone = zoneOf(c, e.client)
      const start = instantIn(date, clockIn(Date.parse(e.start), zone), zone)
      const stop = start + secondsOf(e) * 1000
      return { ...e, start: isoOf(start), stop: isoOf(stop), date }
    },
    'move',
  )
}

/** An entry removed: it stays, marked, out of every list and total. Removing a removed one changes nothing. */
export function removeEntry(
  db: BoardDb,
  id: string,
  actor: Actor,
  o: { force?: boolean; expect?: number } = {},
): TimeEntry {
  return changed(db, id, actor, o, e => (e.deleted ? e : { ...e, deleted: Date.now() }), 'remove')
}

/** A removed entry back; one that is not removed stays as it is. */
export function restoreEntry(
  db: BoardDb,
  id: string,
  actor: Actor,
  o: { force?: boolean; expect?: number } = {},
): TimeEntry {
  return changed(
    db,
    id,
    actor,
    o,
    e => {
      if (!e.deleted) return e
      const { deleted: _d, ...rest } = e
      return rest
    },
    'restore',
  )
}

/** A Toggl row for the store: its lane, and Toggl's id or none (the Detailed report's CSV has none). */
export type ImportRow = Omit<NewEntry, 'startGiven' | 'newProject'>

/** A row the store has that differs from Toggl's: the entry, who made it, and the fields that differ. */
export interface ImportChange {
  id: string
  toggl: string | null
  start: string
  fields: string[]
  /** Who made the stored entry: the import (changed in Toggl since, or on the board), or a session at that start. */
  by: Actor
  /** Toggl's row as the file has it (its start and description), for a person to find it there. */
  row: { start: string; description: string }
}

export type ImportVerdict =
  | { kind: 'new'; entry: TimeEntry }
  | { kind: 'already'; stored: TimeEntry }
  | { kind: 'changed'; stored: TimeEntry; next: TimeEntry; fields: string[] }

const IMPORT_FIELDS = ['client', 'project', 'description', 'start', 'stop', 'tags'] as const

/**
 * A CSV row's key (the Detailed report has no id): its lane and the start Toggl gave it, kept on
 * the entry, so the row is known again after the entry is moved or its start changed on the board.
 * Rows of one lane that start at the same second are told apart by a number after the first
 * (`#2`, `#3`).
 */
export const csvKey = (client: string, start: number, n = 1): string =>
  `csv:${client}:${isoOf(start)}${n > 1 ? `#${n}` : ''}`

/** The lane and start a CSV key names (the start Toggl gave), or null for Toggl's own id. */
const keyStart = (key: string): string | null => {
  const m = /^csv:(.*):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)(?:#\d+)?$/.exec(key)
  return m ? `${m[1]}\u0000${m[2]}` : null
}

/** The entry a Toggl row would be; `id` empty until it is written. */
function importedEntry(c: TimeConfig, n: ImportRow, now: number): TimeEntry {
  return {
    id: '',
    client: n.client,
    project: cleanText(n.project, 120),
    description: cleanText(n.description) || '-',
    tags: [...new Set((n.tags ?? []).map(cleanTag).filter(Boolean))].sort(),
    start: isoOf(n.start),
    stop: isoOf(n.stop),
    date: dateIn(n.start, zoneOf(c, n.client)),
    by: 'import',
    at: now,
    changed: now,
    changedBy: 'import',
    rev: 1,
    toggl: n.toggl || csvKey(n.client, n.start),
  }
}

/**
 * What the store has, for one import or dry run, read once: by key (Toggl's id, or a CSV row's
 * csvKey), and by lane and start (the entries a CSV key names at that start, and every entry that
 * starts there: a session's own, a live one before a removed one). An entry a row of the run was
 * matched to is taken: no second row is matched to it. What the run adds goes in as it goes.
 */
export class ImportIndex {
  private readonly byKey = new Map<string, TimeEntry>()
  private readonly byStart = new Map<string, TimeEntry[]>()
  private readonly taken = new Set<TimeEntry>()
  constructor(db: BoardDb | null) {
    if (!db) return
    const rows = db.db.query(`SELECT ${COLUMNS} FROM time_entries ORDER BY deleted IS NOT NULL, at`).all() as Row[]
    for (const r of rows) this.add(entryOf(r))
  }
  add(e: TimeEntry): void {
    if (e.toggl) this.byKey.set(e.toggl, e)
    const own = `${e.client}\u0000${e.start}`
    const named = e.toggl ? keyStart(e.toggl) : null
    for (const k of new Set([own, ...(named ? [named] : [])])) this.byStart.set(k, [...(this.byStart.get(k) ?? []), e])
  }
  /** The entry with Toggl's id `key`, unless a row of the run has it already. */
  byId(key: string): TimeEntry | null {
    const e = this.byKey.get(key)
    return e && !this.taken.has(e) ? e : null
  }
  /** The entries at a lane and start no row of the run has yet, the live ones first. */
  at(client: string, start: string): TimeEntry[] {
    const all = (this.byStart.get(`${client}\u0000${start}`) ?? []).filter(e => !this.taken.has(e))
    return [...all.filter(e => !e.deleted), ...all.filter(e => e.deleted)]
  }
  take(e: TimeEntry): void {
    this.taken.add(e)
  }
  isTaken(e: TimeEntry): boolean {
    return this.taken.has(e)
  }
  /** A CSV key no entry has, for a row at that lane and start: the first, else #2, #3… */
  freeKey(client: string, start: number): string {
    for (let n = 1; ; n++) {
      const key = csvKey(client, start, n)
      if (!this.byKey.has(key)) return key
    }
  }
}

/** The fields a stored entry has otherwise than a Toggl row's. */
const differing = (stored: TimeEntry, entry: TimeEntry): string[] =>
  IMPORT_FIELDS.filter(f =>
    f === 'tags' ? [...stored.tags].sort().join('\u0000') !== entry.tags.join('\u0000') : stored[f] !== entry[f],
  )

/**
 * How the rows of one lane and start are paired with the entries the store has there, each pass
 * over the rows not yet paired: alike in every field first; then the same project and
 * description (its stop or tags changed); the same project and stop (its words changed); the same
 * project; the same description; the same stop; then whatever is left, one to one.
 */
const PAIRINGS: ((stored: TimeEntry, row: TimeEntry) => boolean)[] = [
  (a, b) => differing(a, b).length === 0,
  (a, b) => a.project === b.project && a.description === b.description,
  (a, b) => a.project === b.project && a.stop === b.stop,
  (a, b) => a.project === b.project,
  (a, b) => a.description === b.description,
  (a, b) => a.stop === b.stop,
  () => true,
]

/**
 * What the store makes of Toggl's rows (index: what it has), each row's verdict in its place. A
 * row with Toggl's id is that entry. The others are known again by their lane and the start Toggl
 * gave them, a lane and start at a time: its rows are paired with the entries there (PAIRINGS),
 * each entry with one row at most, so rows of one start that differ are each an entry of their
 * own. A row paired with an entry alike is `already`; with a removed one, `already` (it stays
 * removed); with one that differs (changed in Toggl, or moved or changed on the board), `changed`,
 * with the fields, and not added twice. A row left over is `new`, with a key of its own; one
 * alike to a row of the same run already new is that row (`already`).
 */
export function importVerdicts(
  index: ImportIndex,
  c: TimeConfig,
  rows: readonly ImportRow[],
  now: number = Date.now(),
): ImportVerdict[] {
  const entries = rows.map(n => importedEntry(c, n, now))
  const out: (ImportVerdict | undefined)[] = rows.map(() => undefined)
  const paired = (stored: TimeEntry, entry: TimeEntry): ImportVerdict => {
    index.take(stored)
    if (stored.deleted) return { kind: 'already', stored }
    const fields = differing(stored, entry)
    return fields.length ? { kind: 'changed', stored, next: entry, fields } : { kind: 'already', stored }
  }
  rows.forEach((n, i) => {
    const stored = n.toggl ? index.byId(n.toggl) : null
    if (stored) out[i] = paired(stored, entries[i] as TimeEntry)
  })
  const groups = new Map<string, number[]>()
  entries.forEach((e, i) => {
    if (out[i]) return
    const k = `${e.client}\u0000${e.start}`
    groups.set(k, [...(groups.get(k) ?? []), i])
  })
  for (const group of groups.values()) {
    const first = entries[group[0] as number] as TimeEntry
    const there = index.at(first.client, first.start)
    for (const pairs of PAIRINGS)
      for (const i of group) {
        if (out[i]) continue
        const stored = there.find(x => !index.isTaken(x) && pairs(x, entries[i] as TimeEntry))
        if (stored) out[i] = paired(stored, entries[i] as TimeEntry)
      }
    const fresh: TimeEntry[] = []
    for (const i of group) {
      if (out[i]) continue
      const e = entries[i] as TimeEntry
      const twin = fresh.find(x => differing(x, e).length === 0)
      if (twin) {
        out[i] = { kind: 'already', stored: twin }
        continue
      }
      if (!rows[i]?.toggl) e.toggl = index.freeKey(e.client, Date.parse(e.start))
      index.add(e)
      index.take(e)
      fresh.push(e)
      out[i] = { kind: 'new', entry: e }
    }
  }
  return out as ImportVerdict[]
}

/** One row's verdict (importVerdicts, for a row alone). */
export const importVerdict = (index: ImportIndex, c: TimeConfig, n: ImportRow, now: number = Date.now()) =>
  importVerdicts(index, c, [n], now)[0] as ImportVerdict

/** A changed verdict as the run reports it. */
export const changeOf = (v: Extract<ImportVerdict, { kind: 'changed' }>): ImportChange => ({
  id: v.stored.id,
  toggl: v.stored.toggl ?? null,
  start: v.stored.start,
  fields: v.fields,
  by: v.stored.by,
  row: { start: v.next.start, description: v.next.description },
})

/**
 * The import's entries, in transactions of `batch` (another writer waits milliseconds), each new
 * one with a journal row. One the store has (importVerdict) is counted, not added. A changed one is
 * listed; with `update`, Toggl's values replace the entry's when the board never changed it (made
 * and last changed by the import), journaled as `import-update`, its work date stamped again.
 */
export function importEntries(
  db: BoardDb,
  c: TimeConfig,
  entries: readonly ImportRow[],
  o: { update?: boolean; now?: number; batch?: number } = {},
): { added: number; already: number; changed: ImportChange[]; updated: ImportChange[] } {
  checkConfig(c)
  const now = o.now ?? Date.now()
  const batch = o.batch ?? 500
  // the file's rows paired with what the store has as a whole first: rows of one start meet together
  const verdicts = importVerdicts(new ImportIndex(db), c, entries, now)
  let added = 0
  let already = 0
  const changes: ImportChange[] = []
  const updated: ImportChange[] = []
  for (let at = 0; at < verdicts.length; at += batch) {
    db.write('import', tx => {
      for (const v of verdicts.slice(at, at + batch)) {
        if (v.kind === 'already') {
          already++
          continue
        }
        if (v.kind === 'changed') {
          const change = changeOf(v)
          const mine = v.stored.by === 'import' && v.stored.changedBy === 'import'
          if (!o.update || !mine) {
            changes.push(change)
            continue
          }
          const saved: TimeEntry = {
            ...v.stored,
            ...v.next,
            id: v.stored.id,
            by: v.stored.by,
            at: v.stored.at,
            rev: v.stored.rev + 1,
            changed: now,
            changedBy: 'import',
            ...(v.stored.toggl !== undefined && { toggl: v.stored.toggl }),
          }
          try {
            update(tx, saved)
          } catch (err) {
            if (!unique(err)) throw err
            changes.push(change)
            continue
          }
          tx.journal({ store: 'time', op: 'import-update', ref: saved.id, before: v.stored, after: saved })
          updated.push(change)
          continue
        }
        const e = { ...v.entry, id: newId(db) }
        try {
          insert(tx, e)
        } catch (err) {
          // another process wrote this row (or one alike) since the index was read: it is there
          if (!unique(err)) throw err
          already++
          continue
        }
        tx.journal({ store: 'time', op: 'import', ref: e.id, after: e })
        added++
      }
    })
  }
  return { added, already, changed: changes, updated }
}
