// Plain-board parity tests for shared schedule parsing and formatting helpers (#698).
import { expect, test } from 'bun:test'
import {
  formatEveryOk,
  formatRemindOk,
  fromNow,
  parseEveryRest,
  parseRemindRest,
  scheduleParts,
  stamp,
  waitsPart,
} from '../../src/core/schedule-cli.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0)

test('plain-board parity: parseRemindRest, parseEveryRest, and format helpers preserve exact outputs and errors', () => {
  const r = parseRemindRest(['in', '30m', 'check', 'tests'], NOW)
  expect(r).toEqual({ at: NOW + 30 * 60_000, text: 'check tests', idle: false })
  expect(formatRemindOk('abc123', r.at, NOW, r.idle, r.text)).toBe(
    `ok · reminder abc123 ${stamp(r.at)} (in 30 min): check tests · cancel: board unschedule abc123`,
  )

  const idleAfterDash = parseRemindRest(['--idle', 'in', '2h', '--', '--idle', 'literal'], NOW)
  expect(idleAfterDash).toEqual({ at: NOW + 120 * 60_000, text: '--idle literal', idle: true })
  expect(formatRemindOk('def456', idleAfterDash.at, NOW, idleAfterDash.idle, idleAfterDash.text)).toContain(
    '(in 2 h, when the session is free): --idle literal',
  )

  const ev = parseEveryRest(['0 9 * * 1-5', '--idle', 'standup'], NOW)
  expect(ev.cron.expr).toBe('0 9 * * 1-5')
  expect(ev.idle).toBe(true)
  expect(ev.text).toBe('standup')
  expect(formatEveryOk('ev1111', ev.cron.expr, ev.next, NOW, ev.idle, ev.text)).toContain(
    `ok · every ev1111 "0 9 * * 1-5", next ${stamp(ev.next)} (${fromNow(ev.next, NOW)}, when the session is free): standup`,
  )

  expect(() => parseRemindRest(['in', '10m'], NOW)).toThrow('usage: board remind')
  expect(() => parseRemindRest(['2020-01-01', '12:00', 'past'], NOW)).toThrow('is in the past')
  expect(() => parseRemindRest(['2035-01-01', '12:00', 'far'], NOW)).toThrow('more than five years ahead')
  expect(() => parseEveryRest(['*/2 * * * *', 'too fast'], NOW)).toThrow('more often than every 5 minutes')
  expect(() => parseEveryRest(['bad cron', 'hello'], NOW)).toThrow('board every')
})

test("#806 in the owner's zone: remind and every read and show its clock, wherever the board runs", () => {
  const zone = 'Asia/Yerevan' // NOW is Tue 16:00 there
  const r = parseRemindRest(['at', '15:30', 'call', 'back'], NOW, { zone })
  expect(r).toEqual({ at: Date.UTC(2026, 10, 25, 11, 30), text: 'call back', idle: false })
  expect(stamp(r.at, zone)).toBe('Wed 2026-11-25 15:30')
  expect(formatRemindOk('abc123', r.at, NOW, false, r.text, '', zone)).toBe(
    'ok · reminder abc123 Wed 2026-11-25 15:30 (in 23 h 30 min): call back · cancel: board unschedule abc123',
  )
  const ev = parseEveryRest(['57 7 * * *', 'monitor'], NOW, { zone })
  expect(ev.next).toBe(Date.UTC(2026, 10, 25, 3, 57))
  expect(formatEveryOk('ev1111', ev.cron.expr, ev.next, NOW, false, ev.text, '', zone)).toContain(
    'next Wed 2026-11-25 07:57 (in 15 h 57 min)',
  )
  expect(() => parseRemindRest(['today', '15:00', 'gone'], NOW, { zone })).toThrow(
    'Tue 2026-11-24 15:00 is in the past',
  )
})

test('#806 without a zone: the lines are the local ones, field for field', () => {
  const e = {
    id: 'aa11bb',
    key: 's1',
    text: 't',
    next: NOW + 3_600_000,
    cron: '0 9 * * *',
    idle: true,
  } as ScheduleEntry
  expect(scheduleParts(e, NOW)).toEqual(['aa11bb', `${stamp(e.next)} (in 1 h)`, 'every "0 9 * * *"', 'when free'])
  const { cron: _cron, ...once } = e
  expect(scheduleParts({ ...once, idle: false }, NOW).slice(2)).toEqual(['once', 'on time'])
  expect(waitsPart(e)).toBe('')
  expect(waitsPart({ ...e, pendingSince: NOW } as ScheduleEntry)).toBe(`due, waits for the session since ${stamp(NOW)}`)
  expect(stamp(NOW, undefined)).toBe(stamp(NOW))
})
