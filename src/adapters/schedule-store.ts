// The schedule: reminders (one-off) and repeating pings (cron) that agents, or the user, set for
// a session; scheduler.mjs sends them. One small JSON file per entry, written like the cards
// (json-store.ts): a lock around read, change, rename, so the scheduler marking a run and an agent
// cancelling the entry at the same moment cannot bring a cancelled entry back. log.jsonl keeps
// what was sent and what was missed, for the web board.
//
// An entry: { id, key (the session's card key), name, pane, cwd, text, at (one-off) | cron, next
// (when it is due), created, by, from (the session that set it: { key, name }) } plus the
// scheduler's own fields: runs, missed, lastRun, gone (runs missed in a row with the session gone),
// movedFrom (the session it was for before /clear), and while it waits for a busy session
// pendingSince, waited, tried, why; claim while a run is on its way.
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanName, cleanText, MAX_PER_SESSION, type ScheduleEntry, type SessionRef } from '../core/schedule-rules.ts'
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
    text: cleanText(fields.text),
    name: cleanName(fields.name),
    ...(fields.from ? { from: { key: String(fields.from.key), name: cleanName(fields.from.name) } } : {}),
  }
  for (;;) {
    const id = randomBytes(3).toString('hex')
    const entry = updateJson(
      fileOf(id),
      (taken: ScheduleEntry | null) => (taken ? undefined : { id, ...clean, created: Date.now() }),
      isEntry,
    )
    if (entry) return entry
  }
}

/** Change an entry that still exists: `change(entry)` returns the new entry or undefined. */
export function updateEntry(
  id: unknown,
  change: (entry: ScheduleEntry) => ScheduleEntry | undefined,
): ScheduleEntry | null | undefined {
  if (!ID.test(String(id))) return undefined
  mkdirSync(scheduleDir(), { recursive: true }) // the lock lives next to the file
  return updateJson(fileOf(String(id)), (entry: ScheduleEntry | null) => (entry ? change(entry) : undefined), isEntry)
}

/** Delete an entry; returns it, or null when there was none. */
export function removeEntry(id: unknown): ScheduleEntry | null {
  let removed: ScheduleEntry | null = null
  if (!ID.test(String(id))) return null
  mkdirSync(scheduleDir(), { recursive: true })
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
