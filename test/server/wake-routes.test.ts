// Settings → Sleep and wake… end to end (#119): the panel's switches edit config.json, Start and
// Start again call wake's start (a recorder here: runner.ts), and the payload carries the state
// line. With wake off nothing is started; with no wake file either, the payload says only that it is
// off (before wake shipped it had no wake field then).
import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WAKE_SHIPPED } from '../../src/core/wake/config.ts'
import { type BoardMessage, serveBoard, unusedPort } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { type Child, root, type Sandbox, sandbox, until } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

const configDir = (box: Sandbox): string => join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
const stateDir = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
const configOf = (box: Sandbox): Record<string, unknown> =>
  JSON.parse(readFileSync(join(configDir(box), 'config.json'), 'utf8'))
function config(box: Sandbox, cfg: Record<string, unknown>): void {
  mkdirSync(configDir(box), { recursive: true })
  writeFileSync(join(configDir(box), 'config.json'), JSON.stringify({ language: 'en', ...cfg }))
}
function stateFile(box: Sandbox, name: string, text: string): void {
  mkdirSync(stateDir(box), { recursive: true })
  writeFileSync(join(stateDir(box), name), text)
}
const EMPTY = { result: { snapshot: { workspaces: [], tabs: [], panes: [] } } }
const starts = (proc: Child): unknown[] =>
  proc.messages.flatMap(m =>
    (m as { wakeStarted?: unknown }).wakeStarted ? [(m as { wakeStarted: unknown }).wakeStarted] : [],
  )

/** Until `fn` says so (it may ask the board); an error after `timeout` ms. */
async function eventually(fn: () => Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the board')
    await Bun.sleep(25)
  }
}
const wakeOf = async (url: string): Promise<Record<string, unknown> | undefined> =>
  (await payload(url)).wake as Record<string, unknown> | undefined

/** The board's payload once it refreshed. */
async function payload(url: string): Promise<Record<string, unknown>> {
  for (let tries = 0; ; tries++) {
    const board = (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
    if (!board.stale) return board
    if (tries > 200) throw new Error('the board did not refresh')
    await Bun.sleep(25)
  }
}

test('the panel’s switches edit config.json; Start and Start again call the starter; the payload carries the state line', async () => {
  const box = await sandbox()
  box.state({ 'api snapshot': EMPTY })
  // Wake answering on its port, its status file saying it runs.
  const wake = await fakeWake()
  const at = Date.now() - 60_000
  stateFile(box, 'wake-status.json', JSON.stringify({ state: 'running', at, pid: 4242, port: wake.port }))
  stateFile(box, 'wake.log', 'one\ntwo\n')
  config(box, { wakeUrl: null, refreshSec: 3600, wake: { enabled: false, port: wake.port, future: 1 } })
  const { url, proc } = await serveBoard(box, {}, { TEST_LIVE_CONFIG: '1' })
  const post = (body: unknown, headers: Record<string, string> = { 'x-board': '1' }) =>
    fetch(`${url}/api/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  const reloaded = (): number => proc.messages.filter(m => (m as { reloaded?: boolean }).reloaded).length

  // Off: its state, and no start.
  const panel = (await (await fetch(`${url}/api/wake`)).json()) as {
    view: Record<string, unknown>
    settings: Record<string, unknown>
  }
  assert.deepEqual(panel.view, { on: false, state: 'off', since: null, asleep: 0, port: wake.port, downSince: null })
  assert.equal(panel.settings.telegram, 'off')
  assert.equal(panel.settings.log, join(stateDir(box), 'wake.log'))
  assert.deepEqual(starts(proc), [])

  // On: config.json says so, its other fields kept; wake answers, so nothing to start.
  let seen = reloaded()
  assert.deepEqual(await (await post({ op: 'on' })).json(), { ok: true })
  assert.deepEqual(configOf(box).wake, { enabled: true, port: wake.port, future: 1 })
  await until(() => reloaded() > seen)
  await eventually(async () => (await wakeOf(url))?.state === 'running')
  assert.deepEqual(await wakeOf(url), {
    on: true,
    state: 'running',
    since: at,
    asleep: 0,
    port: wake.port,
    downSince: null,
  })
  assert.deepEqual(starts(proc), [])

  // The reaper and Telegram.
  assert.equal(
    (await post({ op: 'reaper', enabled: true, idleMinutes: 30, exclude: ['Billing', 'Проект x 50%'] })).status,
    200,
  )
  assert.equal((await post({ op: 'telegram', mode: 'auto' })).status, 200)
  const bad = await post({ op: 'telegram', mode: 'sometimes' })
  assert.deepEqual(
    [bad.status, await bad.json()],
    [409, { ok: false, error: 'Telegram messages (tg-mcp): auto or off' }],
  )
  assert.deepEqual(configOf(box).wake, {
    enabled: true,
    port: wake.port,
    future: 1,
    reaper: { enabled: true, idleMinutes: 30, exclude: ['Billing', 'Проект x 50%'] },
    telegram: 'auto',
  })

  // Start while it answers: nothing to do. Start again: always.
  assert.deepEqual(await (await post({ op: 'start' })).json(), { ok: true })
  assert.deepEqual(starts(proc), [])
  assert.deepEqual(await (await post({ op: 'again' })).json(), { ok: true })
  assert.deepEqual(starts(proc), [['--again']])
  // Down: Start starts it.
  wake.down()
  assert.deepEqual(await (await post({ op: 'start' })).json(), { ok: true })
  assert.deepEqual(starts(proc), [['--again'], []])

  // Log.
  assert.deepEqual(await (await post({ op: 'log' })).json(), { ok: true, text: 'one\ntwo' })

  // Only from the board's own page.
  assert.equal((await post({ op: 'off' }, {})).status, 403)
  assert.equal((await post({ op: 'off' }, { 'x-board': '1', origin: 'https://evil.example' })).status, 403)
  assert.equal(configOf(box).wake && (configOf(box).wake as { enabled: boolean }).enabled, true)
  assert.deepEqual(await (await post({ op: 'nothing' })).json(), { ok: false, error: 'unknown op nothing' })

  // Off.
  seen = reloaded()
  assert.deepEqual(await (await post({ op: 'off' })).json(), { ok: true })
  assert.equal((configOf(box).wake as { enabled: boolean }).enabled, false)
  await until(() => reloaded() > seen)
  assert.deepEqual(starts(proc), [['--again'], []])
  // None of it asked herdr for more than the board's own snapshot.
  assert.deepEqual([...new Set(box.calls().map(c => c.join(' ')))], ['api snapshot'])
})

test('turned on in config.json by hand: started at once', async () => {
  const box = await sandbox()
  box.state({ 'api snapshot': EMPTY })
  const wakePort = await unusedPort()
  config(box, { wakeUrl: null, refreshSec: 3600, wake: false })
  const { proc } = await serveBoard(box, {}, { TEST_LIVE_CONFIG: '1' })
  await Bun.sleep(300)
  assert.deepEqual(starts(proc), [])
  config(box, { wakeUrl: null, refreshSec: 3600, wake: { enabled: true, port: wakePort } })
  await until(() => starts(proc).length > 0)
  assert.deepEqual(starts(proc), [[]])
})

test('wake on in config.json when the board starts, not running: started once', async () => {
  const box = await sandbox()
  box.state({ 'api snapshot': EMPTY })
  const { url, proc } = await serveBoard(box, { language: 'en', wake: { enabled: true, port: await unusedPort() } })
  await until(() => starts(proc).length > 0)
  assert.deepEqual(starts(proc), [[]])
  // The recorder writes no status file: on, not running, since the board first saw it so.
  await eventually(async () => (await wakeOf(url))?.state === 'notRunning')
  assert.deepEqual(await wakeOf(url), {
    on: true,
    state: 'notRunning',
    since: null,
    asleep: 0,
    port: (await wakeOf(url))?.port,
    downSince: (await wakeOf(url))?.downSince,
  })
  assert.equal(typeof (await wakeOf(url))?.downSince, 'number')
  await Bun.sleep(200)
  assert.deepEqual(starts(proc), [[]])
})

test('wake’s state changes: "Setup incomplete" follows at once, not at the next check in 10 minutes', async () => {
  const box = await sandbox()
  box.state({ 'api snapshot': EMPTY })
  // Wake on, not running yet (nothing on its port, no status file): the first check counts it.
  const wake = await fakeWake()
  wake.down()
  const { url, proc } = await serveBoard(box, {
    language: 'en',
    wakeUrl: null,
    wake: { enabled: true, port: wake.port },
  })
  /** The setup note's wake line, after a refresh of the board (its payload asks wake's state again once 2 s old). */
  const wakeLine = async (): Promise<string | undefined> => {
    proc.send('refresh')
    await Bun.sleep(200)
    const setup = (await payload(url)).setup as { sig?: string } | null
    return setup?.sig?.split('|').find(s => s.startsWith('wake:'))
  }
  await eventually(async () => (await wakeLine())?.startsWith('wake:warn:') === true, 10_000)
  // Wake comes up: its state line says it runs, and the setup note drops it.
  stateFile(box, 'wake-status.json', JSON.stringify({ state: 'running', at: Date.now(), pid: 4242, port: wake.port }))
  wake.up()
  await eventually(async () => {
    proc.send('refresh')
    await Bun.sleep(200)
    return (await wakeOf(url))?.state === 'running'
  }, 10_000)
  await eventually(async () => (await wakeLine()) === undefined, 5000)
})

test.skipIf(WAKE_SHIPPED)(
  'with wake off ("wake": false) and no wake file the payload has no wake field and nothing is started',
  async () => {
    const box = await sandbox()
    box.state({ 'api snapshot': EMPTY })
    const { url, proc } = await serveBoard(box, { language: 'en', wake: false })
    const board = await payload(url)
    await Bun.sleep(200)
    assert.equal('wake' in board, false)
    assert.equal('wake' in (await payload(url)), false)
    assert.deepEqual(starts(proc), [])
    assert.ok(!proc.messages.some(m => (m as BoardMessage).log?.includes('wake')))
  },
)

// Once wake ships, its Settings item is there whatever the switch says: off, the payload says so.
test.skipIf(!WAKE_SHIPPED)(
  'with wake off ("wake": false) and no wake file the payload says it is off, and nothing is started or asked',
  async () => {
    const box = await sandbox()
    box.state({ 'api snapshot': EMPTY })
    const { url, proc } = await serveBoard(box, { language: 'en', wake: false })
    await eventually(async () => (await wakeOf(url))?.state === 'off')
    await Bun.sleep(200)
    assert.deepEqual(await wakeOf(url), {
      on: false,
      state: 'off',
      since: null,
      asleep: 0,
      port: 12421,
      downSince: null,
    })
    assert.deepEqual(starts(proc), [])
    assert.ok(!proc.messages.some(m => (m as BoardMessage).log?.includes('wake')))
    assert.deepEqual([...new Set(box.calls().map(c => c.join(' ')))], ['api snapshot'])
  },
)

test('with wake off ("wake": false) and sessions asleep in its file, the payload says it is off and how many', async () => {
  const box = await sandbox()
  box.state({
    'api snapshot': {
      result: { snapshot: { workspaces: [], tabs: [], panes: [{ pane_id: 'w1:p2', cwd: box.dir }] } },
    },
  })
  stateFile(
    box,
    'wake-sessions.json',
    JSON.stringify({ 'w1:p2': { session: 's-bill', name: 'Billing', seen_at: 1, slept_at: 2 } }),
  )
  const { url, proc } = await serveBoard(box, { language: 'en', wake: false })
  await eventually(async () => (await wakeOf(url))?.asleep === 1)
  assert.deepEqual(await wakeOf(url), { on: false, state: 'off', since: null, asleep: 1, port: 12421, downSince: null })
  assert.deepEqual(starts(proc), [])
})

test.skipIf(WAKE_SHIPPED)(
  'with no wake key and no wake file the board alone sends no wake field and starts nothing (dormant)',
  async () => {
    const box = await sandbox()
    box.state({ 'api snapshot': EMPTY })
    const port = await unusedPort()
    config(box, { port, wakeUrl: null, refreshSec: 3600 })
    // The real entrypoint, with the real starter: no runner in between.
    const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'server.ts')], {
      cwd: root,
      env: box.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const url = `http://127.0.0.1:${port}`
      await eventually(async () => {
        try {
          return !((await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }).stale
        } catch {
          return false
        }
      }, 15_000)
      await Bun.sleep(300)
      assert.equal('wake' in (await payload(url)), false)
      assert.deepEqual([...new Set(box.calls().map(c => c.join(' ')))], ['api snapshot'])
    } finally {
      proc.kill()
      await proc.exited
    }
  },
)

test('Switch over, while the old plugin holds wake: taken over, uninstalled, wake started past the held record; only from the board’s own page', async () => {
  const box = await sandbox()
  const port = await unusedPort()
  const oldConfigDir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'herdr-wake')
  const oldStateDir = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'herdr-wake')
  mkdirSync(oldConfigDir, { recursive: true })
  mkdirSync(oldStateDir, { recursive: true })
  writeFileSync(
    join(oldConfigDir, 'config.json'),
    JSON.stringify({
      port,
      wakeCommand: 'claude-tg --resume {session}',
      reaper: { enabled: true, idleMinutes: 60, exclude: ['Billing', 'Проект x 50%'] },
    }),
  )
  writeFileSync(
    join(oldStateDir, 'sessions.json'),
    JSON.stringify({ 'w1:p2': { session: 's-bill', name: 'Billing', seen_at: 1, slept_at: 2 } }),
  )
  const profile = join(box.env.HOME as string, '.claude')
  const hook = (mode: string) => `node "${join(oldConfigDir, 'hook.mjs')}" ${mode}`
  mkdirSync(profile, { recursive: true })
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'SendMessage', hooks: [{ type: 'command', command: hook('pre-send') }] }] },
    }),
  )
  stateFile(box, 'wake-status.json', JSON.stringify({ state: 'held', at: Date.now() }))
  config(box, { wakeUrl: null, refreshSec: 3600, wake: { enabled: true, port } })
  const listed = (ids: string[]) => ({
    result: { type: 'plugin_list', plugins: ids.map(plugin_id => ({ plugin_id })) },
  })
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          workspaces: [{ workspace_id: 'wT', label: 'tg-router' }],
          tabs: [{ tab_id: 'tT', workspace_id: 'wT' }],
          panes: [{ pane_id: 'wT:p1', tab_id: 'tT', workspace_id: 'wT', cwd: box.dir }],
        },
      },
    },
    'plugin list': {
      ...listed(['agent-board', 'herdr-wake']),
      until: ['plugin uninstall'],
      // biome-ignore lint/suspicious/noThenProperty: the fake herdr's reply after the uninstall (test/support/fake-herdr.ts)
      then: listed(['agent-board']),
    },
    'plugin uninstall': { result: null },
    'workspace close': { result: null },
  })
  const { url, proc } = await serveBoard(box, {}, { TEST_LIVE_CONFIG: '1' })
  await eventually(async () => (await wakeOf(url))?.state === 'held')
  const post = (body: unknown, headers: Record<string, string> = { 'x-board': '1' }) =>
    fetch(`${url}/api/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  // Not from another page: nothing asked, nothing changed.
  assert.equal((await post({ op: 'switch' }, {})).status, 403)
  assert.equal((await post({ op: 'switch' }, { 'x-board': '1', origin: 'https://evil.example' })).status, 403)
  assert.deepEqual([...new Set(box.calls().map(c => c.join(' ')))], ['api snapshot'])

  const res = await post({ op: 'switch' })
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(res.status, 200)
  assert.deepEqual(
    { ...body, did: undefined },
    {
      ok: true,
      did: undefined,
      summary: { reaper: 'on', minutes: 60, excluded: 2, telegram: false, asleep: 1 },
      launcher: { old: 'claude-tg', now: 'claude' },
      bindings: [],
    },
  )
  assert.deepEqual(
    box
      .calls()
      .map(c => c.join(' '))
      .filter(c => c !== 'api snapshot'),
    ['plugin list --json', 'plugin uninstall herdr-wake', 'plugin list --json', 'workspace close wT'],
  )
  assert.deepEqual(configOf(box).wake, {
    enabled: true,
    port,
    reaper: { enabled: true, idleMinutes: 60, exclude: ['Billing', 'Проект x 50%'] },
  })
  assert.ok(readFileSync(join(profile, 'settings.json'), 'utf8').includes('wake-hook.ts'))
  assert.ok(existsSync(join(profile, 'settings.json.bak-wake-takeover')))
  // Wake's start, once, though its record still said held.
  await until(() => starts(proc).length > 0)
  await Bun.sleep(200)
  assert.deepEqual(starts(proc), [[]])
})
