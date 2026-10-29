// The Time panel's model (#233, web/src/models/time.ts): the day read with a guard, a duration in
// one form everywhere, a line's name and rules, an entry's description under its line and its times,
// the day's name and the swipe that changes it.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { DayLine } from '../../src/core/time.ts'
import {
  addOf,
  askedInTurn,
  billableSet,
  byText,
  changesOf,
  dateName,
  dayFor,
  dayTitle,
  draftOf,
  draftSeconds,
  draftTimes,
  durationText,
  entryTimes,
  isTimeDay,
  lineLabel,
  localClock,
  markPlan,
  markState,
  newDraft,
  notEntered,
  nudge,
  parseDuration,
  rulesOf,
  ruleText,
  shiftDate,
  swipeDay,
  tagOf,
  typed,
  underLine,
  withDuration,
  withoutTag,
  withTag,
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

test('a duration in one form, worked and billed alike: hours and minutes, to the minute, never wrapped', () => {
  const ru = translator('ru')
  expect(durationText(5400, t)).toBe('1h\u00a030m')
  expect(durationText(2520, t)).toBe('42m')
  expect(durationText(7200, t)).toBe('2h')
  expect(durationText(4220, t)).toBe('1h\u00a010m')
  expect(durationText(0, t)).toBe('0m')
  expect(durationText(5400, ru)).toBe('1\u00a0ч\u00a030\u00a0мин')
  expect(durationText(2520, ru)).toBe('42\u00a0мин')
  expect(durationText(7200, ru)).toBe('2\u00a0ч')
})

test('a line’s name and rule', () => {
  expect(lineLabel(line({ ref: '10001' }), t)).toBe('10001')
  expect(lineLabel(line({ ref: null }), t)).toBe('Support')
  expect(lineLabel(line({ group: 'day', ref: null }), t)).toBe('The day')
  expect(lineLabel(line({ group: 'project', ref: '10001' }), t)).toBe('Support')
  expect(ruleText(line({}), t)).toBe('up to 30 min')
  expect(ruleText(line({ round: 'nearest' }), t)).toBe('nearest 30 min')
  expect(ruleText(line({ round: 'exact', step: 0 }), t)).toBe('exact')
  // a client's rules, each once; exact says nothing
  expect(
    rulesOf([line({}), line({ key: 'b' }), line({ round: 'nearest' }), line({ round: 'exact', step: 0 })], t),
  ).toEqual(['up to 30 min', 'nearest 30 min'])
})

test('an entry under its line: without the line’s name it starts with, the whole description otherwise', () => {
  expect(underLine('Case 10001: saved search for open invoices', '10001')).toBe('Saved search for open invoices')
  expect(underLine('TCK-2538 lookup timeout', 'TCK-2538')).toBe('Lookup timeout')
  expect(underLine('tck-2538 - lookup', 'TCK-2538')).toBe('Lookup')
  expect(underLine('Кейс 10001: отчёт', '10001')).toBe('Отчёт')
  expect(underLine('#10001 fix', '10001')).toBe('Fix')
  // not where the name is only part of a longer one, nor where it is not at the start
  expect(underLine('Case 100019: other', '10001')).toBe('Case 100019: other')
  expect(underLine('Follow-up on 10001', '10001')).toBe('Follow-up on 10001')
  // nothing left, or no name: as it is
  expect(underLine('10001', '10001')).toBe('10001')
  expect(underLine('Case 10001:', '10001')).toBe('Case 10001:')
  expect(underLine('Weekly sync', '')).toBe('Weekly sync')
  // a name with the characters a pattern would take its own way
  expect(underLine('C++ (v2) build fix', 'C++ (v2)')).toBe('Build fix')
})

test('an entry’s times: AM or PM once where both share it, a 24-hour clock as it is', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 29, h, m).toISOString()
  const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ')
  expect(plain(entryTimes({ start: at(16, 0), stop: at(17, 10) }, 'en'))).toBe('4:00-5:10 PM')
  expect(plain(entryTimes({ start: at(11, 30), stop: at(12, 15) }, 'en'))).toBe('11:30 AM-12:15 PM')
  expect(entryTimes({ start: at(9, 10), stop: at(9, 52) }, 'ru')).toBe('09:10-09:52')
  expect(entryTimes({ start: at(23, 40), stop: at(0, 20) }, 'ru')).toBe('23:40-00:20')
})

test('days: named in the board’s language, a day before and after across a month', () => {
  expect(dateName('2026-10-28', 'en')).toBe('Wed, Oct 28')
  expect(dayTitle('2026-10-28', 'en')).toBe('Wednesday, October 28')
  expect(dayTitle('2026-10-29', 'ru')).toBe('Четверг, 29 октября')
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

test('the editor: a draft on this browser’s clock, what saving it sends, the 15-minute steps', () => {
  const e = {
    id: 'e1',
    rev: 3,
    client: 'client-a',
    project: 'Support',
    description: 'Case 10001 X: work',
    date: '2026-10-28',
    start: new Date(2026, 9, 28, 9, 0).toISOString(),
    stop: new Date(2026, 9, 28, 10, 30).toISOString(),
    tags: ['deferred'],
  }
  const d = draftOf(e)
  expect([d.start, d.stop, d.tags]).toEqual(['09:00', '10:30', 'deferred'])
  expect(draftSeconds(d)).toBe(5400)
  // nothing changed: nothing sent
  expect(changesOf(e, d)).toEqual({ edit: null, move: null })
  // a trim: the stop alone, the revision read
  const trimmed = nudge(d, -15)
  expect(trimmed.stop).toBe('10:15')
  expect(changesOf(e, trimmed)?.edit).toEqual({
    op: 'edit',
    id: 'e1',
    rev: 3,
    stop: new Date(2026, 9, 28, 10, 15).toISOString(),
  })
  // a new start: the start, and the stop as it stands (the board would keep the duration else)
  expect(changesOf(e, typed(d, 'start', '08:30'))?.edit).toEqual({
    op: 'edit',
    id: 'e1',
    rev: 3,
    start: new Date(2026, 9, 28, 8, 30).toISOString(),
    stop: new Date(2026, 9, 28, 10, 30).toISOString(),
  })
  // a step never takes the duration under a minute
  expect(draftSeconds(nudge(typed(d, 'stop', '09:10'), -15))).toBe(60)
  // tags and a new date: the edit, then the move
  const moved = changesOf(e, { ...d, tags: '#deferred, waiting', date: '2026-10-30' })
  expect(moved?.edit).toEqual({ op: 'edit', id: 'e1', rev: 3, tags: ['deferred', 'waiting'] })
  expect(moved?.move).toBe('2026-10-30')
  // a typed stop before the start is the next day's
  expect(draftSeconds(typed(typed(d, 'start', '23:30'), 'stop', '00:15'))).toBe(45 * 60)
  expect(changesOf(e, typed(d, 'start', '25:00'))).toBe(null)
})

test('an entry with seconds keeps them: +15 adds fifteen minutes to the stop, the start goes untouched', () => {
  const e = {
    id: 'e2',
    rev: 1,
    client: 'client-a',
    project: 'Support',
    description: 'Case 10001 X: work',
    date: '2026-10-28',
    start: '2026-10-28T13:10:37.000Z',
    stop: '2026-10-28T13:52:12.000Z',
    tags: [],
  }
  const d = nudge(draftOf(e), 15)
  expect(draftSeconds(d)).toBe(2495 + 900)
  expect(changesOf(e, d)?.edit).toEqual({ op: 'edit', id: 'e2', rev: 1, stop: '2026-10-28T14:07:12.000Z' })
  // a description alone: no time sent at all
  expect(changesOf(e, { ...draftOf(e), description: 'Case 10001 X: worked' })?.edit).toEqual({
    op: 'edit',
    id: 'e2',
    rev: 1,
    description: 'Case 10001 X: worked',
  })
  // the same HH:MM typed back over the stop: its seconds kept, nothing sent
  const shown = localClock(Date.parse(e.stop))
  expect(changesOf(e, typed(typed(draftOf(e), 'stop', '00:01'), 'stop', shown))?.edit).toBe(null)
  // a start typed after a stop it kept: not a time (it is not after the start)
  expect(draftTimes(typed(draftOf(e), 'start', '23:00'))).toBe(null)
})

test('a new entry: half an hour ending now today, 09:00 to 09:30 on another day; what adding it sends', () => {
  const now = new Date(2026, 9, 28, 14, 7, 30).getTime()
  expect(newDraft('client-a', 'Support', '2026-10-28', now)).toMatchObject({ start: '13:37', stop: '14:07' })
  const other = newDraft('client-a', 'Support', '2026-10-27', now)
  expect([other.start, other.stop]).toEqual(['09:00', '09:30'])
  expect(addOf({ ...other, description: 'Case 10001 X: work', tags: 'a, b' })).toEqual({
    op: 'add',
    client: 'client-a',
    project: 'Support',
    description: 'Case 10001 X: work',
    tags: ['a', 'b'],
    start: new Date(2026, 9, 27, 9, 0).toISOString(),
    stop: new Date(2026, 9, 27, 9, 30).toISOString(),
  })
})

test('a duration typed: a clock, minutes, hours with a point or a comma, units in English or Russian', () => {
  const cases: [string, number | null][] = [
    ['1:10', 4200],
    ['0:05', 300],
    ['70', 4200],
    ['1h10m', 4200],
    ['1h 10m', 4200],
    ['1ч 10м', 4200],
    ['1 ч 10 мин', 4200],
    ['1\u00a0ч\u00a010\u00a0мин', 4200],
    ['1h\u00a010m', 4200],
    ['45 мин', 2700],
    ['45m', 2700],
    ['2h', 7200],
    ['2 ч', 7200],
    ['1.5', 5400],
    ['1,5', 5400],
    ['1.5h', 5400],
    ['1,5 ч', 5400],
    ['.5', 1800],
    ['  90 min ', 5400],
    // to the minute
    ['1.33', 4800],
    // not one: nothing, words, a clock with a bad minute, under a minute, over a day
    ['', null],
    ['abc', null],
    ['1:75', null],
    ['1:5', null],
    ['h', null],
    ['0', null],
    ['0:00', null],
    ['0.01', null],
    ['25h', null],
    ['24:01', null],
  ]
  for (const [text, seconds] of cases) expect([text, parseDuration(text)]).toEqual([text, seconds])
  // 24 hours, the most an entry lasts, is one
  expect(parseDuration('24:00')).toBe(86_400)
})

test('a typed duration moves the stop from the start as it stands, its seconds kept; a bad start leaves it', () => {
  const e = {
    id: 'e1',
    rev: 1,
    client: 'client-a',
    project: 'Support',
    description: 'x',
    date: '2026-10-28',
    start: '2026-10-28T13:00:30Z',
    stop: '2026-10-28T13:40:30Z',
    tags: [],
  }
  const opened = draftOf(e)
  const longer = withDuration(opened, 4200)
  expect(new Date(longer.stopAt as number).toISOString()).toBe('2026-10-28T14:10:30.000Z')
  expect(draftSeconds(longer)).toBe(4200)
  // only the stop goes: the start keeps its seconds
  expect(changesOf(e, longer)?.edit).toEqual({
    op: 'edit',
    id: 'e1',
    rev: 1,
    stop: '2026-10-28T14:10:30.000Z',
  })
  // a new entry: its start plus the duration
  const fresh = withDuration(newDraft('client-a', 'Support', '2026-10-28', Date.parse('2026-11-05T12:00:00Z')), 5400)
  expect([fresh.start, fresh.stop, draftSeconds(fresh)]).toEqual(['09:00', '10:30', 5400])
  expect(withDuration({ ...opened, start: '9:7x', startAt: null }, 600)).toEqual({
    ...opened,
    start: '9:7x',
    startAt: null,
  })
})

test('tags as tokens: one added once, cleaned as the board keeps it; one taken off; the rest kept in order', () => {
  expect(tagOf(' #Deferred ')).toBe('deferred')
  expect(tagOf('a,b')).toBe('a b')
  expect(withTag('', 'call')).toBe('call')
  expect(withTag('call', '#Review')).toBe('call, review')
  expect(withTag('call, review', 'call')).toBe('call, review')
  expect(withTag('call', '  ')).toBe('call')
  expect(withoutTag('call, review, deferred', 'review')).toBe('call, deferred')
})

test('a line in a system: entered, partly, not, changed after; what a tap sends and what its Undo puts back', () => {
  const post = (system: string, rev: number, changedAfter = false, record: string | null = null) => ({
    system,
    at: 0,
    by: 'user' as const,
    record,
    rev,
    changedAfter,
  })
  const a = { id: 'a', rev: 3, posts: [post('erp', 3, false, 'TR-1')] }
  const b = { id: 'b', rev: 2, posts: [] }
  const c = { id: 'c', rev: 5, posts: [post('erp', 4, true, 'TR-3')] }
  expect([markState([a], 'erp'), markState([a, b], 'erp'), markState([b], 'erp'), markState([a, c], 'erp')]).toEqual([
    'entered',
    'partly',
    'not',
    'changed',
  ])
  // entered: off, Undo puts each back as it was
  expect(markPlan([a], 'erp')).toEqual({
    send: { op: 'unpost', system: 'erp', entries: [{ id: 'a', rev: 3 }] },
    undo: [{ op: 'post', system: 'erp', entries: [{ id: 'a', rev: 3, record: 'TR-1', asOf: 3 }] }],
  })
  // otherwise: the ones not entered and the ones changed after, marked now; Undo takes the new ones
  // off and puts the earlier ones back at the revision they recorded
  expect(markPlan([a, b, c], 'erp')).toEqual({
    send: {
      op: 'post',
      system: 'erp',
      entries: [
        { id: 'b', rev: 2 },
        { id: 'c', rev: 5 },
      ],
    },
    undo: [
      { op: 'unpost', system: 'erp', entries: [{ id: 'b', rev: 2 }] },
      { op: 'post', system: 'erp', entries: [{ id: 'c', rev: 5, record: 'TR-3', asOf: 4 }] },
    ],
  })
})

test('billed time not entered: a line with an entry missing in one of the systems; none to enter, none', () => {
  const day = {
    client: 'x',
    date: '2026-10-28',
    zone: 'UTC',
    held: [],
    nonBillable: [],
    seconds: 0,
    billedSeconds: 0,
    lines: [line({ entries: ['a'], billedSeconds: 1800 }), line({ entries: ['b'], billedSeconds: 3600 })],
  }
  const byId = new Map([
    [
      'a',
      {
        id: 'a',
        rev: 1,
        posts: [{ system: 'erp', at: 0, by: 'user' as const, record: null, rev: 1, changedAfter: false }],
      },
    ],
    ['b', { id: 'b', rev: 1, posts: [] }],
  ])
  expect(notEntered(day, byId, ['erp'])).toBe(3600)
  expect(notEntered(day, byId, ['erp', 'tracker'])).toBe(5400)
  expect(notEntered(day, byId, [])).toBe(0)
})

test('billable in the editor: set on the entry or the config’s; what saving sends of it', () => {
  expect([
    billableSet({ billable: false, billableDefault: false }),
    billableSet({ billable: false, billableDefault: true }),
    billableSet({}),
  ]).toEqual([false, null, null])
  const e = {
    id: 'e1',
    rev: 2,
    client: 'client-a',
    project: 'Support',
    description: 'x',
    date: '2026-10-28',
    start: '2026-10-28T13:00:00Z',
    stop: '2026-10-28T13:30:00Z',
    tags: [],
    billable: true,
    billableDefault: true,
  }
  const d = draftOf(e)
  expect(d.billable).toBe(null)
  expect(changesOf(e, d)?.edit).toBe(null)
  expect(changesOf(e, { ...d, billable: false })?.edit).toEqual({ op: 'edit', id: 'e1', rev: 2, billable: false })
  const set = { ...e, billable: false, billableDefault: false }
  expect(changesOf(set, { ...draftOf(set), billable: null })?.edit).toEqual({
    op: 'edit',
    id: 'e1',
    rev: 2,
    billable: null,
  })
  expect(addOf({ ...newDraft('client-a', 'Support', '2026-10-28'), billable: false })?.billable).toBe(false)
  expect('billable' in (addOf(newDraft('client-a', 'Support', '2026-10-28')) ?? {})).toBe(false)
})
