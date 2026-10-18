// The rules of the schedule that need no files: what an entry may hold, what the session is told
// when one is due, and which session an entry is for. Storage is src/adapters/schedule-store.ts, sending is
// src/services/scheduler.ts.
import { t } from './lang.ts'
import { CALL_NOTE } from './notices.ts'
import type { Item } from './types.ts'
import { countRuns } from './when.ts'
import { longWhen, span } from './when-format.ts'

// Enough for any real use; an agent stuck in a loop cannot fill the disk.
export const MAX_PER_SESSION = 30
export const MAX_TEXT = 2000
// A call's results (kind 'call') are a short report, not a one-line reminder.
export const MAX_REPORT = 16_000
// Later than this, the prompt says by how much.
const LATE_MS = 2 * 60_000

/** The session an entry was set by, or the one it was for before /clear. */
export type SessionRef = { key: string; name: string }

/**
 * An entry: one-off (`at`) or repeating (`cron`), `next` when it is due; plus the scheduler's own
 * fields (runs, missed, lastRun, gone, pendingSince, claim, ...), which pass through untouched.
 */
export type ScheduleEntry = {
  id: string
  key: string
  text: string
  next: number
  name?: string
  pane?: string
  cwd?: string
  at?: number
  cron?: string
  created?: number
  by?: string
  from?: SessionRef
  movedFrom?: SessionRef
  /** 'call': a MokuPilot call's results (`board call-report`); a reminder without one. */
  kind?: string
  [extra: string]: unknown
}

// The text is typed into a terminal: no control characters (an escape could drive the pane).
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g
export const cleanText = (s: unknown, max = MAX_TEXT): string =>
  String(s ?? '')
    .replace(CONTROL, '')
    .slice(0, max)
// A name goes into the prompt's tag: no brackets either.
export const cleanName = (s: unknown): string =>
  String(s ?? '')
    .replace(CONTROL, '')
    .replace(/[[\]]/g, '')
    .trim()
    .slice(0, 60)

/**
 * What the session gets: "[board reminder] text", with a note when it is late or stands for
 * several runs. A MokuPilot call's results (kind 'call') come as "[mokupilot call report]", the
 * report on lines of its own, and a closing note that they are for its information.
 */
export function promptOf(entry: ScheduleEntry, now: number): string {
  const notes: string[] = []
  if (entry.cron) {
    const runs = countRuns(entry.cron, entry.next, now)
    if (runs > 1) notes.push(t('sched.prompt.runs', { n: runs, since: longWhen(entry.next, t, now) }))
  } else if (now - entry.next > LATE_MS) {
    notes.push(t('sched.prompt.late', { late: span(now - entry.next, t), due: longWhen(entry.next, t, now) }))
  }
  // Set by another session, or for the one this pane held before /clear: the receiver judges it.
  const before = entry.movedFrom
  const setter =
    entry.from && entry.from.key !== (before?.key ?? entry.key) ? entry.from.name || entry.from.key.slice(0, 8) : ''
  if (before)
    notes.push(
      t(setter ? 'sched.prompt.clearedFor' : 'sched.prompt.cleared', { name: before.name || before.key.slice(0, 8) }),
    )
  // The tag stays in English: the hook knows a board prompt by it (entrypoints/hook.ts).
  const from = setter ? ` from ${setter}` : ''
  if (entry.kind === 'call')
    return `[mokupilot call report${notes.length ? `; ${notes.join('; ')}` : ''}]\n${entry.text}\n\n${CALL_NOTE}`
  const tag = entry.cron ? `board schedule ${entry.id}${from}: ${entry.cron}` : `board reminder${from}`
  return `[${tag}${notes.length ? `; ${notes.join('; ')}` : ''}] ${entry.text}`
}

const folder = (p: unknown): string =>
  String(p ?? '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()

/**
 * The session an entry is for: by its id, else the Claude session now in its pane and folder.
 * /clear gives a session a new id in the same pane; the reminder follows it there.
 * Returns undefined when there is none (as before the port).
 */
export function targetOf(entry: ScheduleEntry, items: Item[]): Item | undefined {
  const own = items.find(i => i.key === entry.key)
  if (own || !entry.pane || !entry.cwd) return own
  return items.find(i => i.pane === entry.pane && i.session && !i.sleeping && folder(i.cwd) === folder(entry.cwd))
}
