// The archive: sessions taken off the board. The board mirrors herdr, so archiving a session
// closes its pane (its tab, when nothing else is in it); Claude keeps the conversation on disk,
// so Return resumes it in a new tab (`claude --resume <id>`, launch.mjs) with its name, lane and
// card. One small JSON file per session in the state folder's archive/, written under the same
// per-file lock as the cards (store.mjs).
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
// it; a restart on its way is dropped, since a resume is one. Putting them back marks the record
// `restoring` first and drops it only once every entry is back, so a board that stops in between
// finishes the job on its next refresh (collect calls settleReturned). The card file stays where
// it is, so a session resumed by hand elsewhere comes back with its name and lane too.
//
// A record: { key, session, name, autoName, category, cwd, workspace, workspaceId, pane, tab,
// note, title, sleeping, activity, archivedAt, by ('user' | 'agent'), from ({ key, name }: the
// session that archived it), state ('closing' | 'archived' | 'restoring'), closeAt, closedAt,
// held, tries, claim (a close on its way), returning ({ at, launch }: a Return on its way, the
// launch null while it is being started), moved (restoring into the pane it came back in) }.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { archiveBlock } from '../web/archive-model.js'
import { readyToSleep } from './actions.mjs'
import { herdr } from './herdr.mjs'
import { ARCHIVE_DIR, CARDS_DIR, CONTEXT_DIR } from './paths.mjs'
import { listEntries, removeEntry, restoreEntry } from './schedule.mjs'
import { readJson, updateJson } from './store.mjs'
import { nextRun } from './when.mjs'

export { ARCHIVE_DIR }
// The page offers Return in a toast for 6 seconds; the pane closes a little after that.
export const UNDO_MS = 8000
// A close holds its claim this long (a board that died in the middle leaves it).
const CLAIM_MS = 2 * 60_000
// herdr failing to close the pane this many times calls the archive off.
const CLOSE_TRIES = 3

const safe = key => String(key).replace(/[^A-Za-z0-9_-]/g, '_')
const fileOf = key => join(ARCHIVE_DIR, `${safe(key)}.json`)
const LOG_FILE = join(ARCHIVE_DIR, 'log.jsonl')
const notFound = err => /not.?found|no such/i.test(`${err?.code} ${err?.message}`)
const lockTimeout = err => /Timed out waiting for lock/.test(err?.message ?? '')

/** The file names of the records: cheap, for the board's refresh to tell which items to look up. */
export function archivedFiles() {
  try {
    return new Set(readdirSync(ARCHIVE_DIR).filter(n => n.endsWith('.json')))
  } catch {
    return new Set()
  }
}

export const isArchived = (files, key) => files.has(`${safe(key)}.json`)

export function getArchived(key) {
  return readJson(fileOf(key))
}

/** Every record, newest first. */
export function listArchive() {
  const list = []
  for (const name of archivedFiles()) {
    const r = readJson(join(ARCHIVE_DIR, name))
    if (r?.key) list.push(r)
  }
  return list.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}

/** Change a record that exists: `change(record)` returns the new one, null to delete it, or undefined. */
function update(key, change) {
  mkdirSync(ARCHIVE_DIR, { recursive: true })
  return updateJson(fileOf(key), r => (r ? change(r) : undefined))
}

/**
 * Whether a board item stays off the board: its close is on its way, or the pane it was closed
 * in still shows for a moment (herdr's snapshot can lag the close). Seen in another pane once it
 * is archived, the session is back (resumed by Return, or by hand); one being put back shows.
 */
export const hides = (record, item) => !!record && (record.state === 'closing' || (record.state === 'archived' && record.pane === item.pane))

// ------------------------------------------------------------------ what happened, for the page

const LOG_KEEP = 60

/** { key, name, at, result: 'closed' | 'kept' | 'returned' | 'removed' | 'unrestored', why?, detail? }. */
export function logArchive(record) {
  try {
    mkdirSync(ARCHIVE_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`)
    const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
    if (lines.length > LOG_KEEP * 1.5) writeFileSync(LOG_FILE, `${lines.slice(-LOG_KEEP).join('\n')}\n`)
  } catch {}
}

/** The newest `limit` events, newest first. */
export function readArchiveLog(limit = 10) {
  try {
    return readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-limit).reverse().map(l => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

/** What the page shows of a record: no claims, the held entries as a count. */
export function publicRecord(r, { returning = false } = {}) {
  const { claim, held, tries, moved, ...rest } = r
  return { ...rest, held: (held ?? []).length, returning }
}

// ------------------------------------------------------------------ checks against herdr

const WHY = { busy: 'archive.why.working', dialog: 'archive.why.dialog', draft: 'archive.why.draft', tasks: 'archive.why.tasks', gone: 'archive.why.gone' }

/**
 * Whether the session can be closed now, from herdr itself: { ok, pane } (herdr's pane, or null
 * when it is gone already) or { ok: false, why, detail }. Claude in it must be this session and
 * free: no turn, no dialog, no text in its input box, no background command or Monitor (actions.mjs
 * readyToSleep). A shell with no Claude in it goes only as herdr-wake left a sleeping one: marked
 * 💤, nothing running in it but the shell; a Claude that exited by itself, or a program started in
 * its place, keeps the pane.
 */
export async function freeToClose(item) {
  let pane
  try {
    pane = (await herdr(['pane', 'get', item.pane]))?.pane ?? null
  } catch (err) {
    if (notFound(err)) return { ok: true, pane: null }
    return { ok: false, why: 'archive.why.herdr', detail: err.message }
  }
  if (!pane) return { ok: true, pane: null }
  if (!pane.agent) {
    if (!String(pane.label ?? '').startsWith('💤')) return { ok: false, why: 'archive.why.exited' }
    try {
      const info = (await herdr(['pane', 'process-info', '--pane', item.pane]))?.process_info
      if (info?.foreground_processes?.some(p => p.pid !== info.shell_pid)) return { ok: false, why: 'archive.why.shellBusy' }
    } catch (err) {
      return { ok: false, why: 'archive.why.herdr', detail: err.message }
    }
    return { ok: true, pane }
  }
  if (pane.agent !== 'claude' || (pane.agent_session?.value ?? null) !== (item.session ?? null)) return { ok: false, why: 'archive.why.gone' }
  const ready = await readyToSleep(item)
  if (ready.ok) return { ok: true, pane }
  return WHY[ready.why] ? { ok: false, why: WHY[ready.why] } : { ok: false, why: 'archive.why.herdr', detail: ready.why }
}

// ------------------------------------------------------------------ archiving

/**
 * Take a board item off the board: the record now, the pane `grace` ms later (closeDue). Refused
 * with { ok: false, why, detail } when the session may not go (archive-model.js, freeToClose).
 * `item.note` is what its card said last (model.mjs noteOf). by: 'user' or 'agent'; from: the
 * session that asked, when another one did. Returns { ok, record, held, dropped }: how many
 * entries wait with it, how many (a restart) were dropped.
 */
export async function askArchive(item, { by = 'user', from = null, grace = UNDO_MS, now = Date.now() } = {}) {
  const block = archiveBlock(item, listEntries())
  if (block) return { ok: false, why: block }
  const free = await freeToClose(item)
  if (!free.ok) return free
  const record = {
    key: item.key,
    session: item.session,
    name: item.name,
    autoName: item.autoName ?? '',
    category: item.category,
    cwd: item.cwd ?? '',
    workspace: item.workspace ?? '',
    workspaceId: free.pane?.workspace_id ?? '',
    pane: item.pane,
    tab: free.pane?.tab_id ?? '',
    note: item.note ?? '',
    title: item.title ?? '',
    sleeping: !!item.sleeping,
    activity: item.activity ?? 0,
    archivedAt: now,
    by,
    ...(from && { from: { key: String(from.key), name: String(from.name ?? '') } }),
    state: 'closing',
    closeAt: now + grace,
    held: [],
  }
  mkdirSync(ARCHIVE_DIR, { recursive: true })
  const made = updateJson(fileOf(item.key), taken => (taken ? undefined : record))
  if (!made) return { ok: false, why: 'archive.why.already' }
  const dropped = holdEntries(item.key)
  const saved = getArchived(item.key) ?? record
  return { ok: true, record: saved, held: (saved.held ?? []).length, dropped }
}

/**
 * The session's schedule entries into its record: each copied first, then taken out of the
 * schedule, so a board that stops in between leaves one in both at worst (putting it back finds
 * it there). A restart on its way is dropped; a report with a receipt is left where it is (it
 * keeps the session on the board, see closeOne). Returns how many were dropped.
 */
function holdEntries(key) {
  let dropped = 0
  for (const e of listEntries().filter(x => x.key === key && !x.receipt)) {
    if (e.kind === 'restart') {
      removeEntry(e.id)
      dropped++
      continue
    }
    const { claim, tried, waited, pendingSince, why, retryAt, attempts, ...entry } = e
    if (update(key, r => ({ ...r, held: [...(r.held ?? []).filter(x => x.id !== e.id), entry] }))) removeEntry(e.id)
  }
  return dropped
}

/**
 * Close the pane of every record whose time has come. Returns { closed, kept }: how many it closed,
 * how many it called off (back on the board).
 */
export async function closeDue({ log = () => {}, now = Date.now(), keys = null } = {}) {
  const out = { closed: 0, kept: 0 }
  for (const r of listArchive()) {
    if (r.state !== 'closing' || r.closeAt > now || (keys && !keys.includes(r.key))) continue
    const done = await closeOne(r.key, { log })
    if (done) out[done]++
  }
  return out
}

/** Taken for this process, unless a close of it is on its way elsewhere. */
function claim(key, now) {
  return update(key, r => {
    if (r.state !== 'closing' || r.closeAt > now) return undefined
    if (r.claim && r.claim.pid !== process.pid && now - r.claim.at < CLAIM_MS) return undefined
    return { ...r, claim: { pid: process.pid, at: now } }
  })
}

/** 'closed', 'kept' (called off), or null (not now: claimed elsewhere, or herdr is tried again). */
async function closeOne(key, { log }) {
  const r = claim(key, Date.now())
  if (!r) return null
  // Entries set for it while it was on its way wait in the record too; a MokuPilot report that
  // came for it meanwhile keeps it on the board, to be delivered.
  holdEntries(key)
  if (listEntries().some(e => e.key === key && e.receipt)) return keep(r, 'archive.why.report', '', log)
  const free = await freeToClose(r)
  if (!free.ok) {
    // herdr not answering is tried again; the session itself not being free calls it off.
    if (free.why === 'archive.why.herdr') return retry(r, free.detail, log)
    return keep(r, free.why, free.detail, log)
  }
  if (free.pane) {
    try {
      // The tab goes when nothing else is in it, else the pane alone. Another plugin's panel beside
      // it (herdr-sidebar's: no agent, the plugin's own metadata tokens) is nothing else; an agent
      // or a plain shell (a server, the user's own) is.
      const panes = ((await herdr(['pane', 'list', '--workspace', free.pane.workspace_id]))?.panes ?? []).filter(p => p.tab_id === free.pane.tab_id)
      const others = panes.filter(p => p.pane_id !== r.pane && (p.agent || !Object.keys(p.tokens ?? {}).length))
      if (!others.length && free.pane.tab_id) await herdr(['tab', 'close', free.pane.tab_id])
      else await herdr(['pane', 'close', r.pane])
    } catch (err) {
      if (!notFound(err)) return retry(r, err.message, log)
    }
    // Archived only once the pane is gone: one still there would stay hidden, and Return would
    // start a second Claude beside it.
    try {
      await herdr(['pane', 'get', r.pane])
      return retry(r, 'its pane is still there', log)
    } catch (err) {
      if (!notFound(err)) return retry(r, err.message, log)
    }
  }
  update(key, rec => {
    const { claim: c, tries, ...rest } = rec
    return { ...rest, state: 'archived', closedAt: Date.now() }
  })
  logArchive({ key, name: r.name, at: Date.now(), result: 'closed' })
  log(`archive ${r.name}: closed ${free.pane ? r.pane : '(its pane was gone already)'}`)
  return 'closed'
}

/** herdr failed: tried again on the next tick, CLOSE_TRIES times in all, then called off. */
function retry(r, detail, log) {
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
function keep(r, why, detail, log) {
  update(r.key, rec => {
    const { claim: c, ...rest } = rec
    return { ...rest, state: 'restoring' }
  })
  putBack(r.key)
  logArchive({ key: r.key, name: r.name, at: Date.now(), result: 'kept', why, ...(detail && { detail }) })
  log(`archive ${r.name}: kept on the board (${why}${detail ? `: ${detail}` : ''})`)
  return 'kept'
}

/**
 * A record marked `restoring`: its entries back into the schedule, then the record gone. Entries
 * that could not go back yet (a lock held too long) stay in it for the next try. `where`: the
 * session's pane and folder now, when it came back in another pane. Returns whether it is done.
 */
function putBack(key, where = {}) {
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
 * is there already.
 */
function restoreHeld(r, where = {}) {
  const now = Date.now()
  const left = []
  for (const e of r.held ?? []) {
    let next = e.next
    if (e.cron && next < now) {
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
      else logArchive({ key: r.key, name: r.name, at: now, result: 'unrestored', detail: `${e.id}: ${err.message}` })
    }
  }
  return left
}

// ------------------------------------------------------------------ Return, and dropping a record

/**
 * Return: { ok, back: true, name } when its pane had not closed yet (the card is back as it was),
 * { ok, resume: record } when the session is to be resumed in a new tab (the record now says a
 * Return is on its way; the caller starts it and gives its launch with markReturning), { ok,
 * again: true, name } when one is on its way already (`busy(returning)` says whether the one the
 * record names still is), { ok: false, wait: true } while its pane is being closed right now, {
 * ok: false, gone: true } without a record. All of it decided under the record's lock, so two
 * Returns at once never start two sessions.
 */
export function takeBack(key, { busy = () => false, now = Date.now() } = {}) {
  let out = { ok: false, gone: true }
  let back = false
  update(key, r => {
    if (r.state === 'restoring') {
      out = { ok: true, back: true, name: r.name }
      return undefined
    }
    if (r.state === 'closing') {
      if (r.claim && now - r.claim.at < CLAIM_MS) {
        out = { ok: false, wait: true }
        return undefined
      }
      back = true
      out = { ok: true, back: true, name: r.name }
      return { ...r, state: 'restoring' }
    }
    if (r.returning && busy(r.returning)) {
      out = { ok: true, again: true, name: r.name }
      return undefined
    }
    const next = { ...r, returning: { at: now, launch: null } }
    out = { ok: true, resume: next }
    return next
  })
  if (back) {
    putBack(key)
    logArchive({ key, name: out.name, at: now, result: 'returned' })
  }
  return out
}

/** The resume of it started (its launch's id), or failed to (null: Return can be tried again). */
export function markReturning(key, launch) {
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
export function settleReturned(item) {
  let r = null
  let fresh = false
  update(item.key, rec => {
    if (rec.state === 'restoring') {
      r = rec
      return undefined
    }
    if (rec.state !== 'archived' || rec.pane === item.pane) return undefined
    r = { ...rec, state: 'restoring', moved: true }
    fresh = true
    return r
  })
  if (!r) return false
  if (fresh) logArchive({ key: r.key, name: r.name, at: Date.now(), result: 'returned' })
  return putBack(item.key, r.moved ? { pane: item.pane, cwd: item.cwd } : {})
}

/**
 * "Remove from archive": the record and the session's card go (and the context fill the status
 * line kept), with the entries that waited in it. Claude's transcript stays where it is. A record
 * whose pane is still to close, or that is being put back, is not removed.
 */
export function forgetArchived(key) {
  let r = null
  let out = { ok: false, gone: true }
  update(key, rec => {
    if (rec.state === 'closing') {
      out = { ok: false, closing: true }
      return undefined
    }
    if (rec.state !== 'archived') return undefined
    r = rec
    out = { ok: true, record: rec }
    return null
  })
  if (!r) return out
  for (const file of [join(CARDS_DIR, `${safe(key)}.json`), join(CONTEXT_DIR, `${safe(key)}.json`)]) {
    try {
      unlinkSync(file)
    } catch {}
  }
  logArchive({ key, name: r.name, at: Date.now(), result: 'removed' })
  return out
}
