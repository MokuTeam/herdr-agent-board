// The rules of the schedule that need no files: what an entry may hold, what the session is told
// when one is due, and which session an entry is for. Storage is src/adapters/schedule-store.ts, sending is
// src/services/scheduler.ts.
import { t } from './lang.ts'
import { parseNodeKey } from './node-key.ts'
import { CALL_NOTE } from './notices.ts'
import { TURN_RESUME_KIND } from './turn-resume.ts'
import type { Item } from './types.ts'
import { formatPrompt, type RouteItem } from './wake/route.ts'
import { countRuns } from './when.ts'
import { longWhen, span } from './when-format.ts'

// Enough for any real use; an agent stuck in a loop cannot fill the disk.
export const MAX_PER_SESSION = 30
export const MAX_TEXT = 2000
// A call's results (kind 'call') are a short report, not a one-line reminder.
export const MAX_REPORT = 16_000
// Later than this, the prompt says by how much.
const LATE_MS = 2 * 60_000
/** Why a master entry for a node session is held without expiring (#695). */
export const NODE_OFFLINE_WHY = 'node-offline'

/** Master schedule entries held while each device is offline (#695), keyed by device id. */
export function heldByDevice(entries: readonly { key: string; why?: unknown }[]): Record<string, number> {
  const counts = Object.create(null) as Record<string, number>
  for (const e of entries) {
    if (e.why !== NODE_OFFLINE_WHY) continue
    const at = parseNodeKey(e.key)
    if (!at) continue
    counts[at.device] = (counts[at.device] ?? 0) + 1
  }
  return counts
}

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
  /**
   * 'call': a MokuPilot call's results (`board call-report`); 'restart': the session restarted
   * once it is free (`board restart` or the web board), the text its note for after; 'sleep': the
   * session put to sleep once it is free (`board sleep --when-free`), no text; 'turn-resume': one
   * continue after a crash or reboot (#633); a reminder without one. A restart also keeps step
   * ('sleep', 'wake', 'note': how far it got), attempts and retryAt (herdr-wake refused or failed),
   * tasksSince (background tasks hold it) and failed (it gave up, why: only that note is left to
   * type), among the extra fields.
   */
  kind?: string
  /**
   * A retry-safe call report's identity ({ key, session, reportId, hash }: `board call-report
   * --report-id`), narrowed where it is read (adapters/call-receipts.ts).
   */
  receipt?: unknown
  /**
   * A SendMessage from a session of another profile (#251, entrypoints/wake-hook.ts): its profile's
   * title, and the name with its ref an answer goes to ('' when no answer can come back that way).
   */
  fromProfile?: string
  replyTo?: string
  /**
   * A message sent through the board (#619, core/agent-send.ts): answered with `board send` to
   * `replyTo`; `fromDevice` names the computer it came from when that is not the receiver's.
   */
  replyBy?: 'board'
  fromDevice?: string
  /**
   * A sleeping session is not woken for it: it waits until the session is awake (a thread's event,
   * services/work-threads.ts; services/scheduler.ts).
   */
  noWake?: boolean
  /** In the master's payload, an entry of another device's session (#500): its id and key carry the device's prefix. */
  device?: string
  /**
   * Owner thread post(s) carried by this event (#693): if delivery fails past the wait, the
   * scheduler records a private system notice on each named thread so it never passes silently.
   */
  ownerPosts?: { thread: string; key: string; target: SessionRef; seq?: number }[]
  /** Telegram messages held for an offline node (#701), formatted with queued_at on delivery. */
  telegramItems?: RouteItem[]
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

/** Strips terminal control characters and bounds total size of held Telegram items (#701). */
export function cleanTelegramItems(items: readonly RouteItem[], maxTotal = 48_000): RouteItem[] {
  let remaining = maxTotal
  const out: RouteItem[] = []
  for (const it of items) {
    if (remaining <= 0) break
    const text = cleanText(it.text, remaining)
    remaining -= text.length
    const cleanMeta: Record<string, string | undefined> | undefined = it.meta
      ? Object.fromEntries(
          Object.entries(it.meta).map(([k, v]) => [k, v === undefined ? undefined : cleanText(v, 512)]),
        )
      : undefined
    out.push({
      ...it,
      key: cleanText(it.key, 512),
      text,
      ...(it.topic !== undefined && { topic: cleanText(it.topic, 512) }),
      ...(it.pane !== undefined && { pane: cleanText(it.pane, 256) }),
      ...(it.queued_at !== undefined && { queued_at: cleanText(it.queued_at, 64) }),
      ...(cleanMeta !== undefined && { meta: cleanMeta }),
    })
  }
  return out
}

/**
 * What the session gets: "[board reminder] text", with a note when it is late or stands for
 * several runs. A MokuPilot call's results (kind 'call') come as "[mokupilot call report]", the
 * report on lines of its own, and a closing note that they are for its information.
 */
export function promptOf(entry: ScheduleEntry, now: number): string {
  if (entry.kind === 'telegram') {
    if (Array.isArray(entry.telegramItems) && entry.telegramItems.length) return formatPrompt(entry.telegramItems, now)
    return entry.text
  }
  if (entry.kind === 'restart') return restartPrompt(entry)
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
  // A SendMessage from another profile's session (#251, entrypoints/wake-hook.ts): how to answer it.
  if (setter && typeof entry.fromProfile === 'string')
    notes.unshift(
      entry.replyTo
        ? t('sched.prompt.message', { profile: entry.fromProfile, name: entry.replyTo })
        : t('sched.prompt.messageNoReply', { profile: entry.fromProfile }),
    )
  // A message through the board (#619, core/agent-send.ts): answered the same way, from any computer.
  else if (setter && entry.replyBy === 'board' && typeof entry.replyTo === 'string' && entry.replyTo)
    notes.unshift(
      typeof entry.fromDevice === 'string' && entry.fromDevice
        ? t('sched.prompt.sendFrom', { device: entry.fromDevice, name: entry.replyTo })
        : t('sched.prompt.send', { name: entry.replyTo }),
    )
  // The tag stays in English: the hook knows a board prompt by it (entrypoints/hook.ts).
  const from = setter ? ` from ${setter}` : ''
  if (entry.kind === 'call')
    return `[mokupilot call report${notes.length ? `; ${notes.join('; ')}` : ''}]\n${entry.text}\n\n${CALL_NOTE}`
  const tag = entry.cron ? `board schedule ${entry.id}${from}: ${entry.cron}` : `board reminder${from}`
  return `[${tag}${notes.length ? `; ${notes.join('; ')}` : ''}] ${entry.text}`
}

/**
 * After a restart, "[board reminder; restarted ...] <its note>": who asked (the session itself,
 * another one, the user), and the note for after it. One that did not happen says why. Late
 * means nothing here, and a restart never moves to another session (targetOf).
 */
function restartPrompt(entry: ScheduleEntry): string {
  const setter = entry.from && entry.from.key !== entry.key ? entry.from.name || entry.from.key.slice(0, 8) : ''
  // The tag stays in English: the hook knows a board prompt by it (entrypoints/hook.ts).
  const from = setter ? ` from ${setter}` : ''
  const failed = typeof entry.failed === 'string' ? entry.failed : ''
  if (failed)
    return `[board reminder${from}] ${t('sched.prompt.restartFailed', { why: failed })}${entry.text ? ` ${t('sched.prompt.restartNote', { text: entry.text })}` : ''}`
  const by = entry.by === 'user' ? 'User' : setter ? 'Other' : ''
  return `[board reminder${from}; ${t(`sched.prompt.restarted${by}`)}] ${entry.text || t(`sched.prompt.restartText${by === 'User' ? 'User' : ''}`)}`
}

const folder = (p: unknown): string =>
  String(p ?? '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()

/**
 * The session an entry is for (`item`): by its id, else the Claude session now in its pane and
 * folder, when that one runs in the profile the entry's session ran in (`profileOf`: a session's
 * profile id by its key, undefined when not known). /clear gives a session a new id in the same
 * pane and the same Claude, so the same profile; the reminder follows it there. A session there
 * in another profile, or one where either profile is not known, is never followed into (it would
 * be reminded in the wrong account): it comes back as `other`, so the entry waits saying why.
 * Neither when there is none (as before the port). A retry-safe call report (`receipt`), a
 * turn-resume continue (`turn-resume`), a restart or a sleep never follows: the session after
 * /clear, or another one started in that pane, is not the one it was asked for.
 */
export function targetOf(
  entry: ScheduleEntry,
  items: Item[],
  profileOf: (key: string) => string | undefined,
): { item?: Item; other?: Item } {
  const own = items.find(i => i.key === entry.key)
  if (own) return { item: own }
  if (
    entry.receipt ||
    entry.kind === 'restart' ||
    entry.kind === 'sleep' ||
    entry.kind === TURN_RESUME_KIND ||
    !entry.pane ||
    !entry.cwd
  )
    return {}
  const next = items.find(i => i.pane === entry.pane && i.session && !i.sleeping && folder(i.cwd) === folder(entry.cwd))
  if (!next) return {}
  const was = profileOf(entry.key)
  return was !== undefined && was === profileOf(next.key) ? { item: next } : { other: next }
}
