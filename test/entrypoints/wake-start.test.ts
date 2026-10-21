// `bun src/entrypoints/wake-start.ts [--again]`, wake's startup entry, against a sandbox's fake
// herdr with a short deadline: the kill switch read first (off: no herdr call), held while the old
// herdr-wake plugin is installed, nothing opened while a wake answers or its pane runs, a pane
// herdr restored as a bare shell replaced, and always 0 within its deadline.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { unusedPort } from '../support/board-server.ts'
import { root, type Sandbox } from '../support/sandbox.ts'
import { endWithSandbox, wakeOnConfig, wakeSandbox, writeBoardConfig } from '../support/wake-process.ts'

setDefaultTimeout(30_000)

const START_ENTRY = join(root, 'src', 'entrypoints', 'wake-start.ts')
const ROOT = resolve(root)
/** A folder of the user's, with spaces, Cyrillic and %. */
const OTHER_DIR = process.platform === 'win32' ? 'C:\\Work\\Проект x 50%' : '/work/Проект x 50%'
const DEADLINE_MS = 8000

const stateOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
const statusFile = (box: Sandbox): string => join(stateOf(box), 'wake-status.json')
const lockFile = (box: Sandbox): string => join(stateOf(box), 'wake-start.lock')
function statusOf(box: Sandbox): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(statusFile(box), 'utf8'))
  } catch {
    return null
  }
}
function writeStatus(box: Sandbox, status: Record<string, unknown>): void {
  mkdirSync(dirname(statusFile(box)), { recursive: true })
  writeFileSync(statusFile(box), JSON.stringify(status))
}
const wakeLogText = (box: Sandbox): string => {
  try {
    return readFileSync(join(stateOf(box), 'wake.log'), 'utf8')
  } catch {
    return ''
  }
}

/** wake-start.ts run to its end: its exit code and how long it took. */
async function runStart(
  box: Sandbox,
  args: string[] = [],
  deadlineMs = DEADLINE_MS,
): Promise<{ code: number | null; ms: number; stdout: string }> {
  const started = Date.now()
  const proc = Bun.spawn([process.execPath, START_ENTRY, ...args], {
    cwd: root,
    env: { ...box.env, BOARD_WAKE_START_DEADLINE_MS: String(deadlineMs) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  endWithSandbox(proc)
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, ms: Date.now() - started, stdout }
}

/** A pid no process has: that of a Bun that ran and ended. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' })
  await proc.exited
  return proc.pid
}

/** The board's config with wake on at an unused port; the port. */
async function wakeOn(box: Sandbox): Promise<number> {
  const port = await unusedPort()
  writeBoardConfig(box, wakeOnConfig(port))
  return port
}

const sidebar = { 'herdr-sidebar-git': '1' }
const noOldPlugin = { 'plugin list': { result: { type: 'plugin_list', plugins: [{ plugin_id: 'agent-board' }] } } }
const opensIn = (pane: string) => ({ 'plugin pane open': { result: { plugin_pane: { pane: { pane_id: pane } } } } })
const openCall = (workspace: string): string[] => [
  'plugin',
  'pane',
  'open',
  '--plugin',
  'agent-board',
  '--entrypoint',
  'wake',
  '--placement',
  'tab',
  '--workspace',
  workspace,
  '--cwd',
  ROOT,
  '--no-focus',
]

const main = {
  workspace: { workspace_id: 'w1', label: 'Main' },
  tab: { tab_id: 't1', workspace_id: 'w1' },
  agent: {
    pane_id: 'w1:p1',
    tab_id: 't1',
    workspace_id: 'w1',
    agent: 'claude',
    agent_status: 'idle',
    agent_session: { value: 'x' },
  },
}

test('wake off, by "wake": false or a config.json that does not parse: exits 0 and asks herdr nothing', async () => {
  for (const config of [
    { ...wakeOnConfig(0), wake: false },
    wakeOnConfig(0, { wake: { enabled: false } }),
    '{ "wake": { "enabled": tr',
  ]) {
    const box = await wakeSandbox()
    box.state(noOldPlugin)
    writeBoardConfig(box, config)
    const out = await runStart(box)
    expect(out.code).toBe(0)
    expect(box.calls()).toEqual([])
    expect(existsSync(statusFile(box))).toBe(false)
    expect(existsSync(lockFile(box))).toBe(false)
    expect(wakeLogText(box)).toBe('')
  }
})

const noWakeYet = {
  ...noOldPlugin,
  'api snapshot': { result: { snapshot: { workspaces: [main.workspace], tabs: [main.tab], panes: [main.agent] } } },
  'workspace create': { result: { workspace: { workspace_id: 'wN', label: 'Wake' }, tab: { tab_id: 'first-tab' } } },
  'tab close': { result: {} },
  ...opensIn('wN:p2'),
}

test('two starts at once (herdr’s startup entry and the board’s): one Wake workspace, one wake pane; the other start leaves it the work', async () => {
  const box = await wakeSandbox()
  await wakeOn(box)
  const gate = join(box.dir, 'gate')
  // herdr answers its first question only once the test opens the gate: both starts are under way together.
  box.state({ ...noWakeYet, 'plugin list': { ...noOldPlugin['plugin list'], waitFor: gate } })
  const runs = [runStart(box), runStart(box)]
  // One of them finds the other's lock and ends at once (without a lock both would wait: the gate opens after 2 s).
  await Promise.race([...runs, Bun.sleep(2000)])
  writeFileSync(gate, '')
  const outs = await Promise.all(runs)
  expect(outs.map(o => o.code)).toEqual([0, 0])
  expect(outs.map(o => o.stdout.trim()).sort()).toEqual(["wake's start: opened", "wake's start: present"])
  expect(box.calls()).toEqual([
    ['plugin', 'list', '--json'],
    ['api', 'snapshot'],
    ['workspace', 'create', '--label', 'Wake', '--cwd', ROOT, '--no-focus'],
    openCall('wN'),
    ['tab', 'close', 'first-tab'],
  ])
  expect(wakeLogText(box)).toContain('another start is under way')
  // Given back as the start ended.
  expect(existsSync(lockFile(box))).toBe(false)
})

test('a start’s lock left behind (its process gone, or older than the deadline) is taken over; a live one is left alone', async () => {
  const at = Date.now()
  for (const lock of [
    { pid: await deadPid(), at },
    // Its process runs (a pid given out again), but no start takes that long.
    { pid: process.pid, at: at - DEADLINE_MS - 1000 },
  ]) {
    const box = await wakeSandbox()
    await wakeOn(box)
    mkdirSync(stateOf(box), { recursive: true })
    writeFileSync(lockFile(box), JSON.stringify(lock))
    box.state(noWakeYet)
    const out = await runStart(box)
    expect([out.code, out.stdout.trim()]).toEqual([0, "wake's start: opened"])
    expect(box.calls().filter(c => c[1] === 'pane')).toEqual([openCall('wN')])
    expect(existsSync(lockFile(box))).toBe(false)
  }

  // A start under way (this test's process, a moment ago): nothing asked of herdr, its lock kept.
  const box = await wakeSandbox()
  await wakeOn(box)
  mkdirSync(stateOf(box), { recursive: true })
  const live = JSON.stringify({ pid: process.pid, at: Date.now() })
  writeFileSync(lockFile(box), live)
  box.state(noWakeYet)
  const out = await runStart(box)
  expect([out.code, out.stdout.trim()]).toEqual([0, "wake's start: present"])
  expect(box.calls()).toEqual([])
  expect(readFileSync(lockFile(box), 'utf8')).toBe(live)
})

test('the old plugin installed: one herdr plugin list, status held, nothing opened', async () => {
  const box = await wakeSandbox()
  await wakeOn(box)
  writeStatus(box, { state: 'running', at: Date.now(), pane: 'wW:p1', pid: 4242, port: 40000 })
  box.state({ 'plugin list': { result: { plugins: [{ plugin_id: 'agent-board' }, { plugin_id: 'herdr-wake' }] } } })
  const out = await runStart(box)
  expect(out.code).toBe(0)
  expect(box.calls()).toEqual([['plugin', 'list', '--json']])
  // The pane and the supervisor it had are kept: nothing of them was closed.
  expect(statusOf(box)).toEqual({ state: 'held', at: expect.any(Number), pane: 'wW:p1', pid: 4242 })
})

test('a wake answering already: nothing opened; a held status the old plugin left is rewritten stopped', async () => {
  const box = await wakeSandbox()
  const port = await wakeOn(box)
  writeStatus(box, { state: 'held', at: Date.now(), pane: 'wW:p1', pid: 4242 })
  box.state(noOldPlugin)
  const wake = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: () => Response.json({ pid: 4242, started: 'x', sessions: {} }),
  })
  try {
    const out = await runStart(box)
    expect(out.code).toBe(0)
  } finally {
    await wake.stop(true)
  }
  expect(box.calls()).toEqual([['plugin', 'list', '--json']])
  expect(statusOf(box)).toEqual({ state: 'stopped', at: expect.any(Number), pane: 'wW:p1', pid: 4242 })
})

test('its pane is there with its supervisor running: nothing opened, nothing closed', async () => {
  const box = await wakeSandbox()
  await wakeOn(box)
  const status = { state: 'starting', at: Date.now(), pane: 'wW:p1', pid: process.pid }
  writeStatus(box, status)
  box.state({
    ...noOldPlugin,
    'api snapshot': {
      result: {
        snapshot: {
          workspaces: [{ workspace_id: 'wW', label: 'Wake' }],
          tabs: [{ tab_id: 'wake-tab', workspace_id: 'wW' }],
          panes: [{ pane_id: 'wW:p1', tab_id: 'wake-tab', workspace_id: 'wW' }],
        },
      },
    },
  })
  const out = await runStart(box)
  expect(out.code).toBe(0)
  expect(box.calls()).toEqual([
    ['plugin', 'list', '--json'],
    ['api', 'snapshot'],
  ])
  expect(statusOf(box)).toEqual(status)
})

// After a restart herdr brings wake's tab back under the same pane id, a shell in it in place of
// the supervisor, while the status file still names that pane and the supervisor's process.
const restored = {
  workspaces: [{ workspace_id: 'wW', label: 'Wake' }, main.workspace],
  tabs: [{ tab_id: 'wake-tab', workspace_id: 'wW' }, main.tab],
  panes: [
    { pane_id: 'wW:p1', tab_id: 'wake-tab', workspace_id: 'wW', terminal_title_stripped: 'pwsh' },
    { pane_id: 'wW:p2', tab_id: 'wake-tab', workspace_id: 'wW', tokens: sidebar },
    main.agent,
  ],
}
const wakeTabClosed = { ...restored, tabs: [main.tab], panes: [main.agent] }

test('a restored bare-shell wake pane is replaced: its tab closed, a new wake pane opened in Wake', async () => {
  const box = await wakeSandbox()
  await wakeOn(box)
  writeStatus(box, { state: 'running', at: 1, pane: 'wW:p1', pid: await deadPid(), port: 40000 })
  box.state({
    ...noOldPlugin,
    'api snapshot': {
      result: { snapshot: restored },
      until: ['tab close'],
      // biome-ignore lint/suspicious/noThenProperty: the fake herdr's reply after the close (test/support/fake-herdr.ts)
      then: { result: { snapshot: wakeTabClosed } },
    },
    'tab close': { result: {} },
    ...opensIn('wW:p9'),
  })
  const out = await runStart(box)
  expect(out.code).toBe(0)
  expect(box.calls()).toEqual([
    ['plugin', 'list', '--json'],
    ['api', 'snapshot'],
    ['tab', 'close', 'wake-tab'],
    ['api', 'snapshot'],
    openCall('wW'),
  ])
  expect(statusOf(box)).toEqual({ state: 'starting', at: expect.any(Number), pane: 'wW:p9' })
})

test('a stale wake pane in Wake beside a pane of the user’s: only that pane is closed, never their tab', async () => {
  for (const user of [
    { pane_id: 'wW:p5', tab_id: 'wake-tab', workspace_id: 'wW', agent: 'claude', agent_status: 'idle' },
    // An editor: no agent, in a folder of the user's.
    { pane_id: 'wW:p5', tab_id: 'wake-tab', workspace_id: 'wW', cwd: OTHER_DIR, terminal_title_stripped: 'vim' },
  ]) {
    const box = await wakeSandbox()
    await wakeOn(box)
    writeStatus(box, { state: 'running', at: Date.now(), pane: 'wW:p1', pid: await deadPid() })
    const shared = {
      workspaces: [{ workspace_id: 'wW', label: 'Wake' }, main.workspace],
      tabs: [{ tab_id: 'wake-tab', workspace_id: 'wW' }, main.tab],
      panes: [
        { pane_id: 'wW:p1', tab_id: 'wake-tab', workspace_id: 'wW', cwd: ROOT },
        { pane_id: 'wW:p2', tab_id: 'wake-tab', workspace_id: 'wW', tokens: sidebar },
        user,
        main.agent,
      ],
    }
    box.state({
      ...noOldPlugin,
      'api snapshot': { result: { snapshot: shared } },
      'pane close': { result: {} },
      'tab close': { result: {} },
      ...opensIn('wW:p9'),
    })
    const out = await runStart(box)
    expect(out.code).toBe(0)
    expect(box.calls()).toEqual([
      ['plugin', 'list', '--json'],
      ['api', 'snapshot'],
      ['pane', 'close', 'wW:p1'],
      ['api', 'snapshot'],
      openCall('wW'),
    ])
  }
})

// herdr gives a pane's id out again after it starts over: the id wake's status names may be a
// pane of the user's now, outside Wake or with an agent in it. Such a record is left alone.
test('the recorded pane is a Claude session alone in a tab of Main now: nothing closed, a new wake pane opened in Wake', async () => {
  const box = await wakeSandbox()
  await wakeOn(box)
  writeStatus(box, { state: 'stopped', at: Date.now(), pane: 'w1:p1', pid: await deadPid() })
  box.state({
    ...noOldPlugin,
    'api snapshot': {
      result: {
        snapshot: {
          workspaces: [{ workspace_id: 'wW', label: 'Wake' }, main.workspace],
          tabs: [main.tab],
          panes: [main.agent],
        },
      },
    },
    'pane close': { result: {} },
    'tab close': { result: {} },
    ...opensIn('wW:p9'),
  })
  const out = await runStart(box)
  expect(out.code).toBe(0)
  expect(box.calls()).toEqual([['plugin', 'list', '--json'], ['api', 'snapshot'], openCall('wW')])
  expect(statusOf(box)).toEqual({ state: 'starting', at: expect.any(Number), pane: 'wW:p9' })
})

test('the recorded pane is a shell beside an editor in Main now: nothing closed, a new wake pane opened in Wake', async () => {
  const box = await wakeSandbox()
  await wakeOn(box)
  writeStatus(box, { state: 'running', at: Date.now(), pane: 'w1:p7', pid: await deadPid() })
  box.state({
    ...noOldPlugin,
    'api snapshot': {
      result: {
        snapshot: {
          workspaces: [main.workspace],
          tabs: [main.tab],
          panes: [
            { pane_id: 'w1:p7', tab_id: 't1', workspace_id: 'w1', cwd: ROOT, terminal_title_stripped: 'pwsh' },
            { pane_id: 'w1:p8', tab_id: 't1', workspace_id: 'w1', cwd: OTHER_DIR, terminal_title_stripped: 'vim' },
          ],
        },
      },
    },
    'workspace create': { result: { workspace: { workspace_id: 'wN', label: 'Wake' }, tab: { tab_id: 'first-tab' } } },
    'pane close': { result: {} },
    'tab close': { result: {} },
    ...opensIn('wN:p2'),
  })
  const out = await runStart(box)
  expect(out.code).toBe(0)
  expect(box.calls()).toEqual([
    ['plugin', 'list', '--json'],
    ['api', 'snapshot'],
    ['workspace', 'create', '--label', 'Wake', '--cwd', ROOT, '--no-focus'],
    openCall('wN'),
    ['tab', 'close', 'first-tab'],
  ])
  expect(statusOf(box)).toEqual({ state: 'starting', at: expect.any(Number), pane: 'wN:p2' })
})

test('a record from before this boot is stale though its pid runs now (a pid given out again): the restored pane replaced', async () => {
  const box = await wakeSandbox()
  await wakeOn(box)
  // Written before this computer started; the pid is a process of this boot's (the test's own).
  writeStatus(box, { state: 'running', at: 1, pane: 'wW:p1', pid: process.pid, port: 40000 })
  box.state({
    ...noOldPlugin,
    'api snapshot': {
      result: { snapshot: restored },
      until: ['tab close'],
      // biome-ignore lint/suspicious/noThenProperty: the fake herdr's reply after the close (test/support/fake-herdr.ts)
      then: { result: { snapshot: wakeTabClosed } },
    },
    'tab close': { result: {} },
    ...opensIn('wW:p9'),
  })
  const out = await runStart(box)
  expect(out.code).toBe(0)
  expect(box.calls()).toEqual([
    ['plugin', 'list', '--json'],
    ['api', 'snapshot'],
    ['tab', 'close', 'wake-tab'],
    ['api', 'snapshot'],
    openCall('wW'),
  ])
  expect(statusOf(box)).toEqual({ state: 'starting', at: expect.any(Number), pane: 'wW:p9' })
})

test('tabs in Wake with only wake’s leftovers (shells in the plugin’s folder, sidebar panes) are closed; an agent’s, an editor’s or a server’s never', async () => {
  const box = await wakeSandbox()
  await wakeOn(box)
  box.state({
    ...noOldPlugin,
    'api snapshot': {
      result: {
        snapshot: {
          workspaces: [{ workspace_id: 'wW', label: 'Wake' }, main.workspace],
          tabs: [
            { tab_id: 'shell-tab', workspace_id: 'wW' },
            { tab_id: 'sidebar-tab', workspace_id: 'wW' },
            { tab_id: 'agent-tab', workspace_id: 'wW' },
            { tab_id: 'editor-tab', workspace_id: 'wW' },
            { tab_id: 'server-tab', workspace_id: 'wW' },
            { tab_id: 'empty-tab', workspace_id: 'wW' },
            main.tab,
          ],
          panes: [
            { pane_id: 'wW:p1', tab_id: 'shell-tab', workspace_id: 'wW', cwd: ROOT, terminal_title_stripped: 'bash' },
            { pane_id: 'wW:p2', tab_id: 'shell-tab', workspace_id: 'wW', tokens: sidebar },
            { pane_id: 'wW:p3', tab_id: 'sidebar-tab', workspace_id: 'wW', tokens: sidebar },
            { pane_id: 'wW:p4', tab_id: 'agent-tab', workspace_id: 'wW', cwd: ROOT },
            { pane_id: 'wW:p5', tab_id: 'agent-tab', workspace_id: 'wW', agent: 'pi', agent_status: 'idle' },
            {
              pane_id: 'wW:p6',
              tab_id: 'editor-tab',
              workspace_id: 'wW',
              cwd: OTHER_DIR,
              terminal_title_stripped: 'vim',
            },
            { pane_id: 'wW:p7', tab_id: 'editor-tab', workspace_id: 'wW', tokens: sidebar },
            // No folder herdr knows: not known to be wake's.
            { pane_id: 'wW:p8', tab_id: 'server-tab', workspace_id: 'wW', terminal_title_stripped: 'node' },
            // A shell in the user's own workspace is not wake's to close.
            { pane_id: 'w1:p2', tab_id: 't1', workspace_id: 'w1', cwd: ROOT },
          ],
        },
      },
    },
    'tab close': { result: {} },
    ...opensIn('wW:p9'),
  })
  const out = await runStart(box)
  expect(out.code).toBe(0)
  expect(box.calls()).toEqual([
    ['plugin', 'list', '--json'],
    ['api', 'snapshot'],
    openCall('wW'),
    ['tab', 'close', 'shell-tab'],
    ['tab', 'close', 'sidebar-tab'],
  ])
})

/** The board's own workspace: the board's plugin pane (no agent, the plugin's folder) with herdr-sidebar's, and a tab of sidebar panes only. */
const boardWorkspace = (label: string) => ({
  workspaces: [{ workspace_id: 'wB', label }, main.workspace],
  tabs: [{ tab_id: 'board-tab', workspace_id: 'wB' }, { tab_id: 'spare-tab', workspace_id: 'wB' }, main.tab],
  panes: [
    { pane_id: 'wB:p1', tab_id: 'board-tab', workspace_id: 'wB', cwd: ROOT, terminal_title_stripped: 'bun' },
    { pane_id: 'wB:p2', tab_id: 'board-tab', workspace_id: 'wB', tokens: sidebar },
    { pane_id: 'wB:p3', tab_id: 'spare-tab', workspace_id: 'wB', tokens: sidebar },
    main.agent,
  ],
})

test('wake.workspace set to the board’s own workspace (Board, or the label config.json gives it): no tab there is closed', async () => {
  for (const { config, label } of [
    { config: {}, label: 'Board' },
    { config: { workspace: 'Agents' }, label: 'Agents' },
  ]) {
    const box = await wakeSandbox()
    writeBoardConfig(box, wakeOnConfig(await unusedPort(), { config, wake: { workspace: label } }))
    box.state({
      ...noOldPlugin,
      'api snapshot': { result: { snapshot: boardWorkspace(label) } },
      'tab close': { result: {} },
      ...opensIn('wB:p9'),
    })
    const out = await runStart(box)
    expect(out.code).toBe(0)
    expect(box.calls()).toEqual([['plugin', 'list', '--json'], ['api', 'snapshot'], openCall('wB')])
  }
})

test('the board’s pane (board.json) in wake’s workspace: no tab there is closed', async () => {
  const box = await wakeSandbox()
  writeBoardConfig(box, wakeOnConfig(await unusedPort(), { wake: { workspace: 'Tools' } }))
  mkdirSync(stateOf(box), { recursive: true })
  writeFileSync(join(stateOf(box), 'board.json'), JSON.stringify({ pane: 'wB:p1', pid: process.pid }))
  box.state({
    ...noOldPlugin,
    'api snapshot': { result: { snapshot: boardWorkspace('Tools') } },
    'tab close': { result: {} },
    ...opensIn('wB:p9'),
  })
  const out = await runStart(box)
  expect(out.code).toBe(0)
  expect(box.calls()).toEqual([['plugin', 'list', '--json'], ['api', 'snapshot'], openCall('wB')])
})

test('the recorded pane is the board’s (board.json): it is left alone, whatever wake’s record says', async () => {
  const box = await wakeSandbox()
  writeBoardConfig(box, wakeOnConfig(await unusedPort(), { wake: { workspace: 'Board' } }))
  mkdirSync(stateOf(box), { recursive: true })
  writeFileSync(join(stateOf(box), 'board.json'), JSON.stringify({ pane: 'wB:p1', pid: process.pid }))
  writeStatus(box, { state: 'running', at: Date.now(), pane: 'wB:p1', pid: await deadPid() })
  box.state({
    ...noOldPlugin,
    'api snapshot': { result: { snapshot: boardWorkspace('Board') } },
    'pane close': { result: {} },
    'tab close': { result: {} },
    ...opensIn('wB:p9'),
  })
  const out = await runStart(box)
  expect(out.code).toBe(0)
  expect(box.calls()).toEqual([['plugin', 'list', '--json'], ['api', 'snapshot'], openCall('wB')])
})

test('no Wake workspace: one is made, the pane opened there, its first tab closed', async () => {
  const box = await wakeSandbox()
  await wakeOn(box)
  box.state({
    ...noOldPlugin,
    'api snapshot': { result: { snapshot: { workspaces: [main.workspace], tabs: [main.tab], panes: [main.agent] } } },
    'workspace create': { result: { workspace: { workspace_id: 'wN', label: 'Wake' }, tab: { tab_id: 'first-tab' } } },
    'tab close': { result: {} },
    ...opensIn('wN:p2'),
  })
  const out = await runStart(box)
  expect(out.code).toBe(0)
  expect(box.calls()).toEqual([
    ['plugin', 'list', '--json'],
    ['api', 'snapshot'],
    ['workspace', 'create', '--label', 'Wake', '--cwd', ROOT, '--no-focus'],
    openCall('wN'),
    ['tab', 'close', 'first-tab'],
  ])
  expect(statusOf(box)).toEqual({ state: 'starting', at: expect.any(Number), pane: 'wN:p2' })
})

test('--again (Start again): its pane is closed and a new one opened, even while a wake answers', async () => {
  const box = await wakeSandbox()
  const port = await wakeOn(box)
  writeStatus(box, { state: 'crashed', at: 1, pane: 'wW:p1', pid: process.pid, error: 'boom' })
  box.state({
    ...noOldPlugin,
    'api snapshot': {
      result: { snapshot: restored },
      until: ['tab close'],
      // biome-ignore lint/suspicious/noThenProperty: the fake herdr's reply after the close (test/support/fake-herdr.ts)
      then: { result: { snapshot: wakeTabClosed } },
    },
    'tab close': { result: {} },
    ...opensIn('wW:p9'),
  })
  const wake = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => Response.json({ pid: 1, sessions: {} }) })
  try {
    expect((await runStart(box, ['--again'])).code).toBe(0)
  } finally {
    await wake.stop(true)
  }
  expect(box.calls()).toEqual([
    ['plugin', 'list', '--json'],
    ['api', 'snapshot'],
    ['tab', 'close', 'wake-tab'],
    ['api', 'snapshot'],
    openCall('wW'),
  ])
})

test('herdr does not answer: snapshot tried four times, exits 0 within the deadline, the error in wake.log and the status file', async () => {
  const box = await wakeSandbox()
  await wakeOn(box)
  writeStatus(box, { state: 'running', at: Date.now(), pane: 'wW:p1', pid: 4242 })
  box.state({ ...noOldPlugin, 'api snapshot': { error: 'herdr is not ready', code: 'not_ready' } })
  const out = await runStart(box)
  expect(out.code).toBe(0)
  expect(out.ms).toBeLessThan(DEADLINE_MS)
  expect(box.calls()).toEqual([
    ['plugin', 'list', '--json'],
    ['api', 'snapshot'],
    ['api', 'snapshot'],
    ['api', 'snapshot'],
    ['api', 'snapshot'],
  ])
  expect(wakeLogText(box)).toContain('herdr is not ready')
  const status = statusOf(box)
  expect(status).toMatchObject({ state: 'failed', pane: 'wW:p1', pid: 4242 })
  expect(String(status?.error)).toContain('herdr is not ready')
  expect(String(status?.error)).not.toContain('\n')
})

test('herdr hangs: exits 0 at the deadline', async () => {
  const box = await wakeSandbox()
  await wakeOn(box)
  box.state({ 'plugin list': { waitFor: join(box.dir, 'never') } })
  const out = await runStart(box, [], 1500)
  expect(out.code).toBe(0)
  // The fake herdr gives up after 5 s: the deadline ended it well before.
  expect(out.ms).toBeLessThan(4000)
  expect(statusOf(box)).toMatchObject({ state: 'failed', error: expect.stringContaining('1.5 s') })
  // Its lock given back at the deadline too: the next start is not held up.
  expect(existsSync(lockFile(box))).toBe(false)
})
