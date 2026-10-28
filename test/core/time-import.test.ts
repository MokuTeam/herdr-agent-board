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
  // no id column: a key of the row's own, the same on a second run of the same export
  assert.match(first?.key ?? '', /^csv:[0-9a-f]{16}$/)
  assert.equal(rowsFromCsv(CSV, zoned).rows[0]?.key, first?.key)
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
