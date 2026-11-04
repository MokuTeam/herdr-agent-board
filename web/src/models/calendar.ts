// The Calendar panel's rules (#328, components/calendar/): which days a view shows, its title, an
// event's colour and label, times on this browser's clock, the grid's rows. The days are this
// browser's (its zone), as a calendar on the owner's screen shows them. What the board answers
// (GET /api/calendar) is checked here before the panel draws it.
import type { CalEvent } from '../../../src/core/calendar.ts'
import { daysFrom, monthWeeks, weekOf } from '../../../src/core/calendar-layout.ts'
import { addDays } from '../../../src/core/time.ts'

export type CalView = 'day' | 'week' | 'month' | 'agenda'
export const CAL_VIEWS: readonly CalView[] = ['day', 'week', 'month', 'agenda']
export const isCalView = (v: unknown): v is CalView => CAL_VIEWS.includes(v as CalView)

/** How many days the agenda lists from the day it is on. */
export const AGENDA_DAYS = 14

/** A source as the panel marks its events (GET /api/calendar's `sources`). */
export interface CalSourceView {
  id: string
  kind: string
  label: string
  color: string | null
  lane: string | null
  lastOk: number | null
  lastTry: number | null
  error: string | null
  fails: number
  count: number
  problems: string | null
  address: boolean | null
  writes: boolean
  everyMin: number
  url: string | null
  account: string | null
  preset: string | null
  calendars: string[]
}

export interface CalAnswer {
  from: number
  to: number
  zone: string
  events: CalEvent[]
  sources: CalSourceView[]
  busy: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function isCalAnswer(v: unknown): v is CalAnswer {
  return (
    isObject(v) &&
    typeof v.from === 'number' &&
    typeof v.to === 'number' &&
    Array.isArray(v.events) &&
    Array.isArray(v.sources) &&
    Array.isArray(v.busy)
  )
}

// ------------------------------------------------------------------ dates on this browser's clock

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** The date of an instant on this browser's clock. */
export const localDate = (at: number): string => {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Midnight that starts a date on this browser's clock. */
export const midnight = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d).getTime()
}

/** The week's first day for a language: from the browser's locale where it says, else Monday. */
export function weekStartFor(locale: string): number {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const first = l.getWeekInfo?.().firstDay ?? l.weekInfo?.firstDay
    if (first) return first % 7
  } catch {}
  return 1
}

/** The days a view shows around a date. */
export function viewDays(view: CalView, date: string, weekStart: number): string[] {
  if (view === 'day') return [date]
  if (view === 'week') return daysFrom(weekOf(date, weekStart), 7)
  if (view === 'agenda') return daysFrom(date, AGENDA_DAYS)
  return monthWeeks(date, weekStart).flat()
}

/** The window a view asks the board for: from the first day's midnight to the one after its last. */
export function viewWindow(view: CalView, date: string, weekStart: number): { from: number; to: number } {
  const days = viewDays(view, date, weekStart)
  return { from: midnight(days[0] as string), to: midnight(addDays(days.at(-1) as string, 1)) }
}

/** The date the arrows go to: a day, a week, a month (the same day of it, or its last), two weeks of agenda. */
export function stepDate(view: CalView, date: string, by: number): string {
  if (view === 'day') return addDays(date, by)
  if (view === 'week') return addDays(date, 7 * by)
  if (view === 'agenda') return addDays(date, AGENDA_DAYS * by)
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const first = new Date(Date.UTC(y, m - 1 + by, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  return `${first.getUTCFullYear()}-${pad2(first.getUTCMonth() + 1)}-${pad2(Math.min(d, last))}`
}

const fmt = new Map<string, Intl.DateTimeFormat>()
function formatter(locale: string, o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(o)}`
  let f = fmt.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale, o)
    fmt.set(key, f)
  }
  return f
}
const at12 = (date: string): Date => new Date(`${date}T12:00:00Z`)

/** The browser's own clock style (12 or 24 hours), whatever the board's language. */
export function hourCycle(): 'h12' | 'h23' {
  try {
    const c = new Intl.DateTimeFormat(navigator.language, { hour: 'numeric' }).resolvedOptions().hourCycle
    return c === 'h11' || c === 'h12' ? 'h12' : 'h23'
  } catch {
    return 'h23'
  }
}

/** A clock: 09:30, or 9:30 AM where the browser counts twelve hours. */
export function clockText(at: number, lang: string, cycle = hourCycle()): string {
  return formatter(lang, { hour: cycle === 'h12' ? 'numeric' : '2-digit', minute: '2-digit', hourCycle: cycle }).format(
    new Date(at),
  )
}

/** An hour on the grid's edge: 09, or 9 AM. */
export function hourText(hour: number, lang: string, cycle = hourCycle()): string {
  const d = new Date(2026, 0, 5, hour)
  return cycle === 'h12'
    ? formatter(lang, { hour: 'numeric', hourCycle: 'h12' }).format(d)
    : formatter(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
}

/** A view's title: "November 2026", "2–8 November 2026" (spelled with a hyphen), "Wednesday, 4 November". */
export function viewTitle(view: CalView, date: string, weekStart: number, lang: string): string {
  const days = viewDays(view, date, weekStart)
  const first = days[0] as string
  const last = days.at(-1) as string
  if (view === 'month') return formatter(lang, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(at12(date))
  if (view === 'day')
    return formatter(lang, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(at12(date))
  const sameMonth = first.slice(0, 7) === last.slice(0, 7)
  const a = formatter(lang, { day: 'numeric', ...(sameMonth ? {} : { month: 'short' }), timeZone: 'UTC' }).format(
    at12(first),
  )
  const b = formatter(lang, {
    day: 'numeric',
    month: sameMonth ? 'long' : 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at12(last))
  return `${a} - ${b}`
}

/** A day's head: its weekday short and its number. */
export function dayHead(date: string, lang: string): { weekday: string; day: string } {
  return {
    weekday: formatter(lang, { weekday: 'short', timeZone: 'UTC' }).format(at12(date)),
    day: String(Number(date.slice(8, 10))),
  }
}

/** A day as the agenda heads it: "Today", "Tomorrow", else its weekday, day and month. */
export function agendaDay(date: string, today: string, lang: string, t: (k: string) => string): string {
  const name = formatter(lang, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(at12(date))
  if (date === today) return `${t('cal.today')} · ${name}`
  if (date === addDays(today, 1)) return `${t('cal.tomorrow')} · ${name}`
  return name
}

/** The month's name for its grid's weekday heads: Mon, Tue… from the week's first day. */
export const weekdayHeads = (weekStart: number, lang: string): string[] =>
  daysFrom(weekOf('2026-01-07', weekStart), 7).map(d =>
    formatter(lang, { weekday: 'short', timeZone: 'UTC' }).format(at12(d)),
  )

// ------------------------------------------------------------------ events on the grid

/** An event's span on this browser's clock: an all-day one from midnight to midnight. */
export function spanOf(e: Pick<CalEvent, 'start' | 'end' | 'allDay'>): { start: number; end: number } {
  if (e.allDay) return { start: midnight(e.start), end: midnight(e.end) }
  return { start: Date.parse(e.start), end: Date.parse(e.end) }
}

/** Whether an event goes in a strip of bars (all day, or over midnight for a day or more) rather than in the hours. */
export function isBar(e: CalEvent): boolean {
  if (e.allDay) return true
  const s = spanOf(e)
  return s.end - s.start >= 24 * 3_600_000
}

/** An event's first and last date on this browser's clock (its end exclusive). */
export function datesOf(e: CalEvent): { first: string; last: string } {
  if (e.allDay) return { first: e.start, last: addDays(e.end, -1) }
  const s = spanOf(e)
  return { first: localDate(s.start), last: localDate(Math.max(s.start, s.end - 1)) }
}

/** The colours the panel gives a source without one of its own or its lane's, in order. */
const OWN_COLORS = ['#5e5ce6', '#30b0c7', '#ff9f0a', '#bf5af2', '#34c759', '#ff375f', '#a2845e']
/** The board's own calendar, unless config.json gives it a colour. */
const BOARD_COLOR = '#8e8e93'

/** Each source's colour: its own, its lane's, or one of the panel's by its place. */
export function sourceColors(
  sources: readonly Pick<CalSourceView, 'id' | 'kind' | 'color' | 'lane'>[],
  lanes: readonly { id: string; color: string }[],
): Map<string, string> {
  const out = new Map<string, string>()
  let i = 0
  for (const s of sources) {
    const lane = s.lane ? lanes.find(l => l.id === s.lane)?.color : undefined
    out.set(
      s.id,
      s.color ?? lane ?? (s.kind === 'board' ? BOARD_COLOR : (OWN_COLORS[i++ % OWN_COLORS.length] as string)),
    )
  }
  return out
}

/** A source's label: its own, else the lane's title, else its id; the board's own is the board's. */
export function sourceLabel(
  s: Pick<CalSourceView, 'id' | 'kind' | 'label' | 'lane'> | undefined,
  lanes: readonly { id: string; title?: string | undefined }[],
  t: (k: string) => string,
): string {
  if (!s) return ''
  if (s.label && s.label !== s.id) return s.label
  if (s.kind === 'board') return t('cal.board')
  const lane = s.lane ? lanes.find(l => l.id === s.lane)?.title : undefined
  return lane || s.label || s.id
}

/** How an event reads: declined and cancelled dimmed and struck; not answered yet as an outline. */
export function eventTone(e: CalEvent): 'declined' | 'pending' | 'quiet' | 'normal' {
  if (e.status === 'cancelled' || e.response === 'declined') return 'declined'
  if (e.status === 'tentative' || e.response === 'needsAction' || e.response === 'tentative') return 'pending'
  if (e.kind && e.kind !== 'default') return 'quiet'
  return 'normal'
}

/** Whether a call is on now, or starts within `soonMs`: its join link goes forward. */
export const callSoon = (e: Pick<CalEvent, 'start' | 'end' | 'allDay'>, now: number, soonMs = 10 * 60_000): boolean =>
  !e.allDay && Date.parse(e.start) - soonMs <= now && Date.parse(e.end) > now

/** How long until a call, in words: "in 12 min", "now". */
export function untilText(
  start: number,
  end: number,
  now: number,
  t: (k: string, v?: Record<string, number>) => string,
): string {
  if (start <= now && end > now) return t('cal.now')
  const min = Math.max(1, Math.round((start - now) / 60_000))
  if (min < 60) return t('cal.inMin', { n: min })
  return t('cal.inHours', { n: Math.round(min / 60) })
}

/** How long ago a source was fetched, in words. */
export function agoText(at: number | null, now: number, t: (k: string, v?: Record<string, number>) => string): string {
  if (!at) return t('cal.never')
  const min = Math.round((now - at) / 60_000)
  if (min < 1) return t('cal.justNow')
  if (min < 60) return t('cal.minAgo', { n: min })
  const h = Math.round(min / 60)
  return h < 48 ? t('cal.hAgo', { n: h }) : t('cal.dAgo', { n: Math.round(h / 24) })
}

/** The provider a join link goes to, for its button's name. */
export function joinProvider(url: string): string {
  const host = (() => {
    try {
      return new URL(url).hostname
    } catch {
      return ''
    }
  })()
  if (host === 'meet.google.com') return 'Meet'
  if (/(^|\.)zoom(gov)?\.(us|com)$/.test(host)) return 'Zoom'
  if (/teams\.(microsoft|live)\.com$/.test(host)) return 'Teams'
  if (/webex\.com$/.test(host)) return 'Webex'
  if (host === 'telemost.yandex.ru' || host === 'telemost.yandex.com') return 'Telemost'
  return ''
}

/** Where the hours scroll to when a day or week opens: an hour before now on today, else the first event or 8:00. */
export function firstHour(days: readonly string[], events: readonly CalEvent[], now: number): number {
  const today = localDate(now)
  if (days.includes(today)) return Math.max(0, new Date(now).getHours() - 1)
  const starts = events.filter(e => !isBar(e)).map(e => new Date(spanOf(e).start).getHours())
  return starts.length ? Math.max(0, Math.min(...starts) - 1) : 8
}
