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
  /** config.json's `time` does not check out: what, in a line. */
  problems?: string | null
  /** The lanes that take time (null: every lane), and each one's projects (null: any). */
  clients?: string[] | null
  projects?: Record<string, string[] | null>
}

/** A day's answer shows under that day's name only: another day's, arriving late, is not shown. */
export const dayFor = (day: TimeDay | null, date: string): TimeDay | null => (day && day.date === date ? day : null)

/** Questions asked in turn: an answer counts only while its question is the last one asked. */
export function askedInTurn(): { ask(): number; last(n: number): boolean } {
  let n = 0
  return { ask: () => ++n, last: k => k === n }
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

/** A line's name: "The day" for a day's group, the project for a project's, else its reference (a case, a ticket) or its project. */
export function lineLabel(l: DayLine, t: Translator): string {
  if (l.group === 'day') return t('time.dayGroup')
  if (l.group === 'project') return l.project
  return l.ref ?? l.project
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
  return typeof e.by === 'string' ? t(`time.who.${e.by}`) : e.by.name || e.by.key.slice(0, 8)
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

// ------------------------------------------------------------------ the editor

/**
 * An entry as the editor holds it: the times as this browser's clock shows them (HH:MM), on `day`.
 * Until a time is typed, the entry's own instant stands behind it (`startAt`, `stopAt`): its
 * seconds are kept, and a 15-minute step moves the stop by exactly that.
 */
export interface Draft {
  client: string
  project: string
  description: string
  /** The work date (a change moves the entry; for a new one, the day its times are on). */
  date: string
  /** The day of this browser's clock the times are on. */
  day: string
  start: string
  stop: string
  startAt: number | null
  stopAt: number | null
  /** Tags as typed: words, commas between them. */
  tags: string
}

const DAY_MS = 86_400_000
const pad = (n: number): string => String(n).padStart(2, '0')
/** An instant's date on this browser's clock. */
export const localDate = (at: number): string => {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
/** An instant's HH:MM on this browser's clock. */
export const localClock = (at: number): string => {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function draftOf(
  e: Pick<TimeEntry, 'client' | 'project' | 'description' | 'date' | 'start' | 'stop' | 'tags'>,
): Draft {
  const startAt = Date.parse(e.start)
  const stopAt = Date.parse(e.stop)
  return {
    client: e.client,
    project: e.project,
    description: e.description,
    date: e.date,
    day: localDate(startAt),
    start: localClock(startAt),
    stop: localClock(stopAt),
    startAt,
    stopAt,
    tags: e.tags.join(', '),
  }
}

/** A new entry's draft: half an hour ending now on today, else 09:00 to 09:30 on that day. */
export function newDraft(client: string, project: string, date: string, now: number = Date.now()): Draft {
  const today = localDate(now)
  const end = Math.floor(now / 60_000) * 60_000
  return {
    client,
    project,
    description: '',
    date,
    day: date,
    start: date === today ? localClock(end - 30 * 60_000) : '09:00',
    stop: date === today ? localClock(end) : '09:30',
    startAt: null,
    stopAt: null,
    tags: '',
  }
}

/** A time typed into the draft: the field's HH:MM, the instant behind it dropped. */
export const typed = (d: Draft, field: 'start' | 'stop', value: string): Draft =>
  field === 'start' ? { ...d, start: value, startAt: null } : { ...d, stop: value, stopAt: null }

/** HH:MM on a day (YYYY-MM-DD) of this browser's clock as an instant; NaN for a bad one. */
function at(day: string, clock: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock)
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number]
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return Number.NaN
  return new Date(y, mo - 1, d, Number(m[1]), Number(m[2]), 0, 0).getTime()
}

/**
 * The draft's start and stop: the entry's own instants where no time was typed, else HH:MM on the
 * draft's day; a typed stop at or before the start is the next day's. Null when a time is not one,
 * or the stop is not after the start.
 */
export function draftTimes(d: Pick<Draft, 'day' | 'start' | 'stop' | 'startAt' | 'stopAt'>): {
  start: number
  stop: number
} | null {
  const start = d.startAt ?? at(d.day, d.start)
  let stop = d.stopAt ?? at(d.day, d.stop)
  if (Number.isNaN(start) || Number.isNaN(stop)) return null
  if (d.stopAt === null && stop <= start) stop += DAY_MS
  return stop > start ? { start, stop } : null
}

/** The draft's duration in seconds, or null. */
export function draftSeconds(d: Pick<Draft, 'day' | 'start' | 'stop' | 'startAt' | 'stopAt'>): number | null {
  const times = draftTimes(d)
  return times ? Math.round((times.stop - times.start) / 1000) : null
}

/** Longer than this is likely a slip (a stop before the start read as the next day's): the editor asks. */
export const LONG_SECONDS = 12 * 3600

/** The stop moved by `minutes` from where it is (its seconds kept), the duration kept at a minute at least. */
export function nudge(d: Draft, minutes: number): Draft {
  const times = draftTimes(d)
  if (!times) return d
  const stop = Math.max(times.start + 60_000, times.stop + minutes * 60_000)
  return { ...d, stop: localClock(stop), stopAt: stop }
}

export const tagList = (s: string): string[] =>
  s
    .split(',')
    .map(x => x.trim().replace(/^#/, ''))
    .filter(Boolean)

/**
 * What saving a draft of an entry sends, against the entry as it was opened (`base`) and with the
 * revision read then: the edit of what changed, then a move when the work date changed; nothing for
 * a draft as the entry is. Of the times only what moved goes: a new start with the stop as it
 * stands (the board keeps the duration of a start sent alone), else a new stop alone; an untouched
 * time keeps its seconds.
 */
export function changesOf(
  base: Pick<TimeEntry, 'id' | 'rev' | 'client' | 'project' | 'description' | 'date' | 'start' | 'stop' | 'tags'>,
  d: Draft,
): { edit: Record<string, unknown> | null; move: string | null } | null {
  const edit: Record<string, unknown> = {}
  if (d.description.trim() !== base.description) edit.description = d.description
  if (d.project !== base.project) edit.project = d.project
  const times = draftTimes(d)
  if (!times) return null
  if (times.start !== Date.parse(base.start)) {
    edit.start = new Date(times.start).toISOString()
    edit.stop = new Date(times.stop).toISOString()
  } else if (times.stop !== Date.parse(base.stop)) edit.stop = new Date(times.stop).toISOString()
  const tags = tagList(d.tags)
  if (tags.join(',') !== base.tags.join(',')) edit.tags = tags
  return {
    edit: Object.keys(edit).length ? { op: 'edit', id: base.id, rev: base.rev, ...edit } : null,
    move: d.date !== base.date ? d.date : null,
  }
}

/** What saving a new entry's draft sends; null when its times are not times. */
export function addOf(d: Draft): Record<string, unknown> | null {
  const times = draftTimes(d)
  if (!times) return null
  return {
    op: 'add',
    client: d.client,
    project: d.project,
    description: d.description,
    tags: tagList(d.tags),
    start: new Date(times.start).toISOString(),
    stop: new Date(times.stop).toISOString(),
  }
}
