// Which wake the board talks to (#119, call 4): the new one only while it is on and its status file
// is there with a state other than held; otherwise wakeUrl and the old guard, exactly as today.
import { expect, test } from 'bun:test'
import { WAKE_SHIPPED, wakeConfig } from '../../../src/core/wake/config.ts'
import { wakeMode } from '../../../src/core/wake/mode.ts'
import type { WakeStatusFile } from '../../../src/core/wake/status.ts'

const OLD = 'http://127.0.0.1:12421'
const running: WakeStatusFile = { state: 'running', at: 1000, pane: 'w9:p1', pid: 4242, port: 23456 }

test.skipIf(WAKE_SHIPPED)('off, or no status file: the old wakeUrl and the old guard', () => {
  expect(wakeMode({ wakeUrl: OLD }, null)).toEqual({ kind: 'old', url: OLD, on: WAKE_SHIPPED, held: false })
  // A status file left from when it was on does not make the board use it while off.
  expect(wakeMode({ wakeUrl: OLD }, running)).toEqual({ kind: 'old', url: OLD, on: WAKE_SHIPPED, held: false })
})

test('turned off in config.json: the old path, whatever the status file says', () => {
  for (const wake of [false, { enabled: false, port: 23456 }])
    for (const status of [null, running])
      expect(wakeMode({ wake, wakeUrl: OLD }, status)).toEqual({ kind: 'old', url: OLD, on: false, held: false })
})

test('on but its start never ran (no status file): the old path, which starts it once', () => {
  expect(wakeMode({ wake: { enabled: true, port: 23456 }, wakeUrl: OLD }, null)).toEqual({
    kind: 'old',
    url: OLD,
    on: true,
    held: false,
  })
})

test('on and held: the old path', () => {
  const held: WakeStatusFile = { state: 'held', at: 1000 }
  expect(wakeMode({ wake: { enabled: true, port: 23456 }, wakeUrl: OLD }, held)).toEqual({
    kind: 'old',
    url: OLD,
    on: true,
    held: true,
  })
})

test('on, the status file there and not held: the wake port', () => {
  const wake = { enabled: true, port: 23456 }
  for (const state of ['starting', 'running', 'crashed', 'stopped', 'portTaken', 'failed'] as const)
    expect(wakeMode({ wake, wakeUrl: OLD }, { state, at: 1000 })).toEqual({
      kind: 'new',
      url: 'http://127.0.0.1:23456',
      settings: wakeConfig(wake),
    })
  expect(wakeMode({ wake: true, wakeUrl: OLD }, running)).toMatchObject({ kind: 'new', url: OLD })
})

test('wakeUrl set elsewhere is kept on the old path, and not used on the new one', () => {
  const elsewhere = 'http://10.0.0.5:9999'
  expect(wakeMode({ wake: false, wakeUrl: elsewhere }, running)).toMatchObject({ kind: 'old', url: elsewhere })
  expect(wakeMode({ wake: { enabled: true }, wakeUrl: elsewhere }, { state: 'held', at: 1 })).toMatchObject({
    kind: 'old',
    url: elsewhere,
  })
  expect(wakeMode({ wake: { enabled: true }, wakeUrl: null }, null)).toMatchObject({ kind: 'old', url: null })
  expect(wakeMode({ wake: { enabled: true, port: 23456 }, wakeUrl: elsewhere }, running)).toMatchObject({
    kind: 'new',
    url: 'http://127.0.0.1:23456',
  })
})
