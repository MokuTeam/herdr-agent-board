// Threads over HTTP (#392, docs/design/threads 5.3): what the page, MokuPilot and the MCP adapter
// read and write. The feed never rides in the board's payload; the payload carries the threads
// revision, and a client that shows threads reads these routes again when it moves.
//
//   GET  /api/threads?lane=&status=&mine=<session>&since=<rev>&closed=1   heads only
//   GET  /api/threads/<key or id>?last=&since=&full=1                      the head and entries
//   POST /api/threads {op: 'new', lane, title, parent?, to?, doing?}
//   POST /api/threads/<key or id> {op: 'post' | 'set' | 'ask' | 'answer' | 'confirm' | 'keep', ...}
//   GET  /api/threads/events                                               SSE: `rev` on each change
//
// A write over HTTP is the owner's: the party comes from the path, never from the body (3.2). A
// POST carries X-Board: 1. With threads off every route answers 409 and reads nothing. Away from
// the computer only the owner's own logins reach them (core/remote.ts ownerThreads).
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { BoardDb } from '../../adapters/db.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { uploadsDir } from '../../adapters/paths.ts'
import {
  childrenOf,
  entriesOf,
  findThread,
  listThreads,
  mineIds,
  ThreadError,
  threadsRev,
  watchesOf,
} from '../../adapters/work-thread-store.ts'
import { t } from '../../core/lang.ts'
import type { Config } from '../../core/types.ts'
import {
  isOpen,
  isThreadStatus,
  MINE,
  OWNER,
  type Party,
  THREAD_KEY,
  type ThreadEntry,
  type ThreadEntryView,
  type ThreadHead,
  type ThreadRow,
  type ThreadStatus,
  type ThreadView,
  threadsConfig,
} from '../../core/work-threads.ts'
import {
  answerAsk,
  askOwner,
  confirmClose,
  type EventSchedule,
  filePath,
  keepOpen,
  newThread,
  openAsk,
  postEntry,
  setFields,
  type ThreadsCtx,
  withThreadsDb,
} from '../../services/work-threads.ts'
import { json, type Route } from '../http.ts'
import { type Broadcaster, createBroadcaster, namedEvent } from '../sse.ts'

/** How long a page that connects after `POST /api/reveal {thread}` is still sent there (a window being raised). */
export const THREAD_OPEN_MS = 15_000
/** Done and dropped threads a list gives at most, the newest change first. */
export const CLOSED_MAX = 50
/** Entries a thread gives by default (`full=1`: all of them). */
export const ENTRIES_DEFAULT = 200

/** A thread the board was asked to show (`board thread open`, a link clicked outside). */
export interface ThreadOpenState {
  asked(key: string): void
  /** What a page that connects now is told besides the board: the thread asked for within THREAD_OPEN_MS, once. */
  greet(): string
}

export function threadOpenState(now: () => number = Date.now): ThreadOpenState {
  let asked: { key: string; at: number } | null = null
  return {
    asked(key) {
      asked = { key, at: now() }
    },
    greet() {
      const a = asked
      asked = null
      return a && now() - a.at < THREAD_OPEN_MS ? namedEvent('thread-open', { key: a.key }) : ''
    },
  }
}

/** What the routes take of the board. */
export interface ThreadsApp {
  cfg: Pick<Config, 'threads'>
  /** The board's payload goes out again (a write moved the revision and the count). */
  changed(): void
  /**
   * Types the owner's answer into the session that asked (6.6), through the same send() the
   * sheet's composer uses; why not, when it could not.
   */
  tell(session: string, text: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Clears the question on the session's card, as its next prompt would, while it is still `question`. */
  clearAsk(session: string, question: string): void | Promise<void>
  /** The tests' schedule, state folder and clock. */
  schedule?: EventSchedule
  state?: string
  now?: () => number
}

/** The revision's own stream: made on its first client, so a board with threads off keeps no timer for it. */
export interface RevStream {
  /** The revision as the board's payload read it: a `rev` event when it moved. */
  moved(rev: number): void
  /** A new client, told the revision as it is now; the others are told first if it moved. */
  response(req: Request, rev: number): Response
  close(): void
}

export function revStream(): RevStream {
  let last = -1
  let stream: (Broadcaster & { close(): void }) | null = null
  return {
    moved(rev) {
      if (rev === last) return
      last = rev
      stream?.event('rev', { rev })
    },
    response(req, rev) {
      stream ??= createBroadcaster(() => JSON.stringify({ rev: last }), {
        greet: () => namedEvent('rev', { rev: last }),
      })
      this.moved(rev)
      return stream.response(req)
    },
    close() {
      stream?.close()
      stream = null
    },
  }
}

const off = () => json(409, { ok: false, error: t('thread.err.off') })

/** A refusal as the routes answer it: 404 for a thread that is not there, 400 for the rest. */
function refusal(err: unknown): Response {
  if (err instanceof ThreadError)
    return json(err.code === 'not_found' ? 404 : err.code === 'agents_off' ? 403 : 400, {
      ok: false,
      error: err.message,
      code: err.code,
    })
  return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) })
}

/** Every thread's key by id, and its sub-threads counted: what a list row names. */
function rowsOf(db: BoardDb, heads: readonly ThreadHead[]): ThreadRow[] {
  const keys = new Map(
    (db.db.query('SELECT id, key FROM threads').all() as { id: string; key: string }[]).map(r => [r.id, r.key]),
  )
  const kids = new Map<string, { done: number; all: number }>()
  for (const r of db.db.query('SELECT parent, status FROM threads WHERE parent IS NOT NULL').all() as {
    parent: string
    status: ThreadStatus
  }[]) {
    const c = kids.get(r.parent) ?? { done: 0, all: 0 }
    c.all++
    if (!isOpen(r.status)) c.done++
    kids.set(r.parent, c)
  }
  return heads.map(h => ({
    ...h,
    parentKey: h.parent ? (keys.get(h.parent) ?? null) : null,
    children: kids.get(h.id) ?? { done: 0, all: 0 },
  }))
}

const intParam = (v: string | null): number | undefined => (v !== null && /^\d{1,9}$/.test(v) ? Number(v) : undefined)

/** Only the threads with an entry written after the revision `rev`. */
const changedSince = (db: BoardDb, rev: number): string[] =>
  (db.db.query('SELECT DISTINCT thread FROM thread_entries WHERE seq > ?').all(rev) as { thread: string }[]).map(
    r => r.thread,
  )

/** An entry as the page reads it: each file with where it is on this computer. */
function entryView(e: ThreadEntry, state?: string): ThreadEntryView {
  const { files, ...rest } = e
  return files?.length ? { ...rest, files: files.map(f => ({ ...f, path: filePath(f.ref, state) })) } : rest
}

/** A body's string list (links, files): strings only. */
const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, max + 1) : []

export function threadsRoutes(app: ThreadsApp, revs: RevStream): Route[] {
  const now = () => app.now?.() ?? Date.now()
  const on = () => threadsConfig(app.cfg.threads)
  const withDb = withThreadsDb
  const ctxOf = (db: BoardDb, actor: Party = OWNER): ThreadsCtx => {
    const cfg = on()
    if (!cfg) throw new ThreadError('off', t('thread.err.off'))
    return {
      db,
      cfg,
      actor,
      now: now(),
      ...(app.schedule && { schedule: app.schedule }),
      ...(app.state && { state: app.state }),
    }
  }

  function list(url: URL): Response {
    return withDb(false, db => {
      if (!db) return json(200, { ok: true, rev: 0, threads: [] })
      const p = url.searchParams
      const status = p.get('status')
      if (status !== null && !isThreadStatus(status))
        return json(400, { ok: false, error: t('thread.err.bad'), code: 'status' })
      const lane = p.get('lane') || undefined
      const mine = p.get('mine')
      const since = intParam(p.get('since'))
      const closed = p.get('closed') === '1' || (status !== null && !isOpen(status))
      let ids: string[] | undefined
      if (mine) {
        const watched = watchesOf(db, mine)
          .map(w => w.target)
          .filter(target => target !== MINE && !target.startsWith('lane:'))
        ids = [...new Set([...mineIds(db, mine), ...watched])]
      }
      if (since !== undefined) {
        const moved = new Set(changedSince(db, since))
        ids = (ids ?? [...moved]).filter(id => moved.has(id))
      }
      const heads = listThreads(db, {
        ...(lane && { lane }),
        ...(status && { status }),
        closed,
        ...(ids && { ids }),
      })
      // Open ones all; closed ones the newest CLOSED_MAX (a revision asked for gives every one that moved).
      const open = heads.filter(h => isOpen(h.status))
      const shut = heads.filter(h => !isOpen(h.status))
      const shown = [...open, ...(since === undefined ? shut.slice(0, CLOSED_MAX) : shut)]
      return json(200, {
        ok: true,
        rev: threadsRev(db),
        threads: rowsOf(db, shown),
        ...(since === undefined && shut.length > CLOSED_MAX && { moreClosed: shut.length - CLOSED_MAX }),
      })
    })
  }

  function one(word: string, url: URL): Response {
    return withDb(false, db => {
      if (!db) return json(404, { ok: false, error: t('thread.err.gone'), code: 'not_found' })
      const head = findThread(db, word, null)
      const p = url.searchParams
      const since = intParam(p.get('since'))
      const last = intParam(p.get('last'))
      const full = p.get('full') === '1'
      const all = entriesOf(db, head.id)
      const entries =
        since !== undefined
          ? all.filter(e => e.n > since)
          : full
            ? all
            : all.slice(-Math.min(last ?? ENTRIES_DEFAULT, ENTRIES_DEFAULT))
      const [row] = rowsOf(db, [head]) as [ThreadRow]
      const view: ThreadView = {
        head: row,
        children: rowsOf(db, childrenOf(db, head.id)),
        entries: entries.map(e => entryView(e, app.state)),
        earlier: all.length - entries.length,
        ask: openAsk(head, all)?.id ?? null,
      }
      return json(200, { ok: true, rev: threadsRev(db), ...view })
    })
  }

  /** A thread a body names as a parent, or none. */
  const parentOf = (db: BoardDb, v: unknown): ThreadHead | null | undefined =>
    v === null || v === 'none' ? null : typeof v === 'string' && v ? findThread(db, v, null) : undefined

  /** The assignee a body names: a session on this board by its card key, or nobody; refused otherwise. */
  const assigneeOf = (v: unknown): Party | null => {
    if (v === null || v === 'none') return null
    if (!isRecord(v) || typeof v.key !== 'string' || !v.key) throw new ThreadError('assignee', t('thread.err.bad'))
    return { kind: 'session', key: v.key, name: typeof v.name === 'string' ? v.name.slice(0, 80) : v.key.slice(0, 8) }
  }

  async function write(body: Record<string, unknown>, word: string | null): Promise<Response> {
    // Only what the page uploaded: a path inside the board's uploads, resolved, that is there.
    const root = resolve(uploadsDir()) + sep
    const files = strings(body.files, 5).map(p => resolve(p))
    const outside = files.find(p => !p.startsWith(root) || !existsSync(p))
    if (outside !== undefined) return json(400, { ok: false, error: t('thread.err.file'), code: 'file' })
    const done = withDb(true, db => {
      if (!db) throw new ThreadError('no_db', t('thread.err.noDb'))
      const ctx = ctxOf(db)
      if (word === null) {
        if (body.op !== 'new') throw new ThreadError('bad', t('thread.err.bad'))
        return {
          written: newThread(ctx, {
            lane: String(body.lane ?? ''),
            title: String(body.title ?? ''),
            parent: parentOf(db, body.parent) ?? null,
            to: body.to === undefined ? null : assigneeOf(body.to),
            doing: body.doing === true,
          }),
        }
      }
      const head = findThread(db, word, null)
      switch (body.op) {
        case 'post': {
          const status = body.status
          if (status !== undefined && !isThreadStatus(status)) throw new ThreadError('status', t('thread.err.bad'))
          return {
            written: postEntry(ctx, head, {
              ...(typeof body.text === 'string' && { text: body.text }),
              ...(status !== undefined && { status }),
              ...(typeof body.summary === 'string' && { summary: body.summary }),
              ...(typeof body.waitingOn === 'string' && { waitingOn: body.waitingOn }),
              ...(typeof body.replyTo === 'string' && { replyTo: body.replyTo }),
              ...(body.private === true && { private: true }),
              links: strings(body.links, 5),
              files,
            }),
          }
        }
        case 'set':
          return {
            written: setFields(ctx, head, {
              ...(typeof body.title === 'string' && { title: body.title }),
              ...(body.assignee !== undefined && { assignee: assigneeOf(body.assignee) }),
              ...(typeof body.lane === 'string' && { lane: body.lane }),
              ...(body.parent !== undefined && { parent: parentOf(db, body.parent) ?? null }),
            }),
          }
        case 'ask':
          return { written: askOwner(ctx, head, String(body.text ?? '')) }
        case 'answer': {
          const a = answerAsk(ctx, head, String(body.text ?? ''))
          return { written: a, answered: a }
        }
        case 'confirm':
          return { written: confirmClose(ctx, head) }
        case 'keep':
          return { written: keepOpen(ctx, head) }
        case 'watch':
        case 'share':
        case 'unshare':
          throw new ThreadError('later', t('thread.err.later'))
        default:
          throw new ThreadError('bad', t('thread.err.bad'))
      }
    })
    app.changed()
    const { written } = done
    const out: Record<string, unknown> = { ok: true, key: written.head.key, head: written.head, entry: written.entry }
    const answered = 'answered' in done ? done.answered : undefined
    if (answered?.asker) {
      // The owner's own words, typed in full into the session that asked (6.6); its card's question goes.
      const asker = answered.asker.key
      const told = await app.tell(asker, `[board thread ${written.head.key}] ${answered.text}`).catch(err => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }))
      // Its card's question goes once it has the answer; one it did not get stays on show.
      if (told.ok) await app.clearAsk(asker, answered.question)
      out.told = told.ok
      if (!told.ok) out.why = told.error
    }
    return json(200, out)
  }

  return [
    {
      method: 'GET',
      path: '/api/threads',
      handle(_req, ctx) {
        if (!on()) return off()
        try {
          return list(ctx.url)
        } catch (err) {
          return refusal(err)
        }
      },
    },
    {
      method: 'GET',
      path: '/api/threads/events',
      handle(req) {
        if (!on()) return off()
        const rev = withDb(false, db => (db ? threadsRev(db) : 0))
        return revs.response(req, rev)
      },
    },
    {
      method: 'GET',
      path: /^\/api\/threads\/([^/]+)$/,
      handle(_req, ctx) {
        if (!on()) return off()
        try {
          return one(ctx.params[0] ?? '', ctx.url)
        } catch (err) {
          return refusal(err)
        }
      },
    },
    {
      method: 'POST',
      path: '/api/threads',
      guard: ['board-header'],
      async handle(_req, ctx) {
        if (!on()) return off()
        const raw = await ctx.rawBody()
        try {
          return await write(isRecord(raw) ? raw : {}, null)
        } catch (err) {
          return refusal(err)
        }
      },
    },
    {
      method: 'POST',
      path: /^\/api\/threads\/([^/]+)$/,
      guard: ['board-header'],
      async handle(_req, ctx) {
        if (!on()) return off()
        const raw = await ctx.rawBody()
        try {
          return await write(isRecord(raw) ? raw : {}, ctx.params[0] ?? '')
        } catch (err) {
          return refusal(err)
        }
      },
    },
  ]
}

/**
 * `POST /api/reveal {thread}` (8): pages open that thread, those connected now and those that
 * connect within THREAD_OPEN_MS. Refused while threads are off, and for a key no thread has.
 */
export function threadReveal(
  app: Pick<ThreadsApp, 'cfg'>,
  events: Pick<Broadcaster, 'event' | 'size'>,
  state: Pick<ThreadOpenState, 'asked'>,
  word: unknown,
): Response {
  if (!threadsConfig(app.cfg.threads)) return off()
  const key = String(word ?? '')
    .trim()
    .toLowerCase()
  if (!THREAD_KEY.test(key)) return json(400, { ok: false, error: t('thread.err.bad') })
  const known = (db: BoardDb | null): boolean => {
    if (!db) return false
    try {
      return findThread(db, key, null).key === key
    } catch {
      return false
    }
  }
  if (!withThreadsDb(false, known)) return json(404, { ok: false, error: t('thread.err.gone') })
  state.asked(key)
  events.event('thread-open', { key })
  return json(200, { ok: true, thread: key, pages: events.size() })
}
