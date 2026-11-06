// A week's and a month's figures (#241, core/time.ts spanDays): each day with each client's time
// worked, billed by its rules and billed not entered yet; a day is an entry's work date as stored
// (its start's date in its client's zone), an entry over midnight counting whole on the day it
// started; a total adds billed days up and never rounds again.
import { expect, test } from 'bun:test'
import {
  dateIn,
  type EntryPost,
  entryView,
  spanDays,
  spanLength,
  type TimeConfig,
  type TimeEntry,
  timeConfig,
  zoneOf,
} from '../../src/core/time.ts'

const conf = timeConfig({
  zone: 'America/New_York',
  clients: {
    // rounded up to 30 minutes per case and day; entered in an ERP and a tracker, its Internal
    // project not billed, its Ops project entered in the ERP only
    a: {
      projects: ['Support', 'Internal', 'Ops'],
      nonBillable: ['Internal'],
      systems: ['erp', 'tracker'],
      projectSystems: { Ops: ['erp'] },
      billing: [{ group: 'ref', step: 30, round: 'up' }],
    },
    // a day ahead of New York: Tokyo's
    east: { projects: ['Support'], zone: 'Asia/Tokyo' },
    // never billed: worked only
    own: { billable: false },
  },
}) as TimeConfig

let n = 0
/** An entry as the store writes it: its work date its start's in its client's zone. */
function entry(client: string, project: string, description: string, start: string, minutes: number, more = {}) {
  const at = Date.parse(start)
  const e: TimeEntry = {
    id: `e${++n}`,
    client,
    project,
    description,
    tags: [],
    start: new Date(at).toISOString(),
    stop: new Date(at + minutes * 60_000).toISOString(),
    date: dateIn(at, zoneOf(conf, client)),
    by: 'user',
    at: 0,
    changed: 0,
    changedBy: 'user',
    rev: 1,
    ...more,
  }
  return e
}
const post = (system: string, rev = 1): EntryPost => ({ system, at: 0, by: 'user', record: null, rev })
const view = (e: TimeEntry, posts: EntryPost[] = []) => entryView(conf, e, posts)
const fig = (days: ReturnType<typeof spanDays>, date: string, client: string) =>
  days.find(d => d.date === date)?.clients.find(c => c.client === client)

test('every day of the span is there, in order, with no time where there is none', () => {
  const days = spanDays(conf, '2026-11-02', '2026-11-08', [])
  expect(days.map(d => d.date)).toEqual([
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
    '2026-11-05',
    '2026-11-06',
    '2026-11-07',
    '2026-11-08',
  ])
  expect(days.every(d => d.entries === 0 && d.clients.length === 0)).toBe(true)
})

test('the days are counted, not compared as text: the last days a date can have end the span (a review of #241)', () => {
  expect(spanLength('2026-11-01', '2026-11-30')).toBe(30)
  expect(spanLength('2026-11-02', '2026-11-01')).toBe(0)
  expect(spanLength('nope', '2026-11-01')).toBe(0)
  // past 9999-12-31 the next date is no date ("+010000-01"), which sorts before it as text
  expect(spanDays(conf, '9999-12-30', '9999-12-31', []).map(d => d.date)).toEqual(['9999-12-30', '9999-12-31'])
  // a month across a change of clock (DST in New York on 1 November): each day once
  expect(spanDays(conf, '2026-10-31', '2026-11-02', []).map(d => d.date)).toEqual([
    '2026-10-31',
    '2026-11-01',
    '2026-11-02',
  ])
})

test('each client’s day billed by its rules; a week adds its billed days up and never rounds the sum again', () => {
  // two days of 10 minutes on a case: each day billed 30 minutes; the week 60, not 20 rounded to 30
  const days = spanDays(conf, '2026-11-02', '2026-11-08', [
    view(entry('a', 'Support', 'Case 10001 X: one', '2026-11-02T14:00:00Z', 10)),
    view(entry('a', 'Support', 'Case 10001 X: two', '2026-11-03T14:00:00Z', 10)),
  ])
  expect(fig(days, '2026-11-02', 'a')).toMatchObject({ seconds: 600, billedSeconds: 1800 })
  expect(fig(days, '2026-11-03', 'a')).toMatchObject({ seconds: 600, billedSeconds: 1800 })
  const week = days.reduce((s, d) => s + d.clients.reduce((x, c) => x + c.billedSeconds, 0), 0)
  expect(week).toBe(3600)
})

test('billable and worked apart: a non-billable project and a never billed lane are worked, not billed; a held entry is neither, yet the day has time', () => {
  const held = entry('a', 'Support', 'Case 10002 X: later', '2026-11-04T16:00:00Z', 45, { tags: ['deferred'] })
  const days = spanDays(conf, '2026-11-04', '2026-11-04', [
    view(entry('a', 'Support', 'Case 10001 X: fix', '2026-11-04T14:00:00Z', 40)),
    view(entry('a', 'Internal', 'Team call', '2026-11-04T15:00:00Z', 20)),
    view(held),
    view(entry('own', 'Blog', 'Writing', '2026-11-04T18:00:00Z', 90)),
  ])
  expect(fig(days, '2026-11-04', 'a')).toMatchObject({ seconds: 3600, billedSeconds: 3600 })
  expect(fig(days, '2026-11-04', 'own')).toMatchObject({ seconds: 5400, billedSeconds: 0, notEntered: 0 })
  expect(days[0]?.entries).toBe(4)
  // only a held entry: no figures, but the day is not one with no time
  const only = spanDays(conf, '2026-11-04', '2026-11-04', [view(held)])
  expect(only[0]?.entries).toBe(1)
  expect(only[0]?.clients[0]).toMatchObject({ seconds: 0, billedSeconds: 0 })
})

test('time zones: a day is the work date stamped in the client’s zone, not the board’s or this computer’s', () => {
  // 20:00 UTC on 28 October: 16:00 in New York, 05:00 on the 29th in Tokyo
  const at = '2026-10-28T20:00:00Z'
  const days = spanDays(conf, '2026-10-28', '2026-10-29', [
    view(entry('east', 'Support', 'Case 10003: east', at, 60)),
    view(entry('a', 'Support', 'Case 10004 X: west', at, 60)),
  ])
  expect(fig(days, '2026-10-28', 'a')?.seconds).toBe(3600)
  expect(fig(days, '2026-10-28', 'east')).toBeUndefined()
  expect(fig(days, '2026-10-29', 'east')?.seconds).toBe(3600)
  // a work date moved by hand (board time move) is where it counts
  const moved = { ...entry('a', 'Support', 'Case 10005 X: moved', at, 30), date: '2026-10-29' }
  expect(fig(spanDays(conf, '2026-10-28', '2026-10-29', [view(moved)]), '2026-10-29', 'a')?.seconds).toBe(1800)
})

test('an entry over midnight counts whole on the day it started, nothing on the next', () => {
  // 23:30 to 01:00 in New York
  const days = spanDays(conf, '2026-11-02', '2026-11-03', [
    view(entry('a', 'Support', 'Case 10006 X: late', '2026-11-03T04:30:00Z', 90)),
  ])
  expect(days[0]?.date).toBe('2026-11-02')
  expect(fig(days, '2026-11-02', 'a')).toMatchObject({ seconds: 5400, billedSeconds: 5400 })
  expect(days[1]?.entries).toBe(0)
})

test('not entered: billed lines missing a mark in a system their entries are to be entered in; removed entries left out', () => {
  const a = entry('a', 'Support', 'Case 10001 X: one', '2026-11-05T14:00:00Z', 20)
  const b = entry('a', 'Support', 'Case 10002 X: two', '2026-11-05T15:00:00Z', 20)
  const ops = entry('a', 'Ops', 'Case 10003 X: ops', '2026-11-05T16:00:00Z', 20)
  const gone = { ...entry('a', 'Support', 'Case 10004 X: gone', '2026-11-05T17:00:00Z', 20), deleted: 1 }
  const days = spanDays(conf, '2026-11-05', '2026-11-05', [
    // both systems: entered
    view(a, [post('erp'), post('tracker')]),
    // the tracker missing: its line's 30 minutes not entered
    view(b, [post('erp')]),
    // Ops is entered in the ERP only: entered there, nothing missing
    view(ops, [post('erp')]),
    view(gone),
  ])
  expect(fig(days, '2026-11-05', 'a')).toMatchObject({ seconds: 3600, billedSeconds: 5400, notEntered: 1800 })
  expect(days[0]?.entries).toBe(3)
})
