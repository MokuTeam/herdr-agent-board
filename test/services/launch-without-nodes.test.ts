// A start on a board without `nodes` (#504, docs/design/nodes 17): the launch pipeline in this
// process, against a sandbox's fake herdr, with every way a program starts and fetch spied. It runs
// no git command and no fetch, and its tab is created with the arguments it had before the placer.
import { afterEach, spyOn, test } from 'bun:test'
import assert from 'node:assert/strict'
import * as childProcess from 'node:child_process'
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
/** This process takes the sandbox's herdr, folders and pace, as a board started in it would. */
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
  'pane read': { text: 'Session renamed to: Gamma job' },
}

test('without nodes a start runs no git command and no fetch, and its tab is created with main’s arguments', async () => {
  const box = await sandbox()
  box.state(HERDR)
  into(box)
  const dir = join(box.dir, 'Gamma')
  mkdirSync(join(dir, '.git'), { recursive: true }) // a checkout's look: still nothing asks git about it
  const home = box.env.HOME ?? ''
  mkdirSync(join(home, '.claude'), { recursive: true })
  // Loaded after the env is the sandbox's: herdr's binary is read once.
  const { createLaunches } = await import('../../src/services/launch/launches.ts')
  const { normalizeConfig } = await import('../../src/core/categories.ts')
  const { mergeProfiles, profileSet } = await import('../../src/core/profiles.ts')
  const cfg = normalizeConfig({ categories: [{ id: 'acme', title: 'Acme', color: 'blue', paths: [] }], wakeUrl: null })
  const own = join(home, '.claude')
  const profiles = profileSet(mergeProfiles([], [], home).list, own)
  const deps = { cfg, profiles: () => profiles, log: () => {} } as unknown as Parameters<
    typeof createLaunches
  >[0]['deps']

  const execs = spyOn(childProcess, 'execFile')
  const spawns = spyOn(childProcess, 'spawn')
  const bunSpawns = spyOn(Bun, 'spawn')
  const fetches = spyOn(globalThis, 'fetch')
  try {
    const launches = createLaunches({ deps })
    const r = await launches.start(
      { name: 'Gamma job', cwd: dir, category: 'acme', workspace: { id: 'wA', label: 'Alpha' }, message: 'Go.' },
      [],
    )
    assert.ok(r.ok, JSON.stringify(r))
    await until(() => ['done', 'failed'].includes(launches.list()[0]?.state ?? ''), 20_000)
    const l = launches.list()[0]
    assert.equal(l?.state, 'done', l?.error ?? '')
    // The fields a placed start adds are not there.
    assert.equal(l && 'place' in l, false)
    assert.deepEqual(
      box.calls().find(a => a[0] === 'tab' && a[1] === 'create'),
      ['tab', 'create', '--workspace', 'wA', '--cwd', dir, '--label', 'Gamma job', '--no-focus'],
    )
    assert.match(
      box.calls().find(a => a[0] === 'pane' && a[1] === 'run')?.[3] ?? '',
      /^claude --session-id [0-9a-f-]{36}$/,
    )
    const programs = [
      ...execs.mock.calls.map(c => String(c[0])),
      ...spawns.mock.calls.map(c => String(c[0])),
      ...bunSpawns.mock.calls.map(c => String(Array.isArray(c[0]) ? c[0][0] : (c[0] as { cmd?: string[] }).cmd?.[0])),
    ]
    // The spies saw the start's own programs (spawn-agent, herdr), so seeing no git means none ran.
    assert.ok(
      programs.some(p => p === process.execPath),
      programs.join('\n'),
    )
    assert.deepEqual(
      programs.filter(p => /(^|[\\/])git(\.exe|\.cmd)?$/i.test(p)),
      [],
    )
    assert.equal(fetches.mock.calls.length, 0)
  } finally {
    execs.mockRestore()
    spawns.mockRestore()
    bunSpawns.mockRestore()
    fetches.mockRestore()
  }
}, 40_000)
