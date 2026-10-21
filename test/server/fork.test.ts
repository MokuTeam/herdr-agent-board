// A fork of a session against the fake herdr: POST /api/session/<key>/fork starts a new session
// in a new tab with a copy of the conversation (claude --resume <id> --fork-session, an id of its
// own), in the session's folder, lane and workspace, named and briefed; the session itself is not
// touched. These run the server and the board's spawn-agent, as the archive's Return tests do.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { unusedPort } from '../support/board-server.ts'
import { type Child, type Sandbox, sandbox, until } from '../support/sandbox.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
const CODEX_FORK = 'b9d417d7-9b02-4e83-9dba-ec64536ae951'
const calls = (box: Sandbox) => box.calls().map(a => a.join(' '))
const configFile = (box: Sandbox) => join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
const cardOf = (box: Sandbox, key: string): Record<string, unknown> | null => {
  const file = join(box.cards, `${key}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

/** A project folder with Claude's transcript of S in it, and S's card. */
function project(box: Sandbox): string {
  const dir = join(box.dir, 'probe')
  mkdirSync(dir, { recursive: true })
  const projects = join(box.env.HOME as string, '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(projects, { recursive: true })
  const line = { type: 'user', cwd: dir, sessionId: S, message: { role: 'user', content: 'run the probe' } }
  writeFileSync(join(projects, `${S}.jsonl`), `${JSON.stringify({ ...line, timestamp: new Date().toISOString() })}\n`)
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(
    join(box.cards, `${S}.json`),
    JSON.stringify({ key: S, name: 'Probe card', category: 'personal', result: 'tests green' }),
  )
  return dir
}

/** herdr with S idle in wP:p1 (workspace Personal), and a new tab wP:t9 whose Claude comes up idle. */
function herdrWith(box: Sandbox, dir: string, kind = 'claude'): void {
  const pane = {
    pane_id: 'wP:p1',
    tab_id: 'wP:t1',
    workspace_id: 'wP',
    agent: kind,
    agent_session: { value: S },
    agent_status: 'idle',
    cwd: dir,
    terminal_title_stripped: 'Probe',
  }
  const fresh = {
    pane_id: 'wP:p9',
    tab_id: 'wP:t9',
    workspace_id: 'wP',
    agent: kind,
    agent_status: 'idle',
    cwd: dir,
  }
  const workspaces = [{ workspace_id: 'wP', label: 'Personal' }]
  box.state({
    'api snapshot': { result: { snapshot: { panes: [pane], tabs: [], workspaces } } },
    'pane list': { result: { panes: [pane] } },
    'pane get wP:p1': { result: { pane } },
    'pane get wP:p9': { seq: [{ result: { pane: { ...fresh, agent: null } } }, { result: { pane: fresh } }] },
    'agent get': {
      result: {
        agent: { agent: kind, agent_status: 'idle', agent_session: { value: kind === 'codex' ? CODEX_FORK : S } },
      },
    },
    'agent start': { result: null },
    'workspace list': { result: { workspaces } },
    'tab create': { result: { tab: { tab_id: 'wP:t9' }, root_pane: { pane_id: 'wP:p9', terminal_id: 'term-9' } } },
    'pane run': { result: null },
    'agent list': { result: { agents: [] } },
    'agent rename': { result: null },
    'agent prompt': { result: null },
    'pane read': { text: 'Session renamed to: Probe card · fork' },
  })
}

async function board(box: Sandbox, cfg: Record<string, unknown> = {}) {
  const port = await unusedPort()
  const proc: Child = box.run('server', {
    port,
    categories: [{ id: 'personal', title: 'Personal', color: 'blue' }],
    wakeUrl: null,
    refreshSec: 3600,
    language: 'en',
    ...cfg,
  })
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready), 10_000)
  const url = `http://127.0.0.1:${port}`
  const payload = async () => (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
  // The session on the board, from a refresh (the first one may have started before herdr was set).
  for (const end = Date.now() + 10_000; ; ) {
    if (((await payload()).items as { key: string }[]).some(i => i.key === S)) break
    if (Date.now() > end) throw new Error(`not on the board: ${JSON.stringify(proc.messages)}`)
    proc.send('refresh')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    }).then(async r => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }))
  return { proc, payload, post }
}

function codexProject(box: Sandbox): string {
  const bin = join(box.dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), 'echo fake-codex', { mode: 0o755 })
  box.env.PATH = `${bin}${delimiter}${box.env.PATH}`
  const dir = join(box.dir, 'Codex проект 100%')
  mkdirSync(dir, { recursive: true })
  const sessions = join(box.env.USERPROFILE as string, '.codex/sessions/2026/10/20')
  mkdirSync(sessions, { recursive: true })
  const lines = [
    { type: 'session_meta', payload: { id: S, cwd: dir } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run the probe' }] },
    },
  ]
  writeFileSync(join(sessions, `rollout-test-${S}.jsonl`), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(
    join(box.cards, `${S}.json`),
    JSON.stringify({ key: S, name: 'Codex source', category: 'personal', result: 'keep me' }),
  )
  return dir
}

async function settled(b: Awaited<ReturnType<typeof board>>, id: unknown) {
  for (const end = Date.now() + 10_000; ; ) {
    const launch = ((await b.payload()).launches as Record<string, unknown>[]).find(l => l.id === id)
    if (launch?.state === 'done' || launch?.state === 'failed') return launch
    if (Date.now() > end) throw new Error(`launch did not settle: ${JSON.stringify(launch)}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

test('Codex Fork uses its own launcher and new identity, keeps the source and accepts literal Unicode, percent signs and a leading dash in the message', async () => {
  const box = await sandbox()
  const dir = codexProject(box)
  // The shell can be elsewhere when Codex was started with --cd.
  herdrWith(box, box.dir, 'codex')
  const before = readFileSync(join(box.cards, `${S}.json`), 'utf8')
  const b = await board(box, { launch: { agent: 'pi', args: ['--continue'] } })
  const name = 'Форк 100% & review'
  const message = '-Try %USERNAME% $env:HOME & `literal` "quotes" ^ 100%\nвторая строка'
  const r = await b.post(`/api/session/${S}/fork`, { name, message, profile: 'missing-profile', agent: 'claude' })
  expect(r.status).toBe(200)
  expect(await b.payload()).toMatchObject({ fork: false, codexFork: true })
  expect(await settled(b, r.body.id)).toMatchObject({ state: 'done', fork: S })
  const start = box.calls().find(c => c[0] === 'agent' && c[1] === 'start')
  expect(start?.slice(3)).toEqual(['--kind', 'codex', '--pane', 'wP:p9', '--timeout', '120000', '--', 'fork', S])
  expect(box.calls()).toContainEqual([
    'tab',
    'create',
    '--workspace',
    'wP',
    '--cwd',
    dir,
    '--label',
    name,
    '--no-focus',
  ])
  expect(calls(box).some(c => /^pane run/.test(c))).toBe(false)
  expect(box.calls()).toContainEqual(['agent', 'prompt', 'wP:p9', ` ${message}`])
  expect(cardOf(box, CODEX_FORK)).toMatchObject({ name, category: 'personal', forkOf: S })
  expect(cardOf(box, CODEX_FORK)?.profileWant).toBeUndefined()
  expect(readFileSync(join(box.cards, `${S}.json`), 'utf8')).toBe(before)
}, 30_000)

test('a Codex fork without a first message runs no turn and waits for a delayed session identity', async () => {
  const box = await sandbox()
  const dir = codexProject(box)
  herdrWith(box, dir, 'codex')
  const b = await board(box)
  const state = JSON.parse(readFileSync(box.env.FAKE_HERDR_STATE as string, 'utf8'))
  state['agent get'] = {
    seq: [
      { result: { agent: { agent: 'codex', agent_status: 'idle' } } },
      { result: { agent: { agent: 'codex', agent_status: 'idle', agent_session: { value: CODEX_FORK } } } },
    ],
  }
  box.state(state)
  const r = await b.post(`/api/session/${S}/fork`, {})
  expect(r.status).toBe(200)
  expect(await settled(b, r.body.id)).toMatchObject({ state: 'done' })
  const start = box.calls().find(c => c[0] === 'agent' && c[1] === 'start')
  expect(start?.slice(-2)).toEqual(['fork', S])
  expect(cardOf(box, CODEX_FORK)).toMatchObject({ name: 'Codex source · fork', forkOf: S })
  expect(calls(box).some(c => c.startsWith('agent prompt'))).toBe(false)
}, 30_000)

test('a fork refuses a replaced agent or the source id reported for the new pane, without changing either card', async () => {
  const box = await sandbox()
  const dir = codexProject(box)
  herdrWith(box, dir, 'codex')
  const b = await board(box)
  const before = readFileSync(join(box.cards, `${S}.json`), 'utf8')
  for (const [kind, id] of [
    ['codex', S],
    ['codex', S.toUpperCase()],
    ['claude', CODEX_FORK],
  ]) {
    const state = JSON.parse(readFileSync(box.env.FAKE_HERDR_STATE as string, 'utf8'))
    state['agent get'] = { result: { agent: { agent: kind, agent_status: 'idle', agent_session: { value: id } } } }
    box.state(state)
    const r = await b.post(`/api/session/${S}/fork`, {})
    expect(r.status).toBe(200)
    expect(await settled(b, r.body.id)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('did not report a new Codex session'),
    })
    expect(cardOf(box, CODEX_FORK)).toBeNull()
    expect(readFileSync(join(box.cards, `${S}.json`), 'utf8')).toBe(before)
  }
}, 30_000)

test('a Codex startup dialog stays for the user, without Claude trust keys or a second copy of the first message', async () => {
  const box = await sandbox()
  const dir = codexProject(box)
  herdrWith(box, dir, 'codex')
  const b = await board(box)
  const state = JSON.parse(readFileSync(box.env.FAKE_HERDR_STATE as string, 'utf8'))
  state['agent start'] = { code: 'agent_not_ready', error: 'agent_not_ready: blocked during startup' }
  state['agent get'] = {
    seq: [
      { result: { agent: { agent: 'codex', agent_status: 'blocked' } } },
      { result: { agent: { agent: 'codex', agent_status: 'idle', agent_session: { value: CODEX_FORK } } } },
    ],
  }
  box.state(state)
  const r = await b.post(`/api/session/${S}/fork`, { message: 'First turn' })
  expect(r.status).toBe(200)
  expect(await settled(b, r.body.id)).toMatchObject({ state: 'done' })
  expect(cardOf(box, CODEX_FORK)).toMatchObject({ forkOf: S })
  expect(calls(box).some(c => /^(pane read|agent read|pane send-keys)/.test(c))).toBe(false)
  expect(box.calls().filter(c => c[0] === 'agent' && c[1] === 'prompt')).toEqual([
    ['agent', 'prompt', 'wP:p9', 'First turn'],
  ])
  expect(box.calls().filter(c => c[0] === 'agent' && c[1] === 'start')).toHaveLength(1)
}, 30_000)

test('a long first Codex turn does not hold up or fail its launch', async () => {
  const box = await sandbox()
  const dir = codexProject(box)
  herdrWith(box, dir, 'codex')
  const state = JSON.parse(readFileSync(box.env.FAKE_HERDR_STATE as string, 'utf8'))
  const agent = { agent: 'codex', agent_session: { value: CODEX_FORK } }
  state['agent get'] = {
    result: { agent: { ...agent, agent_status: 'idle' } },
    until: ['agent prompt'],
    // biome-ignore lint/suspicious/noThenProperty: the fake herdr fixture changes its reply after a command.
    then: { result: { agent: { ...agent, agent_status: 'working' } } },
  }
  box.state(state)
  const b = await board(box)
  const r = await b.post(`/api/session/${S}/fork`, { message: 'A slow first turn' })
  expect(await settled(b, r.body.id)).toMatchObject({ state: 'done' })
  const seen = box.calls()
  const prompt = seen.findIndex(c => c[0] === 'agent' && c[1] === 'prompt')
  const identity = seen.findIndex(c => c[0] === 'agent' && c[1] === 'get')
  expect(prompt).toBeGreaterThan(identity)
  expect(seen.slice(prompt + 1).some(c => c[0] === 'agent' && c[1] === 'get')).toBe(false)
}, 30_000)

test('a Codex identity arriving after ten seconds remains one pending fork and then links the card', async () => {
  const box = await sandbox()
  const dir = codexProject(box)
  herdrWith(box, dir, 'codex')
  const state = JSON.parse(readFileSync(box.env.FAKE_HERDR_STATE as string, 'utf8'))
  state['agent get'] = { result: { agent: { agent: 'codex', agent_status: 'working' } } }
  box.state(state)
  const b = await board(box)
  const r = await b.post(`/api/session/${S}/fork`, {})
  await new Promise(resolve => setTimeout(resolve, 11_000))
  const pending = ((await b.payload()).launches as Record<string, unknown>[]).find(l => l.id === r.body.id)
  expect(pending).toMatchObject({ state: 'waiting', error: '' })
  expect(cardOf(box, CODEX_FORK)).toBeNull()
  state['agent get'] = {
    result: { agent: { agent: 'codex', agent_status: 'working', agent_session: { value: CODEX_FORK } } },
  }
  box.state(state)
  expect(await settled(b, r.body.id)).toMatchObject({ state: 'done' })
  expect(cardOf(box, CODEX_FORK)).toMatchObject({ forkOf: S, category: 'personal' })
  expect(box.calls().filter(c => c[0] === 'agent' && c[1] === 'start')).toHaveLength(1)
}, 30_000)

test('dismissing a pending Codex fork cancels identity polling and does not send a late prompt', async () => {
  const box = await sandbox()
  const dir = codexProject(box)
  herdrWith(box, dir, 'codex')
  const state = JSON.parse(readFileSync(box.env.FAKE_HERDR_STATE as string, 'utf8'))
  state['agent get'] = { result: { agent: { agent: 'codex', agent_status: 'idle' } } }
  box.state(state)
  const b = await board(box)
  const r = await b.post(`/api/session/${S}/fork`, { message: 'Do not send this after dismiss' })
  await until(() => calls(box).some(c => c.startsWith('agent get')))
  expect((await b.post(`/api/launch/${r.body.id}/dismiss`, {})).status).toBe(200)
  state['agent get'] = {
    result: { agent: { agent: 'codex', agent_status: 'idle', agent_session: { value: CODEX_FORK } } },
  }
  box.state(state)
  await new Promise(resolve => setTimeout(resolve, 800))
  expect((await b.payload()).launches).toEqual([])
  expect(cardOf(box, CODEX_FORK)).toBeNull()
  expect(calls(box).some(c => c.startsWith('agent prompt'))).toBe(false)
}, 30_000)

test('Codex Fork is unavailable without Codex on PATH, and the route also refuses it before opening a tab', async () => {
  const box = await sandbox()
  const dir = codexProject(box)
  box.env.PATH = dirname(process.execPath)
  herdrWith(box, dir, 'codex')
  const b = await board(box)
  expect((await b.payload()).codexFork).toBe(false)
  const r = await b.post(`/api/session/${S}/fork`, {})
  expect(r.status).toBe(409)
  expect(r.body.error).toContain('not on the board’s PATH')
  expect(calls(box).some(c => /^(tab create|agent start)/.test(c))).toBe(false)
}, 30_000)

test('Codex without a local rollout and pi remain refused before a tab opens', async () => {
  const box = await sandbox()
  const dir = project(box)
  for (const kind of ['codex', 'pi']) {
    herdrWith(box, dir, kind)
    const b = await board(box)
    const r = await b.post(`/api/session/${S}/fork`, {})
    expect(r.status).toBe(409)
    expect(calls(box).some(c => /^(tab create|pane run|agent start)/.test(c))).toBe(false)
    b.proc.kill()
    await b.proc.exited
  }
}, 30_000)

test('Fork starts a new session in a new tab with a copy of the conversation, in its folder and workspace, named and briefed; the session is not touched', async () => {
  const box = await sandbox()
  const dir = project(box)
  herdrWith(box, dir)
  mkdirSync(join(configFile(box), '..'), { recursive: true })
  // pi as the default for new sessions changes nothing here: a fork is Claude Code's.
  const launch = { claude: ['claude-tg', '--dangerously-skip-permissions'], default: 'pi', pi: 'pi' }
  writeFileSync(configFile(box), JSON.stringify({ launch }))
  const b = await board(box, { launch })
  assert.equal((await b.payload()).fork, true)
  const r = await b.post(`/api/session/${S}/fork`, { name: 'Probe card · fork', message: 'Try the other way.' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  expect(r.body).toMatchObject({ ok: true, name: 'Probe card · fork', launch: { fork: S, parent: S } })
  await until(() => calls(box).some(c => c === 'agent prompt wP:p9 Try the other way.'), 20_000)
  const seen = calls(box)
  assert.ok(
    seen.includes(`tab create --workspace wP --cwd ${dir} --label Probe card · fork --no-focus`),
    seen.join('\n'),
  )
  const run = seen.find(c => c.startsWith('pane run wP:p9')) ?? ''
  const id = /--session-id ([0-9a-f-]{36})$/.exec(run)?.[1] ?? ''
  assert.equal(
    run,
    `pane run wP:p9 claude-tg --dangerously-skip-permissions --resume ${S} --fork-session --session-id ${id}`,
  )
  assert.ok(seen.includes('agent prompt wP:p9 /rename Probe card · fork'), seen.join('\n'))
  // The fork's card: the session's lane, in its profile, under its own id.
  // Whose fork it is, and since when (its copied lines are older): the board links the two by it.
  expect(cardOf(box, id)).toMatchObject({ category: 'personal', profileWant: 'default', forkOf: S })
  assert.ok(Number(cardOf(box, id)?.forkAt) > Date.now() - 60_000)
  // Nothing went to the session itself, and its card is as it was.
  assert.deepEqual(
    seen.filter(c => c.includes('wP:p1') && !c.startsWith('pane get')),
    [],
  )
  expect(cardOf(box, S)).toMatchObject({ name: 'Probe card', category: 'personal', result: 'tests green' })
  // Without a name it gets the session's with "· fork" after it.
  const again = await b.post(`/api/session/${S}/fork`, {})
  expect(again.body).toMatchObject({ ok: true, name: 'Probe card · fork' })
}, 60_000)

test('a fork is refused before anything starts for a session that is not Claude’s, and offered only where the launcher can fork', async () => {
  const box = await sandbox()
  const dir = project(box)
  herdrWith(box, dir)
  // launch.agent for another agent cannot resume a session by its id: the board offers no fork.
  const b = await board(box, { launch: { agent: 'codex' } })
  assert.equal((await b.payload()).fork, false)
  const r = await b.post(`/api/session/${S}/fork`, { name: 'x' })
  assert.equal(r.status, 409)
  assert.match(String(r.body.error), /cannot fork one that way/)
  assert.equal(
    calls(box).some(c => /^(tab create|pane run|agent start)/.test(c)),
    false,
  )
}, 60_000)
