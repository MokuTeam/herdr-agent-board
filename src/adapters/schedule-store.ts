// The schedule: reminders (one-off) and repeating pings (cron) that agents, or the user, set for
// a session; services/scheduler.ts sends them. One small JSON file per entry, written like the cards
// (json-store.ts): a lock around read, change, rename, so the scheduler marking a run and an agent
// cancelling the entry at the same moment cannot bring a cancelled entry back. log.jsonl keeps
// what was sent and what was missed, for the web board.
//
// An entry: { id, key (the session's card key), name, pane, cwd, text, at (one-off) | cron, next
// (when it is due), created, by, from (the session that set it: { key, name }), kind ('call': a
// MokuPilot call's results, `board call-report`; 'restart': the session restarted once it is
// free, `board restart` or the web board, the text its note for after; 'sleep': the session put
// to sleep once it is free, `board sleep --when-free`; a reminder without one) }
// plus the scheduler's own fields: runs, missed, lastRun, gone (runs missed in a row with the
// session gone), movedFrom (the session it was for before /clear), and while it waits for a busy
// session pendingSince, waited, tried, why; claim while a run is on its way. A restart also keeps
// step ('sleep', 'wake', 'note': how far it got), attempts and retryAt (herdr-wake refused or
// failed), tasksSince (background tasks hold it) and failed (it gave up, why: only that note is
// left to type). A retry-safe call report carries its receipt's identity (receipt:
// call-receipts.ts); its file is written 0600, and the receipt is settled when the entry goes.
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanName,
  cleanText,
  MAX_PER_SESSION,
  MAX_REPORT,
  MAX_TEXT,
  type ScheduleEntry,
  type SessionRef,
} from '../core/schedule-rules.ts'
import { type ReceiptState, settleReport } from './call-receipts.ts'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { scheduleDir } from './paths.ts'

const logFile = (): string => join(scheduleDir(), 'log.jsonl')
const ID = /^[0-9a-f]{6}$/
const fileOf = (id: string): string => join(scheduleDir(), `${id}.json`)

const isEntry = (v: unknown): v is ScheduleEntry =>
  isRecord(v) &&
  typeof v.id === 'string' &&
  !!v.id &&
  typeof v.key === 'string' &&
  !!v.key &&
  typeof v.next === 'number'

/** What a new entry is made of: the caller's fields; the id and creation time are added here. */
export type NewEntry = {
  key: string
  text: string
  next: number
  name?: string
  pane?: string
  cwd?: string
  at?: number
  cron?: string
  by?: string
  from?: SessionRef
  [extra: string]: unknown
}

/** Every entry, soonest first. */
export function listEntries(): ScheduleEntry[] {
  let names: string[]
  try {
    names = readdirSync(scheduleDir())
  } catch {
    return []
  }
  const list: ScheduleEntry[] = []
  for (const name of names) {
    if (!/^[0-9a-f]{6}\.json$/.test(name)) continue
    const e = readJson(join(scheduleDir(), name), isEntry)
    if (e) list.push(e)
  }
  return list.sort((a, b) => a.next - b.next || (a.created ?? 0) - (b.created ?? 0))
}

export function getEntry(id: unknown): ScheduleEntry | null {
  return ID.test(String(id)) ? readJson(fileOf(String(id)), isEntry) : null
}

/** Save a new entry under a fresh id and return it. */
export function addEntry(fields: NewEntry): ScheduleEntry {
  mkdirSync(scheduleDir(), { recursive: true })
  if (listEntries().filter(e => e.key === fields.key).length >= MAX_PER_SESSION) {
    throw new Error(`this session has ${MAX_PER_SESSION} entries already; remove some first (board unschedule <id>)`)
  }
  const clean = {
    ...fields,
    text: cleanText(fields.text, fields.kind === 'call' ? MAX_REPORT : MAX_TEXT),
    name: cleanName(fields.name),
    ...(fields.from ? { from: { key: String(fields.from.key), name: cleanName(fields.from.name) } } : {}),
  }
  for (;;) {
    const id = randomBytes(3).toString('hex')
    const entry = updateJson(
      fileOf(id),
      (taken: ScheduleEntry | null) => (taken ? undefined : { id, ...clean, created: Date.now() }),
      isEntry,
      fields.receipt ? { mode: 0o600 } : undefined,
    )
    if (entry) return entry
  }
}

/**
 * Put back an entry that waited with an archived session (services/archive.ts): under its own id
 * when that is free, so `board unschedule <id>` still finds it, else under a new one. One there
 * under its id already, for the same session with the same text (left by a board that stopped
 * between copying and removing it), is not doubled. Returns the entry.
 */
export function restoreEntry(entry: ScheduleEntry): ScheduleEntry {
  mkdirSync(scheduleDir(), { recursive: true })
  const { id, created, ...fields } = entry
  if (ID.test(String(id))) {
    const seen: { there: ScheduleEntry | null } = { there: null }
    const back = updateJson(
      fileOf(id),
      (taken: ScheduleEntry | null) => {
        seen.there = taken
        return taken ? undefined : { id, ...fields, created: created ?? Date.now() }
      },
      isEntry,
    )
    if (back) return back
    if (seen.there?.key === fields.key && seen.there?.text === fields.text) return seen.there
  }
  return addEntry(fields)
}

/** Who asks for a restart of which session (`by`: 'agent' or 'user'), and the note for after it. */
export type RestartAsk = {
  key: string
  name?: string
  pane?: string
  cwd?: string
  text?: string
  by: string
  from?: SessionRef
}

/**
 * A restart of the session `fields.key`, once it is free: the one already asked for (its note
 * replaced by a new one, when given), else a new entry, due now. One that gave up and still has to
 * say so is dropped: the new restart is the news. An agent asking for one the user asked for takes
 * it over, so it hears how it went. Returns { entry, again }.
 */
export function askRestart(fields: RestartAsk): { entry: ScheduleEntry; again: boolean } {
  const now = Date.now()
  const text = cleanText(fields.text)
  const mine = listEntries().filter(e => e.kind === 'restart' && e.key === fields.key)
  for (const e of mine) if (e.failed) removeEntry(e.id)
  const pending = mine.find(e => !e.failed)
  const from = fields.from && { key: String(fields.from.key), name: cleanName(fields.from.name) }
  const again =
    pending &&
    updateEntry(pending.id, e => {
      if (e.failed) return undefined
      const next: ScheduleEntry = { ...e, ...(text && { text }) }
      // An agent takes it over: by it, and from whoever asked now (no one else: from goes).
      if (fields.by === 'agent') {
        next.by = 'agent'
        if (from) next.from = from
        else delete next.from
      }
      return next
    })
  if (again) return { entry: again, again: true }
  return { entry: addEntry({ ...fields, kind: 'restart', idle: true, text, at: now, next: now }), again: false }
}

/**
 * The session `fields.key` put to sleep once it is free (`board sleep --when-free`): the one asked
 * for already, else a new entry of kind 'sleep', due now. `moveTo` (`board move --when-free`, #250):
 * then moved to that profile; the one asked for already takes it. Returns { entry, again }.
 */
export function askSleep(fields: Omit<RestartAsk, 'text'> & { moveTo?: string }): {
  entry: ScheduleEntry
  again: boolean
} {
  const pending = listEntries().find(e => e.kind === 'sleep' && e.key === fields.key)
  if (pending) {
    const moved = fields.moveTo ? updateEntry(pending.id, e => ({ ...e, moveTo: fields.moveTo })) : null
    return { entry: moved ?? pending, again: true }
  }
  const now = Date.now()
  return { entry: addEntry({ ...fields, kind: 'sleep', idle: true, text: '', at: now, next: now }), again: false }
}

/** Change an entry that still exists: `change(entry)` returns the new entry or undefined. */
export function updateEntry(
  id: unknown,
  change: (entry: ScheduleEntry) => ScheduleEntry | undefined,
): ScheduleEntry | null | undefined {
  if (!ID.test(String(id))) return undefined
  mkdirSync(scheduleDir(), { recursive: true }) // the lock lives next to the file
  return updateJson(
    fileOf(String(id)),
    (entry: ScheduleEntry | null) => (entry ? change(entry) : undefined),
    isEntry,
    getEntry(id)?.receipt ? { mode: 0o600 } : undefined,
  )
}

/**
 * Delete an entry; returns it, or null when there was none. A call report's receipt is settled
 * first (`receiptState`: cancelled, or missed when the scheduler gave up waiting): one on its way
 * becomes of unknown delivery, one done keeps its state (call-receipts.ts settleReport).
 */
export function removeEntry(id: unknown, receiptState: ReceiptState = 'cancelled'): ScheduleEntry | null {
  let removed: ScheduleEntry | null = null
  if (!ID.test(String(id))) return null
  mkdirSync(scheduleDir(), { recursive: true })
  const existing = getEntry(id)
  if (existing?.receipt) settleReport(existing, receiptState)
  updateJson(
    fileOf(String(id)),
    (entry: ScheduleEntry | null) => {
      removed = entry
      return entry ? null : undefined
    },
    isEntry,
  )
  return removed
}

// The log is appended to by the scheduler only; it is cut back to the newest runs now and then.
const LOG_KEEP = 200

export function logRun(record: unknown): void {
  try {
    mkdirSync(scheduleDir(), { recursive: true })
    appendFileSync(logFile(), `${JSON.stringify(record)}\n`)
    const lines = readFileSync(logFile(), 'utf8').split('\n').filter(Boolean)
    if (lines.length > LOG_KEEP * 1.5) writeFileSync(logFile(), `${lines.slice(-LOG_KEEP).join('\n')}\n`)
  } catch {}
}

/** The newest `limit` runs, newest first. */
export function readLog(limit = 30): unknown[] {
  try {
    return readFileSync(logFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .map((line): unknown => {
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
