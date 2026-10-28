// The Time panel (#233) as the page has it: GET /api/time's day read with a guard, and the words
// and numbers the panel shows: hours as a bill says them, a line's label and rule, an entry's
// times on this browser's clock, a date's name, and whether a swipe changes the day. The rules
// themselves are the board's (src/core/time.ts); the page only shows them.
import type { ClientDay, DayLine, TimeEntry } from '../../../src/core/time.ts'
import type { Translator } from '../../../src/core/types.ts'

export interface TimeDay {
  date: string
  zone: string
  days: ClientDay[]
  entries: (TimeEntry & { seconds: number })[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function isTimeDay(v: unknown): v is TimeDay {
  return (
    isObject(v) &&
    typeof v.date === 'string' &&
    typeof v.zone === 'string' &&
    Array.isArray(v.days) &&
    v.days.every(d => isObject(d) && Array.isArray(d.lines) && typeof d.billedSeconds === 'number') &&
    Array.isArray(v.entries)
  )
}

/** Seconds as H:MM. */
export function hm(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

/** Seconds as the hours a bill says: "1.5 h", "0.25 h", "2 h". */
export function hoursText(seconds: number, t: Translator): string {
  const n = Math.round((seconds / 3600) * 100) / 100
  return `${n.toLocaleString(t.lang)} h`
}

/** A line's name: its reference (a case, a ticket), else its project, else "The day". */
export function lineLabel(l: DayLine, t: Translator): string {
  return l.ref ?? (l.project || t('time.dayGroup'))
}

/** A line's rule in a word: exact, or the step and the way it rounds. */
export function ruleText(l: DayLine, t: Translator): string {
  return l.round === 'exact' ? t('time.round.exact') : t(`time.round.${l.round}`, { step: l.step })
}

/** An entry's start and stop on this browser's clock: "09:10-09:52". */
export function entryTimes(e: Pick<TimeEntry, 'start' | 'stop'>, lang: string): string {
  const f = (iso: string) => new Date(iso).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
  return `${f(e.start)}-${f(e.stop)}`
}

/** A date's name in the board's language: "Tue 28 Oct". */
export function dateName(date: string, lang: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(lang, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
}

/** A date and a number of days after it. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** Who made an entry, as a line names it. */
export function byText(e: Pick<TimeEntry, 'by'>, t: Translator): string {
  return typeof e.by === 'string' ? t(`time.by.${e.by}`) : e.by.name || e.by.key.slice(0, 8)
}

/**
 * Whether a horizontal drag of `dx` px in `ms` changes the day, and which way: past a third of
 * the width, or a flick (0.5 px/ms) past 40 px; -1 the day before (a drag to the right), 1 after.
 */
export function swipeDay(dx: number, ms: number, width: number): -1 | 0 | 1 {
  const fast = Math.abs(dx) > 40 && Math.abs(dx) / Math.max(ms, 1) > 0.5
  if (Math.abs(dx) < width / 3 && !fast) return 0
  return dx > 0 ? -1 : 1
}
