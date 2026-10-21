// currentWakeMode: core/wake/mode.ts wakeMode with wake's status file read now, at most once a
// second, and only while wake is on.
import { expect, test } from 'bun:test'
import { rmSync, utimesSync, writeFileSync } from 'node:fs'
import { wakeStatusFile, writeWakeStatus } from '../../src/adapters/wake-files.ts'
import { currentWakeMode } from '../../src/services/wake/mode.ts'
import { isolatedHome } from '../support/env.ts'

const OLD = 'http://127.0.0.1:12421'
const on = { wake: { enabled: true, port: 23456 }, wakeUrl: OLD }

test('the status file as it is now: none, running, held', () => {
  isolatedHome()
  let now = 1_000_000
  const clock = { now: () => now }
  expect(currentWakeMode(on, clock)).toMatchObject({ kind: 'old', on: true, held: false })
  now += 1000
  writeWakeStatus({ state: 'running', at: now })
  expect(currentWakeMode(on, clock)).toMatchObject({ kind: 'new', url: 'http://127.0.0.1:23456' })
  now += 1000
  writeWakeStatus({ state: 'held', at: now })
  utimesSync(wakeStatusFile(), new Date(), new Date(now + 5000))
  expect(currentWakeMode(on, clock)).toMatchObject({ kind: 'old', held: true })
  now += 1000
  rmSync(wakeStatusFile())
  expect(currentWakeMode(on, clock)).toMatchObject({ kind: 'old', held: false })
})

test('read at most once a second, and again only when the file changed', () => {
  isolatedHome()
  let now = 2_000_000
  const clock = { now: () => now }
  writeWakeStatus({ state: 'running', at: now })
  expect(currentWakeMode(on, clock).kind).toBe('new')
  // Within the second, the file is not looked at again.
  writeFileSync(wakeStatusFile(), JSON.stringify({ state: 'held', at: now }))
  utimesSync(wakeStatusFile(), new Date(), new Date(now + 60_000))
  expect(currentWakeMode(on, clock).kind).toBe('new')
  now += 1000
  expect(currentWakeMode(on, clock)).toMatchObject({ kind: 'old', held: true })
})

test('off: the old path without a look at the status file', () => {
  isolatedHome()
  writeWakeStatus({ state: 'running', at: 1 })
  for (const wake of [false, { enabled: false }])
    expect(currentWakeMode({ wake, wakeUrl: OLD }, { now: () => 3_000_000 })).toEqual({
      kind: 'old',
      url: OLD,
      on: false,
      held: false,
    })
})
