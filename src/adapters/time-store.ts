// Time entries in the board's database (#233, core/time.ts): add, change, move, remove and bring
// back, list, and the import's batch. Every change is one transaction with its journal row
// (adapters/db.ts write), so the web board, a session's `board time` and a billing agent writing
// at once never lose each other's change.
//
// Whose entries: a session changes its own entries; another session's, the owner's or the
// import's only with `force` (the owner asked for it; the master session while billing). The
// owner, on the board, changes any. A change can say which revision it read (`expect`): it is
// refused when the entry changed since.
//
// Entered into a client's systems (#240): a mark per entry and system (post, unpost), with the
// entry's revision then. A mark is no change of the entry (its revision stays), so anyone who may
// write marks any entry, without `force`; every mark and unmark has its journal row.
//
// A project renamed (#237, Settings → Time): the client's entries of it, however spelled and removed
// ones too, move to the new name in one transaction, a journal row each; a mark that was current
// stays so (the name is the board's own, nothing to change in the client's systems).
import { randomBytes } from 'node:crypto'
import { t } from '../core/lang.ts'
import {
  type Actor,
  billableByDefault,
  billableOf,
  cleanTag,
  cleanText,
  clientDay,
  clientOf,
  clockIn,
  dateIn,
  instantIn,
  isoOf,
  problemsText,
  projectIn,
  sameProject,
  secondsOf,
  systemsFor,
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
  billable: number | null
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
    ...(r.billable !== null && { billable: r.billable === 1 }),
  }
}

const COLUMNS =
  'id, client, project, description, tags, start, stop, date, by, at, changed, changed_by, rev, deleted, toggl, billable'

/** The column's value: 1 or 0 as set, NULL as the config says. */
const billableColumn = (e: Pick<TimeEntry, 'billable'>): number | null =>
  e.billable === undefined ? null : e.billable ? 1 : 0

export function getEntry(db: BoardDb, id: string): TimeEntry | null {
  const r = db.db.query(`SELECT ${COLUMNS} FROM time_entries WHERE id = ?`).get(id) as Row | null
  return r ? entryOf(r) : null
}

export interface ListQuery {
  from: string
  to: string
  client?: string | undefined
  tag?: string | undefined
  /** A project as the board matches names (core/time.ts sameProject: case and spaces aside). */
  project?: string | undefined
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
  const tag = q.tag ? cleanTag(q.tag) : ''
  return rows
    .map(entryOf)
    .filter(e => (!tag || e.tags.includes(tag)) && (q.project === undefined || sameProject(e.project, q.project)))
}

// ------------------------------------------------------------------ checks

/** No entry is written while config.json's `time` does not check out: its dates and rules would be guesses. */
function checkConfig(c: TimeConfig): void {
  if (c.problems.length) throw new TimeError('time.err.config', { problems: problemsText(c.problems, t) })
}

/**
 * The client takes time (and new entries, for one coming to it: it is on), and the project is one
 * of its own, not retired (an entry keeps a project retired since: `was`, the entry as it is); one
 * typed as new (`newProject`) is the name the client already has for it, case and spaces aside,
 * when it has one. The project's name to keep.
 */
function checkClientProject(
  c: TimeConfig,
  client: string,
  project: string,
  newProject: boolean,
  was?: Pick<TimeEntry, 'client' | 'project'>,
): string {
  const own = clientOf(c, client)
  if (!own.ok) {
    const known = Object.keys(c.clients ?? {}).join(', ')
    throw new TimeError('time.err.client', { client, known })
  }
  if (!own.client.on && was?.client !== client) throw new TimeError('time.err.clientOff', { client })
  if (!project) throw new TimeError('time.err.noProject')
  const projects = own.client.projects
  const retired = projectIn(own.client.retired, project)
  if (retired) {
    if (was?.client === client && was.project === project) return project
    throw new TimeError('time.err.retired', { project: retired, client })
  }
  if (!projects || projects.includes(project)) return project
  const listed = newProject ? projectIn(projects, project) : null
  if (listed) return listed
  if (!newProject) throw new TimeError('time.err.project', { project, client, known: projects.join(', ') })
  return project
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
    .query(`INSERT INTO time_entries (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
      billableColumn(e),
    )
}

function update(tx: Tx, e: TimeEntry): void {
  tx.db
    .query(
      'UPDATE time_entries SET client = ?, project = ?, description = ?, tags = ?, start = ?, stop = ?, date = ?, changed = ?, changed_by = ?, rev = ?, deleted = ?, billable = ? WHERE id = ?',
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
      billableColumn(e),
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
  /** Set billable or not; absent: as the config says. */
  billable?: boolean
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
  if (!description) throw new TimeError('time.err.noDescription')
  const project = checkClientProject(c, n.client, cleanText(n.project, 120), !!n.newProject)
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
    ...(n.billable !== undefined && { billable: n.billable }),
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
  /** Billable or not as set; null: back to what the config says. */
  billable?: boolean | null
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
      let project = ch.project !== undefined ? cleanText(ch.project, 120) : e.project
      // an entry keeps its client off or its project retired; one coming to them is refused
      if (ch.client !== undefined || ch.project !== undefined)
        project = checkClientProject(c, client, project, !!ch.newProject, e)
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
      const { billable: was, ...rest } = e
      // set the way the config has it already, on an entry that follows the config: no change
      const asConfig = was === undefined && ch.billable === billableByDefault(c, client, project)
      const billable = ch.billable === undefined ? was : ch.billable === null || asConfig ? undefined : ch.billable
      // billable last, where a read entry has it: the no-change check compares the two as JSON
      return {
        ...rest,
        client,
        project,
        description,
        tags: [...tags],
        start: isoOf(start),
        stop: isoOf(stop),
        date: moved ? dateIn(start, zoneOf(c, client)) : e.date,
        ...(billable !== undefined && { billable }),
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

/**
 * A client's project renamed (Settings → Time): its entries of `from`, however they spell it (case,
 * spaces and unseen characters aside: projectKey), removed ones too (restored, they come back under
 * the new name), moved to `to` in one transaction, each a revision more with its journal row
 * (`rename`, the entry before and after); one named `to` already is left as it is. A mark that was
 * current (entered at the entry's revision) moves with it (`rename-mark`), so a rename is no change
 * to make in the client's systems. `then` runs last, in that transaction (the config written):
 * when it throws, nothing is changed. db.write may run its function again when SQLite answered
 * busy at its start, before anything ran: `then` writes the same file again then, no harm. The
 * entries moved.
 */
export function renameProject(
  db: BoardDb,
  c: TimeConfig,
  client: string,
  from: string,
  to: string,
  actor: Actor,
  then: () => void = () => {},
): TimeEntry[] {
  checkConfig(c)
  return db.write(actorText(actor), tx => {
    const rows = db.db
      .query(`SELECT ${COLUMNS} FROM time_entries WHERE client = ? ORDER BY start, id`)
      .all(client) as Row[]
    const now = Date.now()
    const moved: TimeEntry[] = []
    for (const e of rows.map(entryOf).filter(x => x.project !== to && sameProject(x.project, from))) {
      const saved: TimeEntry = { ...e, project: to, changed: now, changedBy: actor, rev: e.rev + 1 }
      try {
        update(tx, saved)
      } catch (err) {
        if (unique(err)) throw new TimeError('time.err.sameAs', { id: e.id })
        throw err
      }
      tx.journal({ store: 'time', op: 'rename', ref: e.id, before: e, after: saved })
      for (const m of marksOf(db, [e.id]).get(e.id) ?? []) {
        if (m.rev !== e.rev) continue
        tx.db.query('UPDATE time_marks SET rev = ? WHERE entry = ? AND system = ?').run(saved.rev, e.id, m.system)
        tx.journal({
          store: 'time',
          op: 'rename-mark',
          ref: e.id,
          before: markJson(m),
          after: markJson({ ...m, rev: saved.rev }),
        })
      }
      moved.push(saved)
    }
    then()
    return moved
  })
}

/** How many entries a client has of a project, every spelling of it and removed ones too: what a rename moves. */
export function projectCount(db: BoardDb, client: string, name: string): number {
  const rows = db.db
    .query('SELECT project, COUNT(*) AS n FROM time_entries WHERE client = ? GROUP BY project')
    .all(client) as { project: string; n: number }[]
  return rows.filter(r => sameProject(r.project, name)).reduce((n, r) => n + r.n, 0)
}

/** How many live entries a client has of each project, as each is spelled (Settings → Time adds the spellings up). */
export function projectUse(db: BoardDb, client: string): Record<string, number> {
  const rows = db.db
    .query('SELECT project, COUNT(*) AS n FROM time_entries WHERE client = ? AND deleted IS NULL GROUP BY project')
    .all(client) as { project: string; n: number }[]
  return Object.fromEntries(rows.map(r => [r.project, r.n]))
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
  /** `alike`: the row is alike in the five unique fields to an entry another row has: said, never written */
  | { kind: 'changed'; stored: TimeEntry; next: TimeEntry; fields: string[]; alike?: true }

const IMPORT_FIELDS = ['client', 'project', 'description', 'start', 'stop', 'tags', 'billable'] as const

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
    ...(n.billable !== undefined && { billable: n.billable }),
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
    // the live ones first, then in the order they were made (rowid where two were made at once):
    // where no field tells two entries apart, the first made is the one a row is paired with
    const rows = db.db
      .query(`SELECT ${COLUMNS} FROM time_entries ORDER BY deleted IS NOT NULL, at, rowid`)
      .all() as Row[]
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
  /** The live entry at a lane and start alike in the five fields the store holds one of (taken or not). */
  sameLive(e: TimeEntry): TimeEntry | null {
    return (this.byStart.get(`${e.client}\u0000${e.start}`) ?? []).find(x => !x.deleted && sameKey(x, e)) ?? null
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

/** Alike in the five fields of which the store holds one live entry (its index time_live_same). */
const sameKey = (a: TimeEntry, b: TimeEntry): boolean =>
  a.client === b.client &&
  a.project === b.project &&
  a.description === b.description &&
  a.start === b.start &&
  a.stop === b.stop

/**
 * The fields a stored entry has otherwise than a Toggl row's. Billable only when the row says it
 * (the import takes Toggl's Billable on --billable-from-toggl), as each comes out: an entry that
 * follows the config and a row that says what the config says are the same.
 */
const differing = (c: TimeConfig, stored: TimeEntry, entry: TimeEntry): string[] =>
  IMPORT_FIELDS.filter(f =>
    f === 'tags'
      ? [...stored.tags].sort().join('\u0000') !== entry.tags.join('\u0000')
      : f === 'billable'
        ? entry.billable !== undefined && billableOf(c, stored) !== billableOf(c, entry)
        : stored[f] !== entry[f],
  )

/**
 * How the rows of one lane and start are paired with the entries the store has there, each pass
 * over the rows not yet paired: alike in every field first; then alike but for billable (a row
 * that says it, with --billable-from-toggl, still finds its own entry before another's); then the same project and
 * description (its stop or tags changed); the same project and stop (its words changed); the same
 * project; the same description; the same stop; then whatever is left, one to one. A removed entry
 * is paired only in the strong passes (up to project and stop): a new row at its start that shares
 * less with it is a new entry, not the removed one.
 */
const pairings = (c: TimeConfig): ((stored: TimeEntry, row: TimeEntry) => boolean)[] => [
  (a, b) => differing(c, a, b).length === 0,
  (a, b) => differing(c, a, b).every(f => f === 'billable'),
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
 * gave them, a lane and start at a time: its rows are paired with the entries there (pairings),
 * each entry with one row at most, so rows of one start that differ are each an entry of their
 * own. A row paired with an entry alike is `already`; with a removed one, `already` (it stays
 * removed); with one that differs (changed in Toggl, or moved or changed on the board), `changed`,
 * with the fields, and not added twice. A row left over that is alike in the five fields the
 * store holds one live entry of (client, project, description, start, stop) to an entry there or
 * to a row of this run is that entry: `already`, or `changed` with `alike` where its tags or
 * billable differ (said, never written: it is not the entry's own row). Any other row left over is
 * `new`, with a key of its own.
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
    const fields = differing(c, stored, entry)
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
    const passes = pairings(c)
    passes.forEach((pairs, p) => {
      // a removed entry only by what tells it is that row (up to project and stop)
      const strong = p <= 3
      for (const i of group) {
        if (out[i]) continue
        const stored = there.find(x => !index.isTaken(x) && (strong || !x.deleted) && pairs(x, entries[i] as TimeEntry))
        if (stored) out[i] = paired(stored, entries[i] as TimeEntry)
      }
    })
    for (const i of group) {
      if (out[i]) continue
      const e = entries[i] as TimeEntry
      // alike in the five fields to an entry the store has, or one this run adds (it is in the
      // index): the store holds one, so this row is that one, never a new one
      const twin = index.sameLive(e)
      if (twin) {
        const fields = differing(c, twin, e)
        out[i] = fields.length
          ? { kind: 'changed', stored: twin, next: e, fields, alike: true }
          : { kind: 'already', stored: twin }
        continue
      }
      if (!rows[i]?.toggl) e.toggl = index.freeKey(e.client, Date.parse(e.start))
      index.add(e)
      index.take(e)
      out[i] = { kind: 'new', entry: e }
    }
  }
  return out as ImportVerdict[]
}

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
 * one with a journal row. One the store has (importVerdicts) is counted, not added. A changed one is
 * listed; with `update`, Toggl's values replace the entry's when the board never changed it (made
 * and last changed by the import), journaled as `import-update`, its work date stamped again.
 */
export function importEntries(
  db: BoardDb,
  c: TimeConfig,
  entries: readonly ImportRow[],
  o: {
    update?: boolean
    now?: number
    batch?: number
    /** Each entry it wrote (added, or updated from Toggl): whose projects join the lanes' lists. */
    wrote?: (e: TimeEntry) => void
  } = {},
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
  const wrote = o.wrote ?? (() => {})
  for (let at = 0; at < verdicts.length; at += batch) {
    db.write('import', tx => {
      for (const v of verdicts.slice(at, at + batch)) {
        if (v.kind === 'already') {
          already++
          continue
        }
        if (v.kind === 'changed') {
          const change = changeOf(v)
          // a row alike to an entry another row has is said, never written (two rows would take turns)
          const mine = !v.alike && v.stored.by === 'import' && v.stored.changedBy === 'import'
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
          wrote(saved)
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
        wrote(e)
      }
    })
  }
  return { added, already, changed: changes, updated }
}

// ------------------------------------------------------------------ entered into the clients' systems

/** An entry entered into one of its client's systems. */
export interface Mark {
  entry: string
  system: string
  at: number
  by: Actor
  /** That system's own id for what was entered (a time record's, a worklog's); null: none given. */
  record: string | null
  /** The entry's revision it was entered at: a later one on the entry is a change after entering. */
  rev: number
}

interface MarkRow {
  entry: string
  system: string
  at: number
  by: string
  record: string | null
  rev: number
}

const markOf = (r: MarkRow): Mark => ({ ...r, by: actorOf(r.by) })
/** A mark as its journal row keeps it. */
const markJson = (m: Mark) => ({ ...m, by: actorText(m.by) })

const MARK_COLUMNS = 'entry, system, at, by, record, rev'

function markIn(db: BoardDb, entry: string, system: string): Mark | null {
  const r = db.db
    .query(`SELECT ${MARK_COLUMNS} FROM time_marks WHERE entry = ? AND system = ?`)
    .get(entry, system) as MarkRow | null
  return r ? markOf(r) : null
}

/** The marks of these entries, by entry, each entry's in the order of their systems' ids. */
export function marksOf(db: BoardDb, ids: readonly string[]): Map<string, Mark[]> {
  const out = new Map<string, Mark[]>()
  for (let at = 0; at < ids.length; at += 500) {
    const chunk = ids.slice(at, at + 500)
    const rows = db.db
      .query(
        `SELECT ${MARK_COLUMNS} FROM time_marks WHERE entry IN (${chunk.map(() => '?').join(', ')}) ORDER BY system`,
      )
      .all(...chunk) as MarkRow[]
    for (const r of rows) out.set(r.entry, [...(out.get(r.entry) ?? []), markOf(r)])
  }
  return out
}

/** The system is one of the client's: refused otherwise, naming the ones it has. */
function checkSystem(c: TimeConfig, client: string, system: string): void {
  const systems = systemsFor(c, client)
  if (!systems.some(x => x.id === system))
    throw new TimeError('time.err.system', { client, system, known: systems.map(x => x.id).join(', ') || '-' })
}

/** An entry to mark: its id, the revision read (refused when it moved on), and what the mark keeps. */
export interface PostItem {
  id: string
  /** The entry's revision as read: refused when the entry changed since. */
  rev?: number
  /** That system's id for the record; null: none; absent: the earlier mark's, if any. */
  record?: string | null
  /** The revision the mark records (an Undo putting an earlier mark back); absent: the entry's now. */
  asOf?: number
}

/**
 * Entries marked entered into `system`, one of each entry's client's systems, in one transaction:
 * when, by whom, `record` (the item's, else `o.record`, else the earlier mark's), and the entry's
 * revision now (or the item's `asOf`, no later than it). A mark already as it would be is left as
 * it is; each one written has its journal row (`post`, the mark before and after), and is given
 * back. The entry does not change. All or none: a removed, unknown or changed entry refuses the
 * whole call.
 */
export function postEntries(
  db: BoardDb,
  c: TimeConfig,
  items: readonly PostItem[],
  system: string,
  actor: Actor,
  o: { record?: string; now?: number } = {},
): Mark[] {
  checkConfig(c)
  const now = o.now ?? Date.now()
  return db.write(actorText(actor), tx =>
    items.flatMap(item => {
      const e = getEntry(db, item.id)
      if (!e) throw new TimeError('time.err.gone', { id: item.id })
      if (e.deleted) throw new TimeError('time.err.removed', { id: e.id })
      if (item.rev !== undefined && item.rev !== e.rev)
        throw new TimeError('time.err.changedSince', { id: e.id, rev: e.rev })
      checkSystem(c, e.client, system)
      const asOf = item.asOf ?? e.rev
      if (!Number.isInteger(asOf) || asOf < 1 || asOf > e.rev) throw new TimeError('time.err.rev')
      const before = markIn(db, e.id, system)
      const given = item.record !== undefined ? item.record : o.record
      const record =
        given === undefined ? (before?.record ?? null) : given === null ? null : cleanText(given, 200) || null
      if (before && before.rev === asOf && before.record === record) return []
      const after: Mark = { entry: e.id, system, at: now, by: actor, record, rev: asOf }
      tx.db
        .query(
          `INSERT INTO time_marks (${MARK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (entry, system) DO UPDATE SET at = excluded.at, by = excluded.by, record = excluded.record, rev = excluded.rev`,
        )
        .run(after.entry, after.system, after.at, actorText(after.by), after.record, after.rev)
      tx.journal({
        store: 'time',
        op: 'post',
        ref: e.id,
        before: before ? markJson(before) : null,
        after: markJson(after),
      })
      return [after]
    }),
  )
}

/**
 * Entries' marks in `system` taken off, in one transaction, each with its journal row (`unpost`,
 * the mark it was). An entry with no mark there is left as it is; the system must be one of its
 * client's, or one it has a mark in (a system since gone from the config). The removed marks.
 */
export function unpostEntries(
  db: BoardDb,
  c: TimeConfig,
  items: readonly Pick<PostItem, 'id' | 'rev'>[],
  system: string,
  actor: Actor,
): Mark[] {
  checkConfig(c)
  return db.write(actorText(actor), tx => {
    const removed: Mark[] = []
    for (const item of items) {
      const e = getEntry(db, item.id)
      if (!e) throw new TimeError('time.err.gone', { id: item.id })
      if (item.rev !== undefined && item.rev !== e.rev)
        throw new TimeError('time.err.changedSince', { id: e.id, rev: e.rev })
      const before = markIn(db, e.id, system)
      if (!before) {
        checkSystem(c, e.client, system)
        continue
      }
      tx.db.query('DELETE FROM time_marks WHERE entry = ? AND system = ?').run(e.id, system)
      tx.journal({ store: 'time', op: 'unpost', ref: e.id, before: markJson(before), after: null })
      removed.push(before)
    }
    return removed
  })
}
