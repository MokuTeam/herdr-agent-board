// The Calendar panel's rules (#328, web/src/models/calendar.ts) and where an event's card goes.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { CalEvent } from '../../src/core/calendar.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { cardPlace } from '../../web/src/components/calendar/CalendarViews.tsx'
import {
  agoText,
  callSoon,
  datesOf,
  eventTone,
  isBar,
  isCalAnswer,
  joinProvider,
  sourceColors,
  sourceLabel,
  stepDate,
  untilText,
  viewDays,
  viewTitle,
  viewWindow,
  weekStartFor,
} from '../../web/src/models/calendar.ts'

const en = translator('en')
const ru = translator('ru')
const ev = (o: Partial<CalEvent>): CalEvent => ({
  source: 's',
  id: 'x',
  title: 'T',
  start: '2026-11-04T10:00:00Z',
  end: '2026-11-04T11:00:00Z',
  allDay: false,
  status: 'confirmed',
  ...o,
})

test('views: the days each shows, the window it asks for, where the arrows go, its title', () => {
  assert.deepEqual(viewDays('day', '2026-11-04', 1), ['2026-11-04'])
  assert.deepEqual(viewDays('week', '2026-11-04', 1), [
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
    '2026-11-05',
    '2026-11-06',
    '2026-11-07',
    '2026-11-08',
  ])
  assert.equal(viewDays('week', '2026-11-04', 0)[0], '2026-11-01')
  assert.equal(viewDays('agenda', '2026-11-04', 1).length, 14)
  assert.equal(viewDays('month', '2026-11-04', 1).length, 42)
  const w = viewWindow('week', '2026-11-04', 1)
  assert.equal(w.to - w.from >= 7 * 86_400_000 - 3_600_000, true)
  assert.equal(stepDate('month', '2026-01-31', 1), '2026-02-28')
  assert.equal(stepDate('week', '2026-11-04', -1), '2026-10-28')
  assert.equal(stepDate('agenda', '2026-11-04', 1), '2026-11-18')
  assert.equal(viewTitle('month', '2026-11-04', 1, 'en'), 'November 2026')
  assert.equal(viewTitle('week', '2026-11-04', 1, 'en'), '2 - November 8, 2026')
  assert.match(viewTitle('week', '2026-11-04', 1, 'ru'), /^2 - 8 ноября 2026/)
  assert.match(viewTitle('week', '2026-10-28', 1, 'en'), /^Oct 26 - Nov 1, 2026$/)
  assert.equal(weekStartFor('ru'), 1)
  assert.equal(weekStartFor('en-US'), 0)
})

test('sources: their own colour, else their lane’s, else the panel’s; labels; the board’s own grey', () => {
  const lanes = [{ id: 'acme', title: 'Acme', color: '#007AFF' }]
  const colors = sourceColors(
    [
      { id: 'board', kind: 'board', color: null, lane: null },
      { id: 'a', kind: 'mcp', color: '#112233', lane: 'acme' },
      { id: 'b', kind: 'mcp', color: null, lane: 'acme' },
      { id: 'c', kind: 'ics', color: null, lane: null },
    ],
    lanes,
  )
  assert.deepEqual([...colors.values()], ['#8e8e93', '#112233', '#007AFF', '#5e5ce6'])
  assert.equal(sourceLabel({ id: 'board', kind: 'board', label: '', lane: null }, lanes, en), 'Board')
  assert.equal(sourceLabel({ id: 'board', kind: 'board', label: '', lane: null }, lanes, ru), 'Доска')
  assert.equal(sourceLabel({ id: 'b', kind: 'mcp', label: 'b', lane: 'acme' }, lanes, en), 'Acme')
  assert.equal(sourceLabel({ id: 'b', kind: 'mcp', label: 'Work', lane: 'acme' }, lanes, en), 'Work')
})

test('events: tone, bars, dates, a call soon, how long until, providers', () => {
  assert.equal(eventTone(ev({ response: 'declined' })), 'declined')
  assert.equal(eventTone(ev({ status: 'cancelled' })), 'declined')
  assert.equal(eventTone(ev({ response: 'needsAction' })), 'pending')
  assert.equal(eventTone(ev({ kind: 'workingLocation' })), 'quiet')
  assert.equal(eventTone(ev({})), 'normal')
  assert.equal(isBar(ev({ allDay: true, start: '2026-11-04', end: '2026-11-05' })), true)
  assert.equal(isBar(ev({ end: '2026-11-05T12:00:00Z' })), true)
  assert.equal(isBar(ev({})), false)
  assert.deepEqual(datesOf(ev({ allDay: true, start: '2026-11-04', end: '2026-11-07' })), {
    first: '2026-11-04',
    last: '2026-11-06',
  })
  const start = Date.parse('2026-11-04T10:00:00Z')
  assert.equal(callSoon(ev({}), start - 9 * 60_000), true)
  assert.equal(callSoon(ev({}), start - 11 * 60_000), false)
  assert.equal(callSoon(ev({}), start + 70 * 60_000), false)
  assert.equal(untilText(start, start + 3_600_000, start - 12 * 60_000, en), 'in 12 min')
  assert.equal(untilText(start, start + 3_600_000, start + 1, ru), 'идёт')
  assert.equal(untilText(start, start + 3_600_000, start - 3 * 3_600_000, ru), 'через 3 часа')
  assert.equal(agoText(null, start, en), 'never')
  assert.equal(agoText(start - 5 * 60_000, start, ru), '5 мин назад')
  assert.equal(joinProvider('https://meet.google.com/abc-defg-hij'), 'Meet')
  assert.equal(joinProvider('https://acme.zoom.us/j/1'), 'Zoom')
  assert.equal(joinProvider('https://teams.microsoft.com/l/meetup-join/x'), 'Teams')
  assert.equal(joinProvider('https://example.com/x'), '')
})

test('an event’s card: beside what was tapped where there is room, else under it, always in the window', () => {
  const view = { width: 1000, height: 800 }
  const size = { width: 300, height: 200 }
  assert.deepEqual(cardPlace({ left: 100, right: 200, top: 50, bottom: 80 }, size, view), { left: 208, top: 50 })
  assert.deepEqual(cardPlace({ left: 800, right: 900, top: 50, bottom: 80 }, size, view), { left: 492, top: 50 })
  // no room either side (a phone): under it
  assert.deepEqual(cardPlace({ left: 20, right: 380, top: 100, bottom: 140 }, size, { width: 390, height: 800 }), {
    left: 20,
    top: 148,
  })
  // low on the screen: kept in it
  assert.equal(cardPlace({ left: 100, right: 200, top: 700, bottom: 730 }, size, view).top, 592)
})

test('the board’s answer is checked before it is drawn', () => {
  assert.equal(isCalAnswer({ from: 1, to: 2, events: [], sources: [], busy: [] }), true)
  assert.equal(isCalAnswer({ ok: false, error: 'off' }), false)
})
