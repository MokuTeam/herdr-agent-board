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

async function runFinishInSandbox(herdrState: Record<string, unknown>, itemPane: string | null = 'w1:p5') {
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

test('finish() checks pane get and pane process-info with --pane, closing an idle shell pane (#642)', async () => {
  const idle = await runFinishInSandbox({
    'pane get': { result: { pane: { pane_id: 'w1:p5', tab_id: 'w1:t5', workspace_id: 'w1' } } },
    'pane process-info --pane w1:p5': {
      result: { process_info: { shell_pid: 101, foreground_processes: [{ pid: 101 }] } },
    },
    'pane close': { result: null },
  })
  expect(idle.result).toEqual({ ok: true, notes: ['its pane closed'] })
  expect(idle.card.moved?.to).toBe('server-2')
  expect(idle.calls).toEqual([
    ['pane', 'get', 'w1:p5'],
    ['pane', 'process-info', '--pane', 'w1:p5'],
    ['pane', 'close', 'w1:p5'],
  ])

  const busy = await runFinishInSandbox({
    'pane get': { result: { pane: { pane_id: 'w1:p5', tab_id: 'w1:t5', workspace_id: 'w1' } } },
    'pane process-info --pane w1:p5': {
      result: { process_info: { shell_pid: 101, foreground_processes: [{ pid: 101 }, { pid: 202 }] } },
    },
  })
  expect(busy.result).toEqual({ ok: true, notes: [] })
  expect(busy.calls.some(c => c[0] === 'pane' && c[1] === 'close')).toBe(false)

  const gone = await runFinishInSandbox({
    'pane get': { error: 'pane not found', code: 'pane_not_found' },
  })
  expect(gone.result).toEqual({ ok: true, notes: [] })

  const runningAgent = await runFinishInSandbox({
    'pane get': {
      result: { pane: { pane_id: 'w1:p5', tab_id: 'w1:t5', workspace_id: 'w1', agent: 'claude' } },
    },
  })
  expect(runningAgent.result).toEqual({ ok: true, notes: ['its pane was left (an agent runs in it)'] })
  expect(runningAgent.calls.some(c => c[0] === 'pane' && c[1] === 'close')).toBe(false)
}, 30_000)
