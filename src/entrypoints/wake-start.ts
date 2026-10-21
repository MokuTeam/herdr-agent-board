// Wake's startup entry (#119): `bun src/entrypoints/wake-start.ts [--again]`. Makes sure wake's
// pane runs (services/wake/start.ts); `--again` closes the pane there is and opens a new one (the
// board's "Start again"). The board's own start never waits for it: herdr runs each startup entry
// on its own. config.json's kill switch is read before anything: off, or a config.json that does not
// parse, it ends at once with no herdr call. It always ends with 0, within its deadline
// (START_DEADLINE_MS; BOARD_WAKE_START_DEADLINE_MS in tests), whatever herdr does; errors go to
// wake.log and the status file.
import { existsSync } from 'node:fs'
import { configFile, readConfigFile } from '../adapters/config-file.ts'
import { herdr } from '../adapters/herdr.ts'
import { ROOT } from '../adapters/paths.ts'
import { isAlive } from '../adapters/process.ts'
import { readWakeStatus, wakeLog, writeWakeStatus } from '../adapters/wake-files.ts'
import { wakeConfig, wakeSwitch } from '../core/wake/config.ts'
import { isWakeStatus } from '../core/wake/status.ts'
import { START_DEADLINE_MS, startWake } from '../services/wake/start.ts'

/** One herdr call waits this long at most (less when the deadline is nearer). */
const CALL_MS = 8000
/** How long a wake has to answer GET /status. */
const ANSWER_MS = 2000

// The kill switch, before anything else: off, wake's start asks herdr nothing and writes nothing.
const on = wakeSwitch({ exists: existsSync(configFile()), raw: readConfigFile() })
if (!on) process.exit(0)

const again = process.argv.includes('--again')
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
    const now = readWakeStatus()
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

/** Whether a wake answers on the port. */
async function answers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(ANSWER_MS) })
    return res.ok && isWakeStatus(await res.json())
  } catch {
    return false
  }
}

const result = await startWake(
  {
    herdr: (args, timeoutMs) => herdr(args, Math.max(1, Math.min(timeoutMs ?? CALL_MS, endsAt - Date.now()))),
    answers,
    readStatus: () => readWakeStatus(),
    writeStatus: s => writeWakeStatus(s),
    alive: isAlive,
    log,
    sleep: ms => Bun.sleep(ms),
    now: Date.now,
    root: ROOT,
  },
  { on, settings: wakeConfig(readConfigFile()?.wake), again },
)
console.log(`wake's start: ${result}`)
process.exit(0)
