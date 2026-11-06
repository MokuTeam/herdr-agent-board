// Reminders before events (#335, core/calendar-reminders.ts and core/calendar.ts's settings):
// which events get one and when, a source's own minutes, what Snooze and dismiss do, the grace
// after the board comes up, an event moved or gone, and the state kept no longer than needed.
// Events are invented.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { type CalEvent, calendarConfig } from '../../src/core/calendar.ts'
import {
  actOn,
  GRACE_MS,
  isReminderState,
  KEEP_MS,
  LINGER_MS,
  NO_REMINDERS,
  planReminders,
  REMINDER_ID,
  type ReminderState,
  reminderId,
  reminderKey,
  shownAt,
} from '../../src/core/calendar-reminders.ts'

const MIN = 60_000
const START = Date.parse('2026-11-06T14:30:00Z')

const ev = (over: Partial<CalEvent> = {}): CalEvent => ({
  source: 'work',
  id: 'standup',
  title: 'Standup',
  start: new Date(START).toISOString(),
  end: new Date(START + 30 * MIN).toISOString(),
  allDay: false,
  status: 'confirmed',
  ...over,
})

const config = (raw: Record<string, unknown> = {}) => {
  const c = calendarConfig({ sources: [{ id: 'work', kind: 'push' }], ...raw })
  assert.ok(c)
  return c
}

const fired = (plan: ReturnType<typeof planReminders>) => plan.fire.map(r => r.event.id)
const active = (plan: ReturnType<typeof planReminders>) => plan.active.map(r => r.event.id)

test('settings: on with the calendar, 10 minutes before and a 5 minute snooze unless config.json says', () => {
  assert.deepEqual(config().reminders, { on: true, beforeMin: 10, snoozeMin: 5 })
  assert.deepEqual(calendarConfig(true)?.reminders, { on: true, beforeMin: 10, snoozeMin: 5 })
  assert.equal(config({ reminders: false }).reminders.on, false)
  assert.equal(config({ reminders: { on: false } }).reminders.on, false)
  assert.deepEqual(config({ reminders: { beforeMin: 15, snoozeMin: 10 } }).reminders, {
    on: true,
    beforeMin: 15,
    snoozeMin: 10,
  })
  const bad = config({ reminders: { beforeMin: 0, snoozeMin: 'x', later: 1 } })
  assert.deepEqual(bad.reminders, { on: true, beforeMin: 10, snoozeMin: 5 })
  assert.deepEqual(
    bad.problems.map(p => `${p.at} ${p.why}`),
    ['calendar.reminders.later unknown', 'calendar.reminders.beforeMin range', 'calendar.reminders.snoozeMin range'],
  )
  assert.equal(config({ reminders: 'soon' }).problems[0]?.at, 'calendar.reminders')
  // the calendar off is off: nothing of it is read
  assert.equal(calendarConfig({ on: false, reminders: { beforeMin: 15 } }), null)
})

test('settings: a source’s own minutes, 0 or false for none, the board’s own too; a config without them reads as before', () => {
  const c = calendarConfig({
    sources: [
      { id: 'work', kind: 'push', remindMin: 30 },
      { id: 'home', kind: 'push', remindMin: 0 },
      { id: 'gym', kind: 'push', remindMin: false },
      { id: 'odd', kind: 'push', remindMin: -3 },
      { id: 'plain', kind: 'push' },
      { kind: 'board', remindMin: 5 },
    ],
  })
  assert.ok(c)
  const by = Object.fromEntries(c.sources.map(s => [s.id, s.remindMin]))
  assert.deepEqual(by, { board: 5, work: 30, home: 0, gym: 0, odd: null, plain: null })
  assert.deepEqual(
    c.sources.find(s => s.id === 'odd')?.problems.map(p => p.at),
    ['calendar.sources.3.remindMin'],
  )
  // a config of #329's time: the same sources and no problem
  const before = calendarConfig({ everyMin: 5, sources: [{ id: 'work', kind: 'ics', label: 'Work' }] })
  assert.ok(before)
  assert.deepEqual(before.problems, [])
  assert.deepEqual(before.sources[1]?.problems, [])
})

test('a reminder fires N minutes before the start, not before; once shown it does not fire again', () => {
  const c = config()
  const e = ev()
  const early = planReminders(c, [e], NO_REMINDERS, START - 10 * MIN - 1)
  assert.deepEqual(fired(early), [])
  assert.equal(early.next, START - 10 * MIN)
  const due = planReminders(c, [e], NO_REMINDERS, START - 10 * MIN)
  assert.deepEqual(fired(due), ['standup'])
  const state = shownAt(NO_REMINDERS, [reminderKey(e)], START - 10 * MIN)
  const again = planReminders(c, [e], state, START - 9 * MIN)
  assert.deepEqual(fired(again), [])
  assert.deepEqual(active(again), ['standup'])
})

test('a source’s own minutes win, 0 turns its reminders off, and reminders off is none at all', () => {
  const c = calendarConfig({
    sources: [
      { id: 'work', kind: 'push', remindMin: 30 },
      { id: 'home', kind: 'push', remindMin: 0 },
    ],
  })
  assert.ok(c)
  const work = ev()
  const home = ev({ source: 'home', id: 'dinner' })
  assert.deepEqual(fired(planReminders(c, [work, home], NO_REMINDERS, START - 30 * MIN)), ['standup'])
  assert.deepEqual(fired(planReminders(c, [work, home], NO_REMINDERS, START - 5 * MIN)), ['standup'])
  const off = config({ reminders: false })
  const plan = planReminders(off, [work], NO_REMINDERS, START - 5 * MIN)
  assert.deepEqual(plan, { fire: [], active: [], next: null })
})

test('all-day, cancelled, declined and not-a-meeting events get none; tentative and unanswered do', () => {
  const c = config()
  const list = [
    ev({ id: 'allday', allDay: true, start: '2026-11-06', end: '2026-11-07' }),
    ev({ id: 'cancelled', status: 'cancelled' }),
    ev({ id: 'declined', response: 'declined' }),
    ev({ id: 'office', kind: 'workingLocation' }),
    ev({ id: 'ooo', kind: 'outOfOffice' }),
    ev({ id: 'focus', kind: 'focusTime' }),
    ev({ id: 'maybe', response: 'tentative' }),
    ev({ id: 'asked', response: 'needsAction' }),
    ev({ id: 'tentative', status: 'tentative' }),
  ]
  assert.deepEqual(fired(planReminders(c, list, NO_REMINDERS, START - 5 * MIN)), ['maybe', 'asked', 'tentative'])
})

test('an event moved after its reminder showed is a new one at its new time; one gone fires nothing', () => {
  const c = config()
  const e = ev()
  const state = shownAt(NO_REMINDERS, [reminderKey(e)], START - 10 * MIN)
  const moved = ev({ start: new Date(START + 60 * MIN).toISOString(), end: new Date(START + 90 * MIN).toISOString() })
  const plan = planReminders(c, [moved], state, START - 5 * MIN)
  assert.deepEqual(fired(plan), [])
  assert.deepEqual(active(plan), [], 'the old time’s reminder is no longer on show')
  assert.equal(plan.next, START + 50 * MIN)
  assert.deepEqual(fired(planReminders(c, [moved], state, START + 50 * MIN)), ['standup'])
  // the same time written in another offset is the same reminder
  const same = ev({ start: '2026-11-06T17:30:00+03:00' })
  assert.equal(reminderKey(same), reminderKey(e))
  // deleted (no longer among the events): nothing fires, nothing on show
  assert.deepEqual(planReminders(c, [], state, START - 5 * MIN), { fire: [], active: [], next: null })
})

test('Snooze puts it off for the snooze, At start until the start; it fires again then, once', () => {
  const c = config()
  const e = ev()
  const key = reminderKey(e)
  const shown = shownAt(NO_REMINDERS, [key], START - 10 * MIN)
  const snoozed = actOn(shown, key, START, 'snooze', 5, START - 9 * MIN)
  const quiet = planReminders(c, [e], snoozed, START - 8 * MIN)
  assert.deepEqual([fired(quiet), active(quiet)], [[], []])
  assert.equal(quiet.next, START - 4 * MIN)
  assert.deepEqual(fired(planReminders(c, [e], snoozed, START - 4 * MIN)), ['standup'])
  const back = shownAt(snoozed, [key], START - 4 * MIN)
  assert.equal(back.items[key]?.snooze, undefined)
  assert.deepEqual(fired(planReminders(c, [e], back, START - 3 * MIN)), [])
  // At start
  const atStart = actOn(shown, key, START, 'start', 5, START - 9 * MIN)
  assert.equal(atStart.items[key]?.snooze, START)
  assert.equal(planReminders(c, [e], atStart, START - 8 * MIN).next, START)
  assert.deepEqual(fired(planReminders(c, [e], atStart, START)), ['standup'])
  // At start a minute or less before it is a plain snooze
  assert.equal(actOn(shown, key, START, 'start', 5, START - 30_000).items[key]?.snooze, START - 30_000 + 5 * MIN)
})

test('dismiss and Join are done with it: it neither fires again nor stays on show', () => {
  const c = config()
  const e = ev()
  const key = reminderKey(e)
  for (const act of ['dismiss', 'join'] as const) {
    const done = actOn(shownAt(NO_REMINDERS, [key], START - 10 * MIN), key, START, act, 5, START - 9 * MIN)
    assert.deepEqual(planReminders(c, [e], done, START - 8 * MIN), { fire: [], active: [], next: null })
    assert.deepEqual(planReminders(c, [e], done, START + 60 * MIN), { fire: [], active: [], next: null })
  }
  // a snoozed one dismissed: its snooze goes too
  const snoozed = actOn(shownAt(NO_REMINDERS, [key], START - 10 * MIN), key, START, 'snooze', 5, START - 9 * MIN)
  const done = actOn(snoozed, key, START, 'dismiss', 5, START - 8 * MIN)
  assert.equal(done.items[key]?.snooze, undefined)
  assert.deepEqual(fired(planReminders(c, [e], done, START - 4 * MIN)), [])
})

test('the board coming up late: a reminder still fires within the grace after the start, never later', () => {
  const c = config()
  const e = ev()
  assert.deepEqual(fired(planReminders(c, [e], NO_REMINDERS, START - 2 * MIN)), ['standup'])
  assert.deepEqual(fired(planReminders(c, [e], NO_REMINDERS, START + GRACE_MS)), ['standup'])
  assert.deepEqual(fired(planReminders(c, [e], NO_REMINDERS, START + GRACE_MS + 1)), [])
  // a snooze that ended while the board was down: within the grace of its end only
  const key = reminderKey(e)
  const snoozed = actOn(shownAt(NO_REMINDERS, [key], START - 10 * MIN), key, START, 'snooze', 5, START - 9 * MIN)
  assert.deepEqual(fired(planReminders(c, [e], snoozed, START - 4 * MIN + GRACE_MS)), ['standup'])
  assert.deepEqual(fired(planReminders(c, [e], snoozed, START - 4 * MIN + GRACE_MS + 1)), [])
})

test('a reminder on show stays until LINGER_MS after the start (or its last showing), and the look after says when it goes', () => {
  const c = config()
  const e = ev()
  const key = reminderKey(e)
  const state = shownAt(NO_REMINDERS, [key], START - 10 * MIN)
  const on = planReminders(c, [e], state, START + LINGER_MS - 1)
  assert.deepEqual(active(on), ['standup'])
  assert.equal(on.next, START + LINGER_MS)
  assert.deepEqual(active(planReminders(c, [e], state, START + LINGER_MS)), [])
  // one shown after the start (a snooze) lingers from then
  const late = shownAt(NO_REMINDERS, [key], START + 4 * MIN)
  assert.deepEqual(active(planReminders(c, [e], late, START + LINGER_MS + 1)), ['standup'])
  // fired now: the plan looks again as it would go
  assert.equal(planReminders(c, [e], NO_REMINDERS, START - 10 * MIN).next, START + LINGER_MS)
})

test('the state keeps a reminder two days after its start, reads back only when it is one, and ids are short and plain', () => {
  const e = ev()
  const old = ev({ id: 'old', start: new Date(START - KEEP_MS - MIN).toISOString() })
  const state: ReminderState = shownAt(NO_REMINDERS, [reminderKey(old), reminderKey(e)], START - KEEP_MS - MIN)
  assert.deepEqual(Object.keys(shownAt(state, [], START).items), [reminderKey(e)])
  assert.ok(isReminderState({ items: {} }))
  assert.ok(isReminderState(state))
  assert.equal(isReminderState({ items: { a: { shown: 'x' } } }), false)
  assert.equal(isReminderState([]), false)
  const id = reminderId(reminderKey(e))
  assert.match(id, REMINDER_ID)
  assert.equal(id, reminderId(reminderKey(ev())))
  assert.notEqual(id, reminderId(reminderKey(ev({ id: 'other' }))))
  assert.ok(!id.includes('Standup') && !id.includes('work'))
})
