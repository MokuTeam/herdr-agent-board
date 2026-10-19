import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useLanguage } from '../../src/core/lang.ts'
import { sameDir } from '../../src/core/launch/names.ts'
import { defaultProfileDir, mergeProfiles, profileSet } from '../../src/core/profiles.ts'
import type { Item } from '../../src/core/types.ts'
import { checkRequest } from '../../src/services/launch/request.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { trustScreen } from '../support/trust-screen.ts'

// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

test('a launch request is checked before anything runs', async () => {
  const box = await sandbox()
  const dir = join(box.dir, 'Acme project')
  mkdirSync(dir)
  writeFileSync(join(box.dir, 'file.txt'), 'x')
  // One profile, as on every teammate's computer: the default folder of a home folder of its own.
  const home = join(box.dir, 'home folder')
  const own = defaultProfileDir(home)
  const profiles = profileSet(mergeProfiles([], [], home).list, own)
  const launchOf = async (body: unknown, opts?: { categories?: Set<string> }) => {
    const r = await checkRequest(body, { profiles, ...opts })
    assert.ok(r.ok, JSON.stringify(r))
    return r.launch
  }
  const fieldOf = async (body: unknown, opts?: { categories?: Set<string> }) => {
    const r = await checkRequest(body, { profiles, ...opts })
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
      profile: 'default',
      profileDir: own,
      configDir: null,
      parent: null,
      profileArgs: [],
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

  // Another profile than the board's own: its folder is set, its arguments (strings only) go with it.
  const workDir = join(home, '.claude-work')
  mkdirSync(workDir, { recursive: true })
  const work = { id: 'work', title: 'Work', dir: workDir, color: 'teal', hidden: false, args: ['--model', 'sonnet'] }
  const two = profileSet([...profiles.list, work], own)
  const r = await checkRequest({ name: 'A', cwd: dir, workspace: { id: 'w2' }, profile: 'work' }, { profiles: two })
  assert.ok(r.ok, JSON.stringify(r))
  assert.deepEqual(
    [r.launch.profile, r.launch.profileDir, r.launch.configDir, r.launch.parent, r.launch.profileArgs],
    ['work', workDir, workDir, null, ['--model', 'sonnet']],
  )
  // Two shown and none chosen: the board does not guess.
  const none = await checkRequest({ name: 'A', cwd: dir, workspace: { id: 'w2' } }, { profiles: two })
  assert.deepEqual(none, { ok: false, field: 'profile', error: 'Choose a profile' })
  // "New here" from a card on the board: its profile, by the card's name when another is asked.
  const items = [{ key: 's1', name: 'Work one', profile: 'work' }] as unknown as Item[]
  const here = await checkRequest(
    { name: 'A', cwd: dir, workspace: { id: 'w2' }, parent: 's1' },
    { profiles: two, items },
  )
  assert.ok(here.ok, JSON.stringify(here))
  assert.deepEqual([here.launch.profile, here.launch.parent], ['work', 's1'])
  assert.deepEqual(
    await checkRequest(
      { name: 'A', cwd: dir, workspace: { id: 'w2' }, parent: 's1', profile: 'default' },
      { profiles: two, items },
    ),
    { ok: false, field: 'profile', error: 'A session started from Work one runs in its profile, Work' },
  )
  // One shown, work found besides and hidden: "New here" from a session with no card yet starts in
  // the shown one, its env left alone, as before profiles; one that reported a folder no profile
  // has is not folded into it.
  const oneShown = profileSet([...profiles.list, { ...work, hidden: true }], own)
  const cardless = [{ key: 's2', name: 'Old one', profile: null }] as unknown as Item[]
  const fromOld = await checkRequest(
    { name: 'A', cwd: dir, workspace: { id: 'w2' }, parent: 's2' },
    { profiles: oneShown, items: cardless },
  )
  assert.ok(fromOld.ok, JSON.stringify(fromOld))
  assert.deepEqual([fromOld.launch.profile, fromOld.launch.configDir], ['default', null])
  const stray = [{ key: 's3', name: 'Stray', profile: null, profileFolder: join(box.dir, 'x') }] as unknown as Item[]
  assert.deepEqual(
    await checkRequest(
      { name: 'A', cwd: dir, workspace: { id: 'w2' }, parent: 's3' },
      { profiles: oneShown, items: stray },
    ),
    { ok: false, field: 'profile', error: 'The profile of Stray is not one the board knows: choose one' },
  )
  // A card in another profile than its start asked for: "New here" asks, never repeats the mistake.
  const wrong = [{ key: 's4', name: 'Eps', profile: 'default', profileWanted: 'work' }] as unknown as Item[]
  assert.deepEqual(
    await checkRequest({ name: 'A', cwd: dir, workspace: { id: 'w2' }, parent: 's4' }, { profiles: two, items: wrong }),
    { ok: false, field: 'profile', error: 'The profile of Eps is not one the board knows: choose one' },
  )
  const chosen = await checkRequest(
    { name: 'A', cwd: dir, workspace: { id: 'w2' }, parent: 's4', profile: 'work' },
    { profiles: two, items: wrong },
  )
  assert.ok(chosen.ok, JSON.stringify(chosen))
  assert.deepEqual([chosen.launch.profile, chosen.launch.parent], ['work', 's4'])
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
  profile?: string
  parent?: string | null
}
type BoardPayload = {
  stale: boolean
  launches: LaunchView[]
  items: { key: string; name: string; autoName: string; profile?: string | null }[]
}

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

// herdr's own `agent start`: the board's path when launch.agent is set.
const VIA_HERDR = { launch: { agent: 'claude' } }

// The Claude profiles of the sandbox's home folder as config.json lists them: default and work
// shown (work with arguments of its own), gamedev hidden.
const homeOf = (box: Sandbox) => box.env.HOME ?? ''
const workDirOf = (box: Sandbox) => join(homeOf(box), '.claude-work')
const PROFILES = (box: Sandbox) => ({
  profiles: [
    { id: 'default', title: 'Default', dir: join(homeOf(box), '.claude'), color: 'indigo', hidden: false },
    { id: 'work', title: 'Work', dir: workDirOf(box), color: 'teal', hidden: false, args: ['--model', 'sonnet'] },
    { id: 'gamedev', title: 'Gamedev', dir: join(homeOf(box), '.claude-gamedev'), color: 'pink', hidden: true },
  ],
})

/** A server's config or extra env, as is or made from its sandbox (its home folder). */
type Of<T> = T | ((box: Sandbox) => T)

async function boardServer(cfg: Of<Record<string, unknown>> = {}, env: Of<Record<string, string>> = {}) {
  const box = await sandbox()
  box.state(HERDR)
  // Claude's folders in its home folder: the default one, and a work one found beside it (listed
  // hidden unless the config shows it).
  mkdirSync(join(homeOf(box), '.claude'), { recursive: true })
  mkdirSync(workDirOf(box), { recursive: true })
  writeFileSync(join(workDirOf(box), 'settings.json'), '{}')
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
      ...(typeof cfg === 'function' ? cfg(box) : cfg),
    },
    typeof env === 'function' ? env(box) : env,
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
  JSON.parse(readFileSync(join(cards, `${key}.json`), 'utf8')) as { category?: string; profileWant?: string }
/** No herdr call set an env: a launch in the board's own profile is as before profiles. */
const noEnv = (box: Sandbox) =>
  assert.deepEqual(
    box.calls().filter(a => a.some(x => x === '--env' || x.startsWith('--env='))),
    [],
  )
/** The panes recorded as opened in a profile (profile-panes.json), or null when there is no such file. */
const panesFile = (box: Sandbox) => join(box.env.LOCALAPPDATA ?? '', 'herdr/plugins/agent-board/profile-panes.json')
const recordedPanes = (box: Sandbox) =>
  existsSync(panesFile(box))
    ? (JSON.parse(readFileSync(panesFile(box), 'utf8')) as Record<string, { profile?: string; terminal?: string }>)
    : null
const launcher = fileURLToPath(new URL('../support/fake-launcher.ts', import.meta.url))

test('a new session through herdr (launch.agent): a tab in the chosen workspace, Claude with its id, named, briefed, in its lane', async () => {
  const { box, post, launched, board, url } = await boardServer(VIA_HERDR)
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
  noEnv(box)
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
  noEnv(box)
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
  const { box, started, launched } = await boardServer(VIA_HERDR, { PATH: process.env.PATH ?? '' })
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
  noEnv(box)
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
  noEnv(box)
}, 30_000)

test('dismissing a running launch takes it off the board; it goes on and its session keeps its lane', async () => {
  const { box, post, board, started } = await boardServer(VIA_HERDR)
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
  noEnv(box)
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
  const { box, post, board, launched, started } = await boardServer(VIA_HERDR)
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
  noEnv(box)
}, 40_000)

test('"Close the tab" closes it and drops the launch; "Trust" refuses a screen without the dialog for that folder', async () => {
  const { box, post, board, started } = await boardServer(VIA_HERDR)
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
  noEnv(box)
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
  noEnv(box)
}, 40_000)

// ---------------------------------------------------------------- the board's own spawn-agent (no launch set)
const PANE_READY = {
  result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude', agent_status: 'idle' } },
}

test('with no launcher set, the board starts sessions with its own spawn-agent: Claude with its id, named, briefed, in its lane', async () => {
  const { box, started, launched } = await boardServer()
  box.state({ ...HERDR, 'pane get': PANE_READY, 'pane run': { result: null } })
  const dir = join(box.dir, 'Gamma')
  mkdirSync(dir)
  const id = await started({
    name: 'Gamma job',
    cwd: dir,
    category: 'acme',
    workspace: { id: 'wA', label: 'Alpha' },
    message: 'First line\nsecond line',
  })
  const l = await launched(id)
  assert.equal(l.state, 'done', l.error)
  assert.equal(l.pane, 'wA:p9')
  const calls = box.calls()
  assert.deepEqual(
    calls.find(a => a[0] === 'tab' && a[1] === 'create'),
    ['tab', 'create', '--workspace', 'wA', '--cwd', dir, '--label', 'Gamma job', '--no-focus'],
  )
  const run = calls.find(a => a[0] === 'pane' && a[1] === 'run') ?? []
  const sid = /^claude --session-id ([0-9a-f-]{36})$/.exec(run[3] ?? '')?.[1]
  assert.ok(sid, String(run[3]))
  assert.deepEqual(promptsSent(box), ['wA:p9 /rename Gamma job', 'wA:p9 First line\nsecond line'])
  assert.ok(calls.some(a => a.join(' ') === 'agent rename wA:p9 gamma-job'))
  assert.equal(
    calls.some(a => a[0] === 'agent' && a[1] === 'start'),
    false,
  )
  assert.equal(cardOf(box.cards, sid).category, 'acme')
  // The first message went through a file only this launch read, gone once it was done.
  assert.deepEqual(readdirSync(join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/launch')), [])
  noEnv(box)
}, 40_000)

test('the board’s spawn-agent in a new workspace uses its first pane; a dialog that is not about trust is waited for, then the names and the message', async () => {
  const { box, board, started, launched } = await boardServer()
  const dir = join(box.dir, 'Delta')
  mkdirSync(dir)
  const rootPane = {
    seq: [
      { result: { pane: { pane_id: 'wN:p1', tab_id: 'wN:t1', agent: null } } },
      { result: { pane: { pane_id: 'wN:p1', tab_id: 'wN:t1', agent: 'claude', agent_status: 'blocked' } } },
    ],
  }
  const state = {
    ...HERDR,
    'pane get': rootPane,
    'pane run': { result: null },
    'agent get': blocked,
    'agent list': { result: { agents: [] } },
    'pane read': { text: 'Found 2 new MCP servers in .mcp.json\n❯ 1. Use these servers' },
  }
  box.state(state)
  const id = await started({
    name: 'Delta job',
    cwd: dir,
    category: 'acme',
    workspace: { create: 'Delta space' },
    message: 'Go.',
  })
  const waiting = await launchState(
    board,
    id,
    l => l?.state === 'waiting' || l?.state === 'failed',
    'neither waited nor failed',
  )
  assert.equal(waiting.state, 'waiting', waiting.error)
  assert.equal(waiting.pane, 'wN:p1')
  assert.deepEqual(promptsSent(box), []) // nothing typed while the dialog is up
  box.state({
    ...state,
    'agent get': idle,
    'pane read': { text: 'Session renamed to: Delta job' },
    'agent read': { text: SCREEN('') },
  })
  const l = await launched(id)
  assert.equal(l.state, 'done', l.error)
  assert.deepEqual(promptsSent(box), ['wN:p1 /rename Delta job', 'wN:p1 Go.'])
  const calls = box.calls().map(a => a.join(' '))
  assert.equal(
    calls.some(c => c.startsWith('tab create')),
    false,
  )
  assert.ok(calls.includes('tab rename wN:t1 Delta job'))
  assert.ok(calls.includes('agent rename wN:p1 delta-job'))
  assert.equal(
    calls.some(c => c.startsWith('tab close')),
    false,
  ) // the session is in that tab
  noEnv(box)
}, 40_000)

// ---------------------------------------------------------------- Claude profiles
const callOf = (box: Sandbox, ...head: string[]) => box.calls().find(a => head.every((h, i) => a[i] === h)) ?? []
const anyCall = (box: Sandbox, ...head: string[]) => box.calls().some(a => head.every((h, i) => a[i] === h))
/** profile-panes.json as an earlier herdr run left it: records of pane ids herdr may give out again. */
const oldPanes = (box: Sandbox, panes: Record<string, { profile: string; terminal: string }>) => {
  mkdirSync(join(panesFile(box), '..'), { recursive: true })
  writeFileSync(panesFile(box), JSON.stringify(panes))
}
const OLD = { 'wA:p9': { profile: 'work', terminal: 't-old' }, 'wN:p1': { profile: 'work', terminal: 't-old' } }
const KEPT = { 'wZ:p1': { profile: 'work', terminal: 't-z' } }
// herdr's answers with the terminal each new pane holds; its snapshot has them, and wZ:p1 (KEPT),
// so a refresh does not forget them as panes herdr no longer has.
const OPENED = {
  'api snapshot': {
    result: {
      snapshot: {
        ...SNAPSHOT,
        panes: [
          ...SNAPSHOT.panes,
          { pane_id: 'wA:p9', terminal_id: 'term-9' },
          { pane_id: 'wN:p1', terminal_id: 'term-1' },
          { pane_id: 'wZ:p1', terminal_id: 't-z' },
        ],
      },
    },
  },
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9', terminal_id: 'term-9' } } },
  'workspace create': {
    result: {
      workspace: { workspace_id: 'wN' },
      tab: { tab_id: 'wN:t1' },
      root_pane: { pane_id: 'wN:p1', terminal_id: 'term-1' },
    },
  },
}

test('a launch into the board’s own profile is as before however the board’s env spells it: no --env anywhere', async () => {
  const flipped = (p: string) =>
    p.replace(/^[A-Za-z]/, c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))
  const spellings: ((box: Sandbox) => Record<string, string>)[] = [
    () => ({}),
    box => ({ CLAUDE_CONFIG_DIR: `${homeOf(box)}/.claude/` }),
    ...(process.platform === 'win32'
      ? [
          (box: Sandbox) => ({ CLAUDE_CONFIG_DIR: `${homeOf(box)}\\.claude\\` }),
          (box: Sandbox) => ({ CLAUDE_CONFIG_DIR: flipped(join(homeOf(box), '.claude')) }),
        ]
      : []),
  ]
  // One profile shown (work is found, not shown), no profile in the request: today's calls.
  for (const env of spellings) {
    const { box, started, launched } = await boardServer(VIA_HERDR, env)
    box.state({ ...HERDR, ...OPENED })
    oldPanes(box, { ...OLD, ...KEPT })
    const dir = join(box.dir, 'Alpha project')
    mkdirSync(dir)
    const l = await launched(await started({ name: 'Alpha job', cwd: dir, category: 'acme', workspace: { id: 'wA' } }))
    assert.equal(l.state, 'done', l.error)
    assert.deepEqual([l.profile, l.parent], ['default', null])
    assert.deepEqual(callOf(box, 'tab', 'create'), [
      'tab',
      'create',
      '--workspace',
      'wA',
      '--cwd',
      dir,
      '--label',
      'Alpha job',
      '--no-focus',
    ])
    const start = callOf(box, 'agent', 'start')
    assert.deepEqual(start.slice(7, -1), ['--timeout', '120000', '--', '--session-id'])
    assert.equal(cardOf(box.cards, start.at(-1)).profileWant, 'default')
    // A new workspace, the same: no env, and no record of an earlier pane of its first pane's id.
    const ws = await launched(
      await started({ name: 'Fresh job', cwd: dir, category: 'acme', workspace: { create: 'Fresh' } }),
    )
    assert.equal(ws.state, 'done', ws.error)
    assert.deepEqual(callOf(box, 'workspace', 'create'), [
      'workspace',
      'create',
      '--cwd',
      dir,
      '--label',
      'Fresh',
      '--no-focus',
    ])
    noEnv(box)
    // herdr opened those panes with its own env: an older record of their ids is not theirs.
    assert.deepEqual(recordedPanes(box), KEPT)
  }
  // Two shown and the board's own chosen: the same, through herdr and through spawn-agent.
  const spelled = (box: Sandbox) => ({ CLAUDE_CONFIG_DIR: `${homeOf(box)}/.claude/` })
  for (const viaHerdr of [true, false]) {
    const cfg = (box: Sandbox) => ({ ...(viaHerdr ? VIA_HERDR : {}), ...PROFILES(box) })
    const { box, started, launched } = await boardServer(cfg, spelled)
    box.state({ ...HERDR, ...OPENED, 'pane get': PANE_READY, 'pane run': { result: null } })
    const l = await launched(
      await started({ name: 'Alpha job', cwd: box.dir, category: 'acme', workspace: { id: 'wA' }, profile: 'default' }),
    )
    assert.equal(l.state, 'done', l.error)
    assert.deepEqual(callOf(box, 'tab', 'create').slice(-3), ['--label', 'Alpha job', '--no-focus'])
    if (viaHerdr) assert.deepEqual(callOf(box, 'agent', 'start').slice(-3, -1), ['--', '--session-id'])
    else assert.match(callOf(box, 'pane', 'run')[3] ?? '', /^claude --session-id [0-9a-f-]{36}$/)
    noEnv(box)
    assert.equal(recordedPanes(box)?.['wA:p9'], undefined)
  }
}, 120_000)

test('through herdr into work: --env on the tab, the pane recorded, work’s args, the card wants work', async () => {
  const { box, started, launched } = await boardServer(box => ({ ...VIA_HERDR, ...PROFILES(box) }))
  box.state({ ...HERDR, ...OPENED })
  const dir = join(box.dir, 'Alpha project')
  mkdirSync(dir)
  const l = await launched(
    await started({ name: 'Alpha job', cwd: dir, category: 'acme', workspace: { id: 'wA' }, profile: 'work' }),
  )
  assert.equal(l.state, 'done', l.error)
  assert.deepEqual([l.profile, l.parent], ['work', null])
  assert.deepEqual(callOf(box, 'tab', 'create'), [
    'tab',
    'create',
    '--workspace',
    'wA',
    '--cwd',
    dir,
    '--label',
    'Alpha job',
    '--env',
    `CLAUDE_CONFIG_DIR=${workDirOf(box)}`,
    '--no-focus',
  ])
  const start = callOf(box, 'agent', 'start')
  const sid = start.at(-1) ?? ''
  assert.deepEqual(start.slice(-5, -1), ['--', '--model', 'sonnet', '--session-id'])
  assert.match(sid, /^[0-9a-f-]{36}$/)
  const card = cardOf(box.cards, sid)
  assert.deepEqual([card.category, card.profileWant], ['acme', 'work'])
  // Recorded with the terminal herdr opened the pane with.
  const rec = recordedPanes(box)?.['wA:p9']
  assert.deepEqual([rec?.profile, rec?.terminal], ['work', 'term-9'])
}, 30_000)

test('a new workspace for work is made with the env, and the board’s spawn-agent gets --config-dir and uses its first pane', async () => {
  const { box, started, launched } = await boardServer(PROFILES)
  // spawn-agent reads the profiles (and work's args) from config.json.
  const configFile = join(box.env.APPDATA ?? '', 'herdr/plugins/config/agent-board/config.json')
  mkdirSync(join(configFile, '..'), { recursive: true })
  writeFileSync(configFile, JSON.stringify(PROFILES(box)))
  const dir = join(box.dir, 'Delta')
  mkdirSync(dir)
  const root = { pane_id: 'wN:p1', tab_id: 'wN:t1', terminal_id: 'term-1' }
  box.state({
    ...HERDR,
    ...OPENED,
    'pane get': {
      seq: [
        { result: { pane: { ...root, agent: null } } },
        { result: { pane: { ...root, agent: 'claude', agent_status: 'idle' } } },
      ],
    },
    'pane run': { result: null },
    'agent list': { result: { agents: [] } },
    'pane read': { text: 'Session renamed to: Delta job' },
  })
  const l = await launched(
    await started({
      name: 'Delta job',
      cwd: dir,
      category: 'acme',
      workspace: { create: 'Delta space' },
      message: 'Go.',
      profile: 'work',
    }),
  )
  assert.equal(l.state, 'done', l.error)
  assert.equal(l.pane, 'wN:p1')
  assert.deepEqual(callOf(box, 'workspace', 'create'), [
    'workspace',
    'create',
    '--cwd',
    dir,
    '--label',
    'Delta space',
    '--env',
    `CLAUDE_CONFIG_DIR=${workDirOf(box)}`,
    '--no-focus',
  ])
  // spawn-agent took the pane the board opened in work (it refuses one not recorded so).
  const run = callOf(box, 'pane', 'run')
  assert.equal(run[2], 'wN:p1')
  const sid = /^claude --model sonnet --session-id ([0-9a-f-]{36})$/.exec(run[3] ?? '')?.[1]
  assert.ok(sid, String(run[3]))
  assert.equal(anyCall(box, 'tab', 'create'), false)
  assert.deepEqual(promptsSent(box), ['wN:p1 /rename Delta job', 'wN:p1 Go.'])
  const rec = recordedPanes(box)?.['wN:p1']
  assert.deepEqual([rec?.profile, rec?.terminal], ['work', 'term-1'])
  assert.equal(cardOf(box.cards, sid).profileWant, 'work')
}, 40_000)

test('launch.command gets {profile}, {profileDir} and CLAUDE_CONFIG_DIR for work, and the inherited env for default', async () => {
  const box0 = await sandbox()
  const record = join(box0.dir, 'launcher.json')
  const command = [
    process.execPath,
    launcher,
    record,
    '-Name',
    '{name}',
    '-Profile',
    '{profile}',
    '-Dir',
    '{profileDir}',
  ]
  // The board's env names its own folder its own way: a launch in it keeps that env as it is.
  const { box, started, launched } = await boardServer(
    box => ({ launch: { command }, ...PROFILES(box) }),
    box => ({ CLAUDE_CONFIG_DIR: `${homeOf(box)}/.claude/` }),
  )
  const seen = () => JSON.parse(readFileSync(record, 'utf8')) as { args: string[]; configDir: string | null }
  const work = await launched(
    await started({ name: 'Work job', cwd: box.dir, workspace: { id: 'wA' }, profile: 'work' }),
  )
  assert.equal(work.state, 'done', work.error)
  assert.deepEqual(seen().args.slice(2), ['-Profile', 'work', '-Dir', workDirOf(box)])
  assert.equal(seen().configDir, workDirOf(box))
  const own = await launched(
    await started({ name: 'Own job', cwd: box.dir, workspace: { id: 'wA' }, profile: 'default' }),
  )
  assert.equal(own.state, 'done', own.error)
  assert.deepEqual(seen().args.slice(2), ['-Profile', 'default', '-Dir', join(homeOf(box), '.claude')])
  assert.equal(seen().configDir, `${homeOf(box)}/.claude/`)
  noEnv(box)
  // The panes a launcher opens are its own: the board records none of them.
  assert.equal(recordedPanes(box), null)
}, 30_000)

test('refused before anything runs: two shown and none chosen, hidden, unknown, a folder that is gone', async () => {
  const { box, post, board } = await boardServer(box => ({ ...VIA_HERDR, ...PROFILES(box) }))
  const refused = async (extra: Record<string, unknown>, error: string) => {
    const r = await post('/api/launch', {
      name: 'Nope',
      cwd: box.dir,
      category: 'acme',
      workspace: { id: 'wA' },
      ...extra,
    })
    assert.equal(r.status, 400, JSON.stringify(extra))
    assert.deepEqual(await r.json(), { ok: false, field: 'profile', error })
  }
  await refused({}, 'Choose a profile')
  await refused({ profile: 'gamedev' }, 'The profile Gamedev is hidden: show it in Settings → Profiles')
  await refused({ profile: 'nope' }, 'No profile “nope”')
  // s1 has no card yet: the board does not know its profile, so "New here" asks.
  await refused({ parent: 's1' }, 'The profile of work-10 is not one the board knows: choose one')
  await refused({ parent: 'gone' }, 'The profile of gone is not one the board knows: choose one')
  // Listed, then its folder deleted.
  rmSync(workDirOf(box), { recursive: true, force: true })
  const gone = `The folder of the profile Work is not there: ${workDirOf(box)}`
  await refused({ profile: 'work' }, gone)
  await refused({ profile: 'work', workspace: { create: 'Fresh' } }, gone)
  assert.equal(
    box.calls().some(a => a[0] === 'tab' || a[0] === 'workspace' || (a[0] === 'agent' && a[1] === 'start')),
    false,
  )
  assert.deepEqual((await board()).launches, [])
}, 30_000)

test('herdr that refuses --env: the launch fails saying so, and no Claude was started', async () => {
  const refusal = { error: "error: unexpected argument '--env' found" }
  const { box, started, launched } = await boardServer(box => ({ ...VIA_HERDR, ...PROFILES(box) }))
  box.state({ ...HERDR, 'tab create': refusal, 'workspace create': refusal })
  for (const workspace of [{ id: 'wA' }, { create: 'Fresh' }]) {
    const l = await launched(
      await started({ name: 'Work job', cwd: box.dir, category: 'acme', workspace, profile: 'work' }),
    )
    assert.equal(l.state, 'failed')
    assert.equal(l.kind, 'launcher')
    assert.equal(
      l.error,
      `herdr cannot set CLAUDE_CONFIG_DIR=${workDirOf(box)} for the new tab (--env needs herdr 0.9.5 or newer): update herdr, or start this session yourself`,
    )
  }
  assert.equal(anyCall(box, 'agent', 'start'), false)
  assert.equal(recordedPanes(box), null)

  // The board's own spawn-agent says so too, before anything runs in the tab.
  const own = await boardServer(PROFILES)
  own.box.state({ ...HERDR, 'tab create': refusal })
  const l = await own.launched(
    await own.started({
      name: 'Work job',
      cwd: own.box.dir,
      category: 'acme',
      workspace: { id: 'wA' },
      profile: 'work',
    }),
  )
  assert.equal(l.state, 'failed')
  assert.equal(l.kind, 'launcher')
  assert.match(l.error, /^herdr cannot set CLAUDE_CONFIG_DIR/)
  assert.equal(anyCall(own.box, 'pane', 'run'), false)
  assert.equal(recordedPanes(own.box), null)
}, 40_000)

test('“New here” from a hidden work card starts in work; another profile than its own is refused', async () => {
  const { box, proc, board, post, started, launched } = await boardServer(box => ({
    ...VIA_HERDR,
    profiles: PROFILES(box).profiles.map(p => (p.id === 'work' ? { ...p, hidden: true } : p)),
  }))
  box.state({ ...HERDR, ...OPENED })
  // s1's hooks reported work.
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(
    join(box.cards, 's1.json'),
    JSON.stringify({ key: 's1', name: 'Work one', profile: 'work', profileDir: workDirOf(box) }),
  )
  const n = proc.messages.length
  proc.send('refresh')
  await until(() => proc.messages.slice(n).some(m => (m as { refreshed?: boolean }).refreshed))
  assert.equal((await board()).items.find(i => i.key === 's1')?.profile, 'work')
  const dir = join(box.dir, 'Here')
  mkdirSync(dir)
  const body = { name: 'Here too', cwd: dir, category: 'acme', workspace: { id: 'wA' }, parent: 's1' }
  const l = await launched(await started(body))
  assert.equal(l.state, 'done', l.error)
  assert.deepEqual([l.profile, l.parent], ['work', 's1'])
  assert.deepEqual(callOf(box, 'tab', 'create').slice(-3), [
    '--env',
    `CLAUDE_CONFIG_DIR=${workDirOf(box)}`,
    '--no-focus',
  ])
  const start = callOf(box, 'agent', 'start')
  assert.deepEqual(start.slice(-5, -1), ['--', '--model', 'sonnet', '--session-id'])
  assert.equal(cardOf(box.cards, start.at(-1)).profileWant, 'work')
  const other = await post('/api/launch', { ...body, profile: 'default' })
  assert.equal(other.status, 400)
  assert.deepEqual(await other.json(), {
    ok: false,
    field: 'profile',
    error: 'A session started from Work one runs in its profile, Work',
  })
}, 30_000)

test('"Close the tab" takes a card with only the board’s and the hooks’ fields along, and keeps one with more', async () => {
  const { box, post, board, started } = await boardServer(VIA_HERDR)
  const dir = join(box.dir, 'unsure')
  mkdirSync(dir)
  box.state({
    ...HERDR,
    'agent start': { code: 'agent_not_ready', error: 'agent_not_ready: blocked' },
    'agent get': blocked,
    'pane read': { text: trustScreen(dir) },
    'pane get': { result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude' } } },
  })
  const cardFile = (sid: string) => join(box.cards, `${sid}.json`)
  const held = async (name: string) => {
    const n = box.calls().filter(a => a[0] === 'agent' && a[1] === 'start').length
    const id = await started({ name, cwd: dir, category: 'acme', workspace: { id: 'wA' } })
    await launchState(board, id, l => l?.state === 'trust', 'never asked to trust')
    const sid =
      box
        .calls()
        .filter(a => a[0] === 'agent' && a[1] === 'start')
        [n]?.at(-1) ?? ''
    return { id, sid }
  }
  const add = (sid: string, fields: Record<string, unknown>) =>
    writeFileSync(cardFile(sid), JSON.stringify({ ...JSON.parse(readFileSync(cardFile(sid), 'utf8')), ...fields }))
  // The hooks ran before the dialog: the card says its profile, still nothing anyone wrote.
  const a = await held('Hooked')
  assert.equal(cardOf(box.cards, a.sid).profileWant, 'default')
  add(a.sid, { profile: 'default', profileDir: join(homeOf(box), '.claude') })
  assert.equal((await post(`/api/launch/${a.id}/close`, {})).status, 200)
  assert.equal(existsSync(cardFile(a.sid)), false)
  // Something written on it: it stays.
  const b = await held('Noted')
  add(b.sid, { profile: 'default', profileDir: join(homeOf(box), '.claude'), doing: 'Reading the code' })
  assert.equal((await post(`/api/launch/${b.id}/close`, {})).status, 200)
  assert.equal(existsSync(cardFile(b.sid)), true)
  noEnv(box)
}, 40_000)
