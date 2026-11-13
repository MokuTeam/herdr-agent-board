// A harness's task board as threads (#393, docs/design/threads 13.1, core/thread-import.ts).
//
// `board thread import <file>` makes one thread per item: its text the title (the whole text the
// first entry when it had to be cut), its note the summary, its status, its owner the assignee (the
// session on the board whose key is the item's owner_id, else the name alone), its step's root the
// parent. The item's times are kept: the thread is created at created_at, and started_at and
// done_at become status entries at those times. The import can be run again: an item imported
// before is not added again. The thread keeps what the import last read of its item (origin's
// `seen`), and a later run applies only what changed in the file since then, in one entry: a status,
// a summary, a title or an assignee set on the board stays until the file changes that field. An
// item that did not change writes nothing.
//
// The mirror: on a pi day the task tool belongs to the pi-task-board package, which writes the file
// itself. While threads are on, the board reads the running pi day's file on each refresh and
// imports it again when it changed, as threads marked mirrored. Only this copy writes them (an
// edit on the board is refused, services/work-threads.ts notMirrored; the owner can still close
// one); an open one whose item left the file is dropped. Once that day is over (no pi day runs, or
// another one does), its threads become the board's own. Off, with agents off, without MokuPilot,
// or with `"mokupilot": false`, nothing of it is read.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type BoardDb, DbError, openDb, type Tx } from '../adapters/db.ts'
import { mokupilotHere, taskBoardsFolder } from '../adapters/mokupilot-call.ts'
import { type PiDay, runningPiDay } from '../adapters/mokupilot-day.ts'
import {
  appendEntry,
  childrenOf,
  createThread,
  putWatch,
  releaseMirrored,
  setOrigin,
  ThreadError,
  threadsFromBoard,
} from '../adapters/work-thread-store.ts'
import { categoryFor } from '../core/categories.ts'
import {
  agentBoardOf,
  originOf,
  parseTaskFile,
  type Seen,
  sameSeen,
  seenOf,
  summaryOfNote,
  type TaskFile,
  type TaskItem,
  taskStatusOf,
  titleOfText,
} from '../core/thread-import.ts'
import type { Config } from '../core/types.ts'
import {
  CHILDREN_MAX,
  type EntrySet,
  isOpen,
  LANE,
  type Party,
  sameParty,
  type ThreadHead,
  type ThreadStatus,
  threadsConfig,
} from '../core/work-threads.ts'
import { type ThreadsCtx, tellWatchers } from './work-threads.ts'

/** A task board larger than this is not read: MokuPilot's own are a few kilobytes. */
export const TASK_FILE_MAX_BYTES = 1024 * 1024

export interface ImportResult {
  /** Threads made, updated, and dropped (an item that left a mirrored file), by key. */
  created: string[]
  updated: string[]
  dropped: string[]
  unchanged: number
  /** Items left out: the file's own (core/thread-import.ts), and threads mirrored from pi that a plain import does not change. */
  skipped: number
  /** Each item's thread, by the item's id. */
  keys: Record<string, string>
  told: string[]
  untold: number
}

export interface ImportOptions {
  /** The lane new threads go into. */
  lane: string
  /** A session on the board by its key, for an item's owner_id; null when none has it. */
  sessionOf: (key: string) => Party | null
}

const byOf = (p: Party): string => JSON.stringify(p)

/** The item's owner as an assignee: the session on the board whose key is its owner_id, else the name alone. */
function assigneeOf(item: TaskItem, sessionOf: ImportOptions['sessionOf']): { party: Party | null; onBoard: boolean } {
  if (!item.owner) return { party: null, onBoard: false }
  const found = item.owner.id ? safely(() => sessionOf(item.owner?.id ?? '')) : null
  if (found) return { party: found, onBoard: true }
  const name = item.owner.name || item.owner.id.slice(0, 8)
  return { party: { kind: 'session', key: item.owner.id || item.owner.name, name }, onBoard: false }
}

function safely<T>(f: () => T): T | null {
  try {
    return f()
  } catch {
    return null
  }
}

/** The status steps a new thread's feed gets from the item's times, oldest first, after `from`. */
function stepsOf(item: TaskItem, from: number, now: number): { at: number; status: ThreadStatus }[] {
  const at = (t: number | null): number => Math.min(now, Math.max(from, t ?? from))
  const steps: { at: number; status: ThreadStatus }[] = []
  if (item.startedAt !== null) steps.push({ at: at(item.startedAt), status: 'doing' })
  if (item.doneAt !== null) steps.push({ at: at(item.doneAt), status: 'done' })
  steps.sort((a, b) => a.at - b.at)
  const last = steps.at(-1)
  if (last && last.status !== item.status)
    steps.push({ at: Math.min(now, Math.max(last.at, item.updatedAt ?? last.at)), status: item.status })
  return steps
}

/** When an update of `head` to the item happened: the item's time for its new status, else its updated_at. */
function updateAt(item: TaskItem, set: EntrySet, head: ThreadHead, now: number): number {
  const t =
    set.status === 'done'
      ? (item.doneAt ?? item.updatedAt)
      : set.status === 'doing'
        ? (item.startedAt ?? item.updatedAt)
        : item.updatedAt
  return Math.min(now, Math.max(head.updatedAt, t ?? now))
}

/**
 * The items of `file` as threads of `o.lane`, written as `ctx.actor` in one transaction; its watchers
 * told after. `ctx.mirror`: the board's copy of a pi task board (new threads marked mirrored, open
 * ones whose item left the file dropped).
 */
export function importTaskFile(ctx: ThreadsCtx, file: TaskFile, o: ImportOptions): ImportResult {
  if (ctx.actor.kind === 'session' && !ctx.cfg.agents)
    throw new ThreadError('agents_off', "threads are the owner's on this board: agents do not write to them")
  const lane = String(o.lane ?? '').toLowerCase()
  if (!LANE.test(lane)) throw new ThreadError('lane', `"${o.lane}" is not a lane id (letters, digits, - and _)`)
  const mirror = !!ctx.mirror
  // The transaction may run again when the database was busy: everything it counts is its own.
  const { result, heads } = ctx.db.write(byOf(ctx.actor), tx => {
    const result: Omit<ImportResult, 'told' | 'untold'> = {
      created: [],
      updated: [],
      dropped: [],
      unchanged: 0,
      skipped: file.skipped,
      keys: {},
    }
    const heads = new Map<string, ThreadHead>()
    const byItem = new Map<string, ThreadHead>()
    for (const h of threadsFromBoard(ctx.db, file.harness, file.session)) {
      const id = agentBoardOf(h.origin)?.agentBoard.id
      if (id !== undefined && !byItem.has(id)) byItem.set(id, h)
    }
    // Roots first, so that a step finds its root's thread.
    const items = [...file.items.filter(i => !i.parent), ...file.items.filter(i => i.parent)]
    for (const item of items) {
      const was = byItem.get(item.id)
      const from = agentBoardOf(was?.origin)
      if (was && from?.mirrored && !mirror) {
        // pi's copy: only the mirror changes it.
        result.skipped++
        result.keys[item.id] = was.key
        continue
      }
      const head = was ? write(tx, ctx, file, item, was, byItem, o) : null
      const made = was ? null : create(tx, ctx, file, item, lane, parentFor(ctx.db, item, byItem), o, mirror)
      const now = made ?? head ?? was
      if (!now) continue
      byItem.set(item.id, now)
      result.keys[item.id] = now.key
      if (made) result.created.push(made.key)
      else if (head) result.updated.push(head.key)
      else result.unchanged++
      if (made || head) heads.set(now.id, now)
    }
    if (mirror) {
      const present = new Set(file.items.map(i => i.id))
      for (const [id, h] of byItem) {
        if (present.has(id) || !isOpen(h.status) || !agentBoardOf(h.origin)?.mirrored) continue
        const r = appendEntry(tx, h.id, {
          at: ctx.now,
          author: ctx.actor,
          type: 'system',
          text: 'gone from the task board',
          set: { status: 'dropped' },
        })
        result.dropped.push(r.head.key)
        heads.set(r.head.id, r.head)
      }
      // Another pi day's copies, left from a day that is over: the board's own now.
      releaseMirrored(tx, file.harness, file.session)
    }
    return { result, heads: [...heads.values()] }
  })
  const told = heads.length ? tellWatchers(ctx, heads) : { told: [], untold: 0 }
  return { ...result, ...told }
}

/** The thread an item's step goes under: its root's, when that one is a root with room; else none. */
function parentFor(db: BoardDb, item: TaskItem, byItem: Map<string, ThreadHead>, self?: ThreadHead): string | null {
  if (!item.parent) return null
  const root = byItem.get(item.parent)
  if (!root || root.parent || root.id === self?.id) return null
  if (self && childrenOf(db, self.id).length) return null
  const kids = childrenOf(db, root.id).filter(k => k.id !== self?.id).length
  return kids < CHILDREN_MAX ? root.id : null
}

function create(
  tx: Tx,
  ctx: ThreadsCtx,
  file: TaskFile,
  item: TaskItem,
  lane: string,
  parent: string | null,
  o: ImportOptions,
  mirror: boolean,
): ThreadHead {
  const at = Math.min(ctx.now, item.createdAt ?? item.updatedAt ?? ctx.now)
  const steps = stepsOf(item, at, ctx.now)
  const { title, whole } = titleOfText(item.text)
  const owner = assigneeOf(item, o.sessionOf)
  const made = createThread(tx, {
    lane,
    title,
    status: steps.length ? 'next' : item.status,
    author: ctx.actor,
    at,
    assignee: owner.party,
    parent,
    summary: summaryOfNote(item.note),
    text: whole,
    origin: originOf(file, item, mirror),
  })
  let head = made.head
  for (const s of steps)
    head = appendEntry(tx, head.id, { at: s.at, author: ctx.actor, type: 'system', set: { status: s.status } }).head
  // As `board thread new`: the session that made it hears how it goes, a session it was given hears
  // the owner's answers. Not on pi's copy: nobody asks there, and nobody is there to hear.
  if (mirror) return head
  if (ctx.actor.kind === 'session')
    putWatch(
      tx,
      { session: ctx.actor.key, name: ctx.actor.name, target: head.id, what: 'status', idle: false, wake: false },
      ctx.now,
      true,
    )
  if (owner.onBoard && owner.party?.kind === 'session')
    putWatch(
      tx,
      { session: owner.party.key, name: owner.party.name, target: head.id, what: 'answers', idle: false, wake: false },
      ctx.now,
      true,
    )
  return head
}

/**
 * An item imported before, brought up to date in one entry with what changed in the file since the
 * last import (all of it against the thread, for one imported before `seen` was kept); null when
 * nothing needed writing. What the import read is kept either way.
 */
function write(
  tx: Tx,
  ctx: ThreadsCtx,
  file: TaskFile,
  item: TaskItem,
  head: ThreadHead,
  byItem: Map<string, ThreadHead>,
  o: ImportOptions,
): ThreadHead | null {
  const from = agentBoardOf(head.origin)
  const seen: Seen | undefined = from?.agentBoard.seen
  const now = seenOf(item)
  if (seen && sameSeen(seen, now)) return null
  const changed = (field: keyof Seen): boolean => !seen || JSON.stringify(seen[field]) !== JSON.stringify(now[field])
  const set: EntrySet = {}
  const { title, whole } = titleOfText(item.text)
  if (changed('text') && title !== head.title) set.title = title
  const summary = summaryOfNote(item.note)
  if (changed('note') && summary !== head.summary) set.summary = summary
  // Needing the owner and waiting are still doing to a task board.
  if (changed('status') && taskStatusOf(head.status) !== item.status) set.status = item.status
  const owner = assigneeOf(item, o.sessionOf)
  if (changed('owner')) {
    const same = owner.party === null ? head.assignee === null : sameParty(owner.party, head.assignee)
    const renamed =
      owner.party?.kind === 'session' && head.assignee?.kind === 'session' && owner.party.name !== head.assignee.name
    if (!same || renamed) set.assignee = owner.party
  }
  if (changed('parent')) {
    const parent = parentFor(ctx.db, item, byItem, head)
    if (parent !== head.parent) set.parent = parent
  }
  setOrigin(tx, head.id, { ...(from ?? {}), ...originOf(file, item, !!from?.mirrored) })
  if (!Object.keys(set).length) return null
  const r = appendEntry(tx, head.id, {
    at: updateAt(item, set, head, ctx.now),
    author: ctx.actor,
    type: 'system',
    text: set.title !== undefined ? whole : '',
    set,
  })
  if (!ctx.mirror && set.assignee && owner.onBoard && owner.party?.kind === 'session')
    putWatch(
      tx,
      { session: owner.party.key, name: owner.party.name, target: head.id, what: 'answers', idle: false, wake: false },
      ctx.now,
      true,
    )
  return r.head
}

// ------------------------------------------------------------------ the mirror of a pi day

export interface MirrorOptions {
  /** config.json, live: read on every tick. */
  cfg: Pick<Config, 'threads' | 'categories'> & { readonly mokupilot?: unknown }
  log?: (line: string) => void
  /** A session on the board by its key, for an item's owner. */
  sessionOf?: (key: string) => Party | null
  /** The tests' MokuPilot, day, folder, database and clock. */
  here?: () => boolean
  day?: () => PiDay | null
  folder?: () => string
  db?: () => BoardDb | null
  now?: () => number
}

/**
 * The board's copy of the running pi day's task board, for its refresh: `tick()` imports the file
 * again when it changed since the last copy. While threads are off it returns before anything else,
 * with agents off or `"mokupilot": false` too, and without MokuPilot (looked up once a minute, as
 * the call agents' gate does) before a look at its folder. When the day it copied is over, that
 * day's threads become the board's own.
 */
export function piDayMirror(o: MirrorOptions) {
  const here = o.here ?? mokupilotHere
  const day = o.day ?? (() => runningPiDay())
  const folder = o.folder ?? (() => taskBoardsFolder())
  const now = o.now ?? Date.now
  let seen = { at: Number.NEGATIVE_INFINITY, on: false }
  /** The file as last copied, or as last refused for good (it is tried again once it changes). */
  let copied = ''
  let failed = ''
  /** The session whose copies may be locked now. */
  let copying = ''
  const withDb = <T>(f: (db: BoardDb) => T): T | null => {
    const db = o.db ? o.db() : openDb({ create: true })
    if (!db) return null
    try {
      return f(db)
    } finally {
      if (!o.db) db.close()
    }
  }
  const say = (stamp: string, what: string, err: unknown): void => {
    if (failed !== stamp) o.log?.(`threads: ${what}: ${err instanceof Error ? err.message : String(err)}`)
    failed = stamp
  }
  return {
    tick(): ImportResult | null {
      const cfg = threadsConfig(o.cfg.threads)
      if (!cfg) return null
      if (!cfg.agents || o.cfg.mokupilot === false) return null
      if (now() - seen.at > 60_000) seen = { at: now(), on: here() }
      if (!seen.on) return null
      const d = day()
      if (!d) {
        // The day it copied is over: its threads are the board's own from now on.
        if (copying) {
          try {
            withDb(db => db.write('{"kind":"owner"}', tx => releaseMirrored(tx, 'pi', '')))
            copying = ''
            copied = ''
          } catch (err) {
            say(`release ${copying}`, `pi's day ${copying} is over`, err)
          }
        }
        return null
      }
      const path = join(folder(), 'pi', `${d.session}.json`)
      let stamp: string
      try {
        const st = statSync(path)
        if (st.size > TASK_FILE_MAX_BYTES) {
          say(`${path}|${st.mtimeMs}|${st.size}`, `pi's task board ${path}`, new Error(`${st.size} bytes, too large`))
          return null
        }
        stamp = `${path}|${st.mtimeMs}|${st.size}`
      } catch {
        return null
      }
      if (stamp === copied) return null
      try {
        const file = parseTaskFile(JSON.parse(readFileSync(path, 'utf8')), { harness: 'pi', session: d.session })
        const r = withDb(db =>
          importTaskFile(
            { db, cfg, actor: { kind: 'session', key: d.session, name: d.name || 'pi' }, now: now(), mirror: true },
            file,
            { lane: categoryFor(o.cfg, d.cwd) ?? 'day', sessionOf: o.sessionOf ?? (() => null) },
          ),
        )
        if (r) {
          copied = stamp
          copying = d.session
        }
        return r
      } catch (err) {
        // The database busy a moment: tried again on the next refresh. A file it cannot read
        // (half-written, not a task board): tried again once it changes. Said once either way.
        if (!(err instanceof DbError && err.problem === 'busy')) copied = stamp
        say(stamp, `pi's task board ${path}`, err)
        return null
      }
    },
  }
}
