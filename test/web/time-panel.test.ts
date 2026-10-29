// The Time panel's model (#233, web/src/models/time.ts): the day read with a guard, hours as a
// bill says them, a line's name and rule, the day's name and the swipe that changes it.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { DayLine } from '../../src/core/time.ts'
import {
  askedInTurn,
  byText,
  dateName,
  dayFor,
  hm,
  hoursText,
  isTimeDay,
  lineLabel,
  ruleText,
  shiftDate,
  swipeDay,
} from '../../web/src/models/time.ts'

const t = translator('en')
const line = (o: Partial<DayLine>): DayLine => ({
  key: 'k',
  project: 'Support',
  ref: null,
  rule: 0,
  group: 'ref',
  step: 30,
  round: 'up',
  seconds: 0,
  billedSeconds: 0,
  entries: [],
  ...o,
})

test('the day is taken only as the board sends it', () => {
  expect(isTimeDay({ date: '2026-10-28', zone: 'UTC', days: [], entries: [] })).toBe(true)
  expect(isTimeDay({ date: '2026-10-28', zone: 'UTC', days: [{}], entries: [] })).toBe(false)
  expect(isTimeDay({ ok: false, error: 'off' })).toBe(false)
})

test('hours as a bill says them, raw time as H:MM', () => {
  expect(hoursText(5400, t)).toBe('1.5 h')
  expect(hoursText(900, t)).toBe('0.25 h')
  expect(hoursText(7200, t)).toBe('2 h')
  expect(hoursText(5400, translator('ru'))).toBe('1,5 h')
  expect(hm(2520)).toBe('0:42')
})

test('a line’s name and rule', () => {
  expect(lineLabel(line({ ref: '10001' }), t)).toBe('10001')
  expect(lineLabel(line({ ref: null }), t)).toBe('Support')
  expect(lineLabel(line({ group: 'day', ref: null }), t)).toBe('The day')
  expect(lineLabel(line({ group: 'project', ref: '10001' }), t)).toBe('Support')
  expect(ruleText(line({}), t)).toBe('up to 30 min')
  expect(ruleText(line({ round: 'nearest' }), t)).toBe('nearest 30 min')
  expect(ruleText(line({ round: 'exact', step: 0 }), t)).toBe('exact')
})

test('days: named in the board’s language, a day before and after across a month', () => {
  expect(dateName('2026-10-28', 'en')).toBe('Wed, Oct 28')
  expect(shiftDate('2026-10-31', 1)).toBe('2026-11-01')
  expect(shiftDate('2026-11-01', -1)).toBe('2026-10-31')
})

test('a swipe changes the day past a third of the width, or with a flick; a short slow one settles back', () => {
  expect(swipeDay(-130, 400, 360)).toBe(1)
  expect(swipeDay(130, 400, 360)).toBe(-1)
  expect(swipeDay(-60, 60, 360)).toBe(1)
  expect(swipeDay(-60, 400, 360)).toBe(0)
  expect(swipeDay(-30, 20, 360)).toBe(0)
})

test('a day’s figures show only under that day’s name; a late answer to an earlier question is dropped', () => {
  const day = { date: '2026-10-28', zone: 'America/New_York', days: [], entries: [] }
  expect(dayFor(day, '2026-10-28')).toBe(day)
  expect(dayFor(day, '2026-10-29')).toBeNull()
  expect(dayFor(null, '2026-10-28')).toBeNull()
  // two quick taps: the first answer arrives last and is not taken
  const turns = askedInTurn()
  const first = turns.ask()
  const second = turns.ask()
  expect(turns.last(second)).toBe(true)
  expect(turns.last(first)).toBe(false)
})

test('Russian: counts in all three forms, and the owner or the import named as such where shown alone', () => {
  const ru = translator('ru')
  expect([1, 2, 5, 21, 22, 25].map(n => ru('time.cli.total', { n, total: '1:00' }))).toEqual([
    '1 запись, 1:00',
    '2 записи, 1:00',
    '5 записей, 1:00',
    '21 запись, 1:00',
    '22 записи, 1:00',
    '25 записей, 1:00',
  ])
  expect(byText({ by: 'user' }, ru)).toBe('владелец')
  expect(byText({ by: 'import' }, ru)).toBe('импорт')
  // the sentence that says whose it is keeps its own form
  expect(ru('time.err.notYours', { id: 'ab12cd34', by: ru('time.by.user') })).toContain('принадлежит владельцу')
})
