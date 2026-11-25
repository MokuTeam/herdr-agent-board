// spawn-agent asks the board (#505), the pure part: which starts the placer may take, the request, and
// what the board's payload says became of a start (core/launch/spawn-board.ts).
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { parseArgs, type SpawnOptions } from '../../src/core/launch/spawn-args.ts'
import {
  callerOf,
  type Followed,
  launchBody,
  outcomeOf,
  placeable,
  queuedLine,
} from '../../src/core/launch/spawn-board.ts'
import type { Item } from '../../src/core/types.ts'

const en = translator('en')
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const opts = (...more: string[]) => parseArgs(['--name', 'Acme', '--cwd', '/w', ...more]) as SpawnOptions
const followed: Followed = { id: 'abcd1234', session: SID, name: 'Acme', device: null, seen: true }
const launch = (more: Record<string, unknown>) => ({
  id: 'abcd1234',
  state: 'starting',
  pane: null,
  error: '',
  ...more,
})

test('a new session is placeable; a resume, a fork, a pane, a session id, a profile folder and a Workdesk worker are not', () => {
  expect(placeable(opts())).toBe(true)
  expect(placeable(opts('--model', 'opus', '--agent', 'pi', '--label', 'x'))).toBe(true)
  for (const more of [
    ['--resume', SID],
    ['--fork', SID],
    ['--pane', 'wA:p1'],
    ['--session-id', SID],
    ['--config-dir', '/p'],
    ['--keep-env'],
    ['--workdesk-worker'],
  ])
    expect([more[0], placeable(opts(...more))]).toEqual([more[0], false])
})

test('--trust goes with a placed Claude start (#798); with another agent the start stays here', () => {
  expect(placeable(opts('--trust'))).toBe(true)
  expect(placeable(opts('--trust', '--agent', 'claude'))).toBe(true)
  expect(placeable(opts('--trust', '--agent', 'pi'))).toBe(false)
  expect(placeable(opts('--trust', '--agent', 'agy'))).toBe(false)
  const facts = { cwd: '/w', message: '', workspace: { id: 'w1' } }
  expect(launchBody(opts('--trust'), facts).trust).toBe(true)
  // Without it the request is as before: no trust key at all.
  expect('trust' in launchBody(opts(), facts)).toBe(false)
})

test('the caller is found by its Claude id, else by its pane, never among a node’s items', () => {
  const items = [
    { key: '@server-1:x', session: 'x', pane: 'wA:p1', device: 'server-1' },
    { key: 'pane-wA:p1', session: null, pane: 'wA:p1' },
    { key: SID, session: SID, pane: 'wA:p2' },
  ] as unknown as Item[]
  expect(callerOf(items, { CLAUDE_CODE_SESSION_ID: SID })?.key).toBe(SID)
  expect(callerOf(items, { HERDR_PANE_ID: 'wA:p1' })?.key).toBe('pane-wA:p1')
  expect(callerOf(items, { CLAUDE_CODE_SESSION_ID: 'other', HERDR_PANE_ID: 'wA:p9' })).toBeUndefined()
})

test('the request is an agent’s: byHand false, and only what was given', () => {
  expect(launchBody(opts(), { cwd: '/w', message: '', workspace: { id: 'wA' } })).toEqual({
    name: 'Acme',
    cwd: '/w',
    message: '',
    workspace: { id: 'wA' },
    byHand: false,
  })
  expect(
    launchBody(opts('--agent', 'pi', '--model', 'p/m', '--label', ' Tab '), {
      cwd: '/w',
      message: 'Go',
      workspace: { id: 'wA' },
    }),
  ).toMatchObject({ agent: 'pi', model: 'p/m', label: 'Tab' })
})

test('queued= names the blocker, else the first device that turned it away, else none', () => {
  expect(
    queuedLine({ id: 'q1', place: { wait: { device: 'local', kind: 'memory', freeMb: 1, needMb: 2 } } }, 'A b'),
  ).toBe('queued=q1 name=A b waiting=local:memory')
  expect(queuedLine({ id: 'q1', place: { turned: [{ device: 'server-2', error: 'repo' }] } }, 'A')).toBe(
    'queued=q1 name=A waiting=server-2:repo',
  )
  expect(queuedLine({ id: 'q1', place: {} }, 'A')).toBe('queued=q1 name=A waiting=none')
})

test('what the payload says: still on its way, a node’s failure or dialog, a full queue, a start taken off the board', () => {
  const sent = { items: [], launches: [launch({ state: 'done', place: { device: 'server-1' } })] }
  expect(outcomeOf(sent, followed, en)).toEqual({ kind: 'pending', device: 'server-1', seen: true })
  const key = `@server-1:${SID}`
  const there = (state: string, error = '') => ({
    items: [{ key, session: SID, pane: 'p4', device: 'server-1' }],
    launches: [launch({ id: key, device: 'server-1', state, error })],
  })
  const f = { ...followed, device: 'server-1' }
  expect(outcomeOf(there('starting'), f, en).kind).toBe('pending')
  expect(outcomeOf(there('failed', 'no herdr'), f, en)).toEqual({ kind: 'failed', error: 'on server-1: no herdr' })
  expect(outcomeOf(there('trust'), f, en)).toMatchObject({ kind: 'failed' })
  expect(outcomeOf(there('done'), f, en)).toEqual({
    kind: 'printed',
    line: `pane=@server-1:p4 name=Acme agent=${key} device=server-1 session=${SID}`,
  })
  const full = { items: [], launches: [launch({ state: 'failed', place: { queueFull: true } })] }
  expect(outcomeOf(full, followed, en)).toEqual({
    kind: 'failed',
    error: '50 starts are waiting already: this one was not added',
  })
  const local = { items: [], launches: [launch({ state: 'waiting', pane: 'wA:p9' })] }
  expect(outcomeOf(local, followed, en)).toMatchObject({ kind: 'failed' })
  expect(outcomeOf({ items: [], launches: [] }, followed, en)).toEqual({
    kind: 'failed',
    error: 'the start was taken off the board',
  })
  expect(outcomeOf({ items: [], launches: [] }, { ...followed, seen: false }, en).kind).toBe('pending')
  // Gone from the launches, its session on this computer: it ran here.
  const ran = { items: [{ key: SID, session: SID, pane: 'wA:p9', agent: 'claude' }], launches: [] }
  expect(outcomeOf(ran, followed, en)).toEqual({ kind: 'here', pane: 'wA:p9', agent: 'claude' })
})

test('a node that turned the start away is forgotten: the placer ran it here, and the line is this computer’s', () => {
  const sent = { items: [], launches: [launch({ place: { device: 'server-1' } })] }
  const first = outcomeOf(sent, followed, en)
  expect(first).toEqual({ kind: 'pending', device: 'server-1', seen: true })
  const here = {
    items: [{ key: SID, session: SID, pane: 'wA:p9', agent: 'claude' }],
    launches: [launch({ state: 'done', pane: 'wA:p9', place: { turned: [{ device: 'server-1', error: 'full' }] } })],
  }
  expect(outcomeOf(here, { ...followed, device: 'server-1' }, en)).toEqual({
    kind: 'here',
    pane: 'wA:p9',
    agent: 'claude',
  })
})

test('a node that shows the start before any payload named it: found by the session, not taken off the board', () => {
  const key = `@server-1:${SID}`
  const shown = {
    items: [{ key, session: SID, pane: 'p4', device: 'server-1' }],
    launches: [launch({ id: key, device: 'server-1', state: 'done' })],
  }
  expect(outcomeOf(shown, followed, en)).toEqual({
    kind: 'printed',
    line: `pane=@server-1:p4 name=Acme agent=${key} device=server-1 session=${SID}`,
  })
})

test('pi on a node: its card under its file, or its launch done there before the card comes', () => {
  const file = `/home/u/.pi/sessions/2026-11-21_${SID}.jsonl`
  const f = { ...followed, device: 'server-1' }
  const card = {
    items: [{ key: `@server-1:${file}`, session: `@server-1:${file}`, pane: 'p5', device: 'server-1', agent: 'pi' }],
    launches: [],
  }
  expect(outcomeOf(card, f, en)).toMatchObject({ kind: 'printed', line: expect.stringContaining('pane=@server-1:p5 ') })
  const done = {
    items: [],
    launches: [launch({ id: `@server-1:${SID}`, device: 'server-1', state: 'done', pane: 'p5' })],
  }
  expect(outcomeOf(done, f, en)).toMatchObject({ kind: 'printed', line: expect.stringContaining('pane=@server-1:p5 ') })
})

test('outcomeOf uses renamed device titles in refusals and failure lines while keeping device ids in machine lines (#601)', () => {
  const key = `@server-1:${SID}`
  const devices = [
    { id: 'local', title: 'Work Laptop' },
    { id: 'server-1', title: 'Atlas Box' },
  ]
  const refused = {
    items: [],
    launches: [
      launch({
        state: 'failed',
        place: {
          refuse: { kind: 'pinned-away', pin: { device: 'server-1' }, origin: 'local', home: { kind: 'changes' } },
        },
      }),
    ],
    devices,
  }
  expect(outcomeOf(refused, followed, en)).toEqual({
    kind: 'failed',
    error: 'It runs only on Work Laptop (the folder has changes that are not committed), and “Where” says Atlas Box',
  })
  const nodeFailed = {
    items: [{ key, session: SID, pane: 'p4', device: 'server-1' }],
    launches: [launch({ id: key, device: 'server-1', state: 'failed', error: 'no herdr' })],
    devices,
  }
  expect(outcomeOf(nodeFailed, { ...followed, device: 'server-1' }, en)).toEqual({
    kind: 'failed',
    error: 'on Atlas Box: no herdr',
  })
  const done = {
    items: [{ key, session: SID, pane: 'p4', device: 'server-1' }],
    launches: [launch({ id: key, device: 'server-1', state: 'done' })],
    devices,
  }
  expect(outcomeOf(done, { ...followed, device: 'server-1' }, en)).toEqual({
    kind: 'printed',
    line: `pane=@server-1:p4 name=Acme agent=${key} device=server-1 session=${SID}`,
  })
})
