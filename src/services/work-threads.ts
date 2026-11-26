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
import { readKey } from '../adapters/team-store.ts'
import {
  addWatchKept,
  appendEntry,
  childrenOf,
  createThread,
  cursorOf,
  dropWatch,
  dropWatchesOf,
  type EntryInput,
  entriesAfter,
  entriesOf,
  getThread,
  mineIds,
  moveCursor,
  needsOwner,
  putWatch,
  setCursor,
  ThreadError,
  threadsRev,
  threadsWithRef,
  watchesFor,
  watchesOf,
} from '../adapters/work-thread-store.ts'
import { parseNodeKey } from '../core/node-key.ts'
import { OWNER } from '../core/owner-watch.ts'
import type { ThreadsPayload } from '../core/payload.ts'
import { MAX_TEXT, type ScheduleEntry } from '../core/schedule-rules.ts'
import { agentBoardOf, isMirrored } from '../core/thread-import.ts'
import type { Config } from '../core/types.ts'
import { safeName } from '../core/upload-name.ts'
import { cleanRef, cleanState, REF_MAX, STATE_LINES, STATE_MAX, sameRef } from '../core/work-cases.ts'
import {
  ACCEPT_LINE_MAX,
  ACCEPT_MAX,
  applyEntry,
  CHILDREN_MAX,
  cleanText,
  type DigestItem,
  digestLine,
  type EntryOut,
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
  laneIsDefault,
  MINE,
  OWNER as OWNER_PARTY,
  oneLine,
  type Party,
  SUMMARY_MAX,
  sharedOf,
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
  /**
   * This board's peer id on the hub (#394): a shared thread's entries are folded in the order
   * (n, at, author's peer id). Read from the board's key when it is not given.
   */
  me?: string
  /**
   * The owner's entry of a shared thread waits for the owner's Send on the board's page (#394):
   * written by the `board` command outside a session, which any program could run as the owner.
   */
  ownerHolds?: boolean
  /** Resolves a session key to the full board key (`@<node>:<key>` for node sessions) when scheduling. */
  resolveKey?: (key: string) => string
}

/** One write done: the thread's head after it and the entry, and the entries the board added (a parent's close). */
export interface Written {
  head: ThreadHead
  entry: ThreadEntry
  /** Sessions told of it, by key; watchers that could not be told. */
  told: string[]
  untold: number
  /** Open threads with the same outside reference (#488), the lane's own first; only when there are any. The write was done anyway. */
  sameRef?: { key: string; title: string; lane: string }[]
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
// ------------------------------------------------------------------ case files (#488, core/work-cases.ts)

/** Case fields are written only where config.json turned cases on. */
function casesOn(ctx: ThreadsCtx): void {
  if (!ctx.cfg.cases)
    throw new ThreadError('cases_off', 'case files are off: "threads": { "cases": true } in config.json')
}

function refOf(v: unknown): string {
  const r = cleanRef(v)
  if (r.ok) return r.ref
  if (r.why === 'empty') throw new ThreadError('ref', 'an empty reference: a ticket id or a link (none clears it)')
  throw new ThreadError('ref_long', `the reference has ${r.length} characters; ${REF_MAX} at most`)
}

function caseStateOf(v: unknown): string {
  const r = cleanState(v)
  if (r.ok) return r.text
  if (r.why === 'empty')
    throw new ThreadError('state', 'an empty state: where it stands, what is next, what it waits on')
  if (r.why === 'lines') throw new ThreadError('state_lines', `the state has ${r.length} lines; ${STATE_LINES} at most`)
  throw new ThreadError(
    'state_long',
    `the state has ${r.length} characters; ${STATE_MAX} at most: put the rest in a --file`,
  )
}

/** The open threads whose reference names the same thing (#488), the lane's own first, three at most. */
function sameRefOpen(ctx: ThreadsCtx, ref: string, lane: string, except?: string): Written['sameRef'] {
  const hits = threadsWithRef(ctx.db)
    .filter(h => h.id !== except && isOpen(h.status) && !!h.ref && sameRef(ref, h.ref))
    .sort((a, b) => Number(b.lane === lane) - Number(a.lane === lane))
    .slice(0, 3)
    .map(h => ({ key: h.key, title: h.title, lane: h.lane }))
  return hits.length ? hits : undefined
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
  input: {
    lane: string
    title: string
    parent?: ThreadHead | null
    to?: Party | null
    doing?: boolean
    /** A case's outside reference (#488): cases on only. */
    ref?: string
    /** Verified done (#492): the thread asks for it, and its acceptance lines. */
    verify?: boolean
    accept?: readonly string[]
    /** Lane was only the creator's default (not given by --lane or --to) (#903). */
    laneDefault?: boolean
  },
): Written {
  mayWrite(ctx)
  const lane = String(input.lane ?? '').toLowerCase()
  if (!LANE.test(lane)) throw new ThreadError('lane', `"${input.lane}" is not a lane id (letters, digits, - and _)`)
  const title = titleOf(input.title)
  if (input.parent) parentFor(ctx, input.parent)
  if (input.ref !== undefined) casesOn(ctx)
  const ref = input.ref !== undefined ? refOf(input.ref) : undefined
  const same = ref ? sameRefOpen(ctx, ref, lane) : undefined
  const status: ThreadStatus = input.doing || input.to ? 'doing' : 'next'
  // A lane in verify.lanes: its new threads ask for verification, which only the owner turns off.
  const byLane = !!ctx.cfg.verify?.lanes.includes(lane)
  if ((input.verify || input.accept?.length) && !ctx.cfg.verify) verifyOff()
  const accept = acceptLines(input.accept ?? [], 0)
  const done = ctx.db.write(byOf(ctx.actor), tx => {
    const made = createThread(tx, {
      lane,
      title,
      status,
      author: ctx.actor,
      at: ctx.now,
      assignee: input.to ?? null,
      parent: input.parent?.id ?? null,
      ...(ref && { ref }),
      ...((input.verify || byLane) && { verify: { on: true, lane: byLane } }),
      ...(input.laneDefault && { laneDefault: true }),
    })
    // Acceptance lines given with it: an entry each, by its creator (#492).
    for (const line of accept)
      made.head = appendEntry(tx, made.head.id, {
        at: ctx.now,
        author: ctx.actor,
        type: 'note',
        set: { accept: line },
      }).head
    // The creator hears how it goes; the assignee hears the owner's answers to its questions.
    const own = sessionWatch(ctx.actor, made.head.id, 'status')
    if (own) putWatch(tx, own, ctx.now, true)
    const theirs = input.to && sessionWatch(input.to, made.head.id, 'answers')
    if (theirs) putWatch(tx, theirs, ctx.now, true)
    return made
  })
  return { ...done, ...tellWatchers(ctx, [done.head]), ...(same && { sameRef: same }) }
}

export interface PostInput {
  /** `answer` is the owner's, to a question (answerAsk); `system` the board's own (sharing, #394). */
  type?: 'note' | 'ask' | 'answer' | 'system'
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
  /** How the entry starts on the hub's way (#394): `queued` on a shared thread unless private. */
  out?: EntryOut
  /** Where the case stands (#488): cases on only. */
  state?: string
  /** Acceptance lines to add (#492): one entry carries one; more than one: an entry each after it. */
  accept?: readonly string[]
  /** Owner post written directly by the owner (CLI `post` or `/api/threads/:id` `post`) opts into direct wake/delivery (#693). */
  directOwner?: boolean
  /** Suppresses direct wake/delivery on internal owner transitions (#693). */
  noDirect?: boolean
}

/** Verified done is off on this board (#492). */
function verifyOff(): never {
  throw new ThreadError('verify_off', 'verification is off on this board (threads.verify in config.json)')
}

/** Acceptance lines as a thread keeps them: one line each, refused when too long or too many. */
function acceptLines(raw: readonly string[], had: number): string[] {
  const lines = raw.map(l => oneLine(l, 10_000)).filter(Boolean)
  for (const l of lines)
    if (l.length > ACCEPT_LINE_MAX)
      throw new ThreadError('accept_long', `an acceptance line has ${l.length} characters; ${ACCEPT_LINE_MAX} at most`)
  if (had + lines.length > ACCEPT_MAX)
    throw new ThreadError('accept', `${had + lines.length} acceptance lines; ${ACCEPT_MAX} at most`)
  return lines
}

/**
 * Whether a done is held for a verifier (#492): a session's, on a thread that asks for verification,
 * while the board verifies (threads.verify) and the thread is open and not waiting on the owner
 * (there the owner is the gate: today's proposal). The owner's own done is never held.
 */
export function holdsDone(ctx: Pick<ThreadsCtx, 'cfg' | 'actor'>, head: ThreadHead, set: EntrySet): boolean {
  return (
    set.status === 'done' &&
    set.verdict === undefined &&
    ctx.actor.kind === 'session' &&
    !!ctx.cfg.verify &&
    !!head.verify?.on &&
    isOpen(head.status) &&
    head.status !== 'owner'
  )
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
 * The `out` of an entry this board writes on `head` (11.1): on a shared thread one that is not
 * private goes to the peers, held first when the owner holds the owner's entries; none elsewhere.
 */
export function outOf(
  ctx: Pick<ThreadsCtx, 'ownerHolds' | 'actor'>,
  head: ThreadHead,
  priv = false,
): EntryOut | undefined {
  if (!sharedOf(head) || priv) return undefined
  return ctx.ownerHolds && ctx.actor.kind === 'owner' ? 'held' : 'queued'
}

/** This board's peer id, which a shared thread's entries are folded and numbered with (#394). */
export const meOf = (ctx: Pick<ThreadsCtx, 'me'>): string => ctx.me ?? readKey()?.pub ?? ''

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
  if (input.state !== undefined) {
    casesOn(ctx)
    set.state = caseStateOf(input.state)
  }
  if (input.accept?.length && !ctx.cfg.verify) verifyOff()
  // The verifier changes nothing (#492): its verdict is all it writes (the board's entries about it carry its name too).
  if (isSession(ctx.actor, head.verify?.run?.key ?? '') && set.verdict === undefined && set.verifier === undefined)
    throw new ThreadError(
      'verifier',
      `the verifier of ${head.key} writes nothing but its verdict: board thread verdict`,
    )
  const [accept, ...moreAccept] = acceptLines(input.accept ?? [], head.verify?.accept.length ?? 0)
  if (accept) set.accept = accept
  if (holdsDone(ctx, head, set)) {
    if (head.proposed?.verify)
      throw new ThreadError(
        'held',
        `${head.key}: its done is being verified; wait for the verdict, or post --status doing to take it back`,
      )
    set.hold = true
  }
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
  // A shared thread (#394): its entry goes to the peers unless private, one file at most, and only
  // the owner drops it; its head is folded in the order every board folds it in.
  const shared = sharedOf(head)
  if (shared) {
    if (set.status === 'dropped' && ctx.actor.kind !== 'owner')
      throw new ThreadError('owner_only', `${head.key} is shared: only the owner drops it`)
    if ((input.files?.length ?? 0) > 1) throw new ThreadError('files', `${head.key} is shared: one file per entry`)
  }
  // An entry with nothing but fields that stay on this board stays here: case fields (#488: a state,
  // a reference) on any thread, verification's own (#492) on a shared one, and the two together;
  // a peer's board would get an empty line.
  const keys = Object.keys(set)
  const caseKey = (k: string): boolean => k === 'ref' || k === 'state'
  const verifyKey = (k: string): boolean => k === 'verify' || k === 'verifyLane' || k === 'accept'
  const fieldsOnly = !text && !links.length && !input.files?.length && keys.length > 0
  const home = fieldsOnly && keys.every(k => caseKey(k) || verifyKey(k)) && (keys.every(caseKey) || !!shared)
  const priv = !!input.private || home
  const out = input.out ?? outOf(ctx, head, priv)
  const me = shared || input.out ? meOf(ctx) : undefined
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
        ...(priv && { private: true }),
        ...(out && { out }),
      }
      let r = appendEntry(tx, head.id, entryInput, me)
      for (const line of moreAccept) {
        const more = appendEntry(
          tx,
          head.id,
          { at: ctx.now, author: ctx.actor, type: 'note', set: { accept: line } },
          me,
        )
        r = { ...r, head: more.head }
      }
      const heads = [r.head]
      // A held done (#492): its writer hears the verdict that sends it back.
      const held = set.hold && sessionWatch(ctx.actor, head.id, 'answers')
      if (held) putWatch(tx, held, ctx.now, true)
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
  return {
    ...done.written,
    ...tellWatchers(
      ctx,
      done.heads,
      input.directOwner && !input.noDirect && isOwnerPostContent(done.written.entry)
        ? (() => {
            const target = ownerPostTarget(done.written.head)
            return target ? { session: target.key, name: target.name, seq: done.written.entry.seq } : undefined
          })()
        : undefined,
    ),
  }
}

/** `board thread ask`: a question for the owner; the thread waits on the owner with it. */
export function askOwner(ctx: ThreadsCtx, head: ThreadHead, question: string): Written {
  const q = cleanText(question, TEXT_MAX + 1)
  if (!q) throw new ThreadError('empty', 'usage: board thread ask <key> "<question for the owner>"')
  return postEntry(ctx, head, { type: 'ask', text: q, status: 'owner', waitingOn: oneLine(q, WAITING_MAX) })
}

/** The flags `board thread set` takes on this board: --ref with case files, --verify with verified done. */
function settable(ctx: Pick<ThreadsCtx, 'cfg'>): string {
  const flags = [
    '--title',
    '--assignee',
    '--lane',
    '--parent',
    ...(ctx.cfg.cases ? ['--ref'] : []),
    ...(ctx.cfg.verify ? ['--verify'] : []),
  ]
  return `${flags.slice(0, -1).join(', ')} or ${flags.at(-1)}`
}

/** `board thread set`: the head's own fields, as an entry with no text. */
export function setFields(
  ctx: ThreadsCtx,
  head: ThreadHead,
  input: {
    title?: string
    assignee?: Party | null
    lane?: string
    parent?: ThreadHead | null
    /** A case's outside reference (#488), null to clear it: cases on only. */
    ref?: string | null
    /** Verified done on or off (#492). */
    verify?: boolean
    /** The new assignee's lane (#903): moves the thread there when its lane was only the creator's default. */
    assigneeLane?: string | null
  },
): Written {
  const set: EntrySet = {}
  if (input.ref !== undefined) {
    casesOn(ctx)
    set.ref = input.ref === null ? null : refOf(input.ref)
  }
  if (input.verify !== undefined) {
    if (!ctx.cfg.verify) verifyOff()
    if (!input.verify) mayLiftGate(ctx.actor, head)
    if (!!head.verify?.on !== input.verify) set.verify = input.verify
    else if (!Object.keys(input).some(k => k !== 'verify'))
      throw new ThreadError('same', `${head.key} has verify ${input.verify ? 'on' : 'off'} already`)
  }
  if (input.title !== undefined) set.title = titleOf(input.title)
  if (input.assignee !== undefined) set.assignee = input.assignee
  if (input.lane !== undefined) {
    const lane = input.lane.toLowerCase()
    if (!LANE.test(lane)) throw new ThreadError('lane', `"${input.lane}" is not a lane id`)
    set.lane = lane
  } else if (input.assignee && input.assigneeLane) {
    const lane = input.assigneeLane.trim().toLowerCase()
    if (LANE.test(lane) && lane !== head.lane && laneIsDefault(entriesOf(ctx.db, head.id))) set.lane = lane
  }
  if (input.parent !== undefined) {
    if (input.parent) parentFor(ctx, input.parent, head)
    set.parent = input.parent?.id ?? null
  }
  if (!Object.keys(set).length) throw new ThreadError('empty', `nothing to set: ${settable(ctx)}`)
  const same = set.ref && isOpen(head.status) ? sameRefOpen(ctx, set.ref, set.lane ?? head.lane, head.id) : undefined
  const w = postEntry(ctx, head, { set })
  return same ? { ...w, sameRef: same } : w
}

/**
 * The gate is not lifted by the session it gates (#492): verify off is refused for the thread's
 * assignee and for the session whose done is held, and on a thread its lane put verification on,
 * for every session: there only the owner turns it off.
 */
function mayLiftGate(actor: Party, head: ThreadHead): void {
  if (actor.kind !== 'session') return
  if (head.verify?.lane)
    throw new ThreadError('owner_only', `${head.key} is verified because of its lane: only the owner turns that off`)
  if (isSession(head.assignee, actor.key) || isSession(head.proposed?.by, actor.key))
    throw new ThreadError('owner_only', `${head.key}: the session it verifies does not turn verification off`)
  // Only the session that made the thread, besides the owner: one that just gave the thread up is no less gated.
  if (!isSession(head.createdBy, actor.key))
    throw new ThreadError(
      'owner_only',
      `${head.key}: only the session that made it, or the owner, turns verification off`,
    )
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

/** The `by` of a line carried over from a day's earlier conversation (#403): no later line replaces it. */
export const CARRIED_BY = 'threads-carried'

/**
 * A MokuPilot day's new conversation `to` takes over the watches of the day's earlier ones,
 * `from`, oldest first (#403), so it hears what they heard without watching again. Each earlier
 * one is first told what it has not heard yet, as it would be (never its own entries), and that
 * line goes to `to` as it is, one no later change replaces; then its watches move with what they
 * hear and when they began (a target `to` watches already keeps `to`'s, the newest earlier
 * conversation's before an older one's), its `mine` also as watches on the open threads it created
 * or was given (their creator and assignee are the old session), and its cursor goes. `to`'s
 * cursor starts after everything that line covers and never moves back; the gap after the line
 * holds. The owner watch stays: MokuPilot moves that one itself. How many watches moved.
 */
export function carryWatches(
  ctx: ThreadsCtx,
  to: Extract<Party, { kind: 'session' }>,
  from: readonly string[],
): number {
  const schedule = ctx.schedule ?? fileSchedule
  return ctx.db.write(byOf(ctx.actor), tx => {
    let moved = 0
    for (const old of [...from].reverse()) {
      if (old === to.key) continue
      const ws = watchesOf(ctx.db, old).filter(w => w.target !== OWNER)
      if (!ws.length) continue
      tellOne(ctx, schedule, old, tx)
      const oldKey = ctx.resolveKey ? ctx.resolveKey(old) : old
      const toKey = ctx.resolveKey ? ctx.resolveKey(to.key) : to.key
      const pending = pendingOf(schedule, oldKey) ?? (oldKey !== old ? pendingOf(schedule, old) : undefined)
      if (pending) {
        const { id, created, claim, key, name, by, ...line } = pending
        // Added before it is taken back: a refused add leaves the old line where it was.
        schedule.add({ ...line, key: toKey, ...((to.name || name) && { name: to.name || name }), by: CARRIED_BY })
        schedule.takeBack(id)
      }
      const cursor = cursorOf(ctx.db, old)
      const open = ws.some(w => w.target === MINE)
        ? mineIds(ctx.db, old).filter(id => {
            const h = getThread(ctx.db, id)
            return !!h && isOpen(h.status)
          })
        : []
      for (const w of ws)
        for (const target of w.target === MINE ? [MINE, ...open] : [w.target])
          addWatchKept(tx, { ...w, session: to.key, name: to.name || w.name, target }, ctx.now)
      moved += ws.length
      dropWatchesOf(tx, old, [OWNER])
      setCursor(tx, old, null)
      moveCursor(tx, to.key, { seq: threadsRev(ctx.db), at: cursor?.at ?? 0, asked: cursor?.asked ?? 0 })
    }
    return moved
  })
}

// ------------------------------------------------------------------ what a session hears

/** A thread before its first entry: what folding its feed starts from. */
const blankOf = ({ verify: _verify, ...h }: ThreadHead): ThreadHead => ({
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
  // A done held for a verifier (#492) is no news yet: nobody hears "done" before the verdict.
  if (e.set?.hold) return LEVEL.all
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

export interface OwnerPostRef {
  thread: string
  key: string
  target: { key: string; name: string }
  seq?: number
}

/**
 * Who an owner post in `head` must reach (#693): its assignee when that is a session, else
 * (when there is no assignee) its creator when that is a session; null otherwise.
 */
export function ownerPostTarget(
  head: Pick<ThreadHead, 'assignee' | 'createdBy'>,
): Extract<Party, { kind: 'session' }> | null {
  if (head.assignee) return head.assignee.kind === 'session' ? head.assignee : null
  return head.createdBy.kind === 'session' ? head.createdBy : null
}

/** Whether an entry is an owner post that carries content (text, files, or links) to deliver (#693). */
export function isOwnerPostContent(e: Pick<ThreadEntry, 'author' | 'type' | 'text' | 'files' | 'links'>): boolean {
  if (e.author.kind !== 'owner' || e.type !== 'note') return false
  return !!(e.text || e.files?.length || e.links?.length)
}

interface Heard {
  items: DigestItem[]
  /** The watches that matched: they decide idle and wake. */
  matched: Watch[]
  /** Every entry seen, by thread. */
  byThread: Map<string, { head: ThreadHead; entries: ThreadEntry[] }>
  /** Owner posts targeting `session` in this window (#693). */
  ownerPosts: OwnerPostRef[]
}

/**
 * What `session` hears of the entries written after `since` and up to `until`: every thread one of
 * its watches covers, with the entries that watch is wide enough for and that came after the watch
 * began, never the session's own; plus any direct owner post on a thread it holds (assignee, or
 * creator when unassigned) (#693). `all`: every such entry, whatever the watch's width (`board thread changes`).
 */
export function heardSince(
  db: BoardDb,
  session: string,
  since: number,
  until: number,
  all = false,
  directSeqs?: ReadonlySet<number>,
): Heard {
  const watches = watchesOf(db, session)
  const matched = new Set<Watch>()
  const byThread = new Map<string, { head: ThreadHead; entries: ThreadEntry[] }>()
  const items: DigestItem[] = []
  const ownerPosts: OwnerPostRef[] = []
  const fresh = entriesAfter(db, since, until).filter(e => !isSession(e.author, session))
  if (!fresh.length) return { items, matched: [], byThread, ownerPosts }
  const isDirect = (e: ThreadEntry): boolean => isOwnerPostContent(e) && (all || !!directSeqs?.has(e.seq))
  const threads = new Map<string, ThreadEntry[]>()
  for (const e of fresh) threads.set(e.thread, [...(threads.get(e.thread) ?? []), e])
  for (const [id, list] of threads) {
    const head = getThread(db, id)
    if (!head) continue
    const ws = watches.filter(w => covers(w, head, session))
    const ownerTarget = ownerPostTarget(head)
    const hasOwnerPost = ownerTarget?.key === session && list.some(e => isDirect(e))
    if (!ws.length && !hasOwnerPost) continue
    // Each entry's head before and after it, folded from the start: whether its status changed.
    const states = new Map<string, { before: ThreadHead | null; after: ThreadHead }>()
    let h: ThreadHead | null = null
    // Who wrote the words the line would say (#394): on a shared thread a teammate's summary or what it
    // waits on stays in the head after a local entry that did not change it.
    let saidBy: Party | null = null
    for (const e of entriesOf(db, id)) {
      const after: ThreadHead = applyEntry(h ?? blankOf(head), e)
      states.set(e.id, { before: h, after })
      if (e.set?.summary !== undefined || e.set?.waitingOn !== undefined) saidBy = e.author
      h = after
    }
    const heard: ThreadEntry[] = []
    let status = false
    let ask: string | undefined
    let failed: string | undefined
    let kept = false
    let verified = false
    let closed: number | undefined
    let ownerNote: string | undefined
    let local = saidBy === null || isLocal(saidBy)
    for (const e of list) {
      const st = states.get(e.id)
      // A failed verification (#492) is the held done's writer's to hear, as an answer is.
      const fails = e.set?.verdict === 'fail' && isSession(st?.before?.proposed?.by, session)
      // So is the owner keeping a held done open: it is back with its writer.
      const reopened =
        e.author.kind === 'owner' &&
        !!st?.before?.proposed?.verify &&
        !st.after.proposed &&
        st.after.status === 'doing' &&
        isSession(st.before.proposed.by, session)
      const level = fails || reopened ? LEVEL.answers : st ? entryLevel(e, st.before, st.after) : LEVEL.all
      const by = ws.filter(w => e.seq > w.since && (all || LEVEL[w.what] >= level))
      const forOwner = ownerTarget?.key === session && isDirect(e)
      if (!by.length && !forOwner) continue
      for (const w of by) matched.add(w)
      heard.push(e)
      if (level <= LEVEL.status && !fails && !reopened) status = true
      if (e.type === 'ask') ask = e.text
      if (fails) failed = e.text
      if (reopened) kept = true
      if (e.set?.verdict === 'pass') verified = true
      if (e.closed) closed = e.closed
      if (forOwner) {
        if (!ownerPosts.some(o => o.thread === head.id && o.seq === e.seq))
          ownerPosts.push({
            thread: head.id,
            key: head.key,
            target: { key: ownerTarget.key, name: ownerTarget.name },
            seq: e.seq,
          })
        if (e.text) ownerNote = e.text
        else if (e.files?.length)
          ownerNote ??= e.files.length === 1 ? 'attached a file' : `attached ${e.files.length} files`
        else if (e.links?.length)
          ownerNote ??= e.links.length === 1 ? 'shared a link' : `shared ${e.links.length} links`
      }
      if (!isLocal(e.author)) local = false
    }
    if (!heard.length) continue
    byThread.set(id, { head, entries: heard })
    items.push({
      head,
      status,
      ...(ask !== undefined && { ask: oneLine(ask, SUMMARY_MAX) }),
      ...(failed !== undefined && { failed: oneLine(failed, SUMMARY_MAX) }),
      ...(kept && { kept }),
      ...(verified && { verified }),
      ...(closed && { closed }),
      ...(ownerNote !== undefined && { ownerNote: cleanText(ownerNote, MAX_TEXT) }),
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
  return { items: told, matched: [...matched], byThread, ownerPosts }
}

/** Who was told of a write, and how many watchers could not be (their sessions read `changes`). */
export interface Told {
  told: string[]
  untold: number
}

/**
 * Tells every session that watches one of `heads` (and `direct`, if an owner post targets it)
 * what it has not heard yet, as one pending schedule entry each (see the top of the file). Each
 * session's turn runs in a transaction of the board's database, which holds its write lock: two
 * commands writing at once tell a session one after the other, so the second finds and replaces the
 * first one's entry and no session is left with two. A session the schedule cannot take (one at its
 * limit of entries) is counted untold and reads its news with `board thread changes`.
 */
export function tellWatchers(
  ctx: ThreadsCtx,
  heads: readonly ThreadHead[],
  direct?: { session: string; name: string; seq: number },
): Told {
  const schedule = ctx.schedule ?? fileSchedule
  const out: Told = { told: [], untold: 0 }
  const sessions = new Set<string>()
  try {
    for (const h of heads) for (const w of watchesFor(ctx.db, h)) if (covers(w, h, w.session)) sessions.add(w.session)
    if (direct) sessions.add(direct.session)
    if (ctx.actor.kind === 'session') sessions.delete(ctx.actor.key)
  } catch {
    out.untold = 1
    return out
  }
  for (const session of sessions) {
    try {
      const d = direct?.session === session ? direct : undefined
      if (ctx.db.write(byOf(ctx.actor), tx => tellOne(ctx, schedule, session, tx, d))) out.told.push(session)
    } catch {
      out.untold++
    }
  }
  return out
}

/** One session's event, under the database's write lock (`tx`); whether it was told anything new. */
function tellOne(
  ctx: ThreadsCtx,
  schedule: EventSchedule,
  session: string,
  tx: Tx,
  direct?: { session: string; name: string; seq: number },
): boolean {
  const rev = threadsRev(ctx.db)
  const hadCursor = cursorOf(ctx.db, session)
  const cursor = hadCursor ?? {
    seq: direct ? Math.max(0, direct.seq - 1) : rev,
    at: 0,
    asked: direct ? Math.max(0, direct.seq - 1) : rev,
  }
  const targetKey = ctx.resolveKey ? ctx.resolveKey(session) : session
  const pending = pendingOf(schedule, targetKey) ?? (targetKey !== session ? pendingOf(schedule, session) : undefined)
  const directSeqs = new Set<number>()
  if (direct) directSeqs.add(direct.seq)
  for (const o of Array.isArray(pending?.ownerPosts) ? pending.ownerPosts : []) {
    if (typeof o?.seq === 'number') directSeqs.add(o.seq)
  }
  const pendingSince = typeof pending?.threadsSince === 'number' ? pending.threadsSince : undefined
  let since = pendingSince ?? cursor.seq
  let heard = heardSince(ctx.db, session, since, rev, false, directSeqs)
  if (!heard.items.length) return false
  let text = digestLine(heard.items)
  let hasOwnerPost = heard.ownerPosts.length > 0
  // Nothing new for this session in what was written: its pending event stands as it is (unless an
  // owner post upgrades a delayed or noWake event to wake and deliver now).
  if (pending && pending.text === text && (!hasOwnerPost || (pending.noWake !== true && pending.next <= ctx.now)))
    return false
  // Replaced, not changed in place; one claimed meanwhile goes as it is and this one follows it.
  const replaced = pending ? schedule.takeBack(pending.id) : false
  if (pending && !replaced) {
    since = cursor.seq
    const freshSeqs = new Set<number>(direct ? [direct.seq] : [])
    heard = heardSince(ctx.db, session, since, rev, false, freshSeqs)
    if (!heard.items.length) return false
    text = digestLine(heard.items)
    hasOwnerPost = heard.ownerPosts.length > 0
  }
  // An owner post wakes and goes at once; otherwise a watch that asked to wait for a free session,
  // or to wake it, has its way.
  const wake = hasOwnerPost || heard.matched.some(w => w.wake)
  const idle = hasOwnerPost ? false : heard.matched.some(w => w.idle)
  const next = hasOwnerPost
    ? ctx.now
    : replaced && pending
      ? pending.next
      : Math.max(ctx.now, cursor.at + ctx.cfg.gapSec * 1000)
  const name =
    heard.matched.find(w => w.name)?.name || heard.ownerPosts.find(o => o.target.name)?.target.name || direct?.name
  schedule.add({
    key: targetKey,
    ...(name && { name }),
    text,
    at: next,
    next,
    by: 'threads',
    from: { ...EVENT_FROM },
    ...(wake ? {} : { noWake: true }),
    ...(idle && { idle: true }),
    ...(hasOwnerPost && { ownerPosts: heard.ownerPosts }),
    threadsSince: since,
    threadsSeq: rev,
  })
  moveCursor(tx, session, { seq: rev, at: next, ...(!hadCursor && { asked: cursor.asked }) })
  return true
}

function deliveryFailureText(target: { key: string; name: string }, why: string): string {
  const at = parseNodeKey(target.key)
  const who = target.name || (at ? at.key : target.key).slice(0, 8)
  const place = at ? ` (on ${at.device})` : ''
  if (why === 'node-offline') {
    return at
      ? `Delivery to ${who} (on ${at.device}) held until ${at.device} is back`
      : `Not delivered to ${who}: node offline`
  }
  const reason =
    why === 'gone'
      ? 'session is gone'
      : why === 'node-revoked'
        ? 'node revoked'
        : why === 'node-forgotten'
          ? 'node forgotten'
          : why === 'node-api'
            ? 'node link incompatible'
            : why || 'could not be reached'
  return `Not delivered to ${who}${place}: ${reason}`
}

/**
 * Records a private system notice on each thread whose owner post is held offline or failed (#693),
 * so it never passes silently. Never calls tellWatchers.
 */
export function recordOwnerPostFailure(
  entry: Pick<ScheduleEntry, 'ownerPosts'>,
  why: string,
  now: number,
  log?: (line: string) => void,
): boolean {
  const raw = Array.isArray(entry.ownerPosts) ? entry.ownerPosts : []
  const seen = new Set<string>()
  const refs = raw.filter((r): r is OwnerPostRef => {
    if (
      typeof r !== 'object' ||
      r === null ||
      typeof r.thread !== 'string' ||
      !r.thread ||
      typeof r.key !== 'string' ||
      typeof r.target !== 'object' ||
      r.target === null ||
      typeof r.target.key !== 'string' ||
      typeof r.target.name !== 'string' ||
      seen.has(r.thread)
    )
      return false
    seen.add(r.thread)
    return true
  })
  if (!refs.length) return false
  try {
    return withThreadsDb(false, db => {
      if (!db) return false
      let wrote = false
      for (const ref of refs) {
        if (!getThread(db, ref.thread)) continue
        db.write(byOf(OWNER_PARTY), tx => {
          appendEntry(tx, ref.thread, {
            at: now,
            author: OWNER_PARTY,
            type: 'system',
            text: deliveryFailureText(ref.target, why),
            private: true,
          })
        })
        wrote = true
      }
      return wrote
    })
  } catch (err) {
    log?.(`threads: could not record delivery failure: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
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
 * connection is kept), zeros while there is no database yet (none is made for it). Settings'
 * Threads row (#410) reads the mode from it: `agents: false` and `share: false` only where config.json
 * says so, so `"threads": true` goes out as it did; its case files and verified done switches (#596)
 * read `cases: true` and `verify: true`, there only while each is on.
 */
export function threadsPayload(cfg: Pick<Config, 'threads'>): ThreadsPayload | null {
  const c = threadsConfig(cfg.threads)
  if (!c) {
    if (kept) dropKept()
    return null
  }
  const mode = {
    ...(!c.agents && { agents: false as const }),
    ...(!c.share && { share: false as const }),
    ...(c.cases && { cases: true as const }),
    ...(c.verify && { verify: true as const }),
  }
  return { ...threadsRead(), ...mode }
}

/** The revision and the count, through the kept connection. */
function threadsRead(): ThreadsPayload {
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
 * What answerAsk refuses, without writing: no words, too many, nothing asked, a close the agent
 * proposed. Decisions (#487) check it before the answer is typed in, and write it after.
 */
export function answerCheck(
  db: BoardDb,
  head: ThreadHead,
  words: string,
): { text: string; entries: ThreadEntry[]; ask: ThreadEntry } {
  const text = cleanText(words, TEXT_MAX + 1)
  if (!text) throw new ThreadError('empty', 'an answer needs words')
  if (text.length > TEXT_MAX) throw new ThreadError('text_long', `the answer has more than ${TEXT_MAX} characters`)
  const entries = entriesOf(db, head.id)
  const ask = openAsk(head, entries)
  if (!ask) throw new ThreadError('no_ask', `${head.key} asks the owner nothing`)
  // A close the agent proposed meanwhile is the owner's to confirm or keep: an answer leaves it.
  if (head.proposed) throw new ThreadError('proposed', `${head.key} waits for Confirm or Keep open first`)
  return { text, entries, ask }
}

/**
 * The owner answers the thread's open question (6.6): an `answer` entry in reply to it, which puts
 * the status back to what it was before the question. Telling the session is the caller's (the
 * board's send(), and its card's ask cleared). Refused when nothing is asked.
 */
export function answerAsk(ctx: ThreadsCtx, head: ThreadHead, words: string): Answered {
  const { text, entries, ask } = answerCheck(ctx.db, head, words)
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
  return postEntry(ctx, head, { status: 'done', ...(summary && { summary }), noDirect: true })
}

/**
 * The owner keeps a proposed close open: the thread stays with the owner, the proposal goes. A done
 * held for a verifier (#492) goes back to its worker instead: `doing`, its verifier's word no longer counts.
 */
export function keepOpen(ctx: ThreadsCtx, head: ThreadHead): Written {
  if (!head.proposed) throw new ThreadError('no_proposal', `nobody proposed ${head.key} done`)
  if (!head.proposed.verify) return postEntry(ctx, head, { status: 'owner', noDirect: true })
  // Its worker hears it in one line (heardSince), and the verifier ends as a verdict ends it: its
  // word no longer counts, and it is archived once it is free.
  const run = head.verify?.run
  const w = postEntry(ctx, head, { status: 'doing', noDirect: true })
  if (run) endVerifierRun(run.key, ctx.now)
  return w
}

/**
 * A verifier's run is over (#492: a verdict, the time limit, Keep open): its time-limit entry is due
 * now and in its archive phase, where the sweep leaves its retries alone (services/work-verify.ts).
 */
export function endVerifierRun(key: string, at: number): void {
  for (const e of listEntries())
    if (e.kind === 'verify' && e.key === key) updateEntry(e.id, x => ({ ...x, next: at, at, archive: true }))
}
