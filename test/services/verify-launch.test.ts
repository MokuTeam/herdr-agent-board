// A verifier's start on a board with `nodes` (#492 on #504): the placer is skipped, and the start runs
// on this computer, in the worker's folder, under the session id the board chose; any other new
// start still goes to the placer. The launch pipeline in this process against a sandbox's fake herdr.
import { afterEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'

const kept: Record<string, string | undefined> = {}
afterEach(() => {
  for (const [k, v] of Object.entries(kept)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
    delete kept[k]
  }
})
function into(box: Sandbox): void {
  const vars = { ...box.env, BOARD_TEST_PACE: '0.02' }
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
  'pane read': { text: 'Session renamed to: verify-atlas-1' },
}

test('with nodes a verifier is never placed: it starts here under the board’s session id; another start goes to the placer', async () => {
  const box = await sandbox()
  box.state(HERDR)
  into(box)
  const dir = join(box.dir, 'Atlas work')
  mkdirSync(dir, { recursive: true })
  const home = box.env.HOME ?? ''
  mkdirSync(join(home, '.claude'), { recursive: true })
  const { createLaunches } = await import('../../src/services/launch/launches.ts')
  const { normalizeConfig } = await import('../../src/core/categories.ts')
  const { mergeProfiles, profileSet } = await import('../../src/core/profiles.ts')
  const cfg = normalizeConfig({
    categories: [{ id: 'atlas', title: 'Atlas', color: 'blue', paths: [] }],
    wakeUrl: null,
    nodes: { devices: [] },
  })
  const profiles = profileSet(mergeProfiles([], [], home).list, join(home, '.claude'))
  const deps = { cfg, profiles: () => profiles, log: () => {} } as unknown as Parameters<
    typeof createLaunches
  >[0]['deps']
  const taken: string[] = []
  const placer = {
    take: (l: { name: string }) => {
      taken.push(l.name)
    },
    cancel: () => {},
    shown: () => false,
    observe: () => {},
  }
  const launches = createLaunches({ deps, placer: () => placer })
  const id = '44444444-4444-4444-8444-444444444444'
  const body = {
    name: 'verify-atlas-1',
    cwd: dir,
    category: 'atlas',
    workspace: { id: 'wA', label: 'Alpha' },
    message: 'Check.',
  }
  const r = await launches.start(body, [], { sessionId: id, byHand: false })
  assert.ok(r.ok, JSON.stringify(r))
  assert.equal('session' in r, false)
  await until(() => ['done', 'failed'].includes(launches.state(r.id)?.state ?? ''), 20_000)
  assert.equal(launches.state(r.id)?.state, 'done', launches.state(r.id)?.error ?? '')
  assert.deepEqual(taken, [])
  assert.deepEqual(
    box.calls().find(a => a[0] === 'tab' && a[1] === 'create'),
    ['tab', 'create', '--workspace', 'wA', '--cwd', dir, '--label', 'verify-atlas-1', '--no-focus'],
  )
  assert.equal(box.calls().find(a => a[0] === 'pane' && a[1] === 'run')?.[3], `claude --session-id ${id}`)
  assert.equal(launches.state(r.id)?.sessionId, id)
  // Any other new start is the placer's, as on main.
  const other = await launches.start({ ...body, name: 'Gamma job' }, [])
  assert.ok(other.ok, JSON.stringify(other))
  assert.deepEqual(taken, ['Gamma job'])
}, 40_000)
