// What the page says about helpers and linked sessions (upstream test/helper-model.test.mjs).
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import type { PublicHelper, WorkflowRun } from '../../src/core/helpers.ts'
import type { Item } from '../../src/core/types.ts'
import {
  clock,
  findHelper,
  groupHelpers,
  helperTitle,
  linkedSessions,
  liveCount,
  relatedKeys,
  sessionByName,
  tokens,
  toneOf,
  took,
} from '../../web/src/models/helper-model.ts'

const helper = (id: string, more: Partial<PublicHelper> = {}): PublicHelper => ({
  id,
  kind: 'agent',
  type: '',
  name: '',
  description: '',
  color: '',
  model: '',
  background: false,
  parent: null,
  toolUseId: null,
  workflow: null,
  phase: '',
  status: 'done',
  startedAt: null,
  endedAt: null,
  activity: 0,
  prompt: '',
  from: '',
  now: null,
  after: '',
  waiting: 0,
  tokens: null,
  result: '',
  ...more,
})
const run = (id: string, more: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  name: '',
  status: 'done',
  summary: '',
  startedAt: 0,
  endedAt: 0,
  activity: 0,
  tokens: null,
  tools: null,
  agents: 0,
  taskId: '',
  ...more,
})
const item = (key: string, more: Partial<Item> = {}) => ({ key, name: key, autoName: key, ...more }) as Item

test('a helper in words: its title, a stopwatch, tokens, the tone of its mark', () => {
  assert.equal(helperTitle({ description: 'Review the diff', name: 'r1', type: 'code-reviewer' }), 'Review the diff')
  assert.equal(helperTitle({ name: 'design-check', type: 'x' }), 'design-check')
  assert.equal(helperTitle({ id: 'a1' }), 'a1')
  assert.deepEqual([clock(0), clock(12_400), clock(245_000), clock(3_845_000)], ['0s', '12s', '4:05', '1:04:05'])
  assert.deepEqual(
    [tokens(null), tokens(950), tokens(23_131), tokens(1_234_567), tokens(25_000_000)],
    ['', '950', '23k', '1.2M', '25M'],
  )
  assert.deepEqual(['running', 'done', 'idle', 'failed', 'stopped'].map(toneOf), ['run', 'ok', 'idle', 'fail', 'stop'])
  assert.equal(took({ status: 'done', startedAt: 1000, endedAt: 61_000 }), 60_000)
  assert.equal(took({ status: 'running', startedAt: 1000 }, 31_000), 30_000)
  assert.equal(took({ status: 'done' }), null)
})

test('the list: at work first, workflow runs with their agents, teammates, then the finished', () => {
  const h = (id: string, status: PublicHelper['status'], startedAt: number, more: Partial<PublicHelper> = {}) =>
    helper(id, { status, startedAt, ...more })
  const g = groupHelpers(
    [
      h('a', 'done', 1),
      h('b', 'running', 5),
      h('c', 'running', 3),
      h('kid', 'running', 4, { parent: 'c' }),
      h('grandkid', 'running', 4.5, { parent: 'kid' }),
      h('m', 'idle', 2, { kind: 'teammate' }),
      h('w1', 'done', 6, { kind: 'workflow', workflow: 'wf1' }),
      h('x', 'stopped', 7),
    ],
    [run('wf0', { status: 'done', startedAt: 9 }), run('wf1', { status: 'running', startedAt: 6 })],
  )
  assert.deepEqual(
    g.running.map(x => [x.id, x.depth]),
    [
      ['b', 0],
      ['c', 0],
      ['kid', 1],
      ['grandkid', 2],
    ],
  )
  assert.deepEqual(
    g.teammates.map(x => x.id),
    ['m'],
  )
  assert.deepEqual(
    g.runs.map(r => [r.id, r.agents.map(x => x.id)]),
    [
      ['wf1', ['w1']],
      ['wf0', []],
    ],
  )
  assert.deepEqual(
    g.finished.map(x => x.id),
    ['x', 'a'],
  )
})

test('which helper or session a line of the thread is about', () => {
  const helpers = [
    helper('a1', { toolUseId: 'toolu_1' }),
    helper('f2', { kind: 'fork', name: 'audit', startedAt: 1 }),
    helper('m3', { kind: 'teammate', name: 'audit', startedAt: 0 }),
  ]
  assert.equal(findHelper(helpers, { id: 'a1' })?.id, 'a1')
  assert.equal(findHelper(helpers, { id: 'gone', tool: 'toolu_1' })?.id, 'a1')
  assert.equal(findHelper(helpers, { name: 'audit' })?.id, 'm3') // a teammate goes by its name first
  assert.equal(findHelper(helpers, { name: 'f2' })?.id, 'f2') // SendMessage to an agent id
  assert.equal(findHelper(helpers, {}), null)
  const items = [
    item('k1', { name: 'My case', autoName: 'case-42' }),
    item('k2', { name: 'Twin', autoName: 'Twin' }),
    item('k3', { name: 'Twin', autoName: 'Twin' }),
    item('l', { name: 'case-43', launchOnly: true }),
  ]
  assert.equal(sessionByName(items, 'Case 42')?.key, 'k1')
  assert.equal(sessionByName(items, 'my case')?.key, 'k1')
  assert.equal(sessionByName(items, 'Twin'), null) // two of them: no guess
  assert.equal(sessionByName(items, 'case-42', 'k1'), null) // never the session itself
  assert.equal(sessionByName(items, 'case-43'), null) // a launch still starting is not a session yet
  assert.equal(sessionByName(items, ''), null)
})

test('the card: helpers at work, sessions linked', () => {
  const summary = (running: number, workflows: number) => ({ running, workflows, total: 0, live: [], at: 0 })
  assert.equal(liveCount({ helpers: summary(3, 1) }), 3)
  assert.equal(liveCount({ helpers: summary(0, 1) }), 1) // a workflow between two agents
  assert.equal(liveCount({}), 0)
  const ref = (key: string) => ({ key, name: key, at: 0 })
  const talk = (key: string) => ({ ...ref(key), in: 0, out: 0 })
  assert.deepEqual(
    [...relatedKeys({ links: { from: ref('m'), started: [ref('a')], talks: [talk('m'), talk('b')] } })].sort(),
    ['a', 'b', 'm'],
  )
  assert.equal(relatedKeys({}).size, 0)
})

test("the sheet's sessions: each once, who started it first, then by the latest contact", () => {
  const links = {
    from: { key: 'm', name: 'Master', at: 5 },
    started: [
      { key: 'c', name: 'Case', at: 9 },
      { key: 'gone', name: 'Gone', at: 30 },
    ],
    talks: [
      { key: 'c', name: 'Case', in: 2, out: 1, at: 12 },
      { key: 'm', name: 'Master', in: 1, out: 0, at: 20 },
      { key: 'o', name: 'Other', in: 0, out: 3, at: 15 },
    ],
  }
  assert.deepEqual(
    linkedSessions({ links }, key => key !== 'gone'),
    [
      { key: 'm', from: true, started: false, in: 1, out: 0, at: 20 },
      { key: 'o', from: false, started: false, in: 0, out: 3, at: 15 },
      { key: 'c', from: false, started: true, in: 2, out: 1, at: 12 },
    ],
  )
  assert.deepEqual(
    linkedSessions({ links: null }, () => true),
    [],
  )
})
