// The wake process (#119), what wake's pane runs under its supervisor: today's local API on
// 127.0.0.1:<wake.port> (the old herdr-wake router's paths and answers, plus each session's
// profile), the sessions seen every 15 s, and the reaper every 60 s while it is on. config.json's
// kill switch is read before anything: wake off, or a config.json that does not parse, ends it
// with 0 and no herdr call. The settings are followed live (liveConfig): turned off, it starts no
// other sleep, keeps its port while the wakes, sleeps and deliveries under way end, then ends with
// 0; the reaper's switch starts or stops its loop, and Telegram's (Auto, with tg-mcp's url and token
// found: services/wake/telegram.ts) its poll. Telegram's state goes into /status and into the
// status file, whose other fields are kept.
//
//   bun src/entrypoints/wake.ts                          the process
//   bun src/entrypoints/wake.ts --reap-dry               the reaper's verdict for every Claude pane,
//                                                        one line each
//   bun src/entrypoints/wake.ts --deliver <key> <text>   one message routed by hand as the Telegram
//                                                        router would, tg-mcp not asked; prints the
//                                                        result, exits 0 once it is typed in
// Both only read the session file, never write it: the wake process is its one writer.
//
// API: GET /status, GET /sleeping, GET /awake, POST /wake { target }, POST /sleep { target }; target
// is a session name, a pane id or a session id. GET /alive answers { pid } without asking herdr (the
// supervisor's health check: a slow herdr never gets wake ended). Programs on this computer only: a
// request with an Origin, or a Host other than 127.0.0.1:<port> or localhost:<port> (a web page, DNS
// rebinding), is refused with 403. Once it listens it says { up: <port> } over its IPC channel, when it has one
// (the supervisor's, services/wake/supervisor.ts); told 'restart' there (a code change), it ends
// with 75 once no wake or sleep is under way, answering new ones 503 meanwhile; that channel closed
// (the supervisor gone), it ends with 0 the same way, as when turned off. The port keeps wake
// to one process: held by a wake of the board's, this one ends with 0 quietly; by another program
// (the separate herdr-wake plugin's router too, named), the status file says portTaken and the
// exit is 76.
import { existsSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { configFile, liveConfig, loadConfig, readConfigFile } from '../adapters/config-file.ts'
import { isRecord } from '../adapters/json-store.ts'
import { stateDir } from '../adapters/paths.ts'
import { boardOnPath } from '../adapters/resume-report.ts'
import { oldRouterAt, wakeAnswers } from '../adapters/wake-api.ts'
import { readWakeStatus, wakeLog, wakeSessionsFile, writeWakeStatus } from '../adapters/wake-files.ts'
import { cliWakeHerdr } from '../adapters/wake-herdr.ts'
import { scheduledJobs } from '../adapters/wake-transcripts.ts'
import { type TelegramTarget, telegramTarget, type WakeConfig, wakeConfig, wakeSwitch } from '../core/wake/config.ts'
import type { RouteItem } from '../core/wake/route.ts'
import type { TelegramStatus } from '../core/wake/status.ts'
import { defaultDeps } from '../services/deps.ts'
import { createWakeEngine, type WakeEngine } from '../services/wake/engine.ts'
import { PORT_TAKEN_EXIT, RESTART_EXIT } from '../services/wake/supervisor.ts'
import { createTelegram, type Telegram } from '../services/wake/telegram.ts'

const reapDry = process.argv[2] === '--reap-dry'
/** --deliver's key and words. */
const deliverArgs = process.argv[2] === '--deliver' ? process.argv.slice(3) : null

// The kill switch, before anything else: off, wake asks herdr nothing.
if (!wakeSwitch({ exists: existsSync(configFile()), raw: readConfigFile() })) {
  if (reapDry || deliverArgs) console.error('wake is off in config.json')
  process.exit(deliverArgs ? 1 : 0)
}

const SEEN_EVERY_MS = 15_000
const REAP_EVERY_MS = 60_000
/** What a timer can wait at most. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** Turned off: how long wakes and sleeps under way have at least to end before the process does. */
const OFF_GRACE_MS = 180_000
/** A wake's own wait (wakeTimeoutSec) and this much more: the grace when that is longer. */
const WAKE_GRACE_MS = 30_000
/** Once nothing is under way: how long the last answers have to go out before the process ends. */
const ANSWERS_OUT_MS = 5000
/** Its port taken: how long what holds it has to answer as a wake. */
const PORT_ASK_MS = 5000
/** This computer's name, as sessions put it before their pane id in X-Herdr-Pane (the old router's). */
const MACHINE = process.env.COMPUTERNAME || hostname()
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
let telegram: Telegram | null = null
/** Set once the process is on its way out: the code it ends with, and what new sleeps and wakes are told. */
let leaving: { code: number; why: string } | null = null

const cfg = reapDry || deliverArgs ? loadConfig() : liveConfig(followSettings)
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
    // On its way out, wake counts as off for the engine: its reaper starts no other sleep.
    settings: () => (leaving ? { ...settings(), enabled: false } : settings()),
    sessionsFile: wakeSessionsFile(),
    boardOnPath: () => boardOnPath(),
    scheduled: path => scheduledJobs(path),
    log,
    // --reap-dry and --deliver: the session file is peeked at, never set aside nor written.
    readOnly: reapDry || deliverArgs !== null,
  })
} catch (err) {
  // The session file could not be read, nor set aside: started with none, the next save would lose it.
  log(`wake did not start: ${messageOf(err)}`)
  process.exit(1)
}

/** The reaper's loop: every 60 s, a round that puts the sessions due to sleep. */
const reaperLoop = (): Loop => every(roundMs() ?? REAP_EVERY_MS, 'reaper', () => engine.reapRound())

/** tg-mcp's url and token while Telegram is Auto (~/.claude.json read only then) and wake not on its way out. */
function telegramNow(): TelegramTarget | null {
  const s = settings()
  return !leaving && s.telegram === 'auto' ? telegramTarget(s, claudeJson()) : null
}

/** The Telegram router over the engine: `target` gives tg-mcp's url and token, `onState` hears its state. */
const telegramRouter = (target: () => TelegramTarget | null, onState?: (s: TelegramStatus) => void): Telegram =>
  createTelegram({
    engine,
    herdr: cliWakeHerdr,
    target,
    machine: MACHINE,
    pollTimeoutSec: () => settings().pollTimeoutSec,
    log,
    ...(onState && { onState }),
  })

/** Telegram's poll on while Telegram is on and tg-mcp's url and token are found, off otherwise. */
function followTelegram(): void {
  if (!telegram) return
  if (telegramNow()) telegram.start()
  else telegram.stop()
}

/** Whether the file already says `b`; a file without Telegram's state says off. */
const sameTelegram = (a: TelegramStatus | undefined, b: TelegramStatus): boolean =>
  (a?.state ?? 'off') === b.state && a?.host === b.host && a?.error === b.error

/**
 * Telegram's state into wake's status file, its other fields as they are (its time too: the board
 * reads since when wake runs from it); not written when the file says so already, so with Telegram
 * off the file is as it was. No file, no write: nothing outside this process wrote one.
 */
function telegramToFile(state: TelegramStatus): void {
  try {
    const now = readWakeStatus()
    if (now && !sameTelegram(now.telegram, state)) writeWakeStatus({ ...now, telegram: state })
  } catch (err) {
    wakeLog(`could not write wake's status: ${messageOf(err)}`)
  }
}

/** config.json changed: turned off, the process ends with 0 (leave); the reaper's loop follows its switch. */
function followSettings(): void {
  if (leaving?.code === 0) return
  const s = settings()
  if (!s.enabled) {
    leave(0, 'wake is stopping', 'wake turned off in config.json: stopping')
    return
  }
  if (leaving) return
  followTelegram()
  if (s.reaper.enabled && !reaper) {
    reaper = reaperLoop()
    log(reaperSaid(s))
  } else if (!s.reaper.enabled && reaper) {
    reaper.stop()
    reaper = null
    log(reaperSaid(s))
  }
}

/**
 * On the way out with `code`: no more rounds, new sleeps and wakes answered 503 `why`; the port
 * kept meanwhile, so no second wake starts beside this one. Called again (turned off while
 * restarting, say), only the code and the answer change.
 */
function leave(code: number, why: string, said: string): void {
  const first = leaving === null
  leaving = { code, why }
  log(said)
  if (!first) return
  seen?.stop()
  reaper?.stop()
  reaper = null
  telegram?.stop()
  void drainAndExit()
}

/**
 * Ends with leaving's code once the wakes and sleeps under way are done, at most the longer of
 * 180 s and a wake's own wait and 30 s; the server is stopped gently first, so the answer of a call
 * that was waited for still goes out.
 */
async function drainAndExit(): Promise<void> {
  const graceMs = Math.max(OFF_GRACE_MS, settings().wakeTimeoutSec * 1000 + WAKE_GRACE_MS)
  for (const deadline = Date.now() + graceMs; engine.busy() > 0 && Date.now() < deadline; ) await Bun.sleep(100)
  await Promise.race([server?.stop(), Bun.sleep(ANSWERS_OUT_MS)])
  process.exit(leaving?.code ?? 0)
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
async function api(req: Request, path: string): Promise<unknown> {
  if (req.method === 'GET' && path === '/status') return engine.status()
  if (req.method === 'GET' && path === '/sleeping') return engine.sleeping()
  if (req.method === 'GET' && path === '/awake') return engine.awake()
  if (req.method === 'POST' && path === '/wake') return engine.wake(await targetOf(req))
  if (req.method === 'POST' && path === '/sleep') return engine.sleep(await targetOf(req))
  return null
}

/**
 * Whether the request comes from a program on this computer, not from a web page: a page's request
 * carries an Origin, and one through DNS rebinding the page's own name as Host. The board, the
 * hooks, the old plugin's clients and a terminal send no Origin, and Host as their URL has it.
 */
function fromHere(req: Request, port: number): boolean {
  const host = req.headers.get('host')
  return !req.headers.has('origin') && (host === `127.0.0.1:${port}` || host === `localhost:${port}`)
}

const failed = (status: number, error: string): Response =>
  new Response(JSON.stringify({ ok: false, error }), { status, headers: JSON_HEADERS })

/**
 * 200 with the answer pretty-printed (a one-space indent, as the old router's), 404 with an empty
 * body, 500 { ok: false, error }; 403 for a web page, 503 for a new sleep or wake on the way out.
 * GET /alive is this process's pid, the engine and herdr never asked.
 */
async function answer(req: Request, port: number): Promise<Response> {
  if (!fromHere(req, port)) return failed(403, 'only programs on this computer may use wake, not web pages')
  try {
    const path = new URL(req.url).pathname
    if (req.method === 'GET' && path === '/alive')
      return new Response(JSON.stringify({ pid: process.pid }, null, 1), { headers: JSON_HEADERS })
    if (leaving && req.method === 'POST' && (path === '/wake' || path === '/sleep')) return failed(503, leaving.why)
    const out = await api(req, path)
    if (out === null) return new Response(null, { status: 404 })
    return new Response(JSON.stringify(out, null, 1), { headers: JSON_HEADERS })
  } catch (err) {
    return failed(500, messageOf(err))
  }
}

/**
 * The port is taken (one wake per machine, held by its port). By a wake of the board's (its /alive,
 * within 5 s, so a wake whose herdr is slow is still one): this one ends with 0, quietly, a line in
 * wake.log. By another program, the separate herdr-wake plugin's router included (named, with its
 * process): the status says portTaken (the pane and the supervisor it names kept), the error goes
 * to stderr for the supervisor, and the exit is 76, which the supervisor does not start again.
 */
async function portTaken(port: number): Promise<never> {
  if (await wakeAnswers(port, PORT_ASK_MS)) {
    wakeLog(`another wake answers on 127.0.0.1:${port}: this one ends`)
    process.exit(0)
  }
  // The separate herdr-wake plugin's router, uninstalled but its pane left open, is no wake of the
  // board's: the board must not take it for one, so it is said.
  const router = await oldRouterAt(port, PORT_ASK_MS)
  const error =
    router === null
      ? `Port ${port} is taken by another program`
      : `Port ${port} is held by the separate herdr-wake plugin’s router (process ${router})`
  try {
    const now = readWakeStatus()
    writeWakeStatus({
      state: 'portTaken',
      at: Date.now(),
      ...(now?.pane !== undefined && { pane: now.pane }),
      ...(now?.pid !== undefined && { pid: now.pid }),
      port,
      error,
    })
  } catch (err) {
    wakeLog(`could not write wake's status: ${messageOf(err)}`)
  }
  wakeLog(error)
  console.error(error)
  process.exit(PORT_TAKEN_EXIT)
}

// A stray rejection is logged, never the end of wake.
process.on('unhandledRejection', err => log(`unhandled: ${err instanceof Error ? (err.stack ?? err.message) : err}`))

if (reapDry) {
  for (const p of await engine.plan())
    console.log(`${p.sleep ? 'SLEEP' : 'keep '}  ${p.pane.padEnd(7)} ${p.name.padEnd(34)} ${p.reason}`)
  process.exit(0)
}

if (deliverArgs) {
  const [key, ...words] = deliverArgs
  if (!key) {
    console.error('usage: bun src/entrypoints/wake.ts --deliver <key> <text>')
    process.exit(1)
  }
  const item: RouteItem = {
    id: 0,
    key,
    topic: key,
    text: words.join(' '),
    meta: { message_id: 'test' },
    queued_at: new Date().toISOString(),
  }
  const r = await telegramRouter(() => null).route([item])
  console.log(JSON.stringify(r))
  process.exit('ok' in r ? 0 : 1)
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
    fetch: req => answer(req, start.port),
  })
} catch (err) {
  if (isRecord(err) && err.code === 'EADDRINUSE') await portTaken(start.port)
  log(`local API on 127.0.0.1:${start.port}: ${messageOf(err)}`)
  process.exit(1)
}
log(`wake up: ${telegramSaid(start)}, ${reaperSaid(start)}, state ${stateDir()}, API http://127.0.0.1:${start.port}`)
// Telegram's state in the status file before the supervisor hears wake is up (it writes the file then).
telegram = telegramRouter(telegramNow, telegramToFile)
followTelegram()
telegramToFile(engine.telegram.status)
process.send?.({ up: start.port })
// Each round also follows tg-mcp's url and token in ~/.claude.json while Telegram is on.
seen = every(roundMs() ?? SEEN_EVERY_MS, 'sessions seen', async () => {
  followTelegram()
  await engine.remember()
})
if (start.reaper.enabled) reaper = reaperLoop()
// A code change (the supervisor, over IPC): no new sleep nor wake, and 75 once those under way are
// done; the supervisor starts it again at once. Turned off meanwhile, it ends with 0 all the same.
process.on('message', m => {
  if (m === 'restart' && !leaving) leave(RESTART_EXIT, 'wake is restarting', 'restarting for a code change')
})
// Its supervisor gone (its pane closed, the process killed): nobody would start this one again
// after a code change nor watch its health, so it leaves as when turned off, giving its port back
// for the wake its next start opens.
process.on('disconnect', () => {
  if (leaving?.code !== 0) leave(0, 'wake is stopping', 'its supervisor is gone: stopping')
})
