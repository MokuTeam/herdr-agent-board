// The schedule: reminders (one-off) and repeating pings (cron) that agents, or the user, set for
// a session; scheduler.mjs sends them. One small JSON file per entry, written like the cards
// (store.mjs): a lock around read, change, rename, so the scheduler marking a run and an agent
// cancelling the entry at the same moment cannot bring a cancelled entry back. log.jsonl keeps
// what was sent and what was missed, for the web board.
//
// An entry: { id, key (the session's card key), name, pane, cwd, text, at (one-off) | cron, next
// (when it is due), created, by, from (the session that set it: { key, name }), kind ('call': a
// MokuPilot call's results, `board call-report`; 'restart': the session restarted once it is
// free, `board restart` or the web board, the text its note for after; a reminder without one) }
// plus the scheduler's own fields: runs, missed, lastRun, gone (runs missed in a row with the
// session gone), movedFrom (the session it was for before /clear), and while it waits for a busy
// session pendingSince, waited, tried, why; claim while a run is on its way. A restart also keeps
// step ('sleep', 'wake', 'note': how far it got), attempts and retryAt (herdr-wake refused or
// failed), tasksSince (background tasks hold it) and failed (it gave up, why: only that note is
// left to type).
import { settleReport } from './call-receipts.mjs'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCHEDULE_DIR } from './paths.mjs'
import { readJson, updateJson } from './store.mjs'

export { SCHEDULE_DIR }
const LOG_FILE = join(SCHEDULE_DIR, 'log.jsonl')
const ID = /^[0-9a-f]{6}$/
const fileOf = id => join(SCHEDULE_DIR, `${id}.json`)
// Enough for any real use; an agent stuck in a loop cannot fill the disk.
export const MAX_PER_SESSION = 30
export const MAX_TEXT = 2000
// A call's results (kind 'call') are a short report, not a one-line reminder.
export const MAX_REPORT = 16_000

/** Every entry, soonest first. */
export function listEntries() {
  let names = []
  try {
    names = readdirSync(SCHEDULE_DIR)
  } catch {
    return []
  }
  const list = []
  for (const name of names) {
    if (!/^[0-9a-f]{6}\.json$/.test(name)) continue
    const e = readJson(join(SCHEDULE_DIR, name))
    if (e?.id && e.key && typeof e.next === 'number') list.push(e)
  }
  return list.sort((a, b) => a.next - b.next || a.created - b.created)
}

export function getEntry(id) {
  return ID.test(String(id)) ? readJson(fileOf(id)) : null
}

// The text is typed into a terminal: no control characters (an escape could drive the pane).
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g
export const cleanText = (s, max = MAX_TEXT) => String(s ?? '').replace(CONTROL, '').slice(0, max)
// A name goes into the prompt's tag: no brackets either.
export const cleanName = s => String(s ?? '').replace(CONTROL, '').replace(/[[\]]/g, '').trim().slice(0, 60)

/** Save a new entry under a fresh id and return it. */
export function addEntry(fields) {
  mkdirSync(SCHEDULE_DIR, { recursive: true })
  if (listEntries().filter(e => e.key === fields.key).length >= MAX_PER_SESSION) {
    throw new Error(`this session has ${MAX_PER_SESSION} entries already; remove some first (board unschedule <id>)`)
  }
  const clean = {
    ...fields,
    text: cleanText(fields.text, fields.kind === 'call' ? MAX_REPORT : MAX_TEXT),
    name: cleanName(fields.name),
    ...(fields.from && { from: { key: String(fields.from.key), name: cleanName(fields.from.name) } }),
  }
  for (;;) {
    const id = randomBytes(3).toString('hex')
    const entry = updateJson(fileOf(id), taken => (taken ? undefined : { id, ...clean, created: Date.now() }), clean.receipt ? { mode: 0o600 } : undefined)
    if (entry) return entry
  }
}

/**
 * A restart of the session `fields.key`, once it is free: the one already asked for (its note
 * replaced by a new one, when given), else a new entry, due now. One that gave up and still has to
 * say so is dropped: the new restart is the news. An agent asking for one the user asked for takes
 * it over, so it hears how it went. Returns { entry, again }.
 */
export function askRestart(fields) {
  const now = Date.now()
  const text = cleanText(fields.text)
  const mine = listEntries().filter(e => e.kind === 'restart' && e.key === fields.key)
  for (const e of mine) if (e.failed) removeEntry(e.id)
  const pending = mine.find(e => !e.failed)
  const over = fields.by === 'agent' ? { by: 'agent', from: fields.from && { key: String(fields.from.key), name: cleanName(fields.from.name) } } : {}
  const again = pending && updateEntry(pending.id, e => (e.failed ? undefined : { ...e, ...(text && { text }), ...over }))
  if (again) return { entry: again, again: true }
  return { entry: addEntry({ ...fields, kind: 'restart', idle: true, text, at: now, next: now }), again: false }
}

/** Change an entry that still exists: `change(entry)` returns the new entry or undefined. */
export function updateEntry(id, change) {
  if (!ID.test(String(id))) return undefined
  mkdirSync(SCHEDULE_DIR, { recursive: true }) // the lock lives next to the file
  return updateJson(fileOf(id), entry => (entry ? change(entry) : undefined), getEntry(id)?.receipt ? { mode: 0o600 } : undefined)
}

/** Delete an entry; returns it, or null when there was none. */
export function removeEntry(id, receiptState = 'cancelled') {
  let removed = null
  if (!ID.test(String(id))) return null
  mkdirSync(SCHEDULE_DIR, { recursive: true })
  const existing = getEntry(id)
  if (existing?.receipt) settleReport(existing, receiptState)
  updateJson(fileOf(id), entry => {
    removed = entry
    return entry ? null : undefined
  })
  return removed
}

// The log is appended to by the scheduler only; it is cut back to the newest runs now and then.
const LOG_KEEP = 200

export function logRun(record) {
  try {
    mkdirSync(SCHEDULE_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`)
    const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
    if (lines.length > LOG_KEEP * 1.5) writeFileSync(LOG_FILE, `${lines.slice(-LOG_KEEP).join('\n')}\n`)
  } catch {}
}

/** The newest `limit` runs, newest first. */
export function readLog(limit = 30) {
  try {
    return readFileSync(LOG_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}
