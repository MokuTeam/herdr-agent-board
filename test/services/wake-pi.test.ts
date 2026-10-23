// pi sessions put to sleep and woken by the wake engine (#178), against the in-memory fake herdr,
// a fake process table and a fake clock, with real session files in a temp folder: only an idle pi
// goes to sleep, all its processes are stopped, what wakes it is kept on disk and survives a
// restart of wake and of herdr, it wakes on the same session file and account in its pane or in a
// new tab, and Claude's answers stay as they were.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcRow, ProcSys } from '../../src/adapters/pi-processes.ts'
import { createProfileHomes } from '../../src/adapters/profile-homes.ts'
import { piSessionName } from '../../src/core/pi.ts'
import { profileSet } from '../../src/core/profiles.ts'
import { wakeConfig } from '../../src/core/wake/config.ts'
import type { PiSleepers } from '../../src/core/wake/pi.ts'
import { createWakeEngine, type WakeEngineDeps } from '../../src/services/wake/engine.ts'
import type { PiOps } from '../../src/services/wake/pi.ts'
import { isolatedHome } from '../support/env.ts'
import { type FakePane, type FakeWakeHerdr, fakeWakeHerdr } from '../support/fake-wake-herdr.ts'
import { SID } from '../support/wake-fixtures.ts'

const ID = '01a15d6d-9f21-7751-a71a-834d50839768'
const ID2 = '01a15e9b-3069-70f9-b902-f363327574f0'
const PI_PID = 400
const HOUR = 3_600_000

const RULE = '─'.repeat(40)
const piScreen = (box = '\x1b[7m \x1b[0m') => ['● done', '', RULE, box, RULE, 'xhigh · Opus 5.5   WORK'].join('\n')

/** A pi session file: its header, a prompt, and an answer that ends the turn unless `lines` say otherwise. */
function sessionFile(dir: string, id: string, cwd: string, lines?: Record<string, unknown>[]): string {
  const folder = join(dir, 'sessions', `--${cwd.replace(/[\\/]/g, '-')}--`)
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `2026-10-21T07-47-07-681Z_${id}.jsonl`)
  const entries = lines ?? [
    { type: 'model_change', provider: 'claude-bridge-work', modelId: 'claude-opus-5-5' },
    { type: 'message', message: { role: 'user', content: 'go' } },
    {
      type: 'message',
      message: { role: 'assistant', content: [], provider: 'claude-bridge-work', stopReason: 'stop' },
    },
  ]
  let parent: string | null = null
  const body = entries.map((e, i) => {
    const line = JSON.stringify({ ...e, id: `e${i}`, parentId: parent })
    parent = `e${i}`
    return line
  })
  writeFileSync(file, `${[JSON.stringify({ type: 'session', version: 3, id, cwd }), ...body].join('\n')}\n`)
  return file
}

interface World {
  dir: string
  home: string
  project: string
  file: string
  piFile: string
  io: FakeWakeHerdr
  pane: FakePane
  ops: PiOps
  /** Processes alive, and the signals sent. */
  live: Set<number>
  signals: string[]
  tabs: string[][]
  log: string[]
  clock: { at: number }
  deps: WakeEngineDeps
}

/**
 * A pi pane `w1:p1` in Work's account (its bridge's CLAUDE_CONFIG_DIR), idle, its input box empty,
 * running pi 400 with the bridge's claude 401 and an MCP server 402 under it. Stopping pi leaves
 * the pane at its shell; `board resume --pi <id>` run in a pane brings pi back there on the file.
 */
function world(
  o: { argv?: string[]; status?: string; lines?: Record<string, unknown>[]; configDir?: string | null } = {},
): World {
  const dir = isolatedHome()
  const home = join(dir, 'home')
  const project = join(home, 'Проект x 50%')
  mkdirSync(project, { recursive: true })
  const file = sessionFile(join(home, '.pi', 'agent'), ID, project, o.lines)
  const pane: FakePane = {
    pane_id: 'w1:p1',
    tab_id: 't1',
    workspace_id: 'w1',
    cwd: project,
    agent: 'pi',
    agent_status: o.status ?? 'idle',
    agent_session: { value: file },
    terminal_title_stripped: 'π - billing',
  }
  const io = fakeWakeHerdr({
    panes: [pane],
    workspaces: [{ workspace_id: 'w1', label: 'UP_WORK' }],
    shells: { 'w1:p1': 'bash' },
    screens: { 'w1:p1': piScreen() },
  })
  io.busy.add('w1:p1')
  const rows: ProcRow[] = [
    { pid: 300, ppid: 1 },
    { pid: PI_PID, ppid: 300 },
    { pid: 401, ppid: PI_PID },
    { pid: 402, ppid: 401 },
  ]
  const live = new Set(rows.map(r => r.pid))
  const signals: string[] = []
  const procs: ProcSys = {
    async table() {
      return rows.filter(r => live.has(r.pid))
    },
    signal(pid, sig) {
      signals.push(`${sig} ${pid}`)
      if (!live.delete(pid)) return false
      // pi leaves: its pane is back at its shell.
      if (pid === PI_PID) {
        pane.agent = null
        pane.agent_session = null
        delete pane.agent_status
        io.busy.delete('w1:p1')
      }
      return true
    },
    alive: pid => live.has(pid),
  }
  const tabs: string[][] = []
  let next = 10
  const newPane = (workspace: string, cwd: string): string => {
    const id = `${workspace}:p${next++}`
    io.panes.push({ pane_id: id, workspace_id: workspace, cwd })
    io.shells[id] = 'bash'
    return id
  }
  const ops: PiOps = {
    herdr: io,
    procs,
    piProcess: async p =>
      p === 'w1:p1' && live.has(PI_PID)
        ? {
            pid: PI_PID,
            argv: o.argv ?? [
              'pi',
              '--model',
              'claude-bridge-work/claude-opus-5-5',
              '--name',
              'billing',
              'Read the brief',
            ],
          }
        : null,
    configDir: () => (o.configDir === undefined ? join(home, '.claude-work') : o.configDir),
    tail: f => (existsSync(f) ? readFileSync(f, 'utf8').split('\n') : null),
    sessionName: f => (existsSync(f) ? piSessionName(readFileSync(f, 'utf8')) : ''),
    writtenAt: () => 0,
    exists: p => existsSync(p),
    async newTab(workspace, cwd, label) {
      tabs.push(['tab', workspace, cwd, label])
      return newPane(workspace, cwd)
    },
    async newWorkspace(cwd, label) {
      tabs.push(['workspace', cwd, label])
      io.workspaces.push({ workspace_id: 'w9', label })
      return newPane('w9', cwd)
    },
    home,
    platform: 'linux',
  }
  // pi comes back idle on its session file in whichever pane the wake line runs.
  io.on(
    argv => argv[0] === 'pane' && argv[1] === 'run' && argv[3] === `board resume --pi ${ID}`,
    argv => {
      const p = io.panes.find(x => x.pane_id === argv[2])
      if (!p) return
      p.agent = 'pi'
      p.agent_status = 'idle'
      p.agent_session = { value: file }
      io.busy.add(p.pane_id)
    },
  )
  const clock = { at: Date.now() }
  const log: string[] = []
  const sessionsFile = join(dir, 'state', 'wake-sessions.json')
  const piFile = join(dir, 'state', 'wake-pi.json')
  const settings = wakeConfig({ enabled: true })
  const deps: WakeEngineDeps = {
    herdr: io,
    homes: createProfileHomes(),
    profiles: () => profileSet([], join(home, '.claude')),
    settings: () => settings,
    sessionsFile,
    boardOnPath: () => true,
    scheduled: async () => false,
    log: text => void log.push(text),
    now: () => clock.at,
    sleep: async ms => {
      clock.at += ms
    },
    platform: 'linux',
    pi: ops,
    piCard: () => ({ name: 'Billing' }),
  }
  return { dir, home, project, file, piFile, io, pane, ops, live, signals, tabs, log, clock, deps }
}

const readPis = (w: World): PiSleepers => JSON.parse(readFileSync(w.piFile, 'utf8'))
const typed = (io: FakeWakeHerdr): string[][] =>
  io.calls.filter(c => c[0] === 'pane' && ['run', 'send-keys', 'send-text'].includes(c[1] ?? ''))

test('an idle pi goes to sleep: its whole tree stopped, what wakes it kept on disk, the wake line typed', async () => {
  const w = world()
  const engine = createWakeEngine(w.deps)
  expect(await engine.sleep('w1:p1')).toEqual({ ok: true, pane: 'w1:p1', name: 'Billing' })
  // pi first, then what it left: its bridge's claude and the MCP server under that.
  expect(w.signals[0]).toBe(`SIGTERM ${PI_PID}`)
  expect([...w.live]).toEqual([300])
  const kept = readPis(w)[w.file]
  expect(kept).toMatchObject({
    session: w.file,
    name: 'Billing',
    pane: 'w1:p1',
    workspace: 'w1',
    workspaceLabel: 'UP_WORK',
    cwd: w.project,
    argv: ['pi', '--model', 'claude-bridge-work/claude-opus-5-5', '--name', 'billing', 'Read the brief'],
    account: join(w.home, '.claude-work'),
    provider: 'claude-bridge-work',
  })
  expect(kept?.slept_at).toBe(w.clock.at - 500)
  expect(w.pane.label).toBe('💤 Billing')
  expect(w.io.calls.at(-1)).toEqual(['pane', 'send-text', 'w1:p1', `board resume --pi ${ID}`])
  // The board's list has it; /sleeping, which the hooks read, stays Claude's.
  expect(await engine.sleepingAll()).toEqual([
    {
      name: 'Billing',
      pane: 'w1:p1',
      session: w.file,
      workspace: 'UP_WORK',
      slept_at: new Date(kept?.slept_at ?? 0).toISOString(),
      exited: false,
      agent: 'pi',
      cwd: w.project,
    },
  ])
  expect(await engine.sleeping()).toEqual([])
})

test('by its session file or its id as well as its pane', async () => {
  const byFile = world()
  expect(await createWakeEngine(byFile.deps).sleep(byFile.file)).toMatchObject({ ok: true, pane: 'w1:p1' })
  const byId = world()
  expect(await createWakeEngine(byId.deps).sleep(ID)).toMatchObject({ ok: true, pane: 'w1:p1' })
  const byName = world()
  // Its name is the board's to resolve: wake takes a pane, a file or an id.
  expect(await createWakeEngine(byName.deps).sleep('Billing')).toMatchObject({ ok: false })
})

test('pi that is not free stays up, nothing stopped and nothing kept', async () => {
  const cases: [string, () => World][] = [
    ['working', () => world({ status: 'working' })],
    [
      'mid-turn in its file',
      () =>
        world({
          lines: [
            { type: 'message', message: { role: 'user', content: 'go' } },
            { type: 'message', message: { role: 'assistant', content: [], stopReason: 'toolUse' } },
          ],
        }),
    ],
    [
      'a draft in its input box',
      () => {
        const w = world()
        w.io.screens['w1:p1'] = piScreen('half a thought')
        return w
      },
    ],
    ['an option nobody can read', () => world({ argv: ['pi', '--plan', 'do it'] })],
  ]
  for (const [why, make] of cases) {
    const w = make()
    const r = await createWakeEngine(w.deps).sleep('w1:p1')
    expect(r.ok, why).toBe(false)
    expect(w.signals, why).toEqual([])
    expect(existsSync(w.piFile) ? readPis(w) : {}, why).toEqual({})
    expect(w.pane.agent, why).toBe('pi')
  }
  const off = world()
  off.deps.boardOnPath = () => false
  expect(await createWakeEngine(off.deps).sleep('w1:p1')).toEqual({
    ok: false,
    error: 'Billing cannot be put to sleep: board is not on PATH',
  })
})

test('the account kept is the card’s where pi’s env cannot be read, and none where neither says', async () => {
  const w = world({ configDir: null })
  w.deps.piCard = () => ({ name: 'Billing', account: join(w.home, '.claude') })
  await createWakeEngine(w.deps).sleep('w1:p1')
  expect(readPis(w)[w.file]?.account).toBe(join(w.home, '.claude'))
  const none = world({ configDir: null })
  await createWakeEngine(none.deps).sleep('w1:p1')
  expect(readPis(none)[none.file]).not.toHaveProperty('account')
})

test('the sleeper survives wake restarting, herdr restarting and the computer restarting', async () => {
  const w = world()
  await createWakeEngine(w.deps).sleep('w1:p1')
  // herdr comes back: the pane is a bare shell in its folder, its label and typed line gone.
  delete w.pane.label
  const again = createWakeEngine(w.deps)
  await again.remember()
  expect(await again.sleepingAll()).toMatchObject([{ session: w.file, pane: 'w1:p1', agent: 'pi' }])
  // Its pane closed, or another folder now: it is still asleep, to wake in a new tab.
  w.pane.cwd = '/tmp'
  expect(await createWakeEngine(w.deps).sleepingAll()).toMatchObject([{ session: w.file, pane: '', agent: 'pi' }])
  w.io.panes.length = 0
  const third = createWakeEngine(w.deps)
  await third.remember()
  expect(await third.sleepingAll()).toMatchObject([{ session: w.file, pane: '', workspace: 'UP_WORK' }])
  expect(Object.keys(readPis(w))).toEqual([w.file])
})

test('it wakes in its own pane: the prompt cleared, board resume --pi run, until pi is back on its file', async () => {
  const w = world()
  const engine = createWakeEngine(w.deps)
  await engine.sleep('w1:p1')
  w.io.calls.length = 0
  expect(await engine.wake(w.file)).toEqual({ ok: true, pane: 'w1:p1', name: 'Billing' })
  expect(typed(w.io)).toEqual([
    ['pane', 'send-keys', 'w1:p1', 'ctrl+u'],
    ['pane', 'run', 'w1:p1', `board resume --pi ${ID}`],
  ])
  expect(w.pane).toMatchObject({ agent: 'pi', agent_session: { value: w.file } })
  expect(w.pane.label).toBeUndefined()
  expect(readPis(w)).toEqual({})
  expect(w.tabs).toEqual([])
})

test('its pane gone, it wakes in a new tab of its workspace, in its folder, and says where', async () => {
  const w = world()
  const engine = createWakeEngine(w.deps)
  await engine.sleep('w1:p1')
  w.io.panes.splice(0, 1)
  expect(await engine.wake(ID)).toEqual({ ok: true, pane: 'w1:p10', name: 'Billing' })
  expect(w.tabs).toEqual([['tab', 'w1', w.project, 'Billing']])
  expect(typed(w.io)).toContainEqual(['pane', 'run', 'w1:p10', `board resume --pi ${ID}`])
  expect(readPis(w)).toEqual({})
})

test('another program in its pane, or its folder gone: a new tab; its workspace gone too: a new workspace', async () => {
  const w = world()
  const engine = createWakeEngine(w.deps)
  await engine.sleep('w1:p1')
  w.pane.agent = 'claude'
  w.pane.agent_session = { value: SID }
  rmSync(w.project, { recursive: true })
  w.io.workspaces.length = 0
  expect(await engine.wake('Billing')).toEqual({ ok: true, pane: 'w9:p10', name: 'Billing' })
  expect(w.tabs).toEqual([['workspace', w.home, 'UP_WORK']])
})

test('woken by hand (Enter on the typed line), it is no longer asleep at the next look', async () => {
  const w = world()
  const engine = createWakeEngine(w.deps)
  await engine.sleep('w1:p1')
  w.pane.agent = 'pi'
  w.pane.agent_status = 'idle'
  w.pane.agent_session = { value: w.file }
  await engine.remember()
  expect(readPis(w)).toEqual({})
  expect(w.io.calls).toContainEqual(['pane', 'rename', 'w1:p1', '--clear'])
  // A wake asked for meanwhile finds it up.
  expect(await engine.wake(w.file)).toEqual({ ok: true, pane: 'w1:p1', name: 'π - billing', already: true })
})

test('a session whose file is gone is forgotten', async () => {
  const w = world()
  const engine = createWakeEngine(w.deps)
  await engine.sleep('w1:p1')
  rmSync(w.file)
  await engine.remember()
  expect(readPis(w)).toEqual({})
})

test('a pane where pi was stopped by hand is taken as that session asleep there, its account from its card', async () => {
  const w = world()
  // Stopped by hand: the pane is a shell, pi and its tree gone.
  w.pane.agent = null
  w.pane.agent_session = null
  delete w.pane.agent_status
  w.io.busy.delete('w1:p1')
  w.deps.piCard = () => ({ name: 'Billing', account: join(w.home, '.claude-work') })
  const engine = createWakeEngine(w.deps)
  expect(await engine.adoptPi('w1:p1', w.file)).toEqual({ ok: true, pane: 'w1:p1', name: 'Billing' })
  expect(readPis(w)[w.file]).toMatchObject({
    pane: 'w1:p1',
    cwd: w.project,
    argv: [],
    account: join(w.home, '.claude-work'),
    provider: 'claude-bridge-work',
    adopted: true,
  })
  expect(w.pane.label).toBe('💤 Billing')
  expect(typed(w.io)).toEqual([
    ['pane', 'send-keys', 'w1:p1', 'ctrl+u'],
    ['pane', 'send-text', 'w1:p1', `board resume --pi ${ID}`],
  ])
  expect(await engine.adoptPi('w1:p1', w.file)).toMatchObject({ ok: true, already: true })
  // Not a pane where pi runs that session, nor a file that is not pi's.
  const running = world()
  expect(await createWakeEngine(running.deps).adoptPi('w1:p1', running.file)).toEqual({
    ok: false,
    error: `${running.file} runs in w1:p1: it is not asleep`,
  })
  expect(await engine.adoptPi('w1:p1', join(w.dir, 'x.txt'))).toMatchObject({ ok: false })
})

test('Claude’s answers are as before beside a pi sleeper: /sleeping and the session file', async () => {
  const w = world()
  const at = w.clock.at - HOUR
  mkdirSync(join(w.dir, 'state'), { recursive: true })
  writeFileSync(
    w.deps.sessionsFile,
    JSON.stringify({ 'w1:p2': { session: SID, name: 'Mocap', seen_at: at, slept_at: at, exited: true } }),
  )
  w.io.panes.push({ pane_id: 'w1:p2', workspace_id: 'w1', cwd: w.project })
  const engine = createWakeEngine(w.deps)
  const before = await engine.sleeping()
  await engine.sleep('w1:p1')
  expect(await engine.sleeping()).toEqual(before)
  expect(before).toMatchObject([{ session: SID, pane: 'w1:p2' }])
  const all = await engine.sleepingAll()
  expect(all.map(s => s.session)).toEqual([SID, w.file])
  expect(JSON.parse(readFileSync(w.deps.sessionsFile, 'utf8'))).not.toHaveProperty('w1:p1')
})

test('Telegram: a pi sleeper in its own pane is a pane to wake, and wakePane wakes it', async () => {
  const w = world()
  const engine = createWakeEngine(w.deps)
  await engine.sleep('w1:p1')
  const { sessions } = await engine.seen()
  expect(sessions['w1:p1']).toMatchObject({ session: w.file, title: 'Billing' })
  expect(await engine.wakePane('w1:p1')).toEqual({ ok: true })
  expect(w.pane.agent_session).toEqual({ value: w.file })
})

test('a second sleeper by another id wakes on its own file', async () => {
  const w = world()
  const other = sessionFile(join(w.home, '.pi', 'agent'), ID2, w.project)
  mkdirSync(join(w.dir, 'state'), { recursive: true })
  const slept = Date.now() - HOUR
  writeFileSync(
    w.piFile,
    JSON.stringify({
      [other]: {
        session: other,
        name: 'git-guard',
        pane: 'w1:p5',
        workspace: 'w1',
        cwd: w.project,
        argv: [],
        slept_at: slept,
      },
    }),
  )
  const fresh = createWakeEngine(w.deps)
  expect(await fresh.sleepingAll()).toMatchObject([{ session: other, pane: '' }])
  w.io.on(
    argv => argv[1] === 'run' && argv[3] === `board resume --pi ${ID2}`,
    argv => {
      const p = w.io.panes.find(x => x.pane_id === argv[2])
      if (p) Object.assign(p, { agent: 'pi', agent_status: 'idle', agent_session: { value: other } })
    },
  )
  expect(await fresh.wake(ID2)).toMatchObject({ ok: true, name: 'git-guard' })
  expect(w.tabs).toEqual([['tab', 'w1', w.project, 'git-guard']])
  expect(w.pane.agent_session).toEqual({ value: w.file })
})

test('a pane taken over is named by its session, never by the shell’s title; one with no name by its folder', async () => {
  const w = world()
  w.pane.agent = null
  w.pane.agent_session = null
  delete w.pane.agent_status
  w.io.busy.delete('w1:p1')
  // The shell's title, as herdr shows a bare shell.
  w.pane.terminal_title_stripped = 'nicholas@laptop:~/Проект x 50%'
  w.deps.piCard = () => ({})
  // No name anywhere in the file: pi's own title without one.
  expect(await createWakeEngine(w.deps).adoptPi('w1:p1', w.file)).toEqual({
    ok: true,
    pane: 'w1:p1',
    name: 'π - Проект x 50%',
  })
  expect(w.pane.label).toBe('💤 π - Проект x 50%')
  // A name `--name` gave, right after the header, far above the end that is read for the turn.
  const named = world()
  Object.assign(named.pane, { agent: null, agent_session: null, terminal_title_stripped: 'nicholas@laptop:~' })
  delete named.pane.agent_status
  named.io.busy.delete('w1:p1')
  named.deps.piCard = () => ({})
  const lines = readFileSync(named.file, 'utf8').split('\n')
  const info = JSON.stringify({ type: 'session_info', id: 'n0', parentId: null, name: 'board-ask-form-missing' })
  named.ops.tail = f => (f === named.file ? lines.slice(-3) : null)
  writeFileSync(named.file, [lines[0], info, ...lines.slice(1)].join('\n'))
  expect(await createWakeEngine(named.deps).adoptPi('w1:p1', named.file)).toMatchObject({
    name: 'board-ask-form-missing',
  })
})

test('a running pi whose name is only near the top of its file sleeps under that name', async () => {
  const w = world()
  w.deps.piCard = () => ({})
  const lines = readFileSync(w.file, 'utf8').split('\n')
  writeFileSync(
    w.file,
    [
      lines[0],
      JSON.stringify({ type: 'session_info', id: 'n0', parentId: null, name: 'pricing-sync' }),
      ...lines.slice(1),
    ].join('\n'),
  )
  w.ops.tail = f => (f === w.file ? readFileSync(f, 'utf8').split('\n').slice(-4) : null)
  expect(await createWakeEngine(w.deps).sleep('w1:p1')).toEqual({ ok: true, pane: 'w1:p1', name: 'pricing-sync' })
})
