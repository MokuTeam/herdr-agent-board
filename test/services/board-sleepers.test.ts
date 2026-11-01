// The board's sleeping sessions (#119, calls 10 and 28). With wake off and no wake file, the board
// makes today's calls and shows today's items. With wake off and sessions asleep in wake's file,
// their cards stay, in the workspace herdr shows their pane in; one whose pane runs Claude again,
// or is gone, is not shown.
import { expect, setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { saveWakeSessions, writeWakeStatus } from '../../src/adapters/wake-files.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import { WAKE_SHIPPED } from '../../src/core/wake/config.ts'
import { sharedHerdrWake } from '../../src/integrations/herdr-wake.ts'
import { defaultDeps } from '../../src/services/deps.ts'
import { serveBoard } from '../support/board-server.ts'
import { isolatedHome } from '../support/env.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

const SLEPT = Date.UTC(2026, 9, 21, 8)
const configDir = (box: Sandbox): string => join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
const stateDir = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')

function config(box: Sandbox, cfg: Record<string, unknown>): void {
  mkdirSync(configDir(box), { recursive: true })
  writeFileSync(join(configDir(box), 'config.json'), JSON.stringify({ language: 'en', ...cfg }))
}
function wakeFile(box: Sandbox, sessions: unknown): void {
  mkdirSync(stateDir(box), { recursive: true })
  writeFileSync(join(stateDir(box), 'wake-sessions.json'), JSON.stringify(sessions))
}

/** herdr's view: a running session, a shell where one went to sleep, a pane running Claude again. */
function herdrState(box: Sandbox): void {
  const snapshot = {
    workspaces: [
      { workspace_id: 'w1', label: 'Work stuff' },
      { workspace_id: 'w2', label: 'Проект x 50%' },
    ],
    tabs: [
      { tab_id: 't1', workspace_id: 'w1' },
      { tab_id: 't2', workspace_id: 'w2' },
    ],
    panes: [
      {
        pane_id: 'w1:p1',
        tab_id: 't1',
        workspace_id: 'w1',
        agent: 'claude',
        agent_session: { value: 's-run' },
        agent_status: 'idle',
        cwd: box.dir,
        terminal_title_stripped: 'Running',
      },
      { pane_id: 'w1:p2', tab_id: 't1', workspace_id: 'w1', cwd: box.dir },
      {
        pane_id: 'w2:p3',
        tab_id: 't2',
        workspace_id: 'w2',
        agent: 'claude',
        agent_session: { value: 's-back' },
        agent_status: 'working',
        cwd: box.dir,
        terminal_title_stripped: 'Back again',
      },
    ],
  }
  box.state({ 'api snapshot': { result: { snapshot } } })
}

async function boardList(box: Sandbox): Promise<string[]> {
  const out = await box.run('cli', { args: ['list'], env: {} }).exited
  assert.equal(out.code, 0, out.stderr)
  return out.stdout.trim().split('\n')
}

// What `board list` printed for this test against main's services/deps.ts and services/board.ts
// (run there once, as AGENTS.md says).
const TODAY = ['Back again [other] Working', 'Old sleeper [other] Idle (asleep)', 'Running [other] Idle']

for (const [name, wake] of [
  ['no wake key', undefined],
  ['"wake": false', false],
] as const)
  test.skipIf(wake === undefined && WAKE_SHIPPED)(
    `with wake off (${name}) and no wake file, the board’s calls are today’s`,
    async () => {
      const box = await sandbox()
      herdrState(box)
      const old = await fakeWake({
        sleeping: [
          {
            name: 'Old sleeper',
            pane: 'w1:p2',
            session: 's-old',
            workspace: 'Work stuff',
            slept_at: '2026-10-21T08:00:00Z',
          },
        ],
      })
      config(box, { wakeUrl: old.url, ...(wake === undefined ? {} : { wake }) })
      assert.deepEqual(await boardList(box), TODAY)
      assert.deepEqual(box.calls(), [['api', 'snapshot']])
      assert.deepEqual(old.requests(), [{ method: 'GET', path: '/sleeping', body: null }])
    },
  )

/** The board's items as the page gets them. */
async function boardItems(box: Sandbox, cfg: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const { url } = await serveBoard(box, cfg)
  for (let tries = 0; ; tries++) {
    const board = (await (await fetch(`${url}/api/board`)).json()) as {
      stale: boolean
      items: Record<string, unknown>[]
    }
    if (!board.stale) return board.items
    if (tries > 200) throw new Error('the board did not refresh')
    await Bun.sleep(25)
  }
}

test('wake off with sessions asleep in its file: their cards stay, workspace from the snapshot', async () => {
  const box = await sandbox()
  herdrState(box)
  const old = await fakeWake({ sleeping: [] })
  const work = join(box.dir, 'home', '.claude-work 100%')
  wakeFile(box, {
    'w1:p2': {
      session: 's-bill',
      name: 'Billing',
      cwd: box.dir,
      seen_at: SLEPT - 60_000,
      slept_at: SLEPT,
      profileDir: work,
      profile: 'work',
    },
    'w1:p1': { session: 's-run', name: 'Running', seen_at: SLEPT },
  })
  config(box, { wakeUrl: old.url, wake: false })
  const items = await boardItems(box, { language: 'en', wakeUrl: old.url, wake: false })
  const billing = items.find(i => i.key === 's-bill')
  assert.deepEqual(
    {
      pane: billing?.pane,
      workspace: billing?.workspace,
      name: billing?.name,
      status: billing?.status,
      sleeping: billing?.sleeping,
      fromFile: billing?.fromFile,
      activity: billing?.activity,
    },
    {
      pane: 'w1:p2',
      workspace: 'Work stuff',
      name: 'Billing',
      status: 'sleeping',
      sleeping: true,
      fromFile: true,
      activity: SLEPT,
    },
  )
  assert.deepEqual(items.map(i => i.key).sort(), ['s-back', 's-bill', 's-run'])
  // The running one is not marked; the old wake was still asked, as today.
  assert.equal(items.find(i => i.key === 's-run')?.fromFile, undefined)
  assert.ok(old.requests().some(r => r.path === '/sleeping'))
})

test('a file sleeper whose pane runs Claude again, or is gone, is not shown', async () => {
  const box = await sandbox()
  herdrState(box)
  const old = await fakeWake({ sleeping: [] })
  wakeFile(box, {
    'w2:p3': { session: 's-before', name: 'Before', seen_at: SLEPT - 60_000, slept_at: SLEPT },
    'w9:p9': { session: 's-gone', name: 'Gone', seen_at: SLEPT - 60_000, slept_at: SLEPT },
    'w1:p2': { session: 's-bill', name: 'Billing', seen_at: SLEPT - 60_000, slept_at: SLEPT, exited: true },
  })
  config(box, { wakeUrl: old.url, wake: false })
  const items = await boardItems(box, { language: 'en', wakeUrl: old.url, wake: false })
  assert.deepEqual(items.map(i => i.key).sort(), ['s-back', 's-bill', 's-run'])
  assert.equal(items.find(i => i.key === 's-bill')?.workspace, 'Work stuff')
})

test('#204: a file sleeper whose pane wake closed is shown without a pane, its workspace and folder the file’s', async () => {
  const box = await sandbox()
  herdrState(box)
  const old = await fakeWake({ sleeping: [] })
  const freed = {
    pane: 'w1:p7',
    workspace: 'w1',
    workspaceLabel: 'Billing room',
    topic: 'topic:Billing room',
    at: SLEPT,
  }
  wakeFile(box, {
    's-free': { session: 's-free', name: 'Freed', cwd: box.dir, seen_at: SLEPT - 60_000, slept_at: SLEPT, freed },
    // One that runs again shows as running, once.
    's-run': { session: 's-run', name: 'Running', seen_at: SLEPT - 60_000, slept_at: SLEPT, freed },
  })
  config(box, { wakeUrl: old.url, wake: false })
  const items = await boardItems(box, { language: 'en', wakeUrl: old.url, wake: false })
  const one = items.find(i => i.key === 's-free')
  assert.deepEqual(
    [one?.pane, one?.workspace, one?.cwd, one?.status, one?.sleeping, one?.fromFile],
    [null, 'Billing room', box.dir, 'sleeping', true, true],
  )
  assert.deepEqual(items.map(i => i.key).sort(), ['s-back', 's-free', 's-run'])
  assert.equal(items.find(i => i.key === 's-run')?.sleeping, false)
})

test('the old wake’s own sleepers are not filtered: today’s list stays as it was', async () => {
  const box = await sandbox()
  herdrState(box)
  // herdr-wake lists one whose pane is gone: shown as today (only the file's are checked).
  const old = await fakeWake({
    sleeping: [
      { name: 'Elsewhere', pane: 'w9:p9', session: 's-else', workspace: 'Old', slept_at: '2026-10-21T08:00:00Z' },
    ],
  })
  wakeFile(box, { 'w9:p9': { session: 's-else', name: 'Elsewhere', seen_at: 1, slept_at: 2 } })
  config(box, { wakeUrl: old.url, wake: false })
  const items = await boardItems(box, { language: 'en', wakeUrl: old.url, wake: false })
  const elsewhere = items.find(i => i.key === 's-else')
  assert.equal(elsewhere?.workspace, 'Old')
  assert.equal(elsewhere?.fromFile, undefined)
})

test('the provider: today’s own with wake off and no wake file; the file’s sleepers added with one; the new wake once its start ran', async () => {
  isolatedHome()
  const OLD = 'http://127.0.0.1:12421'
  const cfg = normalizeConfig({ wakeUrl: OLD, wake: false })
  const deps = defaultDeps(cfg)
  expect(deps.wake).toBe(sharedHerdrWake(OLD))
  // A wake file: the same provider wrapped once, each read giving the same one.
  saveWakeSessions({ 'w1:p2': { session: 's-bill', name: 'Billing', seen_at: 1, slept_at: 2 } })
  const withFile = deps.wake
  expect(withFile).not.toBe(sharedHerdrWake(OLD))
  expect(deps.wake).toBe(withFile)
  // On, its start not run yet (no status file): the old path, without the file's sleepers.
  cfg.wake = { enabled: true, port: 23456 }
  expect(deps.wake).toBe(sharedHerdrWake(OLD))
  // Its start ran: the new wake at its port, one for every caller, once the status file is looked
  // at again (at most once a second).
  writeWakeStatus({ state: 'starting', at: Date.now() })
  expect(deps.wake).toBe(sharedHerdrWake(OLD))
  await Bun.sleep(1001)
  const later = defaultDeps(cfg)
  expect(later.wake).toMatchObject({ mode: 'new' })
  expect(later.wake).toBe(later.wake)
  // Off again: today's, with the file's sleepers.
  cfg.wake = false
  expect(later.wake).toBe(withFile)
})
