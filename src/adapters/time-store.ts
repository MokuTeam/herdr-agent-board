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
  clientOf,
  clockIn,
  dateIn,
  instantIn,
  isoOf,
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
  return q.tag ? list.filter(e => e.tags.includes(q.tag as string)) : list
}

// ------------------------------------------------------------------ checks

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

/**
 * A new entry; or the live one alike (client, project, description, start and stop), with
 * `existing`: a repeated call after a failure writes nothing. Without a given start, the same
 * session's entry alike in all but its start, made in the last REPEAT_MS, is the one.
 */
export function addEntry(
  db: BoardDb,
  c: TimeConfig,
  n: NewEntry,
  actor: Actor,
  now: number = Date.now(),
): { entry: TimeEntry; existing: boolean } {
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
  if (before) return { entry: before, existing: true }
  if (!n.startGiven && typeof actor !== 'string') {
    const seconds = secondsOf(entry)
    const rows = db.db
      .query(
        `SELECT ${COLUMNS} FROM time_entries WHERE client = ? AND project = ? AND description = ? AND by = ? AND at >= ? AND deleted IS NULL`,
      )
      .all(entry.client, entry.project, entry.description, actorText(actor), now - REPEAT_MS) as Row[]
    const repeat = rows.map(entryOf).find(e => secondsOf(e) === seconds)
    if (repeat) return { entry: repeat, existing: true }
  }
  try {
    return db.write(actorText(actor), tx => {
      // another process may have written it since the look above: the index tells
      const again = sameLive(db, entry)
      if (again) return { entry: again, existing: true }
      const made = { ...entry, id: newId(db) }
      insert(tx, made)
      tx.journal({ store: 'time', op: 'add', ref: made.id, after: made })
      return { entry: made, existing: false }
    })
  } catch (err) {
    // another process wrote the same entry between the look and the insert: that one is it
    const found = unique(err) ? sameLive(db, entry) : null
    if (found) return { entry: found, existing: true }
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
      const tags = new Set(e.tags)
      for (const tag of ch.addTags ?? []) if (cleanTag(tag)) tags.add(cleanTag(tag))
      for (const tag of ch.removeTags ?? []) tags.delete(cleanTag(tag))
      const moved = ch.start !== undefined || client !== e.client
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

/** An entry to another work date: the same wall clock in the client's zone on that date, the same duration. */
export function moveEntry(
  db: BoardDb,
  c: TimeConfig,
  id: string,
  date: string,
  actor: Actor,
  o: { force?: boolean; expect?: number } = {},
): TimeEntry {
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
export function removeEntry(db: BoardDb, id: string, actor: Actor, o: { force?: boolean } = {}): TimeEntry {
  return changed(db, id, actor, o, e => (e.deleted ? e : { ...e, deleted: Date.now() }), 'remove')
}

/** A removed entry back; one that is not removed stays as it is. */
export function restoreEntry(db: BoardDb, id: string, actor: Actor, o: { force?: boolean } = {}): TimeEntry {
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

/** Toggl ids already in the store, removed entries' too: what the import leaves alone. */
export function knownToggl(db: BoardDb): Set<string> {
  const rows = db.db.query('SELECT toggl FROM time_entries WHERE toggl IS NOT NULL').all() as { toggl: string }[]
  return new Set(rows.map(r => r.toggl))
}

/**
 * The import's entries, in transactions of `batch` (another writer waits milliseconds), each new
 * one with a journal row; one already there (its Toggl id, or a live entry alike) is skipped.
 */
export function importEntries(
  db: BoardDb,
  c: TimeConfig,
  entries: readonly Omit<NewEntry, 'startGiven'>[],
  now: number = Date.now(),
  batch = 500,
): { added: number; already: number } {
  const known = knownToggl(db)
  let added = 0
  let already = 0
  for (let at = 0; at < entries.length; at += batch) {
    db.write('import', tx => {
      for (const n of entries.slice(at, at + batch)) {
        if (n.toggl && known.has(n.toggl)) {
          already++
          continue
        }
        const e: TimeEntry = {
          id: newId(db),
          client: n.client,
          project: cleanText(n.project, 120),
          description: cleanText(n.description) || '-',
          tags: [...new Set((n.tags ?? []).map(cleanTag).filter(Boolean))],
          start: isoOf(n.start),
          stop: isoOf(n.stop),
          date: dateIn(n.start, zoneOf(c, n.client)),
          by: 'import',
          at: now,
          changed: now,
          changedBy: 'import',
          rev: 1,
          ...(n.toggl && { toggl: n.toggl }),
        }
        if (sameLive(db, e)) {
          already++
          continue
        }
        insert(tx, e)
        tx.journal({ store: 'time', op: 'import', ref: e.id, after: e })
        if (n.toggl) known.add(n.toggl)
        added++
      }
    })
  }
  return { added, already }
}
