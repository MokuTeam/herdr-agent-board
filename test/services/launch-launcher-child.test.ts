// The board's own launcher runs spawn-agent as a child (#505): that child never asks the board back.
// Its arguments say it is the board's (--keep-env or --config-dir, --session-id unless the line picks
// its own session), and the launcher marks it besides (BOARD_SPAWN_CHILD), so that a later change to
// those arguments cannot make it a start the placer takes. The launch pipeline runs in this process
// against a sandbox's fake herdr, the child reads a config.json with `nodes` and the port of a fake
// board here, which counts every request, and the program runner is spied for the child's env.
import { afterEach, spyOn, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'

const kept: Record<string, string | undefined> = {}
const servers: { stop(force?: boolean): unknown }[] = []
afterEach(() => {
  for (const [k, v] of Object.entries(kept)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
    delete kept[k]
  }
  for (const s of servers.splice(0)) s.stop(true)
})
/** This process takes the sandbox's herdr, folders and pace, as a board started in it would. */
function into(box: Sandbox): void {
  const vars = { ...box.env, BOARD_TEST_PACE: '0.02', CLAUDE_CODE_SESSION_ID: '' }
  for (const [k, v] of Object.entries(vars)) {
    if (k === 'PATH' || k === 'TZ') continue
    if (!(k in kept)) kept[k] = process.env[k]
    process.env[k] = v
  }
}

const READY = { result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude', agent_status: 'idle' } } }
const HERDR = {
  'api snapshot': {
    result: { snapshot: { panes: [], tabs: [], workspaces: [{ workspace_id: 'wA', label: 'Alpha' }] } },
  },
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9' } } },
  'tab rename': { result: null },
  'pane get': READY,
  'pane run': { result: null },
  'agent list': { result: { agents: [] } },
  'agent prompt': { result: null },
  'agent rename': { result: null },
  'pane read': { text: 'Session renamed to: Gamma job' },
}

/** One start from the board's New session, the board's config with `nodes` or without: what the child was given, what the board heard. */
async function startOnce(nodes: boolean) {
  const requests: string[] = []
  const board = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      requests.push(`${req.method} ${new URL(req.url).pathname}`)
      return Response.json({ items: [], launches: [] })
    },
  })
  servers.push(board)
  const box = await sandbox()
  box.state(HERDR)
  into(box)
  const launch = { claude: ['claude', '--continue'] }
  // What the child reads: a master's config, with the board's port.
  const cfgDir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ language: 'en', port: board.port, nodes: {}, launch }))
  const dir = join(box.dir, 'Gamma')
  mkdirSync(dir)
  const home = box.env.HOME ?? ''
  mkdirSync(join(home, '.claude'), { recursive: true })
  // Loaded after the env is the sandbox's: herdr's binary is read once.
  const { createLaunches } = await import('../../src/services/launch/launches.ts')
  const processes = await import('../../src/adapters/process.ts')
  const runs = spyOn(processes, 'runTree')
  const { normalizeConfig } = await import('../../src/core/categories.ts')
  const { mergeProfiles, profileSet } = await import('../../src/core/profiles.ts')
  const cfg = normalizeConfig({ categories: [], wakeUrl: null, launch, ...(nodes && { nodes: {} }) })
  const profiles = profileSet(mergeProfiles([], [], home).list, join(home, '.claude'))
  const deps = { cfg, profiles: () => profiles, log: () => {} } as unknown as Parameters<
    typeof createLaunches
  >[0]['deps']
  const launches = createLaunches({ deps })
  const r = await launches.start(
    { name: 'Gamma job', cwd: dir, workspace: { id: 'wA', label: 'Alpha' }, message: 'Go.' },
    [],
  )
  assert.ok(r.ok, JSON.stringify(r))
  await until(() => ['done', 'failed'].includes(launches.list()[0]?.state ?? ''), 20_000)
  const l = launches.list()[0]
  assert.equal(l?.state, 'done', l?.error ?? '')
  // The child started it here, as the board asked: the line picks its own session, so no id went with it.
  assert.equal(box.calls().find(a => a[0] === 'pane' && a[1] === 'run')?.[3], 'claude --continue')
  assert.deepEqual(requests, [])
  const child = runs.mock.calls.find(c => String(c[1]?.[0] ?? '').endsWith('spawn-agent.ts'))
  runs.mockRestore()
  assert.ok(child, 'the launcher ran spawn-agent')
  return { args: child[1], env: child[2]?.env ?? {}, requests }
}

test('the spawn-agent the board’s launcher runs does not come back to the board, with no --session-id to tell it', async () => {
  const child = await startOnce(true)
  // The child is the board's by its arguments and by the mark the launcher puts in its env.
  assert.ok(child.args.includes('--keep-env'), child.args.join(' '))
  assert.equal(child.args.includes('--session-id'), false)
  assert.equal(child.env.BOARD_SPAWN_CHILD, '1')
  assert.deepEqual(child.requests, [])
}, 40_000)

test('without nodes the child’s env carries no mark: the launcher runs it as before', async () => {
  const child = await startOnce(false)
  assert.equal('BOARD_SPAWN_CHILD' in child.env, false)
  assert.deepEqual(child.requests, [])
}, 40_000)
