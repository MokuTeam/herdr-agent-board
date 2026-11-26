// Antigravity (`agy`) sessions put to sleep and woken by the wake engine (#631), against the
// in-memory fake herdr and a fake clock: only an idle agy with no running subagents and an empty
// input box goes to sleep via `/exit` (with Enter retry and `Ctrl+D Ctrl+D` fallback), what wakes
// it is kept in `wake-agy.json`, `/sleeping` stays Claude-only while `/sleeping?agents=all` adds
// agy, it wakes in its pane or a new tab and reports its conversation UUID when herdr has not yet
// seen a PreInvocation, and Claude's behavior stays untouched.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProfileHomes } from '../../src/adapters/profile-homes.ts'
import { profileSet } from '../../src/core/profiles.ts'
import type { AgySleepers } from '../../src/core/wake/agy.ts'
import { wakeConfig } from '../../src/core/wake/config.ts'
import type { AgyOps } from '../../src/services/wake/agy.ts'
import { createWakeEngine, type WakeEngineDeps } from '../../src/services/wake/engine.ts'
import { isolatedHome } from '../support/env.ts'
import { type FakePane, type FakeWakeHerdr, fakeWakeHerdr } from '../support/fake-wake-herdr.ts'
import { runningSession } from '../support/wake-fixtures.ts'

const ID = '509dfc37-b58e-4851-9988-a8c7befe9f0d'
const LINE = `board resume --agy ${ID}`
const RULE = '─'.repeat(40)
const agyScreen = (box = '> ') => ['● Done.', '', RULE, box, RULE, '? for shortcuts   Gemini 4 Neon · high'].join('\n')

interface World {
  dir: string
  home: string
  project: string
  agyFile: string
  io: FakeWakeHerdr
  pane: FakePane
  ops: AgyOps
  reported: [string, string][]
  tabs: string[][]
  log: string[]
  clock: { at: number }
  hasConv: boolean
  runningHelpers: boolean
  archivedIds: Set<string>
  deps: WakeEngineDeps
}

function world(
  o: {
    argv?: string[]
    status?: string
    screen?: string
    runningHelpers?: boolean
    hasConv?: boolean
    boardOnPath?: boolean
    exitOn?: 'prompt' | 'enter' | 'ctrl-d' | 'ctrl-d-first' | 'never'
    reportOnWake?: boolean
  } = {},
): World {
  const dir = isolatedHome()
  const home = join(dir, 'home')
  const project = join(home, 'Проект x 50%')
  mkdirSync(project, { recursive: true })
  const pane: FakePane = {
    pane_id: 'w5:p9',
    tab_id: 't9',
    workspace_id: 'w5',
    cwd: project,
    agent: 'agy',
    agent_status: o.status ?? 'idle',
    agent_session: { value: ID },
    terminal_title_stripped: 'Gemini Dev',
  }
  const io = fakeWakeHerdr({
    panes: [pane],
    workspaces: [{ workspace_id: 'w5', label: 'Server' }],
    shells: { 'w5:p9': 'bash' },
    screens: { 'w5:p9': o.screen ?? agyScreen() },
    inputBoxes: { 'w5:p9': o.screen ?? agyScreen() },
  })
  io.busy.add('w5:p9')

  const exitOn = o.exitOn ?? 'prompt'
  const clearPane = (p: FakePane) => {
    p.agent = null
    p.agent_session = null
    delete p.agent_status
    io.busy.delete(p.pane_id)
  }

  let ctrlDCount = 0
  const basePrompt = io.prompt.bind(io)
  io.prompt = async (paneId, text) => {
    await basePrompt(paneId, text)
    if (paneId === 'w5:p9' && text === '/exit') {
      if (exitOn === 'prompt') {
        clearPane(pane)
        return
      }
      if (exitOn === 'enter') {
        io.screens['w5:p9'] = agyScreen('> /exit')
        const err = Object.assign(new Error('agent_prompt_stalled'), { code: 'agent_prompt_stalled' })
        throw err
      }
      if (exitOn === 'ctrl-d' || exitOn === 'ctrl-d-first' || exitOn === 'never') {
        const err = Object.assign(new Error('agent_prompt_stalled'), { code: 'agent_prompt_stalled' })
        throw err
      }
    }
  }

  const baseSendKeys = io.sendKeys.bind(io)
  io.sendKeys = async (paneId, key) => {
    await baseSendKeys(paneId, key)
    if (paneId === 'w5:p9' && key === 'enter' && exitOn === 'enter') clearPane(pane)
    if (paneId === 'w5:p9' && key === 'ctrl+d' && (exitOn === 'ctrl-d' || exitOn === 'ctrl-d-first')) {
      ctrlDCount++
      if (exitOn === 'ctrl-d-first' || ctrlDCount >= 2) clearPane(pane)
    }
  }

  const baseRun = io.run.bind(io)
  io.run = async (paneId, line) => {
    await baseRun(paneId, line)
    if (line === LINE) {
      const target = io.panes.find(p => p.pane_id === paneId)
      if (target) {
        target.agent = 'agy'
        target.agent_status = 'idle'
        // Simulate herdr not yet knowing agent_session before PreInvocation when reportOnWake is true.
        target.agent_session = o.reportOnWake ? null : { value: ID }
        io.busy.add(paneId)
      }
    }
  }

  const reported: [string, string][] = []
  const tabs: string[][] = []
  let next = 20
  const newPane = (workspace: string, cwd: string): string => {
    const id = `${workspace}:p${next++}`
    io.panes.push({ pane_id: id, workspace_id: workspace, cwd })
    io.shells[id] = 'bash'
    return id
  }

  const state = { hasConv: o.hasConv ?? true, runningHelpers: o.runningHelpers ?? false }
  const archivedIds = new Set<string>()
  const ops: AgyOps = {
    herdr: io,
    agyProcess: async p =>
      p === 'w5:p9' && pane.agent === 'agy'
        ? { pid: 9001, argv: o.argv ?? ['agy', '--dangerously-skip-permissions', '--conversation', ID] }
        : null,
    hasConversation: id => state.hasConv && id.toLowerCase() === ID.toLowerCase(),
    hasRunningHelpers: () => state.runningHelpers,
    async reportSession(paneId, session) {
      reported.push([paneId, session])
      const target = io.panes.find(p => p.pane_id === paneId)
      if (target) target.agent_session = { value: session }
    },
    exists: p => existsSync(p),
    home,
    async newTab(workspace, cwd, label) {
      tabs.push(['tab', workspace, cwd, label])
      return newPane(workspace, cwd)
    },
    async newWorkspace(cwd, label) {
      tabs.push(['ws', cwd, label])
      const ws = `w${next}`
      io.workspaces.push({ workspace_id: ws, label })
      return newPane(ws, cwd)
    },
  }

  const clock = { at: Date.UTC(2026, 10, 23, 15, 0, 0) }
  const log: string[] = []
  const sessionsFile = join(dir, 'wake-sessions.json')
  const agyFile = join(dir, 'wake-agy.json')
  const deps: WakeEngineDeps = {
    herdr: io,
    homes: createProfileHomes(),
    profiles: () => profileSet([], join(home, '.claude')),
    settings: () => wakeConfig({ enabled: true, wakeTimeoutSec: 10 }),
    sessionsFile,
    agyFile,
    agy: ops,
    agyCard: () => ({ name: 'Gemini Dev' }),
    archived: ids => new Set(ids.filter(id => archivedIds.has(id))),
    boardOnPath: () => o.boardOnPath ?? true,
    scheduled: async () => false,
    log: text => log.push(text),
    now: () => clock.at,
    sleep: async ms => {
      clock.at += ms
    },
  }
  return {
    dir,
    home,
    project,
    agyFile,
    io,
    pane,
    ops,
    reported,
    tabs,
    log,
    clock,
    get hasConv() {
      return state.hasConv
    },
    set hasConv(v) {
      state.hasConv = v
    },
    get runningHelpers() {
      return state.runningHelpers
    },
    set runningHelpers(v) {
      state.runningHelpers = v
    },
    archivedIds,
    deps,
  }
}

test('puts an idle agy session to sleep via /exit, keeps wake-agy.json, keeps /sleeping Claude-only, and wakes in its pane', async () => {
  const w = world({ reportOnWake: true })
  const engine = createWakeEngine(w.deps)

  const slept = await engine.sleep(ID)
  expect(slept).toEqual({ ok: true, pane: 'w5:p9', name: 'Gemini Dev' })
  expect(w.pane.label).toBe('💤 Gemini Dev')
  expect(w.io.calls).toContainEqual(['pane', 'send-text', 'w5:p9', LINE])

  const saved = JSON.parse(readFileSync(w.agyFile, 'utf8')) as AgySleepers
  expect(saved[ID]).toMatchObject({
    session: ID,
    name: 'Gemini Dev',
    pane: 'w5:p9',
    workspace: 'w5',
    workspaceLabel: 'Server',
    cwd: w.project,
    argv: ['agy', '--dangerously-skip-permissions', '--conversation', ID],
  })

  // /sleeping stays Claude-only; /sleeping?agents=all includes agy.
  expect(await engine.sleeping()).toEqual([])
  expect(await engine.sleepingAll()).toEqual([
    {
      name: 'Gemini Dev',
      pane: 'w5:p9',
      session: ID,
      workspace: 'Server',
      slept_at: new Date(saved[ID]?.slept_at ?? 0).toISOString(),
      exited: false,
      agent: 'agy',
      cwd: w.project,
    },
  ])

  // Wake in its own pane: clears prompt line, runs board resume --agy <id>, reports session UUID to herdr, clears 💤.
  const woke = await engine.wake(ID)
  expect(woke).toEqual({ ok: true, pane: 'w5:p9', name: 'Gemini Dev' })
  expect(w.io.calls).toContainEqual(['pane', 'send-keys', 'w5:p9', 'ctrl+u'])
  expect(w.io.calls).toContainEqual(['pane', 'run', 'w5:p9', LINE])
  expect(w.reported).toEqual([['w5:p9', ID]])
  expect(w.pane.label).toBeUndefined()
  expect(await engine.sleepingAll()).toEqual([])
})

test('handles /exit completion Enter retry and Ctrl+D Ctrl+D fallback', async () => {
  const wEnter = world({ exitOn: 'enter' })
  const eEnter = createWakeEngine(wEnter.deps)
  expect(await eEnter.sleep('w5:p9')).toEqual({ ok: true, pane: 'w5:p9', name: 'Gemini Dev' })
  expect(wEnter.io.calls).toContainEqual(['pane', 'send-keys', 'w5:p9', 'enter'])

  const wCtrlD = world({ exitOn: 'ctrl-d' })
  const eCtrlD = createWakeEngine(wCtrlD.deps)
  expect(await eCtrlD.sleep('w5:p9')).toEqual({ ok: true, pane: 'w5:p9', name: 'Gemini Dev' })
  expect(wCtrlD.io.calls.filter(c => c[0] === 'pane' && c[1] === 'send-keys' && c[3] === 'ctrl+d')).toHaveLength(2)

  // If agy already exits on the first Ctrl+D, do not send a second Ctrl+D to the shell.
  const wCtrlDFirst = world({ exitOn: 'ctrl-d-first' })
  const eCtrlDFirst = createWakeEngine(wCtrlDFirst.deps)
  expect(await eCtrlDFirst.sleep('w5:p9')).toEqual({ ok: true, pane: 'w5:p9', name: 'Gemini Dev' })
  expect(wCtrlDFirst.io.calls.filter(c => c[0] === 'pane' && c[1] === 'send-keys' && c[3] === 'ctrl+d')).toHaveLength(1)

  // If agy refuses to exit at all, marks.stayed() removes the sleeper record.
  const wStuck = world({ exitOn: 'never' })
  const eStuck = createWakeEngine(wStuck.deps)
  const res = await eStuck.sleep(ID)
  expect(res.ok).toBe(false)
  expect(await eStuck.sleepingAll()).toEqual([])
})

test('refuses to sleep when working, blocked, running subagents, draft text, missing board, or missing conversation', async () => {
  for (const [label, opts, match] of [
    ['working', { status: 'working' }, /not idle/],
    ['blocked', { status: 'blocked' }, /not idle/],
    ['subagents', { runningHelpers: true }, /subagents/],
    ['draft', { screen: agyScreen('> half typed') }, /input box/],
    ['no board on PATH', { boardOnPath: false }, /board is not on PATH/],
    ['no conversation', { hasConv: false }, /no transcript/],
  ] as const) {
    const w = world(opts)
    const engine = createWakeEngine(w.deps)
    const r = await engine.sleep(ID)
    expect(r.ok, label).toBe(false)
    if (!r.ok) expect(r.error, label).toMatch(match)
    expect(w.pane.agent, label).toBe('agy')
  }
})

test('wakes in a new tab when the original pane is gone or repurposed, and supports wakePane + remember cleanup', async () => {
  const w = world()
  const engine = createWakeEngine(w.deps)
  expect((await engine.sleep(ID)).ok).toBe(true)

  // Remove the pane -> sleepingAll shows pane '', wake opens a new tab in workspace w5.
  w.io.panes.length = 0
  expect((await engine.sleepingAll())[0]?.pane).toBe('')
  const woke = await engine.wake('Gemini Dev [509dfc37]')
  expect(woke).toEqual({ ok: true, pane: 'w5:p20', name: 'Gemini Dev' })
  expect(w.tabs).toEqual([['tab', 'w5', w.project, 'Gemini Dev']])

  // Sleep again in w5:p9 (restore pane), test Telegram seen() + wakePane().
  const w2 = world()
  const engine2 = createWakeEngine(w2.deps)
  expect((await engine2.sleep(ID)).ok).toBe(true)
  const seen = await engine2.seen()
  expect(seen.sessions['w5:p9']?.session).toBe(ID)
  const wp = await engine2.wakePane('w5:p9')
  expect(wp).toEqual({ ok: true })
  expect(await engine2.sleepingAll()).toEqual([])

  // Archived agy sleeper is forgotten on remember().
  const w3 = world()
  const engine3 = createWakeEngine(w3.deps)
  expect((await engine3.sleep(ID)).ok).toBe(true)
  w3.archivedIds.add(ID)
  await engine3.remember()
  expect(await engine3.sleepingAll()).toEqual([])
})

const CLAUDE_ID = '2fbcc149-2101-4190-892f-f3dbf6beca67'
const CLAUDE_BOX = [RULE, '❯ ', RULE, '? for shortcuts'].join('\n')

test('plain Claude setup never calls AgyOps, and same-shape Claude + agy UUIDs stay isolated', async () => {
  const dir = isolatedHome()
  const home = join(dir, 'home')
  const project = join(home, 'repo')
  mkdirSync(project, { recursive: true })
  const clock = { at: Date.UTC(2026, 10, 23, 15, 0, 0) }
  const claudeDir = join(home, '.claude')
  runningSession(claudeDir, {
    id: CLAUDE_ID,
    name: 'Claude Master',
    cwd: project,
    status: 'idle',
    statusUpdatedAt: clock.at - 120_000,
  })

  const claudePane: FakePane = {
    pane_id: 'w1:p1',
    tab_id: 't1',
    workspace_id: 'w1',
    cwd: project,
    agent: 'claude',
    agent_status: 'idle',
    agent_session: { value: CLAUDE_ID },
    terminal_title_stripped: 'Claude Master',
  }
  const io = fakeWakeHerdr({
    panes: [claudePane],
    workspaces: [{ workspace_id: 'w1', label: 'Main' }],
    shells: { 'w1:p1': 'bash' },
    screens: { 'w1:p1': CLAUDE_BOX },
    inputBoxes: { 'w1:p1': CLAUDE_BOX },
  })
  io.busy.add('w1:p1')
  const basePrompt = io.prompt.bind(io)
  io.prompt = async (paneId, text) => {
    await basePrompt(paneId, text)
    if (paneId === 'w1:p1' && text === '/exit') {
      claudePane.agent = null
      claudePane.agent_session = null
      delete claudePane.agent_status
      io.busy.delete('w1:p1')
    }
  }
  const baseRun = io.run.bind(io)
  io.run = async (paneId, line) => {
    await baseRun(paneId, line)
    if (paneId === 'w1:p1' && line.startsWith(`board resume ${CLAUDE_ID}`)) {
      claudePane.agent = 'claude'
      claudePane.agent_status = 'idle'
      claudePane.agent_session = { value: CLAUDE_ID }
      io.busy.add('w1:p1')
    }
  }

  const bomb = (name: string): never => {
    throw new Error(`AgyOps.${name} must not be called for a plain Claude setup`)
  }
  const throwingAgy: AgyOps = {
    herdr: io,
    agyProcess: async () => bomb('agyProcess'),
    hasConversation: () => bomb('hasConversation'),
    hasRunningHelpers: () => bomb('hasRunningHelpers'),
    reportSession: async () => bomb('reportSession'),
    exists: () => bomb('exists'),
    home,
    newTab: async () => bomb('newTab'),
    newWorkspace: async () => bomb('newWorkspace'),
  }
  const sessionsFile = join(dir, 'wake-sessions.json')
  const agyFile = join(dir, 'wake-agy.json')
  const engine = createWakeEngine({
    herdr: io,
    homes: createProfileHomes(),
    profiles: () => profileSet([], claudeDir),
    settings: () => wakeConfig({ enabled: true, closePanes: false, wakeTimeoutSec: 10 }),
    sessionsFile,
    agyFile,
    agy: throwingAgy,
    boardOnPath: () => true,
    scheduled: async () => false,
    log: () => {},
    now: () => clock.at,
    sleep: async ms => {
      clock.at += ms
    },
  })

  await engine.remember()
  expect(await engine.awake()).toHaveLength(1)
  expect(await engine.plan()).toHaveLength(1)
  expect(await engine.sleeping()).toEqual([])
  expect(await engine.sleepingAll()).toEqual([])

  expect(await engine.sleep(CLAUDE_ID)).toEqual({ ok: true, pane: 'w1:p1', name: 'Claude Master' })
  expect(existsSync(agyFile)).toBe(false)
  expect((await engine.sleeping()).map(s => s.session)).toEqual([CLAUDE_ID])
  expect((await engine.sleepingAll()).map(s => s.session)).toEqual([CLAUDE_ID])

  expect(await engine.wake(CLAUDE_ID)).toEqual({ ok: true, pane: 'w1:p1', name: 'Claude Master' })
  expect(existsSync(agyFile)).toBe(false)

  // Now add a sleeping agy session with a same-shape UUID beside the sleeping Claude session:
  // /sleeping returns only Claude, /sleeping?agents=all returns both, and waking Claude leaves agy asleep.
  const agySleeper = {
    session: ID,
    name: 'Gemini Dev',
    pane: 'w5:p9',
    workspace: 'w5',
    workspaceLabel: 'Server',
    cwd: project,
    argv: ['agy'],
    slept_at: clock.at,
  }
  writeFileSync(agyFile, JSON.stringify({ [ID]: agySleeper }))
  expect((await engine.sleep(CLAUDE_ID)).ok).toBe(true)

  const mixed = createWakeEngine({
    herdr: io,
    homes: createProfileHomes(),
    profiles: () => profileSet([], claudeDir),
    settings: () => wakeConfig({ enabled: true, closePanes: false, wakeTimeoutSec: 10 }),
    sessionsFile,
    agyFile,
    agy: { ...throwingAgy, hasConversation: id => id === ID },
    boardOnPath: () => true,
    scheduled: async () => false,
    log: () => {},
    now: () => clock.at,
    sleep: async ms => {
      clock.at += ms
    },
  })
  expect((await mixed.sleeping()).map(s => s.session)).toEqual([CLAUDE_ID])
  const all = await mixed.sleepingAll()
  expect(all.map(s => [s.session, 'agent' in s ? s.agent : 'claude'])).toEqual([
    [CLAUDE_ID, 'claude'],
    [ID, 'agy'],
  ])
  expect(await mixed.wake(CLAUDE_ID)).toEqual({ ok: true, pane: 'w1:p1', name: 'Claude Master' })
  expect(await mixed.sleeping()).toEqual([])
  expect((await mixed.sleepingAll()).map(s => s.session)).toEqual([ID])
})

test('closes agy tab on sleep on win32 when closePanes is on, leaves pane open on linux, and restores tabLabel (#888)', async () => {
  const wLinux = world()
  wLinux.io.tabs.push(
    { tab_id: 't1', workspace_id: 'w5', label: '1', number: 1 },
    { tab_id: 't9', workspace_id: 'w5', label: 'Agy Tab', number: 2 },
  )
  wLinux.io.panes.push(
    { pane_id: 'w5:p1', tab_id: 't1', workspace_id: 'w5', cwd: wLinux.project, agent: 'claude' },
    { pane_id: 'w5:s9', tab_id: 't9', workspace_id: 'w5', cwd: wLinux.project, label: 'Sidebar' },
  )
  wLinux.io.screens['w5:p9'] = `PS ${wLinux.project}> `
  expect(await createWakeEngine({ ...wLinux.deps, platform: 'linux' }).sleep(ID)).toEqual({
    ok: true,
    pane: 'w5:p9',
    name: 'Gemini Dev',
  })
  expect(wLinux.io.calls.some(c => c[1] === 'close')).toBe(false)

  const w = world()
  w.io.tabs.push(
    { tab_id: 't1', workspace_id: 'w5', label: '1', number: 1 },
    { tab_id: 't9', workspace_id: 'w5', label: 'Agy Tab', number: 2 },
  )
  w.io.panes.push({ pane_id: 'w5:p1', tab_id: 't1', workspace_id: 'w5', cwd: w.project, agent: 'claude' }, {
    pane_id: 'w5:s9',
    tab_id: 't9',
    workspace_id: 'w5',
    cwd: w.project,
    label: 'Sidebar',
    tokens: { 'herdr-sidebar-git': '1' },
  } as FakePane)
  w.io.screens['w5:p9'] = `PS ${w.project}> `
  const engine = createWakeEngine({
    ...w.deps,
    platform: 'win32',
    processTable: async () => [{ pid: 4000, ppid: 1, bytes: 1024, name: 'pwsh' }],
  })
  expect(await engine.sleep(ID)).toEqual({ ok: true, pane: 'w5:p9', name: 'Gemini Dev' })
  expect(w.io.calls).toContainEqual(['tab', 'close', 't9'])
  expect(await engine.sleepingAll()).toMatchObject([{ agent: 'agy', session: ID, pane: '' }])

  const woke = await engine.wake(ID)
  expect(woke).toEqual({ ok: true, pane: 'w5:p20', name: 'Gemini Dev' })
  expect(w.tabs).toEqual([['tab', 'w5', w.project, 'Agy Tab']])
  expect(await engine.sleepingAll()).toEqual([])
})
