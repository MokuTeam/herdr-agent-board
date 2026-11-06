// The Time panel's week and month as the page reads them (#241, web/src/models/time-span.ts): the
// answer checked, the days a view shows (the Calendar's), the totals per client and per day, the
// marks (a weekday gone by with no time, billed time not entered), a duration in its parts.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { durationText, type SpanDay } from '../../src/core/time.ts'
import { weekStartFor } from '../../web/src/models/calendar.ts'
import {
  dayFigures,
  dayMarks,
  durationParts,
  isTimeSpan,
  spanClients,
  spanDates,
  spanFor,
  spanTotals,
  tallest,
  when,
} from '../../web/src/models/time-span.ts'

const day = (date: string, clients: [string, number, number, number][], entries = clients.length): SpanDay => ({
  date,
  entries,
  clients: clients.map(([client, seconds, billedSeconds, notEntered]) => ({
    client,
    seconds,
    billedSeconds,
    notEntered,
  })),
})

test('an answer is taken only when it is one, and shown only for the days it was asked for', () => {
  const span = { from: '2026-11-02', to: '2026-11-08', zone: 'America/New_York', days: [day('2026-11-02', [])] }
  expect(isTimeSpan(span)).toBe(true)
  expect(isTimeSpan({ ...span, days: [{ date: '2026-11-02', clients: [{ client: 'a' }], entries: 1 }] })).toBe(false)
  expect(isTimeSpan({ date: '2026-11-02', days: [], entries: [] })).toBe(false)
  expect(spanFor(span, '2026-11-02', '2026-11-08')).toBe(span)
  expect(spanFor(span, '2026-11-09', '2026-11-15')).toBeNull()
})

test('a week and a month as the Calendar shows them: Monday first in Russian, a month in whole weeks', () => {
  const monday = weekStartFor('ru')
  expect(spanDates('week', '2026-11-06', monday)).toEqual([
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
    '2026-11-05',
    '2026-11-06',
    '2026-11-07',
    '2026-11-08',
  ])
  expect(spanDates('week', '2026-11-06', 0)[0]).toBe('2026-11-01')
  const month = spanDates('month', '2026-11-06', monday)
  expect(month.length % 7).toBe(0)
  expect(month[0]).toBe('2026-10-26')
  expect(month.at(-1)).toBe('2026-12-06')
})

test('totals per day and per client, billed and worked apart; one client picked is that client’s only', () => {
  const days = [
    day('2026-11-02', [
      ['a', 3000, 3600, 1800],
      ['b', 1200, 1800, 0],
    ]),
    day('2026-11-03', [
      ['a', 600, 1800, 0],
      ['own', 5400, 0, 0],
    ]),
  ]
  expect(dayFigures(days[0] as SpanDay, null)).toMatchObject({ seconds: 4200, billedSeconds: 5400, notEntered: 1800 })
  expect(dayFigures(days[0] as SpanDay, 'b')).toMatchObject({ seconds: 1200, billedSeconds: 1800, notEntered: 0 })
  const all = spanTotals(days, null)
  expect(all).toMatchObject({ seconds: 10200, billedSeconds: 7200, notEntered: 1800 })
  expect(all.clients.map(c => [c.client, c.seconds, c.billedSeconds, c.notEntered])).toEqual([
    ['a', 3600, 5400, 1800],
    ['b', 1200, 1800, 0],
    ['own', 5400, 0, 0],
  ])
  expect(spanTotals(days, 'a')).toMatchObject({ seconds: 3600, billedSeconds: 5400, notEntered: 1800 })
  expect(spanTotals(days, 'a').clients).toHaveLength(1)
  expect(spanClients(days)).toEqual(['a', 'b', 'own'])
  // each day's bar is drawn against the longest billed day on show
  expect(tallest(days, null)).toBe(5400)
  expect(tallest([day('2026-11-04', [])], null)).toBe(60)
})

test('no time: a weekday gone by with no entry at all; never today, a weekend or a day ahead', () => {
  const today = '2026-11-06' // a Friday
  expect(dayMarks(day('2026-11-05', []), today, null).noTime).toBe(true)
  expect(dayMarks(day('2026-11-05', []), today, 'a').noTime).toBe(true)
  expect(dayMarks(day('2026-11-06', []), today, null).noTime).toBe(false)
  expect(dayMarks(day('2026-11-01', []), today, null).noTime).toBe(false) // Sunday
  expect(dayMarks(day('2026-10-31', []), today, null).noTime).toBe(false) // Saturday
  expect(dayMarks(day('2026-11-09', []), today, null).noTime).toBe(false)
  // a held entry only: there is time, not billed yet
  expect(dayMarks(day('2026-11-04', [['a', 0, 0, 0]], 1), today, null).noTime).toBe(false)
  // another client's time is time: the day is not one with none under a client's chip
  expect(dayMarks(day('2026-11-04', [['b', 600, 1800, 0]]), today, 'a').noTime).toBe(false)
  expect([when('2026-11-05', today), when(today, today), when('2026-11-07', today)]).toEqual(['past', 'today', 'ahead'])
})

test('not entered: the clients on show, today too', () => {
  const d = day('2026-11-06', [
    ['a', 3000, 3600, 1800],
    ['b', 1200, 1800, 900],
  ])
  expect(dayMarks(d, '2026-11-06', null).notEntered).toBe(2700)
  expect(dayMarks(d, '2026-11-06', 'b').notEntered).toBe(900)
  expect(dayMarks(day('2026-11-05', [['a', 600, 1800, 0]]), '2026-11-06', null).notEntered).toBe(0)
})

test('a duration in its parts reads as the panel’s one form, in English and Russian', () => {
  for (const lang of ['en', 'ru'] as const) {
    const t = translator(lang)
    for (const s of [0, 45 * 60, 2 * 3600, 7.5 * 3600, 26 * 3600 + 60])
      expect(durationParts(s, t).join(' ')).toBe(durationText(s, t))
  }
  expect(durationParts(7.5 * 3600, translator('en'))).toEqual(['7h', '30m'])
  expect(durationParts(7.5 * 3600, translator('ru'))).toEqual(['7 ч', '30 мин'])
})
