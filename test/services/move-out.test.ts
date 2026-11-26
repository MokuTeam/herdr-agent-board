// The source's half of a move to another device (#616, services/move-out.ts): which folder it packs
// a session from. A session moved to this board before has the source device's folder in its
// transcript's first lines (#621); the folder it runs in here, whose project folder holds the
// transcript, is the one that travels.
import { beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'
import type { Item } from '../../src/core/types.ts'
import type { Deps } from '../../src/services/deps.ts'
import { createMoveOut } from '../../src/services/move-out.ts'
import { isolatedHome } from '../support/env.ts'
import { root, sandbox } from '../support/sandbox.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
let home = ''
beforeEach(() => {
  home = isolatedHome()
})

test("a session moved here before packs the folder it runs in here, not the one its transcript's first lines name", async () => {
  const dir = join(home, '.claude')
  const here = join(home, 'work', 'example.com', 'anna', 'atlas-feature-x')
  const there = join(home, 'laptop', 'atlas')
  for (const d of [here, there]) mkdirSync(d, { recursive: true })
  const project = join(dir, 'projects', projectFolderName(here))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${S}.jsonl`), `${JSON.stringify({ type: 'user', cwd: there, sessionId: S })}\n`)
  const asked: string[] = []
  const out = createMoveOut({
    deps: {
      profiles: () => ({ list: [{ id: 'default', dir, title: 'Default', hidden: false }] }),
    } as unknown as Deps,
    items: () =>
      [
        {
          key: S,
          session: S,
          name: 'Atlas',
          agent: 'claude',
          cwd: here,
          sleeping: true,
          profile: 'default',
          category: 'atlas',
        },
      ] as unknown as Item[],
    log: () => {},
    git: {
      checkout: async cwd => {
        asked.push(cwd)
        return {
          root: cwd,
          remote: { name: 'origin', url: 'git@github.com:anna/atlas.git', address: 'github.com/anna/atlas' },
          clean: true,
          headPushed: true,
        }
      },
      info: async cwd => ({ root: cwd, branch: 'feature-x' }),
      identity: async () => null,
      changes: async () => ({ head: 'c'.repeat(40), changes: { files: [], deleted: [], odd: [] } }),
    },
  })
  const r = await out.pack(S, 'server-1')
  if (!r.ok) throw new Error(r.why)
  expect(r.pack.cwd).toBe(here)
  expect(asked).toEqual([here])
  // A session that never moved: its transcript's folder is the one it runs in, as before.
  const fresh = join(home, 'fresh')
  mkdirSync(fresh, { recursive: true })
  const project2 = join(dir, 'projects', projectFolderName(fresh))
  mkdirSync(project2, { recursive: true })
  const S2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
  writeFileSync(join(project2, `${S2}.jsonl`), `${JSON.stringify({ type: 'user', cwd: fresh, sessionId: S2 })}\n`)
  const out2 = createMoveOut({
    deps: { profiles: () => ({ list: [{ id: 'default', dir, title: 'Default', hidden: false }] }) } as unknown as Deps,
    items: () =>
      [
        {
          key: S2,
          session: S2,
          name: 'Ben',
          agent: 'claude',
          cwd: '',
          sleeping: true,
          profile: 'default',
          category: 'atlas',
        },
      ] as unknown as Item[],
    log: () => {},
    git: {
      checkout: async cwd => ({
        root: cwd,
        remote: { name: 'origin', url: 'git@github.com:anna/atlas.git', address: 'github.com/anna/atlas' },
        clean: true,
        headPushed: true,
      }),
      info: async cwd => ({ root: cwd, branch: 'main' }),
      identity: async () => null,
      changes: async () => ({ head: 'c'.repeat(40), changes: { files: [], deleted: [], odd: [] } }),
    },
  })
  const r2 = await out2.pack(S2, 'laptop')
  expect(r2.ok && r2.pack.cwd).toBe(fresh)
})

async function runFinishInSandbox(
  herdrState: Record<string, unknown>,
  opts: { itemPane?: string | null; processTableRows?: string; platform?: string } = {},
) {
  const { itemPane = 'w1:p5', processTableRows, platform = 'linux' } = opts
  const box = await sandbox()
  const dir = join(box.env.HOME as string, '.claude')
  const here = join(box.dir, 'atlas')
  mkdirSync(here, { recursive: true })
  const project = join(dir, 'projects', projectFolderName(here))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${S}.jsonl`), `${JSON.stringify({ type: 'user', cwd: here, sessionId: S })}\n`)
  box.state(herdrState)
  const src = join(root, 'src').replaceAll('\\', '/')
  const script = join(box.dir, 'finish-case.ts')
  const processTableLine = processTableRows !== undefined ? `processTable: async () => ${processTableRows},` : ''
  writeFileSync(
    script,
    `
import { createMoveOut } from '${src}/services/move-out.ts'

const out = createMoveOut({
  deps: {
    profiles: () => ({ list: [{ id: 'default', dir: ${JSON.stringify(dir)}, title: 'Default', hidden: false }] }),
    wake: { forget: () => {} },
  } as never,
  items: () => [{
    key: '${S}',
    session: '${S}',
    pane: ${JSON.stringify(itemPane)},
    name: 'Atlas',
    agent: 'claude',
    cwd: ${JSON.stringify(here)},
    sleeping: true,
    profile: 'default',
    category: 'atlas',
  }] as never,
  log: () => {},
  home: ${JSON.stringify(box.env.HOME)},
  platform: ${JSON.stringify(platform)},
  ${processTableLine}
  git: {
    checkout: async cwd => ({
      root: cwd,
      remote: { name: 'origin', url: 'git@github.com:anna/atlas.git', address: 'github.com/anna/atlas' },
      clean: true,
      headPushed: true,
    }),
    info: async cwd => ({ root: cwd, branch: 'main' }),
    identity: async () => null,
    changes: async () => ({ head: 'c'.repeat(40), changes: { files: [], deleted: [], odd: [] } }),
  },
})
const packed = await out.pack('${S}', 'laptop')
if (!packed.ok) throw new Error(packed.why)
const finished = await out.finish('${S}', 'server-2')
console.log(JSON.stringify(finished))
process.exit(0)
`,
  )
  const proc = Bun.spawn([process.execPath, script], { cwd: root, env: box.env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect([await proc.exited, err]).toEqual([0, ''])
  const result = JSON.parse(out.trim().split('\n').at(-1) ?? 'null') as { ok: boolean; notes: string[] }
  const card = JSON.parse(readFileSync(join(box.cards, `${S}.json`), 'utf8')) as { moved?: { to?: string } }
  return { result, calls: box.calls(), card }
}

test('finish() checks pane get and pane process-info with --pane, preserving main on linux and closing tab on win32 (#642, #888)', async () => {
  const samePane = { pane_id: 'w1:p5', terminal_id: 'term-5', label: '💤 Atlas', tab_id: 'w1:t5', workspace_id: 'w1' }
  const sidebarPane = { pane_id: 'w1:s5', tab_id: 'w1:t5', workspace_id: 'w1', label: 'Sidebar' }
  const userPane = { pane_id: 'w1:p6', tab_id: 'w1:t5', workspace_id: 'w1', label: 'user shell' }
  const procOk = { result: { process_info: { shell_pid: 101, foreground_processes: [{ pid: 101 }] } } }
  const pwshIdle = JSON.stringify([{ pid: 101, ppid: 1, bytes: 1024, name: 'pwsh' }])

  // Linux keeps exact main behavior: closes pane directly without pane list or processTable.
  const linuxIdle = await runFinishInSandbox(
    {
      'pane get': { result: { pane: samePane } },
      'pane process-info --pane w1:p5': procOk,
      'pane close': { result: null },
    },
    { platform: 'linux' },
  )
  expect(linuxIdle.result).toEqual({ ok: true, notes: ['its pane closed'] })
  expect(linuxIdle.card.moved?.to).toBe('server-2')
  expect(linuxIdle.calls).toEqual([
    ['pane', 'get', 'w1:p5'],
    ['pane', 'get', 'w1:p5'],
    ['pane', 'process-info', '--pane', 'w1:p5'],
    ['pane', 'close', 'w1:p5'],
  ])

  // win32 alone beside an expired Sidebar pane -> closes the whole tab so no empty sidebar shell stays.
  const alone = await runFinishInSandbox(
    {
      'pane get': { result: { pane: samePane } },
      'pane process-info --pane w1:p5': procOk,
      'pane list --workspace w1': { result: { panes: [samePane, sidebarPane] } },
      'tab close': { result: null },
    },
    { platform: 'win32', processTableRows: pwshIdle },
  )
  expect(alone.result).toEqual({ ok: true, notes: ['its pane closed'] })
  expect(alone.card.moved?.to).toBe('server-2')
  expect(alone.calls).toEqual([
    ['pane', 'get', 'w1:p5'],
    ['pane', 'get', 'w1:p5'],
    ['pane', 'process-info', '--pane', 'w1:p5'],
    ['pane', 'list', '--workspace', 'w1'],
    ['tab', 'close', 'w1:t5'],
  ])

  // win32 shared tab with a user shell -> closes only the sleeper's pane.
  const shared = await runFinishInSandbox(
    {
      'pane get': { result: { pane: samePane } },
      'pane process-info --pane w1:p5': procOk,
      'pane list --workspace w1': { result: { panes: [samePane, sidebarPane, userPane] } },
      'pane close': { result: null },
    },
    { platform: 'win32', processTableRows: pwshIdle },
  )
  expect(shared.result).toEqual({ ok: true, notes: ['its pane closed'] })
  expect(shared.calls).toContainEqual(['pane', 'close', 'w1:p5'])
  expect(shared.calls.some(c => c[0] === 'tab' && c[1] === 'close')).toBe(false)

  // win32 pane list failing falls back to pane close.
  const fallback = await runFinishInSandbox(
    {
      'pane get': { result: { pane: samePane } },
      'pane process-info --pane w1:p5': procOk,
      'pane list --workspace w1': { error: 'pane list failed', code: 'exec_failed' },
      'pane close': { result: null },
    },
    { platform: 'win32', processTableRows: pwshIdle },
  )
  expect(fallback.result).toEqual({ ok: true, notes: ['its pane closed'] })
  expect(fallback.calls).toContainEqual(['pane', 'close', 'w1:p5'])

  // win32 process table gate: child process under shell pid prevents close.
  const winBusy = await runFinishInSandbox(
    {
      'pane get': { result: { pane: samePane } },
      'pane process-info --pane w1:p5': procOk,
      'pane list --workspace w1': { result: { panes: [samePane, sidebarPane] } },
      'tab close': { result: null },
    },
    {
      platform: 'win32',
      processTableRows: JSON.stringify([
        { pid: 101, ppid: 1, bytes: 1024, name: 'pwsh' },
        { pid: 202, ppid: 101, bytes: 1024, name: 'node' },
      ]),
    },
  )
  expect(winBusy.result).toEqual({ ok: true, notes: [] })
  expect(winBusy.calls.some(c => c[1] === 'close')).toBe(false)

  const busy = await runFinishInSandbox({
    'pane get': { result: { pane: samePane } },
    'pane process-info --pane w1:p5': {
      result: { process_info: { shell_pid: 101, foreground_processes: [{ pid: 101 }, { pid: 202 }] } },
    },
  })
  expect(busy.result).toEqual({ ok: true, notes: [] })
  expect(busy.calls.some(c => c[0] === 'pane' && c[1] === 'close')).toBe(false)

  const reusedTerminal = await runFinishInSandbox({
    'pane get': {
      seq: [{ result: { pane: samePane } }, { result: { pane: { ...samePane, terminal_id: 'term-9' } } }],
    },
    'pane close': { result: null },
  })
  expect(reusedTerminal.result).toEqual({ ok: true, notes: ['its pane was left (its pane changed)'] })
  expect(reusedTerminal.calls.some(c => c[0] === 'pane' && c[1] === 'close')).toBe(false)

  const relabeled = await runFinishInSandbox({
    'pane get': {
      seq: [{ result: { pane: samePane } }, { result: { pane: { ...samePane, label: 'New work' } } }],
    },
    'pane close': { result: null },
  })
  expect(relabeled.result).toEqual({ ok: true, notes: ['its pane was left (its pane changed)'] })
  expect(relabeled.calls.some(c => c[0] === 'pane' && c[1] === 'close')).toBe(false)

  const gone = await runFinishInSandbox({
    'pane get': { seq: [{ result: { pane: samePane } }, { error: 'pane not found', code: 'pane_not_found' }] },
  })
  expect(gone.result).toEqual({ ok: true, notes: [] })

  const otherNotFound = await runFinishInSandbox({
    'pane get': { seq: [{ result: { pane: samePane } }, { error: 'command not found', code: 'exec_failed' }] },
  })
  expect(otherNotFound.result).toEqual({
    ok: true,
    notes: ['its pane was left (herdr pane get: exec_failed: command not found)'],
  })

  const runningAgent = await runFinishInSandbox({
    'pane get': {
      result: { pane: { ...samePane, agent: 'claude' } },
    },
  })
  expect(runningAgent.result).toEqual({ ok: true, notes: ['its pane was left (an agent runs in it)'] })
  expect(runningAgent.calls.some(c => c[0] === 'pane' && c[1] === 'close')).toBe(false)
}, 30_000)
