// The checks in front of the keys: services/answer.ts and the server's answer/permit route against the
// fake herdr. Every refusal must come before a key is sent.

import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { parseDialog } from '../../src/core/dialogs/questions.ts'
import { inputScreen, PI_IDLE, PI_INPUT, PI_SELECT, selectScreen } from '../support/fake-pi.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'

const screen = (name: string): string =>
  readFileSync(new URL(`../support/screens/${name}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const BASH = screen('permission-bash')
const parsed = parseDialog(BASH)
if (parsed?.kind !== 'permission') throw new Error('permission-bash.txt is not a permission prompt')
const FINGERPRINT = parsed.fingerprint
// Claude's input box and no dialog: what the pane shows once a dialog is answered.
const IDLE = ['● Done.', '', '─'.repeat(60), '❯ ', '─'.repeat(60), '  ⏵⏵ manual mode on'].join('\n')
const COLOR = {
  questions: [
    {
      question: 'Which color should the test widget use?',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'A warm red, good for alerts' },
        { label: 'Green', description: 'Calm green for success states' },
        { label: 'Blue', description: 'Neutral blue, the default' },
      ],
    },
  ],
}

const QUESTION = 'Which color should the test widget use?'
const agent = (status = 'blocked', session = 's1') => ({
  result: { agent: { agent: 'claude', agent_status: status, agent_session: { value: session } } },
})
const item = (box: Sandbox, extra: Record<string, unknown> = {}) => ({
  key: 's1',
  session: 's1',
  pane: 'p1',
  agent: 'claude',
  name: 'Probe',
  transcript: join(box.dir, 's1.jsonl'),
  ...extra,
})
const keysSent = (box: Sandbox) => box.calls().filter(a => a[1] === 'send-keys' || a[1] === 'send-text')

/** A transcript whose last call is this AskUserQuestion, answered or not. */
function transcript(path: string, id: string, answered = false) {
  const ask = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: COLOR }] },
  }
  const result = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'answered' }] },
    toolUseResult: { answers: { [QUESTION]: 'Blue' } },
  }
  writeFileSync(path, `${JSON.stringify(ask)}\n${answered ? `${JSON.stringify(result)}\n` : ''}`)
}

async function run(box: Sandbox, input: unknown) {
  const out = await box.run('answer', input).exited
  assert.equal(out.code, 0, out.stderr)
  return JSON.parse(out.stdout)
}

test('refusals come before any key: not Claude, another session, not waiting, no fresh question', async () => {
  const box = await sandbox()
  transcript(join(box.dir, 's1.jsonl'), 'toolu_1')
  box.state({ 'agent get': agent(), 'agent read': { text: screen('question-single') } })
  const notClaude = await run(box, {
    kind: 'permit',
    item: item(box, { agent: 'codex' }),
    body: { fingerprint: FINGERPRINT, option: 1 },
  })
  assert.match(notClaude.error, /not a Claude session/)
  const noSession = await run(box, {
    kind: 'answer',
    item: item(box, { session: null }),
    body: { toolUseId: 'toolu_1', answers: [{ options: ['Blue'] }] },
  })
  assert.equal(noSession.ok, false)
  assert.equal(box.calls().length, 0) // refused before asking herdr anything

  box.state({ 'agent get': agent('blocked', 'someone-else'), 'agent read': { text: screen('question-single') } })
  assert.match(
    (
      await run(box, {
        kind: 'answer',
        item: item(box),
        body: { toolUseId: 'toolu_1', answers: [{ options: ['Blue'] }] },
      })
    ).error,
    /another session/,
  )
  box.state({ 'agent get': agent('working'), 'agent read': { text: screen('question-single') } })
  const working = await run(box, {
    kind: 'answer',
    item: item(box),
    body: { toolUseId: 'toolu_1', answers: [{ options: ['Blue'] }] },
  })
  assert.equal(working.gone, true)
  assert.match(working.error, /no longer waits/)

  box.state({ 'agent get': agent(), 'agent read': { text: screen('question-single') } })
  const other = await run(box, {
    kind: 'answer',
    item: item(box),
    body: { toolUseId: 'toolu_older', answers: [{ options: ['Blue'] }] },
  })
  assert.equal(other.gone, true)
  assert.match(other.error, /no longer open/)
  transcript(join(box.dir, 's1.jsonl'), 'toolu_1', true)
  assert.equal(
    (
      await run(box, {
        kind: 'answer',
        item: item(box),
        body: { toolUseId: 'toolu_1', answers: [{ options: ['Blue'] }] },
      })
    ).gone,
    true,
  )
  transcript(join(box.dir, 's1.jsonl'), 'toolu_1')
  assert.match(
    (
      await run(box, {
        kind: 'answer',
        item: item(box),
        body: { toolUseId: 'toolu_1', answers: [{ options: ['Teal'] }] },
      })
    ).error,
    /every question/,
  )
  // A permission prompt that is not the one the user saw.
  box.state({ 'agent get': agent(), 'agent read': { text: screen('permission-write') } })
  const changed = await run(box, { kind: 'permit', item: item(box), body: { fingerprint: FINGERPRINT, option: 1 } })
  assert.match(changed.error, /another dialog/)
  assert.equal(changed.stopped, false)
  assert.deepEqual(keysSent(box), [])
}, 30_000)

test('an answer goes in, and counts as done once the transcript has it', async () => {
  const box = await sandbox()
  const path = join(box.dir, 's1.jsonl')
  transcript(path, 'toolu_1')
  box.state({
    'agent get': agent(),
    'agent read': { text: screen('question-single') },
    'agent send-keys': { result: null },
  })
  const running = box.run('answer', {
    kind: 'answer',
    item: item(box),
    body: { toolUseId: 'toolu_1', answers: [{ options: ['Blue'] }] },
  })
  await until(() => keysSent(box).length > 0, 10_000)
  // The screen is still the old one (a slow redraw); the transcript already has the answer.
  transcript(path, 'toolu_1', true)
  const out = await running.exited
  assert.equal(out.code, 0, out.stderr)
  assert.deepEqual(JSON.parse(out.stdout), { ok: true, answers: [{ question: QUESTION, answer: 'Blue' }] })
  assert.deepEqual(keysSent(box), [['agent', 'send-keys', 'p1', '3']])
}, 30_000)

test('a permission prompt: one key, done when the input box is back twice; a blank screen proves nothing', async () => {
  const box = await sandbox()
  box.state({ 'agent get': agent(), 'agent read': { text: BASH }, 'agent send-keys': { result: null } })
  const running = box.run('answer', { kind: 'permit', item: item(box), body: { fingerprint: FINGERPRINT, option: 1 } })
  await until(() => keysSent(box).length > 0, 10_000)
  box.state({ 'agent get': agent(), 'agent read': { text: IDLE }, 'agent send-keys': { result: null } })
  const out = await running.exited
  assert.deepEqual(JSON.parse(out.stdout), { ok: true })
  assert.deepEqual(keysSent(box), [['agent', 'send-keys', 'p1', '1']])

  // Blank after the key: not taken for done.
  const blank = await sandbox()
  blank.state({ 'agent get': agent(), 'agent read': { text: BASH }, 'agent send-keys': { result: null } })
  const second = blank.run('answer', {
    kind: 'permit',
    item: item(blank),
    body: { fingerprint: FINGERPRINT, option: 4 },
  })
  await until(() => keysSent(blank).length > 0, 10_000)
  blank.state({ 'agent get': agent(), 'agent read': { text: '\n\n' }, 'agent send-keys': { result: null } })
  const r = JSON.parse((await second.exited).stdout)
  assert.equal(r.ok, false)
  assert.equal(r.stopped, true)
  assert.match(r.error, /never showed the dialog closing/)
}, 30_000)

test('herdr failing: before any key it says so; after keys it says the dialog may be partly filled in', async () => {
  const box = await sandbox()
  box.state({ 'agent get': agent(), 'agent read': { error: 'pipe closed' } })
  const before = await run(box, { kind: 'permit', item: item(box), body: { fingerprint: FINGERPRINT, option: 1 } })
  assert.match(before.error, /herdr did not answer: .*pipe closed/)
  assert.ok(!before.stopped)
  box.state({ 'agent get': agent(), 'agent read': { text: BASH }, 'agent send-keys': { error: 'pipe closed' } })
  const after = await run(box, { kind: 'permit', item: item(box), body: { fingerprint: FINGERPRINT, option: 1 } })
  assert.equal(after.stopped, true)
  assert.match(after.error, /partly filled in/)
  assert.match(after.screen, /Do you want to proceed\?/)
}, 30_000)

test('an own answer that starts with a dash gets a space before it', async () => {
  const box = await sandbox()
  box.state({ 'pane send-text': { result: null } })
  await run(box, { kind: 'text', item: { pane: 'p1' }, text: '-1 day' })
  await run(box, { kind: 'text', item: { pane: 'p1' }, text: 'plain' })
  assert.deepEqual(keysSent(box), [
    ['pane', 'send-text', 'p1', ' -1 day'],
    ['pane', 'send-text', 'p1', 'plain'],
  ])
}, 10_000)

// ---------------------------------------------------------------- pi

// herdr reports a pi pane's session by its file, which is the session's key on the board.
const PI_FILE = '/home/u/.pi/agent/sessions/--tmp-probe--/2026-10-20T20-16-28-825Z_01a15af5.jsonl'
const piAgent = (status = 'blocked', session = PI_FILE) => ({
  result: { agent: { agent: 'pi', agent_status: status, agent_session: { value: session } } },
})
const PI_ITEM = { key: PI_FILE, session: PI_FILE, pane: 'p1', agent: 'pi', name: 'pi probe' }
/** The fingerprint of pi's dialog on `screen` ('' when there is none: the tests that need it fail). */
const fingerprintOf = (screen: string): string => {
  const d = parseDialog(screen, 'pi')
  return d?.kind === 'select' || d?.kind === 'input' ? d.fingerprint : ''
}
const MENU = fingerprintOf(PI_SELECT)
const NOTE = fingerprintOf(PI_INPUT)

test("a pi pane's menu: one arrow key, then Enter once the screen shows the cursor on the option", async () => {
  const box = await sandbox()
  const shows = (text: string) =>
    box.state({ 'agent get': piAgent(), 'agent read': { text }, 'agent send-keys': { result: null } })
  shows(PI_SELECT)
  const running = box.run('answer', { kind: 'permit', item: PI_ITEM, body: { fingerprint: MENU, option: 2 } })
  await until(() => keysSent(box).length === 1, 10_000)
  shows(selectScreen(2))
  await until(() => keysSent(box).length === 2, 10_000)
  shows(PI_IDLE)
  const out = await running.exited
  assert.deepEqual(JSON.parse(out.stdout), { ok: true }, out.stderr)
  assert.deepEqual(keysSent(box), [
    ['agent', 'send-keys', 'p1', 'down'],
    ['agent', 'send-keys', 'p1', 'enter'],
  ])
}, 30_000)

test("a pi pane's text input: the note typed, Enter once the field shows it", async () => {
  const box = await sandbox()
  const shows = (text: string) =>
    box.state({
      'agent get': piAgent(),
      'agent read': { text },
      'agent send-keys': { result: null },
      'pane send-text': { result: null },
    })
  shows(PI_INPUT)
  const running = box.run('answer', {
    kind: 'permit',
    item: PI_ITEM,
    body: { fingerprint: NOTE, text: '  use a branch\nnot main  ' },
  })
  await until(() => keysSent(box).length === 1, 10_000)
  shows(inputScreen('use a branch not main'))
  await until(() => keysSent(box).length === 2, 10_000)
  shows(PI_IDLE)
  const out = await running.exited
  assert.deepEqual(JSON.parse(out.stdout), { ok: true }, out.stderr)
  assert.deepEqual(keysSent(box), [
    ['pane', 'send-text', 'p1', 'use a branch not main'],
    ['agent', 'send-keys', 'p1', 'enter'],
  ])
}, 30_000)

test("pi refusals come before any key; a Claude pane does not take pi's menu", async () => {
  const box = await sandbox()
  box.state({ 'agent get': piAgent(), 'agent read': { text: PI_SELECT }, 'agent send-keys': { result: null } })
  for (const body of [
    { option: 1 },
    { fingerprint: MENU, option: 0 },
    { fingerprint: MENU, option: 51 },
    { fingerprint: MENU, option: 'two' },
    { fingerprint: NOTE, text: '  \n ' },
  ]) {
    const r = await run(box, { kind: 'permit', item: PI_ITEM, body })
    assert.match(r.error, /every question|not valid|invalid/i, JSON.stringify(body))
  }
  assert.equal(box.calls().length, 0) // refused before asking herdr anything
  // A pi item whose key is not a session file is not one the board reads.
  const odd = await run(box, {
    kind: 'permit',
    item: { ...PI_ITEM, session: 'abc' },
    body: { fingerprint: MENU, option: 1 },
  })
  assert.match(odd.error, /not a Claude session/)
  // herdr says another session, or no longer waiting.
  box.state({ 'agent get': piAgent('blocked', '/other.jsonl'), 'agent read': { text: PI_SELECT } })
  assert.match(
    (await run(box, { kind: 'permit', item: PI_ITEM, body: { fingerprint: MENU, option: 1 } })).error,
    /another session/,
  )
  box.state({ 'agent get': piAgent('working'), 'agent read': { text: PI_SELECT } })
  assert.equal((await run(box, { kind: 'permit', item: PI_ITEM, body: { fingerprint: MENU, option: 1 } })).gone, true)
  // The text for a menu, an option for the input: the screen shows another dialog.
  box.state({ 'agent get': piAgent(), 'agent read': { text: PI_SELECT }, 'agent send-keys': { result: null } })
  const typed = await run(box, { kind: 'permit', item: PI_ITEM, body: { fingerprint: MENU, text: 'x' } })
  assert.match(typed.error, /another dialog/)
  box.state({ 'agent get': piAgent(), 'agent read': { text: PI_INPUT }, 'agent send-keys': { result: null } })
  const picked = await run(box, { kind: 'permit', item: PI_ITEM, body: { fingerprint: NOTE, option: 1 } })
  assert.match(picked.error, /another dialog/)
  // A Claude session's pane is read as before: pi's menu there is no prompt of Claude's.
  box.state({ 'agent get': agent(), 'agent read': { text: PI_SELECT }, 'agent send-keys': { result: null } })
  const claude = await run(box, { kind: 'permit', item: item(box), body: { fingerprint: MENU, option: 1 } })
  assert.match(claude.error, /another dialog/)
  assert.deepEqual(keysSent(box), [])
}, 40_000)

// ---------------------------------------------------------------- the route

async function unusedPort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise(resolve => server.close(resolve))
  return port
}

const SNAPSHOT = {
  result: {
    snapshot: {
      panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'blocked', cwd: '' }],
      tabs: [],
      workspaces: [],
    },
  },
}

/** The server against the fake herdr; `prepare` sets up files before it first reads them. */
async function board(state: unknown, prepare: (box: Sandbox) => void = () => {}) {
  const box = await sandbox()
  mkdirSync(join(box.env.HOME as string, '.claude', 'projects', 'p'), { recursive: true })
  box.state(state)
  prepare(box)
  const port = await unusedPort()
  const proc = box.run('server', {
    port,
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    wakeUrl: null,
    refreshSec: 3600,
    language: 'en',
  })
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready))
  const post = (action: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/api/session/s1/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
      body: JSON.stringify(body),
    }).then(async r => ({ status: r.status, body: (await r.json()) as { error: string } }))
  return { box, proc, port, post }
}

test('the route: stale data, another page, another session, one answer at a time', async () => {
  const gate = (await sandbox()).dir
  const { box, proc, port, post } = await board({
    'api snapshot': SNAPSHOT,
    'agent get': { ...agent(), waitFor: join(gate, 'go') },
    'agent read': { text: BASH },
    'agent send-keys': { result: null },
  })
  await until(() => box.calls().some(a => a[1] === 'snapshot'))
  proc.send('refresh')
  await until(() => proc.messages.some(m => (m as { refreshed?: boolean }).refreshed))

  const page = await post(
    'permit',
    { session: 's1', fingerprint: FINGERPRINT, option: 1 },
    { origin: 'http://evil.example' },
  )
  assert.equal(page.status, 403)
  const other = await post('permit', { session: 's2', fingerprint: FINGERPRINT, option: 1 })
  assert.equal(other.status, 409)
  assert.match(other.body.error, /another session/)

  // The first holds in herdr; a second one at the same time is turned away.
  const first = post('permit', { session: 's1', fingerprint: FINGERPRINT, option: 1 })
  await until(() => box.calls().some(a => a[1] === 'get'))
  const second = await post('permit', { session: 's1', fingerprint: FINGERPRINT, option: 2 })
  assert.equal(second.status, 409, JSON.stringify(second.body) + JSON.stringify(proc.messages))
  assert.match(second.body.error, /already being typed/)
  box.state({
    'api snapshot': SNAPSHOT,
    'agent get': agent(),
    'agent read': { text: BASH },
    'agent send-keys': { result: null },
  })
  writeFileSync(join(gate, 'go'), '')
  await until(() => keysSent(box).length > 0, 10_000)
  box.state({
    'api snapshot': SNAPSHOT,
    'agent get': agent(),
    'agent read': { text: IDLE },
    'agent send-keys': { result: null },
  })
  const done = await first
  assert.equal(done.status, 200, JSON.stringify(done.body))
  assert.deepEqual(keysSent(box), [['agent', 'send-keys', 'p1', '1']])

  // herdr gone: the board's data goes stale and answers wait for it.
  box.state({ 'api snapshot': { error: 'offline' } })
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/api/board`).then(r => r.json())).stale; i++) {
    proc.send('refresh')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const stale = await post('answer', { session: 's1', toolUseId: 'toolu_1', answers: [] })
  assert.equal(stale.status, 409, JSON.stringify(stale.body))
  assert.match(stale.body.error, /No fresh data/)
  assert.equal(keysSent(box).length, 1)
}, 40_000)

test("the route: a pi pane's detail has its menu, a Claude pane's is read as before, and the menu is answered", async () => {
  const panes = [
    { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'blocked', cwd: '' },
    { pane_id: 'p2', agent: 'pi', agent_session: { value: PI_FILE }, agent_status: 'blocked', cwd: '' },
  ]
  const { box, proc, port } = await board({
    'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } },
    'agent read p1': { text: PI_SELECT },
    'agent read p2': { text: PI_SELECT },
  })
  await until(() => box.calls().some(a => a[1] === 'snapshot'))
  proc.send('refresh')
  await until(() => proc.messages.some(m => (m as { refreshed?: boolean }).refreshed))
  const detail = async (key: string) =>
    (await fetch(`http://127.0.0.1:${port}/api/session/${encodeURIComponent(key)}`).then(r => r.json())) as {
      dialog: Record<string, unknown> | null
    }
  // A Claude pane that shows pi's words: no dialog, as before.
  assert.equal((await detail('s1')).dialog, null)
  const pi = (await detail(PI_FILE)).dialog
  assert.equal(pi?.kind, 'select')
  assert.equal(pi?.title, 'Git approval needed: git commit')
  assert.equal(pi?.fingerprint, MENU)
  assert.deepEqual(pi?.options, [
    { n: 1, label: 'Approve' },
    { n: 2, label: 'Reject' },
    { n: 3, label: 'Reject with a note' },
  ])
  // A Claude pane with Claude's prompt: as before.
  box.state({
    'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } },
    'agent read p1': { text: BASH },
    'agent read p2': { seq: [{ text: PI_SELECT }, { text: PI_IDLE }] },
    'agent get': piAgent(),
    'agent send-keys': { result: null },
  })
  assert.equal((await detail('s1')).dialog?.fingerprint, FINGERPRINT)
  const permit = await fetch(`http://127.0.0.1:${port}/api/session/${encodeURIComponent(PI_FILE)}/permit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ session: PI_FILE, fingerprint: MENU, option: 1 }),
  })
  assert.deepEqual([permit.status, await permit.json()], [200, { ok: true }])
  assert.deepEqual(keysSent(box), [['agent', 'send-keys', 'p2', 'enter']])
}, 40_000)

// ---------------------------------------------------------------- a question Claude Code holds back

// In auto and plan mode Claude Code 2.1.303 writes the response that asks only once it is answered:
// while the dialog is open, the transcript ends with the call before it. The board's PreToolUse
// hook put the question on the card (core/held-question.ts).
const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`
const bashCall = line({
  type: 'assistant',
  timestamp: '2026-10-21T08:53:33.724Z',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } }],
  },
})
const bashResult = line({
  type: 'user',
  timestamp: '2026-10-21T08:53:38.887Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'denied' }] },
})
const REPORTED = Date.parse('2026-10-21T08:53:44.700Z')
const ASKING = {
  id: 'toolu_1',
  detail: QUESTION,
  questions: [{ ...COLOR.questions[0], preview: false }],
  at: REPORTED,
}
/** What Claude Code writes once the question is answered: the call (from before the report) and the answer. */
const heldLines = (id = 'toolu_1') =>
  line({
    type: 'assistant',
    timestamp: '2026-10-21T08:53:44.667Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: COLOR }] },
  }) +
  line({
    type: 'user',
    timestamp: '2026-10-21T08:57:53.973Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'answered' }] },
    toolUseResult: { answers: { [QUESTION]: 'Blue' } },
  })
type BoardItem = { key: string; attention: string; question: string; tool: Record<string, unknown> | null }
const itemOf = async (port: number): Promise<BoardItem | undefined> =>
  ((await fetch(`http://127.0.0.1:${port}/api/board`).then(r => r.json())) as { items: BoardItem[] }).items.find(
    i => i.key === 's1',
  )

test('a question Claude Code holds back: the hook’s copy on the board, answered from it; an old one is not', async () => {
  const transcriptOf = (box: Sandbox) => join(box.env.HOME as string, '.claude', 'projects', 'p', 's1.jsonl')
  const { box, proc, port, post } = await board(
    {
      'api snapshot': SNAPSHOT,
      'agent get': agent(),
      'agent read': { text: screen('question-single') },
      'agent send-keys': { result: null },
    },
    box => writeFileSync(transcriptOf(box), bashCall + bashResult),
  )
  const path = transcriptOf(box)
  const refresh = async () => {
    const n = proc.messages.filter(m => (m as { refreshed?: boolean }).refreshed).length
    proc.send('refresh')
    await until(() => proc.messages.filter(m => (m as { refreshed?: boolean }).refreshed).length > n)
  }
  const card = (extra: Record<string, unknown>) => {
    mkdirSync(box.cards, { recursive: true })
    writeFileSync(join(box.cards, 's1.json'), JSON.stringify({ key: 's1', category: 'other', ...extra }))
  }

  // Without the hook's copy (an install from before it, or any other setup): as before.
  card({})
  await refresh()
  const before = await itemOf(port)
  assert.equal(before?.attention, 'decision')
  assert.equal(before?.question, '')
  assert.deepEqual(before?.tool, { id: 'toolu_bash', name: 'Bash', label: 'Bash', detail: 'ls', pending: false })

  // With it: the question and its form, as if the transcript had the call.
  card({ asking: ASKING })
  await refresh()
  const held = await itemOf(port)
  assert.equal(held?.question, QUESTION)
  assert.equal(held?.tool?.id, 'toolu_1')
  assert.equal(held?.tool?.pending, true)
  assert.deepEqual(held?.tool?.questions, ASKING.questions)

  // Answered from the board: the keys go in, and it is done once Claude Code writes call and answer.
  const answering = post('answer', { session: 's1', toolUseId: 'toolu_1', answers: [{ options: ['Blue'] }] })
  await until(() => keysSent(box).length > 0, 10_000)
  writeFileSync(path, bashCall + bashResult + heldLines())
  const done = await answering
  assert.deepEqual([done.status, done.body], [200, { ok: true, answers: [{ question: QUESTION, answer: 'Blue' }] }])
  assert.deepEqual(keysSent(box), [['agent', 'send-keys', 'p1', '3']])

  // The transcript has it now: the transcript's, answered; the card's copy is not shown again.
  await refresh()
  assert.equal((await itemOf(port))?.tool?.pending, false)
  // A copy older than the transcript's last line (the session went on without it): not shown, not answered.
  writeFileSync(path, bashCall + bashResult)
  card({ asking: { ...ASKING, at: Date.parse('2026-10-21T08:50:00.000Z') } })
  await refresh()
  assert.equal((await itemOf(port))?.question, '')
  const old = await post('answer', { session: 's1', toolUseId: 'toolu_1', answers: [{ options: ['Blue'] }] })
  assert.match(old.body.error, /no longer open/)
  assert.equal(keysSent(box).length, 1)
}, 40_000)
