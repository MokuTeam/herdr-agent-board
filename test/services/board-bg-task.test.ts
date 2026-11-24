import { Database } from 'bun:sqlite'
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgyHome } from '../../src/adapters/agy-home.ts'
import type { Item } from '../../src/core/types.ts'
import { putAgyToSleep } from '../../src/services/wake/agy.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'
import { fakeWakeHerdr } from '../support/fake-wake-herdr.ts'

const S_AGY_FRESH = '11111111-1111-4111-8111-111111111111'
const S_AGY_STUCK = '22222222-2222-4222-8222-222222222222'
const S_AGY_DB_DONE = '33333333-3333-4333-8333-333333333333'
const S_AGY_FOOTER = '44444444-4444-4444-8444-444444444444'
const S_AGY_SLEEP = '55555555-5555-4555-8555-555555555555'
const S_CLAUDE = '66666666-6666-4666-8666-666666666666'
const S_CODEX = '77777777-7777-4777-8777-777777777777'

const RULE = '─'.repeat(50)
const SCREEN_WITH_TASK = ['● Waiting on task', '', RULE, '> ', RULE, '1 task(s) · esc to cancel'].join('\n')
const SCREEN_IDLE = ['● Done', '', RULE, '> ', RULE, '? for shortcuts'].join('\n')

function writeAgyTranscript(root: string, id: string, lines: Record<string, unknown>[]): void {
  const dir = join(root, 'brain', id, '.system_generated', 'logs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'transcript.jsonl'), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
}

function writeConvStepsDb(root: string, id: string, rows: { idx: number; status: number }[]): void {
  const dir = join(root, 'conversations')
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, `${id}.db`))
  try {
    db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, status integer NOT NULL DEFAULT 0)')
    const ins = db.query('INSERT INTO steps (idx, status) VALUES (?, ?)')
    for (const r of rows) ins.run(r.idx, r.status)
  } finally {
    db.close(false)
  }
}

describe('board background task detection and stuck threshold (#676)', () => {
  const sandbox = sharedSandbox()
  let url = ''
  let box: Awaited<ReturnType<typeof sandbox>>
  let agyRoot = ''
  let piSession = ''
  const now = Date.now()
  const ts12m = new Date(now - 12 * 60_000).toISOString()
  const ts45m = new Date(now - 45 * 60_000).toISOString()

  const board = async (): Promise<Item[]> =>
    ((await (await fetch(`${url}/api/board`)).json()) as { items: Item[] }).items
  const postSettings = (body: unknown) =>
    fetch(`${url}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Board': '1', Origin: url },
      body: JSON.stringify(body),
    })

  beforeAll(async () => {
    box = await sandbox()
    agyRoot = join(box.dir, 'agy-home')
    const cwd = join(box.dir, 'atlas work')
    const winCwd = 'C:\\Users\\anna\\work repo 50%'
    mkdirSync(cwd, { recursive: true })
    piSession = join(box.dir, 'pi-sessions', '2026-11-24_atlas 50%.jsonl')
    mkdirSync(join(box.dir, 'pi-sessions'), { recursive: true })
    writeFileSync(piSession, `${JSON.stringify({ type: 'session', cwd })}\n`)

    // 1) Active agy task running 12 min (not stuck under default 30 min) even though planner ended turn.
    writeAgyTranscript(agyRoot, S_AGY_FRESH, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: ts12m,
        content: '<USER_REQUEST>\nBuild bundle\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: ts12m,
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"bun run build"', toolSummary: '"Build bundle"' } }],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: ts12m,
        content: `Created At: ${ts12m}\nTool is running as a background task with task id: ${S_AGY_FRESH}/task-2\nTask Description: bun run build`,
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: ts12m,
        content: 'Waiting on build task.',
      },
    ])

    // 2) Stuck agy task running 45 min (past default 30 min) while herdr says done.
    writeAgyTranscript(agyRoot, S_AGY_STUCK, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: ts45m,
        content: '<USER_REQUEST>\nCapture screenshots\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: ts45m,
        tool_calls: [
          { name: 'run_command', args: { CommandLine: '"node chrome.js"', toolSummary: '"Chrome screenshot run"' } },
        ],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: ts45m,
        content: `Created At: ${ts45m}\nTool is running as a background task with task id: ${S_AGY_STUCK}/task-2\nTask Description: node chrome.js`,
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: ts45m,
        content: 'Waiting on Chrome run.',
      },
    ])

    // 3) Stale transcript RUNNING entry whose conversations/<id>.db step is already DONE (status = 3).
    writeAgyTranscript(agyRoot, S_AGY_DB_DONE, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: ts45m,
        content: '<USER_REQUEST>\nRun quick script\n</USER_REQUEST>',
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: ts45m,
        content: `Created At: ${ts45m}\nTool is running as a background task with task id: ${S_AGY_DB_DONE}/task-2\nTask Description: echo ok`,
      },
    ])
    writeConvStepsDb(agyRoot, S_AGY_DB_DONE, [{ idx: 2, status: 3 }])

    // 4) agy pane with no transcript task, detected from footer "1 task(s)".
    writeAgyTranscript(agyRoot, S_AGY_FOOTER, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: ts12m,
        content: '<USER_REQUEST>\nCheck footer\n</USER_REQUEST>',
      },
    ])

    // 5) Sleeping agy session: must stay sleeping without bgTasks even if its transcript had a task.
    writeAgyTranscript(agyRoot, S_AGY_SLEEP, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: ts45m,
        content: '<USER_REQUEST>\nSleepy run\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: ts45m,
        content: `Created At: ${ts45m}\nTool is running as a background task with task id: ${S_AGY_SLEEP}/task-1`,
      },
    ])
    const stateDir = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(stateDir, 'wake-agy.json'),
      JSON.stringify({
        [S_AGY_SLEEP]: {
          session: S_AGY_SLEEP,
          name: 'Sleepy Atlas',
          pane: 'a9',
          cwd,
          argv: ['agy'],
          slept_at: now - 3600_000,
        },
      }),
    )

    const snapshot = {
      workspaces: [{ workspace_id: 'w1', label: 'Atlas 50%' }],
      tabs: [],
      panes: [
        {
          pane_id: 'a1',
          workspace_id: 'w1',
          agent: 'agy',
          agent_status: 'idle',
          agent_session: { value: S_AGY_FRESH },
          cwd,
          label: 'Anna agy',
        },
        {
          pane_id: 'a2',
          workspace_id: 'w1',
          agent: 'agy',
          agent_status: 'done',
          agent_session: { value: S_AGY_STUCK },
          cwd,
          label: 'Ben agy',
        },
        {
          pane_id: 'a3',
          workspace_id: 'w1',
          agent: 'agy',
          agent_status: 'done',
          agent_session: { value: S_AGY_DB_DONE },
          cwd,
          label: 'Cleo agy',
        },
        {
          pane_id: 'a4',
          workspace_id: 'w1',
          agent: 'agy',
          agent_status: 'done',
          agent_session: { value: S_AGY_FOOTER },
          cwd,
          label: 'Atlas agy',
        },
        {
          pane_id: 'c1',
          workspace_id: 'w1',
          agent: 'claude',
          agent_status: 'done',
          agent_session: { value: S_CLAUDE },
          cwd,
          terminal_title_stripped: 'Anna claude',
        },
        {
          pane_id: 'c2',
          workspace_id: 'w1',
          agent: 'claude',
          agent_status: 'idle',
          cwd: winCwd,
          terminal_title_stripped: 'Анна 50% pane',
        },
        {
          pane_id: 'p1',
          workspace_id: 'w1',
          agent: 'pi',
          agent_status: 'done',
          agent_session: { value: piSession },
          cwd: winCwd,
          terminal_title_stripped: 'Ben pi',
        },
        {
          pane_id: 'x1',
          workspace_id: 'w1',
          agent: 'codex',
          agent_status: 'done',
          agent_session: { value: S_CODEX },
          cwd,
          terminal_title_stripped: 'Cleo codex',
        },
      ],
    }

    box.state({
      'api snapshot': { result: { snapshot } },
      'agent read a3': { text: SCREEN_IDLE },
      'agent read a4': { text: SCREEN_WITH_TASK },
    })

    const cfgDir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({
        language: 'en',
        categories: [{ id: 'other', title: 'Other', color: 'gray', paths: [] }],
        wakeUrl: null,
        wake: false,
        refreshSec: 3600,
        launch: { agy: 'agy' },
      }),
    )

    ;({ url } = await serveBoard(
      box,
      { language: 'en', launch: { agy: 'agy' }, wake: false },
      { ANTIGRAVITY_APP_DATA_DIR: agyRoot, BOARD_TEST_PACE: '0.02', TEST_LIVE_CONFIG: '1' },
    ))
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const body = (await (await fetch(`${url}/api/board`)).json()) as { stale: boolean; items: Item[] }
      if (!body.stale && body.items.find(i => i.key === S_AGY_FOOTER)?.status === 'working') break
      await Bun.sleep(20)
    }
  }, 20_000)

  test('promotes agy sessions with transcript or footer tasks to working and flags stuck tasks past threshold', async () => {
    const items = await board()

    const fresh = items.find(i => i.key === S_AGY_FRESH)
    expect(fresh).toMatchObject({
      status: 'working',
      column: 'work',
      bgTasks: { count: 1, detail: 'Build bundle', stuckMin: 30 },
    })
    expect(fresh?.bgTasks?.stuck).toBeUndefined()

    const stuck = items.find(i => i.key === S_AGY_STUCK)
    expect(stuck).toMatchObject({
      status: 'working',
      column: 'work',
      bgTasks: { count: 1, detail: 'Chrome screenshot run', stuckMin: 30, stuck: true },
    })

    // Cleared in conversations/<id>.db -> stays done without bgTasks.
    const dbDone = items.find(i => i.key === S_AGY_DB_DONE)
    expect(dbDone).toMatchObject({ status: 'done', column: 'done' })
    expect(dbDone?.bgTasks).toBeUndefined()

    // Footer-only detection promotes done -> working.
    const footer = items.find(i => i.key === S_AGY_FOOTER)
    expect(footer).toMatchObject({
      status: 'working',
      column: 'work',
      bgTasks: { count: 1, detail: '', stuckMin: 30 },
    })
  })

  test('leaves Claude, pane-only, Codex, pi, and sleeping sessions untouched with zero footer probes', async () => {
    const items = await board()
    for (const key of [S_CLAUDE, 'pane-c2', piSession, S_CODEX, S_AGY_SLEEP]) {
      const it = items.find(i => i.key === key)
      expect(it).toBeDefined()
      expect(it?.bgTasks).toBeUndefined()
      expect('bgTasks' in (it as object)).toBe(false)
    }
    expect(items.find(i => i.key === S_CLAUDE)).toMatchObject({ status: 'done', column: 'done' })
    expect(items.find(i => i.key === 'pane-c2')).toMatchObject({
      name: 'Анна 50% pane',
      cwd: 'C:\\Users\\anna\\work repo 50%',
      status: 'idle',
      column: 'idle',
    })
    expect(items.find(i => i.key === piSession)).toMatchObject({ status: 'done', column: 'done' })
    expect(items.find(i => i.key === S_CODEX)).toMatchObject({ status: 'done', column: 'done' })
    expect(items.find(i => i.key === S_AGY_SLEEP)).toMatchObject({ sleeping: true, status: 'sleeping' })

    const readCalls = box.calls().filter(c => c[0] === 'agent' && c[1] === 'read')
    expect(readCalls.some(c => ['c1', 'c2', 'p1', 'x1'].includes(c[2] ?? ''))).toBe(false)
  })

  test('POST /api/settings configures bgTaskStuckMin and validates bounds', async () => {
    const waitStuckMin = async (expected: number): Promise<Item[]> => {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const items = await board()
        if (items.find(i => i.key === S_AGY_STUCK)?.bgTasks?.stuckMin === expected) return items
        await Bun.sleep(30)
      }
      return board()
    }

    // Reject invalid values.
    for (const bad of [-1, 1441, 1.5, '30', true]) {
      const res = await postSettings({ bgTaskStuckMin: bad })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false })
    }

    // Raise threshold to 60 min: 45 min task stays working without stuck flag.
    expect((await postSettings({ bgTaskStuckMin: 60 })).status).toBe(200)
    let items = await waitStuckMin(60)
    let stuck = items.find(i => i.key === S_AGY_STUCK)
    expect(stuck?.bgTasks?.stuckMin).toBe(60)
    expect(stuck?.bgTasks?.stuck).toBeUndefined()

    // Disable stuck warning with 0: still working, never stuck.
    expect((await postSettings({ bgTaskStuckMin: 0 })).status).toBe(200)
    items = await waitStuckMin(0)
    stuck = items.find(i => i.key === S_AGY_STUCK)
    expect(stuck?.status).toBe('working')
    expect(stuck?.bgTasks?.stuckMin).toBe(0)
    expect(stuck?.bgTasks?.stuck).toBeUndefined()

    // Lower threshold to 10 min: 12 min and 45 min tasks are both stuck.
    expect((await postSettings({ bgTaskStuckMin: 10 })).status).toBe(200)
    items = await waitStuckMin(10)
    expect(items.find(i => i.key === S_AGY_FRESH)?.bgTasks?.stuck).toBe(true)
    expect(items.find(i => i.key === S_AGY_STUCK)?.bgTasks?.stuck).toBe(true)
  })
})

describe('agy sleep refuses active background tasks (#676)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test('putAgyToSleep refuses when transcript or footer shows running background tasks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-bg-sleep-'))
    dirs.push(dir)
    const nowIso = new Date().toISOString()
    writeAgyTranscript(dir, S_AGY_FRESH, [
      { step_index: 0, type: 'USER_INPUT', created_at: nowIso, content: '<USER_REQUEST>\ngo\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: nowIso,
        content: `Tool is running as a background task with task id: ${S_AGY_FRESH}/task-1`,
      },
    ])
    const agy = createAgyHome(dir)
    expect(agy.hasRunningBgTask(S_AGY_FRESH)).toBe(true)

    const pane = {
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      tab_id: 't1',
      cwd: dir,
      agent: 'agy',
      agent_status: 'idle',
      agent_session: { value: S_AGY_FRESH },
    }
    const io = fakeWakeHerdr({ panes: [pane], inputBoxes: { 'w1:p1': SCREEN_IDLE } })
    const marks = { going() {}, stayed() {} }

    const fromTranscript = await putAgyToSleep(
      {
        herdr: io,
        agyProcess: async () => ({ pid: 10, argv: ['agy'] }),
        hasConversation: () => true,
        hasRunningHelpers: s => agy.hasRunningSubagent(s) || agy.hasRunningBgTask(s),
        reportSession: async () => {},
        exists: () => true,
        home: dir,
        newTab: async () => 'x',
        newWorkspace: async () => 'x',
      },
      { pane: 'w1:p1', session: S_AGY_FRESH, name: 'Atlas' },
      marks,
      { boardOnPath: true },
    )
    expect(fromTranscript.ok).toBe(false)

    // Even without transcript tasks, footer "1 task(s)" blocks sleep.
    const ioFooter = fakeWakeHerdr({ panes: [pane], inputBoxes: { 'w1:p1': SCREEN_WITH_TASK } })
    const fromFooter = await putAgyToSleep(
      {
        herdr: ioFooter,
        agyProcess: async () => ({ pid: 10, argv: ['agy'] }),
        hasConversation: () => true,
        hasRunningHelpers: () => false,
        reportSession: async () => {},
        exists: () => true,
        home: dir,
        newTab: async () => 'x',
        newWorkspace: async () => 'x',
      },
      { pane: 'w1:p1', session: S_AGY_FRESH, name: 'Atlas' },
      marks,
      { boardOnPath: true },
    )
    expect(fromFooter.ok).toBe(false)
    if (!fromFooter.ok) expect(fromFooter.error).toContain('background tasks are still running')
  })
})
