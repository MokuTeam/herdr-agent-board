// Threads in the board's database (#379, db-schema.ts step 5, core/work-threads.ts): the head of
// each thread in its row, the feed, the per-lane counter for keys, the watches and the cursors.
// Every entry is written with its journal row (store `threads`, op `new` or `post`, ref the
// thread's id, the head before and after), and the entry keeps that row's seq: the journal's
// last thread seq is the threads revision. Watches and cursors say who was told what: they change
// without a journal row, as a time entry's billing mark does not count as a change of it.
import { randomUUID } from 'node:crypto'
import { MAX_WORK_N } from '../core/team-wire.ts'
import { foldShared } from '../core/work-share.ts'
import {
  afterN,
  applyEntry,
  type CaseState,
  type EntryOut,
  type EntrySet,
  type EntryType,
  ID_REF,
  isEntryOut,
  isParty,
  isThreadStatus,
  keyNumber,
  keyOf,
  MINE,
  type Party,
  type Proposed,
  type SharedScope,
  sharedOf,
  sharingOf,
  THREAD_KEY,
  type ThreadEntry,
  type ThreadFile,
  type ThreadHead,
  type ThreadLink,
  type ThreadScope,
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
  ref: string | null
  state: string | null
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
  out: string | null
}

const HEAD_COLUMNS =
  'id, key, lane, title, summary, status, waiting_on, proposed, assignee, parent, scope, created_by, created_at, updated_at, done_at, rev, origin, ref, state'
const ENTRY_COLUMNS = 'id, thread, n, seq, at, author, type, text, fields, links, files, reply_to, private, closed, out'

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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strs = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : undefined

/**
 * A thread's scope as stored (#394): `"local"` as every thread had it, a local one a share was
 * asked for, or a shared one; anything else reads as local.
 */
function scopeOf(s: string): ThreadScope {
  const v = parse(s)
  if (!isObj(v)) return 'local'
  if (v.kind === 'local') {
    const r = v.request
    if (!isObj(r) || typeof r.to !== 'string' || !isParty(r.by) || typeof r.at !== 'number') return 'local'
    return { kind: 'local', request: { to: r.to, history: r.history === true, by: r.by, at: r.at } }
  }
  if (v.kind !== 'peer' && v.kind !== 'team' && v.kind !== 'channel') return 'local'
  if (typeof v.topic !== 'string' || typeof v.key !== 'string' || typeof v.by !== 'string') return 'local'
  const members = strs(v.members)
  const offer = isObj(v.offer) && typeof v.offer.by === 'string' && typeof v.offer.at === 'number' ? v.offer : null
  return {
    kind: v.kind,
    ...(typeof v.peer === 'string' && { peer: v.peer }),
    ...(members && { members }),
    topic: v.topic,
    key: v.key,
    by: v.by,
    at: typeof v.at === 'number' ? v.at : 0,
    ...(offer && { offer: { by: offer.by as string, at: offer.at as number } }),
    ...(typeof v.ended === 'number' && { ended: v.ended }),
  }
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
    scope: scopeOf(r.scope),
    createdBy: partyOf(r.created_by) ?? { kind: 'owner' },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    doneAt: r.done_at,
    rev: r.rev,
    ...(r.origin !== null && { origin: parse(r.origin) }),
    // Case files (#488): only once set, so the heads of a board without them are as they were.
    ...(r.ref !== null && r.ref !== '' && { ref: r.ref }),
    ...(stateOf(r.state) && { state: stateOf(r.state) as CaseState }),
  }
}

/** A case's state as stored (#488): JSON {text, at, by}; anything else is none. */
function stateOf(s: string | null): CaseState | null {
  const v = parse(s)
  if (!isObj(v) || typeof v.text !== 'string' || typeof v.at !== 'number' || !isParty(v.by)) return null
  return { text: v.text, at: v.at, by: v.by }
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
    ...(isEntryOut(r.out) && { out: r.out }),
  }
}

// ------------------------------------------------------------------ reading

export function getThread(db: Pick<BoardDb, 'db'>, id: string): ThreadHead | null {
  const r = db.db.query(`SELECT ${HEAD_COLUMNS} FROM threads WHERE id = ?`).get(id) as HeadRow | null
  return r ? headOf(r) : null
}

export function threadByKey(db: BoardDb, key: string): ThreadHead | null {
  const r = db.db.query(`SELECT ${HEAD_COLUMNS} FROM threads WHERE key = ?`).get(key) as HeadRow | null
  return r ? headOf(r) : null
}

/**
 * The thread a word names: its key, the first 8 characters of its id (or the whole id), or a bare number in `lane`
 * (the session's own). Refused with the reason when none or several match.
 */
export function findThread(db: BoardDb, word: string, lane: string | null, exact = false): ThreadHead {
  const w = word.trim().toLowerCase().replace(/^#/, '')
  if (THREAD_KEY.test(w)) {
    const h = sameKey(db, w, exact)
    if (h) return h
  }
  const number = /^\d{1,9}$/.test(w)
  if (number && lane) {
    const h = sameKey(db, keyOf(lane, Number(w)))
    if (h) return h
  }
  // An id's first 8 characters can all be digits (#572): a number that names no thread is tried as one.
  if (ID_REF.test(w)) {
    const rows = db.db.query(`SELECT ${HEAD_COLUMNS} FROM threads WHERE id LIKE ? LIMIT 3`).all(`${w}%`) as HeadRow[]
    if (rows.length === 1) return headOf(rows[0] as HeadRow)
    if (rows.length > 1)
      throw new ThreadError('ambiguous', `"${word}" names several threads: ${rows.map(r => r.key).join(', ')}`)
  }
  if (number && !lane) throw new ThreadError('no_lane', `"${word}" is a number: give the whole key (<lane>-${w})`)
  throw new ThreadError('not_found', `no thread "${word}" on this board`)
}

/**
 * The thread a whole key names (11.5): a peer's thread whose key this board had minted too goes by
 * `key@name`, and the bare key then names both: refused with each one's key and 8-character ref.
 */
function sameKey(db: BoardDb, key: string, exact = false): ThreadHead | null {
  const h = threadByKey(db, key)
  if (key.includes('@') || (exact && h)) return h
  const others = (
    db.db
      .query(`SELECT ${HEAD_COLUMNS} FROM threads WHERE substr(key, 1, ?1) = ?2 AND substr(key, ?1 + 1, 1) = '@'`)
      .all(key.length, key) as HeadRow[]
  ).map(headOf)
  const all = [...(h ? [h] : []), ...others]
  if (all.length > 1)
    throw new ThreadError(
      'ambiguous',
      `"${key}" names ${all.length} threads: ${all.map(t => `${t.key} (${t.id.slice(0, 8)})`).join(', ')}`,
    )
  return all[0] ?? null
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

/** The threads that carry an outside reference (#488), whatever their status; the caller matches them (core/work-cases.ts sameRef). */
export function threadsWithRef(db: BoardDb): ThreadHead[] {
  return (
    db.db
      .query(`SELECT ${HEAD_COLUMNS} FROM threads WHERE ref IS NOT NULL AND ref <> '' ORDER BY updated_at DESC, key`)
      .all() as HeadRow[]
  ).map(headOf)
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

/**
 * A thread's entries, oldest first: after `since` (an n; on a thread that is or was shared, a
 * private entry with that number too: afterN), or the last `last`, or all.
 */
export function entriesOf(
  db: Pick<BoardDb, 'db'>,
  thread: string,
  o: { since?: number; last?: number; shared?: boolean } = {},
): ThreadEntry[] {
  if (o.since !== undefined) {
    const since = o.since
    return (
      db.db
        .query(
          `SELECT ${ENTRY_COLUMNS} FROM thread_entries WHERE thread = ? AND n ${o.shared ? '>=' : '>'} ? ORDER BY n, at, id`,
        )
        .all(thread, since) as EntryRow[]
    )
      .map(entryOf)
      .filter(e => afterN(e, since, o.shared === true))
  }
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

/**
 * Open threads that wait on the owner, proposed closes among them, and (#394) those an agent asked
 * to share and those a peer offered this board: each waits for the owner's press.
 */
export const needsOwner = (db: BoardDb): number =>
  (
    db.db
      .query(
        "SELECT count(*) AS n FROM threads WHERE status = 'owner' OR (json_valid(scope) AND (json_extract(scope, '$.request') IS NOT NULL OR json_extract(scope, '$.offer') IS NOT NULL))",
      )
      .get() as { n: number }
  ).n

// ------------------------------------------------------------------ shared threads (#394)

/** An entry by its id, or null. */
export function entryById(db: Pick<BoardDb, 'db'>, id: string): ThreadEntry | null {
  const r = db.db.query(`SELECT ${ENTRY_COLUMNS} FROM thread_entries WHERE id = ?`).get(id) as EntryRow | null
  return r ? entryOf(r) : null
}

/** Whether a thread has this key. */
export const keyTaken = (db: Pick<BoardDb, 'db'>, key: string): boolean =>
  !!db.db.query('SELECT 1 FROM threads WHERE key = ?').get(key)

/** The threads that are shared, whatever their status. */
export function sharedThreads(db: BoardDb): ThreadHead[] {
  return (
    db.db
      .query(
        `SELECT ${HEAD_COLUMNS} FROM threads WHERE json_valid(scope) AND json_extract(scope, '$.kind') IN ('peer', 'team', 'channel')`,
      )
      .all() as HeadRow[]
  )
    .map(headOf)
    .filter(h => sharedOf(h) !== null)
}

/** Entries in these states, oldest first. */
export function entriesWithOut(db: BoardDb, outs: readonly EntryOut[]): ThreadEntry[] {
  if (!outs.length) return []
  return (
    db.db
      .query(
        `SELECT ${ENTRY_COLUMNS} FROM thread_entries WHERE out IN (${outs.map(() => '?').join(', ')}) ORDER BY seq`,
      )
      .all(...outs) as EntryRow[]
  ).map(entryOf)
}

/** How far a shared entry got. Bookkeeping, as a watch is: no journal row, the revision stays. */
export function setOut(db: BoardDb | Tx, id: string, out: EntryOut | null): boolean {
  return db.db.query('UPDATE thread_entries SET out = ? WHERE id = ?').run(out, id).changes > 0
}

/** A thread's scope (#394), changed with the entry that says so. */
export function setScope(tx: Tx, id: string, scope: ThreadScope): void {
  tx.db.query('UPDATE threads SET scope = ? WHERE id = ?').run(JSON.stringify(scope), id)
}

/** How far above this board's own numbers a peer's key still counts when this board mints one (11.5). */
export const PEER_KEY_REACH = 1000

/** An entry's counter at most: what the wire takes (core/team-wire.ts MAX_WORK_N). */
const MAX_ENTRY_N = MAX_WORK_N

/** Entries a peer may have written in one thread here at most (#394): a peer cannot grow it without end. */
export const MAX_PEER_ENTRIES = 2000

/** How many entries peers wrote in a thread. */
export const peerEntries = (db: Pick<BoardDb, 'db'>, thread: string): number =>
  (
    db.db
      .query("SELECT count(*) AS n FROM thread_entries WHERE thread = ? AND json_extract(author, '$.kind') = 'peer'")
      .get(thread) as { n: number }
  ).n

/** A shared thread's head folded again from all its entries (after many were added at once). */
export function refoldShared(tx: Tx, id: string, me: string): ThreadHead | null {
  const row = tx.db.query(`SELECT ${HEAD_COLUMNS} FROM threads WHERE id = ?`).get(id) as HeadRow | null
  if (!row) return null
  const head = foldShared(headOf(row), entriesOf(tx, id), me)
  saveHead(tx, head, false)
  return head
}

/**
 * A peer's thread, new here (#394): its head as the first entry that came will set it, with no
 * entry of its own; the entries that came are appended after it. Its key is the one given (the
 * sharer's, or with `@name` after it, 11.5); the lane's counter moves past it.
 */
export function createShared(
  tx: Tx,
  input: { id: string; key: string; lane: string; title: string; author: Party; at: number; scope: SharedScope },
): ThreadHead {
  const head: ThreadHead = {
    id: input.id,
    key: input.key,
    lane: input.lane,
    title: input.title,
    summary: '',
    status: 'next',
    waitingOn: '',
    proposed: null,
    assignee: null,
    parent: null,
    scope: input.scope,
    createdBy: input.author,
    createdAt: input.at,
    updatedAt: input.at,
    doneAt: null,
    rev: 0,
  }
  saveHead(tx, head, true)
  tx.journal({ store: 'threads', op: 'new', ref: input.id, after: head })
  return head
}

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
  /** A shared thread's entry (#394): how far it got, or where it came from. */
  out?: EntryOut
  /** Its counter, when another board gave it (#394); else one above the thread's. */
  n?: number
}

const insertEntry = (tx: Tx, e: ThreadEntry): void => {
  tx.db
    .query(`INSERT INTO thread_entries (${ENTRY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
      e.out ?? null,
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
    h.ref ?? null,
    json(h.state),
  ]
  if (fresh)
    tx.db
      .query(`INSERT INTO threads (${HEAD_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...values)
  else
    tx.db
      .query(
        `UPDATE threads SET key = ?2, lane = ?3, title = ?4, summary = ?5, status = ?6, waiting_on = ?7, proposed = ?8, assignee = ?9, parent = ?10, scope = ?11, created_by = ?12, created_at = ?13, updated_at = ?14, done_at = ?15, rev = ?16, origin = ?17, ref = ?18, state = ?19 WHERE id = ?1`,
      )
      .run(...values)
}

/**
 * The next key of `lane`: one above its counter and above every key of that lane the board holds
 * (one restored or, later, shared), never one in use.
 */
function mintKey(tx: Tx, lane: string): string {
  const seen = (tx.db.query('SELECT n FROM thread_seq WHERE lane = ?').get(lane) as { n: number } | null)?.n ?? 0
  const keys = tx.db.query('SELECT key, created_by FROM threads WHERE lane = ?').all(lane) as {
    key: string
    created_by: string
  }[]
  const numberOf = (k: { key: string }): number => (k.key.startsWith(`${lane}-`) ? keyNumber(k.key) : 0)
  const byPeer = (k: { created_by: string }): boolean => partyOf(k.created_by)?.kind === 'peer'
  const own = Math.max(seen, ...keys.filter(k => !byPeer(k)).map(numberOf))
  // A peer's key (#394, 11.5) keeps this board's numbers above it while it is near them; one far
  // ahead (a peer's choice) is passed by, so no peer can use up this lane's numbers.
  const near = keys
    .filter(byPeer)
    .map(numberOf)
    .filter(x => x <= own + PEER_KEY_REACH)
  let n = Math.max(own, ...near) + 1
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
    /** A case's outside reference (#488). */
    ref?: string
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
    ...(input.ref && { ref: input.ref }),
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
  /** This board's peer id (#394): a shared thread's head is its entries folded in the shared order. */
  me?: string,
  /** Not folded now: the caller folds once after many (refoldShared). */
  later = false,
): { before: ThreadHead; head: ThreadHead; entry: ThreadEntry } {
  const row = tx.db.query(`SELECT ${HEAD_COLUMNS} FROM threads WHERE id = ?`).get(id) as HeadRow | null
  if (!row) throw new ThreadError('not_found', 'no such thread')
  const before = headOf(row)
  // An entry of this board that never reaches the peers of a shared thread: a private one (#541),
  // or one written with nothing to send it (no `out`: the parent's "all N sub-threads closed",
  // #548). It is private, and takes the number of the entry it follows (as an adoption takes its
  // sender's), since a number of its own would leave a hole the peers read as entries missing
  // (4.3, rule 3). A peer's entry is numbered by its board, or is next in this one's feed. A
  // caller whose entry is meant to go out sets `out` (postEntry does).
  // A peer's thread whose sharing ended counts too (#569): what this board writes there stays home
  // if its sharer shares it again, so a number of its own would outrank the share.
  const was = sharingOf(before)
  const home =
    (sharedOf(before) !== null || (was?.ended !== undefined && was.by !== 'me')) &&
    input.n === undefined &&
    input.author.kind !== 'peer' &&
    (input.private === true || input.out === undefined)
  const n = home ? before.rev : before.rev + 1
  const draft: ThreadEntry = {
    id: input.id ?? randomUUID(),
    thread: id,
    n: input.n ?? n,
    seq: 0,
    at: input.at,
    author: input.author,
    type: input.type,
    text: input.text ?? '',
    ...(input.set && Object.keys(input.set).length && { set: input.set }),
    ...(input.links?.length && { links: input.links }),
    ...(input.files?.length && { files: input.files }),
    ...(input.replyTo && { replyTo: input.replyTo }),
    ...((input.private || home) && { private: true }),
    ...(input.closed !== undefined && { closed: input.closed }),
    ...(input.out && { out: input.out }),
  }
  // A shared thread (#394): every entry it holds, this one among them, in the order every board
  // folds it in; an entry that came late lands where it belongs.
  if (draft.n > MAX_ENTRY_N) throw new ThreadError('counter', 'the thread has no numbers left for entries')
  const shared = sharedOf(before) !== null && me !== undefined && !later
  const head = shared ? foldShared(before, [...entriesOf(tx, id), draft], me) : applyEntry(before, draft)
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

/**
 * An entry of a thread by its id, its first 8 characters, or its number (`4`, `#4`). An id's first
 * characters can all be digits (#572): a number that names no entry is tried as the start of an id.
 */
export function findEntry(db: BoardDb, thread: string, word: string): ThreadEntry {
  const w = word.trim().toLowerCase().replace(/^#/, '')
  const idLike = /^[0-9a-f][0-9a-f-]{3,35}$/.test(w)
  if (!/^\d{1,9}$/.test(w) && !idLike)
    throw new ThreadError('no_entry', `"${word}" is not an entry: its number (4, #4) or its id`)
  const byNumber = /^\d{1,9}$/.test(w)
    ? (db.db
        .query(`SELECT ${ENTRY_COLUMNS} FROM thread_entries WHERE thread = ? AND n = ?`)
        .all(thread, Number(w)) as EntryRow[])
    : []
  const number = byNumber.length > 0
  const rows = number
    ? byNumber
    : idLike
      ? (db.db
          .query(`SELECT ${ENTRY_COLUMNS} FROM thread_entries WHERE thread = ? AND id LIKE ? LIMIT 2`)
          .all(thread, `${w}%`) as EntryRow[])
      : []
  if (rows.length === 1) return entryOf(rows[0] as EntryRow)
  // One number, several entries: on a shared thread a private entry takes the number of the entry
  // it follows (#541), and two boards may write the same number at once. The number is the one
  // entry the peers hold by it, when there is one; else the entry goes by its id.
  const found = rows.map(entryOf)
  const open = found.filter(e => !e.private)
  if (number && open.length === 1) return open[0] as ThreadEntry
  if (number && found.length > 1)
    throw new ThreadError(
      'no_entry',
      `#${w} is ${found.length} entries: give its id (${found.map(e => e.id.slice(0, 8)).join(', ')})`,
    )
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

/** A watch as given, `since` and all, unless the session watches that target already (#403). */
export function addWatchKept(tx: Tx, w: Watch, at: number): void {
  tx.db
    .query(
      'INSERT INTO thread_watch (session, target, what, idle, wake, name, at, since) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (session, target) DO NOTHING',
    )
    .run(w.session, w.target, w.what, w.idle ? 1 : 0, w.wake ? 1 : 0, w.name, at, w.since)
}

/** Every watch of `session` but those on the targets `keep` names; how many went. */
export function dropWatchesOf(tx: Tx, session: string, keep: readonly WatchTarget[] = []): number {
  const marks = keep.map(() => '?').join(', ')
  const sql = `DELETE FROM thread_watch WHERE session = ?${keep.length ? ` AND target NOT IN (${marks})` : ''}`
  return tx.db.query(sql).run(session, ...keep).changes
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

/** A session's cursor as given, back or forward (#403); null removes it. */
export function setCursor(tx: Tx, session: string, to: Cursor | null): void {
  if (!to) {
    tx.db.query('DELETE FROM thread_cursor WHERE session = ?').run(session)
    return
  }
  tx.db
    .query(
      'INSERT INTO thread_cursor (session, seq, at, asked) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (session) DO UPDATE SET seq = ?2, at = ?3, asked = ?4',
    )
    .run(session, to.seq, to.at, to.asked)
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
