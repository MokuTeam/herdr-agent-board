import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LAUNCHER_CHILD } from '../../src/core/launch/spawn-args.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

// spawn-agent's limits on a session's starts (#815) end to end, against the sandbox's fake herdr:
// a session's start is written in the ledger and refused past a limit, with one line and a question
// on its card; the owner's starts and the board's own launcher go the way they went before.
const SPAWN = join(root, 'src', 'entrypoints', 'spawn-agent.ts')
const CHILD = '0f8fad5b-d9cb-469f-a165-70867728950e'
const READY = {
  result: {
    pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude', agent_status: 'idle', agent_session: { value: CHILD } },
  },
}
const STATE = {
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9', terminal_id: 'term-9' } } },
  'tab rename': { result: null },
  'pane run': { result: null },
  'pane get': { seq: [{ result: { pane: { pane_id: 'wA:p9', agent: null } } }, READY] },
  'agent list': { result: { agents: [{ pane_id: 'wA:p9' }] } },
  'agent rename': { result: null },
  'agent prompt': { result: null },
  'pane read': { text: 'Session renamed to: Acme' },
  'pane send-keys': { result: null },
}
const SID = 'atlas-0000-4000-8000-000000000001'

async function runSpawn(box: Sandbox, args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, SPAWN, ...args], {
    cwd: root,
    env: { ...box.env, BOARD_TEST_PACE: '0.02', ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

async function limitBox(spawnLimits?: unknown) {
  const box = await sandbox()
  box.state(STATE)
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ language: 'en', ...(spawnLimits !== undefined && { spawnLimits }) }),
  )
  const cwd = join(box.dir, 'Acme project')
  mkdirSync(cwd)
  return { box, cwd }
}

const ledgerFile = (box: Sandbox) =>
  join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board', 'spawns.json')
const ledger = (box: Sandbox) =>
  existsSync(ledgerFile(box))
    ? (JSON.parse(readFileSync(ledgerFile(box), 'utf8')).entries as Record<string, unknown>[])
    : null
const cardOf = (box: Sandbox, key: string): Record<string, unknown> | null => {
  const file = join(box.cards, `${key}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}
const args = (cwd: string) => [
  '--name',
  'Acme',
  '--cwd',
  cwd,
  '--workspace',
  'wA',
  '--brief',
  'Hi',
  '--session-id',
  CHILD,
]

test("the owner's start: no ledger, and herdr gets the calls it got before", async () => {
  const { box, cwd } = await limitBox({ agents: false, perHour: 1 })
  const r = await runSpawn(box, args(cwd))
  expect(r.code).toBe(0)
  expect(r.stdout.trim()).toBe('pane=wA:p9 name=Acme agent=acme')
  expect(ledger(box)).toBeNull()
  expect(box.calls().some(c => c[0] === 'api')).toBe(false)
}, 30_000)

test("a session's start under the limits: the same herdr calls as the owner's, and the ledger says who started whom", async () => {
  const owner = await limitBox()
  await runSpawn(owner.box, args(owner.cwd))
  const ownerCalls = owner.box.calls().map(c => c.join(' ').replace(owner.cwd, '<cwd>'))

  const { box, cwd } = await limitBox()
  const r = await runSpawn(box, args(cwd), { CLAUDE_CODE_SESSION_ID: SID })
  expect(r.code).toBe(0)
  expect(r.stdout.trim()).toBe('pane=wA:p9 name=Acme agent=acme')
  expect(box.calls().map(c => c.join(' ').replace(cwd, '<cwd>'))).toEqual(ownerCalls)
  const entries = ledger(box)
  expect(entries).toHaveLength(1)
  expect(entries?.[0]).toMatchObject({ by: { session: SID }, name: 'Acme', child: { pane: 'wA:p9', session: CHILD } })
}, 30_000)

test("past a limit: exit 1 with one line, nothing started, and the owner's question on the session's card", async () => {
  const { box, cwd } = await limitBox({ perHour: 1 })
  const env = { CLAUDE_CODE_SESSION_ID: SID }
  expect((await runSpawn(box, args(cwd), env)).code).toBe(0)
  const before = box.calls().length
  const r = await runSpawn(box, args(cwd), env)
  expect(r.code).toBe(1)
  expect(r.stdout).toBe('')
  expect(r.stderr.trim().split('\n')).toEqual([
    'spawn-agent: this session started 1 session in the last hour, the limit is 1 (Settings → Board & Agents): wait, or ask the owner',
  ])
  expect(
    box
      .calls()
      .slice(before)
      .some(c => c[0] === 'tab'),
  ).toBe(false)
  expect(ledger(box)).toHaveLength(1)
  expect(cardOf(box, SID)?.ask).toBe(
    'Wants to start "Acme": it started 1 session in the last hour, the limit is 1 (Settings → Board & Agents)',
  )
}, 30_000)

test("agent starts off: a session is refused; the board's own launcher is not", async () => {
  const { box, cwd } = await limitBox({ agents: false })
  const env = { CLAUDE_CODE_SESSION_ID: SID }
  const refused = await runSpawn(box, args(cwd), env)
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain('sessions on this computer may not start sessions')
  // The board's launcher marks the spawn-agent it runs: never counted.
  const launcher = await runSpawn(box, args(cwd), { ...env, [LAUNCHER_CHILD]: '1' })
  expect(launcher.code).toBe(0)
  expect(ledger(box)).toBeNull()
}, 30_000)
