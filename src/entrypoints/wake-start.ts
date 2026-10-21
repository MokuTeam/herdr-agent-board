// Wake's startup entry (#119): `bun src/entrypoints/wake-start.ts [--again]`. Makes sure wake's
// pane runs (services/wake/start.ts); `--again` closes the pane there is and opens a new one (the
// board's "Start again"). The board's own start never waits for it: herdr runs each startup entry
// on its own. config.json's kill switch is read before anything: off, or a config.json that does not
// parse, it ends at once with no herdr call. It always ends with 0, within its deadline
// (START_DEADLINE_MS; BOARD_WAKE_START_DEADLINE_MS in tests), whatever herdr does; errors go to
// wake.log and the status file.
import { existsSync, readFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { configFile, readConfigFile } from '../adapters/config-file.ts'
import { herdr } from '../adapters/herdr.ts'
import { boardFile, ROOT } from '../adapters/paths.ts'
import { isAlive } from '../adapters/process.ts'
import { wakeAnswers } from '../adapters/wake-api.ts'
import { readWakeStatus, wakeLog, writeWakeStatus } from '../adapters/wake-files.ts'
import { asSavedBoard } from '../core/board-pane.ts'
import { wakeConfig, wakeSwitch } from '../core/wake/config.ts'
import { type BoardPlace, START_DEADLINE_MS, startWake } from '../services/wake/start.ts'

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
  let pane: string | null = null
  try {
    pane = asSavedBoard(JSON.parse(readFileSync(boardFile(), 'utf8')))?.pane ?? null
  } catch {}
  return { label: typeof raw?.workspace === 'string' && raw.workspace ? raw.workspace : 'Board', pane }
}

const result = await startWake(
  {
    herdr: (args, timeoutMs) => herdr(args, Math.max(1, Math.min(timeoutMs ?? CALL_MS, endsAt - Date.now()))),
    answers: port => wakeAnswers(port, ANSWER_MS),
    readStatus: () => readWakeStatus(),
    writeStatus: s => writeWakeStatus(s),
    alive: isAlive,
    log,
    sleep: ms => Bun.sleep(ms),
    now: Date.now,
    bootedAt,
    root: ROOT,
  },
  { on, settings: wakeConfig(readConfigFile()?.wake), board: boardPlace(), again },
)
console.log(`wake's start: ${result}`)
process.exit(0)
