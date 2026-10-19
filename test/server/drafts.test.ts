import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { sandbox, until } from '../support/sandbox.ts'

type Board = { stale: boolean; items: { session?: string | null; key?: string }[] }
type Result = { ok: boolean }

test('HTTP messages recheck a fresh snapshot and reject replaced sessions/offline without prompt', async () => {
  const box = await sandbox()
  const snapshot = (session: string) => ({
    panes: [{ pane_id: 'p', agent: 'claude', agent_session: { value: session }, agent_status: 'idle' }],
    tabs: [],
    workspaces: [],
  })
  const state = (session: string): Record<string, Record<string, unknown>> => ({
    'api snapshot': { result: { snapshot: snapshot(session) } },
    'agent get': { result: { agent: { agent_session: { value: session }, agent_status: 'idle' } } },
    'agent prompt': { result: {} },
  })
  box.state(state('a'))
  const { url: base, proc } = await serveBoard(box)
  async function fresh(): Promise<void> {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const board = (await (await fetch(`${base}/api/board`)).json()) as Board
      if (!board.stale && board.items[0]?.session === 'a') return
      await new Promise(r => setTimeout(r, 10))
    }
    throw Error('No fresh fixture board')
  }
  await fresh()
  const post = async (id: string): Promise<Result> =>
    (await (
      await fetch(`${base}/api/session/a/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify({ text: 'hello', session: 'a', requestId: id }),
      })
    ).json()) as Result
  const prompts = () => box.calls().filter(a => a[1] === 'prompt').length
  box.state(state('b'))
  assert.equal((await post('replaced')).ok, false)
  assert.equal(prompts(), 0)
  box.state(state('a'))
  proc.send('refresh')
  await fresh()
  const release = join(box.dir, 'release-prompt')
  const delayed = state('a')
  ;(delayed['agent prompt'] as Record<string, unknown>).waitFor = release
  box.state(delayed)
  const first = post('duplicate')
  const second = post('duplicate')
  await until(() => box.calls().some(a => a[1] === 'prompt'))
  writeFileSync(release, '')
  assert.ok((await first).ok)
  assert.ok((await second).ok)
  assert.equal((await post('duplicate')).ok, true)
  assert.equal(prompts(), 1)
  box.state({ 'api snapshot': { error: 'offline' } })
  assert.notEqual((await post('offline')).ok, true)
  assert.equal(prompts(), 1)
}, 15_000)

test('a pane with no Claude session id still takes messages, also without a request id', async () => {
  const box = await sandbox()
  box.state({
    'api snapshot': {
      result: {
        snapshot: { panes: [{ pane_id: 'p', agent: 'codex', agent_status: 'idle' }], tabs: [], workspaces: [] },
      },
    },
    'agent get': { result: { agent: { agent_status: 'idle' } } },
    'agent prompt': { result: {} },
  })
  const { url: base } = await serveBoard(box)
  for (let i = 0; i < 100; i++) {
    const board = (await (await fetch(`${base}/api/board`)).json()) as Board
    if (board.items[0]?.key === 'pane-p') break
    await new Promise(r => setTimeout(r, 20))
  }
  const r = (await (
    await fetch(`${base}/api/session/pane-p/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ text: 'hi', session: null }),
    })
  ).json()) as Result
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(
    box.calls().filter(a => a[1] === 'prompt'),
    [['agent', 'prompt', 'p', 'hi']],
  )
}, 15_000)
