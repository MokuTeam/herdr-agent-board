// Plain-board parity tests for shared schedule parsing and formatting helpers (#698).
import { expect, test } from 'bun:test'
import {
  formatEveryOk,
  formatRemindOk,
  fromNow,
  parseEveryRest,
  parseRemindRest,
  stamp,
} from '../../src/core/schedule-cli.ts'

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
