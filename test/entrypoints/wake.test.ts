// `bun src/entrypoints/wake.ts`: the wake process against a sandbox's fake herdr, with Claude's
// registry and transcripts under the sandbox's home. Today's local API (the old router's paths and
// answers, plus each session's profile) on 127.0.0.1 only, the kill switch read before anything,
// the settings followed live, and nothing done by itself while the reaper and Telegram are off.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { unusedPort } from '../support/board-server.ts'
import { type Sandbox, until } from '../support/sandbox.ts'
import { runningSession, SID, SID2 } from '../support/wake-fixtures.ts'
import { spawnWake, startWakeProcess, wakeOnConfig, wakeSandbox, writeBoardConfig } from '../support/wake-process.ts'

setDefaultTimeout(30_000)

const HOUR = 3_600_000
/** A project folder with spaces, Cyrillic and %. */
const PROJECT = process.platform === 'win32' ? 'C:\\Work\\Проект x 50%' : '/work/Проект x 50%'

const claudePane = (pane: string, session: string, status = 'idle') => ({
  pane_id: pane,
  tab_id: 't1',
  workspace_id: 'w1',
  cwd: PROJECT,
  agent: 'claude',
  agent_status: status,
  agent_session: { value: session },
  terminal_title_stripped: 'claude',
})
const shellPane = (pane: string) => ({ pane_id: pane, tab_id: 't1', workspace_id: 'w1', cwd: PROJECT })

/** The fake herdr's `api snapshot`: these panes in workspace "Main". */
function herdrShows(box: Sandbox, panes: unknown[], more: Record<string, unknown> = {}): void {
  box.state({
    'api snapshot': {
      result: {
        snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'Main' }],
          tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
          panes,
        },
      },
    },
    ...more,
  })
}

const home = (box: Sandbox): string => box.env.HOME as string
const claudeDir = (box: Sandbox): string => join(home(box), '.claude')

/** Wake's session file in the sandbox's state folder. */
function wakeSessions(box: Sandbox, sessions: Record<string, unknown>): void {
  const file = join(stateOf(box), 'wake-sessions.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(sessions))
}

/** A Default session idle for two hours in w1:p1, and a Default sleeper in w1:p2 (a shell). */
function idleAndAsleep(box: Sandbox): { since: number; sleptAt: number } {
  const since = Date.now() - 2 * HOUR
  const sleptAt = Date.now() - HOUR
  runningSession(claudeDir(box), { id: SID, name: 'Billing', cwd: PROJECT, statusUpdatedAt: since })
  wakeSessions(box, {
    'w1:p2': {
      session: SID2,
      name: 'Ledger',
      cwd: PROJECT,
      title: 'claude',
      seen_at: sleptAt,
      slept_at: sleptAt,
      profileDir: claudeDir(box),
      profile: 'default',
    },
  })
  herdrShows(box, [claudePane('w1:p1', SID), shellPane('w1:p2')])
  return { since, sleptAt }
}

/** The board's state folder in the sandbox. */
const stateOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
const wakeLogText = (box: Sandbox): string => {
  try {
    return readFileSync(join(stateOf(box), 'wake.log'), 'utf8')
  } catch {
    return ''
  }
}

/** Whether GET <url>/status gets any answer within a second. */
async function listening(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/status`, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

/** Resolves with the exit code, or null when the process is still running after `ms`. */
async function exitWithin(proc: Bun.Subprocess, ms: number): Promise<number | null> {
  return Promise.race([proc.exited, Bun.sleep(ms).then(() => null)])
}

const post = (url: string, body: string): Promise<Response> => fetch(url, { method: 'POST', body })

test('the API answers today’s paths, plus each session’s profile', async () => {
  const box = await wakeSandbox()
  const { since, sleptAt } = idleAndAsleep(box)
  const port = await unusedPort()
  const wake = await startWakeProcess(box, { port })

  const status = await fetch(`${wake.url}/status`)
  expect(status.status).toBe(200)
  expect(status.headers.get('content-type')).toBe('application/json')
  const text = await status.text()
  const body = JSON.parse(text)
  // Pretty-printed with a one-space indent, as the old router's.
  expect(text).toBe(JSON.stringify(body, null, 1))
  expect(Object.keys(body)).toEqual(['pid', 'started', 'lastPoll', 'lastError', 'reaper', 'sleeping', 'sessions'])
  expect(body.pid).toBe(wake.proc.pid)
  expect(body.reaper).toEqual({ enabled: false, idleMinutes: 60, exclude: [], maxPerRound: 3 })
  expect([body.lastPoll, body.lastError]).toEqual([null, null])

  const sleeper = {
    name: 'Ledger',
    pane: 'w1:p2',
    session: SID2,
    workspace: 'Main',
    slept_at: new Date(sleptAt).toISOString(),
    exited: false,
    profile: { dir: claudeDir(box), id: 'default' },
  }
  expect(await (await fetch(`${wake.url}/sleeping`)).json()).toEqual([sleeper])
  expect(body.sleeping).toEqual([sleeper])
  expect(await (await fetch(`${wake.url}/awake`)).json()).toEqual([
    {
      name: 'Billing',
      pane: 'w1:p1',
      workspace: 'Main',
      status: 'idle',
      since: new Date(since).toISOString(),
      sleeps_in_min: null,
      kept: 'reaper off',
      profile: { dir: claudeDir(box), id: 'default' },
    },
  ])

  // POST /wake and /sleep read { target }; a body that does not parse is {}.
  expect(await (await post(`${wake.url}/wake`, JSON.stringify({ target: 'nobody' }))).json()).toEqual({
    ok: false,
    error: 'no session named nobody in herdr',
  })
  expect(await (await post(`${wake.url}/sleep`, 'not json')).json()).toEqual({
    ok: false,
    error: 'no running session named undefined',
  })

  // Anything else: 404 with an empty body.
  for (const res of [
    await fetch(`${wake.url}/nothing`),
    await post(`${wake.url}/status`, '{}'),
    await fetch(`${wake.url}/wake`),
  ]) {
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
  }

  // Told the supervisor it listens, over its IPC channel, and said so in wake.log.
  expect(wake.messages).toContainEqual({ up: port })
  expect(wakeLogText(box)).toContain(
    ` wake up: Telegram off, reaper off, state ${stateOf(box)}, API http://127.0.0.1:${port}\n`,
  )

  // A thrown error: 500 { ok: false, error }.
  herdrShows(box, [], { 'api snapshot': { error: 'herdr is gone', code: 'gone' } })
  const failed = await fetch(`${wake.url}/sleeping`)
  expect(failed.status).toBe(500)
  const error = await failed.json()
  expect(error.ok).toBe(false)
  expect(error.error).toContain('herdr is gone')
})

test('"wake": false, or a config.json that does not parse: the process ends at once and asks herdr nothing', async () => {
  for (const config of [
    { ...wakeOnConfig(0), wake: false },
    wakeOnConfig(0, { wake: { enabled: false } }),
    '{ "language": "en", "wake": { "enabled": tr',
  ]) {
    const box = await wakeSandbox()
    idleAndAsleep(box)
    const port = await unusedPort()
    writeBoardConfig(box, typeof config === 'string' ? config : { ...config, wake: withPort(config.wake, port) })
    const { proc } = spawnWake(box)
    expect(await exitWithin(proc, 10_000)).toBe(0)
    expect(box.calls()).toEqual([])
    expect(await listening(`http://127.0.0.1:${port}`)).toBe(false)
  }
})

/** A wake section with this port, when it is an object. */
const withPort = (wake: unknown, port: number): unknown => (wake && typeof wake === 'object' ? { ...wake, port } : wake)

test('on by default doing nothing by itself: idle sessions past idleMinutes and tg-mcp in ~/.claude.json, and over many rounds nobody is put to sleep, woken, renamed or typed into', async () => {
  const box = await wakeSandbox()
  idleAndAsleep(box)
  let asked = 0
  const tg = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      asked++
      return Response.json({ items: [] })
    },
  })
  try {
    writeFileSync(
      join(home(box), '.claude.json'),
      JSON.stringify({
        mcpServers: { telegram: { url: `${tg.url.origin}/mcp`, headers: { Authorization: 'Bearer secret' } } },
      }),
    )
    const port = await unusedPort()
    await startWakeProcess(box, {
      port,
      wake: { enabled: true, reaper: { enabled: false, idleMinutes: 1 } },
      env: { BOARD_WAKE_ROUND_MS: '50' },
    })
    await Bun.sleep(1000)
    const calls = box.calls().map(c => c.slice(0, 2).join(' '))
    // Many rounds of looking…
    expect(calls.filter(c => c === 'api snapshot').length).toBeGreaterThanOrEqual(3)
    // …and nothing done.
    for (const done of ['agent prompt', 'pane run', 'pane rename', 'pane send-keys', 'pane send-text'])
      expect(calls).not.toContain(done)
    expect(asked).toBe(0)
  } finally {
    await tg.stop(true)
  }
})

/** The first IPv4 address of this machine that is not a loopback one. */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find(i => i?.family === 'IPv4' && !i.internal)?.address

test.skipIf(!lanAddress)('it listens on 127.0.0.1 only', async () => {
  const box = await wakeSandbox()
  idleAndAsleep(box)
  const port = await unusedPort()
  const wake = await startWakeProcess(box, { port })
  expect(await listening(wake.url)).toBe(true)
  expect(await listening(`http://${lanAddress}:${port}`)).toBe(false)
})

test('turned off in config.json while it runs: its API closes and it ends with 0', async () => {
  const box = await wakeSandbox()
  idleAndAsleep(box)
  const port = await unusedPort()
  const wake = await startWakeProcess(box, { port })
  writeBoardConfig(box, { ...wakeOnConfig(port), wake: false })
  expect(await exitWithin(wake.proc, 10_000)).toBe(0)
  expect(await listening(wake.url)).toBe(false)
})

test('the reaper’s switch is followed live: its loop starts and stops without a restart', async () => {
  const box = await wakeSandbox()
  idleAndAsleep(box)
  const port = await unusedPort()
  const wake = await startWakeProcess(box, { port, env: { BOARD_WAKE_ROUND_MS: '50' } })
  writeBoardConfig(box, wakeOnConfig(port, { wake: { reaper: { enabled: true, idleMinutes: 5 } } }))
  await until(() => wakeLogText(box).includes(' reaper on (5 min)\n'))
  writeBoardConfig(box, wakeOnConfig(port, { wake: { reaper: { enabled: false, idleMinutes: 5 } } }))
  await until(() => wakeLogText(box).includes(' reaper off\n'))
  // The same process all along, still answering.
  expect(wake.proc.exitCode).toBeNull()
  expect((await (await fetch(`${wake.url}/status`)).json()).reaper).toEqual({
    enabled: false,
    idleMinutes: 5,
    exclude: [],
    maxPerRound: 3,
  })
})

test('--reap-dry prints one line per Claude pane', async () => {
  const box = await wakeSandbox()
  runningSession(claudeDir(box), { id: SID, name: 'Billing', cwd: PROJECT })
  // w1:p1 idle in the registry, w1:p3 a Claude pane the registry does not have, w1:p2 a shell.
  herdrShows(box, [claudePane('w1:p1', SID), shellPane('w1:p2'), claudePane('w1:p3', SID2, 'working')])
  writeBoardConfig(box, wakeOnConfig(await unusedPort()))
  const { proc, output } = spawnWake(box, ['--reap-dry'])
  expect(await exitWithin(proc, 10_000)).toBe(0)
  const lines = output().stdout.trimEnd().split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatch(/^keep {3}w1:p1 {3}Billing {28}cannot wake: /)
  expect(lines[1]).toBe(`keep   w1:p3   ${'claude'.padEnd(34)} not in the session registry`)
  // Only looked: herdr was asked for its snapshot, nothing else.
  expect(box.calls()).toEqual([['api', 'snapshot']])
})
