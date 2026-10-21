// Wake's startup entry (#119): `bun src/entrypoints/wake-start.ts [--again]`. Makes sure wake's
// pane runs (services/wake/start.ts); `--again` closes the pane there is and opens a new one (the
// board's "Start again"). The board's own start never waits for it: herdr runs each startup entry
// on its own. config.json's kill switch is read before anything: off, or a config.json that does not
// parse, it ends at once with no herdr call. It always ends with 0, within its deadline
// (START_DEADLINE_MS; BOARD_WAKE_START_DEADLINE_MS in tests), whatever herdr does; errors go to
// wake.log and the status file. One start runs at a time (herdr's startup entry, the board's start
// and a second click may come together): it holds `wake-start.lock` until it ends, and a start that
// finds another one's lock leaves it the work and ends with `present`. The first start after the
// separate herdr-wake plugin was removed by hand takes over what it left, once
// (services/wake/takeover.ts).
import { existsSync } from 'node:fs'
import { homedir, uptime } from 'node:os'
import { configFile, readConfigFile } from '../adapters/config-file.ts'
import { herdr } from '../adapters/herdr.ts'
import { ROOT } from '../adapters/paths.ts'
import { isAlive } from '../adapters/process.ts'
import { wakeAnswers } from '../adapters/wake-api.ts'
import { boardPaneNow, readWakeStatus, takeWakeStartLock, wakeLog, writeWakeStatus } from '../adapters/wake-files.ts'
import { wakeConfig, wakeSwitch } from '../core/wake/config.ts'
import { type BoardPlace, START_DEADLINE_MS, startWake } from '../services/wake/start.ts'
import { takeOverAtFirstStart } from '../services/wake/takeover.ts'

/** One herdr call waits this long at most (less when the deadline is nearer). */
const CALL_MS = 8000
/** How long a wake has to answer on its port (GET /alive, else the old router's /status). */
const ANSWER_MS = 2000

// The kill switch, before anything else: off, wake's start asks herdr nothing and writes nothing.
const on = wakeSwitch({ exists: existsSync(configFile()), raw: readConfigFile() })
if (!on) process.exit(0)

const again = process.argv.includes('--again')
/** When this computer started: a status from before names a pane and a process of an earlier boot. */
const bootedAt = Date.now() - uptime() * 1000
const testDeadline = Number(process.env.BOARD_WAKE_START_DEADLINE_MS)
const deadlineMs = Number.isInteger(testDeadline) && testDeadline > 0 ? testDeadline : START_DEADLINE_MS
const endsAt = Date.now() + deadlineMs

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const log = (text: string): void => wakeLog(`wake's start: ${text}`)

/** Whatever goes wrong is logged; the process still ends with 0. */
function giveUp(text: string): never {
  log(text)
  process.exit(0)
}
process.on('uncaughtException', err => giveUp(`unexpected: ${messageOf(err)}`))
process.on('unhandledRejection', err => giveUp(`unexpected: ${messageOf(err)}`))

// One start at a time: the lock is given back however this process ends (its end, an error, the
// deadline), as every way out goes through process.exit. A lock that cannot be made at all (the
// state folder not writable) is logged, and the start goes on as it did before there was one.
let release: (() => void) | null
try {
  release = takeWakeStartLock({ pid: process.pid, now: Date.now(), maxAgeMs: deadlineMs, alive: isAlive })
} catch (err) {
  log(`no lock: ${messageOf(err)}`)
  release = () => {}
}
if (!release) {
  log('another start is under way: left to it')
  console.log("wake's start: present")
  process.exit(0)
}
process.on('exit', release)

// The deadline: herdr hanging (or anything else) never keeps this entry, and one of herdr's places
// for plugin commands, for long. The status keeps the pane and supervisor it names.
setTimeout(() => {
  const error = `did not end within ${deadlineMs / 1000} s`
  try {
    const read = readWakeStatus()
    const now = read && read.at >= bootedAt ? read : null
    writeWakeStatus({
      state: 'failed',
      at: Date.now(),
      error,
      ...(now?.pane !== undefined && { pane: now.pane }),
      ...(now?.pid !== undefined && { pid: now.pid }),
    })
  } catch {}
  giveUp(error)
}, deadlineMs)

/** The board's workspace (config.json's `workspace`, else Board, as entrypoints/open.ts names it) and the pane board.json names. */
function boardPlace(): BoardPlace {
  const raw = readConfigFile()
  return { label: typeof raw?.workspace === 'string' && raw.workspace ? raw.workspace : 'Board', pane: boardPaneNow() }
}

/** One herdr call, never past the deadline. */
const herdrCall = <T = unknown>(args: string[], timeoutMs?: number): Promise<T> =>
  herdr<T>(args, Math.max(1, Math.min(timeoutMs ?? CALL_MS, endsAt - Date.now())))

const result = await startWake(
  {
    herdr: herdrCall,
    answers: port => wakeAnswers(port, ANSWER_MS),
    readStatus: () => readWakeStatus(),
    writeStatus: s => writeWakeStatus(s),
    alive: isAlive,
    log,
    sleep: ms => Bun.sleep(ms),
    now: Date.now,
    bootedAt,
    root: ROOT,
    // The separate herdr-wake plugin removed by hand: its config, sleeping list and hooks taken over once.
    takeOver: () => takeOverAtFirstStart({ herdr: herdrCall, home: homedir(), env: process.env, log }),
  },
  { on, settings: wakeConfig(readConfigFile()?.wake), board: boardPlace(), again },
)
console.log(`wake's start: ${result}`)
process.exit(0)
