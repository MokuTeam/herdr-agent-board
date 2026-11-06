// The Time panel's week and month (#241): which days a view shows (the Calendar's grid, #329), the
// board's answer for them checked, and the figures and marks drawn from it. A day is a work date
// as the board stores it; each client's day is billed by its rules on the board (core/time.ts
// spanDays), so every total here adds up billed days and never rounds again.
import { weekdayOf } from '../../../src/core/calendar-layout.ts'
import type { SpanClient, SpanDay } from '../../../src/core/time.ts'
import type { Translator } from '../../../src/core/types.ts'
import { viewDays } from './calendar.ts'

export type TimeView = 'day' | 'week' | 'month'
export const TIME_VIEWS: readonly TimeView[] = ['day', 'week', 'month']

export interface TimeSpan {
  from: string
  to: string
  zone: string
  problems?: string | null
  days: SpanDay[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function isTimeSpan(v: unknown): v is TimeSpan {
  return (
    isObject(v) &&
    typeof v.from === 'string' &&
    typeof v.to === 'string' &&
    typeof v.zone === 'string' &&
    Array.isArray(v.days) &&
    v.days.every(
      d =>
        isObject(d) &&
        typeof d.date === 'string' &&
        typeof d.entries === 'number' &&
        Array.isArray(d.clients) &&
        d.clients.every(
          c =>
            isObject(c) &&
            typeof c.client === 'string' &&
            typeof c.seconds === 'number' &&
            typeof c.billedSeconds === 'number' &&
            typeof c.notEntered === 'number',
        ),
    )
  )
}

/** The days a week or a month shows around a date: the Calendar's (a month in whole weeks). */
export const spanDates = (view: Exclude<TimeView, 'day'>, date: string, weekStart: number): string[] =>
  viewDays(view, date, weekStart)

/** An answer shows for the days it was asked for only: one for other days, arriving late, is not shown. */
export const spanFor = (span: TimeSpan | null, from: string, to: string): TimeSpan | null =>
  span && span.from === from && span.to === to ? span : null

/** A day's figures, all clients' or one's. */
export interface Figures {
  seconds: number
  billedSeconds: number
  notEntered: number
  clients: SpanClient[]
}

/** A day's figures: its clients' added up, or the one client's on show. */
export function dayFigures(day: SpanDay, client: string | null): Figures {
  const clients = day.clients.filter(c => !client || c.client === client)
  return {
    seconds: clients.reduce((n, c) => n + c.seconds, 0),
    billedSeconds: clients.reduce((n, c) => n + c.billedSeconds, 0),
    notEntered: clients.reduce((n, c) => n + c.notEntered, 0),
    clients,
  }
}

/** Whether figures have time to show: worked or billed (a day of held entries only has none yet). */
export const hasTime = (f: Figures): boolean => f.clients.some(c => c.seconds > 0 || c.billedSeconds > 0)

/** The days' figures added up: in all and per client (in lane id order, as the chips). */
export function spanTotals(days: readonly SpanDay[], client: string | null): Figures {
  const per = new Map<string, SpanClient>()
  for (const d of days)
    for (const c of d.clients) {
      if (client && c.client !== client) continue
      const was = per.get(c.client) ?? { client: c.client, seconds: 0, billedSeconds: 0, notEntered: 0 }
      per.set(c.client, {
        client: c.client,
        seconds: was.seconds + c.seconds,
        billedSeconds: was.billedSeconds + c.billedSeconds,
        notEntered: was.notEntered + c.notEntered,
      })
    }
  const clients = [...per.values()].sort((a, b) => a.client.localeCompare(b.client))
  return {
    seconds: clients.reduce((n, c) => n + c.seconds, 0),
    billedSeconds: clients.reduce((n, c) => n + c.billedSeconds, 0),
    notEntered: clients.reduce((n, c) => n + c.notEntered, 0),
    clients,
  }
}

/** The clients with time in the days, each once, in lane id order (as the day's chips). */
export const spanClients = (days: readonly SpanDay[]): string[] =>
  [...new Set(days.flatMap(d => d.clients.map(c => c.client)))].sort()

/** Monday to Friday. */
export const isWeekday = (date: string): boolean => {
  const wd = weekdayOf(date)
  return wd >= 1 && wd <= 5
}

/**
 * A day's marks. `noTime`: a weekday before today (the board's) with no entry at all, whichever
 * client is on show; today, a weekend and what is ahead never. `notEntered`: billed time of the
 * clients on show missing a mark in a system it is to be entered in.
 */
export function dayMarks(day: SpanDay, today: string, client: string | null): { noTime: boolean; notEntered: number } {
  return {
    noTime: day.entries === 0 && day.date < today && isWeekday(day.date),
    notEntered: dayFigures(day, client).notEntered,
  }
}

/** Whether a day is past, today or ahead of the board's today. */
export const when = (date: string, today: string): 'past' | 'today' | 'ahead' =>
  date < today ? 'past' : date === today ? 'today' : 'ahead'

/** The largest billed figure of the days (a minute at least): each day's bar is drawn against it. */
export const tallest = (days: readonly SpanDay[], client: string | null): number =>
  Math.max(60, ...days.map(d => dayFigures(d, client).billedSeconds))

/**
 * A duration in the panel's one form (core/time.ts durationText), in its parts: ["7 h", "30 min"],
 * so a narrow month's cell can put each on a line of its own; side by side they read as the whole.
 */
export function durationParts(seconds: number, t: Translator): string[] {
  const minutes = Math.round(seconds / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return [t('time.dur.m', { m })]
  return m ? [t('time.dur.h', { h }), t('time.dur.m', { m })] : [t('time.dur.h', { h })]
}
