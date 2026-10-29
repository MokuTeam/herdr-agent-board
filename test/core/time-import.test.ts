import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { instantIn } from '../../src/core/time.ts'
import { csvRows, dayTotals, parseMap, rowsFromCsv, rowsFromJson } from '../../src/core/time-import.ts'

const IST = 'Europe/Istanbul'
const zoned = (date: string, clock: [number, number, number]) => instantIn(date, clock, IST)

// Toggl's Detailed report as its web page exports it (no id column), a BOM, a quoted field with a
// comma and a doubled quote, CRLF line ends, a row of a timer still running
const CSV = [
  '﻿User,Email,Client,Project,Task,Description,Billable,Start date,Start time,End date,End time,Duration,Tags,Amount ()',
  'Me,me@example.org,Client A,Support,,"Case 10001 X: fixed it, ""finally""",Yes,2026-10-28,09:00:00,2026-10-28,10:30:00,01:30:00,"deferred, other",',
  'Me,me@example.org,,Internal,,Board work,No,2026-10-28,23:30:00,2026-10-29,00:15:00,00:45:00,,',
  'Me,me@example.org,Client A,Support,,Still running,Yes,2026-10-28,11:00:00,,,,,',
].join('\r\n')

test('csvRows: quotes, doubled quotes, commas and line breaks inside quotes, CRLF', () => {
  assert.deepEqual(csvRows('a,"b,c","d ""e""",\r\n"x\ny",z\n'), [
    ['a', 'b,c', 'd "e"', ''],
    ['x\ny', 'z'],
  ])
})

test('the Detailed report: columns by header, times in the profile’s zone, the end over midnight, running rows marked', () => {
  const r = rowsFromCsv(CSV, zoned)
  assert.deepEqual(r.missing, [])
  assert.deepEqual(r.bad, [])
  assert.equal(r.rows.length, 3)
  const [first, night, running] = r.rows
  assert.equal(first?.client, 'Client A')
  assert.equal(first?.description, 'Case 10001 X: fixed it, "finally"')
  assert.deepEqual(first?.tags, ['deferred', 'other'])
  assert.equal(new Date(first?.start ?? 0).toISOString(), '2026-10-28T06:00:00.000Z')
  assert.equal(((first?.stop ?? 0) - (first?.start ?? 0)) / 60_000, 90)
  assert.equal(night?.client, '')
  assert.equal(((night?.stop ?? 0) - (night?.start ?? 0)) / 60_000, 45)
  assert.equal(running?.running, true)
  assert.equal(first?.running, false)
  // no id column: no key (the store knows the row again by its lane and start)
  assert.equal(first?.key, '')
})

test('dates either way round: the file shows which, or --date-format; a date that is no date is unreadable', () => {
  const head = 'Client,Project,Description,Start date,Start time,End date,End time,Duration,Tags\n'
  const row = (start: string, end: string, time = '09:00:00', endTime = '10:00:00') =>
    `Client A,Support,Work,${start},${time},${end},${endTime},01:00:00,\n`
  const iso = (r: ReturnType<typeof rowsFromCsv>) => r.rows.map(x => new Date(x.start).toISOString().slice(0, 10))
  // 28/10 can only be day/month, so 10/11 in the same file is the 10th of November
  const dmy = rowsFromCsv(head + row('28/10/2026', '28/10/2026') + row('10/11/2026', '10/11/2026'), zoned)
  assert.deepEqual(iso(dmy), ['2026-10-28', '2026-11-10'])
  // 10/28 can only be month/day
  assert.deepEqual(iso(rowsFromCsv(head + row('10/28/2026', '10/28/2026') + row('10/11/2026', '10/11/2026'), zoned)), [
    '2026-10-28',
    '2026-10-11',
  ])
  // dots and dashes as Toggl's other formats write them
  assert.deepEqual(iso(rowsFromCsv(head + row('28.10.2026', '28.10.2026') + row('29-10-2026', '29-10-2026'), zoned)), [
    '2026-10-28',
    '2026-10-29',
  ])
  // nothing in the file tells: refused, unless the flag says
  const only = head + row('10/11/2026', '10/11/2026')
  assert.equal(rowsFromCsv(only, zoned).dates, 'ambiguous')
  assert.deepEqual(iso(rowsFromCsv(only, zoned, 'dmy')), ['2026-11-10'])
  assert.deepEqual(iso(rowsFromCsv(only, zoned, 'mdy')), ['2026-10-11'])
  // the same either way needs no flag
  assert.deepEqual(iso(rowsFromCsv(head + row('10/10/2026', '10/10/2026'), zoned)), ['2026-10-10'])
  // both ways in one file
  assert.equal(
    rowsFromCsv(head + row('28/10/2026', '28/10/2026') + row('10/28/2026', '10/28/2026'), zoned).dates,
    'mixed',
  )
  // a date that is no date, an impossible clock: unreadable rows, by line
  const badRows = rowsFromCsv(
    head +
      row('2026-02-30', '2026-02-30') +
      row('2026-10-28', '2026-10-28', '25:00:00') +
      row('2026-10-28', '2026-10-28'),
    zoned,
  )
  assert.deepEqual(badRows.bad, [2, 3])
  assert.equal(badRows.rows.length, 1)
  // 12-hour times
  const pm = rowsFromCsv(head + row('2026-10-28', '2026-10-28', '1:05:00 PM', '2:35:00 PM'), zoned)
  assert.equal(new Date(pm.rows[0]?.start ?? 0).toISOString(), '2026-10-28T10:05:00.000Z')
  assert.equal(((pm.rows[0]?.stop ?? 0) - (pm.rows[0]?.start ?? 0)) / 60_000, 90)
  assert.equal(
    rowsFromCsv(head + row('2026-10-28', '2026-10-28', '12:30:00 AM', '1:00:00 AM'), zoned).rows[0]?.start,
    Date.parse('2026-10-27T21:30:00Z'),
  )
})

test('a report without an End time column is read by its durations, not as running timers', () => {
  const csv =
    'Client,Project,Description,Start date,Start time,Duration\nClient A,Support,Work,2026-10-28,09:00:00,01:30:00\n'
  const r = rowsFromCsv(csv, zoned)
  assert.equal(r.rows[0]?.running, false)
  assert.equal(((r.rows[0]?.stop ?? 0) - (r.rows[0]?.start ?? 0)) / 60_000, 90)
})

test('an id column is the key; a CSV without the columns it needs says which', () => {
  const withId = CSV.replace('User,Email,', 'ID,Email,').replace(
    'Me,me@example.org,Client A,Support,,"Case',
    '4012345678,me@example.org,Client A,Support,,"Case',
  )
  assert.equal(rowsFromCsv(withId, zoned).rows[0]?.key, '4012345678')
  const r = rowsFromCsv('Client,Project\nA,B\n', zoned)
  assert.deepEqual(r.missing, ['description', 'startDate', 'startTime', 'duration'])
})

test('Toggl’s JSON (API v9 with its names): ids as keys, a running timer marked', () => {
  const r = rowsFromJson([
    {
      id: 4012345678,
      start: '2026-10-28T06:00:00+00:00',
      stop: '2026-10-28T07:30:00+00:00',
      duration: 5400,
      description: 'Case 10001 X: work',
      project_name: 'Support',
      client_name: 'Client A',
      tags: ['deferred'],
    },
    { id: 4012345679, start: '2026-10-28T08:00:00Z', duration: -1761638400, description: 'running' },
    { start: 'not a time' },
  ])
  assert.deepEqual(r.bad, [2])
  assert.equal(r.rows[0]?.key, '4012345678')
  assert.equal(r.rows[0]?.project, 'Support')
  assert.equal(r.rows[1]?.running, true)
})

test('--map: Toggl client names (case aside, empty for none) to lanes', () => {
  const m = parseMap(['Client A=client-a', '=personal'])
  assert.ok(m instanceof Map)
  assert.equal(m.get('client a'), 'client-a')
  assert.equal(m.get(''), 'personal')
  assert.equal(parseMap(['no equals sign']), 'no equals sign')
})

test('dayTotals: per day and lane, for the dry run', () => {
  assert.deepEqual(
    dayTotals([
      { date: '2026-10-28', client: 'a', seconds: 60 },
      { date: '2026-10-27', client: 'a', seconds: 30 },
      { date: '2026-10-28', client: 'a', seconds: 60 },
    ]),
    [
      { date: '2026-10-27', client: 'a', entries: 1, seconds: 30 },
      { date: '2026-10-28', client: 'a', entries: 2, seconds: 120 },
    ],
  )
})
