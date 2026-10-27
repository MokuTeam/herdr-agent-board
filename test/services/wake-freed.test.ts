// #204: a Claude session put to sleep gives its pane back, and its tab when only herdr-sidebar's
// panes are beside it, and wakes in a new tab of its workspace under its tab's label. The wake
// engine against the in-memory fake herdr, a fake clock, a temp home with a Work profile, and fake
// new tabs; what follows the session from pane to pane recorded.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  }
  return { dir, home, work, file, io, deps, opened, follows, log, clock, archivedIds, tidyFile, settings }
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
