import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useLanguage } from '../../src/core/lang.ts'
import { sameDir } from '../../src/core/launch/names.ts'
import { checkRequest } from '../../src/services/launch/request.ts'
import { sandbox, until } from '../support/sandbox.ts'
import { trustScreen } from '../support/trust-screen.ts'

// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

test('a launch request is checked before anything runs', async () => {
  const box = await sandbox()
  const dir = join(box.dir, 'Acme project')
  mkdirSync(dir)
  writeFileSync(join(box.dir, 'file.txt'), 'x')
  const launchOf = async (body: unknown, opts?: { categories?: Set<string> }) => {
    const r = await checkRequest(body, opts)
    assert.ok(r.ok, JSON.stringify(r))
    return r.launch
  }
  const fieldOf = async (body: unknown, opts?: { categories?: Set<string> }) => {
    const r = await checkRequest(body, opts)
    assert.ok(!r.ok, JSON.stringify(body).slice(0, 80))
    return r.field
  }
  const ok = await launchOf({ name: ' Acme ', cwd: dir, category: 'acme', workspace: { id: 'w2' }, message: ' hi ' })
  assert.deepEqual(
    { ...ok },
    {
      name: 'Acme',
      label: 'Acme',
      cwd: dir,
      category: 'acme',
      workspaceId: 'w2',
      workspaceLabel: '',
      newWorkspace: false,
      message: 'hi',
      worktree: null,
    },
  )
  assert.equal((await launchOf({ name: 'A', cwd: dir, workspace: { create: 'Fresh' } })).newWorkspace, true)
  // A lane must be one the board has; none given is "other".
  const lanes = { categories: new Set(['acme']) }
  assert.equal((await launchOf({ name: 'A', cwd: dir, workspace: { id: 'w2' } }, lanes)).category, 'other')
  assert.equal(
    (await launchOf({ name: 'A', cwd: dir, category: 'acme', workspace: { id: 'w2' } }, lanes)).category,
    'acme',
  )
  for (const category of ['Bad Id!', '-acme', 'nope'])
    assert.equal(await fieldOf({ name: 'A', cwd: dir, category, workspace: { id: 'w2' } }, lanes), 'category', category)
  // A workspace's name only fills {workspaceLabel}: one that could read as an option is dropped.
  assert.equal((await launchOf({ name: 'A', cwd: dir, workspace: { id: 'w2', label: '-x' } })).workspaceLabel, '')
  const fails: [unknown, string][] = [
    [{ name: '', cwd: dir, workspace: { id: 'w2' } }, 'name'],
    [{ name: 'A', cwd: join(box.dir, 'missing'), workspace: { id: 'w2' } }, 'cwd'],
    [{ name: 'A', cwd: join(box.dir, 'file.txt'), workspace: { id: 'w2' } }, 'cwd'],
    [{ name: 'A', cwd: '', workspace: { id: 'w2' } }, 'cwd'],
    [{ name: 'A', cwd: dir, workspace: { id: 'w2; rm -rf' } }, 'workspace'],
    [{ name: 'A', cwd: dir, workspace: { create: '' } }, 'workspace'],
    [{ name: 'A', cwd: dir, workspace: { create: '--focus' } }, 'workspace'],
    [{ name: 'A', cwd: dir, workspace: { id: '-w2' } }, 'workspace'],
    [{ name: 'A', cwd: dir, workspace: { id: 'w2' }, worktree: { branch: 'a..b' } }, 'worktree'],
    [{ name: 'A', cwd: dir, workspace: { id: 'w2' }, message: 'x'.repeat(20_001) }, 'message'],
  ]
  for (const [body, field] of fails) assert.equal(await fieldOf(body), field, JSON.stringify(body).slice(0, 80))
})

// ---------------------------------------------------------------- through the server
async function unusedPort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise(resolve => server.close(resolve))
  return port
}

/** A launch as the board payload shows it. */
type LaunchView = {
  id: string
  name: string
  cwd: string
  category: string
  workspaceId: string | null
  state: string
  step: string
  error: string
  kind: string
  pane: string | null
  worktree: { branch: string } | null
  newWorkspace: boolean
}
type BoardPayload = { stale: boolean; launches: LaunchView[]; items: { name: string; autoName: string }[] }

// Claude's input box as herdr reads it: a rule, the ❯ line with what is typed, a rule.
const RULE = '─'.repeat(30)
const SCREEN = (typed: string) => `Some reply.\n${RULE}\n❯ ${typed}\n${RULE}\n  ? for shortcuts\n`
const SNAPSHOT = {
  panes: [
    {
      pane_id: 'p1',
      agent: 'claude',
      agent_session: { value: 's1' },
      agent_status: 'idle',
      cwd: 'C:\\old',
      terminal_title_stripped: 'work-10',
      workspace_id: 'wA',
    },
  ],
  tabs: [],
  workspaces: [{ workspace_id: 'wA', label: 'Alpha' }],
}
const HERDR = {
  'api snapshot': { result: { snapshot: SNAPSHOT } },
  'workspace list': {
    result: {
      workspaces: [
        { workspace_id: 'wA', label: 'Alpha', focused: true },
        { workspace_id: 'wB', label: 'Board' },
      ],
    },
  },
  'workspace create': {
    result: { workspace: { workspace_id: 'wN' }, tab: { tab_id: 'wN:t1' }, root_pane: { pane_id: 'wN:p1' } },
  },
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9' } } },
  'tab rename': { result: null },
  'agent list': { result: { agents: [{ name: 'alpha-job' }, { name: 'work-10' }] } },
  'agent start': { result: { type: 'ok' } },
  'agent prompt': { result: null },
  'agent get': { result: { agent: { agent_session: { value: 's1' }, agent_status: 'idle', name: 'work-10' } } },
  'agent rename': { result: null },
  'pane read': { text: 'Session renamed to: Alpha job' },
  'agent read': { text: SCREEN('') },
  'pane list': {
    result: {
      panes: [
        { pane_id: 'wN:p1', agent: null, tab_id: 'wN:t1' },
        { pane_id: 'wN:p2', agent: null, tab_id: 'wN:t1' },
      ],
    },
  },
  'tab close': { result: null },
  'pane send-keys': { result: null },
}

async function boardServer(cfg: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const box = await sandbox()
  box.state(HERDR)
  const port = await unusedPort()
  const proc = box.run(
    'server',
    {
      port,
      categories: [
        { id: 'acme', title: 'Acme', color: 'blue', paths: [] },
        { id: 'other', title: 'Other', color: 'gray' },
      ],
      wakeUrl: null,
      refreshSec: 3600,
      ...cfg,
    },
    env,
  )
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready))
  const url = `http://127.0.0.1:${port}`
  const board = async () => (await (await fetch(`${url}/api/board`)).json()) as BoardPayload
  const deadline = Date.now() + 5000
  while ((await board()).stale) {
    if (Date.now() > deadline) throw new Error('not fresh')
    await new Promise(r => setTimeout(r, 10))
  }
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
      body: JSON.stringify(body),
    })
  const started = async (body: unknown) => ((await (await post('/api/launch', body)).json()) as { id: string }).id
  const launched = async (id: string) => {
    let l: LaunchView | undefined
    const end = Date.now() + 10_000
    while (Date.now() < end) {
      l = (await board()).launches.find(x => x.id === id)
      if (l && (l.state === 'done' || l.state === 'failed')) return l
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error(`launch ${id} did not finish: ${JSON.stringify(l)}`)
  }
  return { box, proc, url, board, post, started, launched }
}

const cardOf = (cards: string, key: string | undefined) =>
  JSON.parse(readFileSync(join(cards, `${key}.json`), 'utf8')) as { category?: string }
const launcher = fileURLToPath(new URL('../support/fake-launcher.ts', import.meta.url))

test('a new session through herdr: a tab in the chosen workspace, Claude with its id, named, briefed, in its lane', async () => {
  const { box, post, launched, board, url } = await boardServer()
  const dir = join(box.dir, 'Alpha project')
  mkdirSync(dir)
  // The guards every change has, plus the page's own origin for this one.
  assert.equal((await fetch(`${url}/api/launch`, { method: 'POST', body: '{}' })).status, 403)
  assert.equal(
    (await post('/api/launch', { name: 'x', cwd: dir, workspace: { id: 'wA' } }, { origin: 'http://evil.example' }))
      .status,
    403,
  )
  const bad = await post('/api/launch', { name: 'x', cwd: join(dir, 'nope'), workspace: { id: 'wA' } })
  assert.equal(bad.status, 400)
  assert.equal(((await bad.json()) as { field: string }).field, 'cwd')
  assert.equal(
    box.calls().some(a => a[0] === 'tab'),
    false,
  )

  const res = await post('/api/launch', {
    name: 'Alpha job',
    cwd: dir,
    category: 'acme',
    workspace: { id: 'wA', label: 'Alpha' },
    message: '-dash first, then text',
  })
  assert.equal(res.status, 200)
  const { id } = (await res.json()) as { id: string }
  const l = await launched(id)
  assert.equal(l.state, 'done', l.error)
  assert.equal(l.pane, 'wA:p9')
  const calls = box.calls()
  assert.deepEqual(
    calls.find(a => a[0] === 'tab' && a[1] === 'create'),
    ['tab', 'create', '--workspace', 'wA', '--cwd', dir, '--label', 'Alpha job', '--no-focus'],
  )
  const start = calls.find(a => a[0] === 'agent' && a[1] === 'start') ?? []
  assert.deepEqual(start.slice(0, 7), ['agent', 'start', 'alpha-job-2', '--kind', 'claude', '--pane', 'wA:p9'])
  const sid = start.at(-1) ?? ''
  assert.deepEqual(start.slice(-3, -1), ['--', '--session-id'])
  assert.match(sid, /^[0-9a-f-]{36}$/)
  const prompts = calls.filter(a => a[0] === 'agent' && a[1] === 'prompt').map(a => a.slice(2))
  assert.deepEqual(prompts, [
    ['wA:p9', '/rename Alpha job'],
    ['wA:p9', ' -dash first, then text'],
  ])
  // The card existed before Claude did, so its first brief already names the lane.
  assert.equal(cardOf(box.cards, sid).category, 'acme')
  assert.equal((await board()).launches.length, 1)
}, 30_000)

test('a new session through the configured launcher: a new workspace, the values as arguments, its pane, and a failure with its reason', async () => {
  const box0 = await sandbox()
  const record = join(box0.dir, 'launcher.json')
  const command = [
    process.execPath,
    launcher,
    record,
    '-Name',
    '{name}',
    '-Cwd',
    '{cwd}',
    '-Workspace',
    '{workspace}',
    ['-BriefFile', '{messageFile}'],
    ['-Session', '{sessionId}'],
  ]
  const { box, started, launched, post } = await boardServer({ launch: { command } })
  const dir = join(box.dir, 'Beta')
  mkdirSync(dir)
  const id = await started({
    name: 'Beta work',
    cwd: dir,
    category: 'acme',
    workspace: { create: 'Beta space' },
    message: 'Line one\nline two',
  })
  const l = await launched(id)
  assert.equal(l.state, 'done', l.error)
  assert.equal(l.pane, 'wT:p7')
  const seen = JSON.parse(readFileSync(record, 'utf8')) as {
    args: string[]
    brief: string | null
    workspace: string | null
    pane: string | null
  }
  const session = seen.args[seen.args.indexOf('-Session') + 1] ?? ''
  assert.deepEqual(seen.args.slice(0, 6), ['-Name', 'Beta work', '-Cwd', dir, '-Workspace', 'wN'])
  assert.equal(seen.brief, 'Line one\nline two')
  assert.match(session, /^[0-9a-f-]{36}$/)
  // It runs for that workspace, not for the board's own pane.
  assert.equal(seen.workspace, 'wN')
  assert.equal(seen.pane, null)
  const calls = box.calls()
  assert.deepEqual(
    calls.find(a => a[0] === 'workspace' && a[1] === 'create'),
    ['workspace', 'create', '--cwd', dir, '--label', 'Beta space', '--no-focus'],
  )
  // The tab of shells the new workspace came with goes, the launcher made its own tab.
  assert.ok(calls.some(a => a.join(' ') === 'tab close wN:t1'))
  assert.equal(cardOf(box.cards, session).category, 'acme')

  const f = await launched(await started({ name: 'Will fail', cwd: dir, workspace: { id: 'wA' } }))
  assert.equal(f.state, 'failed')
  assert.equal(f.error, 'Claude in wT:p9 waits for a dialog (folder trust?). Answer it in that tab.')
  assert.equal(f.kind, 'dialog')
  assert.equal(f.pane, 'wT:p9')
  assert.equal((await post(`/api/launch/${f.id}/dismiss`, {})).status, 200)
}, 30_000)

test('renaming: the board’s name on the card, back to the automatic one, and Claude only when asked', async () => {
  const { box, post, board, proc } = await boardServer()
  const named = async () => {
    proc.send('refresh')
    await new Promise(r => setTimeout(r, 150))
    const item = (await board()).items[0]
    assert.ok(item)
    return item
  }
  const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error
  assert.equal((await post('/api/session/s1/rename', { name: 'Billing fixes' })).status, 200)
  let it = await named()
  assert.equal(it.name, 'Billing fixes')
  assert.equal(it.autoName, 'work-10')
  assert.equal(
    box.calls().some(a => a[0] === 'agent' && a[1] === 'prompt'),
    false,
  ) // nothing typed into the session
  assert.equal((await post('/api/session/s1/rename', { name: '/bad' })).status, 409)
  assert.equal((await post('/api/session/s1/rename', { name: '' })).status, 200)
  it = await named()
  assert.equal(it.name, 'work-10')

  assert.equal((await post('/api/session/s1/rename', { name: 'Billing fixes', claude: true })).status, 200)
  const calls = box.calls().map(a => a.join(' '))
  assert.ok(calls.includes('agent prompt p1 /rename Billing fixes'))
  assert.ok(calls.includes('agent rename p1 billing-fixes'))

  // A session in the middle of a turn is not typed into.
  box.state({
    ...HERDR,
    'agent get': {
      result: { agent: { agent_session: { value: 's1' }, agent_status: 'working', name: 'billing-fixes' } },
    },
  })
  const busy = await post('/api/session/s1/rename', { name: 'Other', claude: true })
  assert.equal(busy.status, 409)
  assert.match(await errorOf(busy), /working|работает/)
  // Only idle and done: a state herdr cannot tell is no place to type either.
  box.state({
    ...HERDR,
    'agent get': {
      result: { agent: { agent_session: { value: 's1' }, agent_status: 'unknown', name: 'billing-fixes' } },
    },
  })
  assert.equal((await post('/api/session/s1/rename', { name: 'Other', claude: true })).status, 409)

  // What the user started typing would go out with /rename: refused, and the board keeps the old name.
  const prompted = () => box.calls().filter(a => a[0] === 'agent' && a[1] === 'prompt').length
  const before = prompted()
  box.state({ ...HERDR, 'agent read': { text: SCREEN('half a thought') } })
  const draft = await post('/api/session/s1/rename', { name: 'Draft name', claude: true })
  assert.equal(draft.status, 409)
  assert.match(await errorOf(draft), /unsent text|недописанный/)
  // No input box on screen (a picker, a dialog): refused too.
  box.state({ ...HERDR, 'agent read': { text: 'Select a model\n> Opus\n  Sonnet\n' } })
  assert.equal((await post('/api/session/s1/rename', { name: 'Draft name', claude: true })).status, 409)
  assert.equal(prompted(), before)
  assert.equal((await named()).name, 'Billing fixes')

  // Claude does not say "Session renamed": the board name stays, herdr's does not follow, the page is told.
  box.state({ ...HERDR, 'pane read': { text: 'nothing new' } })
  const quiet = await post('/api/session/s1/rename', { name: 'Quiet name', claude: true })
  assert.equal(quiet.status, 200)
  assert.equal(((await quiet.json()) as { confirmed: boolean }).confirmed, false)
  assert.ok(!box.calls().some(a => a.join(' ') === 'agent rename p1 quiet-name'))
  assert.equal((await named()).name, 'Quiet name')
}, 30_000)

test('a retry starts in the worktree and the workspace the failed launch made, not new ones', async () => {
  const { box, started, launched } = await boardServer({}, { PATH: process.env.PATH ?? '' })
  const repo = join(box.dir, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'a.txt'), 'a')
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  // The worktree is made, then herdr fails: the view says where it is and offers no worktree again.
  box.state({ ...HERDR, 'tab create': { error: 'workspace is gone' } })
  const failed = await launched(
    await started({
      name: 'Wt job',
      cwd: join(repo, 'src'),
      category: 'acme',
      workspace: { id: 'wA', label: 'Alpha' },
      worktree: { branch: 'feature-x' },
    }),
  )
  assert.equal(failed.state, 'failed')
  assert.equal(failed.worktree, null)
  assert.ok(sameDir(failed.cwd, join(box.dir, 'repo-feature-x', 'src')), failed.cwd)
  box.state(HERDR)
  const again = await started({
    name: failed.name,
    cwd: failed.cwd,
    category: failed.category,
    workspace: { id: 'wA' },
    worktree: failed.worktree,
  })
  assert.equal((await launched(again)).state, 'done')
  assert.equal(git('worktree', 'list').toString().trim().split('\n').length, 2)

  // A new workspace is made, then the agent fails: the retry goes to that workspace.
  box.state({ ...HERDR, 'agent start': { error: 'no such agent kind' } })
  const ws = await launched(
    await started({ name: 'New ws', cwd: repo, category: 'acme', workspace: { create: 'Fresh' } }),
  )
  assert.equal(ws.state, 'failed')
  assert.deepEqual([ws.workspaceId, ws.newWorkspace], ['wN', false])
}, 40_000)

test('a launcher that runs too long is ended with everything it started', async () => {
  const box0 = await sandbox()
  const record = join(box0.dir, 'launcher.json')
  const { box, started, launched } = await boardServer({
    launch: { command: [process.execPath, launcher, record, '-Name', '{name}'], timeoutSec: 1 },
  })
  const begun = Date.now()
  const l = await launched(await started({ name: 'Will hang', cwd: box.dir, workspace: { id: 'wA' } }))
  assert.equal(l.state, 'failed')
  assert.equal(l.kind, 'timeout')
  assert.ok(Date.now() - begun < 8000, 'the card does not wait for pipes a descendant keeps open')
  // What it started would have opened a tab 2.5 s in: it is gone with the launcher.
  await new Promise(r => setTimeout(r, 3500))
  assert.equal(existsSync(`${record}.late`), false)
}, 30_000)

test('dismissing a running launch takes it off the board; it goes on and its session keeps its lane', async () => {
  const { box, post, board, started } = await boardServer()
  const gate = join(box.dir, 'agent-start-gate')
  box.state({ ...HERDR, 'agent start': { result: { type: 'ok' }, waitFor: gate } })
  const id = await started({
    name: 'Gone quiet',
    cwd: box.dir,
    category: 'acme',
    workspace: { id: 'wA' },
    message: 'go on',
  })
  const deadline = Date.now() + 5000
  while ((await board()).launches.find(l => l.id === id)?.step !== 'agent') {
    if (Date.now() > deadline) throw new Error('never reached the agent step')
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal((await post(`/api/launch/${id}/dismiss`, {})).status, 200)
  assert.deepEqual((await board()).launches, [])
  writeFileSync(gate, '')
  const prompted = () =>
    box
      .calls()
      .filter(a => a[0] === 'agent' && a[1] === 'prompt')
      .map(a => a.slice(2).join(' '))
  const end = Date.now() + 10_000
  while (!prompted().includes('wA:p9 go on')) {
    if (Date.now() > end) throw new Error(`the launch did not go on: ${JSON.stringify(prompted())}`)
    await new Promise(r => setTimeout(r, 50))
  }
  assert.deepEqual((await board()).launches, [])
  const sid = box
    .calls()
    .find(a => a[0] === 'agent' && a[1] === 'start')
    ?.at(-1)
  assert.equal(cardOf(box.cards, sid).category, 'acme')
}, 30_000)

// ---------------------------------------------------------------- Claude's folder-trust dialog
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const blocked = { result: { agent: { agent_session: { value: null }, agent_status: 'blocked', name: 'x' } } }
const idle = { result: { agent: { agent_session: { value: null }, agent_status: 'idle', name: 'x' } } }
type Box = Awaited<ReturnType<typeof sandbox>>
const keysSent = (box: Box) =>
  box
    .calls()
    .filter(a => a[0] === 'pane' && a[1] === 'send-keys')
    .map(a => a.slice(2).join(' '))
const promptsSent = (box: Box) =>
  box
    .calls()
    .filter(a => a[0] === 'agent' && a[1] === 'prompt')
    .map(a => a.slice(2).join(' '))
async function launchState(
  board: () => Promise<BoardPayload>,
  id: string,
  pred: (l: LaunchView | undefined) => boolean,
  what: string,
): Promise<LaunchView> {
  const end = Date.now() + 10_000
  for (;;) {
    const l = (await board()).launches.find(x => x.id === id)
    if (l && pred(l)) return l
    if (Date.now() > end) throw new Error(`${what}: ${JSON.stringify(l)}`)
    await sleep(30)
  }
}

test('Claude asks to trust a new folder: the launch waits on its card, and on request moves the cursor it sees to "Yes", then names and briefs it', async () => {
  const { box, post, board, launched, started } = await boardServer()
  const dir = join(box.dir, 'a fresh project') // a space: Claude may break the line there
  mkdirSync(dir)
  const dialog = (selected: 'no' | 'yes') => ({ text: trustScreen(dir, { selected, width: 30 }) })
  const state = {
    ...HERDR,
    'agent start': { code: 'agent_not_ready', error: 'agent_not_ready: blocked during startup' },
    'agent get': blocked,
    'pane read': { seq: [dialog('no'), dialog('no'), dialog('yes'), { text: 'Session renamed to: Fresh one' }] },
  }
  box.state(state)
  const id = await started({
    name: 'Fresh one',
    cwd: dir,
    category: 'acme',
    workspace: { id: 'wA' },
    message: 'Say hello.',
  })
  const held = await launchState(board, id, l => l?.state === 'trust', 'never asked to trust')
  assert.equal(held.pane, 'wA:p9')
  assert.deepEqual(keysSent(box), []) // not a key before the user says so
  assert.equal((await post(`/api/launch/${id}/trust`, {})).status, 200)
  // The cursor was on "No, exit": one step down, read again, then Enter.
  assert.deepEqual(keysSent(box), ['wA:p9 down', 'wA:p9 enter'])
  // Trusted, Claude asks something else next (a project's MCP servers): the card says it waits in herdr.
  const asked = await launchState(board, id, l => l?.state === 'waiting', 'a dialog after the trust went unnoticed')
  assert.equal(asked.step, 'dialog')
  assert.deepEqual(keysSent(box), ['wA:p9 down', 'wA:p9 enter']) // and no key for that one
  box.state({ ...state, 'agent get': idle })
  const l = await launched(id)
  assert.equal(l.state, 'done', l.error)
  assert.deepEqual(promptsSent(box), ['wA:p9 /rename Fresh one', 'wA:p9 Say hello.'])
}, 40_000)

test('"Close the tab" closes it and drops the launch; "Trust" refuses a screen without the dialog for that folder', async () => {
  const { box, post, board, started } = await boardServer()
  const dir = join(box.dir, 'unsure')
  mkdirSync(dir)
  const state = {
    ...HERDR,
    'agent start': { code: 'agent_not_ready', error: 'agent_not_ready: blocked' },
    'agent get': blocked,
    'pane read': { text: trustScreen(dir) },
    'pane get': { result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude' } } },
  }
  box.state(state)
  const id = await started({ name: 'Unsure', cwd: dir, category: 'acme', workspace: { id: 'wA' } })
  await launchState(board, id, l => l?.state === 'trust', 'never asked to trust')
  const sid = box
    .calls()
    .find(a => a[0] === 'agent' && a[1] === 'start')
    ?.at(-1)
  assert.ok(existsSync(join(box.cards, `${sid}.json`)))
  // The screen moved on (answered in herdr, or another folder): no key goes.
  box.state({ ...state, 'pane read': { text: trustScreen(join(box.dir, 'elsewhere')) } })
  const refused = await post(`/api/launch/${id}/trust`, {})
  assert.equal(refused.status, 409)
  assert.match(((await refused.json()) as { error: string }).error, /trust dialog|доверии/)
  box.state({ ...state, 'pane read': { text: 'PS C:\\> ' } })
  assert.equal((await post(`/api/launch/${id}/trust`, {})).status, 409)
  assert.deepEqual(keysSent(box), [])
  assert.equal((await post(`/api/launch/${id}/close`, {})).status, 200)
  assert.ok(box.calls().some(a => a.join(' ') === 'tab close wA:t9'))
  assert.equal(
    (await board()).launches.some(l => l.id === id),
    false,
  )
  // The card the board made for it held nothing but the lane: it goes with the tab.
  assert.equal(existsSync(join(box.cards, `${sid}.json`)), false)
}, 30_000)

test('a launcher that gives up at the trust dialog: the launch is kept, and once trusted the board does what the launcher did not', async () => {
  const box0 = await sandbox()
  const record = join(box0.dir, 'launcher.json')
  const { box, post, board, launched, started } = await boardServer({
    launch: {
      command: [process.execPath, launcher, record, '-Name', '{name}', '-Cwd', '{cwd}', '-Workspace', '{workspace}'],
    },
  })
  const dir = join(box.dir, 'Will fail here')
  mkdirSync(dir)
  // The stand-in fails like spawn-agent: "Claude in wT:p9 waits for a dialog (folder trust?)".
  const trusted = { text: trustScreen(dir, { selected: 'yes' }) }
  const state = {
    ...HERDR,
    'agent get': blocked,
    'agent list': { result: { agents: [] } },
    'pane read': { seq: [trusted, trusted, { text: 'Session renamed to: Will fail' }] },
  }
  box.state(state)
  const id = await started({
    name: 'Will fail',
    cwd: dir,
    category: 'acme',
    workspace: { id: 'wA' },
    message: 'First task.',
  })
  const held = await launchState(
    board,
    id,
    l => l?.state === 'trust' || l?.state === 'failed',
    'neither held nor failed',
  )
  assert.equal(held.state, 'trust', held.error)
  assert.equal(held.pane, 'wT:p9')
  assert.equal((await post(`/api/launch/${id}/trust`, {})).status, 200)
  assert.deepEqual(keysSent(box), ['wT:p9 enter']) // already on "Yes": only Enter
  box.state({ ...state, 'agent get': idle })
  const l = await launched(id)
  assert.equal(l.state, 'done', l.error)
  assert.deepEqual(promptsSent(box), ['wT:p9 /rename Will fail', 'wT:p9 First task.'])
  assert.ok(box.calls().some(a => a.join(' ') === 'agent rename wT:p9 will-fail'))
}, 40_000)
