// Threads in the board's database (#379, db-schema.ts step 5, core/work-threads.ts): the head of
// each thread in its row, the feed, the per-lane counter for keys, the watches and the cursors.
// Every entry is written with its journal row (store `threads`, op `new` or `post`, ref the
// thread's id, the head before and after), and the entry keeps that row's seq: the journal's
// last thread seq is the threads revision. Watches and cursors say who was told what: they change
// without a journal row, as a time entry's billing mark does not count as a change of it.
import { randomUUID } from 'node:crypto'
import {
  applyEntry,
  type EntrySet,
  type EntryType,
  ID_REF,
  isParty,
  isThreadStatus,
  keyNumber,
  keyOf,
  MINE,
  type Party,
  type Proposed,
  THREAD_KEY,
  type ThreadEntry,
  type ThreadFile,
  type ThreadHead,
  type ThreadLink,
  type ThreadStatus,
  type Watch,
  type WatchTarget,
  type WatchWhat,
  wider,
} from '../core/work-threads.ts'
import type { BoardDb, Tx } from './db.ts'

/** A refusal with a code (`--json`'s `error`) and words for a person. */
export class ThreadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ThreadError'
  }
}

interface HeadRow {
  id: string
  key: string
  lane: string
  title: string
  summary: string
  status: string
  waiting_on: string
  proposed: string | null
  assignee: string | null
  parent: string | null
  scope: string
  created_by: string
  created_at: number
  updated_at: number
  done_at: number | null
  rev: number
  origin: string | null
}

interface EntryRow {
  id: string
  thread: string
  n: number
  seq: number
  at: number
  author: string
  type: string
  text: string
  fields: string | null
  links: string | null
  files: string | null
  reply_to: string | null
  private: number
  closed: number | null
}

const HEAD_COLUMNS =
  'id, key, lane, title, summary, status, waiting_on, proposed, assignee, parent, scope, created_by, created_at, updated_at, done_at, rev, origin'
const ENTRY_COLUMNS = 'id, thread, n, seq, at, author, type, text, fields, links, files, reply_to, private, closed'

const parse = (s: string | null): unknown => {
  if (s === null) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v))
const partyOf = (s: string | null): Party | null => {
  const v = parse(s)
  return isParty(v) ? v : null
}

function headOf(r: HeadRow): ThreadHead {
  const proposed = parse(r.proposed) as Proposed | null
  return {
    id: r.id,
    key: r.key,
    lane: r.lane,
    title: r.title,
    summary: r.summary,
    status: isThreadStatus(r.status) ? r.status : 'next',
    waitingOn: r.waiting_on,
    proposed: proposed && isParty(proposed.by) ? proposed : null,
    assignee: partyOf(r.assignee),
    parent: r.parent,
    scope: 'local',
    createdBy: partyOf(r.created_by) ?? { kind: 'owner' },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    doneAt: r.done_at,
    rev: r.rev,
    ...(r.origin !== null && { origin: parse(r.origin) }),
  }
}

function entryOf(r: EntryRow): ThreadEntry {
  const set = parse(r.fields) as EntrySet | null
  const links = parse(r.links) as ThreadLink[] | null
  const files = parse(r.files) as ThreadFile[] | null
  return {
    id: r.id,
    thread: r.thread,
    n: r.n,
    seq: r.seq,
    at: r.at,
    author: partyOf(r.author) ?? { kind: 'owner' },
    type: (['note', 'ask', 'answer', 'system'].includes(r.type) ? r.type : 'note') as EntryType,
    text: r.text,
    ...(set && { set }),
    ...(links?.length && { links }),
    ...(files?.length && { files }),
    ...(r.reply_to && { replyTo: r.reply_to }),
    ...(r.private === 1 && { private: true }),
    ...(r.closed !== null && { closed: r.closed }),
  }
}

// ------------------------------------------------------------------ reading

export function getThread(db: BoardDb, id: string): ThreadHead | null {
  const r = db.db.query(`SELECT ${HEAD_COLUMNS} FROM threads WHERE id = ?`).get(id) as HeadRow | null
  return r ? headOf(r) : null
}

export function threadByKey(db: BoardDb, key: string): ThreadHead | null {
  const r = db.db.query(`SELECT ${HEAD_COLUMNS} FROM threads WHERE key = ?`).get(key) as HeadRow | null
  return r ? headOf(r) : null
}

/**
 * The thread a word names: its key, the first 8 characters of its id, or a bare number in `lane`
 * (the session's own). Refused with the reason when none or several match.
 */
export function findThread(db: BoardDb, word: string, lane: string | null): ThreadHead {
  const w = word.trim().toLowerCase().replace(/^#/, '')
  if (THREAD_KEY.test(w)) {
    const h = threadByKey(db, w)
    if (h) return h
  }
  if (/^\d{1,9}$/.test(w)) {
    if (!lane) throw new ThreadError('no_lane', `"${word}" is a number: give the whole key (<lane>-${w})`)
    const h = threadByKey(db, keyOf(lane, Number(w)))
    if (h) return h
  }
  if (ID_REF.test(w)) {
    const rows = db.db.query(`SELECT ${HEAD_COLUMNS} FROM threads WHERE id LIKE ? LIMIT 3`).all(`${w}%`) as HeadRow[]
    if (rows.length === 1) return headOf(rows[0] as HeadRow)
    if (rows.length > 1)
      throw new ThreadError('ambiguous', `"${word}" names several threads: ${rows.map(r => r.key).join(', ')}`)
  }
  throw new ThreadError('not_found', `no thread "${word}" on this board`)
}

export interface ListFilter {
  lane?: string
  status?: ThreadStatus
  /** Done and dropped ones too. */
  closed?: boolean
  /** Only these ids. */
  ids?: readonly string[]
}

/** Heads, the newest change first. */
export function listThreads(db: BoardDb, f: ListFilter = {}): ThreadHead[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (f.lane) {
    where.push('lane = ?')
    params.push(f.lane)
  }
  if (f.status) {
    where.push('status = ?')
    params.push(f.status)
  } else if (!f.closed) where.push("status NOT IN ('done', 'dropped')")
  if (f.ids) {
    if (!f.ids.length) return []
    where.push(`id IN (${f.ids.map(() => '?').join(', ')})`)
    params.push(...f.ids)
  }
  const sql = `SELECT ${HEAD_COLUMNS} FROM threads${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, key`
  return (db.db.query(sql).all(...params) as HeadRow[]).map(headOf)
}

/** The threads imported from one session's task board (#393), whatever their status. */
export function threadsFromBoard(db: BoardDb, harness: string, session: string): ThreadHead[] {
  return (
    db.db
      .query(
        `SELECT ${HEAD_COLUMNS} FROM threads WHERE origin IS NOT NULL AND json_valid(origin) AND json_extract(origin, '$.agentBoard.harness') = ? AND json_extract(origin, '$.agentBoard.session') = ?`,
      )
      .all(harness, session) as HeadRow[]
  ).map(headOf)
}

/**
 * What an import last read of an item, kept in the thread's origin (#393). Bookkeeping, as watches
 * are: no journal row, the thread's feed and revision stay as they are.
 */
export function setOrigin(tx: Tx, id: string, origin: unknown): void {
  tx.db.query('UPDATE threads SET origin = ? WHERE id = ?').run(json(origin), id)
}

/**
 * Threads copied from `harness`'s task boards of every session but `keep` become the board's own:
 * the copy of a day that is over stops, and they can be written to and closed (#393). How many.
 */
export function releaseMirrored(tx: Tx, harness: string, keep: string): number {
  return tx.db
    .query(
      `UPDATE threads SET origin = json_remove(origin, '$.mirrored') WHERE origin IS NOT NULL AND json_valid(origin) AND json_extract(origin, '$.mirrored') = 1 AND json_extract(origin, '$.agentBoard.harness') = ? AND json_extract(origin, '$.agentBoard.session') IS NOT ?`,
    )
    .run(harness, keep).changes
}

export function childrenOf(db: BoardDb, parent: string): ThreadHead[] {
  return (
    db.db.query(`SELECT ${HEAD_COLUMNS} FROM threads WHERE parent = ? ORDER BY key`).all(parent) as HeadRow[]
  ).map(headOf)
}

/** A thread's entries, oldest first: after `since` (an n), or the last `last`, or all. */
export function entriesOf(db: BoardDb, thread: string, o: { since?: number; last?: number } = {}): ThreadEntry[] {
  if (o.since !== undefined)
    return (
      db.db
        .query(`SELECT ${ENTRY_COLUMNS} FROM thread_entries WHERE thread = ? AND n > ? ORDER BY n, at, id`)
        .all(thread, o.since) as EntryRow[]
    ).map(entryOf)
  if (o.last !== undefined)
    return (
      db.db
        .query(`SELECT ${ENTRY_COLUMNS} FROM thread_entries WHERE thread = ? ORDER BY n DESC, at DESC, id DESC LIMIT ?`)
        .all(thread, Math.max(0, o.last)) as EntryRow[]
    )
      .map(entryOf)
      .reverse()
  return (
    db.db
      .query(`SELECT ${ENTRY_COLUMNS} FROM thread_entries WHERE thread = ? ORDER BY n, at, id`)
      .all(thread) as EntryRow[]
  ).map(entryOf)
}

export const entryCount = (db: BoardDb, thread: string): number =>
  (db.db.query('SELECT count(*) AS n FROM thread_entries WHERE thread = ?').get(thread) as { n: number }).n

/** Every entry written after the journal seq `seq` and up to `until`, oldest first. */
export function entriesAfter(db: BoardDb, seq: number, until = Number.MAX_SAFE_INTEGER): ThreadEntry[] {
  return (
    db.db
      .query(`SELECT ${ENTRY_COLUMNS} FROM thread_entries WHERE seq > ? AND seq <= ? ORDER BY seq, n`)
      .all(seq, until) as EntryRow[]
  ).map(entryOf)
}

/** The threads revision: the journal seq of the last entry written (0: none yet). */
export const threadsRev = (db: BoardDb): number =>
  (db.db.query('SELECT max(seq) AS s FROM thread_entries').get() as { s: number | null }).s ?? 0

/** Open threads that wait on the owner, proposed closes among them. */
export const needsOwner = (db: BoardDb): number =>
  (db.db.query("SELECT count(*) AS n FROM threads WHERE status = 'owner'").get() as { n: number }).n

// ------------------------------------------------------------------ writing

/** An entry as a write gives it; the store adds its n, seq and the thread's id. */
export interface EntryInput {
  id?: string
  at: number
  author: Party
  type: EntryType
  text?: string
  set?: EntrySet
  links?: ThreadLink[]
  files?: ThreadFile[]
  replyTo?: string
  private?: boolean
  closed?: number
}

const insertEntry = (tx: Tx, e: ThreadEntry): void => {
  tx.db
    .query(`INSERT INTO thread_entries (${ENTRY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      e.id,
      e.thread,
      e.n,
      e.seq,
      e.at,
      JSON.stringify(e.author),
      e.type,
      e.text,
      json(e.set && Object.keys(e.set).length ? e.set : null),
      json(e.links?.length ? e.links : null),
      json(e.files?.length ? e.files : null),
      e.replyTo ?? null,
      e.private ? 1 : 0,
      e.closed ?? null,
    )
}

const saveHead = (tx: Tx, h: ThreadHead, fresh: boolean): void => {
  const values = [
    h.id,
    h.key,
    h.lane,
    h.title,
    h.summary,
    h.status,
    h.waitingOn,
    json(h.proposed),
    json(h.assignee),
    h.parent,
    JSON.stringify(h.scope),
    JSON.stringify(h.createdBy),
    h.createdAt,
    h.updatedAt,
    h.doneAt,
    h.rev,
    json(h.origin),
  ]
  if (fresh)
    tx.db
      .query(`INSERT INTO threads (${HEAD_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...values)
  else
    tx.db
      .query(
        `UPDATE threads SET key = ?2, lane = ?3, title = ?4, summary = ?5, status = ?6, waiting_on = ?7, proposed = ?8, assignee = ?9, parent = ?10, scope = ?11, created_by = ?12, created_at = ?13, updated_at = ?14, done_at = ?15, rev = ?16, origin = ?17 WHERE id = ?1`,
      )
      .run(...values)
}

/**
 * The next key of `lane`: one above its counter and above every key of that lane the board holds
 * (one restored or, later, shared), never one in use.
 */
function mintKey(tx: Tx, lane: string): string {
  const seen = (tx.db.query('SELECT n FROM thread_seq WHERE lane = ?').get(lane) as { n: number } | null)?.n ?? 0
  const keys = tx.db.query('SELECT key FROM threads WHERE lane = ?').all(lane) as { key: string }[]
  let n = Math.max(seen, ...keys.map(k => (k.key.startsWith(`${lane}-`) ? keyNumber(k.key) : 0))) + 1
  while (tx.db.query('SELECT 1 FROM threads WHERE key = ?').get(keyOf(lane, n))) n++
  tx.db
    .query('INSERT INTO thread_seq (lane, n) VALUES (?, ?) ON CONFLICT (lane) DO UPDATE SET n = excluded.n')
    .run(lane, n)
  return keyOf(lane, n)
}

/** A new thread with its first entry (a system entry that sets its fields), in the transaction `tx`. */
export function createThread(
  tx: Tx,
  input: {
    lane: string
    title: string
    status: ThreadStatus
    author: Party
    at: number
    assignee?: Party | null
    parent?: string | null
    id?: string
    /** The first summary, and the first entry's text (an imported item's whole text, #393). */
    summary?: string
    text?: string
    /** Where an imported thread came from (3.2). */
    origin?: unknown
  },
): { head: ThreadHead; entry: ThreadEntry } {
  const id = input.id ?? randomUUID()
  const key = mintKey(tx, input.lane)
  const empty: ThreadHead = {
    id,
    key,
    lane: input.lane,
    title: input.title,
    summary: '',
    status: 'next',
    waitingOn: '',
    proposed: null,
    assignee: null,
    parent: null,
    scope: 'local',
    createdBy: input.author,
    createdAt: input.at,
    updatedAt: input.at,
    doneAt: null,
    rev: 0,
    ...(input.origin !== undefined && { origin: input.origin }),
  }
  const set: EntrySet = {
    title: input.title,
    status: input.status,
    lane: input.lane,
    ...(input.assignee && { assignee: input.assignee }),
    ...(input.parent && { parent: input.parent }),
    ...(input.summary && { summary: input.summary }),
  }
  const head = applyEntry(empty, {
    id: '',
    thread: id,
    n: 1,
    seq: 0,
    at: input.at,
    author: input.author,
    type: 'system',
    text: '',
    set,
  })
  saveHead(tx, head, true)
  const seq = tx.journal({ store: 'threads', op: 'new', ref: id, after: head })
  const entry: ThreadEntry = {
    id: randomUUID(),
    thread: id,
    n: 1,
    seq,
    at: input.at,
    author: input.author,
    type: 'system',
    text: input.text ?? '',
    set,
  }
  insertEntry(tx, entry)
  return { head, entry }
}

/** One entry on the thread `id`, its head folded and saved, in the transaction `tx`. */
export function appendEntry(
  tx: Tx,
  id: string,
  input: EntryInput,
): { before: ThreadHead; head: ThreadHead; entry: ThreadEntry } {
  const row = tx.db.query(`SELECT ${HEAD_COLUMNS} FROM threads WHERE id = ?`).get(id) as HeadRow | null
  if (!row) throw new ThreadError('not_found', 'no such thread')
  const before = headOf(row)
  const draft: ThreadEntry = {
    id: input.id ?? randomUUID(),
    thread: id,
    n: before.rev + 1,
    seq: 0,
    at: input.at,
    author: input.author,
    type: input.type,
    text: input.text ?? '',
    ...(input.set && Object.keys(input.set).length && { set: input.set }),
    ...(input.links?.length && { links: input.links }),
    ...(input.files?.length && { files: input.files }),
    ...(input.replyTo && { replyTo: input.replyTo }),
    ...(input.private && { private: true }),
    ...(input.closed !== undefined && { closed: input.closed }),
  }
  const head = applyEntry(before, draft)
  saveHead(tx, head, false)
  const seq = tx.journal({
    store: 'threads',
    op: 'post',
    ref: id,
    before,
    after: { head, entry: { ...draft, seq: undefined } },
  })
  const entry = { ...draft, seq }
  insertEntry(tx, entry)
  return { before, head, entry }
}

/** An entry of a thread by its id, its first 8 characters, or its number (`4`, `#4`). */
export function findEntry(db: BoardDb, thread: string, word: string): ThreadEntry {
  const w = word.trim().toLowerCase().replace(/^#/, '')
  if (!/^\d{1,9}$/.test(w) && !/^[0-9a-f][0-9a-f-]{3,35}$/.test(w))
    throw new ThreadError('no_entry', `"${word}" is not an entry: its number (4, #4) or its id`)
  const rows = /^\d{1,9}$/.test(w)
    ? (db.db
        .query(`SELECT ${ENTRY_COLUMNS} FROM thread_entries WHERE thread = ? AND n = ?`)
        .all(thread, Number(w)) as EntryRow[])
    : (db.db
        .query(`SELECT ${ENTRY_COLUMNS} FROM thread_entries WHERE thread = ? AND id LIKE ? LIMIT 2`)
        .all(thread, `${w}%`) as EntryRow[])
  if (rows.length === 1) return entryOf(rows[0] as EntryRow)
  throw new ThreadError('no_entry', `no entry "${word}" in that thread (its number, #4, or its id)`)
}

// ------------------------------------------------------------------ watches and cursors

interface WatchRow {
  session: string
  target: string
  what: string
  idle: number
  wake: number
  name: string
  since: number
}
const WATCH_COLUMNS = 'session, target, what, idle, wake, name, since'
const watchOf = (r: WatchRow): Watch => ({
  session: r.session,
  name: r.name,
  target: r.target,
  what: (['answers', 'status', 'asks', 'all'].includes(r.what) ? r.what : 'status') as WatchWhat,
  idle: r.idle === 1,
  wake: r.wake === 1,
  since: r.since,
})

/** A session's watches, or every watch. */
export function watchesOf(db: BoardDb, session?: string): Watch[] {
  const rows = session
    ? db.db.query(`SELECT ${WATCH_COLUMNS} FROM thread_watch WHERE session = ? ORDER BY at`).all(session)
    : db.db.query(`SELECT ${WATCH_COLUMNS} FROM thread_watch ORDER BY at`).all()
  return (rows as WatchRow[]).map(watchOf)
}

/** The watches that may concern `head`: on it, on its lane, or on `mine`. */
export function watchesFor(db: BoardDb, head: ThreadHead): Watch[] {
  return (
    db.db
      .query(`SELECT ${WATCH_COLUMNS} FROM thread_watch WHERE target IN (?, ?, ?)`)
      .all(head.id, `lane:${head.lane}`, MINE) as WatchRow[]
  ).map(watchOf)
}

/**
 * A session watches `target`. An explicit watch is as asked; one the board sets by itself (`auto`:
 * the creator's, the assignee's) only adds to what the session already has, never narrows it.
 * A watch hears only what is written after it began (`since`, the threads revision then), also when
 * the session watched other things before; changing a watch keeps when it began. A session's first
 * watch starts its cursor there too.
 */
export function putWatch(tx: Tx, w: Omit<Watch, 'since'>, at: number, auto = false): Watch {
  const had = tx.db
    .query(`SELECT ${WATCH_COLUMNS} FROM thread_watch WHERE session = ? AND target = ?`)
    .get(w.session, w.target) as WatchRow | null
  const old = had ? watchOf(had) : null
  const rev = (tx.db.query('SELECT max(seq) AS s FROM thread_entries').get() as { s: number | null }).s ?? 0
  const next: Watch =
    auto && old
      ? { ...old, what: wider(old.what, w.what), name: w.name || old.name }
      : { ...w, name: w.name || old?.name || '', since: old?.since ?? rev }
  tx.db
    .query(
      'INSERT INTO thread_watch (session, target, what, idle, wake, name, at, since) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session, target) DO UPDATE SET what = excluded.what, idle = excluded.idle, wake = excluded.wake, name = excluded.name',
    )
    .run(next.session, next.target, next.what, next.idle ? 1 : 0, next.wake ? 1 : 0, next.name, at, next.since)
  tx.db
    .query('INSERT INTO thread_cursor (session, seq, at, asked) VALUES (?, ?, 0, ?) ON CONFLICT (session) DO NOTHING')
    .run(next.session, rev, rev)
  return next
}

export function dropWatch(tx: Tx, session: string, target: WatchTarget): number {
  return tx.db.query('DELETE FROM thread_watch WHERE session = ? AND target = ?').run(session, target).changes
}

export interface Cursor {
  /** The last change an event was queued for. */
  seq: number
  /** When that event was due: the next one waits out the gap from it. */
  at: number
  /** The last change `board thread changes` showed. */
  asked: number
}

export function cursorOf(db: BoardDb, session: string): Cursor | null {
  return (
    (db.db.query('SELECT seq, at, asked FROM thread_cursor WHERE session = ?').get(session) as Cursor | null) ?? null
  )
}

/** Moves a session's cursor; a field left out stays. Never backwards. */
export function moveCursor(tx: Tx, session: string, to: Partial<Cursor>): void {
  tx.db
    .query(
      `INSERT INTO thread_cursor (session, seq, at, asked) VALUES (?1, coalesce(?2, 0), coalesce(?3, 0), coalesce(?4, 0))
       ON CONFLICT (session) DO UPDATE SET
         seq = max(seq, coalesce(?2, seq)), at = max(at, coalesce(?3, at)), asked = max(asked, coalesce(?4, asked))`,
    )
    .run(session, to.seq ?? null, to.at ?? null, to.asked ?? null)
}

/** The threads a session counts as its own: those it created or is assigned. */
export function mineIds(db: BoardDb, session: string): string[] {
  return (
    db.db
      .query(
        "SELECT id FROM threads WHERE json_extract(created_by, '$.key') = ?1 AND json_extract(created_by, '$.kind') = 'session' OR json_extract(assignee, '$.key') = ?1 AND json_extract(assignee, '$.kind') = 'session'",
      )
      .all(session) as { id: string }[]
  ).map(r => r.id)
}
