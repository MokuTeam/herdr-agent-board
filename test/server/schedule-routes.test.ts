import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

// The web board's side of the schedule (the CLI side: test/scheduler.test.mjs).
const HOUR = 3600e3
const dirOf = (box: Sandbox) => join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule')

function put(box: Sandbox, entry: Record<string, unknown>): void {
  mkdirSync(dirOf(box), { recursive: true })
  writeFileSync(
    join(dirOf(box), `${entry.id}.json`),
    JSON.stringify({ key: 's1', name: 'Test', created: Date.now(), ...entry }),
  )
}
const read = (box: Sandbox, id: string): Record<string, unknown> | null =>
  existsSync(join(dirOf(box), `${id}.json`))
    ? (JSON.parse(readFileSync(join(dirOf(box), `${id}.json`), 'utf8')) as Record<string, unknown>)
    : null

/** herdr with one Claude session s1 in pane p1. */
function herdrWith(box: Sandbox, status: string): void {
  const snapshot = {
    panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: status, cwd: box.dir }],
    tabs: [],
    workspaces: [],
  }
  box.state({
    'api snapshot': { result: { snapshot } },
    'agent get': { result: { agent: { agent: 'claude', agent_status: status, agent_session: { value: 's1' } } } },
    'agent prompt': { result: {} },
  })
}

test('the web board lists the schedule without the bookkeeping and cancels an entry', async () => {
  const box = await sandbox()
  herdrWith(box, 'idle')
  put(box, {
    id: 'abcdef',
    text: 'later',
    at: Date.now() + HOUR,
    next: Date.now() + HOUR,
    claim: { pid: 1, at: 1 },
    tried: 1,
  })
  const { url } = await serveBoard(box)
  const board = (await (await fetch(`${url}/api/board`)).json()) as {
    schedules: Record<string, unknown>[]
    scheduleLog: unknown[]
  }
  assert.equal(board.schedules.length, 1)
  assert.equal(board.schedules[0]?.text, 'later')
  assert.equal('claim' in (board.schedules[0] ?? {}) || 'tried' in (board.schedules[0] ?? {}), false)
  assert.deepEqual(board.scheduleLog, [])
  const post = (body: unknown, headers: Record<string, string> = { 'x-board': '1' }) =>
    fetch(`${url}/api/schedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  // The mode: when the session is free, then on time again.
  assert.equal((await post({ op: 'mode', id: 'abcdef', idle: true }, {})).status, 403)
  assert.equal((await post({ op: 'mode', id: 'abcdef', idle: true })).status, 200)
  assert.equal(read(box, 'abcdef')?.idle, true)
  assert.equal((await post({ op: 'mode', id: 'abcdef', idle: false })).status, 200)
  assert.equal('idle' in (read(box, 'abcdef') ?? {}), false)
  assert.equal((await post({ op: 'snooze', id: 'abcdef' })).status, 400)
  const cancel = (headers: Record<string, string>) => post({ op: 'cancel', id: 'abcdef' }, headers)
  assert.equal((await cancel({})).status, 403)
  assert.equal((await cancel({ 'x-board': '1' })).status, 200)
  assert.equal(read(box, 'abcdef'), null)
  assert.equal((await cancel({ 'x-board': '1' })).status, 404)
}, 15_000)
