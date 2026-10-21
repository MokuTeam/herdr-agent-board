// A fork of a session against the fake herdr: POST /api/session/<key>/fork starts a new session
// in a new tab with a copy of the conversation (claude --resume <id> --fork-session, an id of its
// own), in the session's folder, lane and workspace, named and briefed; the session itself is not
// touched. These run the server and the board's spawn-agent, as the archive's Return tests do.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unusedPort } from '../support/board-server.ts'
import { type Child, type Sandbox, sandbox, until } from '../support/sandbox.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
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
function herdrWith(box: Sandbox, dir: string): void {
  const pane = {
    pane_id: 'wP:p1',
    tab_id: 'wP:t1',
    workspace_id: 'wP',
    agent: 'claude',
    agent_session: { value: S },
    agent_status: 'idle',
    cwd: dir,
    terminal_title_stripped: 'Probe',
  }
  const fresh = {
    pane_id: 'wP:p9',
    tab_id: 'wP:t9',
    workspace_id: 'wP',
    agent: 'claude',
    agent_status: 'idle',
    cwd: dir,
  }
  const workspaces = [{ workspace_id: 'wP', label: 'Personal' }]
  box.state({
    'api snapshot': { result: { snapshot: { panes: [pane], tabs: [], workspaces } } },
    'pane list': { result: { panes: [pane] } },
    'pane get wP:p1': { result: { pane } },
    'pane get wP:p9': { seq: [{ result: { pane: { ...fresh, agent: null } } }, { result: { pane: fresh } }] },
    'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: S } } } },
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
