// Verified done (#492, core/work-verify.ts): the board's side. The web board's scheduler runs
// sweep() on every tick while threads.verify is set: a held done with no verifier gets one (while
// fewer than verify.max run), started as a fork is (services/launch), with a Claude session id the
// board chose, so the thread knows its verifier before the session exists; a launch that failed
// sends the thread to the owner. The time limit is a schedule entry of kind `verify` under the
// verifier's key, which the scheduler hands to due(): past the limit with no verdict, the thread
// goes to the owner; after the verdict (board thread verdict moves the entry to now) the verifier
// is archived once it is free. Everything the thread says is an entry, so a board that restarts in
// the middle finds it all again: a running verifier keeps its entry (the sweep puts back one that
// went), a held done with none is started on the next tick.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { listArchive } from '../adapters/archive-store.ts'
import { readCard } from '../adapters/cards.ts'
import type { BoardDb } from '../adapters/db.ts'
import { ROOT } from '../adapters/paths.ts'
import { addEntry, listEntries, removeEntry, updateEntry } from '../adapters/schedule-store.ts'
import { readKey } from '../adapters/team-store.ts'
import { entriesOf, getThread, heldThreads, ThreadError, verifyingThreads } from '../adapters/work-thread-store.ts'
import { categoryInfo } from '../core/categories.ts'
import { sessionWorkspace, UNSAFE_CHARS } from '../core/launch/names.ts'
import { type NodeStatus, nodeKey, parseNodeKey } from '../core/nodes.ts'
import { DEFAULT_PROFILE } from '../core/profiles.ts'
import type { ScheduleEntry } from '../core/schedule-rules.ts'
import type { Config, Item } from '../core/types.ts'
import {
  briefFor,
  isSession,
  OWNER,
  oneLine,
  type Party,
  profileFor,
  SUMMARY_MAX,
  sharingOf,
  type ThreadHead,
  type ThreadsConfig,
  threadsConfig,
  type Verdict,
  type VerifyConfig,
  type VerifyRun,
} from '../core/work-threads.ts'
import { ownerLine, verifierName, verifyBrief } from '../core/work-verify.ts'
import { dropHeld } from './archive.ts'
import type { LaunchState, StartOptions, StartResult } from './launch/launches.ts'
import type { ParentFacts } from './launch/request.ts'
import { endVerifierRun, filePath, postEntry, type ThreadsCtx, type Written } from './work-threads.ts'

/** The default checklist in the repository (docs/agents/verify-checklist-code.md is the one for code a lane may name). */
export const CHECKLIST = join(ROOT, 'docs', 'agents', 'verify-checklist.md')

/** The schedule entry of a verifier: its time limit, then its archive. */
export const VERIFY_KIND = 'verify'
/** An archive the verifier is not free for yet is tried again after this long, this many times. */
const ARCHIVE_RETRY_MS = 60_000
const ARCHIVE_TRIES = 30
/** A verifier that has not shown up on the board this long after its start, and was not started by this process, is lost. */
const LOST_GRACE_MS = 3 * 60_000

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The verifier as the author of the board's entries about it: a session party with its key and name. */
const verifierParty = (key: string, thread: string): Extract<Party, { kind: 'session' }> => ({
  kind: 'session',
  key,
  name: verifierName(thread),
})

/** What the master knows of a device when a worker runs on a node (#675). */
export interface VerifyNodeInfo {
  configured: boolean
  online: boolean
  status: NodeStatus | null
  profiles?: Readonly<Record<string, string>>
  paused?: boolean
  drain?: boolean
  revoked?: boolean
}

/** What the board's side needs: the live config, its launches, herdr's workspaces, the archive, the database. */
export interface VerifyHost {
  cfg: Config
  log(line: string): void
  start(body: unknown, items: Item[], options: StartOptions): Promise<StartResult>
  launchState(id: string): LaunchState | null
  workspaces(): Promise<{ id: string; label: string }[]>
  /** Archive a session that is free: whether it went ('busy' while it works). */
  archive(item: Item): Promise<'ok' | 'busy'>
  /** The database for one call; null when there is none. */
  withDb<T>(fn: (db: BoardDb | null) => T): T
  /** How many profiles the board shows: a verifier with no worker's profile to keep needs exactly one, or verify.profile. */
  profiles(): number
  /** Another device's state for a worker on a node (#675); null when unknown or `nodes` is off. */
  node?(device: string): VerifyNodeInfo | null
  /** A placed launch's state on its node, from the node's payload (#675). */
  remoteLaunchState?(key: string): LaunchState | null
  /** Cancel a launch that is still queued in the placer (#675); true when one was cancelled. */
  cancelQueued?(launchId: string | undefined, key: string): boolean
  now?(): number
  /** The state folder, where entries' files are kept (tests). */
  state?: string
}

export interface Verifier {
  /** Start verifiers for held dones, catch failed launches, keep each running one's time limit. */
  sweep(items: () => Promise<Item[]>): Promise<void>
  /** A `verify` entry is due: the time limit, or the archive after the verdict. */
  due(entry: ScheduleEntry, items: Item[]): Promise<void>
  /**
   * Verified done was turned off (Settings, config.json; #596): every held done goes to the owner,
   * its verifier's run ended as a verdict ends it (the verifier archived once free). How many went.
   */
  switchedOff(): number
}

/** What a held done waits on once verified done was turned off (#596). */
export const SWITCHED_OFF = 'verification was switched off'

/** The board's verifier side over `host`. */
export function createVerifier(host: VerifyHost): Verifier {
  const now = (): number => host.now?.() ?? Date.now()
  // The launches this process started, by thread id: a failed one sends the thread to the owner.
  const started = new Map<string, { launch: string; key: string; at: number; handedAt?: number }>()
  // The same launches by the verifier's key, while due() may still need to know one is on its way.
  const launchOf = new Map<string, string>()

  const ctxOf = (db: BoardDb, cfg: ThreadsConfig, actor: Party): ThreadsCtx => ({
    db,
    cfg,
    actor,
    now: now(),
    ...(host.state && { state: host.state }),
    me: readKey()?.pub ?? '',
  })

  function cancelIfQueued(key: string): boolean {
    const launch = launchOf.get(key)
    const st = launch ? host.launchState(launch) : null
    const rst = parseNodeKey(key) ? (host.remoteLaunchState?.(key) ?? null) : null
    if (st?.state !== 'queued' && rst?.state !== 'queued') return false
    if (!host.cancelQueued?.(launch, key)) return false
    for (const [tid, s] of started) if (s.key === key) started.delete(tid)
    launchOf.delete(key)
    return true
  }

  /** The verification ends at the owner (a launch that failed, the time limit), in the verifier's name. */
  function toOwner(
    db: BoardDb,
    cfg: ThreadsConfig,
    head: ThreadHead,
    key: string,
    outcome: 'timeout' | 'error',
    why: string,
  ): void {
    const v = cfg.verify as VerifyConfig
    const line = outcome === 'timeout' ? `no verdict within ${v.limitMin} min` : oneLine(why, SUMMARY_MAX)
    postEntry(ctxOf(db, cfg, verifierParty(key, head.key)), head, {
      type: 'note',
      text: line,
      status: 'owner',
      waitingOn: ownerLine(outcome, why, v.limitMin),
      set: { verdict: outcome, verifier: null },
      ...(sharingOf(head) && { private: true }),
    })
  }

  /** The checklist for a lane: the file verify.brief names (a relative path is the repository's), else the default. */
  function checklistFor(v: VerifyConfig, lane: string): string {
    const named = briefFor(v, lane)
    const path = named ? (isAbsolute(named) ? named : join(ROOT, named)) : CHECKLIST
    try {
      return readFileSync(path, 'utf8')
    } catch {
      throw new Error(`the checklist ${path} cannot be read`)
    }
  }

  /** The worker's folder and what the start keeps of it: its card on the board, else its archive record. */
  function workerOf(by: Party, items: Item[]) {
    if (by.kind !== 'session') return null
    const item = items.find(i => i.key === by.key)
    if (item) return { item, cwd: item.cwd ?? '', record: null }
    if (parseNodeKey(by.key)) return null
    const record = listArchive().find(r => r.key === by.key) ?? null
    return record ? { item: null, cwd: record.cwd, record } : null
  }

  async function startOne(db: BoardDb, cfg: ThreadsConfig, held: ThreadHead, items: Item[]): Promise<void> {
    let head = held
    const v = cfg.verify as VerifyConfig
    const rawId = randomUUID()
    const by = head.proposed?.by
    const byDevice = by?.kind === 'session' ? (parseNodeKey(by.key)?.device ?? null) : null
    const worker = by ? workerOf(by, items) : null
    const device = worker?.item?.device ?? byDevice
    const key = device ? nodeKey(device, rawId) : rawId
    const fail = (why: string): void => {
      host.log(`verify ${head.key}: ${why}`)
      const fresh = getThread(db, head.id)
      if (fresh?.proposed?.verify) toOwner(db, cfg, fresh, key, 'error', why)
    }
    if (device !== null) {
      const info = host.node?.(device) ?? null
      if (!info?.configured) return fail(`device ${device} is not configured`)
      if (info.revoked) return fail(`${device} is revoked`)
      if (info.paused) return fail(`${device} is paused`)
      if (info.drain) return fail(`${device} is draining`)
      if (!info.online) return fail(`${device} is not reachable`)
      if (!info.status) return fail(`${device} has not reported its status yet`)
      if (!info.status.agents.includes('claude')) return fail(`${device} cannot start claude`)
      if (!worker?.cwd) return fail("the worker's folder is not known")
      const claude = worker.item ? (worker.item.agent ?? 'claude') === 'claude' : false
      let nodeProfile: string
      if (claude) {
        if (worker.item?.profileFolder || worker.item?.profileWanted || !worker.item?.profile)
          return fail(`the worker's profile on ${device} is not known`)
        nodeProfile = worker.item.profile
      } else {
        const configured =
          profileFor(v, device) ?? (typeof v.profile === 'string' ? (info.profiles?.[v.profile] ?? null) : null)
        if (configured) nodeProfile = configured
        else {
          const picked = pickNodeDefaultProfile(device, info.status.profiles)
          if (!picked.ok) return fail(picked.why)
          nodeProfile = picked.id
        }
      }
      const profileEntry = info.status.profiles.find(p => p.id === nodeProfile)
      if (!profileEntry) return fail(`${device} has no profile ${nodeProfile}`)
      if (profileEntry.loggedIn === false) return fail(`${device} is not logged in to ${nodeProfile}`)
      let checklist: string
      try {
        checklist = checklistFor(v, head.lane)
      } catch (err) {
        return fail(messageOf(err))
      }
      const at = now()
      const until = at + v.limitMin * 60_000
      const name = verifierName(head.key)
      const entries = entriesOf(db, head.id)
      const message = verifyBrief({
        head,
        entries,
        checklist,
        folder: worker.cwd,
        until,
        now: at,
        limitMin: v.limitMin,
        fileAt: () => `· see board thread show ${head.key}`,
        keyOfId: id => getThread(db, id)?.key ?? id.slice(0, 8),
        parentKey: head.parent ? (getThread(db, head.parent)?.key ?? null) : null,
      })
      const category = hostCategory(host.cfg, head.lane, worker.item, items)
      const workspace = nodeWorkspace([worker.item?.workspace, categoryInfo(host.cfg, category).title], name)
      const now2 = getThread(db, head.id)
      if (!now2?.proposed?.verify || now2.verify?.run) return
      head = now2
      try {
        postEntry(ctxOf(db, cfg, verifierParty(key, head.key)), head, {
          type: 'system',
          set: { verifier: { key, name, at, until } },
          ...(sharingOf(head) && { private: true }),
        })
      } catch (err) {
        host.log(`verify ${head.key}: ${messageOf(err)}`)
        return
      }
      const limit = addLimit(key, name, head, until, at)
      const body = {
        name,
        cwd: worker.cwd,
        category,
        workspace,
        message,
        profile: nodeProfile,
        pin: { device },
        ...(v.model && { model: v.model }),
      }
      let r: StartResult
      try {
        r = await host.start(body, items, { sessionId: rawId, remote: device, byHand: false })
      } catch (err) {
        r = { ok: false, field: '', error: messageOf(err) }
      }
      if (!r.ok) {
        if (limit) removeEntry(limit.id)
        const fresh = getThread(db, head.id)
        if (fresh && fresh.verify?.run?.key === key)
          toOwner(db, cfg, fresh, key, 'error', `the start was refused: ${r.error}`)
        host.log(`verify ${head.key}: ${r.error}`)
        return
      }
      started.set(head.id, { launch: r.id, key, at })
      launchOf.set(key, r.id)
      host.log(`verify ${head.key}: ${name} starts on ${device} in ${worker.cwd}`)
      return
    }
    // The folder itself is checked by the start (launch/request.ts, with a time limit): a mapped drive
    // that is offline does not hold up the scheduler's tick here.
    if (!worker?.cwd) return fail("the worker's folder is not known")
    let checklist: string
    try {
      checklist = checklistFor(v, head.lane)
    } catch (err) {
      return fail(messageOf(err))
    }
    const at = now()
    const until = at + v.limitMin * 60_000
    const name = verifierName(head.key)
    const entries = entriesOf(db, head.id)
    const message = verifyBrief({
      head,
      entries,
      checklist,
      folder: worker.cwd,
      until,
      now: at,
      limitMin: v.limitMin,
      fileAt: f => filePath(f.ref, host.state),
      keyOfId: id => getThread(db, id)?.key ?? id.slice(0, 8),
      parentKey: head.parent ? (getThread(db, head.parent)?.key ?? null) : null,
    })
    // A Claude worker's verifier runs in its profile; a pi or Codex worker's (or one gone from the
    // board with no profile it is known by) in verify.profile, else the one profile the board shows.
    const claude = worker.item ? (worker.item.agent ?? 'claude') === 'claude' : !!worker.record
    const from = worker.item ?? worker.record
    const parent = claude && from ? factsOf(from) : null
    const localProfile = profileFor(v, null)
    if (!parent && !localProfile) {
      const shown = host.profiles()
      if (shown !== 1)
        return fail(
          `no worker's profile to keep and no threads.verify.profile, while the board shows ${shown} profiles`,
        )
    }
    const category = hostCategory(host.cfg, head.lane, worker.item, items)
    let workspaces: { id: string; label: string }[] = []
    try {
      workspaces = await host.workspaces()
    } catch (err) {
      return fail(`herdr did not list its workspaces: ${messageOf(err)}`)
    }
    const workspace = sessionWorkspace({
      workspace: worker.item?.workspace ?? worker.record?.workspace ?? '',
      category,
      title: categoryInfo(host.cfg, category).title,
      items,
      workspaces,
      board: (host.cfg.placement ?? 'workspace') === 'workspace' ? (host.cfg.workspace ?? 'Board') : '',
    })
    // The thread knows its verifier first: a verdict that comes quickly finds it there. Read again
    // after the waits above: a done confirmed or taken back meanwhile gets no verifier.
    const now2 = getThread(db, head.id)
    if (!now2?.proposed?.verify || now2.verify?.run) return
    head = now2
    try {
      postEntry(ctxOf(db, cfg, verifierParty(key, head.key)), head, {
        type: 'system',
        set: { verifier: { key, name, at, until } },
        ...(sharingOf(head) && { private: true }),
      })
    } catch (err) {
      host.log(`verify ${head.key}: ${messageOf(err)}`)
      return
    }
    const limit = addLimit(key, name, head, until, at)
    const body = {
      name,
      cwd: worker.cwd,
      category,
      workspace,
      message,
      ...(v.model && { model: v.model }),
      ...(!parent && localProfile && { profile: localProfile }),
    }
    let r: StartResult
    try {
      r = await host.start(body, items, { sessionId: key, ...(parent && { parent }) })
    } catch (err) {
      r = { ok: false, field: '', error: messageOf(err) }
    }
    if (!r.ok) {
      if (limit) removeEntry(limit.id)
      const fresh = getThread(db, head.id)
      // The thread already names the verifier: its feed says the start was refused, not that none was named.
      if (fresh && fresh.verify?.run?.key === key)
        toOwner(db, cfg, fresh, key, 'error', `the start was refused: ${r.error}`)
      host.log(`verify ${head.key}: ${r.error}`)
      return
    }
    started.set(head.id, { launch: r.id, key, at })
    launchOf.set(key, r.id)
    host.log(`verify ${head.key}: ${name} starts in ${worker.cwd}`)
  }

  async function sweep(items: () => Promise<Item[]>): Promise<void> {
    const cfg = threadsConfig(host.cfg.threads)
    const v = cfg?.verify
    if (!cfg || !v) return
    await host.withDb(async db => {
      if (!db) return
      // Launches that failed after they started: the thread goes to the owner.
      for (const [thread, s] of started) {
        const st = host.launchState(s.launch)
        if (st?.state === 'failed') {
          started.delete(thread)
          const head = getThread(db, thread)
          if (head?.verify?.run?.key === s.key) {
            removeLimit(s.key)
            toOwner(db, cfg, head, s.key, 'error', st.error || 'the launch failed')
          }
          continue
        }
        if (!st || st.state === 'done') {
          if (parseNodeKey(s.key) && host.remoteLaunchState) {
            s.handedAt ??= st ? now() : s.at
            const rst = host.remoteLaunchState(s.key)
            if (rst?.state === 'failed') {
              started.delete(thread)
              const head = getThread(db, thread)
              if (head?.verify?.run?.key === s.key) {
                removeLimit(s.key)
                toOwner(db, cfg, head, s.key, 'error', rst.error || 'the launch failed')
              }
              continue
            }
            if (rst && rst.state !== 'done') continue
            if (rst?.state === 'done' || now() - s.handedAt >= LOST_GRACE_MS) started.delete(thread)
            continue
          }
          started.delete(thread)
        }
      }
      // A verifier the thread names that this process never started and that never got a card (the
      // board stopped between the entry and the launch): started afresh. One that had a card and is
      // gone from the board: the owner hears it is gone. Both only after a grace for a launch on its way.
      const lost = verifyingThreads(db).filter(h => {
        const run = h.verify?.run
        return !!run && ![...started.values()].some(s => s.key === run.key) && run.at < now() - LOST_GRACE_MS
      })
      if (lost.length) {
        const board = await items()
        for (const h of lost) {
          const run = h.verify?.run as VerifyRun
          if (board.some(i => i.key === run.key)) continue
          if (parseNodeKey(run.key)) {
            const rst = host.remoteLaunchState?.(run.key)
            if (rst && rst.state !== 'failed' && rst.state !== 'done') continue
            removeLimit(run.key)
            toOwner(
              db,
              cfg,
              h,
              run.key,
              'error',
              rst?.state === 'failed'
                ? rst.error || 'the launch failed'
                : `the verifier ${run.name} is gone from the board`,
            )
            continue
          }
          removeLimit(run.key)
          if (!readCard(run.key))
            postEntry(ctxOf(db, cfg, verifierParty(run.key, h.key)), h, {
              type: 'system',
              set: { verifier: null },
              ...(sharingOf(h) && { private: true }),
            })
          else toOwner(db, cfg, h, run.key, 'error', `the verifier ${run.name} is gone from the board`)
        }
      }
      // Each running verifier keeps its time limit; a limit whose thread no longer waits on it goes now
      // to its archive phase. One in that phase already is due()'s: its retries are left as they are.
      const running = verifyingThreads(db)
      const limits = listEntries().filter(e => e.kind === VERIFY_KIND)
      for (const h of running) {
        const run = h.verify?.run
        if (run && !limits.some(e => e.key === run.key)) addLimit(run.key, run.name, h, run.until, run.at)
      }
      for (const e of limits) {
        const h = typeof e.thread === 'string' ? getThread(db, e.thread) : null
        if (e.archive !== true && h?.verify?.run?.key !== e.key) {
          if (cancelIfQueued(e.key)) removeEntry(e.id)
          else endVerifierRun(e.key, now())
        }
      }
      // Held dones with no verifier, the oldest first, while fewer than verify.max run.
      let count = running.length
      const waiting = heldThreads(db).filter(h => !h.verify?.run)
      if (!waiting.length || count >= v.max) return
      const board = await items()
      for (const h of waiting) {
        if (count >= v.max) break
        await startOne(db, cfg, h, board)
        count++
      }
    })
  }

  function switchedOff(): number {
    // Threads may be off as well: the entries are written all the same, the owner finds them when they are on.
    const cfg = threadsConfig(host.cfg.threads) ?? (threadsConfig(true) as ThreadsConfig)
    return host.withDb(db => {
      if (!db) return 0
      let n = 0
      for (const head of heldThreads(db)) {
        const run = head.verify?.run
        try {
          postEntry(ctxOf(db, cfg, OWNER), head, {
            type: 'note',
            text: SWITCHED_OFF,
            status: 'owner',
            waitingOn: SWITCHED_OFF,
            ...(run && { set: { verifier: null } }),
            ...(sharingOf(head) && { private: true }),
            noDirect: true,
          })
          n++
        } catch (err) {
          host.log(`verify ${head.key}: ${messageOf(err)}`)
          continue
        }
        started.delete(head.id)
        // The verifier, if one runs, ends as after a verdict: a queued launch is cancelled, else archived once free.
        if (run) {
          if (cancelIfQueued(run.key)) removeLimit(run.key)
          else endVerifierRun(run.key, now())
        }
      }
      if (n) host.log(`verify: switched off, ${n} held done${n === 1 ? '' : 's'} sent to the owner`)
      return n
    })
  }

  async function due(entry: ScheduleEntry, items: Item[]): Promise<void> {
    const cfg = threadsConfig(host.cfg.threads)
    const thread = typeof entry.thread === 'string' ? entry.thread : ''
    // The time limit: past it with no verdict, the thread goes to the owner.
    host.withDb(db => {
      if (!db || !cfg?.verify) return
      const head = getThread(db, thread)
      const run = head?.verify?.run
      // Only a held done times out; anything else that still names it has nothing left to wait for.
      if (!head || run?.key !== entry.key || !head.proposed?.verify) return
      if (run.until > now()) {
        updateEntry(entry.id, x => ({ ...x, next: run.until, at: run.until }))
        return 'later'
      }
      toOwner(db, cfg, head, entry.key, 'timeout', '')
      endVerifierRun(entry.key, now())
    })
    const still = listEntries().find(e => e.id === entry.id)
    if (!still || still.next > now()) return
    // Then the archive: once the verifier is free. Not on the board: while its launch is still starting,
    // or within the grace of its start, its card may yet come (a run that ended before the session was
    // up), so it is tried again; after that nothing is left to do.
    const item = items.find(i => i.key === entry.key)
    if (!item) {
      if (cancelIfQueued(entry.key)) {
        removeEntry(entry.id)
        return
      }
      const launch = launchOf.get(entry.key)
      const st = launch ? host.launchState(launch) : null
      const rst = parseNodeKey(entry.key) ? (host.remoteLaunchState?.(entry.key) ?? null) : null
      const starting =
        st?.state === 'starting' || st?.state === 'queued' || (!!rst && rst.state !== 'done' && rst.state !== 'failed')
      const begun = Number(entry.begun) || 0
      const young = now() - begun < LOST_GRACE_MS
      const tries = (Number(entry.tries) || 0) + 1
      if ((starting || young) && tries < ARCHIVE_TRIES) {
        updateEntry(entry.id, x => ({
          ...x,
          next: now() + ARCHIVE_RETRY_MS,
          at: now() + ARCHIVE_RETRY_MS,
          tries,
          archive: true,
        }))
        return
      }
      launchOf.delete(entry.key)
      removeEntry(entry.id)
      return
    }
    let r: 'ok' | 'busy'
    try {
      r = await host.archive(item)
    } catch (err) {
      host.log(`verify: archive ${item.name}: ${messageOf(err)}`)
      r = 'busy'
    }
    if (r === 'ok') {
      // The archive took the session's entries into its record: this one must not come back with it.
      if (!parseNodeKey(item.key)) dropHeld(item.key, entry.id)
      removeEntry(entry.id)
      launchOf.delete(entry.key)
      return
    }
    const tries = (Number(entry.tries) || 0) + 1
    if (tries >= ARCHIVE_TRIES) {
      removeEntry(entry.id)
      host.log(`verify: ${item.name} stays on the board: never free to archive`)
      return
    }
    updateEntry(entry.id, x => ({
      ...x,
      next: now() + ARCHIVE_RETRY_MS,
      at: now() + ARCHIVE_RETRY_MS,
      tries,
      archive: true,
    }))
  }

  return { sweep, due, switchedOff }
}

/** A workspace label for a verifier started on a node (#675). */
function nodeWorkspace(candidates: (string | null | undefined)[], fallback: string): { create: string } {
  for (const c of candidates) {
    const s = typeof c === 'string' ? c.trim() : ''
    if (s && !UNSAFE_CHARS.test(s) && !s.startsWith('-')) return { create: s.slice(0, 40) }
  }
  return { create: fallback.slice(0, 40) }
}

/** Default Claude profile on a node for a non-Claude worker when config names none (#675). */
function pickNodeDefaultProfile(
  device: string,
  profiles: NodeStatus['profiles'],
): { ok: true; id: string } | { ok: false; why: string } {
  if (!profiles.length) return { ok: false, why: `${device} has no Claude profile` }
  const usable = profiles.filter(p => p.loggedIn !== false)
  if (!usable.length) return { ok: false, why: `${device} is not logged in to Claude` }
  const def = usable.find(p => p.id === DEFAULT_PROFILE) ?? (usable.length === 1 ? usable[0] : null)
  if (!def)
    return { ok: false, why: `no threads.verify.profile for ${device} and ${device} has no default Claude profile` }
  return { ok: true, id: def.id }
}

/** The profile facts a start keeps: those of the worker's card, or of its archive record. */
function factsOf(x: {
  key: string
  name: string
  profile?: string | null | undefined
  profileFolder?: string | undefined
  profileWanted?: string | undefined
}): ParentFacts {
  return {
    key: x.key,
    name: x.name,
    profile: x.profile ?? null,
    ...(x.profileFolder !== undefined && { profileFolder: x.profileFolder }),
    ...(x.profileWanted !== undefined && { profileWanted: x.profileWanted }),
  }
}

/** The lane a verifier starts in: the thread's, when the board has it, else the worker's, else other. */
function hostCategory(cfg: Pick<Config, 'categories'>, lane: string, worker: Item | null, items: Item[]): string {
  const lanes = new Set([...cfg.categories.map(c => c.id), ...items.map(i => i.category)])
  if (lanes.has(lane)) return lane
  return worker?.category && lanes.has(worker.category) ? worker.category : 'other'
}

/** A verifier's time limit in the schedule (kind `verify`); null when the schedule takes no more. */
function addLimit(key: string, name: string, head: ThreadHead, until: number, begun: number): ScheduleEntry | null {
  try {
    return addEntry({
      key,
      name,
      text: `time limit of the verification of ${head.key}`,
      at: until,
      next: until,
      kind: VERIFY_KIND,
      by: 'threads',
      thread: head.id,
      begun,
    })
  } catch {
    return null
  }
}

function removeLimit(key: string): void {
  for (const e of listEntries()) if (e.kind === VERIFY_KIND && e.key === key) removeEntry(e.id)
}

// ------------------------------------------------------------------ the verdict (the verifier's command)

/** The session a command runs in, as herdr confirms it, or why it could not be confirmed. */
export type SelfAnswer = { key: string } | { why: string }

/**
 * The session a verdict runs in (#492), failing closed: `key` is the command's own session (never
 * --session's), and herdr must say the pane HERDR_PANE_ID names holds that very session. No pane,
 * no answer from herdr, no session there or another one: a refusal that says why. This keeps a
 * confused agent from passing its own work with the verifier's id (which its card shows); it is no
 * wall against a process on the same computer that sets up a pane of its own.
 */
export async function paneSelf(
  key: string | null,
  pane: string | undefined,
  heldIn: (pane: string) => Promise<string | null>,
): Promise<SelfAnswer> {
  if (!key) return { why: 'it runs in no Claude session' }
  if (!pane) return { why: 'HERDR_PANE_ID is not set, so herdr cannot confirm the session it runs in' }
  let held: string | null
  try {
    held = await heldIn(pane)
  } catch (err) {
    return { why: `herdr did not say which session pane ${pane} holds: ${messageOf(err)}` }
  }
  if (!held) return { why: `herdr names no session in pane ${pane}` }
  if (held !== key) return { why: `pane ${pane} holds another session` }
  return { key }
}

export interface VerdictInput {
  outcome: 'pass' | 'fail' | 'unsure'
  line: string
  files?: readonly string[]
  /** The session that runs the command itself, as herdr confirmed it (paneSelf): it must be the verifier. */
  self: SelfAnswer | null
}

/**
 * What a verdict is refused for before herdr is asked anything: verification off, none running,
 * or a command that does not even claim the verifier's session.
 */
export function verdictGate(ctx: ThreadsCtx, head: ThreadHead): VerifyRun {
  if (!ctx.cfg.verify)
    throw new ThreadError('verify_off', 'verification is off on this board (threads.verify in config.json)')
  const run = head.verify?.run
  if (!run || !head.proposed?.verify) throw new ThreadError('no_verify', `no verification of ${head.key} is running`)
  if (!isSession(ctx.actor, run.key)) throw notVerifier(head)
  return run
}

const notVerifier = (head: ThreadHead, why = ''): ThreadError =>
  new ThreadError(
    'not_verifier',
    `only the verifier the board started for ${head.key} gives its verdict, from its own session${why ? `: ${why}` : ''}`,
  )

/**
 * `board thread verdict`: only from the verifier the board started for the thread, itself. Pass
 * needs a report (--file) and closes it done, with the held done's words as its summary; fail sends
 * it back to the worker (`doing`), the second fail in a row to the owner; unsure goes to the owner
 * and is no fail. On a shared thread a fail and an unsure stay here; a pass goes out as a plain done.
 * Its time-limit entry moves to now: the scheduler archives the verifier once it is free.
 */
export function giveVerdict(ctx: ThreadsCtx, head: ThreadHead, input: VerdictInput): Written {
  const run = verdictGate(ctx, head)
  if (!input.self) throw notVerifier(head)
  if ('why' in input.self) throw notVerifier(head, input.self.why)
  if (input.self.key !== run.key) throw notVerifier(head)
  const line = oneLine(input.line, 10_000)
  if (!line)
    throw new ThreadError(
      'usage',
      `usage: board thread verdict ${head.key} pass|fail|unsure [--file <report>] "<one line>"`,
    )
  if (line.length > SUMMARY_MAX)
    throw new ThreadError('summary_long', `the line has ${line.length} characters; ${SUMMARY_MAX} at most`)
  const files = input.files ?? []
  if (input.outcome === 'pass' && !files.length)
    throw new ThreadError(
      'report',
      'a pass needs its report: --file <report.md> naming each acceptance line and checklist point with what you looked at',
    )
  const twice = input.outcome === 'fail' && (head.verify?.fails ?? 0) + 1 >= 2
  const verdict: Verdict = input.outcome
  const shared = !!sharingOf(head)
  const w = postEntry(ctx, head, {
    type: 'note',
    text: line,
    files,
    set: { verdict },
    ...(input.outcome === 'pass'
      ? { status: 'done' as const, summary: oneLine(head.proposed?.why || line, SUMMARY_MAX) }
      : input.outcome === 'unsure' || twice
        ? { status: 'owner' as const, waitingOn: ownerLine(input.outcome === 'unsure' ? 'unsure' : 'fail', line) }
        : { status: 'doing' as const }),
    ...(shared && input.outcome !== 'pass' && { private: true }),
  })
  endVerifierRun(run.key, ctx.now)
  return w
}
