// Threads (#379, core/work-threads.ts): a write, then the watchers told. Every write opens the
// board's database itself, as `board time` does, so it is durable the moment the command prints ok,
// with the board running or not (4.2).
//
// An event (6) is no stored message. When a change concerns a session that watches it, the board
// computes that session's digest from its cursor to now (every watched thread that changed, one
// clause each, never its own changes) and leaves it in the schedule as a one-off entry `by:
// 'threads'`, from `threads`, which the scheduler types in as "[board reminder from threads] ...":
// queued into a working session, waiting out a dialog or the owner's unsent text, following a
// session to its new pane, going to a MokuPilot day session's inbox. A session has one such entry
// at a time: a new change replaces the pending one's text, so ten changes before it goes out are one
// line. The first event after a quiet spell is due at once, the next one no sooner than the gap
// (threads.events.gapSec, 60 s) after it. The entry carries `noWake` unless one of the watches
// that matched asked for --wake: a sleeping session is not woken for it, and hears it when it is
// next awake (services/scheduler.ts). It carries `idle` when every watch that matched asked for it.
//
// A pending entry is replaced by removing it and adding the new one, never by changing its text in
// place: the scheduler reads an entry before it claims it, and a text changed in between would be
// lost as the old one went out; a removed entry's claim fails and the scheduler sends the new one.
// One already claimed is on its way and stays; the new entry follows it.
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type BoardDb, dbFile, openDb, type Tx } from '../adapters/db.ts'
import { stateDir } from '../adapters/paths.ts'
import { addEntry, listEntries, type NewEntry, updateEntry } from '../adapters/schedule-store.ts'
import {
  appendEntry,
  childrenOf,
  createThread,
  cursorOf,
  dropWatch,
  type EntryInput,
  entriesAfter,
  entriesOf,
  getThread,
  moveCursor,
  needsOwner,
  putWatch,
  ThreadError,
  threadsRev,
  watchesFor,
  watchesOf,
} from '../adapters/work-thread-store.ts'
import type { ThreadsPayload } from '../core/payload.ts'
import type { ScheduleEntry } from '../core/schedule-rules.ts'
import { agentBoardOf, isMirrored } from '../core/thread-import.ts'
import type { Config } from '../core/types.ts'
import { safeName } from '../core/upload-name.ts'
import {
  applyEntry,
  CHILDREN_MAX,
  cleanText,
  type DigestItem,
  digestLine,
  type EntrySet,
  EVENT_FROM,
  FILE_MAX_BYTES,
  FILES_MAX,
  isLocal,
  isOpen,
  isSession,
  LANE,
  LEVEL,
  LINK_MAX,
  LINKS_MAX,
  MINE,
  oneLine,
  type Party,
  SUMMARY_MAX,
  statusChanged,
  TEXT_MAX,
  type ThreadEntry,
  type ThreadFile,
  type ThreadHead,
  type ThreadLink,
  type ThreadStatus,
  type ThreadsConfig,
  TITLE_MAX,
  threadsConfig,
  WAITING_MAX,
  type Watch,
  type WatchWhat,
} from '../core/work-threads.ts'

// ------------------------------------------------------------------ the schedule an event goes into

/** The board's schedule as events use it: the tests give their own. */
export interface EventSchedule {
  list(): ScheduleEntry[]
  add(fields: NewEntry): ScheduleEntry
  /** Removes an entry unless the scheduler claimed it meanwhile; whether it was removed. */
  takeBack(id: string): boolean
}

export const fileSchedule: EventSchedule = {
  list: () => listEntries(),
  add: fields => addEntry(fields),
  // Under the entry's lock: one the scheduler claimed meanwhile is on its way and stays (undefined),
  // a removed one comes back as null.
  takeBack: id => updateEntry(id, e => (e.claim ? undefined : (null as unknown as ScheduleEntry))) === null,
}

/** The pending event of a session: one not claimed yet. */
const pendingOf = (schedule: EventSchedule, session: string): ScheduleEntry | undefined =>
  schedule.list().find(e => e.key === session && e.by === 'threads' && !e.claim)

// ------------------------------------------------------------------ a write's context

export interface ThreadsCtx {
  db: BoardDb
  cfg: ThreadsConfig
  /** Who writes: the session that runs the command, or the owner. */
  actor: Party
  now: number
  schedule?: EventSchedule
  /** The state folder, where entries' files are kept. */
  state?: string
  /** The board copying a pi task board (services/thread-import.ts): the one writer of mirrored threads. */
  mirror?: boolean
}

/** One write done: the thread's head after it and the entry, and the entries the board added (a parent's close). */
export interface Written {
  head: ThreadHead
  entry: ThreadEntry
  /** Sessions told of it, by key; watchers that could not be told. */
  told: string[]
  untold: number
}

const byOf = (p: Party): string => JSON.stringify(p)

/** Agents switched off as writers: a session's write is refused (14). */
function mayWrite(ctx: ThreadsCtx): void {
  if (ctx.actor.kind === 'session' && !ctx.cfg.agents)
    throw new ThreadError('agents_off', "threads are the owner's on this board: agents do not write to them")
}

/**
 * A thread copied from a pi task board changes there, never on the board (#393). The owner may still
 * close one (`set`: a status done or dropped, with a summary or a note), so that a copy the board can
 * no longer follow is never stuck open.
 */
export function notMirrored(ctx: Pick<ThreadsCtx, 'mirror' | 'actor'>, head: ThreadHead, set?: EntrySet): void {
  if (ctx.mirror || !isMirrored(head)) return
  const closes =
    !!set &&
    (set.status === 'done' || set.status === 'dropped') &&
    Object.keys(set).every(k => k === 'status' || k === 'summary')
  if (ctx.actor.kind === 'owner' && closes) return
  const from = agentBoardOf(head.origin)?.agentBoard
  throw new ThreadError(
    'mirrored',
    `${head.key} is a copy of ${from?.harness ?? 'pi'}'s task board${from ? ` (session ${from.session.slice(0, 8)})` : ''}: change it there, the board follows (the owner can close it here: done or dropped)`,
  )
}

function titleOf(v: unknown): string {
  const t = oneLine(v, 1000)
  if (!t) throw new ThreadError('no_title', 'a thread needs a title')
  if (t.length > TITLE_MAX)
    throw new ThreadError('title_long', `the title has ${t.length} characters; ${TITLE_MAX} at most`)
  return t
}
function lineOf(v: unknown, max: number, what: string): string {
  const t = oneLine(v, 10_000)
  if (t.length > max) throw new ThreadError(`${what}_long`, `the ${what} has ${t.length} characters; ${max} at most`)
  return t
}

/** The parent a thread may name: one with no parent of its own and room for another child. */
function parentFor(ctx: ThreadsCtx, parent: ThreadHead, child?: ThreadHead): void {
  notMirrored(ctx, parent)
  if (parent.parent) throw new ThreadError('nested', `${parent.key} is a sub-thread itself: one level only`)
  if (child && parent.id === child.id) throw new ThreadError('nested', 'a thread is not its own parent')
  if (child && childrenOf(ctx.db, child.id).length)
    throw new ThreadError('nested', `${child.key} has sub-threads: it cannot be one`)
  const kids = childrenOf(ctx.db, parent.id).filter(k => k.id !== child?.id).length
  if (kids >= CHILDREN_MAX) throw new ThreadError('children', `${parent.key} has ${CHILDREN_MAX} sub-threads already`)
}

const sessionWatch = (p: Party, target: string, what: WatchWhat): Omit<Watch, 'since'> | null =>
  p.kind === 'session' ? { session: p.key, name: p.name, target, what, idle: false, wake: false } : null

// ------------------------------------------------------------------ writes

/** `board thread new`: a thread in `lane`, `next` unless it is given to someone or started. */
export function newThread(
  ctx: ThreadsCtx,
  input: { lane: string; title: string; parent?: ThreadHead | null; to?: Party | null; doing?: boolean },
): Written {
  mayWrite(ctx)
  const lane = String(input.lane ?? '').toLowerCase()
  if (!LANE.test(lane)) throw new ThreadError('lane', `"${input.lane}" is not a lane id (letters, digits, - and _)`)
  const title = titleOf(input.title)
  if (input.parent) parentFor(ctx, input.parent)
  const status: ThreadStatus = input.doing || input.to ? 'doing' : 'next'
  const done = ctx.db.write(byOf(ctx.actor), tx => {
    const made = createThread(tx, {
      lane,
      title,
      status,
      author: ctx.actor,
      at: ctx.now,
      assignee: input.to ?? null,
      parent: input.parent?.id ?? null,
    })
    // The creator hears how it goes; the assignee hears the owner's answers to its questions.
    const own = sessionWatch(ctx.actor, made.head.id, 'status')
    if (own) putWatch(tx, own, ctx.now, true)
    const theirs = input.to && sessionWatch(input.to, made.head.id, 'answers')
    if (theirs) putWatch(tx, theirs, ctx.now, true)
    return made
  })
  return { ...done, ...tellWatchers(ctx, [done.head]) }
}

export interface PostInput {
  /** `answer` is the owner's, to a question (answerAsk). */
  type?: 'note' | 'ask' | 'answer'
  text?: string
  status?: ThreadStatus
  summary?: string
  waitingOn?: string
  /** Paths of files to copy into the thread. */
  files?: readonly string[]
  links?: readonly string[]
  replyTo?: string
  private?: boolean
  set?: EntrySet
}

const URL_LIKE = /^https?:\/\/\S+$/i

/** A link as an entry keeps it: http or https, a thread key, or a local path. */
function linkOf(raw: string): ThreadLink {
  const url = oneLine(raw, LINK_MAX + 1)
  if (!url) throw new ThreadError('link', 'an empty link')
  if (url.length > LINK_MAX) throw new ThreadError('link', `a link of ${url.length} characters; ${LINK_MAX} at most`)
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !URL_LIKE.test(url) && !/^[a-z]:[\\/]/i.test(url))
    throw new ThreadError('link', `${url}: a link is http or https, a thread key or a local path`)
  return { url }
}

/** Files copied into thread-files/<thread id>/ in the state folder, named after the entry; nothing is copied when one is refused. */
function copyFiles(ctx: ThreadsCtx, thread: string, entry: string, paths: readonly string[]): ThreadFile[] {
  if (paths.length > FILES_MAX) throw new ThreadError('files', `${paths.length} files; ${FILES_MAX} at most`)
  const found = paths.map(path => {
    let size: number
    try {
      const st = statSync(path)
      if (!st.isFile()) throw new Error('not a file')
      size = st.size
    } catch {
      throw new ThreadError('file', `${path}: no such file`)
    }
    if (size > FILE_MAX_BYTES)
      throw new ThreadError('file_big', `${path}: ${Math.ceil(size / 1048576)} MB; 5 MB at most on a local thread`)
    return { path, size, name: safeName(path) }
  })
  const dir = join(ctx.state ?? stateDir(), 'thread-files', thread)
  const out: ThreadFile[] = []
  try {
    for (const f of found) {
      mkdirSync(dir, { recursive: true })
      let name = `${entry.slice(0, 8)}-${f.name}`
      for (let i = 2; out.some(o => o.ref.endsWith(`/${name}`)); i++) name = `${entry.slice(0, 8)}-${i}-${f.name}`
      copyFileSync(f.path, join(dir, name))
      out.push({ name: f.name, size: f.size, ref: `thread-files/${thread}/${name}` })
    }
  } catch (err) {
    for (const o of out) rmSync(join(ctx.state ?? stateDir(), o.ref), { force: true })
    throw err
  }
  return out
}

/** Where a file of an entry is on this computer. */
export const filePath = (ref: string, state = stateDir()): string => join(state, ...ref.split('/'))

/**
 * One entry on `head` (`post`, `done`, `ask`, `set`). The last open sub-thread of a parent closing
 * writes a system entry on the parent, by the same author, so its watchers hear of it and the one
 * who closed it does not.
 */
export function postEntry(ctx: ThreadsCtx, head: ThreadHead, input: PostInput): Written {
  mayWrite(ctx)
  const set: EntrySet = { ...input.set }
  if (input.status !== undefined) set.status = input.status
  if (input.summary !== undefined) set.summary = lineOf(input.summary, SUMMARY_MAX, 'summary')
  notMirrored(ctx, head, input.waitingOn !== undefined ? { ...set, waitingOn: input.waitingOn } : set)
  if (input.waitingOn !== undefined) {
    set.waitingOn = lineOf(input.waitingOn, WAITING_MAX, 'waiting')
    if (set.status === undefined && head.status !== 'waiting' && head.status !== 'owner') set.status = 'waiting'
    if (set.status !== undefined && set.status !== 'waiting' && set.status !== 'owner')
      throw new ThreadError('waiting', `--waiting goes with --status waiting or owner, not ${set.status}`)
  }
  const text = cleanText(input.text ?? '', TEXT_MAX + 1)
  if (text.length > TEXT_MAX)
    throw new ThreadError('text_long', `the text has more than ${TEXT_MAX} characters: send a longer report as --file`)
  const links = (input.links ?? []).map(linkOf)
  if (links.length > LINKS_MAX) throw new ThreadError('links', `${links.length} links; ${LINKS_MAX} at most`)
  if (!text && !Object.keys(set).length && !links.length && !input.files?.length)
    throw new ThreadError('empty', 'nothing to post: give text, --status, --summary, --waiting, --file or --link')
  const entryId = randomUUID()
  const files = input.files?.length ? copyFiles(ctx, head.id, entryId, input.files) : []
  let done: { written: Written; heads: ThreadHead[] }
  try {
    done = ctx.db.write(byOf(ctx.actor), tx => {
      const entryInput: EntryInput = {
        id: entryId,
        at: ctx.now,
        author: ctx.actor,
        type: input.type ?? 'note',
        text,
        set,
        links,
        files,
        ...(input.replyTo && { replyTo: input.replyTo }),
        ...(input.private && { private: true }),
      }
      const r = appendEntry(tx, head.id, entryInput)
      const heads = [r.head]
      // A new assignee hears the owner's answers to its questions.
      const theirs = set.assignee && sessionWatch(set.assignee, head.id, 'answers')
      if (theirs) putWatch(tx, theirs, ctx.now, true)
      // The last open sub-thread closed: the parent says so.
      const parentId = r.head.parent
      if (parentId && isOpen(r.before.status) && !isOpen(r.head.status)) {
        const kids = tx.db.query('SELECT status FROM threads WHERE parent = ?').all(parentId) as {
          status: ThreadStatus
        }[]
        if (kids.length && kids.every(k => !isOpen(k.status))) {
          const p = appendEntry(tx, parentId, {
            at: ctx.now,
            author: ctx.actor,
            type: 'system',
            text: `all ${kids.length} sub-threads closed`,
            closed: kids.length,
          })
          heads.push(p.head)
        }
      }
      return { written: { head: r.head, entry: r.entry, told: [], untold: 0 }, heads }
    })
  } catch (err) {
    for (const f of files) rmSync(filePath(f.ref, ctx.state), { force: true })
    throw err
  }
  return { ...done.written, ...tellWatchers(ctx, done.heads) }
}

/** `board thread ask`: a question for the owner; the thread waits on the owner with it. */
export function askOwner(ctx: ThreadsCtx, head: ThreadHead, question: string): Written {
  const q = cleanText(question, TEXT_MAX + 1)
  if (!q) throw new ThreadError('empty', 'usage: board thread ask <key> "<question for the owner>"')
  return postEntry(ctx, head, { type: 'ask', text: q, status: 'owner', waitingOn: oneLine(q, WAITING_MAX) })
}

/** `board thread set`: the head's own fields, as an entry with no text. */
export function setFields(
  ctx: ThreadsCtx,
  head: ThreadHead,
  input: { title?: string; assignee?: Party | null; lane?: string; parent?: ThreadHead | null },
): Written {
  const set: EntrySet = {}
  if (input.title !== undefined) set.title = titleOf(input.title)
  if (input.assignee !== undefined) set.assignee = input.assignee
  if (input.lane !== undefined) {
    const lane = input.lane.toLowerCase()
    if (!LANE.test(lane)) throw new ThreadError('lane', `"${input.lane}" is not a lane id`)
    set.lane = lane
  }
  if (input.parent !== undefined) {
    if (input.parent) parentFor(ctx, input.parent, head)
    set.parent = input.parent?.id ?? null
  }
  if (!Object.keys(set).length)
    throw new ThreadError('empty', 'nothing to set: --title, --assignee, --lane or --parent')
  return postEntry(ctx, head, { set })
}

// ------------------------------------------------------------------ watches

export function watch(ctx: ThreadsCtx, w: Omit<Watch, 'session' | 'name' | 'since'> & { session: Party }): Watch {
  if (w.session.kind !== 'session')
    throw new ThreadError('no_session', 'only a session watches threads: run it from one, or pass --session')
  const session = w.session
  return ctx.db.write(byOf(ctx.actor), tx =>
    putWatch(
      tx,
      { session: session.key, name: session.name, target: w.target, what: w.what, idle: w.idle, wake: w.wake },
      ctx.now,
    ),
  )
}

export function unwatch(ctx: ThreadsCtx, session: string, target: string): number {
  return ctx.db.write(byOf(ctx.actor), tx => dropWatch(tx, session, target))
}

// ------------------------------------------------------------------ what a session hears

/** A thread before its first entry: what folding its feed starts from. */
const blankOf = (h: ThreadHead): ThreadHead => ({
  ...h,
  title: '',
  summary: '',
  status: 'next',
  waitingOn: '',
  proposed: null,
  assignee: null,
  parent: null,
  doneAt: null,
  rev: 0,
})

/** The least a watch must hear for this entry to reach it. */
function entryLevel(e: ThreadEntry, before: ThreadHead | null, after: ThreadHead): number {
  if (e.type === 'answer') return LEVEL.answers
  const proposed = after.proposed !== null && after.proposed !== (before?.proposed ?? null)
  if (e.closed || statusChanged(before, after) || proposed) return LEVEL.status
  if (e.type === 'ask') return LEVEL.asks
  return LEVEL.all
}

/** Whether `w` covers the thread `h` for the session `session`. */
function covers(w: Watch, h: ThreadHead, session: string): boolean {
  if (w.target === h.id) return true
  if (w.target === `lane:${h.lane}`) return true
  return w.target === MINE && (isSession(h.createdBy, session) || isSession(h.assignee, session))
}

interface Heard {
  items: DigestItem[]
  /** The watches that matched: they decide idle and wake. */
  matched: Watch[]
  /** Every entry seen, by thread. */
  byThread: Map<string, { head: ThreadHead; entries: ThreadEntry[] }>
}

/**
 * What `session` hears of the entries written after `since` and up to `until`: every thread one of
 * its watches covers, with the entries that watch is wide enough for and that came after the watch
 * began, never the session's own. `all`: every such entry, whatever the watch's width (`board
 * thread changes`).
 */
export function heardSince(db: BoardDb, session: string, since: number, until: number, all = false): Heard {
  const watches = watchesOf(db, session)
  const matched = new Set<Watch>()
  const byThread = new Map<string, { head: ThreadHead; entries: ThreadEntry[] }>()
  const items: DigestItem[] = []
  if (!watches.length) return { items, matched: [], byThread }
  const fresh = entriesAfter(db, since, until).filter(e => !isSession(e.author, session))
  const threads = new Map<string, ThreadEntry[]>()
  for (const e of fresh) threads.set(e.thread, [...(threads.get(e.thread) ?? []), e])
  for (const [id, list] of threads) {
    const head = getThread(db, id)
    if (!head) continue
    const ws = watches.filter(w => covers(w, head, session))
    if (!ws.length) continue
    // Each entry's head before and after it, folded from the start: whether its status changed.
    const states = new Map<string, { before: ThreadHead | null; after: ThreadHead }>()
    let h: ThreadHead | null = null
    for (const e of entriesOf(db, id)) {
      const after: ThreadHead = applyEntry(h ?? blankOf(head), e)
      states.set(e.id, { before: h, after })
      h = after
    }
    const heard: ThreadEntry[] = []
    let status = false
    let ask: string | undefined
    let closed: number | undefined
    let local = true
    for (const e of list) {
      const st = states.get(e.id)
      const level = st ? entryLevel(e, st.before, st.after) : LEVEL.all
      const by = ws.filter(w => e.seq > w.since && (all || LEVEL[w.what] >= level))
      if (!by.length) continue
      for (const w of by) matched.add(w)
      heard.push(e)
      if (level <= LEVEL.status) status = true
      if (e.type === 'ask') ask = e.text
      if (e.closed) closed = e.closed
      if (!isLocal(e.author)) local = false
    }
    if (!heard.length) continue
    byThread.set(id, { head, entries: heard })
    items.push({
      head,
      status,
      ...(ask !== undefined && { ask: oneLine(ask, SUMMARY_MAX) }),
      ...(closed && { closed }),
      entries: heard.length,
      local,
    })
  }
  // A parent whose only news is that its last sub-thread closed says nothing the line does not
  // already say when every one of its sub-threads is spelled out closed in it (one handed-out
  // child that finished, as in the design's worked example): its clause goes. `board thread
  // changes` still shows it.
  const closedHere = new Set(items.filter(i => i.status && !isOpen(i.head.status)).map(i => i.head.id))
  const told = items.filter(i => {
    const only = byThread.get(i.head.id)?.entries.every(e => e.closed)
    return !(only && i.closed && childrenOf(db, i.head.id).every(k => closedHere.has(k.id)))
  })
  return { items: told, matched: [...matched], byThread }
}

/** Who was told of a write, and how many watchers could not be (their sessions read `changes`). */
export interface Told {
  told: string[]
  untold: number
}

/**
 * Tells every session that watches one of `heads` what it has not heard yet, as one pending
 * schedule entry each (see the top of the file). Each session's turn runs in a transaction of the
 * board's database, which holds its write lock: two commands writing at once tell a session one
 * after the other, so the second finds and replaces the first one's entry and no session is left
 * with two. A session the schedule cannot take (one at its limit of entries) is counted untold and
 * reads its news with `board thread changes`.
 */
export function tellWatchers(ctx: ThreadsCtx, heads: readonly ThreadHead[]): Told {
  const schedule = ctx.schedule ?? fileSchedule
  const out: Told = { told: [], untold: 0 }
  const sessions = new Set<string>()
  try {
    for (const h of heads) for (const w of watchesFor(ctx.db, h)) if (covers(w, h, w.session)) sessions.add(w.session)
    if (ctx.actor.kind === 'session') sessions.delete(ctx.actor.key)
  } catch {
    out.untold = 1
    return out
  }
  for (const session of sessions) {
    try {
      if (ctx.db.write(byOf(ctx.actor), tx => tellOne(ctx, schedule, session, tx))) out.told.push(session)
    } catch {
      out.untold++
    }
  }
  return out
}

/** One session's event, under the database's write lock (`tx`); whether it was told anything new. */
function tellOne(ctx: ThreadsCtx, schedule: EventSchedule, session: string, tx: Tx): boolean {
  const rev = threadsRev(ctx.db)
  const cursor = cursorOf(ctx.db, session) ?? { seq: rev, at: 0, asked: rev }
  const pending = pendingOf(schedule, session)
  const pendingSince = typeof pending?.threadsSince === 'number' ? pending.threadsSince : undefined
  let since = pendingSince ?? cursor.seq
  let heard = heardSince(ctx.db, session, since, rev)
  if (!heard.items.length) return false
  let text = digestLine(heard.items)
  // Nothing new for this session in what was written: its pending event stands as it is.
  if (pending && pending.text === text) return false
  // Replaced, not changed in place; one claimed meanwhile goes as it is and this one follows it.
  const replaced = pending ? schedule.takeBack(pending.id) : false
  if (pending && !replaced) {
    since = cursor.seq
    heard = heardSince(ctx.db, session, since, rev)
    if (!heard.items.length) return false
    text = digestLine(heard.items)
  }
  // A watch that asked to wait for a free session, or to wake it, has its way: waiting only delays
  // the line, and waking is what that watch asked for.
  const wake = heard.matched.some(w => w.wake)
  const idle = heard.matched.some(w => w.idle)
  const next = replaced && pending ? pending.next : Math.max(ctx.now, cursor.at + ctx.cfg.gapSec * 1000)
  const name = heard.matched.find(w => w.name)?.name
  schedule.add({
    key: session,
    ...(name && { name }),
    text,
    at: next,
    next,
    by: 'threads',
    from: { ...EVENT_FROM },
    ...(wake ? {} : { noWake: true }),
    ...(idle && { idle: true }),
    threadsSince: since,
    threadsSeq: rev,
  })
  moveCursor(tx, session, { seq: rev, at: next })
  return true
}

/** One line per thread `board thread changes` prints: what changed since the session last asked. */
export interface Change {
  head: ThreadHead
  entries: number
  status: boolean
}

/**
 * `board thread changes`: what changed on the threads the session watches since it last asked,
 * every entry of them but its own. The session's place moves to now, and its pending event, which
 * says nothing this did not, is taken back, unless `peek`, or unless there are more than `shown`
 * threads to list (then nothing is marked read until it asks for all of them).
 */
export function changesFor(
  ctx: ThreadsCtx,
  session: string,
  { peek = false, shown = Number.POSITIVE_INFINITY }: { peek?: boolean; shown?: number } = {},
): { changes: Change[]; since: number; rev: number; moved: boolean } {
  return ctx.db.write(byOf(ctx.actor), tx => {
    const rev = threadsRev(ctx.db)
    const cursor = cursorOf(ctx.db, session)
    const since = cursor?.asked ?? rev
    const heard = heardSince(ctx.db, session, since, rev, true)
    const changes = [...heard.byThread.values()]
      .map(({ head, entries }) => ({
        head,
        entries: entries.length,
        status: heard.items.find(i => i.head.id === head.id)?.status ?? false,
      }))
      .sort((a, b) => b.head.updatedAt - a.head.updatedAt || b.head.rev - a.head.rev)
    const moved = !peek && changes.length <= shown
    if (moved) {
      moveCursor(tx, session, { asked: rev, seq: rev })
      const schedule = ctx.schedule ?? fileSchedule
      const pending = pendingOf(schedule, session)
      if (pending) schedule.takeBack(pending.id)
    }
    return { changes, since, rev, moved }
  })
}

// ------------------------------------------------------------------ the payload

/** What the board's payload says of threads while they are on: the revision and how many wait on the owner. */
export function threadsLine(db: BoardDb | null): ThreadsPayload {
  if (!db) return { rev: 0, needsOwner: 0 }
  return { rev: threadsRev(db), needsOwner: needsOwner(db) }
}

// The web board keeps one connection while threads are on; a command opens and closes its own.
let kept: { path: string; db: BoardDb } | null = null
function dropKept(): void {
  try {
    kept?.db.close()
  } catch {}
  kept = null
}

/**
 * The payload's line for the live config `cfg`: null while threads are off (nothing is read, no
 * connection is kept), zeros while there is no database yet (none is made for it).
 */
export function threadsPayload(cfg: Pick<Config, 'threads'>): ThreadsPayload | null {
  if (!threadsConfig(cfg.threads)) {
    if (kept) dropKept()
    return null
  }
  const path = dbFile()
  if (!existsSync(path)) {
    if (kept) dropKept()
    return { rev: 0, needsOwner: 0 }
  }
  try {
    if (kept && kept.path !== path) dropKept()
    if (!kept) {
      const db = openDb({ path, create: false })
      if (!db) return { rev: 0, needsOwner: 0 }
      kept = { path, db }
    }
    return threadsLine(kept.db)
  } catch {
    dropKept()
    return { rev: 0, needsOwner: 0 }
  }
}

let keep = false
/** The web board keeps one connection for the routes, the payload's (server/app.ts); elsewhere each call opens and closes its own. */
export function keepThreadsDb(on: boolean): void {
  keep = on
  if (!on) dropKept()
}

/**
 * The database for one call of the routes (server/routes/threads.ts): null when there is none and
 * `create` is false (nothing to read yet). On the web board the connection the payload keeps; a
 * failure that is not a thread's refusal drops it, so the next call opens it afresh.
 */
export function withThreadsDb<T>(create: boolean, fn: (db: BoardDb | null) => T): T {
  const path = dbFile()
  if (!keep) {
    if (!create && !existsSync(path)) return fn(null)
    const db = openDb({ path, create })
    try {
      return fn(db)
    } finally {
      db?.close()
    }
  }
  if (kept && (kept.path !== path || !existsSync(path))) dropKept()
  if (!kept) {
    if (!create && !existsSync(path)) return fn(null)
    const db = openDb({ path, create })
    if (!db) return fn(null)
    kept = { path, db }
  }
  try {
    return fn(kept.db)
  } catch (err) {
    if (!(err instanceof ThreadError)) dropKept()
    throw err
  }
}

// ------------------------------------------------------------------ the owner's answers (6.6, 3.5)

/**
 * The question the owner has not answered yet: the newest `ask` entry, while the thread has waited
 * on the owner ever since. An answer closes it, and so does any entry that moved the thread off
 * the owner (the agent recorded an answer given in its terminal, or went on); a proposed close
 * keeps the thread with the owner and leaves the question open.
 */
export function openAsk(head: ThreadHead, entries: readonly ThreadEntry[]): ThreadEntry | null {
  let h: ThreadHead | null = null
  let open: ThreadEntry | null = null
  for (const e of entries) {
    h = applyEntry(h ?? blankOf(head), e)
    if (e.type === 'ask') open = e
    else if (e.type === 'answer' || h.status !== 'owner') open = null
  }
  return head.status === 'owner' ? open : null
}

/** What a thread was before its question for the owner: the status an answer puts back, and what it waited on then. */
export function beforeAsk(
  head: ThreadHead,
  entries: readonly ThreadEntry[],
  ask: ThreadEntry,
): { status: ThreadStatus; waitingOn: string } {
  let h: ThreadHead | null = null
  let before: { status: ThreadStatus; waitingOn: string } = { status: 'doing', waitingOn: '' }
  for (const e of entries) {
    if (e.id === ask.id) break
    h = applyEntry(h ?? blankOf(head), e)
    if (h.status !== 'owner' && isOpen(h.status)) before = { status: h.status, waitingOn: h.waitingOn }
  }
  return before
}

/** The owner's answer written: the head after it, the session that asked (to be told), the words. */
export interface Answered extends Written {
  asker: Extract<Party, { kind: 'session' }> | null
  text: string
  /** The question it answers, as the asker's card holds it. */
  question: string
}

/**
 * The owner answers the thread's open question (6.6): an `answer` entry in reply to it, which puts
 * the status back to what it was before the question. Telling the session is the caller's (the
 * board's send(), and its card's ask cleared). Refused when nothing is asked.
 */
export function answerAsk(ctx: ThreadsCtx, head: ThreadHead, words: string): Answered {
  const text = cleanText(words, TEXT_MAX + 1)
  if (!text) throw new ThreadError('empty', 'an answer needs words')
  if (text.length > TEXT_MAX) throw new ThreadError('text_long', `the answer has more than ${TEXT_MAX} characters`)
  const entries = entriesOf(ctx.db, head.id)
  const ask = openAsk(head, entries)
  if (!ask) throw new ThreadError('no_ask', `${head.key} asks the owner nothing`)
  // A close the agent proposed meanwhile is the owner's to confirm or keep: an answer leaves it.
  if (head.proposed) throw new ThreadError('proposed', `${head.key} waits for Confirm or Keep open first`)
  const before = beforeAsk(head, entries, ask)
  const written = postEntry(ctx, head, {
    text,
    replyTo: ask.id,
    set: {
      status: before.status,
      ...(before.status === 'waiting' && before.waitingOn && { waitingOn: before.waitingOn }),
    },
    type: 'answer',
  })
  const asker = ask.author.kind === 'session' ? ask.author : null
  // `board thread ask` put the question on the card as the thread's waitingOn.
  return { ...written, asker, text, question: oneLine(ask.text, WAITING_MAX) }
}

/** The owner confirms an agent's proposed close (3.5): done, with the agent's words as the summary. */
export function confirmClose(ctx: ThreadsCtx, head: ThreadHead): Written {
  if (!head.proposed) throw new ThreadError('no_proposal', `nobody proposed ${head.key} done`)
  const summary = oneLine(head.proposed.why, SUMMARY_MAX)
  return postEntry(ctx, head, { status: 'done', ...(summary && { summary }) })
}

/** The owner keeps a proposed close open: the thread stays with the owner, the proposal goes. */
export function keepOpen(ctx: ThreadsCtx, head: ThreadHead): Written {
  if (!head.proposed) throw new ThreadError('no_proposal', `nobody proposed ${head.key} done`)
  return postEntry(ctx, head, { status: 'owner' })
}
