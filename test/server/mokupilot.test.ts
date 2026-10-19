// A MokuPilot call through the board's server (POST /api/session/<key>/mokupilot, the payload's
// `mokupilot`): upstream's test/mokupilot.test.mjs (#44), its last two tests. The launcher is a
// stand-in (support/fake-launcher.ts) that writes down how it was started.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isBoardPayload } from '../../web/src/api/client.ts'
import { serveBoard } from '../support/board-server.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'

const ID = '0b3f8c2e-5d1a-4c6b-9e7f-1a2b3c4d5e6f'

type Pane = Record<string, unknown>

/** The board in the sandbox, its herdr data fresh; it runs in a herdr pane of its own, which is not the call's. */
async function boardServer(box: Sandbox, cfg: Record<string, unknown>, panes: Pane[]) {
  box.state({
    'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [{ workspace_id: 'wA', label: 'Alpha' }] } } },
  })
  // English whatever the system language: the tests read the board's texts.
  const { url, proc } = await serveBoard(box, { language: 'en', ...cfg }, { HERDR_PANE_ID: 'wB:p1' })
  const board = async (): Promise<Record<string, unknown>> => (await fetch(`${url}/api/board`)).json()
  for (let i = 0; i < 50; i++) {
    const b = await board()
    if (!b.stale && Array.isArray(b.items) && b.items.length) break
    proc.send('refresh')
    await Bun.sleep(100)
  }
  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
      body: '{}',
    })
  return { board, post }
}

test('the board starts a MokuPilot call with a fork of a Claude session, only from its own page', async () => {
  const launcher = fileURLToPath(new URL('../support/fake-launcher.ts', import.meta.url))
  const box = await sandbox()
  const record = join(box.dir, 'call.json')
  const project = join(box.dir, 'Acme')
  const other = join(box.dir, 'Other')
  mkdirSync(project)
  mkdirSync(other)
  const panes = [
    {
      pane_id: 'p1',
      agent: 'claude',
      agent_session: { value: ID },
      agent_status: 'idle',
      cwd: other,
      workspace_id: 'wA',
    },
    {
      pane_id: 'p2',
      agent: 'codex',
      agent_session: { value: '1c9d0f3a-2b4e-4d6f-8a1b-2c3d4e5f6a7b' },
      agent_status: 'idle',
      cwd: project,
      workspace_id: 'wA',
    },
    { pane_id: 'p3', agent: 'claude', agent_status: 'idle', cwd: project, workspace_id: 'wA' },
  ]
  // The session's transcript says where it started; the pane may have moved on since.
  const folder = join(box.env.HOME ?? '', '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, `${ID}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd: project, sessionId: ID, message: { role: 'user', content: 'hi' } })}\n`,
  )
  const { board, post } = await boardServer(
    box,
    { mokupilot: { command: [process.execPath, launcher, record] } },
    panes,
  )
  assert.equal((await board()).mokupilot, true)
  // The page takes the board with it as it comes.
  assert.ok(isBoardPayload(await board()))

  assert.equal((await post(`/api/session/${ID}/mokupilot`, { 'x-board': '' })).status, 403)
  assert.equal((await post(`/api/session/${ID}/mokupilot`, { origin: 'http://evil.example' })).status, 403)
  assert.equal(existsSync(record), false)

  const res = await post(`/api/session/${ID}/mokupilot`)
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()))
  await until(() => existsSync(record) && readFileSync(record, 'utf8').length > 0, 10_000)
  const seen = JSON.parse(readFileSync(record, 'utf8'))
  assert.deepEqual(seen.args, ['call', '--claude-session', ID, '--cwd', project])
  assert.equal(seen.cwd, realpathSync(project))
  assert.equal(seen.pane, null)

  for (const key of ['1c9d0f3a-2b4e-4d6f-8a1b-2c3d4e5f6a7b', 'pane-p3']) {
    const r = await post(`/api/session/${key}/mokupilot`)
    assert.equal(r.status, 409, key)
    assert.match(((await r.json()) as { error: string }).error, /Claude Code session/)
  }
}, 30_000)

test('without MokuPilot the page offers no call, and asking for one says what is missing', async () => {
  const box = await sandbox()
  const nope = join(box.dir, 'MokuPilot', 'MokuPilot')
  const panes = [
    {
      pane_id: 'p1',
      agent: 'claude',
      agent_session: { value: ID },
      agent_status: 'idle',
      cwd: box.dir,
      workspace_id: 'wA',
    },
  ]
  const { board, post } = await boardServer(box, { mokupilot: { command: [nope] } }, panes)
  assert.equal((await board()).mokupilot, false)
  assert.ok(isBoardPayload(await board()))
  const r = await post(`/api/session/${ID}/mokupilot`)
  assert.equal(r.status, 409)
  assert.match(((await r.json()) as { error: string }).error, /MokuPilot not found/)
}, 30_000)
