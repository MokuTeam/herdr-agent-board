// Wake's control on the board (#119): its state for the panel and the payload, its switches, Start,
// Start again and Log, and starting it once when it is on but not running (safeguard 3).
import { expect, onTestFinished, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { configFile } from '../../src/adapters/config-file.ts'
import { boardFile, configDir, ROOT } from '../../src/adapters/paths.ts'
import { wakeLogFile, wakeStatusFile, writeWakeStatus } from '../../src/adapters/wake-files.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import { useLanguage } from '../../src/core/lang.ts'
import type { Config } from '../../src/core/types.ts'
import { WAKE_PORT, WAKE_SHIPPED } from '../../src/core/wake/config.ts'
import type { WakeView } from '../../src/core/wake/view.ts'
import { closeWakeWorkspace, createWakeControl } from '../../src/services/wake/control.ts'
import { isolatedHome } from '../support/env.ts'
import { until } from '../support/sandbox.ts'

// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')
const PORT = 23456
const on = (extra: Record<string, unknown> = {}): Config =>
  normalizeConfig({ wake: { enabled: true, port: PORT, ...extra } })
const off = (): Config => normalizeConfig({ wake: false })

/** A control with a recording starter and a wake that answers as the test says. */
function control(cfg: Config, o: { answers?: boolean; now?: () => number; herdr?: (args: string[]) => unknown } = {}) {
  const started: string[][] = []
  const asked = { answers: 0 }
  const herdrCalls: string[][] = []
  const c = createWakeControl({
    cfg,
    answers: async () => {
      asked.answers++
      return o.answers ?? false
    },
    starter: (args = []) => started.push(args),
    herdr: async <T>(args: string[]) => {
      herdrCalls.push(args)
      return (o.herdr?.(args) ?? null) as T
    },
    asleep: () => 2,
    ...(o.now && { now: o.now }),
  })
  return { c, started, asked, herdrCalls }
}

test('ensure starts wake once when it is on, not held and not answering; never when off or held', async () => {
  isolatedHome()
  const down = control(on())
  await Promise.all([down.c.ensure(), down.c.ensure()])
  expect(down.started).toEqual([[]])
  // Just started: not again while its start may still be under way.
  await down.c.ensure()
  expect(down.started).toEqual([[]])

  const up = control(on(), { answers: true })
  await up.c.ensure()
  expect(up.started).toEqual([])

  const wakeOff = control(off())
  await wakeOff.c.ensure()
  expect([wakeOff.started, wakeOff.asked.answers]).toEqual([[], 0])

  writeWakeStatus({ state: 'held', at: Date.now() })
  const held = control(on())
  await held.c.ensure()
  expect([held.started, held.asked.answers]).toEqual([[], 0])

  // herdr's startup entry started wake a moment ago (its record says starting): the board leaves it
  // the work; a record of a start that never came up (older than a minute) is started again.
  writeWakeStatus({ state: 'starting', at: Date.now(), pane: 'wW:p9' })
  const underWay = control(on())
  await underWay.c.ensure()
  expect(underWay.started).toEqual([])
  writeWakeStatus({ state: 'starting', at: Date.now() - 61_000, pane: 'wW:p9' })
  const never = control(on())
  await never.c.ensure()
  expect(never.started).toEqual([[]])
  // None of it asked herdr anything.
  expect([down, up, wakeOff, held, underWay, never].flatMap(x => x.herdrCalls)).toEqual([])
})

test('turned on in config.json by hand: started at once', async () => {
  isolatedHome()
  const cfg = off()
  const { c, started } = control(cfg)
  c.configChanged()
  await Bun.sleep(0)
  expect(started).toEqual([])
  // liveConfig puts the new config into the same object, then the board's refresh runs.
  cfg.wake = { enabled: true, port: PORT }
  c.configChanged()
  await until(() => started.length > 0)
  expect(started).toEqual([[]])
  c.configChanged()
  await Bun.sleep(10)
  expect(started).toEqual([[]])
})

const snapshot = (panes: Record<string, unknown>[], workspaces = [{ workspace_id: 'w5', label: 'Wake' }]) => ({
  snapshot: {
    workspaces,
    tabs: [
      { tab_id: 't5', workspace_id: 'w5' },
      { tab_id: 't6', workspace_id: 'w5' },
    ],
    panes,
  },
})
/** A folder of the user's, with spaces, Cyrillic and %. */
const OTHER_DIR = process.platform === 'win32' ? 'C:\\Work\\Проект x 50%' : '/work/Проект x 50%'
/** Wake's pane, a bare shell in the plugin's folder once wake ended. */
const shell = { pane_id: 'w5:p1', tab_id: 't5', workspace_id: 'w5', cwd: ROOT }
const sidebar = { pane_id: 'w5:p2', tab_id: 't5', workspace_id: 'w5', tokens: { 'herdr-sidebar.width': 30 } }
const claude = { pane_id: 'w5:p3', tab_id: 't5', workspace_id: 'w5', agent: 'claude' }
/** No agent, in a folder of the user's: an editor, a dev server, a log tail. */
const editor = { pane_id: 'w5:p4', tab_id: 't6', workspace_id: 'w5', cwd: OTHER_DIR, terminal_title_stripped: 'vim' }
/** A pane herdr says no folder of: not known to be wake's. */
const unknown = { pane_id: 'w5:p5', tab_id: 't6', workspace_id: 'w5', terminal_title_stripped: 'node' }
/** The board's own pane (board.json): no agent, in the plugin's folder. */
const boardPane = { pane_id: 'w5:p6', tab_id: 't6', workspace_id: 'w5', cwd: ROOT, terminal_title_stripped: 'bun' }

test('off: the Wake workspace is closed only when nothing but wake’s shells and sidebar panes is in it', async () => {
  const calls: string[][] = []
  const herdr = (panes: Record<string, unknown>[], workspaces?: { workspace_id: string; label: string }[]) =>
    (async <T>(args: string[]): Promise<T> => {
      calls.push(args)
      return (args[0] === 'api' ? snapshot(panes, workspaces) : null) as T
    }) as <T = unknown>(args: string[], timeoutMs?: number) => Promise<T>
  const settings = { workspace: 'Wake' }
  const place = (o: { pane?: string | null; label?: string; wakePane?: string | null } = {}) => ({
    board: { label: o.label ?? 'Board', pane: o.pane ?? null },
    root: ROOT,
    wakePane: o.wakePane ?? null,
  })
  const closing = async (
    panes: Record<string, unknown>[],
    o: Parameters<typeof place>[0] = {},
    workspaces?: { workspace_id: string; label: string }[],
  ) => {
    calls.length = 0
    return [await closeWakeWorkspace(herdr(panes, workspaces), settings, place(o)), [...calls]]
  }
  const snap = ['api', 'snapshot']

  // Wake's shell (its folder spelled as herdr may: another case, a trailing separator) and sidebar panes.
  expect(await closing([shell, sidebar])).toEqual(['workspace', [snap, ['workspace', 'close', 'w5']]])
  const spelled = { ...shell, cwd: `${process.platform === 'win32' ? ROOT.toUpperCase() : ROOT}/` }
  expect(await closing([spelled, sidebar])).toEqual(['workspace', [snap, ['workspace', 'close', 'w5']]])

  // A pane of the user's beside it (an agent, an editor in another folder, one of no known folder):
  // the workspace stays; only wake's own pane goes, with its tab when nothing but sidebar panes is beside it.
  for (const user of [claude, editor, unknown]) {
    expect(await closing([shell, sidebar, user])).toEqual([null, [snap]])
    const alone = user.tab_id === 't6'
    expect(await closing([shell, sidebar, user], { wakePane: 'w5:p1' })).toEqual(
      alone ? ['tab', [snap, ['tab', 'close', 't5']]] : ['pane', [snap, ['pane', 'close', 'w5:p1']]],
    )
  }
  // An editor in wake's own tab: only wake's pane.
  expect(await closing([shell, sidebar, { ...editor, tab_id: 't5' }], { wakePane: 'w5:p1' })).toEqual([
    'pane',
    [snap, ['pane', 'close', 'w5:p1']],
  ])
  // The recorded pane is no wake's now (an agent in it): nothing.
  expect(await closing([{ ...shell, agent: 'claude' }, editor], { wakePane: 'w5:p1' })).toEqual([null, [snap]])
  // Its id given to a program of the user's after herdr started over (no agent, another folder): nothing.
  expect(
    await closing([{ ...editor, tab_id: 't5', pane_id: 'w5:p1' }, sidebar, claude], { wakePane: 'w5:p1' }),
  ).toEqual([null, [snap]])

  // The board's pane (board.json) in it: the workspace stays, though that pane reads as a shell in the
  // plugin's folder; wake's own pane still goes, never the board's.
  expect(await closing([shell, sidebar, boardPane], { pane: 'w5:p6' })).toEqual([null, [snap]])
  expect(await closing([shell, sidebar, boardPane], { pane: 'w5:p6', wakePane: 'w5:p1' })).toEqual([
    'tab',
    [snap, ['tab', 'close', 't5']],
  ])
  expect(await closing([shell, sidebar, boardPane], { pane: 'w5:p6', wakePane: 'w5:p6' })).toEqual([null, [snap]])

  // No workspace of that name; or it is the board's own (by its label), with no wake pane recorded.
  expect(await closing([shell], {}, [{ workspace_id: 'w5', label: 'Other' }])).toEqual([null, [snap]])
  expect(await closing([shell], { label: 'Wake' })).toEqual([null, []])
  // Wake's workspace is the board's: only wake's recorded pane, never the workspace.
  expect(await closing([shell, sidebar, boardPane], { label: 'Wake', wakePane: 'w5:p1' })).toEqual([
    'tab',
    [snap, ['tab', 'close', 't5']],
  ])

  // Turned off from the panel: config.json says so, and once wake no longer answers its workspace goes.
  isolatedHome()
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFile(), JSON.stringify({ language: 'en', wake: { enabled: true, port: PORT } }))
  let answers = true
  const herdrCalls: string[][] = []
  const c = createWakeControl({
    cfg: on(),
    answers: async () => answers,
    starter: () => {},
    herdr: async <T>(args: string[]) => {
      herdrCalls.push(args)
      return (args[0] === 'api' ? snapshot([shell, sidebar]) : null) as T
    },
    pollMs: 10,
  })
  expect(await c.turn(false)).toEqual({ ok: true })
  expect(JSON.parse(readFileSync(configFile(), 'utf8')).wake).toEqual({ enabled: false, port: PORT })
  await Bun.sleep(50)
  expect(herdrCalls).toEqual([])
  answers = false
  await until(() => herdrCalls.length === 2)
  expect(herdrCalls).toEqual([
    ['api', 'snapshot'],
    ['workspace', 'close', 'w5'],
  ])
  c.stop()
})

test('turned off from the panel with a pane of the user’s or the board’s in Wake: only wake’s recorded pane goes', async () => {
  for (const { panes, wakePane, closed } of [
    // An editor beside it: wake's tab (its pane and a sidebar pane) goes, the editor's stays.
    { panes: [shell, sidebar, editor], wakePane: 'w5:p1', closed: [['tab', 'close', 't5']] },
    // The board's pane (board.json), with no wake pane recorded: nothing goes.
    { panes: [shell, sidebar, boardPane], wakePane: undefined, closed: [] },
  ]) {
    isolatedHome()
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(configFile(), JSON.stringify({ language: 'en', wake: { enabled: true, port: PORT } }))
    mkdirSync(dirname(boardFile()), { recursive: true })
    writeFileSync(boardFile(), JSON.stringify({ pane: 'w5:p6', pid: process.pid }))
    writeWakeStatus({ state: 'stopped', at: Date.now(), ...(wakePane && { pane: wakePane }) })
    let answers = true
    const herdrCalls: string[][] = []
    const c = createWakeControl({
      cfg: on(),
      answers: async () => answers,
      starter: () => {},
      herdr: async <T>(args: string[]) => {
        herdrCalls.push(args)
        return (args[0] === 'api' ? snapshot(panes) : null) as T
      },
      pollMs: 10,
    })
    expect(await c.turn(false)).toEqual({ ok: true })
    answers = false
    await until(() => herdrCalls.length >= 1 + closed.length)
    await Bun.sleep(30)
    expect(herdrCalls).toEqual([['api', 'snapshot'], ...closed])
    c.stop()
  }
})

test('turned on again before wake ended: its workspace stays', async () => {
  isolatedHome()
  const herdrCalls: string[][] = []
  const started: string[][] = []
  let answers = true
  const c = createWakeControl({
    cfg: on(),
    answers: async () => answers,
    starter: (args = []) => started.push(args),
    herdr: async <T>(args: string[]) => {
      herdrCalls.push(args)
      return snapshot([shell]) as T
    },
    pollMs: 10,
  })
  await c.turn(false)
  expect(await c.turn(true)).toEqual({ ok: true })
  answers = false
  await Bun.sleep(80)
  expect(herdrCalls).toEqual([])
  expect(started).toEqual([[]])
  c.stop()
})

test('view: each WakeState from the status file and reach', async () => {
  isolatedHome()
  let now = 10_000_000
  const clock = () => now
  const cases: [Config, Parameters<typeof writeWakeStatus>[0] | null, boolean, Record<string, unknown>][] = [
    [
      normalizeConfig({ wake: { enabled: false, port: PORT } }),
      { state: 'running', at: now - 5000 },
      true,
      { on: false, state: 'off', since: null, downSince: null },
    ],
    [on(), null, false, { on: true, state: 'notRunning', since: null, downSince: now }],
    [on(), { state: 'held', at: now - 5000 }, true, { on: true, state: 'held', downSince: null }],
    [on(), { state: 'running', at: now - 5000 }, true, { state: 'running', since: now - 5000, downSince: null }],
    [on(), { state: 'starting', at: now - 5000 }, false, { state: 'starting', since: null, downSince: now }],
    [on(), { state: 'starting', at: now - 61_000 }, false, { state: 'notRunning' }],
    [
      on(),
      { state: 'crashed', at: now - 5000, error: 'TypeError: x', crashes: [1, 2, 3, 4, 5] },
      false,
      { state: 'crashed', error: 'TypeError: x', crashes: 5 },
    ],
    [
      on(),
      { state: 'portTaken', at: now - 5000, port: PORT, error: `Port ${PORT} is taken by another program` },
      false,
      { state: 'portTaken', port: PORT, error: `Port ${PORT} is taken by another program` },
    ],
  ]
  for (const [cfg, status, answers, want] of cases) {
    if (status) writeWakeStatus(status)
    else rmSync(wakeStatusFile(), { force: true })
    const { c, asked } = control(cfg, { answers, now: clock })
    const view = await c.view()
    expect(view).toMatchObject({ port: PORT, asleep: 2, ...want })
    // Off or held: wake is not asked.
    if (want.state === 'off' || want.state === 'held') expect(asked.answers).toBe(0)
  }

  // Cached for 2 s; "down since" stays the first time it was seen down.
  writeWakeStatus({ state: 'crashed', at: now, error: 'boom', crashes: [1] })
  const { c, asked } = control(on(), { now: clock })
  const first = await c.view()
  now += 1999
  expect(await c.view()).toEqual(first)
  expect(asked.answers).toBe(1)
  now += 1
  expect((await c.view()).downSince).toBe(first.downSince)
  expect(asked.answers).toBe(2)
})

test('current(): what the payload carries, without waiting; while off with no wake file, that it is off (nothing before it ships)', async () => {
  isolatedHome()
  let changed = 0
  let asked = 0
  const quiet = createWakeControl({
    cfg: off(),
    answers: async () => {
      asked++
      return true
    },
    starter: () => {},
    onChange: () => changed++,
  })
  // Once wake ships the Settings item is there whatever the switch says, so the payload says it is off.
  const offView: WakeView | null = WAKE_SHIPPED
    ? { on: false, state: 'off', since: null, asleep: 0, port: WAKE_PORT, downSince: null }
    : null
  expect(quiet.current()).toEqual(offView)
  await Bun.sleep(10)
  expect([quiet.current(), changed, asked]).toEqual([offView, WAKE_SHIPPED ? 1 : 0, 0])
  changed = 0

  writeWakeStatus({ state: 'running', at: 5 })
  const c = createWakeControl({
    cfg: on(),
    answers: async () => true,
    starter: () => {},
    onChange: () => changed++,
    asleep: () => 1,
  })
  expect(c.current()).toBeNull() // asked in the background
  await until(() => changed > 0)
  expect(c.current()).toMatchObject({ on: true, state: 'running', since: 5, asleep: 1 })
})

test('the state line follows the switch: a view of the switch before is asked again once config.json changes', async () => {
  isolatedHome()
  writeWakeStatus({ state: 'running', at: 5 })
  // The panel's On writes config.json, and the board reads it a moment later: the board refreshed
  // in between and kept "off" (the config it had then).
  const cfg = off()
  let changed = 0
  const c = createWakeControl({ cfg, answers: async () => true, starter: () => {}, onChange: () => changed++ })
  expect(await c.turn(true)).toEqual({ ok: true })
  await c.view()
  expect(c.current()?.state).toBe('off')
  // config.json read again: the next refresh says it runs, without waiting for the view to age.
  Object.assign(cfg, on())
  c.configChanged()
  changed = 0
  c.current()
  await until(() => changed > 0)
  expect(c.current()).toMatchObject({ on: true, state: 'running' })
})

test('Log: the tail of wake.log', () => {
  isolatedHome()
  mkdirSync(wakeLogFile().replace(/[\\/]wake\.log$/, ''), { recursive: true })
  writeFileSync(wakeLogFile(), `${Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n')}\n`)
  const { c } = control(on())
  const tail = c.logTail().split('\n')
  expect([tail.length, tail[0], tail.at(-1)]).toEqual([200, 'line 51', 'line 250'])
})

test('settings: the reaper, Telegram and where tg-mcp is, the log file, wake’s hooks per profile; never the token', async () => {
  isolatedHome()
  const cfg = on({ telegram: 'auto', reaper: { enabled: true, idleMinutes: 45, exclude: ['Billing'] } })
  const c = createWakeControl({
    cfg,
    status: async () => ({ pid: 4242, sessions: {}, lastPoll: null, lastError: 'tg-mcp: 401 Unauthorized' }),
    starter: () => {},
    claudeJson: () => ({
      mcpServers: { telegram: { url: 'http://tg.local:8080/mcp', headers: { Authorization: 'Bearer secret' } } },
    }),
    hooks: () => [{ id: 'work', title: 'Work', state: 'missing' }],
  })
  const s = await c.settings()
  expect(s).toEqual({
    reaper: { enabled: true, idleMinutes: 45, exclude: ['Billing'], maxPerRound: 3 },
    telegram: 'auto',
    found: { host: 'tg.local:8080' },
    lastError: 'tg-mcp: 401 Unauthorized',
    log: wakeLogFile(),
    hooks: [{ id: 'work', title: 'Work', state: 'missing' }],
  })
  expect(JSON.stringify(s)).not.toContain('secret')
})

test('Start and Start again: refused while off or held, nothing to do while it answers', async () => {
  isolatedHome()
  const wakeOff = control(off())
  expect(await wakeOff.c.start()).toEqual({ ok: false, error: 'Sleep and wake is off (Settings → Sleep and wake…)' })
  expect(await wakeOff.c.again()).toEqual({ ok: false, error: 'Sleep and wake is off (Settings → Sleep and wake…)' })
  expect(wakeOff.started).toEqual([])

  const up = control(on(), { answers: true })
  expect(await up.c.start()).toEqual({ ok: true })
  expect(up.started).toEqual([])
  expect(await up.c.again()).toEqual({ ok: true })
  expect(up.started).toEqual([['--again']])

  // Not running: Start makes its pane anew (--again), past a record whose pid another process may
  // have now (herdr's restart, Fast Startup).
  const down = control(on())
  expect(await down.c.start()).toEqual({ ok: true })
  // Wake's start is under way: it recorded its new pane as starting. A second Start starts nothing.
  writeWakeStatus({ state: 'starting', at: Date.now(), pane: 'wW:p9' })
  expect(await down.c.start()).toEqual({ ok: true })
  expect(down.started).toEqual([['--again']])
  // Start again still makes the pane anew.
  expect(await down.c.again()).toEqual({ ok: true })
  expect(down.started).toEqual([['--again'], ['--again']])
  // The board's own start once on (ensure, the switch) is the plain one: a wake pane there is kept.
  writeWakeStatus({ state: 'running', at: Date.now() - 300_000, pane: 'wW:p9', pid: process.pid })
  const plain = control(on())
  await plain.c.ensure()
  expect(plain.started).toEqual([[]])

  writeWakeStatus({ state: 'held', at: 1 })
  const held = control(on())
  expect(await held.c.start()).toEqual({ ok: false, error: 'The separate herdr-wake plugin does this now' })
  expect(held.started).toEqual([])
})

test('view: the Telegram router’s state while wake runs, never from a status file a crash left behind', async () => {
  isolatedHome()
  const polling = { state: 'polling', host: '127.0.0.1:8787' } as const
  writeWakeStatus({ state: 'running', at: 5, pid: 4242, telegram: polling })
  expect((await control(on(), { answers: true }).c.view()).telegram).toEqual(polling)
  writeWakeStatus({ state: 'running', at: 5, pid: 4242, telegram: { state: 'error', error: 'tg-mcp: 401' } })
  expect((await control(on(), { answers: true }).c.view()).telegram).toEqual({ state: 'error', error: 'tg-mcp: 401' })
  // Crashed, not answering, or off: the file's Telegram is the dead process's, not said.
  writeWakeStatus({ state: 'crashed', at: 5, crashes: [1, 2, 3, 4, 5], telegram: polling })
  expect('telegram' in (await control(on()).c.view())).toBe(false)
  writeWakeStatus({ state: 'running', at: 5, pid: 4242, telegram: polling })
  expect('telegram' in (await control(on(), { answers: false }).c.view())).toBe(false)
  expect('telegram' in (await control(off(), { answers: true }).c.view())).toBe(false)
  // No Telegram in the file (Telegram never on): the view as it was.
  rmSync(wakeStatusFile(), { force: true })
  writeWakeStatus({ state: 'running', at: 5, pid: 4242 })
  expect('telegram' in (await control(on(), { answers: true }).c.view())).toBe(false)
})

/**
 * A wake on a port of the test's own: the board's (GET /alive answers at once; GET /status, a herdr
 * snapshot in the wake process, never answers here), or the separate plugin's router (/status
 * only, a 404 for the rest). The paths asked, in order.
 */
function wakeOnPort(kind: 'board' | 'router'): { port: number; asked: string[] } {
  const asked: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: req => {
      const path = new URL(req.url).pathname
      asked.push(path)
      if (kind === 'board') return path === '/alive' ? Response.json({ pid: 4242 }) : new Promise<Response>(() => {})
      return path === '/status' ? Response.json({ pid: 4242, sessions: {} }) : new Response(null, { status: 404 })
    },
  })
  onTestFinished(() => server.stop(true))
  return { port: server.port as number, asked }
}

test('view: whether wake answers by its /alive, never its /status (a herdr snapshot in the wake process)', async () => {
  isolatedHome()
  writeWakeStatus({ state: 'running', at: 5, pid: 4242 })
  const wake = wakeOnPort('board')
  let now = 10_000_000
  const c = createWakeControl({ cfg: on({ port: wake.port }), starter: () => {}, now: () => now })
  const started = performance.now()
  expect((await c.view()).state).toBe('running')
  expect(performance.now() - started).toBeLessThan(1500)
  // The payload's poll: asked again in the background each time the view is 2 s old.
  for (let i = 2; i <= 4; i++) {
    now += 2000
    c.current()
    await until(() => wake.asked.length === i)
  }
  await until(() => c.current()?.state === 'running')
  expect(wake.asked).toEqual(['/alive', '/alive', '/alive', '/alive'])
})

test('view: the separate plugin’s router left on wake’s port is not wake running, and is not asked its /status', async () => {
  isolatedHome()
  writeWakeStatus({ state: 'stopped', at: Date.now() })
  const router = wakeOnPort('router')
  const c = createWakeControl({ cfg: on({ port: router.port }), starter: () => {} })
  expect((await c.view()).state).toBe('notRunning')
  expect(router.asked).toEqual(['/alive'])
})

test('wake off ("wake": false): no question on any port and no herdr call, whatever the panel asks', async () => {
  isolatedHome()
  writeWakeStatus({ state: 'running', at: 5, pid: 4242 })
  const fetched: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      fetched.push(String(input))
      return realFetch(input, init)
    },
    { preconnect: realFetch.preconnect },
  )
  onTestFinished(() => {
    globalThis.fetch = realFetch
  })
  const herdrCalls: string[][] = []
  const c = createWakeControl({
    cfg: off(),
    starter: () => {},
    herdr: async <T>(args: string[]) => {
      herdrCalls.push(args)
      return null as T
    },
  })
  expect((await c.view()).state).toBe('off')
  c.current()
  await c.settings()
  await c.ensure()
  await c.start()
  await Bun.sleep(20)
  expect([fetched, herdrCalls]).toEqual([[], []])
})

test('onState: when the view’s state changes, never for the same one; and once Switch over ends', async () => {
  isolatedHome()
  let answers = false
  let now = 10_000_000
  let states = 0
  const c = createWakeControl({
    cfg: on(),
    answers: async () => answers,
    starter: () => {},
    now: () => now,
    onState: () => states++,
  })
  // The first look: nothing changed yet.
  expect((await c.view()).state).toBe('notRunning')
  now += 2000
  expect((await c.view()).state).toBe('notRunning')
  expect(states).toBe(0)
  answers = true
  now += 2000
  expect((await c.view()).state).toBe('running')
  expect(states).toBe(1)
  now += 2000
  await c.view()
  expect(states).toBe(1)
  writeWakeStatus({ state: 'held', at: now })
  now += 2000
  expect((await c.view()).state).toBe('held')
  expect(states).toBe(2)
  // Switch over, even one that stops at once (the board's config.json does not read): once it ended.
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFile(), '{"wake": ')
  expect((await c.switchOver()).ok).toBe(false)
  expect(states).toBe(3)
})

test('current(): a view that fails is logged, never an unhandled rejection', async () => {
  isolatedHome()
  const logged: string[] = []
  const c = createWakeControl({
    cfg: on(),
    answers: async () => true,
    starter: () => {},
    onChange: () => {
      throw new Error('publish failed')
    },
    log: text => logged.push(text),
  })
  const unhandled: unknown[] = []
  const seen = (err: unknown): void => {
    unhandled.push(err)
  }
  process.on('unhandledRejection', seen)
  onTestFinished(() => {
    process.off('unhandledRejection', seen)
  })
  c.current()
  await until(() => logged.length > 0)
  await Bun.sleep(10)
  expect(unhandled).toEqual([])
  expect(logged[0]).toContain('publish failed')
})
