// The archive: sessions taken off the board. The board mirrors herdr, so archiving a session
// closes its pane (its tab, when nothing else is in it); Claude keeps the conversation on disk,
// so Return resumes it in a new tab (`claude --resume <id>`, services/launch) with its name, lane
// and card. One small JSON file per session in the state folder's archive/, written under the
// same per-file lock as the cards (adapters/archive-store.ts).
//
// A record starts `closing`: the board hides the card at once and the pane closes UNDO_MS later,
// so Return from the page's toast puts everything back as it was, and the record on disk carries
// that through a reload of the page or a restart of the board. The scheduler closes due ones
// (closeDue), checking first that the session is still free: one that got to work meanwhile
// stays on the board ("kept", the log says why). Then the record is `archived` until Return
// brings the session back or "Remove from archive" drops the record and the card; Claude's
// transcript is never touched.
//
// The session's schedule entries wait in the record (held) and go back into the schedule with
// it; a restart on its way is dropped, since a resume is one, and so is a sleep (`board sleep
// --when-free`), which would put it back to sleep as it comes back. Putting them back marks the
// record `restoring` first and drops it only once every entry is back, so a board that stops in between
// finishes the job on its next refresh (collect calls settleReturned). The card file stays where
// it is, so a session resumed by hand elsewhere comes back with its name and lane too.
//
// Claude profiles: the record keeps the profile the session ran in, and Return resumes it there
// or not at all: the board's launch path with that profile (launchTarget with the record as the
// parent), its transcript looked up in that profile's folder only. A session whose profile the
// board cannot tell is not archived, as it could not come back in the right account.
//
// A record: core/archive.ts ArchiveRecord.

import {
  archivedFiles,
  getArchived,
  isArchived,
  listArchive,
  logArchive,
  removeSessionFiles,
  updateArchived,
} from '../adapters/archive-store.ts'
import { readCard } from '../adapters/cards.ts'
import { cwdOf } from '../adapters/claude-home.ts'
import { herdr, workspaceList } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import { listEntries, removeEntry, restoreEntry } from '../adapters/schedule-store.ts'
import { type ArchiveRecord, type ArchiveReturning, archiveBlock } from '../core/archive.ts'
import { noteOf } from '../core/board.ts'
import { categoryInfo } from '../core/categories.ts'
import { parentProfile } from '../core/item-profile.ts'
import { t } from '../core/lang.ts'
import { sameDir, sessionWorkspace, UNSAFE_CHARS } from '../core/launch/names.ts'
import { launchTarget, type ProfileSet, sessionProfile } from '../core/profiles.ts'
import type { ScheduleEntry, SessionRef } from '../core/schedule-rules.ts'
import type { Config, Item, Translator } from '../core/types.ts'
import { nextRun } from '../core/when.ts'
import { readyToSleep } from './actions.ts'
import type { Deps } from './deps.ts'
import type { Launches } from './launch/launches.ts'

export { archivedFiles, getArchived, isArchived, listArchive }

// The page offers Return in a toast for 6 seconds; the pane closes a little after that.
export const UNDO_MS = 8000
// A close holds its claim this long (a board that died in the middle leaves it).
const CLAIM_MS = 2 * 60_000
// herdr failing to close the pane this many times calls the archive off.
const CLOSE_TRIES = 3

/** How long a session put in the archive keeps its pane, for Return in the page's toast: config.json's archiveUndoSec. */
export const undoMs = (cfg: Pick<Config, 'archiveUndoSec'>): number =>
  typeof cfg.archiveUndoSec === 'number' && cfg.archiveUndoSec >= 0 ? cfg.archiveUndoSec * 1000 : UNDO_MS

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const codeOf = (err: unknown): unknown => (isRecord(err) ? err.code : undefined)
const notFound = (err: unknown): boolean => /not.?found|no such/i.test(`${codeOf(err)} ${messageOf(err)}`)
const lockTimeout = (err: unknown): boolean => /Timed out waiting for lock/.test(messageOf(err))
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

type Log = (line: string) => void

/** Change a record that exists: `change(record)` returns the new one, null to delete it, or undefined. */
function update(
  key: string,
  change: (r: ArchiveRecord) => ArchiveRecord | null | undefined,
): ArchiveRecord | null | undefined {
  return updateArchived(key, r => (r ? change(r) : undefined))
}

/**
 * Whether a board item stays off the board: its close is on its way, or the pane it was closed
 * in still shows for a moment (herdr's snapshot can lag the close). Seen in another pane once it
 * is archived, the session is back (resumed by Return, or by hand); one being put back shows.
 */
export const hides = (record: ArchiveRecord | null, item: Pick<Item, 'pane'>): boolean =>
  !!record && (record.state === 'closing' || (record.state === 'archived' && record.pane === item.pane))

// ------------------------------------------------------------------ the session's profile

/** What tells a session's profile: its item's, or its record's (taken from its item when it was archived). */
type ProfileFacts = Pick<Item, 'profile' | 'profileFolder' | 'profileWanted'>

/**
 * Why the board cannot tell a session's profile, for a message (the folder it reported, a profile
 * no longer listed, or the one its start asked for when it runs in another); null when it can
 * (core/item-profile.ts parentProfile: the one a start from it keeps, hidden or not). In `tr`'s
 * language: the board's, or English for `board archive`.
 */
export function profileDoubt(facts: ProfileFacts, set: ProfileSet, tr: Translator = t): string | null {
  if (parentProfile(facts, set.list)) return null
  if (facts.profileWanted) {
    const want = set.list.find(p => p.id === facts.profileWanted)?.title || facts.profileWanted
    return tr('profile.wrong', { want })
  }
  return facts.profileFolder || facts.profile || tr('profile.unknown')
}

/** A record's profile: as its session's item said when it was archived, else as its card says now. */
function recordProfile(deps: Deps, r: ArchiveRecord): ProfileFacts {
  if (!('profile' in r)) return sessionProfile(readCard(r.key), deps.profiles().list)
  return {
    profile: typeof r.profile === 'string' ? r.profile : null,
    ...(typeof r.profileFolder === 'string' && r.profileFolder && { profileFolder: r.profileFolder }),
    ...(typeof r.profileWanted === 'string' && r.profileWanted && { profileWanted: r.profileWanted }),
  }
}

// ------------------------------------------------------------------ checks against herdr

const WHY: Record<string, string> = {
  busy: 'archive.why.working',
  dialog: 'archive.why.dialog',
  draft: 'archive.why.draft',
  tasks: 'archive.why.tasks',
  gone: 'archive.why.gone',
}

/** What the archive reads of a pane in herdr. */
interface PaneFacts {
  workspace: string
  tab: string
  agent: string | null
  session: string | null
  label: string
}

/** herdr's pane, or null when its answer has none. */
async function paneGet(pane: string): Promise<PaneFacts | null> {
  const answer = await herdr(['pane', 'get', pane])
  const p = isRecord(answer) ? answer.pane : null
  if (!isRecord(p)) return null
  return {
    workspace: text(p.workspace_id),
    tab: text(p.tab_id),
    agent: text(p.agent) || null,
    session: isRecord(p.agent_session) ? text(p.agent_session.value) || null : null,
    label: text(p.label),
  }
}

/** What the archive's checks read of a board item, or of a record (it keeps the same fields). */
export type ArchiveSubject = Pick<Item, 'name' | 'pane' | 'session' | 'profile' | 'profileFolder' | 'profileWanted'>

export type FreeToClose = { ok: true; pane: PaneFacts | null } | { ok: false; why: string; detail?: string }

/**
 * Whether the session can be closed now, from herdr itself: { ok, pane } (herdr's pane, or null
 * when it is gone already) or { ok: false, why, detail }. Its profile must be one the board can
 * tell, or it could not come back in the right account. Claude in it must be this session and
 * free: no turn, no dialog, no text in its input box, no background command or Monitor (actions.ts
 * readyToSleep, in its own profile's registry). A shell with no Claude in it goes only as
 * herdr-wake left a sleeping one: marked 💤, nothing running in it but the shell; a Claude that
 * exited by itself, or a program started in its place, keeps the pane. The profile's detail is in
 * `tr`'s language (profileDoubt).
 */
export async function freeToClose(deps: Deps, item: ArchiveSubject, tr: Translator = t): Promise<FreeToClose> {
  const doubt = profileDoubt(item, deps.profiles(), tr)
  if (doubt !== null) return { ok: false, why: 'archive.why.profile', detail: doubt }
  // A sleeper whose pane wake closed (#204): nothing to close.
  if (!item.pane) return { ok: true, pane: null }
  const target = item.pane
  let pane: PaneFacts | null
  try {
    pane = await paneGet(target)
  } catch (err) {
    if (notFound(err)) return { ok: true, pane: null }
    return { ok: false, why: 'archive.why.herdr', detail: messageOf(err) }
  }
  if (!pane) return { ok: true, pane: null }
  if (!pane.agent) {
    if (!pane.label.startsWith('💤')) return { ok: false, why: 'archive.why.exited' }
    try {
      const answer = await herdr(['pane', 'process-info', '--pane', target])
      const info = isRecord(answer) && isRecord(answer.process_info) ? answer.process_info : null
      const procs = Array.isArray(info?.foreground_processes) ? info.foreground_processes : []
      if (procs.some(p => isRecord(p) && p.pid !== info?.shell_pid)) return { ok: false, why: 'archive.why.shellBusy' }
    } catch (err) {
      return { ok: false, why: 'archive.why.herdr', detail: messageOf(err) }
    }
    return { ok: true, pane }
  }
  if (pane.agent !== 'claude' || pane.session !== (item.session ?? null)) return { ok: false, why: 'archive.why.gone' }
  const ready = await readyToSleep(deps, item)
  if (ready.ok) return { ok: true, pane }
  if (ready.profile)
    return { ok: false, why: 'archive.why.profile', detail: profileDoubt(item, deps.profiles(), tr) ?? '' }
  const why = Object.hasOwn(WHY, ready.why) ? WHY[ready.why] : undefined
  return why ? { ok: false, why } : { ok: false, why: 'archive.why.herdr', detail: ready.why }
}

// ------------------------------------------------------------------ archiving

export type AskArchive =
  | { ok: true; record: ArchiveRecord; held: number; dropped: number }
  | { ok: false; why: string; detail?: string }

/**
 * Take a board item off the board: the record now, the pane `grace` ms later (closeDue). Refused
 * with { ok: false, why, detail } when the session may not go (core/archive.ts archiveBlock,
 * freeToClose). The record keeps what its card says last (core/board.ts noteOf) and the profile it
 * runs in. by: 'user' or 'agent'; from: the session that asked, when another one did; tr: the
 * language of a refusal's detail (freeToClose). Returns { ok, record, held, dropped }: how many
 * entries wait with it, how many (a restart, a sleep) were dropped.
 */
export async function askArchive(
  deps: Deps,
  item: Item,
  {
    by = 'user',
    from = null,
    grace = UNDO_MS,
    now = Date.now(),
    tr = t,
  }: { by?: 'user' | 'agent'; from?: SessionRef | null; grace?: number; now?: number; tr?: Translator } = {},
): Promise<AskArchive> {
  const block = archiveBlock(item, listEntries())
  if (block) return { ok: false, why: block }
  const free = await freeToClose(deps, item, tr)
  if (!free.ok) return free
  const record: ArchiveRecord = {
    key: item.key,
    session: item.session ?? '',
    name: item.name,
    autoName: item.autoName ?? '',
    category: item.category,
    cwd: item.cwd ?? '',
    workspace: item.workspace ?? '',
    workspaceId: free.pane?.workspace ?? '',
    pane: item.pane ?? '',
    tab: free.pane?.tab ?? '',
    note: noteOf(item) ?? '',
    title: item.title ?? '',
    sleeping: !!item.sleeping,
    activity: item.activity ?? 0,
    // The profile it runs in: it comes back in that one, or not at all (bringBack).
    ...(item.profile !== undefined && { profile: item.profile }),
    ...(item.profileFolder !== undefined && { profileFolder: item.profileFolder }),
    ...(item.profileWanted !== undefined && { profileWanted: item.profileWanted }),
    archivedAt: now,
    by,
    ...(from && { from: { key: String(from.key), name: String(from.name ?? '') } }),
    state: 'closing',
    closeAt: now + grace,
    held: [],
  }
  const made = updateArchived(item.key, taken => (taken ? undefined : record))
  if (!made) return { ok: false, why: 'archive.why.already' }
  const dropped = holdEntries(item.key)
  const saved = getArchived(item.key) ?? record
  return { ok: true, record: saved, held: saved.held.length, dropped }
}

/**
 * The session's schedule entries into its record: each copied first, then taken out of the
 * schedule, so a board that stops in between leaves one in both at worst (putting it back finds
 * it there). A restart or a sleep on its way is dropped; a report with a receipt is left where it
 * is (it keeps the session on the board, see closeOne). Returns how many were dropped.
 */
export function holdEntries(key: string): number {
  let dropped = 0
  for (const e of listEntries().filter(x => x.key === key && !x.receipt)) {
    if (e.kind === 'restart' || e.kind === 'sleep') {
      removeEntry(e.id)
      dropped++
      continue
    }
    const { claim, tried, waited, pendingSince, why, retryAt, attempts, ...entry } = e
    if (update(key, r => ({ ...r, held: [...r.held.filter(x => x.id !== e.id), entry] }))) removeEntry(e.id)
  }
  return dropped
}

/**
 * Close the pane of every record whose time has come (`keys`: of these sessions only). Returns {
 * closed, kept }: how many it closed, how many it called off (back on the board).
 */
export async function closeDue(
  deps: Deps,
  { log = () => {}, now = Date.now(), keys = null }: { log?: Log; now?: number; keys?: string[] | null } = {},
): Promise<{ closed: number; kept: number }> {
  const out = { closed: 0, kept: 0 }
  for (const r of listArchive()) {
    if (r.state !== 'closing' || r.closeAt > now || (keys && !keys.includes(r.key))) continue
    const done = await closeOne(deps, r.key, log)
    if (done) out[done]++
  }
  return out
}

/** Taken for this process, unless a close of it is on its way elsewhere. */
function claim(key: string, now: number): ArchiveRecord | null | undefined {
  return update(key, r => {
    if (r.state !== 'closing' || r.closeAt > now) return undefined
    if (r.claim && r.claim.pid !== process.pid && now - r.claim.at < CLAIM_MS) return undefined
    return { ...r, claim: { pid: process.pid, at: now } }
  })
}

/** The panes of a tab: their ids, whether an agent runs in each, and whether a plugin made it (its tokens). */
async function tabPanes(workspace: string, tab: string): Promise<{ pane: string; agent: boolean; plugin: boolean }[]> {
  const answer = await herdr(['pane', 'list', '--workspace', workspace])
  const panes = isRecord(answer) && Array.isArray(answer.panes) ? answer.panes : []
  return panes.flatMap(p =>
    isRecord(p) && p.tab_id === tab
      ? [{ pane: text(p.pane_id), agent: !!p.agent, plugin: isRecord(p.tokens) && Object.keys(p.tokens).length > 0 }]
      : [],
  )
}

/** 'closed', 'kept' (called off), or null (not now: claimed elsewhere, or herdr is tried again). */
export async function closeOne(deps: Deps, key: string, log: Log): Promise<'closed' | 'kept' | null> {
  const r = claim(key, Date.now())
  if (!r) return null
  // Entries set for it while it was on its way wait in the record too; a MokuPilot report that
  // came for it meanwhile keeps it on the board, to be delivered.
  holdEntries(key)
  if (listEntries().some(e => e.key === key && e.receipt)) return keep(r, 'archive.why.report', '', log)
  const free = await freeToClose(deps, r)
  if (!free.ok) {
    // herdr not answering is tried again; the session itself not being free calls it off.
    if (free.why === 'archive.why.herdr') return retry(r, free.detail ?? '', log)
    return keep(r, free.why, free.detail ?? '', log)
  }
  const pane = free.pane
  if (pane) {
    try {
      // The tab goes when nothing else is in it, else the pane alone. Another plugin's panel beside
      // it (herdr-sidebar's: no agent, the plugin's own metadata tokens) is nothing else; an agent
      // or a plain shell (a server, the user's own) is.
      const others = (await tabPanes(pane.workspace, pane.tab)).filter(p => p.pane !== r.pane && (p.agent || !p.plugin))
      if (!others.length && pane.tab) await herdr(['tab', 'close', pane.tab])
      else await herdr(['pane', 'close', r.pane])
    } catch (err) {
      if (!notFound(err)) return retry(r, messageOf(err), log)
    }
    // Archived only once the pane is gone: one still there would stay hidden, and Return would
    // start a second Claude beside it.
    try {
      await herdr(['pane', 'get', r.pane])
      return retry(r, 'its pane is still there', log)
    } catch (err) {
      if (!notFound(err)) return retry(r, messageOf(err), log)
    }
  }
  update(key, rec => {
    const { claim: c, tries, ...rest } = rec
    return { ...rest, state: 'archived', closedAt: Date.now() }
  })
  logArchive({ key, name: r.name, at: Date.now(), result: 'closed' })
  log(`archive ${r.name}: closed ${pane ? r.pane : '(its pane was gone already)'}`)
  return 'closed'
}

/** herdr failed: tried again on the next tick, CLOSE_TRIES times in all, then called off. */
function retry(r: ArchiveRecord, detail: string, log: Log): 'kept' | null {
  const tries = (r.tries ?? 0) + 1
  if (tries >= CLOSE_TRIES) return keep(r, 'archive.why.herdr', detail, log)
  update(r.key, rec => {
    const { claim: c, ...rest } = rec
    return { ...rest, tries }
  })
  log(`archive ${r.name}: herdr failed (${detail}), trying again`)
  return null
}

/** The session stays on the board after all: its entries back, the record gone, the reason logged. */
function keep(r: ArchiveRecord, why: string, detail: string, log: Log): 'kept' {
  update(r.key, rec => {
    const { claim: c, ...rest } = rec
    return { ...rest, state: 'restoring' }
  })
  putBack(r.key)
  logArchive({ key: r.key, name: r.name, at: Date.now(), result: 'kept', why, ...(detail && { detail }) })
  log(`archive ${r.name}: kept on the board (${why}${detail ? `: ${detail}` : ''})`)
  return 'kept'
}

/** Where a session came back: its pane and folder now, when another than the one archived. */
type Where = { pane?: string | null; cwd?: string }

/**
 * A record marked `restoring`: its entries back into the schedule, then the record gone. Entries
 * that could not go back yet (a lock held too long) stay in it for the next try. `where`: the
 * session's pane and folder now, when it came back in another pane. Returns whether it is done.
 */
export function putBack(key: string, where: Where = {}): boolean {
  const r = getArchived(key)
  if (r?.state !== 'restoring') return !r
  const left = restoreHeld(r, where)
  if (left.length) {
    update(key, rec => ({ ...rec, held: left }))
    return false
  }
  update(key, rec => (rec.state === 'restoring' ? null : undefined))
  return true
}

/**
 * A record's entries back into the schedule; returns those that could not go back now. A
 * repeating one goes on from its next run after now (the runs it missed while archived are not
 * owed); a one-off that came due meanwhile goes out once the session is free, saying how late it
 * is. One still in the schedule under its id (a board stopped between copying and removing it)
 * is there already. When they run, they wake the session through the board's profile guards.
 */
export function restoreHeld(r: ArchiveRecord, where: Where = {}): ScheduleEntry[] {
  const now = Date.now()
  const left: ScheduleEntry[] = []
  for (const e of r.held) {
    let next: number | null = e.next
    if (e.cron && e.next < now) {
      try {
        next = nextRun(e.cron, now)
      } catch {
        next = null
      }
      if (next === null) continue
    }
    try {
      restoreEntry({ ...e, next, ...(where.pane && { pane: where.pane }), ...(where.cwd && { cwd: where.cwd }) })
    } catch (err) {
      if (lockTimeout(err)) left.push(e)
      else logArchive({ key: r.key, name: r.name, at: now, result: 'unrestored', detail: `${e.id}: ${messageOf(err)}` })
    }
  }
  return left
}

// ------------------------------------------------------------------ Return, and dropping a record

/**
 * What Return finds: { ok, back, name } when its pane had not closed yet (the card is back as it
 * was), { ok, resume: record } when the session is to be resumed in a new tab (the record now
 * says a Return is on its way; the caller starts it and gives its launch with markReturning), {
 * ok, again, name } when one is on its way already, { ok: false, wait } while its pane is being
 * closed right now, { ok: false, gone } without a record.
 */
export type TakeBack =
  | { ok: false; gone: true }
  | { ok: false; wait: true }
  | { ok: true; back: true; name: string }
  | { ok: true; again: true; name: string }
  | { ok: true; resume: ArchiveRecord }

/**
 * Return, decided under the record's lock, so two Returns at once never start two sessions.
 * `busy(returning)` says whether the Return the record names still is on its way.
 */
export function takeBack(
  key: string,
  { busy = () => false, now = Date.now() }: { busy?: (returning: ArchiveReturning) => boolean; now?: number } = {},
): TakeBack {
  const seen: { out: TakeBack; back: string | null } = { out: { ok: false, gone: true }, back: null }
  update(key, r => {
    if (r.state === 'restoring') {
      seen.out = { ok: true, back: true, name: r.name }
      return undefined
    }
    if (r.state === 'closing') {
      if (r.claim && now - r.claim.at < CLAIM_MS) {
        seen.out = { ok: false, wait: true }
        return undefined
      }
      seen.back = r.name
      seen.out = { ok: true, back: true, name: r.name }
      return { ...r, state: 'restoring' }
    }
    if (r.returning && busy(r.returning)) {
      seen.out = { ok: true, again: true, name: r.name }
      return undefined
    }
    const next: ArchiveRecord = { ...r, returning: { at: now, launch: null } }
    seen.out = { ok: true, resume: next }
    return next
  })
  if (seen.back !== null) {
    putBack(key)
    logArchive({ key, name: seen.back, at: now, result: 'returned' })
  }
  return seen.out
}

/** The resume of it started (its launch's id), or failed to (null: Return can be tried again). */
export function markReturning(key: string, launch: string | null): void {
  update(key, r => {
    if (r.state !== 'archived') return undefined
    const { returning, ...rest } = r
    return launch ? { ...rest, returning: { at: Date.now(), launch } } : rest
  })
}

/**
 * The session is on the board again, in another pane than the one archived: resumed by Return or
 * by hand. Its entries go back with its pane and folder now, the record goes. Also finishes a
 * record a board left `restoring` when it stopped. Returns whether the record is gone.
 */
export function settleReturned(item: Pick<Item, 'key' | 'pane' | 'cwd'>): boolean {
  const seen: { r: ArchiveRecord | null; fresh: boolean } = { r: null, fresh: false }
  update(item.key, rec => {
    if (rec.state === 'restoring') {
      seen.r = rec
      return undefined
    }
    if (rec.state !== 'archived' || rec.pane === item.pane) return undefined
    const moved: ArchiveRecord = { ...rec, state: 'restoring', moved: true }
    seen.r = moved
    seen.fresh = true
    return moved
  })
  const r = seen.r
  if (!r) return false
  if (seen.fresh) logArchive({ key: r.key, name: r.name, at: Date.now(), result: 'returned' })
  return putBack(item.key, r.moved ? { pane: item.pane, cwd: item.cwd } : {})
}

export type Forget = { ok: true; record: ArchiveRecord } | { ok: false; gone: true } | { ok: false; closing: true }

/**
 * "Remove from archive": the record and the session's card go (and the context fill the status
 * line kept), with the entries that waited in it. Claude's transcript and folders stay where they
 * are. A record whose pane is still to close, or that is being put back, is not removed.
 */
export function forgetArchived(key: string): Forget {
  const seen: { out: Forget } = { out: { ok: false, gone: true } }
  update(key, rec => {
    if (rec.state === 'closing') {
      seen.out = { ok: false, closing: true }
      return undefined
    }
    if (rec.state !== 'archived') return undefined
    seen.out = { ok: true, record: rec }
    return null
  })
  const out = seen.out
  if (!out.ok) return out
  removeSessionFiles(key)
  logArchive({ key, name: out.record.name, at: Date.now(), result: 'removed' })
  return out
}

// ------------------------------------------------------------------ bringing one back

/** What Return needs of the board: its launches (to start the resume, and to see it run) and its items now. */
export interface ReturnApp {
  launches: Pick<Launches, 'start' | 'list'>
  items(): Item[]
}

/** Whether a Return on its way still is: its launch runs (not failed, not waved off), or (no launch yet) it is being started. */
export function returningOn(launches: Pick<Launches, 'list'>, ret: ArchiveReturning): boolean {
  const id = ret.launch
  return id ? launches.list().some(l => l.id === id && l.state !== 'failed') : Date.now() - ret.at < 60_000
}

export type BringBack =
  | { ok: true; name: string; back?: boolean; again?: boolean; resume?: true; launch?: string }
  | { ok: false; error: string }

/**
 * Bring a session back from the archive: Return before its pane closed puts the card back as it
 * was; after that, the session is resumed in a new tab (services/launch, `--resume <id>`) in the
 * folder it ran in, in its workspace while herdr has it, else its lane's, with its name and lane.
 * It resumes in its own profile (the record's, else its card's), hidden or not, through the
 * board's launch path, or not at all: a profile the board cannot be sure of, or a transcript not
 * in that profile's folder, refuses it before anything starts.
 */
export async function bringBack(deps: Deps, app: ReturnApp, key: string): Promise<BringBack> {
  const { cfg } = deps
  // A resume that failed or was waved off does not stand in the way of another; one on its way does.
  const back = (): TakeBack => takeBack(key, { busy: ret => returningOn(app.launches, ret) })
  let r = back()
  // Its pane is being closed right now: Return comes once that is done.
  for (const end = Date.now() + 20_000; 'wait' in r && Date.now() < end; r = back()) await sleep(300)
  if ('wait' in r) return { ok: false, error: t('archive.err.busy') }
  if ('gone' in r) return { ok: false, error: t('archive.err.gone') }
  if (!('resume' in r)) return { ok: true, back: 'back' in r, again: 'again' in r, name: r.name }
  const rec = r.resume
  // The record says a Return is on its way from now on; one that does not get started says so.
  const fail = (error: string): BringBack => {
    markReturning(key, null)
    return { ok: false, error }
  }
  // Its own profile, hidden or not, never another (launchTarget with the record as the parent).
  const set = deps.profiles()
  const facts = recordProfile(deps, rec)
  const target = launchTarget(undefined, { name: rec.name, ...facts }, set)
  const refused = (profile: string): BringBack =>
    fail(t('archive.err.profile', { name: rec.name, profile, session: rec.session }))
  if (!target.ok) return refused(profileDoubt(facts, set) ?? t('profile.unknown'))
  const own = target.profile
  // Its conversation, in that profile's folder only: Claude resumes a session only where it ran.
  const path = deps.homes.forDir(own.dir).transcriptPath(rec.session, rec.cwd)
  if (!path) {
    const elsewhere = set.list.some(
      p => !sameDir(p.dir, own.dir) && deps.homes.forDir(p.dir).transcriptPath(rec.session, rec.cwd),
    )
    return elsewhere ? refused(own.title) : fail(t('archive.err.noTranscript', { name: rec.name }))
  }
  // Claude finds a session by the folder it ran in.
  const cwd = (await cwdOf(path)) || rec.cwd
  let workspaces: { id: string; label: string }[]
  try {
    workspaces = (await workspaceList(8000)).map(w => ({ id: w.id, label: w.label ?? '' }))
  } catch (err) {
    return fail(t('archive.err.herdr', { why: messageOf(err) }))
  }
  const items = app.items()
  const board = (cfg.placement ?? 'workspace') === 'workspace' ? (cfg.workspace ?? 'Board') : ''
  const known = new Set([...cfg.categories.map(c => c.id), ...items.map(i => i.category)])
  const category = known.has(rec.category) ? rec.category : 'other'
  const workspace = sessionWorkspace({
    workspaceId: rec.workspaceId,
    workspace: rec.workspace,
    category: rec.category,
    title: categoryInfo(cfg, rec.category).title,
    items,
    workspaces,
    board,
  })
  const name =
    String(rec.name ?? '')
      .replace(new RegExp(UNSAFE_CHARS.source, 'g'), '')
      .replace(/^[\s/-]+/, '')
      .trim()
      .slice(0, 60) || rec.session.slice(0, 8)
  const started = await app.launches.start({ name, cwd, category, workspace, profile: own.id }, items, {
    resume: rec.session,
    parent: { key: rec.key, name: rec.name, ...facts },
  })
  if (!started.ok) return fail(started.error)
  markReturning(key, started.id)
  deps.log(`archive ${rec.name}: resuming ${rec.session} in ${cwd}`)
  return { ok: true, resume: true, launch: started.id, name: rec.name }
}
