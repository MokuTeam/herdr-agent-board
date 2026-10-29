// #204: a Claude session put to sleep gives its pane back, and its tab when only herdr-sidebar's
// panes are beside it, and wakes in a new tab of its workspace under its tab's label. The wake
// engine against the in-memory fake herdr, a fake clock, a temp home with a Work profile, and fake
// new tabs; what follows the session from pane to pane recorded.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemRow } from '../../src/adapters/pane-facts.ts'
import { createProfileHomes } from '../../src/adapters/profile-homes.ts'
import { findProfileDirs } from '../../src/adapters/profiles.ts'
import { mergeProfiles, profileSet } from '../../src/core/profiles.ts'
import { wakeConfig } from '../../src/core/wake/config.ts'
import type { WakeSessions } from '../../src/core/wake/sessions.ts'
import { createWakeEngine, type WakeEngineDeps } from '../../src/services/wake/engine.ts'
import type { TabOps } from '../../src/services/wake/tabs.ts'
import { isolatedHome } from '../support/env.ts'
import { type FakePane, type FakeWakeHerdr, fakeWakeHerdr } from '../support/fake-wake-herdr.ts'
import { runningSession, SID, SID2 } from '../support/wake-fixtures.ts'

const PROJECT = process.platform === 'win32' ? 'C:\\Work\\Проект x 50%' : '/work/Проект x 50%'
const HOUR = 3_600_000
const RULE = `\x1b[38;2;136;136;136m${'─'.repeat(60)}\x1b[0m`
const EMPTY_BOX = ['● done', '', RULE, `❯ \x1b[2mTry "fix the tests"\x1b[0m`, RULE].join('\n')
/** What a pane shows once Claude has left: its resume hint, then the shell's empty prompt. */
const SHELL_SCREEN = `Resume this session with:\nclaude --resume ${SID}\nPS ${PROJECT}> `

const sidebar = (pane: string, tab: string, ws = 'w1'): FakePane & { tokens: Record<string, string> } => ({
  pane_id: pane,
  tab_id: tab,
  workspace_id: ws,
  cwd: PROJECT,
  label: 'Sidebar',
  tokens: { 'herdr-sidebar-git': '1' },
})
const claudePane = (pane: string, tab: string, session: string): FakePane => ({
  pane_id: pane,
  tab_id: tab,
  workspace_id: 'w1',
  cwd: PROJECT,
  agent: 'claude',
  agent_status: 'idle',
  agent_session: { value: session },
})
const shellPane = (pane: string, tab: string, label?: string): FakePane => ({
  pane_id: pane,
  tab_id: tab,
  workspace_id: 'w1',
  cwd: PROJECT,
  ...(label && { label }),
})

/**
 * Workspace "Main" with tab t1 ("1", the first) and t2 ("Billing"), each with a sidebar, plus
 * `panes`; the session file `sessions`; closePanes as `closePanes` says (on by default).
 */
function world(o: { panes?: FakePane[]; sessions?: (work: string) => WakeSessions; closePanes?: boolean } = {}) {
  const dir = isolatedHome()
  const home = join(dir, 'home')
  const claude = join(home, '.claude')
  const work = join(home, '.claude-work')
  for (const folder of [claude, work]) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'settings.json'), '{}')
  }
  const file = join(dir, 'state', 'wake-sessions.json')
  const sessions = o.sessions?.(work)
  if (sessions) {
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(file, JSON.stringify(sessions))
  }
  const panes = [sidebar('w1:s1', 't1'), sidebar('w1:s2', 't2'), ...(o.panes ?? [])]
  const io = fakeWakeHerdr({
    panes,
    workspaces: [{ workspace_id: 'w1', label: 'Main' }],
    tabs: [
      { tab_id: 't1', workspace_id: 'w1', label: '1', number: 1 },
      { tab_id: 't2', workspace_id: 'w1', label: 'Billing', number: 2 },
    ],
    inputBoxes: Object.fromEntries(panes.map(p => [p.pane_id, EMPTY_BOX])),
    screens: Object.fromEntries(panes.map(p => [p.pane_id, SHELL_SCREEN])),
  })
  const opened: string[][] = []
  let next = 1
  const fresh = (ws: string, tab: string, cwd: string): string => {
    const id = `${ws}:new${next++}`
    io.panes.push({ pane_id: id, tab_id: tab, workspace_id: ws, cwd })
    return id
  }
  const tabs: TabOps = {
    async newTab(ws, cwd, label) {
      opened.push(['tab', ws, cwd, label])
      const tab = `t${10 + next}`
      io.tabs.push({ tab_id: tab, workspace_id: ws, label, number: 10 + next })
      return fresh(ws, tab, cwd)
    },
    async newWorkspace(cwd, label, tabLabel) {
      opened.push(['workspace', cwd, label, tabLabel ?? ''])
      io.workspaces.push({ workspace_id: 'w9', label })
      io.tabs.push({ tab_id: 'w9:t1', workspace_id: 'w9', label: tabLabel ?? '1', number: 1 })
      return fresh('w9', 'w9:t1', cwd)
    },
    exists: () => true,
    home,
  }
  const follows: string[][] = []
  const set = profileSet(mergeProfiles(undefined, findProfileDirs(home), home, claude).list, claude)
  const settings = wakeConfig({ enabled: true, ...(o.closePanes === false && { closePanes: false }) })
  const tidyFile = join(dir, 'state', 'wake-tidy.json')
  const clock = { at: Date.now() }
  const log: string[] = []
  const archivedIds = new Set<string>()
  const table: MemRow[] = [{ pid: 4000, ppid: 1, bytes: 75 * 2 ** 20, name: 'pwsh' }]
  const deps: WakeEngineDeps = {
    herdr: io,
    homes: createProfileHomes(),
    profiles: () => set,
    settings: () => settings,
    sessionsFile: file,
    boardOnPath: () => true,
    scheduled: async () => false,
    log: text => void log.push(text),
    now: () => clock.at,
    sleep: async ms => {
      clock.at += ms
    },
    tabs,
    follow: {
      paneClosed: (s, p) => void follows.push(['closed', s, p]),
      paneOpened: (s, p) => void follows.push(['opened', s, p]),
    },
    archived: ids => new Set(ids.filter(id => archivedIds.has(id))),
    tidyFile,
    // The process table as wake reads it on Windows (#243): the fake's shells (pid 4000), nothing under them.
    processTable: async () => table,
  }
  return { dir, home, work, file, io, deps, opened, follows, log, clock, archivedIds, tidyFile, settings, table }
}

/** Claude leaves the pane on /exit, its registry entry with it. */
function exitsOnPrompt(io: FakeWakeHerdr, pane: FakePane, registry: string): void {
  io.on(
    argv => argv[1] === 'prompt' && argv[2] === pane.pane_id && argv[3] === '/exit',
    () => {
      pane.agent = null
      pane.agent_session = null
      delete pane.agent_status
      rmSync(registry, { force: true })
    },
  )
}

/** Claude comes up idle, registered in `dir`, in whichever pane `board resume <id>` runs. */
function startsOnRun(io: FakeWakeHerdr, dir: string, s: { id: string; name: string; n: number }) {
  io.on(
    argv => argv[0] === 'pane' && argv[1] === 'run' && (argv[3] ?? '').startsWith(`board resume ${s.id}`),
    argv => {
      const p = io.panes.find(x => x.pane_id === argv[2])
      if (!p) return
      p.agent = 'claude'
      p.agent_status = 'idle'
      p.agent_session = { value: s.id }
      io.busy.add(p.pane_id)
      runningSession(dir, { ...s, cwd: PROJECT })
    },
  )
}

const readSessions = (file: string): WakeSessions => JSON.parse(readFileSync(file, 'utf8'))
const closes = (io: FakeWakeHerdr): string[][] => io.calls.filter(c => c[1] === 'close')
const typed = (io: FakeWakeHerdr): string[][] =>
  io.calls.filter(c => c[0] === 'pane' && ['run', 'send-keys', 'send-text'].includes(c[1] ?? ''))

test('put to sleep in a tab of its own (a sidebar beside it): the tab closed, the sleeper kept by its session id', async () => {
  const pane = claudePane('w1:p2', 't2', SID)
  const w = world({ panes: [pane] })
  runningSession(w.work, { id: SID, name: 'Billing', cwd: PROJECT, n: 1 })
  exitsOnPrompt(w.io, pane, join(w.work, 'sessions', '1.json'))
  const engine = createWakeEngine(w.deps)

  expect(await engine.sleep('Billing')).toEqual({ ok: true, pane: 'w1:p2', name: 'Billing' })
  expect(closes(w.io)).toEqual([['tab', 'close', 't2']])
  expect(w.io.panes.map(p => p.pane_id)).toEqual(['w1:s1'])
  // Nothing typed into it, nothing renamed: it is gone.
  expect(typed(w.io)).toEqual([])
  const saved = readSessions(w.file)
  expect(Object.keys(saved)).toEqual([SID])
  expect(saved[SID]).toMatchObject({
    session: SID,
    name: 'Billing',
    cwd: PROJECT,
    profile: 'work',
    freed: {
      pane: 'w1:p2',
      workspace: 'w1',
      workspaceLabel: 'Main',
      tabLabel: 'Billing',
      topic: 'topic:Main / Billing',
    },
  })
  expect(w.follows).toEqual([['closed', SID, 'w1:p2']])
  expect(await engine.sleeping()).toMatchObject([
    { name: 'Billing', pane: '', session: SID, workspace: 'Main', cwd: PROJECT, profile: { id: 'work' } },
  ])
})

test('a tab with the user’s pane beside it keeps it: only the sleeper’s pane goes', async () => {
  const pane = claudePane('w1:p2', 't2', SID)
  const w = world({ panes: [pane, shellPane('w1:p3', 't2')] })
  runningSession(w.work, { id: SID, name: 'Billing', cwd: PROJECT, n: 1 })
  exitsOnPrompt(w.io, pane, join(w.work, 'sessions', '1.json'))
  const engine = createWakeEngine(w.deps)

  expect(await engine.sleep(SID)).toMatchObject({ ok: true })
  expect(closes(w.io)).toEqual([['pane', 'close', 'w1:p2']])
  expect(w.io.panes.map(p => p.pane_id)).toEqual(['w1:s1', 'w1:s2', 'w1:p3'])
})

test('kept as before: the workspace’s first tab with others beside it, closePanes off, a shell that runs something', async () => {
  const cases: { o: Parameters<typeof world>[0]; pane: FakePane; busy?: true }[] = [
    { o: {}, pane: claudePane('w1:p1', 't1', SID) },
    { o: { closePanes: false }, pane: claudePane('w1:p2', 't2', SID) },
    { o: {}, pane: claudePane('w1:p2', 't2', SID), busy: true },
  ]
  for (const { o, pane, busy } of cases) {
    const w = world({ ...o, panes: [pane] })
    runningSession(w.work, { id: SID, name: 'Billing', cwd: PROJECT, n: 1 })
    exitsOnPrompt(w.io, pane, join(w.work, 'sessions', '1.json'))
    // Something started in the shell as Claude left: a pane that runs a program is not closed.
    if (busy)
      w.io.on(
        argv => argv[3] === '/exit',
        () => void w.io.busy.add(pane.pane_id),
      )
    const engine = createWakeEngine(w.deps)

    expect(await engine.sleep(SID)).toMatchObject({ ok: true, pane: pane.pane_id })
    expect(closes(w.io)).toEqual([])
    expect(pane.label).toBe('💤 Billing')
    expect(readSessions(w.file)[pane.pane_id]).not.toHaveProperty('freed')
    expect(w.follows).toEqual([])
  }
})

test('woken: a new tab of its workspace under its tab’s label, the line run there, the sleeper moved to that pane', async () => {
  const at = Date.now() - HOUR
  const w = world({
    sessions: work => ({
      [SID]: {
        session: SID,
        name: 'Billing',
        cwd: PROJECT,
        seen_at: at,
        slept_at: at,
        profileDir: work,
        profile: 'work',
        freed: {
          pane: 'w1:p2',
          workspace: 'w1',
          workspaceLabel: 'Main',
          tabLabel: 'Billing',
          topic: 'topic:Main / Billing',
          at,
        },
      },
    }),
  })
  startsOnRun(w.io, w.work, { id: SID, name: 'Billing', n: 1 })
  const engine = createWakeEngine(w.deps)

  expect(await engine.wake('Billing')).toEqual({ ok: true, pane: 'w1:new1', name: 'Billing' })
  expect(w.opened).toEqual([['tab', 'w1', PROJECT, 'Billing']])
  // A fresh shell: no clear key, the line as it is.
  expect(typed(w.io)).toEqual([['pane', 'run', 'w1:new1', `board resume ${SID} --profile work`]])
  const saved = readSessions(w.file)
  expect(Object.keys(saved)).toEqual(['w1:new1'])
  expect(saved['w1:new1']).not.toHaveProperty('slept_at')
  expect(saved['w1:new1']).not.toHaveProperty('freed')
  expect(w.follows).toEqual([['opened', SID, 'w1:new1']])
  expect(await engine.wake('Billing')).toEqual({ ok: true, pane: 'w1:new1', name: 'Billing', already: true })
})

test('its workspace gone too: a new workspace of its label, its tab under the old tab’s label', async () => {
  const at = Date.now() - HOUR
  const w = world({
    sessions: work => ({
      [SID]: {
        session: SID,
        name: 'Solo',
        cwd: PROJECT,
        seen_at: at,
        slept_at: at,
        profileDir: work,
        profile: 'work',
        freed: {
          pane: 'w5:p1',
          workspace: 'w5',
          workspaceLabel: 'Solo work',
          tabLabel: 'main',
          topic: 'topic:Solo work',
          at,
        },
      },
    }),
  })
  startsOnRun(w.io, w.work, { id: SID, name: 'Solo', n: 1 })
  const engine = createWakeEngine(w.deps)

  expect(await engine.wake(SID)).toMatchObject({ ok: true, pane: 'w9:new1' })
  expect(w.opened).toEqual([['workspace', PROJECT, 'Solo work', 'main']])
})

test('not up in time: it sleeps on in the new pane, 💤, woken there next time', async () => {
  const at = Date.now() - HOUR
  const w = world({
    sessions: work => ({
      [SID]: {
        session: SID,
        name: 'Billing',
        seen_at: at,
        slept_at: at,
        profileDir: work,
        profile: 'work',
        freed: { pane: 'w1:p2', workspace: 'w1', topic: '', at },
      },
    }),
  })
  const engine = createWakeEngine(w.deps)

  expect(await engine.wake('Billing')).toMatchObject({ ok: false })
  const saved = readSessions(w.file)
  expect(Object.keys(saved)).toEqual(['w1:new1'])
  expect(saved['w1:new1']).toMatchObject({ session: SID, slept_at: at })
  expect(w.io.panes.find(p => p.pane_id === 'w1:new1')?.label).toBe('💤 Billing')
  startsOnRun(w.io, w.work, { id: SID, name: 'Billing', n: 1 })
  expect(await engine.wake('Billing')).toEqual({ ok: true, pane: 'w1:new1', name: 'Billing' })
  expect(w.opened).toHaveLength(1)
})

test('Telegram: the router’s pick is its session id; wakePane opens the tab and says where', async () => {
  const at = Date.now() - HOUR
  const w = world({
    sessions: work => ({
      [SID]: {
        session: SID,
        name: 'Billing',
        seen_at: at,
        slept_at: at,
        profileDir: work,
        profile: 'work',
        freed: { pane: 'w1:p2', workspace: 'w1', tabLabel: 'Billing', topic: 'topic:Main / Billing', at },
      },
    }),
  })
  startsOnRun(w.io, w.work, { id: SID, name: 'Billing', n: 1 })
  const engine = createWakeEngine(w.deps)

  const { sessions } = await engine.seen()
  expect(sessions[SID]?.freed?.topic).toBe('topic:Main / Billing')
  expect(await engine.wakePane(SID)).toEqual({ ok: true, pane: 'w1:new1' })
})

test('once per start, a session asleep in a pane kept before is given it back; an exited one, a busy one and another’s pane are not', async () => {
  const at = Date.now() - HOUR
  const entry = (session: string, name: string, more: Record<string, unknown> = {}) => ({
    session,
    name,
    seen_at: at,
    slept_at: at,
    ...more,
  })
  const kept = shellPane('w1:p2', 't2', '💤 Billing')
  const w = world({
    panes: [
      kept,
      shellPane('w1:p4', 't4', '💤 Exited'),
      shellPane('w1:p5', 't5', '💤 Busy'),
      shellPane('w1:p6', 't6', 'my shell'),
      shellPane('w1:p1', 't1', '💤 First'),
    ],
    sessions: () => ({
      'w1:p2': entry(SID, 'Billing'),
      'w1:p4': entry(SID2, 'Exited', { exited: true }),
      'w1:p5': entry('1b2c3d4e-5f60-4718-8a9b-c0d1e2f3a4b5', 'Busy'),
      'w1:p6': entry('2c3d4e5f-6071-4829-9bac-d1e2f3a4b5c6', 'Renamed'),
      'w1:p1': entry('3d4e5f60-7182-4930-acbd-e2f3a4b5c6d7', 'First'),
    }),
  })
  for (const t of ['t4', 't5', 't6'])
    w.io.tabs.push({ tab_id: t, workspace_id: 'w1', label: t, number: Number(t.slice(1)) })
  w.io.busy.add('w1:p5')
  const engine = createWakeEngine(w.deps)

  await engine.remember()
  expect(closes(w.io)).toEqual([['tab', 'close', 't2']])
  expect(Object.keys(readSessions(w.file)).sort()).toEqual([SID, 'w1:p1', 'w1:p4', 'w1:p5', 'w1:p6'].sort())
  expect(readSessions(w.file)[SID]?.freed).toMatchObject({ pane: 'w1:p2', tabLabel: 'Billing' })
  // Not again: a pane labelled so later is the user's to close.
  w.io.panes.push(shellPane('w1:p7', 't2', '💤 Billing'))
  await engine.remember()
  expect(closes(w.io)).toHaveLength(1)
})

test('no tidy with closePanes off', async () => {
  const at = Date.now() - HOUR
  const w = world({
    closePanes: false,
    panes: [shellPane('w1:p2', 't2', '💤 Billing')],
    sessions: () => ({ 'w1:p2': { session: SID, name: 'Billing', seen_at: at, slept_at: at } }),
  })
  await createWakeEngine(w.deps).remember()
  expect(closes(w.io)).toEqual([])
})

test('put in the archive meanwhile: no longer asleep', async () => {
  const at = Date.now() - HOUR
  const w = world({
    sessions: () => ({
      [SID]: { session: SID, name: 'Billing', seen_at: at, slept_at: at, freed: { pane: 'w1:p2', topic: '', at } },
      [SID2]: { session: SID2, name: 'Other', seen_at: at, slept_at: at, freed: { pane: 'w1:p3', topic: '', at } },
    }),
  })
  const engine = createWakeEngine(w.deps)
  w.archivedIds.add(SID)
  await engine.remember()
  expect(Object.keys(readSessions(w.file))).toEqual([SID2])
  expect((await engine.sleeping()).map(s => s.name)).toEqual(['Other'])
})

test('two wakes at once (the board and a SendMessage): one new tab, both told where it woke', async () => {
  const at = Date.now() - HOUR
  const w = world({
    sessions: work => ({
      [SID]: {
        session: SID,
        name: 'Billing',
        cwd: PROJECT,
        seen_at: at,
        slept_at: at,
        profileDir: work,
        profile: 'work',
        freed: { pane: 'w1:p2', workspace: 'w1', tabLabel: 'Billing', topic: 'topic:Main / Billing', at },
      },
    }),
  })
  startsOnRun(w.io, w.work, { id: SID, name: 'Billing', n: 1 })
  const engine = createWakeEngine(w.deps)

  const both = await Promise.all([engine.wake('Billing'), engine.wake(SID), engine.wakePane(SID)])
  expect(both.map(r => r.ok && 'pane' in r && r.pane)).toEqual(['w1:new1', 'w1:new1', 'w1:new1'])
  expect(w.opened).toHaveLength(1)
  expect(typed(w.io).filter(c => c[1] === 'run')).toHaveLength(1)
})

/** A sleep of `pane`'s session, Claude leaving on /exit, its registry entry in Work. */
async function sleepIn(w: ReturnType<typeof world>, pane: FakePane, session: string, name: string, n: number) {
  runningSession(w.work, { id: session, name, cwd: PROJECT, n })
  exitsOnPrompt(w.io, pane, join(w.work, 'sessions', `${n}.json`))
  return createWakeEngine(w.deps).sleep(session)
}

test('review: a close that takes effect and then fails (a timeout) keeps the sleeper, by its session id', async () => {
  const pane = claudePane('w1:p2', 't2', SID)
  const w = world({ panes: [pane] })
  const close = w.io.closeTab
  w.io.closeTab = async tab => {
    await close(tab)
    throw new Error('herdr tab close: timed out')
  }
  expect(await sleepIn(w, pane, SID, 'Billing', 1)).toMatchObject({ ok: true })
  expect(Object.keys(readSessions(w.file))).toEqual([SID])
  expect(readSessions(w.file)[SID]?.freed?.pane).toBe('w1:p2')
  expect(w.log.some(l => l.includes('timed out'))).toBe(true)
})

test('review: a close that fails with the pane still there: back under its pane, 💤, its line typed', async () => {
  const pane = claudePane('w1:p2', 't2', SID)
  const w = world({ panes: [pane] })
  w.io.closeTab = async () => {
    throw new Error('herdr tab close: refused')
  }
  expect(await sleepIn(w, pane, SID, 'Billing', 1)).toMatchObject({ ok: true })
  const saved = readSessions(w.file)
  expect(Object.keys(saved)).toEqual(['w1:p2'])
  expect(saved['w1:p2']).not.toHaveProperty('freed')
  expect(pane.label).toBe('💤 Billing')
  expect(typed(w.io).at(-1)).toEqual(['pane', 'send-text', 'w1:p2', `board resume ${SID} --profile work`])
})

test('review: nothing is closed in the tab the user looks at', async () => {
  const pane = claudePane('w1:p2', 't2', SID)
  const w = world({ panes: [pane] })
  const side = w.io.panes.find(p => p.pane_id === 'w1:s2')
  if (side) side.focused = true
  expect(await sleepIn(w, pane, SID, 'Billing', 1)).toMatchObject({ ok: true })
  expect(closes(w.io)).toEqual([])
  expect(pane.label).toBe('💤 Billing')
})

test('review: a workspace another sleeper comes back to is not closed with its last tab (the topics would swap)', async () => {
  const master = claudePane('w1:p1', 't1', SID2)
  const billing = claudePane('w1:p2', 't2', SID)
  const w = world({ panes: [master, billing] })
  // Billing's tab goes: Master's is the workspace's only tab now.
  expect(await sleepIn(w, billing, SID, 'Billing', 1)).toMatchObject({ ok: true })
  expect(closes(w.io)).toEqual([['tab', 'close', 't2']])
  expect(await sleepIn(w, master, SID2, 'Master', 2)).toMatchObject({ ok: true })
  expect(closes(w.io)).toHaveLength(1)
  expect(master.label).toBe('💤 Master')
  expect(Object.keys(readSessions(w.file)).sort()).toEqual([SID, 'w1:p1'].sort())
})

test('review: alone in its workspace, nobody else coming back there: the tab goes, and the workspace with it', async () => {
  const pane = claudePane('w1:p1', 't1', SID)
  const w = world({ panes: [pane] })
  w.io.tabs.splice(1, 1)
  w.io.panes.splice(
    w.io.panes.findIndex(p => p.pane_id === 'w1:s2'),
    1,
  )
  expect(await sleepIn(w, pane, SID, 'Solo', 1)).toMatchObject({ ok: true })
  expect(closes(w.io)).toEqual([['tab', 'close', 't1']])
  expect(w.io.workspaces).toEqual([])
  expect(readSessions(w.file)[SID]?.freed).toMatchObject({ workspaceLabel: 'Main', topic: 'topic:Main' })
})

test('review: a sidebar whose tokens have expired is still a sidebar: the tab goes with it', async () => {
  const pane = claudePane('w1:p2', 't2', SID)
  const w = world({ panes: [pane] })
  const side = w.io.panes.find(p => p.pane_id === 'w1:s2') as FakePane & { tokens?: unknown }
  delete side.tokens
  expect(await sleepIn(w, pane, SID, 'Billing', 1)).toMatchObject({ ok: true })
  expect(closes(w.io)).toEqual([['tab', 'close', 't2']])
})

test('review: the tidy leaves a kept shell with something typed in it, runs under way, and is done once for good', async () => {
  const at = Date.now() - HOUR
  const typedIn = shellPane('w1:p2', 't2', '💤 Billing')
  const waking = shellPane('w1:p4', 't4', '💤 Ledger')
  const SID3 = '1b2c3d4e-5f60-4718-8a9b-c0d1e2f3a4b5'
  const sessions = () => ({
    'w1:p2': { session: SID, name: 'Billing', seen_at: at, slept_at: at },
    'w1:p4': { session: SID3, name: 'Ledger', seen_at: at, slept_at: at },
  })
  const w = world({ panes: [typedIn, waking], sessions })
  w.io.tabs.push({ tab_id: 't4', workspace_id: 'w1', label: 'Ledger', number: 4 })
  w.io.screens['w1:p2'] = `PS ${PROJECT}> board resume ${SID}\nPS ${PROJECT}> cd ..`
  w.io.screens['w1:p4'] = `PS ${PROJECT}> board resume ${SID3} --profile work`
  const engine = createWakeEngine(w.deps)
  const busy: number[] = []
  w.io.on(
    argv => argv[1] === 'close',
    () => void busy.push(engine.busy()),
  )

  await engine.remember()
  expect(closes(w.io)).toEqual([['tab', 'close', 't4']])
  expect(busy).toEqual([1])
  expect(existsSync(w.tidyFile)).toBe(true)
  // Wake started again (a code change): not again, even for a pane that would go now.
  w.io.screens['w1:p2'] = `PS ${PROJECT}> `
  await createWakeEngine(w.deps).remember()
  expect(closes(w.io)).toHaveLength(1)
})

test('review: with closePanes off the tidy waits, unmarked, until it is turned on', async () => {
  const at = Date.now() - HOUR
  const w = world({
    closePanes: false,
    panes: [shellPane('w1:p2', 't2', '💤 Billing')],
    sessions: () => ({ 'w1:p2': { session: SID, name: 'Billing', seen_at: at, slept_at: at } }),
  })
  await createWakeEngine(w.deps).remember()
  expect(existsSync(w.tidyFile)).toBe(false)
  const on = { ...w.deps, settings: () => wakeConfig({ enabled: true }) }
  await createWakeEngine(on).remember()
  expect(closes(w.io)).toEqual([['tab', 'close', 't2']])
  expect(existsSync(w.tidyFile)).toBe(true)
})

test('re-review: herdr still answering once for the pane it just closed does not put the sleeper back under it', async () => {
  const pane = claudePane('w1:p2', 't2', SID)
  const w = world({ panes: [pane] })
  const get = w.io.pane
  let stale = 0
  w.io.on(
    argv => argv[1] === 'close',
    () => {
      stale = 1
    },
  )
  w.io.pane = async id => {
    if (stale > 0 && id === 'w1:p2') {
      stale--
      return { pane_id: 'w1:p2', tab_id: 't2', workspace_id: 'w1' }
    }
    return get(id)
  }
  expect(await sleepIn(w, pane, SID, 'Billing', 1)).toMatchObject({ ok: true })
  expect(Object.keys(readSessions(w.file))).toEqual([SID])
  expect(await createWakeEngine(w.deps).sleeping()).toMatchObject([{ name: 'Billing', pane: '' }])
})

test('re-review: no tidy marker while herdr shows no panes, or answers for none of those to look at; it tries again', async () => {
  const at = Date.now() - HOUR
  const kept = shellPane('w1:p2', 't2', '💤 Billing')
  const w = world({
    panes: [kept],
    sessions: () => ({ 'w1:p2': { session: SID, name: 'Billing', seen_at: at, slept_at: at } }),
  })
  const engine = createWakeEngine(w.deps)
  // herdr starting over: a snapshot without panes.
  const snapshot = w.io.snapshot
  w.io.snapshot = async () => ({ ...(await snapshot()), panes: [] })
  await engine.remember()
  expect(existsSync(w.tidyFile)).toBe(false)
  // Panes shown, but herdr fails on every question about them.
  w.io.snapshot = snapshot
  const info = w.io.processInfo
  w.io.processInfo = async () => {
    throw new Error('herdr: not answering')
  }
  await engine.remember()
  expect(existsSync(w.tidyFile)).toBe(false)
  expect(closes(w.io)).toEqual([])
  // herdr back: done, and marked.
  w.io.processInfo = info
  await engine.remember()
  expect(closes(w.io)).toEqual([['tab', 'close', 't2']])
  expect(existsSync(w.tidyFile)).toBe(true)
})

// ------------------------------------------------------------------ #243: kept sleepers looked at again

/** A world on a machine whose one-time tidy (#207) is done: what a look does after that. */
function afterTidy(o: Parameters<typeof world>[0]) {
  const w = world(o)
  mkdirSync(join(w.dir, 'state'), { recursive: true })
  writeFileSync(w.tidyFile, '{"at":1}\n')
  return w
}
const ASLEEP_AT = Date.now() - HOUR
/** A session asleep in a pane wake kept, in the Work profile. */
const asleep = (work: string, session: string, name: string, more: Record<string, unknown> = {}) => ({
  session,
  name,
  seen_at: ASLEEP_AT,
  slept_at: ASLEEP_AT,
  profileDir: work,
  profile: 'work',
  ...more,
})
const withTerminal = (p: FakePane, terminal: string): FakePane => ({ ...p, terminal_id: terminal })
/** What a sleep leaves at a kept pane's prompt: its wake line, typed and not run. */
const lineScreen = (id: string): string => `${SHELL_SCREEN}board resume ${id} --profile work`
/** The questions about a pane's shell: its screen, its processes. */
const asked = (io: FakeWakeHerdr, pane: string): string[][] =>
  io.calls.filter(c => c.includes(pane) && (c[1] === 'read' || c[1] === 'process-info'))
const SID3 = '1b2c3d4e-5f60-4718-8a9b-c0d1e2f3a4b5'

test('#243: kept while its tab was looked at, its pane goes once the user looks elsewhere, its wake line still there', async () => {
  const w = afterTidy({
    panes: [withTerminal(shellPane('w1:p2', 't2', '💤 Billing'), 'term-a')],
    sessions: work => ({ 'w1:p2': asleep(work, SID, 'Billing') }),
  })
  w.io.screens['w1:p2'] = lineScreen(SID)
  const side = w.io.panes.find(p => p.pane_id === 'w1:s2') as FakePane
  side.focused = true
  const engine = createWakeEngine(w.deps)

  await engine.remember()
  expect(closes(w.io)).toEqual([])
  // The user looks at its tab: its screen is not even read. Its terminal and its shell's process
  // are noted the first time it is seen asleep (one question to herdr, once).
  expect(asked(w.io, 'w1:p2')).toEqual([['pane', 'process-info', '--pane', 'w1:p2']])
  expect(readSessions(w.file)['w1:p2']).toMatchObject({ terminal: 'term-a', shellPid: 4000 })
  await engine.remember()
  expect(asked(w.io, 'w1:p2')).toHaveLength(1)

  side.focused = false
  await engine.remember()
  expect(closes(w.io)).toEqual([['tab', 'close', 't2']])
  expect(readSessions(w.file)[SID]?.freed).toMatchObject({ pane: 'w1:p2', tabLabel: 'Billing' })
  expect(w.follows).toEqual([['closed', SID, 'w1:p2']])
  expect(w.log).toContain('Billing: gave back the pane w1:p2 it slept in')
})

test('#243: the same shell at an empty prompt (the user may have run something there) stays, and is not asked again', async () => {
  const w = afterTidy({
    panes: [withTerminal(shellPane('w1:p2', 't2', '💤 Billing'), 'term-a')],
    sessions: work => ({ 'w1:p2': asleep(work, SID, 'Billing', { terminal: 'term-a' }) }),
  })
  w.io.screens['w1:p2'] = `${lineScreen(SID)}\nPS ${PROJECT}> git status\nOn branch main\nPS ${PROJECT}> `
  const engine = createWakeEngine(w.deps)

  await engine.remember()
  expect(closes(w.io)).toEqual([])
  expect(typed(w.io)).toEqual([])
  const once = asked(w.io, 'w1:p2').length
  expect(once).toBeGreaterThan(0)
  await engine.remember()
  expect(asked(w.io, 'w1:p2')).toHaveLength(once)
  expect(readSessions(w.file)['w1:p2']).toMatchObject({ slept_at: ASLEEP_AT, terminal: 'term-a' })
})

test('#243: a pane herdr restored after starting over (a new terminal) at an empty prompt goes', async () => {
  const w = afterTidy({
    panes: [withTerminal(shellPane('w1:p2', 't2', '💤 Счета 100% x'), 'term-b')],
    sessions: work => ({ 'w1:p2': asleep(work, SID, 'Счета 100% x', { terminal: 'term-a' }) }),
  })
  // A fresh shell: its prompt, no wake line.
  w.io.screens['w1:p2'] = `PS ${PROJECT}> `
  await createWakeEngine(w.deps).remember()
  expect(closes(w.io)).toEqual([['tab', 'close', 't2']])
  expect(Object.keys(readSessions(w.file))).toEqual([SID])
  expect(typed(w.io)).toEqual([])
})

test('#243: restored but kept by its place: its wake line typed again, the new terminal noted, given back once its place allows', async () => {
  const w = afterTidy({
    panes: [withTerminal(shellPane('w1:p1', 't1', '💤 Master'), 'term-b')],
    sessions: work => ({ 'w1:p1': asleep(work, SID, 'Master', { terminal: 'term-a' }) }),
  })
  w.io.screens['w1:p1'] = `PS ${PROJECT}> `
  const engine = createWakeEngine(w.deps)

  // The workspace's first tab, with Billing's beside it: it stays, as a sleep leaves it.
  await engine.remember()
  expect(closes(w.io)).toEqual([])
  expect(typed(w.io)).toEqual([['pane', 'send-text', 'w1:p1', `board resume ${SID} --profile work`]])
  // Who looks at its tab is asked last, right before the typing (review round 2).
  const at = w.io.calls.findIndex(c => c[1] === 'send-text')
  expect(w.io.calls.slice(at - 2, at + 1).map(c => c.slice(0, 2).join(' '))).toEqual([
    'pane process-info',
    'api snapshot',
    'pane send-text',
  ])
  expect(readSessions(w.file)['w1:p1']?.terminal).toBe('term-b')
  w.io.screens['w1:p1'] = `PS ${PROJECT}> board resume ${SID} --profile work`
  const once = asked(w.io, 'w1:p1').length
  await engine.remember()
  expect(asked(w.io, 'w1:p1')).toHaveLength(once)

  // The user closes Billing's tab: it is the workspace's only tab now, and nobody comes back there.
  w.io.tabs.splice(
    w.io.tabs.findIndex(t => t.tab_id === 't2'),
    1,
  )
  w.io.panes.splice(
    w.io.panes.findIndex(p => p.pane_id === 'w1:s2'),
    1,
  )
  await engine.remember()
  expect(closes(w.io)).toEqual([['tab', 'close', 't1']])
  expect(readSessions(w.file)[SID]?.freed).toMatchObject({ pane: 'w1:p1', workspaceLabel: 'Main', topic: 'topic:Main' })
})

test('#243: a restored shell that shows no prompt yet is asked again at the next look; one that never does is left after a few', async () => {
  const w = afterTidy({
    panes: [
      withTerminal(shellPane('w1:p2', 't2', '💤 Billing'), 'term-b'),
      withTerminal(shellPane('w1:p4', 't4', '💤 Ledger'), 'term-d'),
    ],
    sessions: work => ({
      'w1:p2': asleep(work, SID, 'Billing', { terminal: 'term-a' }),
      'w1:p4': asleep(work, SID2, 'Ledger', { terminal: 'term-c' }),
    }),
  })
  w.io.tabs.push({ tab_id: 't4', workspace_id: 'w1', label: 'Ledger', number: 4 })
  w.io.screens['w1:p2'] = ''
  w.io.screens['w1:p4'] = ''
  const engine = createWakeEngine(w.deps)

  await engine.remember()
  expect(closes(w.io)).toEqual([])
  expect(readSessions(w.file)['w1:p2']?.terminal).toBe('term-a')
  // Its shell is up now.
  w.io.screens['w1:p2'] = `PS ${PROJECT}> `
  await engine.remember()
  expect(closes(w.io)).toEqual([['tab', 'close', 't2']])

  // Ledger's never shows a prompt: asked at every look for ten minutes, then left, its terminal noted.
  for (let minutes = 0; minutes < 9; minutes++) {
    w.clock.at += 60_000
    await engine.remember()
  }
  expect(readSessions(w.file)['w1:p4']?.terminal).toBe('term-c')
  w.clock.at += 61_000
  await engine.remember()
  expect(readSessions(w.file)['w1:p4']?.terminal).toBe('term-d')
  expect(w.log).toContain('Ledger: kept in the pane w1:p4 herdr gave a new terminal')
  const reads = asked(w.io, 'w1:p4').length
  await engine.remember()
  expect(asked(w.io, 'w1:p4')).toHaveLength(reads)
  expect(closes(w.io)).toHaveLength(1)
})

test('#243: a session the user exited: never in the same shell; restored, given back, and nothing typed where it stays', async () => {
  const w = afterTidy({
    panes: [
      withTerminal(shellPane('w1:p2', 't2', '💤 Billing'), 'term-a'),
      withTerminal(shellPane('w1:p4', 't4', '💤 Ledger'), 'term-d'),
      withTerminal(shellPane('w1:p1', 't1', '💤 Master'), 'term-f'),
    ],
    sessions: work => ({
      'w1:p2': asleep(work, SID, 'Billing', { exited: true, terminal: 'term-a' }),
      'w1:p4': asleep(work, SID2, 'Ledger', { exited: true, terminal: 'term-c' }),
      'w1:p1': asleep(work, SID3, 'Master', { exited: true, terminal: 'term-e' }),
    }),
  })
  w.io.tabs.push({ tab_id: 't4', workspace_id: 'w1', label: 'Ledger', number: 4 })
  for (const pane of ['w1:p2', 'w1:p4', 'w1:p1']) w.io.screens[pane] = `PS ${PROJECT}> `
  await createWakeEngine(w.deps).remember()
  expect(closes(w.io)).toEqual([['tab', 'close', 't4']])
  // The user is likely at the prompt of the one in the same shell: not even asked.
  expect(asked(w.io, 'w1:p2')).toEqual([])
  // Master, restored in the first tab, stays: no wake line typed where the user exited it.
  expect(typed(w.io)).toEqual([])
  expect(readSessions(w.file)['w1:p1']).toMatchObject({ exited: true, terminal: 'term-f' })
})

test('#243: restored with something at its prompt, or a program running: kept as it is, nothing typed', async () => {
  const w = afterTidy({
    panes: [
      withTerminal(shellPane('w1:p2', 't2', '💤 Billing'), 'term-b'),
      withTerminal(shellPane('w1:p4', 't4', '💤 Ledger'), 'term-d'),
    ],
    sessions: work => ({
      'w1:p2': asleep(work, SID, 'Billing', { terminal: 'term-a' }),
      'w1:p4': asleep(work, SID2, 'Ledger', { terminal: 'term-c' }),
    }),
  })
  w.io.tabs.push({ tab_id: 't4', workspace_id: 'w1', label: 'Ledger', number: 4 })
  w.io.screens['w1:p2'] = `PS ${PROJECT}> cd ..`
  w.io.screens['w1:p4'] = `PS ${PROJECT}> `
  w.io.busy.add('w1:p4')
  const engine = createWakeEngine(w.deps)

  await engine.remember()
  expect(closes(w.io)).toEqual([])
  expect(typed(w.io)).toEqual([])
  expect(readSessions(w.file)['w1:p2']?.terminal).toBe('term-b')
  expect(readSessions(w.file)['w1:p4']?.terminal).toBe('term-d')
  const before = asked(w.io, 'w1:p2').length + asked(w.io, 'w1:p4').length
  await engine.remember()
  expect(asked(w.io, 'w1:p2').length + asked(w.io, 'w1:p4').length).toBe(before)
})

test('#243: a pane-<id> key (another agent’s session) is never looked at, restored or not', async () => {
  const w = afterTidy({
    panes: [withTerminal(shellPane('w1:p2', 't2', '💤 Codex'), 'term-b')],
    sessions: work => ({ 'w1:p2': asleep(work, 'pane-w1:p2', 'Codex', { terminal: 'term-a' }) }),
  })
  w.io.screens['w1:p2'] = `PS ${PROJECT}> `
  await createWakeEngine(w.deps).remember()
  expect(asked(w.io, 'w1:p2')).toEqual([])
  expect(closes(w.io)).toEqual([])
})

test('#243: with closePanes off nothing is asked and nothing noted, as before', async () => {
  const w = afterTidy({
    closePanes: false,
    panes: [
      withTerminal(shellPane('w1:p2', 't2', '💤 Billing'), 'term-b'),
      withTerminal(shellPane('w1:p4', 't2', '💤 Ledger'), 'term-c'),
    ],
    sessions: work => ({
      'w1:p2': asleep(work, SID, 'Billing', { terminal: 'term-a' }),
      'w1:p4': asleep(work, SID2, 'Ledger'),
    }),
  })
  w.io.screens['w1:p2'] = `PS ${PROJECT}> `
  const saved = readFileSync(w.file, 'utf8')
  await createWakeEngine(w.deps).remember()
  expect(w.io.calls).toEqual([['api', 'snapshot']])
  expect(readFileSync(w.file, 'utf8')).toBe(saved)
})

// ------------------------------------------------------------------ #243, review: what a restored shell must show

/** A sleeper in Billing's tab whose pane herdr gave a new terminal, its screen `screen`. */
function restoredBilling(screen: string, more: Record<string, unknown> = {}) {
  const w = afterTidy({
    panes: [withTerminal(shellPane('w1:p2', 't2', '💤 Billing'), 'term-b')],
    sessions: work => ({ 'w1:p2': asleep(work, SID, 'Billing', { terminal: 'term-a', ...more }) }),
  })
  w.io.screens['w1:p2'] = screen
  return w
}

test('#243 review: a restored shell the user ran something in stays, its prompt empty again or not', async () => {
  for (const screen of [
    // git status ran: an empty prompt again, two prompt rows.
    `PS ${PROJECT}> git status\nOn branch main\nPS ${PROJECT}> `,
    // ssh: the remote shell's prompt reads as an empty one, and herdr lists no program in front of
    // the shell, as on Windows (nothing in the fake's busy set).
    `PS ${PROJECT}> ssh prod\nLast login: Thu Oct 29\nroot@prod:~# `,
    // node's REPL.
    `PS ${PROJECT}> node\nWelcome to Node.js v22.\n> `,
  ]) {
    const w = restoredBilling(screen)
    await createWakeEngine(w.deps).remember()
    expect([screen, closes(w.io), typed(w.io)]).toEqual([screen, [], []])
    expect(readSessions(w.file)['w1:p2']?.terminal).toBe('term-b')
  }
})

test('#243 review: a handoff (a new terminal, the same shell): judged as its own shell, an empty prompt is not enough', async () => {
  // The fake's shells all have pid 4000: the one noted is the one there now.
  const cleared = restoredBilling(`PS ${PROJECT}> `, { shellPid: 4000 })
  await createWakeEngine(cleared.deps).remember()
  expect(closes(cleared.io)).toEqual([])
  expect(typed(cleared.io)).toEqual([])
  expect(readSessions(cleared.file)['w1:p2']).toMatchObject({ terminal: 'term-b', shellPid: 4000 })

  // Its wake line still there, as the sleep left it: given back, as in its own terminal.
  const kept = restoredBilling(lineScreen(SID), { shellPid: 4000 })
  await createWakeEngine(kept.deps).remember()
  expect(closes(kept.io)).toEqual([['tab', 'close', 't2']])

  // Another shell process than the one noted: restored after all.
  const fresh = restoredBilling(`PS ${PROJECT}> `, { shellPid: 3999 })
  await createWakeEngine(fresh.deps).remember()
  expect(closes(fresh.io)).toEqual([['tab', 'close', 't2']])
})

test('#243 review: nothing typed, nor even read, while the user looks at the pane or its tab; judged once they look elsewhere', async () => {
  for (const focus of ['w1:p1', 'w1:s1'] as const) {
    const w = afterTidy({
      panes: [withTerminal(shellPane('w1:p1', 't1', '💤 Master'), 'term-b')],
      sessions: work => ({ 'w1:p1': asleep(work, SID, 'Master', { terminal: 'term-a' }) }),
    })
    w.io.screens['w1:p1'] = `PS ${PROJECT}> `
    const looked = w.io.panes.find(p => p.pane_id === focus) as FakePane
    looked.focused = true
    const engine = createWakeEngine(w.deps)
    for (let i = 0; i < 3; i++) await engine.remember()
    expect([focus, asked(w.io, 'w1:p1'), typed(w.io)]).toEqual([focus, [], []])
    expect(readSessions(w.file)['w1:p1']?.terminal).toBe('term-a')

    looked.focused = false
    await engine.remember()
    expect(typed(w.io)).toEqual([['pane', 'send-text', 'w1:p1', `board resume ${SID} --profile work`]])
    expect(w.log).toContain('Master: kept in the pane w1:p1 herdr gave a new terminal, its wake line typed again')
  }
})

test('#243 review: the user comes to its tab while it is looked at: nothing typed, asked again later, however long', async () => {
  const w = afterTidy({
    panes: [withTerminal(shellPane('w1:p1', 't1', '💤 Master'), 'term-b')],
    sessions: work => ({ 'w1:p1': asleep(work, SID, 'Master', { terminal: 'term-a' }) }),
  })
  w.io.screens['w1:p1'] = `PS ${PROJECT}> `
  const pane = w.io.panes.find(p => p.pane_id === 'w1:p1') as FakePane
  // Its screen read on a look that saw nobody there; the user clicks into it right after.
  let reads = 0
  w.io.on(
    argv => argv[1] === 'read' && argv[2] === 'w1:p1',
    () => {
      reads++
      pane.focused = reads === 1
    },
  )
  const engine = createWakeEngine(w.deps)
  await engine.remember()
  expect(typed(w.io)).toEqual([])
  expect(readSessions(w.file)['w1:p1']?.terminal).toBe('term-a')
  // Well past the ten minutes a shell has to show its prompt: not counted against it.
  w.clock.at += 11 * 60_000
  pane.focused = false
  await engine.remember()
  expect(typed(w.io)).toEqual([['pane', 'send-text', 'w1:p1', `board resume ${SID} --profile work`]])
})

test('#243 review: a wake asked while a look gives its pane back wakes it in a new tab', async () => {
  const w = afterTidy({
    panes: [withTerminal(shellPane('w1:p2', 't2', '💤 Billing'), 'term-a')],
    sessions: work => ({ 'w1:p2': asleep(work, SID, 'Billing', { terminal: 'term-a' }) }),
  })
  w.io.screens['w1:p2'] = lineScreen(SID)
  startsOnRun(w.io, w.work, { id: SID, name: 'Billing', n: 1 })
  const engine = createWakeEngine(w.deps)
  // The look and the wake at once: the look holds the pane and gives it back first.
  const [, woke] = await Promise.all([engine.remember(), engine.wake('Billing')])
  expect(closes(w.io)).toEqual([['tab', 'close', 't2']])
  expect(woke).toMatchObject({ ok: true, pane: 'w1:new1', name: 'Billing' })
  expect(w.io.panes.find(p => p.pane_id === 'w1:new1')).toMatchObject({ agent: 'claude' })
})

test('#243 review: the Telegram router’s pane given back a moment before it wakes it: woken in a new tab', async () => {
  const w = afterTidy({
    panes: [withTerminal(shellPane('w1:p2', 't2', '💤 Billing'), 'term-a')],
    sessions: work => ({ 'w1:p2': asleep(work, SID, 'Billing', { terminal: 'term-a' }) }),
  })
  w.io.screens['w1:p2'] = lineScreen(SID)
  startsOnRun(w.io, w.work, { id: SID, name: 'Billing', n: 1 })
  const engine = createWakeEngine(w.deps)
  // The router picked w1:p2; a look gives it back before the router wakes it.
  await engine.remember()
  expect(closes(w.io)).toEqual([['tab', 'close', 't2']])
  expect(await engine.wakePane('w1:p2')).toEqual({ ok: true, pane: 'w1:new1' })
  // Long after, the old pane's id is another pane's to herdr: not this sleeper's.
  const later = afterTidy({
    sessions: work => ({
      [SID]: asleep(work, SID, 'Billing', { freed: { pane: 'w1:p2', topic: '', at: Date.now() - HOUR } }),
    }),
  })
  expect(await createWakeEngine(later.deps).wakePane('w1:p2')).toMatchObject({ ok: false })
})

// ------------------------------------------------------------------ #243, review round 2: what runs under a restored shell

/** A sleeper in Billing's tab restored by herdr: another terminal, and another shell than the noted one (3999). */
function restoredShell(screen: string) {
  const w = restoredBilling(screen, { shellPid: 3999 })
  return w
}
const under = (pid: number, name: string): MemRow => ({ pid, ppid: 4000, bytes: 10 * 2 ** 20, name })

test('#243 review 2: a cleared restored shell with something still running under it stays (ssh, a REPL), as herdr does not list it on Windows', async () => {
  for (const [screen, program] of [
    ['root@prod:~# ', 'ssh'],
    ['> ', 'node'],
    [`PS ${PROJECT}> `, 'bun'],
  ] as const) {
    const w = restoredShell(screen)
    w.table.push(under(4001, program))
    await createWakeEngine(w.deps).remember()
    expect([program, closes(w.io), typed(w.io)]).toEqual([program, [], []])
    // Judged: kept in that shell for good, not looked at again.
    expect(readSessions(w.file)['w1:p2']).toMatchObject({ terminal: 'term-b', shellPid: 4000 })
  }
})

test('#243 review 2: time spent looking at its tab is no use of the shell: one the user ssh-ed from, cleared and left stays', async () => {
  const w = restoredShell(`PS ${PROJECT}> `)
  const side = w.io.panes.find(p => p.pane_id === 'w1:s2') as FakePane
  side.focused = true
  const engine = createWakeEngine(w.deps)
  for (let i = 0; i < 3; i++) await engine.remember()
  w.io.screens['w1:p2'] = 'root@prod:~# '
  w.table.push(under(4001, 'ssh'))
  side.focused = false
  await engine.remember()
  expect(closes(w.io)).toEqual([])
})

test('#243 review 2: Windows’ console host under a shell is nothing of the user’s; a table that cannot be read is asked again', async () => {
  const w = restoredShell(`PS ${PROJECT}> `)
  w.table.push(under(4002, 'conhost'))
  let readable = false
  w.deps.processTable = async () => (readable ? w.table : null)
  const engine = createWakeEngine(w.deps)
  await engine.remember()
  expect(closes(w.io)).toEqual([])
  expect(readSessions(w.file)['w1:p2']?.terminal).toBe('term-a')
  readable = true
  await engine.remember()
  expect(closes(w.io)).toEqual([['tab', 'close', 't2']])
})

test('#243 review 2: the table is read only when a restored pane is due, once per look; not at all without one (macOS, Linux)', async () => {
  let reads = 0
  const w = afterTidy({
    panes: [
      withTerminal(shellPane('w1:p2', 't2', '💤 Billing'), 'term-b'),
      withTerminal(shellPane('w1:p4', 't4', '💤 Ledger'), 'term-d'),
    ],
    sessions: work => ({
      'w1:p2': asleep(work, SID, 'Billing', { terminal: 'term-a', shellPid: 3999 }),
      'w1:p4': asleep(work, SID2, 'Ledger', { terminal: 'term-c', shellPid: 3999 }),
    }),
  })
  w.io.tabs.push({ tab_id: 't4', workspace_id: 'w1', label: 'Ledger', number: 4 })
  for (const pane of ['w1:p2', 'w1:p4']) w.io.screens[pane] = `PS ${PROJECT}> `
  w.deps.processTable = async () => {
    reads++
    return w.table
  }
  const engine = createWakeEngine(w.deps)
  await engine.remember()
  expect(closes(w.io)).toEqual([
    ['tab', 'close', 't2'],
    ['tab', 'close', 't4'],
  ])
  expect(reads).toBe(1)
  await engine.remember()
  expect(reads).toBe(1)

  // No table (herdr lists what a shell started there): the screen and herdr's list decide.
  const unix = restoredShell(`PS ${PROJECT}> `)
  unix.deps.processTable = null
  await createWakeEngine(unix.deps).remember()
  expect(closes(unix.io)).toEqual([['tab', 'close', 't2']])
})

test('#243 review 2: herdr not saying which shell runs at first sight: nothing noted, logged once, asked again', async () => {
  const w = afterTidy({
    panes: [withTerminal(shellPane('w1:p1', 't1', '💤 Master'), 'term-a')],
    sessions: work => ({ 'w1:p1': asleep(work, SID, 'Master') }),
  })
  const info = w.io.processInfo
  w.io.processInfo = async () => {
    throw new Error('herdr: not answering')
  }
  const engine = createWakeEngine(w.deps)
  await engine.remember()
  await engine.remember()
  expect(readSessions(w.file)['w1:p1']).not.toHaveProperty('terminal')
  expect(w.log.filter(l => l.includes('does not say which shell'))).toHaveLength(1)
  w.io.processInfo = info
  await engine.remember()
  expect(readSessions(w.file)['w1:p1']).toMatchObject({ terminal: 'term-a', shellPid: 4000 })

  // Never answering: after ten minutes the terminal is noted alone.
  const mute = afterTidy({
    panes: [withTerminal(shellPane('w1:p1', 't1', '💤 Master'), 'term-a')],
    sessions: work => ({ 'w1:p1': asleep(work, SID, 'Master') }),
  })
  mute.io.processInfo = async () => {
    throw new Error('herdr: not answering')
  }
  const quiet = createWakeEngine(mute.deps)
  await quiet.remember()
  mute.clock.at += 10 * 60_000
  await quiet.remember()
  expect(readSessions(mute.file)['w1:p1']).toMatchObject({ terminal: 'term-a' })
  expect(readSessions(mute.file)['w1:p1']).not.toHaveProperty('shellPid')
})
