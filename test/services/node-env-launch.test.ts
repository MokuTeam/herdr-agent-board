// A node's env file in its sessions (#507, docs/design/nodes 10 item 4): `<state>/node/env/<profile>.env`
// on a board with `node`. A start through the launch pipeline (as a start from the master runs, in
// this process against a sandbox's fake herdr, with the board's own spawn-agent as the launcher)
// gets its variables in the new tab's env, never on the line typed into it; `board resume` gives them
// to Claude (the fake on PATH). A name the board sets itself is left out and said by name. A master
// that has the file (a node made the master, #824) applies it the same way; a board without the file,
// master or node, starts and resumes as main does.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fakeClaudeOn } from '../support/fake-claude.ts'
import { root, type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const CANARY = 'Bearer c4n4ry-T11 x'
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const ENV_FILE = [
  `MCP_DOCS_AUTHORIZATION='${CANARY}'`,
  'GIT_TERMINAL_PROMPT=0',
  'PATH=/evil/bin',
  'HERDR_EVIL=1',
  '',
].join('\n')

const kept: Record<string, string | undefined> = {}
afterEach(() => {
  for (const [k, v] of Object.entries(kept)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
    delete kept[k]
  }
})
/** This process takes the sandbox's herdr, folders and pace, as a board started in it would. */
function into(box: Sandbox): void {
  const vars = { ...box.env, BOARD_TEST_PACE: '0.02' }
  for (const [k, v] of Object.entries(vars)) {
    if (k === 'PATH' || k === 'TZ') continue
    if (!(k in kept)) kept[k] = process.env[k]
    process.env[k] = v
  }
}

const HERDR = {
  'api snapshot': {
    result: { snapshot: { panes: [], tabs: [], workspaces: [{ workspace_id: 'wA', label: 'Alpha' }] } },
  },
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9' } } },
  'workspace create': {
    result: { workspace: { workspace_id: 'wA' }, tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9' } },
  },
  'tab rename': { result: null },
  'pane get': { result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude', agent_status: 'idle' } } },
  'pane run': { result: null },
  'agent list': { result: { agents: [] } },
  'agent prompt': { result: null },
  'agent rename': { result: null },
  'pane read': { text: 'Session renamed to: Gamma job' },
}

const NODE = { id: 'server-1', port: 47391, workRoot: '~/work' }
const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')

/** A sandbox with config.json on disk as spawn-agent reads it, and the default profile's env file when asked. */
async function boardBox(o: { node: boolean; envFile: boolean }): Promise<Sandbox> {
  const box = await sandbox()
  box.state(HERDR)
  mkdirSync(join(box.env.HOME as string, '.claude'), { recursive: true })
  mkdirSync(join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board'), { recursive: true })
  // A port nobody listens on: the board command in this sandbox reaches no real board.
  writeFileSync(configPath(box), JSON.stringify({ language: 'en', port: 9, ...(o.node && { node: NODE }) }))
  if (o.envFile) {
    const dir = join(stateFolder(box), 'node', 'env')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'default.env'), ENV_FILE)
  }
  return box
}

/** One start through the launch pipeline: herdr's calls, and what the board logged. */
async function start(
  box: Sandbox,
  node: boolean,
  workspace: { id: string; label: string } | { create: string } = { id: 'wA', label: 'Alpha' },
): Promise<{ calls: string[][]; logged: string[]; dir: string }> {
  into(box)
  const dir = join(box.dir, 'Gamma')
  mkdirSync(dir, { recursive: true })
  const home = box.env.HOME ?? ''
  const { createLaunches } = await import('../../src/services/launch/launches.ts')
  const { normalizeConfig } = await import('../../src/core/categories.ts')
  const { mergeProfiles, profileSet } = await import('../../src/core/profiles.ts')
  const cfg = normalizeConfig({
    categories: [{ id: 'acme', title: 'Acme', color: 'blue', paths: [] }],
    wakeUrl: null,
    ...(node && { node: NODE }),
  })
  const profiles = profileSet(mergeProfiles([], [], home).list, join(home, '.claude'))
  const logged: string[] = []
  const deps = { cfg, profiles: () => profiles, log: (text: string) => logged.push(text) } as unknown as Parameters<
    typeof createLaunches
  >[0]['deps']
  const launches = createLaunches({ deps })
  const r = await launches.start({ name: 'Gamma job', cwd: dir, category: 'acme', workspace, message: 'Go.' }, [])
  expect(r.ok).toBe(true)
  await until(() => ['done', 'failed'].includes(launches.list()[0]?.state ?? ''), 20_000)
  const l = launches.list()[0]
  expect([l?.state, l?.error || '']).toEqual(['done', ''])
  return { calls: box.calls(), logged, dir }
}

const tabCreate = (calls: string[][]): string[] | undefined => calls.find(a => a[0] === 'tab' && a[1] === 'create')

/** `board resume <id>` in the sandbox, with the fake Claude on PATH: what it was started with. */
async function resume(box: Sandbox): Promise<{ log: Record<string, unknown>; stderr: string; code: number | null }> {
  const bin = join(box.dir, 'bin')
  fakeClaudeOn(bin)
  const log = join(box.dir, 'claude.json')
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), 'resume', SID], {
    cwd: box.dir,
    env: {
      ...box.env,
      PATH: `${bin}${delimiter}${box.env.PATH}`,
      CLAUDE_CODE_SESSION_ID: '',
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_SHOW: 'MCP_DOCS_AUTHORIZATION,GIT_TERMINAL_PROMPT,HERDR_EVIL',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  return { log: JSON.parse(readFileSync(log, 'utf8')), stderr, code: proc.exitCode }
}

/** main's tab for this start (test/services/launch-without-nodes.test.ts). */
const mainTab = (dir: string): string[] => [
  'tab',
  'create',
  '--workspace',
  'wA',
  '--cwd',
  dir,
  '--label',
  'Gamma job',
  '--no-focus',
]

test("on a node a start's new tab has the env file's variables, never on the typed line; a name the board owns is left out and said", async () => {
  const box = await boardBox({ node: true, envFile: true })
  const { calls, logged, dir } = await start(box, true)
  const tab = tabCreate(calls) ?? []
  expect(tab).toEqual([
    'tab',
    'create',
    '--workspace',
    'wA',
    '--cwd',
    dir,
    '--label',
    'Gamma job',
    '--env',
    `MCP_DOCS_AUTHORIZATION=${CANARY}`,
    '--env',
    'GIT_TERMINAL_PROMPT=0',
    '--no-focus',
  ])
  // What is typed into the pane holds no value.
  const typed = calls.filter(a => a[0] === 'pane' && a[1] === 'run').map(a => a.join(' '))
  expect(typed.length).toBeGreaterThan(0)
  expect(typed.join('\n')).not.toContain('c4n4ry')
  // The names the board sets itself, by name; no value in the board's log.
  expect(logged).toEqual([
    'node env: PATH in default.env is set by the board itself: left out',
    'node env: HERDR_EVIL in default.env is set by the board itself: left out',
  ])
}, 40_000)

test("on a node board resume gives Claude the env file's variables, the board's own names left out", async () => {
  const box = await boardBox({ node: true, envFile: true })
  const r = await resume(box)
  expect(r.code).toBe(0)
  expect(r.log).toMatchObject({
    args: ['--resume', SID],
    env: { MCP_DOCS_AUTHORIZATION: CANARY, GIT_TERMINAL_PROMPT: '0', HERDR_EVIL: null },
  })
  expect(r.stderr).toContain('board resume: node env: PATH in default.env is set by the board itself: left out')
  expect(r.stderr).toContain('board resume: node env: HERDR_EVIL in default.env is set by the board itself: left out')
  expect(r.stderr).not.toContain('c4n4ry')
}, 40_000)

/** `spawn-agent` run as a command in the sandbox: the new tab's `tab create` and its stderr. */
async function spawnHere(box: Sandbox): Promise<{ tab: string[] | undefined; stderr: string; code: number | null }> {
  const dir = join(box.dir, 'Delta')
  mkdirSync(dir, { recursive: true })
  const proc = Bun.spawn(
    [
      process.execPath,
      join(root, 'src/entrypoints/spawn-agent.ts'),
      '-Name',
      'Delta job',
      '-Cwd',
      dir,
      '-Workspace',
      'wA',
    ],
    { cwd: root, env: { ...box.env, BOARD_TEST_PACE: '0.02' }, stdout: 'pipe', stderr: 'pipe' },
  )
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  return { tab: tabCreate(box.calls()), stderr, code: proc.exitCode }
}

/** A start into a new workspace: the board opens it itself (services/launch/run.ts), the launcher takes its pane. */
async function intoNewWorkspace(
  box: Sandbox,
): Promise<{ create: string[] | undefined; logged: string[]; dir: string }> {
  const first = { result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: null } } }
  box.state({ ...HERDR, 'pane get': { seq: [first, HERDR['pane get']] } })
  const { calls, logged, dir } = await start(box, false, { create: 'Fresh' })
  return { create: calls.find(a => a[0] === 'workspace' && a[1] === 'create'), logged, dir }
}

const envArgs = ['--env', `MCP_DOCS_AUTHORIZATION=${CANARY}`, '--env', 'GIT_TERMINAL_PROMPT=0']

test("a master that keeps a profile's env file (a node made the master, #824): a start, spawn-agent and board resume get its variables, never on the typed line", async () => {
  const box = await boardBox({ node: false, envFile: true })
  const { calls, logged, dir } = await start(box, false)
  const tab = mainTab(dir)
  expect(tabCreate(calls)).toEqual([...tab.slice(0, -1), ...envArgs, '--no-focus'])
  const typed = calls.filter(a => a[0] === 'pane' && a[1] === 'run').map(a => a.join(' '))
  expect(typed.length).toBeGreaterThan(0)
  expect(typed.join('\n')).not.toContain('c4n4ry')
  expect(logged).toEqual([
    'node env: PATH in default.env is set by the board itself: left out',
    'node env: HERDR_EVIL in default.env is set by the board itself: left out',
  ])
  expect(logged.join('\n')).not.toContain('c4n4ry')

  const r = await resume(box)
  expect(r.code).toBe(0)
  expect(r.log).toMatchObject({
    args: ['--resume', SID],
    env: { MCP_DOCS_AUTHORIZATION: CANARY, GIT_TERMINAL_PROMPT: '0', HERDR_EVIL: null },
  })
  expect(r.stderr).not.toContain('c4n4ry')

  const spawned = await boardBox({ node: false, envFile: true })
  const s = await spawnHere(spawned)
  expect(s.code).toBe(0)
  expect(s.tab).toEqual([
    'tab',
    'create',
    '--workspace',
    'wA',
    '--cwd',
    join(spawned.dir, 'Delta'),
    '--label',
    'Delta job',
    ...envArgs,
    '--no-focus',
  ])
  expect(s.stderr).not.toContain('c4n4ry')

  const fresh = await intoNewWorkspace(await boardBox({ node: false, envFile: true }))
  expect(fresh.create).toEqual([
    'workspace',
    'create',
    '--cwd',
    fresh.dir,
    '--label',
    'Fresh',
    ...envArgs,
    '--no-focus',
  ])
  expect(fresh.logged.join('\n')).not.toContain('c4n4ry')
}, 60_000)

test("without the env file, on a master or a node: a start's tab, spawn-agent's tab and a resume's env and arguments are main's", async () => {
  // A node without the file.
  const bare = await boardBox({ node: true, envFile: false })
  const noFile = await start(bare, true)
  expect(tabCreate(noFile.calls)).toEqual(mainTab(noFile.dir))
  expect(noFile.logged).toEqual([])

  // A master without the file.
  const box = await boardBox({ node: false, envFile: false })
  const { calls, logged, dir } = await start(box, false)
  expect(tabCreate(calls)).toEqual(mainTab(dir))
  expect(logged).toEqual([])
  const r = await resume(box)
  expect([r.code, r.log]).toEqual([
    0,
    {
      args: ['--resume', SID],
      configDir: null,
      cwd: expect.any(String),
      env: { MCP_DOCS_AUTHORIZATION: null, GIT_TERMINAL_PROMPT: null, HERDR_EVIL: null },
    },
  ])
  expect(r.stderr).toBe('')

  const spawned = await boardBox({ node: false, envFile: false })
  const s = await spawnHere(spawned)
  expect(s.code).toBe(0)
  expect(s.tab).toEqual([
    'tab',
    'create',
    '--workspace',
    'wA',
    '--cwd',
    join(spawned.dir, 'Delta'),
    '--label',
    'Delta job',
    '--no-focus',
  ])

  const fresh = await intoNewWorkspace(await boardBox({ node: false, envFile: false }))
  expect(fresh.create).toEqual(['workspace', 'create', '--cwd', fresh.dir, '--label', 'Fresh', '--no-focus'])
  expect(fresh.logged).toEqual([])
}, 60_000)

test("the env a tab, a workspace or launch.command gets: the env file's variables beside CLAUDE_CONFIG_DIR, none without them", async () => {
  const { openInProfile } = await import('../../src/services/launch/launcher.ts')
  const seen = (l: Parameters<typeof openInProfile>[0]) => openInProfile(l, async env => env)
  // main's: the inherited env, or CLAUDE_CONFIG_DIR alone.
  expect(await seen({ configDir: null })).toBeUndefined()
  expect(await seen({ configDir: '/home/me/.claude-work' })).toEqual({ CLAUDE_CONFIG_DIR: '/home/me/.claude-work' })
  expect(await seen({ configDir: null, nodeEnv: null })).toBeUndefined()
  expect(await seen({ configDir: null, nodeEnv: {} })).toBeUndefined()
  // On a node.
  expect(await seen({ configDir: null, nodeEnv: { A: '1' } })).toEqual({ A: '1' })
  expect(await seen({ configDir: '/home/me/.claude-work', nodeEnv: { A: '1' } })).toEqual({
    A: '1',
    CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
  })
})

test("herdr's words that quote a variable lose its value; without variables an error is as it was", async () => {
  const { openInProfile, withoutValues } = await import('../../src/services/launch/launcher.ts')
  // An open (a tab, a workspace) that fails with an argument in herdr's words.
  const failed = await openInProfile({ configDir: null, nodeEnv: { MCP_X: CANARY } }, async () => {
    throw new Error(`herdr tab create: invalid value 'MCP_X=${CANARY}' for --env`)
  }).catch((err: Error) => err.message)
  expect(failed).toContain('herdr tab create: invalid value')
  expect(failed).not.toContain('c4n4ry')
  const plain = new Error('herdr tab create: no such workspace')
  expect(withoutValues(plain, null)).toBe(plain)
  expect(withoutValues(plain, {})).toBe(plain)
  expect(plain.message).toBe('herdr tab create: no such workspace')
})
