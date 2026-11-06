// Reminders at work in the board's process (#335, services/calendar-reminders.ts): off with the
// calendar or its reminders (no timer, nothing read or written, nothing in the payload); on, a
// reminder fires once, written down before it shows, so a board that starts again does not repeat
// it; Snooze, At start and dismiss from the page or the desktop; the desktop's words. The events,
// the desktop and the clock are the test's own; events are invented.
import { onTestFinished, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readReminders, remindersFile } from '../../src/adapters/reminder-store.ts'
import type { CalEvent } from '../../src/core/calendar.ts'
import { reminderId, reminderKey } from '../../src/core/calendar-reminders.ts'
import type { Config } from '../../src/core/types.ts'
import type { ReminderToast } from '../../src/integrations/reminder-toast.ts'
import { createCalendarReminders, whenText } from '../../src/services/calendar-reminders.ts'
import { calendarSettingsView, editCalendarSettings } from '../../src/services/calendar-settings.ts'
import { isolatedHome } from '../support/env.ts'

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
  join: 'https://meet.example.com/abc',
  ...over,
})

function setup(calendar: unknown, events: CalEvent[] = [ev()], at = START - 10 * MIN) {
  const cfg: Pick<Config, 'calendar'> = { calendar }
  const clock = { now: at }
  const shown: ReminderToast[] = []
  const cleared: string[] = []
  const reads: number[] = []
  let changes = 0
  const make = () =>
    createCalendarReminders({
      cfg,
      log: () => {},
      onChange: () => changes++,
      desktop: { show: t => shown.push(t), clear: id => cleared.push(id) },
      events: (_c, from) => {
        reads.push(from)
        return events
      },
      now: () => clock.now,
      zone: () => 'UTC',
    })
  const r = make()
  onTestFinished(() => r.stop())
  return { cfg, clock, shown, cleared, reads, changes: () => changes, r, make }
}

/** setTimeout counted while `fn` runs. */
function timersIn(fn: () => void): number {
  const real = globalThis.setTimeout
  let n = 0
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    n++
    return real(...args)
  }) as typeof setTimeout
  try {
    fn()
  } finally {
    globalThis.setTimeout = real
  }
  return n
}

const WORK = { sources: [{ id: 'work', kind: 'push', label: 'Work' }] }

test('the calendar off, or its reminders: no timer, nothing read or written, nothing for the payload', () => {
  isolatedHome()
  for (const calendar of [undefined, false, { on: false, ...WORK }, { ...WORK, reminders: false }]) {
    const s = setup(calendar)
    assert.equal(
      timersIn(() => {
        s.r.configChanged()
        s.r.changed()
      }),
      0,
    )
    assert.equal(s.r.line(), null)
    assert.deepEqual(s.r.act(reminderId(reminderKey(ev())), 'snooze'), { ok: false, code: 'off' })
    assert.deepEqual([s.reads, s.shown, s.changes()], [[], [], 0])
    assert.equal(existsSync(remindersFile()), false)
  }
})

test('on: it fires once at its time, written down first, on the desktop and in the payload; a board started again does not repeat it', () => {
  isolatedHome()
  const s = setup(WORK)
  s.r.configChanged()
  assert.equal(s.shown.length, 1)
  const toast = s.shown[0]
  assert.ok(toast)
  assert.deepEqual(
    { ...toast, labels: toast.labels },
    {
      id: reminderId(reminderKey(ev())),
      title: 'Standup',
      body: 'in 10 min · 14:30 - 15:00',
      whose: 'Work',
      join: 'https://meet.example.com/abc',
      expires: START + 10 * MIN,
      labels: { join: 'Join', open: 'Open', snooze: 'Snooze 5 min', start: 'At start' },
    },
  )
  assert.ok(readReminders().items[reminderKey(ev())]?.shown)
  const line = s.r.line()
  assert.equal(line?.snoozeMin, 5)
  assert.deepEqual(line?.items, [
    {
      id: toast.id,
      source: 'work',
      event: 'standup',
      title: 'Standup',
      start: ev().start,
      end: ev().end,
      join: 'https://meet.example.com/abc',
      label: 'Work',
      kind: 'push',
      color: null,
      lane: null,
    },
  ])
  assert.equal(s.changes(), 1)
  // looked at again: nothing new
  s.clock.now += MIN
  s.r.configChanged()
  assert.equal(s.shown.length, 1)
  assert.equal(s.changes(), 1)
  // the board started again
  s.r.stop()
  const again = s.make()
  onTestFinished(() => again.stop())
  again.configChanged()
  assert.equal(s.shown.length, 1)
  assert.equal(again.line()?.items.length, 1, 'still on show after the restart, not shown again')
})

test('it reads only what a reminder may come from: back a while, ahead as far as the longest lead', () => {
  isolatedHome()
  const s = setup({ sources: [{ id: 'work', kind: 'push', remindMin: 45 }] }, [ev()], START - 50 * MIN)
  s.r.configChanged()
  assert.deepEqual(s.shown, [])
  assert.equal(s.reads.length, 1)
  assert.equal(s.r.line(), null)
})

test('Snooze from the page: off the desktop and the payload, back after the snooze; from the desktop its toast is left to Windows', () => {
  isolatedHome()
  const s = setup(WORK)
  s.r.configChanged()
  const id = reminderId(reminderKey(ev()))
  const done = s.r.act(id, 'snooze')
  assert.deepEqual(done, {
    ok: true,
    event: { source: 'work', id: 'standup', start: ev().start },
    join: 'https://meet.example.com/abc',
  })
  assert.deepEqual(s.cleared, [id])
  assert.equal(s.r.line(), null)
  s.clock.now += 5 * MIN
  s.r.configChanged()
  assert.equal(s.shown.length, 2)
  assert.equal(s.shown[1]?.body, 'in 5 min · 14:30 - 15:00')
  assert.equal(s.r.line()?.items.length, 1)
  // At start, from the notification's button
  assert.equal(s.r.act(id, 'start', { desktop: true }).ok, true)
  assert.deepEqual(s.cleared, [id])
  s.clock.now = START
  s.r.configChanged()
  assert.equal(s.shown.length, 3)
  assert.equal(s.shown[2]?.body, 'starting now · 14:30 - 15:00')
  assert.equal(s.shown[2]?.labels.start, undefined, 'no At start once it starts')
})

test('dismiss and Join are the end of it; Open changes nothing; an id no event has is gone', () => {
  isolatedHome()
  const s = setup(WORK)
  s.r.configChanged()
  const id = reminderId(reminderKey(ev()))
  assert.equal(s.r.act(id, 'open').ok, true)
  assert.equal(s.r.line()?.items.length, 1)
  assert.deepEqual(s.cleared, [])
  assert.equal(s.r.act(id, 'join').ok, true)
  assert.equal(s.r.line(), null)
  s.clock.now += 20 * MIN
  s.r.configChanged()
  assert.equal(s.shown.length, 1)
  assert.deepEqual(s.r.act('AAAAAAAAAAAAAAAA', 'dismiss'), { ok: false, code: 'gone' })
})

test('turned off while one is on show: it goes from the payload and the timer stops', () => {
  isolatedHome()
  const s = setup(WORK)
  s.r.configChanged()
  assert.equal(s.r.line()?.items.length, 1)
  s.cfg.calendar = { ...WORK, reminders: false }
  assert.equal(
    timersIn(() => s.r.configChanged()),
    0,
  )
  assert.equal(s.r.line(), null)
  assert.equal(s.changes(), 2)
})

test('the desktop’s words: when, in the board’s language, from minutes ahead to started a while ago', () => {
  const e = { start: new Date(START).toISOString(), end: new Date(START + 45 * MIN).toISOString() }
  assert.equal(whenText(e, START - 90 * MIN, 'UTC'), 'in 2 hours · 14:30 - 15:15')
  assert.equal(whenText(e, START - 10 * MIN, 'UTC'), 'in 10 min · 14:30 - 15:15')
  assert.equal(whenText(e, START, 'UTC'), 'starting now · 14:30 - 15:15')
  assert.equal(whenText(e, START + 3 * MIN, 'UTC'), 'started 3 min ago · 14:30 - 15:15')
  assert.equal(whenText({ start: e.start, end: e.start }, START - MIN, 'Asia/Tbilisi'), 'in 1 min · 18:30')
})

test('Settings → Calendar: reminders on or off, minutes before, the snooze, and a source’s own minutes, in config.json', () => {
  const dir = isolatedHome()
  const file = () =>
    JSON.parse(readFileSync(join(dir, 'config', 'herdr', 'plugins', 'config', 'agent-board', 'config.json'), 'utf8'))
      .calendar
  assert.equal(editCalendarSettings({ op: 'on', on: true }).ok, true)
  assert.equal(editCalendarSettings({ op: 'add', kind: 'push', source: { label: 'Work' } }).ok, true)
  const view = () => calendarSettingsView((_c, fn) => fn(null))
  assert.deepEqual(view().reminders, { on: true, beforeMin: 10, snoozeMin: 5 })
  assert.equal('reminders' in file(), false, 'nothing written while nothing was set')

  assert.equal(editCalendarSettings({ op: 'reminders', beforeMin: 15, snoozeMin: 10 }).ok, true)
  assert.deepEqual(file().reminders, { beforeMin: 15, snoozeMin: 10 })
  assert.equal(editCalendarSettings({ op: 'reminders', on: false }).ok, true)
  assert.deepEqual(file().reminders, { beforeMin: 15, snoozeMin: 10, on: false })
  assert.equal(view().reminders.on, false)
  assert.equal(editCalendarSettings({ op: 'reminders', on: true }).ok, true)
  assert.deepEqual(file().reminders, { beforeMin: 15, snoozeMin: 10 })
  const bad = editCalendarSettings({ op: 'reminders', beforeMin: 0 })
  assert.equal(bad.ok, false)
  assert.equal(file().reminders.beforeMin, 15, 'a refused change leaves the file as it was')
  assert.equal(editCalendarSettings({ op: 'reminders' }).ok, false)

  // a source's own: minutes, none (0), back to the calendar's (null)
  assert.equal(editCalendarSettings({ op: 'edit', id: 'work', source: { remindMin: 30 } }).ok, true)
  assert.equal(file().sources[0].remindMin, 30)
  assert.equal(view().sources.find(s => s.id === 'work')?.remindMin, 30)
  assert.equal(editCalendarSettings({ op: 'edit', id: 'work', source: { remindMin: 0 } }).ok, true)
  assert.equal(file().sources[0].remindMin, 0)
  assert.equal(editCalendarSettings({ op: 'edit', id: 'work', source: { remindMin: null } }).ok, true)
  assert.equal('remindMin' in file().sources[0], false)
  assert.equal(editCalendarSettings({ op: 'edit', id: 'work', source: { remindMin: 5000 } }).ok, false)
  // the board's own calendar takes one too
  assert.equal(editCalendarSettings({ op: 'edit', id: 'board', source: { remindMin: 5 } }).ok, true)
  assert.equal(view().sources.find(s => s.id === 'board')?.remindMin, 5)
})
