// Wake's status file and the state the board shows (src/core/wake/status.ts).
import { expect, test } from 'bun:test'
import {
  asTelegramStatus,
  asWakeStatus,
  isWakeStatus,
  STARTING_MS,
  type WakeStatusFile,
  wakeState,
} from '../../../src/core/wake/status.ts'

const NOW = 1_760_000_000_000
const at = (state: WakeStatusFile['state'], ago = 1000): WakeStatusFile => ({ state, at: NOW - ago })

test.each([
  ['off, whatever the file and the port say', false, at('running'), true, 'off'],
  ['held by the old plugin, even with a wake answering (the old router)', true, at('held'), true, 'held'],
  ['a wake answers, no file', true, null, true, 'running'],
  ['a wake answers, the file says crashed', true, at('crashed'), true, 'running'],
  ['crashed', true, at('crashed'), false, 'crashed'],
  ['port taken by another program', true, at('portTaken'), false, 'portTaken'],
  ['starting, a moment ago', true, at('starting'), false, 'starting'],
  ['starting, a minute ago and nothing answers', true, at('starting', STARTING_MS), false, 'notRunning'],
  ['running in the file, nothing answers', true, at('running'), false, 'notRunning'],
  ['stopped', true, at('stopped'), false, 'notRunning'],
  ['failed to start', true, at('failed'), false, 'notRunning'],
  ['no file, nothing answers', true, null, false, 'notRunning'],
] as const)('wakeState: %s', (_, on, status, answers, state) => {
  expect(wakeState({ on, status, answers, now: NOW })).toBe(state)
})

test('isWakeStatus: an object with a number pid and an object sessions, the old router’s and the new one’s', () => {
  const oldRouter = {
    pid: 4242,
    started: '2026-10-21T08:00:00.000Z',
    lastPoll: null,
    lastError: null,
    reaper: { enabled: false, idleMinutes: 60, exclude: [], maxPerRound: 3 },
    sleeping: [],
    sessions: {},
  }
  expect(isWakeStatus(oldRouter)).toBe(true)
  expect(isWakeStatus({ pid: 1, sessions: { 'w1:p1': { session: 'x' } } })).toBe(true)
  for (const not of [{}, [], { pid: '1', sessions: {} }, { pid: 1, sessions: [] }, { pid: 1 }, null, 'ok', 42])
    expect(isWakeStatus(not)).toBe(false)
})

test('asWakeStatus: a state and a time; the other fields only when of their type', () => {
  expect(
    asWakeStatus({
      state: 'crashed',
      at: NOW,
      pane: 'w9:p1',
      pid: 77,
      error: 'boom',
      crashes: [NOW - 2, NOW - 1],
      port: 40000,
      extra: 'kept on disk, not read',
    }),
  ).toEqual({
    state: 'crashed',
    at: NOW,
    pane: 'w9:p1',
    pid: 77,
    error: 'boom',
    crashes: [NOW - 2, NOW - 1],
    port: 40000,
  })
  expect(asWakeStatus({ state: 'running', at: NOW, pane: 5, pid: 'x', error: null, crashes: 'no', port: -1 })).toEqual({
    state: 'running',
    at: NOW,
  })
  expect(asWakeStatus({ state: 'held', at: NOW, crashes: [NOW, 'x', null] })).toEqual({
    state: 'held',
    at: NOW,
    crashes: [NOW],
  })
  for (const not of [null, [], {}, { state: 'asleep', at: NOW }, { state: 'running' }, { state: 'running', at: '1' }])
    expect(asWakeStatus(not)).toBeNull()
})

test('asWakeStatus: the Telegram router’s state the wake process writes, its host and error only when strings', () => {
  const telegram = { state: 'error', host: '127.0.0.1:8787', error: 'HTTP 401', extra: 'dropped' }
  expect(asWakeStatus({ state: 'running', at: NOW, telegram })).toEqual({
    state: 'running',
    at: NOW,
    telegram: { state: 'error', host: '127.0.0.1:8787', error: 'HTTP 401' },
  })
  expect(asTelegramStatus({ state: 'polling', host: 'box:1', error: 5 })).toEqual({ state: 'polling', host: 'box:1' })
  expect(asTelegramStatus({ state: 'off' })).toEqual({ state: 'off' })
  for (const not of [null, 'polling', [], {}, { state: 'on' }, { host: 'box:1' }]) {
    expect(asTelegramStatus(not)).toBeNull()
    expect(asWakeStatus({ state: 'running', at: NOW, telegram: not })).toEqual({ state: 'running', at: NOW })
  }
})
