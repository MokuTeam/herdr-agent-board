// Threads over HTTP (#392, docs/design/threads 5.3): what the page, MokuPilot and the MCP adapter
// read and write. The feed never rides in the board's payload; the payload carries the threads
// revision, and a client that shows threads reads these routes again when it moves.
//
//   GET  /api/threads?lane=&status=&mine=<session>&since=<rev>&closed=1   heads only
//   GET  /api/threads/<key or id>?last=&since=&full=1                      the head and entries
//   POST /api/threads {op: 'new', lane, title, parent?, to?, doing?}
//   POST /api/threads/<key or id> {op: 'post' | 'set' | 'ask' | 'answer' | 'confirm' | 'keep', ...}
//   POST /api/threads/<key or id> {op: 'send', entry}        a shared entry to the peers (#394)
//   POST /api/threads/<key or id> {op: 'share', to, history?} | 'unshare' | 'decline-share'
//                                 | 'take' | 'decline' (an offer) | 'history'
//   POST /api/threads {op: 'track', topic, lane}               a Team topic as a thread (13.3)
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
import { type OwnerAction, unlocks } from '../../core/team-confirm.ts'
import type { Config } from '../../core/types.ts'
import {
  isOpen,
  isThreadStatus,
  MINE,
  OWNER,
  type Party,
  sharedOf,
  THREAD_KEY,
  type ThreadEntry,
  type ThreadEntryView,
  type ThreadHead,
  type ThreadRow,
  type ThreadStatus,
  type ThreadView,
  threadsConfig,
} from '../../core/work-threads.ts'
import type { TeamConfirm } from '../../services/team-confirm.ts'
import type { SendOut, WorkHub } from '../../services/work-hub.ts'
import { declineOffer, declineShare, myPeer, takeOffer, unshareThread } from '../../services/work-share.ts'
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
  /** Shared threads over the hub (#394): absent, every share op is refused. */
  work?: WorkHub
  /** The owner's passkey (#224): what sends as the owner waits for it while it is on. */
  confirm?: Pick<TeamConfirm, 'required' | 'unlocked' | 'safe' | 'pend' | 'urlOf'>
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
      const head = findThread(db, word, null, true)
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
    v === null || v === 'none' ? null : typeof v === 'string' && v ? findThread(db, v, null, true) : undefined

  /** The assignee a body names: a session on this board by its card key, or nobody; refused otherwise. */
  /**
   * The assignee a body names: a session on this board by its card key, or nobody; on a shared
   * thread also a teammate's board in its scope by its peer id (11.6, an offer). Refused otherwise.
   */
  const assigneeOf = (v: unknown, head?: ThreadHead): Party | null => {
    if (v === null || v === 'none') return null
    if (isRecord(v) && typeof v.peer === 'string') {
      const s = head ? sharedOf(head) : null
      const inScope =
        !!s && (s.kind === 'peer' ? s.peer === v.peer : s.kind === 'team' || !!s.members?.includes(v.peer))
      if (!inScope || !/^[A-Za-z0-9_-]{43}$/.test(v.peer)) throw new ThreadError('assignee', t('thread.err.bad'))
      return { kind: 'peer', peer: v.peer, name: typeof v.name === 'string' ? v.name.slice(0, 40) : v.peer.slice(0, 8) }
    }
    if (!isRecord(v) || typeof v.key !== 'string' || !v.key) throw new ThreadError('assignee', t('thread.err.bad'))
    return { kind: 'session', key: v.key, name: typeof v.name === 'string' ? v.name.slice(0, 80) : v.key.slice(0, 8) }
  }

  /** Why an owner's action that goes out may not go now (428 with its confirmation), or null (#224). */
  function gate(req: Request, action: OwnerAction): Response | null {
    const c = app.confirm
    if (!c?.required()) return null
    if (unlocks(action) && c.unlocked(req.headers.get('x-board-unlock'))) return null
    if (!c.safe()) return json(503, { ok: false, error: 'loopback' })
    const id = c.pend(action)
    return json(428, { ok: false, error: 'confirm', id, confirm: c.urlOf(id) })
  }

  const unlockedBy = (req: Request): boolean =>
    !app.confirm?.required() || app.confirm.unlocked(req.headers.get('x-board-unlock'))

  /** The share ops (#394): what goes to the hub, behind the passkey; what only narrows, at once. */
  async function shareOp(body: Record<string, unknown>, word: string, req: Request): Promise<Response | null> {
    const op = body.op
    if (!['share', 'unshare', 'decline-share', 'take', 'decline', 'history', 'send'].includes(String(op))) return null
    const work = app.work
    if (!work?.on()) throw new ThreadError('share_off', t('thread.err.shareOff'))
    if (op === 'send') {
      const entry = String(body.entry ?? '')
      const r = await work.send(entry, unlockedBy(req))
      if (r.state === 'confirm') return gate(req, { kind: 'thread-send', entry }) ?? json(200, sendReply(r))
      app.changed()
      return json(200, sendReply(r))
    }
    if (op === 'share' || op === 'history') {
      const to = String(body.to ?? '')
      const action: OwnerAction =
        op === 'share'
          ? { kind: 'thread-share', thread: word, to, history: body.history === true }
          : { kind: 'thread-history', thread: word }
      const wait = gate(req, action)
      if (wait) return wait
      const r = await performThreadAction(work, action)
      app.changed()
      return json(r.status, r.body)
    }
    // Unshare and declines narrow; Take and Decline write the owner's entry, which then goes as any does.
    const written = withDb(true, db => {
      if (!db) throw new ThreadError('no_db', t('thread.err.noDb'))
      const head = findThread(db, word, null, true)
      const ctx = { ...ctxOf(db), me: myPeer() }
      if (op === 'unshare') return unshareThread(ctx, head)
      if (op === 'decline-share') return declineShare(ctx, head)
      if (op === 'take') return takeOffer(ctx, head)
      return declineOffer(ctx, head, typeof body.text === 'string' ? body.text : '')
    })
    app.changed()
    return sendWritten(written, req, { ok: true, key: written.head.key, head: written.head, entry: written.entry })
  }

  /** After an owner's write on a shared thread: its entry goes, or waits for the passkey (428). */
  async function sendWritten(
    written: { entry: ThreadEntry },
    req: Request,
    out: Record<string, unknown>,
  ): Promise<Response> {
    if (written.entry.out !== 'queued' || !app.work?.on()) return json(200, out)
    const r = await app.work.send(written.entry.id, unlockedBy(req))
    app.changed()
    if (r.state === 'confirm') {
      const wait = gate(req, { kind: 'thread-send', entry: written.entry.id })
      if (wait) return wait
    }
    return json(200, { ...out, ...sendReply(r) })
  }

  async function write(body: Record<string, unknown>, word: string | null, req: Request): Promise<Response> {
    if (word !== null) {
      const shared = await shareOp(body, word, req)
      if (shared) return shared
    } else if (body.op === 'track') {
      const work = app.work
      if (!work?.on()) throw new ThreadError('share_off', t('thread.err.shareOff'))
      const action: OwnerAction = {
        kind: 'thread-track',
        topic: String(body.topic ?? ''),
        lane: String(body.lane ?? ''),
      }
      const wait = gate(req, action)
      if (wait) return wait
      const r = await performThreadAction(work, action)
      app.changed()
      return json(r.status, r.body)
    }
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
      const head = findThread(db, word, null, true)
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
              ...(body.assignee !== undefined && { assignee: assigneeOf(body.assignee, head) }),
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
          throw new ThreadError('later', t('thread.err.later'))
        default:
          throw new ThreadError('bad', t('thread.err.bad'))
      }
    })
    app.changed()
    const { written } = done
    let out: Record<string, unknown> = { ok: true, key: written.head.key, head: written.head, entry: written.entry }
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
    // A shared thread's entry (#394): sent now, or waiting for the passkey.
    if (written.entry.out === 'queued') {
      const sent = await sendWritten(written, req, out)
      if (sent.status !== 200) return sent
      out = (await sent.json()) as Record<string, unknown>
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
      async handle(req, ctx) {
        if (!on()) return off()
        const raw = await ctx.rawBody()
        try {
          return await write(isRecord(raw) ? raw : {}, null, req)
        } catch (err) {
          return refusal(err)
        }
      },
    },
    {
      method: 'POST',
      path: /^\/api\/threads\/([^/]+)$/,
      guard: ['board-header'],
      async handle(req, ctx) {
        if (!on()) return off()
        const raw = await ctx.rawBody()
        try {
          return await write(isRecord(raw) ? raw : {}, ctx.params[0] ?? '', req)
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
      return findThread(db, key, null, true).key === key
    } catch {
      return false
    }
  }
  if (!withThreadsDb(false, known)) return json(404, { ok: false, error: t('thread.err.gone') })
  state.asked(key)
  events.event('thread-open', { key })
  return json(200, { ok: true, thread: key, pages: events.size() })
}

/** What a send of a shared entry answers (#394): its state, and the reason a held one waits. */
function sendReply(r: SendOut): Record<string, unknown> {
  return {
    ok: r.state !== 'refused',
    out: r.state,
    ...(r.state === 'held' && { reason: r.reason, ...(r.detail && { detail: r.detail }) }),
    ...(r.state === 'queued' && { why: r.why }),
    ...(r.state === 'refused' && { error: r.error }),
  }
}

/**
 * A shared thread's owner action, once it may go (#394): at once with the passkey off, or when
 * the confirmation window confirmed it (server/routes/team.ts perform).
 */
export async function performThreadAction(
  work: WorkHub,
  a: OwnerAction,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    if (a.kind === 'thread-send') {
      const r = await work.send(a.entry, true)
      return { status: r.state === 'refused' ? 400 : 200, body: sendReply(r) }
    }
    if (a.kind === 'thread-share') {
      const r = await work.share(a.thread, a.to, a.history)
      return {
        status: 200,
        body: {
          ok: true,
          key: r.written.head.key,
          head: r.written.head,
          ...sendReply(r.sent),
          ...(r.history && { history: r.history.state }),
        },
      }
    }
    if (a.kind === 'thread-history') {
      const r = await work.history(a.thread)
      return { status: r.state === 'refused' ? 400 : 200, body: sendReply(r) }
    }
    if (a.kind === 'thread-track') {
      const r = await work.track(a.topic, a.lane)
      return { status: 200, body: { ok: true, key: r.written.head.key, head: r.written.head, ...sendReply(r.sent) } }
    }
    return { status: 400, body: { ok: false, error: 'kind' } }
  } catch (err) {
    if (err instanceof ThreadError)
      return { status: err.code === 'not_found' ? 404 : 400, body: { ok: false, error: err.message, code: err.code } }
    return { status: 500, body: { ok: false, error: err instanceof Error ? err.message : String(err) } }
  }
}

/** What the confirmation window shows of a shared thread's action (#394), in the board's words. */
export function describeThreadAction(a: OwnerAction, nameOf: (peer: string) => string): Record<string, unknown> {
  const head = (word: string): ThreadHead | null => {
    try {
      return withThreadsDb(false, db => (db ? findThread(db, word, null, true) : null))
    } catch {
      return null
    }
  }
  if (a.kind === 'thread-send') {
    const found = withThreadsDb(false, db => {
      if (!db) return null
      const e = db.db.query('SELECT thread, text, fields, files FROM thread_entries WHERE id = ?').get(a.entry) as {
        thread: string
        text: string
        fields: string | null
        files: string | null
      } | null
      if (!e) return null
      const h = db.db.query('SELECT key, title FROM threads WHERE id = ?').get(e.thread) as {
        key: string
        title: string
      } | null
      // Everything the entry sends, said: its words, what it changes, its file.
      const set = (e.fields ? JSON.parse(e.fields) : {}) as Record<string, unknown>
      const files = (e.files ? JSON.parse(e.files) : []) as { name?: string }[]
      const changes = [
        typeof set.status === 'string' && `status: ${set.status}`,
        typeof set.summary === 'string' && set.summary && `summary: ${set.summary}`,
        typeof set.waitingOn === 'string' && set.waitingOn && `waiting on: ${set.waitingOn}`,
        typeof set.title === 'string' && `title: ${set.title}`,
        set.assignee !== undefined && 'a new assignee',
        ...files.map(f => `file: ${String(f.name ?? '')}`),
      ].filter(Boolean)
      const text = [e.text, changes.join(' · ')].filter(Boolean).join('\n')
      return h ? { text, key: h.key, title: h.title } : null
    })
    return { kind: a.kind, ...(found && { thread: found.key, title: found.title, text: found.text }) }
  }
  if (a.kind === 'thread-share') {
    const h = head(a.thread)
    const isPeer = /^[A-Za-z0-9_-]{43}$/.test(a.to)
    return {
      kind: a.kind,
      ...(h && { thread: h.key, title: h.title }),
      who: isPeer ? nameOf(a.to) : a.to,
      history: a.history,
    }
  }
  if (a.kind === 'thread-history') {
    const h = head(a.thread)
    return { kind: a.kind, ...(h && { thread: h.key, title: h.title }) }
  }
  if (a.kind === 'thread-track') return { kind: a.kind, lane: a.lane }
  return { kind: a.kind }
}
