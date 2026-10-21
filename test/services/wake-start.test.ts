// Wake's start (src/services/wake/start.ts) with an in-memory herdr, status file and clock: what it
// takes for its own pane's record and what it writes there. A record from before this boot, or one
// with no process past a start's time, is stale; the record the new pane's supervisor writes while
// the start is still under way is kept.
import { expect, test } from 'bun:test'
import { dirname } from 'node:path'
import { wakeConfig } from '../../src/core/wake/config.ts'
import { STARTING_MS, type WakeStatusFile } from '../../src/core/wake/status.ts'
import { type StartDeps, startWake } from '../../src/services/wake/start.ts'

/** The plugin's folder, with spaces, Cyrillic and %. */
const ROOT = process.platform === 'win32' ? 'C:\\Users\\Иван Петров\\agent-board 100%' : '/home/иван/agent-board 100%'
const NOW = 1_800_000_000_000
/** This computer started an hour ago. */
const BOOTED_AT = NOW - 3_600_000
/** The pane `plugin pane open` gives the new wake. */
const NEW_PANE = 'wW:p9'
/** A process that runs. */
const LIVE = 4242

interface Snap {
  workspaces: { workspace_id: string; label: string }[]
  tabs: { tab_id: string; workspace_id: string }[]
  panes: Record<string, unknown>[]
}

/** Wake's workspace with its tab: wake's pane in the plugin's folder and herdr-sidebar's. */
const wakeTab = (): Snap => ({
  workspaces: [
    { workspace_id: 'wW', label: 'Wake' },
    { workspace_id: 'w1', label: 'Main' },
  ],
  tabs: [
    { tab_id: 'wake-tab', workspace_id: 'wW' },
    { tab_id: 't1', workspace_id: 'w1' },
  ],
  panes: [
    { pane_id: 'wW:p1', tab_id: 'wake-tab', workspace_id: 'wW', cwd: ROOT },
    { pane_id: 'wW:p2', tab_id: 'wake-tab', workspace_id: 'wW', tokens: { 'herdr-sidebar-git': '1' } },
    { pane_id: 'w1:p1', tab_id: 't1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle' },
  ],
})

/** startWake against an in-memory herdr (closing a tab or a pane takes it from the snapshot) and status file. */
async function start(o: {
  status: WakeStatusFile | null
  /** herdr's snapshot; wakeTab() when not given. */
  snap?: Snap
  /** What happens while `plugin pane open` runs (the new pane's supervisor writing its record, say). */
  duringOpen?: (status: { file: WakeStatusFile | null }) => void
}): Promise<{ result: string; calls: string[][]; written: WakeStatusFile[]; file: WakeStatusFile | null }> {
  const snap = o.snap ?? wakeTab()
  const status = { file: o.status }
  const calls: string[][] = []
  const written: WakeStatusFile[] = []
  const deps: StartDeps = {
    async herdr<T>(args: string[]): Promise<T> {
      calls.push(args)
      const [a, b, c] = args
      const answer = (v: unknown): T => v as T
      if (a === 'plugin' && b === 'list') return answer({ plugins: [{ plugin_id: 'agent-board' }] })
      if (a === 'api' && b === 'snapshot') return answer({ snapshot: structuredClone(snap) })
      if (a === 'plugin' && b === 'pane' && c === 'open') {
        o.duringOpen?.(status)
        return answer({ plugin_pane: { pane: { pane_id: NEW_PANE } } })
      }
      if (a === 'tab' && b === 'close') {
        snap.tabs = snap.tabs.filter(t => t.tab_id !== c)
        snap.panes = snap.panes.filter(p => p.tab_id !== c)
        return answer(null)
      }
      if (a === 'pane' && b === 'close') {
        snap.panes = snap.panes.filter(p => p.pane_id !== c)
        return answer(null)
      }
      throw new Error(`unexpected herdr ${args.join(' ')}`)
    },
    answers: async () => false,
    readStatus: () => status.file,
    writeStatus: s => {
      written.push(s)
      status.file = s
    },
    alive: pid => pid === LIVE,
    log: () => {},
    sleep: async () => {},
    now: () => NOW,
    bootedAt: BOOTED_AT,
    root: ROOT,
  }
  const result = await startWake(deps, {
    on: true,
    settings: wakeConfig({ enabled: true, port: 40000 }),
    board: { label: 'Board', pane: null },
  })
  return { result, calls, written, file: status.file }
}

const opened = (): string[] => [
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
  'wW',
  '--cwd',
  ROOT,
  '--no-focus',
]

test('the new pane’s supervisor writes its record while the start opens the pane: the start writes nothing over it, the pid and port kept', async () => {
  const running: WakeStatusFile = { state: 'running', at: NOW, pane: NEW_PANE, pid: 777, port: 40000 }
  const out = await start({
    status: null,
    duringOpen: status => {
      status.file = running
    },
  })
  expect(out.result).toBe('opened')
  expect(out.written).toEqual([])
  expect(out.file).toEqual(running)
})

test('the supervisor’s record not there yet: the start records the new pane as starting', async () => {
  const before: WakeStatusFile = { state: 'stopped', at: NOW - 1000, pane: 'wW:p1', pid: 999_999 }
  const out = await start({ status: before })
  expect(out.result).toBe('opened')
  expect(out.file).toEqual({ state: 'starting', at: NOW, pane: NEW_PANE })
})

test('a record with no process: the pane trusted for a start’s time, stale after it', async () => {
  const young = await start({ status: { state: 'starting', at: NOW - STARTING_MS + 1000, pane: 'wW:p1' } })
  expect(young.result).toBe('present')
  expect(young.calls).toEqual([
    ['plugin', 'list', '--json'],
    ['api', 'snapshot'],
  ])

  const old = await start({ status: { state: 'starting', at: NOW - STARTING_MS - 1000, pane: 'wW:p1' } })
  expect(old.result).toBe('opened')
  expect(old.calls).toEqual([
    ['plugin', 'list', '--json'],
    ['api', 'snapshot'],
    ['tab', 'close', 'wake-tab'],
    ['api', 'snapshot'],
    opened(),
  ])
  expect(old.file).toEqual({ state: 'starting', at: NOW, pane: NEW_PANE })
})

test('a record from before this boot is stale though its pid runs now; one of this boot with that pid is wake running', async () => {
  const before = await start({ status: { state: 'running', at: BOOTED_AT - 1, pane: 'wW:p1', pid: LIVE } })
  expect(before.result).toBe('opened')
  expect(before.calls).toEqual([
    ['plugin', 'list', '--json'],
    ['api', 'snapshot'],
    ['tab', 'close', 'wake-tab'],
    ['api', 'snapshot'],
    opened(),
  ])

  const since = await start({ status: { state: 'running', at: BOOTED_AT + 1, pane: 'wW:p1', pid: LIVE } })
  expect(since.result).toBe('present')
  expect(since.written).toEqual([])
})

test('a record from before this boot names no pane nor process in what the start writes', async () => {
  // herdr answers no snapshot: the start fails, its record keeps only what is of this boot.
  const deps = (status: WakeStatusFile): { deps: StartDeps; written: WakeStatusFile[] } => {
    const written: WakeStatusFile[] = []
    return {
      written,
      deps: {
        herdr: async <T>(args: string[]): Promise<T> => {
          if (args[0] === 'plugin') return { plugins: [] } as T
          throw new Error('herdr is not ready')
        },
        answers: async () => false,
        readStatus: () => status,
        writeStatus: s => {
          written.push(s)
        },
        alive: pid => pid === LIVE,
        log: () => {},
        sleep: async () => {},
        now: () => NOW,
        bootedAt: BOOTED_AT,
        root: ROOT,
      },
    }
  }
  const o = { on: true, settings: wakeConfig({ enabled: true, port: 40000 }), board: { label: 'Board', pane: null } }
  const old = deps({ state: 'running', at: BOOTED_AT - 1, pane: 'wW:p1', pid: LIVE })
  expect(await startWake(old.deps, o)).toBe('failed')
  expect(old.written).toEqual([{ state: 'failed', at: NOW, error: 'herdr is not ready' }])

  const current = deps({ state: 'running', at: BOOTED_AT + 1, pane: 'wW:p1', pid: LIVE })
  expect(await startWake(current.deps, o)).toBe('failed')
  expect(current.written).toEqual([{ state: 'failed', at: NOW, error: 'herdr is not ready', pane: 'wW:p1', pid: LIVE }])
})

test('leftover tabs: a shell in the plugin’s folder however herdr spells it (case, separators, a trailing one) is wake’s; one in another folder is not', async () => {
  const spellings =
    process.platform === 'win32'
      ? ['c:/users/иван петров/agent-board 100%/', 'C:\\Users\\ИВАН ПЕТРОВ\\agent-board 100%\\']
      : ['/home/иван/agent-board 100%/', '/home//иван/agent-board 100%']
  // A folder beside it whose name starts the same, and the folder it is in.
  const other = [`${ROOT} old`, dirname(ROOT)]
  const tabs = [...spellings.map((_, i) => `same-${i}`), ...other.map((_, i) => `other-${i}`)]
  const out = await start({
    status: null,
    snap: {
      workspaces: [{ workspace_id: 'wW', label: 'Wake' }],
      tabs: tabs.map(tab_id => ({ tab_id, workspace_id: 'wW' })),
      panes: [...spellings, ...other].map((cwd, i) => ({
        pane_id: `wW:p${i + 1}`,
        tab_id: tabs[i],
        workspace_id: 'wW',
        cwd,
      })),
    },
  })
  expect(out.result).toBe('opened')
  expect(out.calls.filter(c => c[0] === 'tab')).toEqual(spellings.map((_, i) => ['tab', 'close', `same-${i}`]))
})
