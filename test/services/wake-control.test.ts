// Wake's control on the board (#119): its state for the panel and the payload, its switches, Start,
// Start again and Log, and starting it once when it is on but not running (safeguard 3).
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { configFile } from '../../src/adapters/config-file.ts'
import { configDir } from '../../src/adapters/paths.ts'
import { wakeLogFile, wakeStatusFile, writeWakeStatus } from '../../src/adapters/wake-files.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import { useLanguage } from '../../src/core/lang.ts'
import type { Config } from '../../src/core/types.ts'
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
  // None of it asked herdr anything.
  expect([down, up, wakeOff, held].flatMap(x => x.herdrCalls)).toEqual([])
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
  snapshot: { workspaces, tabs: [{ tab_id: 't5', workspace_id: 'w5' }], panes },
})
const shell = { pane_id: 'w5:p1', tab_id: 't5', workspace_id: 'w5' }
const sidebar = { pane_id: 'w5:p2', tab_id: 't5', workspace_id: 'w5', tokens: { 'herdr-sidebar.width': 30 } }
const claude = { pane_id: 'w5:p3', tab_id: 't5', workspace_id: 'w5', agent: 'claude' }

test('off: the Wake workspace is closed only when nothing but shells and sidebar panes is in it', async () => {
  const calls: string[][] = []
  const herdr = (panes: Record<string, unknown>[], workspaces?: { workspace_id: string; label: string }[]) =>
    (async <T>(args: string[]): Promise<T> => {
      calls.push(args)
      return (args[0] === 'api' ? snapshot(panes, workspaces) : null) as T
    }) as <T = unknown>(args: string[], timeoutMs?: number) => Promise<T>
  const settings = { workspace: 'Wake' }

  expect(await closeWakeWorkspace(herdr([shell, sidebar]), settings, 'Board')).toBe(true)
  expect(calls).toEqual([
    ['api', 'snapshot'],
    ['workspace', 'close', 'w5'],
  ])
  calls.length = 0
  expect(await closeWakeWorkspace(herdr([shell, claude]), settings, 'Board')).toBe(false)
  expect(calls).toEqual([['api', 'snapshot']])
  calls.length = 0
  // No workspace of that name; or it is the board's own.
  expect(await closeWakeWorkspace(herdr([shell], [{ workspace_id: 'w5', label: 'Other' }]), settings, 'Board')).toBe(
    false,
  )
  expect(await closeWakeWorkspace(herdr([shell]), settings, 'Wake')).toBe(false)
  expect(calls).toEqual([['api', 'snapshot']])

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

test('current(): what the payload carries, without waiting; nothing while off with no wake file', async () => {
  isolatedHome()
  let changed = 0
  const quiet = createWakeControl({
    cfg: off(),
    answers: async () => true,
    starter: () => {},
    onChange: () => changed++,
  })
  expect(quiet.current()).toBeNull()
  await Bun.sleep(10)
  expect([quiet.current(), changed]).toEqual([null, 0])

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

  const down = control(on())
  expect(await down.c.start()).toEqual({ ok: true })
  expect(await down.c.start()).toEqual({ ok: true })
  expect(down.started).toEqual([[], []])

  writeWakeStatus({ state: 'held', at: 1 })
  const held = control(on())
  expect(await held.c.start()).toEqual({ ok: false, error: 'The separate herdr-wake plugin does this now' })
  expect(held.started).toEqual([])
})
