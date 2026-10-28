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

/** A Toggl row for the store: its lane, and Toggl's id or none (the Detailed report's CSV has none). */
export type ImportRow = Omit<NewEntry, 'startGiven' | 'newProject'>

/** A row the store has, changed in Toggl since: the entry, and the fields that differ. */
export interface ImportChange {
  id: string
  toggl: string | null
  start: string
  fields: string[]
}

export type ImportVerdict =
  | { kind: 'new'; entry: TimeEntry }
  | { kind: 'already'; stored: TimeEntry }
  | { kind: 'changed'; stored: TimeEntry; next: TimeEntry; fields: string[] }

const IMPORT_FIELDS = ['client', 'project', 'description', 'start', 'stop', 'tags'] as const

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
    ...(n.toggl && { toggl: n.toggl }),
  }
}

/**
 * What the store makes of a Toggl row. It is known again by Toggl's id, else by its lane and its
 * start to the second (a live entry first, then a removed one): the same in client, project,
 * description, start, stop and tags is `already`; a removed one stays removed (`already`); one
 * that differs is `changed`, with the fields, and is not added twice. A live entry alike in all
 * but tags, made by a session, is `already` too.
 */
export function importVerdict(
  db: BoardDb | null,
  c: TimeConfig,
  n: ImportRow,
  now: number = Date.now(),
): ImportVerdict {
  const entry = importedEntry(c, n, now)
  if (!db) return { kind: 'new', entry }
  const r = (
    n.toggl
      ? db.db.query(`SELECT ${COLUMNS} FROM time_entries WHERE toggl = ?`).get(n.toggl)
      : db.db
          .query(
            `SELECT ${COLUMNS} FROM time_entries WHERE client = ? AND start = ? ORDER BY deleted IS NOT NULL, at LIMIT 1`,
          )
          .get(entry.client, entry.start)
  ) as Row | null
  const stored = r ? entryOf(r) : sameLive(db, entry)
  if (!stored) return { kind: 'new', entry }
  if (stored.deleted) return { kind: 'already', stored }
  const fields = IMPORT_FIELDS.filter(f =>
    f === 'tags' ? [...stored.tags].sort().join('\u0000') !== entry.tags.join('\u0000') : stored[f] !== entry[f],
  )
  if (!fields.length || !r) return { kind: 'already', stored }
  return { kind: 'changed', stored, next: entry, fields }
}

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
  let added = 0
  let already = 0
  const changes: ImportChange[] = []
  const updated: ImportChange[] = []
  for (let at = 0; at < entries.length; at += batch) {
    db.write('import', tx => {
      for (const n of entries.slice(at, at + batch)) {
        const v = importVerdict(db, c, n, now)
        if (v.kind === 'already') {
          already++
          continue
        }
        if (v.kind === 'changed') {
          const change = { id: v.stored.id, toggl: v.stored.toggl ?? null, start: v.stored.start, fields: v.fields }
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
        insert(tx, e)
        tx.journal({ store: 'time', op: 'import', ref: e.id, after: e })
        added++
      }
    })
  }
  return { added, already, changed: changes, updated }
}
