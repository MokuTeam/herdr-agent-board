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
  // No mode set: auto, and this page on 127.0.0.1 with no proxy in front is the board's own computer.
  assert.deepEqual(await res.clone().json(), {
    ok: true,
    state: 'launched',
    file: process.execPath,
    resolved: 'local',
    why: 'loopback-direct',
    viewer: '127.0.0.1',
  })
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

test('in link mode the page offers the call and the route gives the link, starting nothing', async () => {
  const launcher = fileURLToPath(new URL('../support/fake-launcher.ts', import.meta.url))
  const box = await sandbox()
  const record = join(box.dir, 'call.json')
  const project = join(box.dir, 'Acme project')
  mkdirSync(project)
  const panes = [
    {
      pane_id: 'p1',
      agent: 'claude',
      agent_session: { value: ID },
      agent_status: 'idle',
      cwd: project,
      workspace_id: 'wA',
    },
    { pane_id: 'p3', agent: 'claude', agent_status: 'idle', cwd: project, workspace_id: 'wA' },
  ]
  // A launcher that would write down its start, beside the link: the link goes first.
  const { board, post } = await boardServer(
    box,
    { mokupilot: { link: true, command: [process.execPath, launcher, record] } },
    panes,
  )
  assert.equal((await board()).mokupilot, true)
  assert.ok(isBoardPayload(await board()))
  assert.equal((await post(`/api/session/${ID}/mokupilot`, { 'x-board': '' })).status, 403)

  const res = await post(`/api/session/${ID}/mokupilot`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), {
    ok: true,
    state: 'link',
    url: `mokupilot://call?claude-session=${ID}&cwd=${encodeURIComponent(project)}`,
    resolved: 'link',
    why: 'mode-link',
  })
  const r = await post('/api/session/pane-p3/mokupilot')
  assert.equal(r.status, 409)
  assert.match(((await r.json()) as { error: string }).error, /Claude Code session/)
  await Bun.sleep(500)
  assert.equal(existsSync(record), false)
}, 30_000)

const configOf = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')

/**
 * The board with `cfg`, written to its config.json too: the panel's save edits that file. The
 * board keeps the config it was given (the watcher that reads the file again is the config
 * tests'), so a test after a save starts a board with what was saved.
 */
async function boardWith(box: Sandbox, cfg: Record<string, unknown>, panes: Pane[]) {
  const full = {
    language: 'en',
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    wakeUrl: null,
    refreshSec: 3600,
    ...cfg,
  }
  mkdirSync(join(configOf(box), '..'), { recursive: true })
  writeFileSync(configOf(box), JSON.stringify(full))
  box.state({
    'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [{ workspace_id: 'wA', label: 'Alpha' }] } } },
  })
  const { url, proc } = await serveBoard(box, full, { HERDR_PANE_ID: 'wB:p1' })
  for (let i = 0; i < 50; i++) {
    const b = (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
    if (!b.stale && Array.isArray(b.items) && b.items.length) break
    proc.send('refresh')
    await Bun.sleep(100)
  }
  const get = async (headers: Record<string, string> = {}) =>
    (await (await fetch(`${url}/api/mokupilot`, { headers })).json()) as Record<string, unknown>
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
      body: JSON.stringify(body),
    })
  return { get, post }
}

// tailscale serve in front of the board: the peer is 127.0.0.1, the caller its X-Forwarded-For.
const PHONE = { 'x-forwarded-for': '100.64.0.7' }

test('auto by who asks: a page through a proxy for another computer gets the link, this one a launch', async () => {
  const launcher = fileURLToPath(new URL('../support/fake-launcher.ts', import.meta.url))
  const box = await sandbox()
  const record = join(box.dir, 'call.json')
  const project = join(box.dir, 'Acme')
  mkdirSync(project)
  const panes = [
    {
      pane_id: 'p1',
      agent: 'claude',
      agent_session: { value: ID },
      agent_status: 'idle',
      cwd: project,
      workspace_id: 'wA',
    },
  ]
  const { get, post } = await boardWith(box, { mokupilot: { command: [process.execPath, launcher, record] } }, panes)

  // Settings → MokuPilot…: auto, MokuPilot here, and where a call from this page and from the phone goes.
  assert.deepEqual(await get(), {
    ok: true,
    mode: 'auto',
    off: false,
    here: 'ok',
    hereFile: process.execPath,
    resolved: 'local',
    why: 'loopback-direct',
    auto: { resolved: 'local', why: 'loopback-direct', viewer: '127.0.0.1' },
  })
  const fromPhone = await get(PHONE)
  assert.equal(fromPhone.resolved, 'link')
  assert.deepEqual(fromPhone.auto, { resolved: 'link', why: 'forwarded-other', viewer: '100.64.0.7' })

  const call = await post(`/api/session/${ID}/mokupilot`, {}, PHONE)
  assert.equal(call.status, 200)
  assert.deepEqual(await call.json(), {
    ok: true,
    state: 'link',
    url: `mokupilot://call?claude-session=${ID}&cwd=${encodeURIComponent(project)}`,
    resolved: 'link',
    why: 'forwarded-other',
    viewer: '100.64.0.7',
  })
  await Bun.sleep(300)
  assert.equal(existsSync(record), false)

  // The panel's save: refused without the board's header, from another site, or for a mode it does not know.
  assert.equal((await post('/api/mokupilot', { mode: 'local' }, { 'x-board': '' })).status, 403)
  assert.equal((await post('/api/mokupilot', { mode: 'local' }, { origin: 'http://evil.example' })).status, 403)
  const bad = await post('/api/mokupilot', { mode: 'remote' })
  assert.equal(bad.status, 409)
  assert.match(((await bad.json()) as { error: string }).error, /Unknown MokuPilot mode: remote/)
  assert.equal(((await get()) as { mode: string }).mode, 'auto')

  // This machine, saved: the phone's call starts here too, on a board with what was saved.
  assert.equal((await post('/api/mokupilot', { mode: 'local' })).status, 200)
  const written = JSON.parse(readFileSync(configOf(box), 'utf8')) as { mokupilot: unknown; language: string }
  assert.deepEqual(written.mokupilot, { command: [process.execPath, launcher, record], mode: 'local' })
  assert.equal(written.language, 'en')
  const saved = await boardWith(box, { mokupilot: written.mokupilot }, panes)
  assert.equal((await saved.get(PHONE)).why, 'mode-local')
  const here = await saved.post(`/api/session/${ID}/mokupilot`, {}, PHONE)
  assert.deepEqual(await here.json(), {
    ok: true,
    state: 'launched',
    file: process.execPath,
    resolved: 'local',
    why: 'mode-local',
  })
  await until(() => existsSync(record) && readFileSync(record, 'utf8').length > 0, 10_000)
}, 30_000)

test('the older "link": true reads as the link mode, and reading never rewrites config.json', async () => {
  const box = await sandbox()
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
  const { get, post } = await boardWith(box, { mokupilot: { link: true } }, panes)
  const before = readFileSync(configOf(box), 'utf8')
  const view = await get()
  assert.equal(view.mode, 'link')
  assert.equal(view.resolved, 'link')
  assert.equal(view.why, 'mode-link')
  // Nothing on this computer: shown, and no matter for the link.
  assert.equal(view.here, 'missing')
  const r = await post(`/api/session/${ID}/mokupilot`)
  assert.equal(((await r.json()) as { state: string }).state, 'link')
  assert.equal(readFileSync(configOf(box), 'utf8'), before)
  // Auto saved from the panel: `mode` written, `link` gone; this page is on the board's computer,
  // which has no MokuPilot.
  assert.equal((await post('/api/mokupilot', { mode: 'auto' })).status, 200)
  const written = JSON.parse(readFileSync(configOf(box), 'utf8')) as { mokupilot: unknown }
  assert.deepEqual(written.mokupilot, { mode: 'auto' })
  const saved = await boardWith(box, { mokupilot: written.mokupilot }, panes)
  assert.equal((await saved.get()).mode, 'auto')
  const local = await saved.post(`/api/session/${ID}/mokupilot`)
  const out = (await local.json()) as { ok: boolean; resolved: string; why: string; error: string }
  assert.equal(out.ok, false)
  assert.equal(out.resolved, 'local')
  assert.equal(out.why, 'loopback-direct')
}, 30_000)
