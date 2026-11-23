// Antigravity (`agy`) sleep, wake and restart on the board's side (#631):
// sleeping agy cards from wake or wake-agy.json, waking in own pane or new tab,
// board sleep / board sleep --self (gated to the board's own wake), full board restart
// lifecycle through the scheduler, SessionStart reporting, and web sheet/menu visibility.
import { expect, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { t, useLanguage } from '../../src/core/lang.ts'
import type { Item } from '../../src/core/types.ts'
import { cardMenu } from '../../web/src/models/menu-model.ts'
import { headButtons } from '../../web/src/models/sheet.ts'
import { serveBoard, unusedPort } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { root, type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { boardOnPath, paneCalls, stateDir, wakeRuns } from '../support/sleeper-fixtures.ts'

setDefaultTimeout(40_000)
// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

const ID = '509dfc37-b58e-4851-9988-a8c7befe9f0d'
const LINE = `board resume --agy ${ID}`
const SLEPT = Date.UTC(2026, 10, 23, 15)
const RULE = '─'.repeat(40)
const AGY_SCREEN = ['● Done.', '', RULE, '> ', RULE, '? for shortcuts   Gemini 4 Neon'].join('\n')

function agySession(box: Sandbox): { cwd: string; agyRoot: string } {
  const cwd = join(box.dir, 'Work', 'Проект x 50%')
  mkdirSync(cwd, { recursive: true })
  const agyRoot = join(box.dir, 'agy-home')
  const logs = join(agyRoot, 'brain', ID, '.system_generated', 'logs')
  mkdirSync(logs, { recursive: true })
  writeFileSync(
    join(logs, 'transcript.jsonl'),
    `${[
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-23T14:50:00Z',
        content: '<USER_REQUEST>\nstatus?\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-23T14:50:05Z',
        content: 'All green.',
        model: 'gemini-4-neon-high',
      }),
    ].join('\n')}\n`,
  )
  return { cwd, agyRoot }
}

function asleepInAgyFile(box: Sandbox, cwd: string): void {
  mkdirSync(stateDir(box), { recursive: true })
  const entry = {
    session: ID,
    name: 'Gemini Dev',
    pane: 'w5:p9',
    workspace: 'w5',
    workspaceLabel: 'Server',
    cwd,
    argv: ['agy', '--dangerously-skip-permissions'],
    slept_at: SLEPT,
  }
  writeFileSync(join(stateDir(box), 'wake-agy.json'), JSON.stringify({ [ID]: entry }))
}

function herdrAgy(box: Sandbox, cwd: string, o: { own: boolean; running?: boolean; wokenByWake?: boolean }): void {
  const shell = { pane_id: 'w5:p9', workspace_id: 'w5', tab_id: 't9', cwd }
  const woken = o.own ? 'w5:p9' : 'w5:p20'
  const agy = (pane: string) => ({
    pane_id: pane,
    workspace_id: 'w5',
    tab_id: pane === 'w5:p9' ? 't9' : 't20',
    cwd,
    agent: 'agy',
    agent_status: 'idle',
    agent_session: { value: ID },
    terminal_title_stripped: 'Gemini Dev',
  })
  const snapshot = (panes: unknown[]) => ({
    result: {
      snapshot: {
        workspaces: [{ workspace_id: 'w5', label: 'Server' }],
        tabs: [{ tab_id: 't9', workspace_id: 'w5' }],
        panes,
      },
    },
  })
  const before = o.running ? [agy('w5:p9')] : o.own ? [shell] : []
  const after = o.own ? [agy('w5:p9')] : [agy('w5:p20')]
  const agent = { result: { agent: { agent: 'agy', agent_status: 'idle', agent_session: { value: ID } } } }
  box.state({
    // biome-ignore lint/suspicious/noThenProperty: fake herdr transition
    'api snapshot': { ...snapshot(before), until: ['pane run'], then: snapshot(after) },
    [`pane get ${woken}`]: {
      result: { pane: o.own ? shell : { pane_id: 'w5:p20', workspace_id: 'w5', cwd } },
      until: ['pane run'],
      // biome-ignore lint/suspicious/noThenProperty: fake herdr transition
      then: { result: { pane: agy(woken) } },
    },
    // biome-ignore lint/suspicious/noThenProperty: fake herdr transition
    'agent get': o.running ? agent : { result: { agent: null }, until: ['pane run'], then: agent },
    ...(o.wokenByWake && { 'agent get w5:p20': agent }),
    'pane process-info': {
      result: { process_info: { shell_pid: 4242, foreground_processes: [{ pid: 4242, name: 'bash' }] } },
    },
    'tab create': { result: { tab: { tab_id: 't20' }, root_pane: { pane_id: 'w5:p20', terminal_id: 'term20' } } },
    'agent read': { text: AGY_SCREEN },
    'pane read': { text: AGY_SCREEN },
    'pane run': { result: {} },
    'pane send-keys': { result: {} },
    'pane rename': { result: {} },
    'agent prompt': { result: {} },
  })
}

type Shown = {
  key: string
  agent?: string
  sleeping?: boolean
  pane?: string | null
  workspace?: string
  category?: string
}

async function board(box: Sandbox, cfg: Record<string, unknown>, agyRoot: string) {
  const categories = [
    { id: 'work', title: 'Work', color: 'blue', paths: [join(box.dir, 'Work')] },
    { id: 'other', title: 'Other', color: 'gray' },
  ]
  const { url, proc } = await serveBoard(
    box,
    { language: 'en', categories, ...cfg },
    { ...boardOnPath(box), ANTIGRAVITY_APP_DATA_DIR: agyRoot, BOARD_TEST_PACE: '0.02' },
  )
  const refreshed = (): number => proc.messages.filter(m => (m as { refreshed?: boolean }).refreshed).length
  const card = async (fits: (i: Shown) => boolean = () => true): Promise<Shown> => {
    for (const deadline = Date.now() + 10_000; ; await Bun.sleep(50)) {
      const before = refreshed()
      proc.send('refresh')
      await until(() => refreshed() > before)
      const b = (await (await fetch(`${url}/api/board`)).json()) as { stale?: boolean; items?: Shown[] }
      const it = b.items?.find(i => i.key === ID)
      if (!b.stale && it && fits(it)) return it
      if (Date.now() > deadline) throw new Error(`the board did not show ${ID} as asked`)
    }
  }
  const post = async (action: string, body: unknown = {}) => {
    const res = await fetch(`${url}/api/session/${encodeURIComponent(ID)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { url, card, post }
}

function writeConfig(box: Sandbox, cfg: Record<string, unknown>): void {
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...cfg }))
}

async function cli(box: Sandbox, args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), ...args], {
    cwd: box.dir,
    env: { ...box.env, ...boardOnPath(box), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: `${stdout}${stderr}`.trim() }
}

for (const [setup, wakeCfg] of [
  ['wake off', async () => ({ wake: false })],
  ['wake on but nothing listening on its port', async () => ({ wake: { enabled: true, port: await unusedPort() } })],
] as const) {
  test(`${setup}: sleeping agy shows in its lane and Wake runs board resume --agy in its pane`, async () => {
    const box = await sandbox()
    const { cwd, agyRoot } = agySession(box)
    asleepInAgyFile(box, cwd)
    herdrAgy(box, cwd, { own: true })
    const cfg = await wakeCfg()
    if (typeof cfg.wake === 'object') wakeRuns(box)
    const { card, post } = await board(box, cfg, agyRoot)
    const shown = await card()
    assert.deepEqual(
      [shown.agent, shown.sleeping, shown.pane, shown.workspace, shown.category],
      ['agy', true, 'w5:p9', 'Server', 'work'],
    )
    const r = await post('wake')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(paneCalls(box), [
      ['pane', 'process-info', '--pane', 'w5:p9'],
      ['pane', 'send-keys', 'w5:p9', 'ctrl+u'],
      ['pane', 'run', 'w5:p9', LINE],
    ])
    await card(i => !i.sleeping && i.pane === 'w5:p9')
  })
}

test('pane gone: sleeping agy card stays and Wake opens a new tab in its workspace and folder', async () => {
  const box = await sandbox()
  const { cwd, agyRoot } = agySession(box)
  asleepInAgyFile(box, cwd)
  herdrAgy(box, cwd, { own: false })
  const { card, post } = await board(box, { wake: false }, agyRoot)
  const shown = await card()
  assert.deepEqual([shown.sleeping, shown.pane ?? null, shown.workspace], [true, null, 'Server'])
  const r = await post('wake')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  expect(box.calls().find(c => c[0] === 'tab' && c[1] === 'create')).toEqual([
    'tab',
    'create',
    '--workspace',
    'w5',
    '--cwd',
    cwd,
    '--label',
    'Gemini Dev',
    '--no-focus',
  ])
  expect(paneCalls(box).filter(c => c[1] === 'run')).toEqual([['pane', 'run', 'w5:p20', LINE]])
})

test('board wake answering: sleeping agy wakes on message, board sleep works, and board restart runs full sleep -> wake -> note', async () => {
  const box = await sandbox()
  const { cwd, agyRoot } = agySession(box)
  herdrAgy(box, cwd, { own: true, running: true })

  let sleptCount = 0
  let wokeCount = 0
  const sleeperRow = {
    name: 'Gemini Dev',
    pane: 'w5:p9',
    session: ID,
    workspace: 'Server',
    slept_at: new Date(SLEPT).toISOString(),
    exited: false,
    agent: 'agy',
    cwd,
  }
  const wake = await fakeWake({
    sleep: () => {
      sleptCount++
      wake.sleeping = [sleeperRow]
      return { ok: true, pane: 'w5:p9', name: 'Gemini Dev' }
    },
    wake: () => {
      wokeCount++
      wake.sleeping = []
      return { ok: true, pane: 'w5:p9', name: 'Gemini Dev' }
    },
  })
  wakeRuns(box)
  const wakeCfg = { wake: { enabled: true, port: wake.port }, scheduleTickSec: 0.2, restartSettleSec: 0 }
  writeConfig(box, wakeCfg)
  const { card, post } = await board(box, wakeCfg, agyRoot)
  await card(i => !i.sleeping && i.agent === 'agy')

  // 1. `board sleep` puts an idle agy session to sleep through the board's wake.
  const slp = await cli(box, ['sleep', 'Gemini Dev'], { ANTIGRAVITY_APP_DATA_DIR: agyRoot })
  expect(slp.code).toBe(0)
  expect(slp.out).toContain('1 put to sleep')
  expect(
    wake
      .requests()
      .some(q => q.method === 'POST' && q.path === '/sleep' && (q.body as { target?: unknown })?.target === ID),
  ).toBe(true)

  // Reset fake wake state to awake for the restart test.
  wake.sleeping = []
  wokeCount = sleptCount
  const rst = await post('restart')
  expect(rst.status).toBe(200)
  expect(rst.body.ok).toBe(true)

  // Wait until the scheduler completes sleep -> wake -> sends restarted note into w5:p9.
  await until(() =>
    box.calls().some(c => c[0] === 'agent' && c[1] === 'prompt' && c[2] === 'w5:p9' && /restarted/i.test(c[3] ?? '')),
  )
  expect(sleptCount).toBe(2)
  expect(wokeCount).toBe(2)

  // 2. `board restart` CLI from inside an agy session works and mentions Antigravity.
  const cliRestart = await cli(box, ['restart', 'check tests'], {
    ANTIGRAVITY_APP_DATA_DIR: agyRoot,
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'w5:p9',
    ANTIGRAVITY_CONVERSATION_ID: ID,
  })
  expect(cliRestart.code).toBe(0)
  expect(cliRestart.out).toContain('Antigravity exits and resumes')
  expect(cliRestart.out).toContain('check tests')
})

test('legacy herdr-wake plugin leaves agy alone for sleep and restart', async () => {
  const box = await sandbox()
  const { cwd, agyRoot } = agySession(box)
  herdrAgy(box, cwd, { own: true, running: true })
  const legacy = await fakeWake({ oldRouter: true })
  writeConfig(box, { wake: false, wakeUrl: legacy.url })
  const { card, post } = await board(box, { wake: false, wakeUrl: legacy.url }, agyRoot)
  await card(i => !i.sleeping && i.agent === 'agy')

  const rst = await post('restart')
  expect(rst.status).toBe(409)
  expect(rst.body.ok).toBe(false)

  const slp = await cli(box, ['sleep', 'Gemini Dev'], { ANTIGRAVITY_APP_DATA_DIR: agyRoot })
  expect(slp.code).toBe(0)
  expect(slp.out).toContain('1 kept up')
})

test('agy-hook SessionStart reports conversation UUID to herdr when agent.session is null', async () => {
  const box = await sandbox()
  box.state({
    'agent get p1': { result: { agent: { agent: 'agy' } } },
    'pane report-agent-session': { text: '{}' },
  })
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/agy-hook.ts')], {
    cwd: root,
    env: { ...box.env, HERDR_ENV: '1', HERDR_PANE_ID: 'p1', ANTIGRAVITY_CONVERSATION_ID: ID },
    stdin: new TextEncoder().encode(
      JSON.stringify({ hookEventName: 'SessionStart', conversationId: ID, cwd: box.dir }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await proc.exited).toBe(0)
  const report = box.calls().find(c => c[0] === 'pane' && c[1] === 'report-agent-session')
  expect(report).toBeDefined()
  expect(report).toContain('--agent')
  expect(report).toContain('agy')
  expect(report).toContain('--agent-session-id')
  expect(report).toContain(ID)
})

test('web sheet and card menu offer Sleep and Restart for awake agy, Wake for sleeping agy, and keep pi/codex unchanged', () => {
  const base = {
    key: ID,
    session: ID,
    pane: 'w5:p9',
    workspace: 'Server',
    name: 'Gemini Dev',
    autoName: 'Gemini Dev',
    category: 'work',
    categorySet: true,
    cwd: '/work',
    status: 'idle' as const,
    sleeping: false,
    focused: false,
    activity: 0,
    column: 'idle' as const,
    auto: 'idle' as const,
    pin: '' as const,
    doing: '',
    doingAt: null,
    wait: '',
    waitSince: null,
    result: '',
    title: '',
    prompt: '',
    lastText: '',
    lastAt: null,
    recap: '',
    recapAt: null,
    tool: null,
    attention: '',
    question: '',
    askSince: null,
    helpers: null,
    transcript: null,
    claudeRoot: null,
  } as unknown as Item

  const agyAwake = headButtons({ ...base, agent: 'agy' }, t)
  expect(agyAwake.sleepHidden).toBe(false)
  expect(agyAwake.restartHidden).toBe(false)
  expect(agyAwake.wakeHidden).toBe(true)

  const agyAsleep = headButtons({ ...base, agent: 'agy', sleeping: true, status: 'sleeping' }, t)
  expect(agyAsleep.wakeHidden).toBe(false)
  expect(agyAsleep.sleepHidden).toBe(true)
  expect(agyAsleep.restartHidden).toBe(true)

  // pi and codex still do not get Restart.
  expect(headButtons({ ...base, agent: 'pi' }, t).restartHidden).toBe(true)
  expect(headButtons({ ...base, agent: 'codex' }, t).restartHidden).toBe(true)

  const menuCtx = {
    t,
    canMutate: true,
    canEdit: true,
    categories: [],
    restarting: false,
  } as unknown as Parameters<typeof cardMenu>[1]
  const agyIds = cardMenu({ ...base, agent: 'agy' }, menuCtx).map(e => ('id' in e ? e.id : ''))
  expect(agyIds).toContain('sleep')
  expect(agyIds).toContain('restart')

  const piIds = cardMenu({ ...base, agent: 'pi' }, menuCtx).map(e => ('id' in e ? e.id : ''))
  expect(piIds).not.toContain('restart')
})
