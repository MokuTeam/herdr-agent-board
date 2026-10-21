// The wake process (#119), what wake's pane runs under its supervisor: today's local API on
// 127.0.0.1:<wake.port> (the old herdr-wake router's paths and answers, plus each session's
// profile), the sessions seen every 15 s, and the reaper every 60 s while it is on. config.json's
// kill switch is read before anything: wake off, or a config.json that does not parse, ends it
// with 0 and no herdr call. The settings are followed live (liveConfig): turned off, the API closes
// and it ends with 0; the reaper's switch starts or stops its loop.
//
//   bun src/entrypoints/wake.ts              the process
//   bun src/entrypoints/wake.ts --reap-dry   the reaper's verdict for every Claude pane, one line each
//
// API: GET /status, GET /sleeping, GET /awake, POST /wake { target }, POST /sleep { target }; target
// is a session name, a pane id or a session id. Once it listens it says { up: <port> } over its IPC
// channel, when it has one (the supervisor's).
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configFile, liveConfig, loadConfig, readConfigFile } from '../adapters/config-file.ts'
import { isRecord } from '../adapters/json-store.ts'
import { stateDir } from '../adapters/paths.ts'
import { boardOnPath } from '../adapters/resume-report.ts'
import { wakeLog, wakeSessionsFile } from '../adapters/wake-files.ts'
import { cliWakeHerdr } from '../adapters/wake-herdr.ts'
import { scheduledJobs } from '../adapters/wake-transcripts.ts'
import { telegramTarget, type WakeConfig, wakeConfig, wakeSwitch } from '../core/wake/config.ts'
import { defaultDeps } from '../services/deps.ts'
import { createWakeEngine, type WakeEngine } from '../services/wake/engine.ts'

const reapDry = process.argv[2] === '--reap-dry'

// The kill switch, before anything else: off, wake asks herdr nothing.
if (!wakeSwitch({ exists: existsSync(configFile()), raw: readConfigFile() })) {
  if (reapDry) console.error('wake is off in config.json')
  process.exit(0)
}

const SEEN_EVERY_MS = 15_000
const REAP_EVERY_MS = 60_000
/** What a timer can wait at most. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** Turned off: how long wakes and sleeps under way have to end before the process does. */
const OFF_GRACE_MS = 180_000
const JSON_HEADERS = { 'content-type': 'application/json' }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** On the pane's screen with the time, and in wake.log. */
function log(text: string): void {
  console.log(`${new Date().toLocaleTimeString()} ${text}`)
  wakeLog(text)
}

/** BOARD_WAKE_ROUND_MS (tests only, unset in production): both loops' pause, when a whole number of ms a timer can hold. */
function roundMs(): number | null {
  const ms = Number(process.env.BOARD_WAKE_ROUND_MS)
  return Number.isInteger(ms) && ms >= 1 && ms <= MAX_TIMER_MS ? ms : null
}

/** ~/.claude.json, where tg-mcp's url and token are by default; null when there is none or it does not parse. */
function claudeJson(): unknown {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

const telegramSaid = (s: WakeConfig): string =>
  (s.telegram === 'auto' && telegramTarget(s, claudeJson())?.host) || 'Telegram off'
const reaperSaid = (s: WakeConfig): string =>
  s.reaper.enabled ? `reaper on (${s.reaper.idleMinutes} min)` : 'reaper off'

interface Loop {
  stop(): void
}

/** `fn` now, then again `ms` after each round ends, until stopped; an error is logged once until it changes. */
function every(ms: number, name: string, fn: () => Promise<void>): Loop {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastError: string | null = null
  const round = async (): Promise<void> => {
    try {
      await fn()
      lastError = null
    } catch (err) {
      const message = messageOf(err)
      if (message !== lastError) log(`${name} failed: ${message}`)
      lastError = message
    }
    if (!stopped) timer = setTimeout(round, ms)
  }
  void round()
  return {
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
}

let server: ReturnType<typeof Bun.serve> | undefined
let seen: Loop | null = null
let reaper: Loop | null = null
let stopping = false

const cfg = reapDry ? loadConfig() : liveConfig(followSettings)
/** Wake's settings as config.json has them now. */
const settings = (): WakeConfig => wakeConfig(cfg.wake)
const deps = defaultDeps(cfg, log)
let engine: WakeEngine
try {
  engine = createWakeEngine({
    herdr: cliWakeHerdr,
    homes: deps.homes,
    // The board's profiles with the folder this process's env points to, as `board resume` reads them.
    profiles: () => deps.profiles(),
    settings,
    sessionsFile: wakeSessionsFile(),
    boardOnPath: () => boardOnPath(),
    scheduled: path => scheduledJobs(path),
    log,
  })
} catch (err) {
  // The session file could not be read, nor set aside: started with none, the next save would lose it.
  log(`wake did not start: ${messageOf(err)}`)
  process.exit(1)
}

/** The reaper's loop: every 60 s, a round that puts the sessions due to sleep. */
const reaperLoop = (): Loop => every(roundMs() ?? REAP_EVERY_MS, 'reaper', () => engine.reapRound())

/** config.json changed: turned off, the API closes and the process ends with 0; the reaper's loop follows its switch. */
function followSettings(): void {
  if (stopping) return
  const s = settings()
  if (!s.enabled) {
    void stop()
    return
  }
  if (s.reaper.enabled && !reaper) {
    reaper = reaperLoop()
    log(reaperSaid(s))
  } else if (!s.reaper.enabled && reaper) {
    reaper.stop()
    reaper = null
    log(reaperSaid(s))
  }
}

/** Wake turned off: no more requests nor rounds; ends with 0 once the wakes and sleeps under way are done (180 s at most). */
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  log('wake turned off in config.json: stopping')
  seen?.stop()
  reaper?.stop()
  void server?.stop(true)
  for (const deadline = Date.now() + OFF_GRACE_MS; engine.busy() > 0 && Date.now() < deadline; ) await Bun.sleep(100)
  process.exit(0)
}

/** POST's `{ target }`; a body that does not parse is {}. */
async function targetOf(req: Request): Promise<unknown> {
  let body: unknown
  try {
    body = JSON.parse((await req.text()) || '{}')
  } catch {
    body = {}
  }
  return isRecord(body) ? body.target : undefined
}

/** The old router's paths, each with its answer; null for anything else. */
async function api(req: Request): Promise<unknown> {
  const path = new URL(req.url).pathname
  if (req.method === 'GET' && path === '/status') return engine.status()
  if (req.method === 'GET' && path === '/sleeping') return engine.sleeping()
  if (req.method === 'GET' && path === '/awake') return engine.awake()
  if (req.method === 'POST' && path === '/wake') return engine.wake(await targetOf(req))
  if (req.method === 'POST' && path === '/sleep') return engine.sleep(await targetOf(req))
  return null
}

/** 200 with the answer pretty-printed (a one-space indent, as the old router's), 404 with an empty body, 500 { ok: false, error }. */
async function answer(req: Request): Promise<Response> {
  try {
    const out = await api(req)
    if (out === null) return new Response(null, { status: 404 })
    return new Response(JSON.stringify(out, null, 1), { headers: JSON_HEADERS })
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: messageOf(err) }), { status: 500, headers: JSON_HEADERS })
  }
}

// A stray rejection is logged, never the end of wake.
process.on('unhandledRejection', err => log(`unhandled: ${err instanceof Error ? (err.stack ?? err.message) : err}`))

if (reapDry) {
  for (const p of await engine.plan())
    console.log(`${p.sleep ? 'SLEEP' : 'keep '}  ${p.pane.padEnd(7)} ${p.name.padEnd(34)} ${p.reason}`)
  process.exit(0)
}

const start = settings()
// No idle timeout: a wake can take its wakeTimeoutSec and more. No port reuse: the port keeps wake
// to one process. Not development: a throw must never serve Bun's error page.
try {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: start.port,
    idleTimeout: 0,
    development: false,
    reusePort: false,
    fetch: answer,
  })
} catch (err) {
  log(`local API on 127.0.0.1:${start.port}: ${messageOf(err)}`)
  process.exit(1)
}
process.send?.({ up: start.port })
log(`wake up: ${telegramSaid(start)}, ${reaperSaid(start)}, state ${stateDir()}, API http://127.0.0.1:${start.port}`)
seen = every(roundMs() ?? SEEN_EVERY_MS, 'sessions seen', () => engine.remember())
if (start.reaper.enabled) reaper = reaperLoop()
