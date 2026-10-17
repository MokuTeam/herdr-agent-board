// What the schedule panel shows (web/app.js renderSchedule, entryHTML, logHTML, pendingText): the
// entries due and waiting for their session first, then by day, soonest first (the server sorts
// them); each one's time, session, text, counts and why it waits; then what was sent or missed
// lately. Times are against the board's clock `now`.
import type { ScheduleEntry } from '../../../src/core/schedule-rules.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import { capital, dayLabel, longWhen, shortWhen, span, timeOf } from '../../../src/core/when-format.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A due entry waits for its session until it can go. */
export const overdue = (e: Pick<ScheduleEntry, 'next'>, now: number): boolean => e.next <= now

export interface ScheduleGroup {
  title: string
  /** Each entry with its time as the group words it ("Fri 9:00" while it waits, else "9:00"). */
  entries: { entry: ScheduleEntry; time: string }[]
}

/** Due ones that wait for their session first, then by day. */
export function scheduleGroups(list: ScheduleEntry[], now: number, t: Translator): ScheduleGroup[] {
  const groups: ScheduleGroup[] = []
  const waiting = list.filter(e => overdue(e, now))
  if (waiting.length)
    groups.push({
      title: t('sched.waiting'),
      entries: waiting.map(e => ({ entry: e, time: shortWhen(e.next, t, now) })),
    })
  for (const e of list.filter(e => !overdue(e, now))) {
    const title = capital(dayLabel(e.next, t, now), t)
    let group = groups.at(-1)
    if (group?.title !== title) {
      group = { title, entries: [] }
      groups.push(group)
    }
    group.entries.push({ entry: e, time: timeOf(e.next, t) })
  }
  return groups
}

const WAITS: Record<string, string> = {
  gone: 'sched.gone',
  draft: 'sched.draft',
  dialog: 'sched.dialog',
  busy: 'sched.pending',
}

/** Why a due entry has not gone out yet; nothing while it is not waiting. */
export function pendingText(e: ScheduleEntry, t: Translator): string {
  if (!e.pendingSince) return ''
  const why = e.why
  const key = typeof why === 'string' && Object.hasOwn(WAITS, why) ? WAITS[why] : undefined
  return t(key ?? (why ? 'sched.failed' : 'sched.pending'), { why: String(why ?? '') })
}

export interface EntryView {
  /** It is due and waits for its session (its time in orange). */
  waiting: boolean
  repeats: boolean
  /** The session it is for: its name and lane color; one gone from the board is not a link. */
  who: { name: string; color: string; onBoard: boolean }
  /** The repeat rule, then "3 runs", "1 missed", "set by …". */
  cron: string
  stats: string[]
  /** Why it waits, or that its session left the board (muted). */
  note: string
  noteMuted: boolean
}

const count = (value: unknown): number => (typeof value === 'number' ? value : 0)

export function entryView(
  e: ScheduleEntry,
  itemOf: (key: string) => Item | undefined,
  colorOf: (item: Item) => string,
  t: Translator,
): EntryView {
  const it = itemOf(e.key)
  const pending = pendingText(e, t)
  // Set by another session than the one it is for (`board remind --session`).
  const from = e.from
  const by =
    from && from.key !== (e.movedFrom?.key ?? e.key)
      ? t('sched.by', { name: itemOf(from.key)?.name || from.name || from.key.slice(0, 8) })
      : ''
  const runs = count(e.runs)
  const missed = count(e.missed)
  return {
    waiting: !!pending,
    repeats: !!e.cron,
    who: { name: it?.name || e.name || t('session'), color: it ? colorOf(it) : 'var(--gray)', onBoard: !!it },
    cron: e.cron ?? '',
    stats: [runs ? t('sched.runs', { n: runs }) : '', missed ? t('sched.missedN', { n: missed }) : '', by].filter(
      Boolean,
    ),
    // A session that left the board keeps its entries until they run out of patience or are cancelled.
    note: pending || (it ? '' : t('sched.gone')),
    noteMuted: !pending,
  }
}

// ---------------------------------------------------------------- the log of recent runs

/** One line of the scheduler's log (src/services/scheduler.ts record), as the panel reads it. */
export interface LogRecord {
  key: string
  name: string
  text: string
  due: number
  at: number
  /** 'sent', 'missed' or 'dropped'. */
  result: string
  why: string
  n: number | undefined
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The newest 15 lines of the log, those that are records of a run. */
export function logRecords(log: unknown[]): LogRecord[] {
  return log.slice(0, 15).flatMap(r =>
    isRecord(r) && typeof r.at === 'number'
      ? [
          {
            key: text(r.key),
            name: text(r.name),
            text: text(r.text),
            due: typeof r.due === 'number' ? r.due : Number.NaN,
            at: r.at,
            result: text(r.result),
            why: text(r.why),
            n: typeof r.n === 'number' ? r.n : undefined,
          },
        ]
      : [],
  )
}

const MISSED_WHY = ['busy', 'gone', 'draft', 'dialog']

export interface LogView {
  result: string
  /** A check when sent, "!" when missed, "×" when the entry was dropped. */
  icon: 'check' | '!' | '×'
  iconTitle: string
  when: string
  name: string
  note: string
}

export function logView(r: LogRecord, itemOf: (key: string) => Item | undefined, now: number, t: Translator): LogView {
  const late = r.at - r.due
  const note =
    r.result === 'dropped'
      ? t('sched.why.dropped', { n: r.n ?? 3 })
      : r.result === 'missed'
        ? MISSED_WHY.includes(r.why)
          ? t(`sched.why.${r.why}`)
          : r.why
        : late > 120_000
          ? t('sched.lateBy', { late: span(late, t) })
          : ''
  return {
    result: r.result,
    icon: r.result === 'sent' ? 'check' : r.result === 'dropped' ? '×' : '!',
    iconTitle: t(`sched.${r.result === 'sent' || r.result === 'dropped' ? r.result : 'missed'}`),
    when: capital(longWhen(r.at, t, now), t),
    name: itemOf(r.key)?.name || r.name || t('session'),
    note,
  }
}

/** Entries that came in while the panel is open (they materialize); none on its first draw after opening. */
export const newEntries = (ids: string[], seen: ReadonlySet<string> | null): string[] =>
  seen ? ids.filter(id => !seen.has(id)) : []
