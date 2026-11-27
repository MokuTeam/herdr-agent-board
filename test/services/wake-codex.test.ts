import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProfileHomes } from '../../src/adapters/profile-homes.ts'
import { codexDraft } from '../../src/core/dialogs/codex-input.ts'
import { profileSet } from '../../src/core/profiles.ts'
import { wakeConfig } from '../../src/core/wake/config.ts'
import { createWakeEngine, type WakeEngineDeps } from '../../src/services/wake/engine.ts'
import { isolatedHome } from '../support/env.ts'
import { type FakePane, fakeWakeHerdr } from '../support/fake-wake-herdr.ts'

const ID = '509dfc37-b58e-4851-9988-a8c7befe9f0d'
const LINE = `board resume --codex ${ID}`
const PANE = 'w5:p9'
const label = 'Проект x 50%'
const cwd = 'C:\\Projects\\Проект x 50%'

function world() {
  const dir = isolatedHome()
  const pane: FakePane = {
    pane_id: PANE,
    workspace_id: 'w5',
    cwd,
    agent: 'codex',
    agent_status: 'idle',
    agent_session: { value: ID },
    terminal_title_stripped: label,
  }
  const io = fakeWakeHerdr({
    panes: [pane],
    workspaces: [{ workspace_id: 'w5', label: 'Workspace' }],
    inputBoxes: { [PANE]: '› \x1b[2mAsk Codex\x1b[0m' },
    shells: { [PANE]: 'pwsh.exe' },
  })
  io.busy.add(PANE)
  io.on(
    a => a[0] === 'agent' && a[1] === 'prompt' && a[3] === '/exit',
    () => {
      pane.agent = null
      pane.agent_session = null
      delete pane.agent_status
      io.busy.delete(PANE)
    },
  )
  io.on(
    a => a[0] === 'pane' && a[1] === 'run' && a[3] === LINE,
    a => {
      const woken = io.panes.find(p => p.pane_id === a[2])
      if (!woken) throw new Error('missing test pane')
      woken.agent = 'codex'
      woken.agent_session = { value: ID }
      woken.agent_status = 'idle'
    },
  )
  const clock = { now: 100_000 }
  const tabs: string[][] = []
  const file = join(dir, 'wake-codex.json')
  const deps: WakeEngineDeps & { codex: NonNullable<WakeEngineDeps['codex']> } = {
    herdr: io,
    homes: createProfileHomes(),
    profiles: () => profileSet([], join(dir, '.claude')),
    settings: () => wakeConfig({ enabled: true, reaper: { enabled: true, idleMinutes: 2 } }),
    sessionsFile: join(dir, 'wake-sessions.json'),
    codexFile: file,
    boardOnPath: () => true,
    archived: () => new Set(),
    scheduled: async () => false,
    log: () => {},
    now: () => clock.now,
    sleep: async ms => {
      clock.now += ms
    },
    codex: {
      herdr: io,
      codex: { line: id => `board resume --codex ${id}`, draft: codexDraft },
      hasConversation: id => id === ID,
      home: dir,
      exists: () => true,
      async newTab(workspace, folder, name) {
        tabs.push([workspace, folder, name])
        io.panes.push({ pane_id: 'w5:p10', workspace_id: workspace, cwd: folder })
        return 'w5:p10'
      },
      async newWorkspace() {
        throw new Error('workspace still exists')
      },
    },
  }
  return { deps, pane, io, file, tabs, clock }
}

test('sleeps Codex, persists its card, and wakes the same conversation after the pane closes', async () => {
  const w = world()
  const engine = createWakeEngine(w.deps)
  expect(await engine.sleep(ID)).toMatchObject({ ok: true, pane: PANE, name: label })
  expect(w.io.calls).toContainEqual(['agent', 'prompt', PANE, '/exit'])
  expect(w.io.calls).toContainEqual(['pane', 'send-text', PANE, LINE])
  expect(await engine.sleeping()).toEqual([])
  expect(await engine.sleepingAll()).toMatchObject([{ agent: 'codex', session: ID, pane: PANE, cwd }])
  w.io.panes.splice(0)
  const reopened = createWakeEngine(w.deps)
  expect(await reopened.wake(ID)).toMatchObject({ ok: true, pane: 'w5:p10' })
  expect(w.tabs).toEqual([['w5', cwd, label]])
  expect(w.io.calls).toContainEqual(['pane', 'run', 'w5:p10', LINE])
  expect(JSON.parse(readFileSync(w.file, 'utf8'))).toEqual({})
})

test('reaper times only idle Codex and preserves a draft, focus and recent activity', async () => {
  const w = world()
  const engine = createWakeEngine(w.deps)
  await engine.reapRound()
  w.clock.now += 120_000
  w.pane.focused = true
  await engine.reapRound()
  expect(w.io.calls.some(a => a[1] === 'prompt')).toBe(false)
  w.pane.focused = false
  w.io.inputBoxes[PANE] = '› unfinished draft'
  await engine.reapRound()
  expect(w.io.calls.some(a => a[1] === 'prompt')).toBe(false)
  w.io.inputBoxes[PANE] = '› \x1b[2mAsk Codex\x1b[0m'
  w.pane.agent_status = 'working'
  await engine.reapRound()
  w.pane.agent_status = 'done'
  await engine.reapRound()
  expect(w.io.calls.some(a => a[1] === 'prompt')).toBe(false)
  w.clock.now += 120_000
  await engine.reapRound()
  expect(await engine.sleepingAll()).toMatchObject([{ agent: 'codex', session: ID }])
})

test.each(['claude', 'agy', 'pi', undefined])('skips Codex reaper calls for pane kind %p', async kind => {
  const w = world()
  if (kind) w.pane.agent = kind
  else delete w.pane.agent
  const unexpected = () => {
    throw new Error('Codex ops used for another pane kind')
  }
  w.deps.codex.hasConversation = unexpected
  const engine = createWakeEngine(w.deps)
  await engine.reapRound()
  w.clock.now += 120_000
  await engine.reapRound()
  expect(w.io.calls.filter(a => a[0] !== 'api')).toEqual([])
})

test('closes Codex tab on sleep on win32 when beside only Sidebar and leaves pane open on linux (#888)', async () => {
  // Linux keeps original main behavior (pane stays open, no tab close).
  const wLinux = world()
  wLinux.pane.tab_id = 't2'
  wLinux.io.tabs.push(
    { tab_id: 't1', workspace_id: 'w5', label: '1', number: 1 },
    { tab_id: 't2', workspace_id: 'w5', label: 'Codex Work', number: 2 },
  )
  wLinux.io.panes.push(
    { pane_id: 'w5:p1', tab_id: 't1', workspace_id: 'w5', cwd, agent: 'claude' },
    { pane_id: 'w5:s2', tab_id: 't2', workspace_id: 'w5', cwd, label: 'Sidebar' },
  )
  wLinux.io.screens[PANE] = `PS ${cwd}> `
  const linuxEngine = createWakeEngine({ ...wLinux.deps, platform: 'linux' })
  expect(await linuxEngine.sleep(ID)).toEqual({ ok: true, pane: PANE, name: label })
  expect(wLinux.io.calls.some(c => c[1] === 'close')).toBe(false)

  // Windows closes the tab when only Sidebar sits beside it and preserves tabLabel on wake.
  const w = world()
  w.pane.tab_id = 't2'
  w.io.tabs.push(
    { tab_id: 't1', workspace_id: 'w5', label: '1', number: 1 },
    { tab_id: 't2', workspace_id: 'w5', label: 'Codex Work', number: 2 },
  )
  w.io.panes.push(
    { pane_id: 'w5:p1', tab_id: 't1', workspace_id: 'w5', cwd, agent: 'claude' },
    { pane_id: 'w5:s2', tab_id: 't2', workspace_id: 'w5', cwd, label: 'Sidebar' },
  )
  w.io.screens[PANE] = `PS ${cwd}> `
  const engine = createWakeEngine({
    ...w.deps,
    platform: 'win32',
    processTable: async () => [{ pid: 4000, ppid: 1, bytes: 1024, name: 'pwsh' }],
  })
  expect(await engine.sleep(ID)).toEqual({ ok: true, pane: PANE, name: label })
  expect(w.io.calls).toContainEqual(['tab', 'close', 't2'])
  expect(await engine.sleepingAll()).toMatchObject([{ agent: 'codex', session: ID, pane: '' }])

  // Reopen via engine with tabLabel preserved in freed metadata.
  const reopened = createWakeEngine({ ...w.deps, platform: 'win32', processTable: async () => [] })
  expect(await reopened.wake(ID)).toEqual({ ok: true, pane: 'w5:p10', name: label })
  expect(JSON.parse(readFileSync(w.file, 'utf8'))).toEqual({})
})

test('submits the unchanged resume line once when pane run did not press Enter', async () => {
  const w = world()
  w.pane.terminal_id = 'terminal-original'
  const engine = createWakeEngine(w.deps)
  expect(await engine.sleep(ID)).toMatchObject({ ok: true })
  w.io.on(
    a => a[1] === 'run' && a[3] === LINE,
    () => {
      w.pane.agent = null
      w.pane.agent_session = null
      delete w.pane.agent_status
      w.io.screens[PANE] = `user@Mac % ${LINE}`
    },
  )
  w.io.on(
    a => a[1] === 'send-keys' && a[3] === 'enter',
    () => {
      w.pane.agent = 'codex'
      w.pane.agent_session = { value: ID }
      w.pane.agent_status = 'idle'
    },
  )
  expect(await engine.wake(ID)).toMatchObject({ ok: true, pane: PANE })
  expect(w.io.calls.filter(a => a[1] === 'send-keys' && a[3] === 'enter')).toEqual([
    ['pane', 'send-keys', PANE, 'enter'],
  ])
})
