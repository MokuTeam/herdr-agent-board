// Wake's status file (wake-status.json in the board's state folder) and the one state the board
// shows of wake (#119). The supervisor in wake's pane writes it (starting, running, crashed,
// stopped), as do wake's start (held, failed, stopped, starting) and the wake process when its
// port is another program's (portTaken). `pane` and `pid` are wake's pane and its supervisor's
// process, as board.json records the board's: a pane whose process is gone is a restored bare shell.
// The wake process also writes its Telegram router's state there (`telegram`), which every other
// writer keeps as it is.

export type WakeStatusState = 'starting' | 'running' | 'crashed' | 'stopped' | 'held' | 'portTaken' | 'failed'

/**
 * The Telegram router's state, in wake's /status and its status file: off (Telegram off, no tg-mcp
 * url and token found, or wake on its way out), polling tg-mcp at `host`, or its last poll failed,
 * with why. Never the token.
 */
export interface TelegramStatus {
  state: 'off' | 'polling' | 'error'
  /** tg-mcp's host and port, while on. */
  host?: string
  /** Why the last poll failed, in state error. */
  error?: string
}

export interface WakeStatusFile {
  state: WakeStatusState
  /** When it was written (ms). */
  at: number
  /** Wake's pane. */
  pane?: string
  /** The supervisor's process in that pane. */
  pid?: number
  /** The last error's line: the wake process's last stderr line, or why the start failed. */
  error?: string
  /** The recent crashes' times (core/crash-policy.ts). */
  crashes?: number[]
  /** The port the wake process listens on, or the one another program holds. */
  port?: number
  /** The Telegram router's state, as the wake process last wrote it (stale once that process is gone). */
  telegram?: TelegramStatus
}

const STATES: readonly string[] = ['starting', 'running', 'crashed', 'stopped', 'held', 'portTaken', 'failed']

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const isState = (v: unknown): v is WakeStatusState => typeof v === 'string' && STATES.includes(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isId = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0
const TELEGRAM_STATES: readonly string[] = ['off', 'polling', 'error']
const isTelegramState = (v: unknown): v is TelegramStatus['state'] =>
  typeof v === 'string' && TELEGRAM_STATES.includes(v)

/** The Telegram router's state as read: a known state, `host` and `error` only when strings; null otherwise. */
export function asTelegramStatus(value: unknown): TelegramStatus | null {
  const v = record(value)
  if (!v || !isTelegramState(v.state)) return null
  return {
    state: v.state,
    ...(typeof v.host === 'string' && { host: v.host }),
    ...(typeof v.error === 'string' && { error: v.error }),
  }
}

/** The file's content as the board reads it: a state and a time, the other fields only when of their type; null otherwise. */
export function asWakeStatus(value: unknown): WakeStatusFile | null {
  const v = record(value)
  if (!v || !isState(v.state) || !isTime(v.at)) return null
  const crashes = Array.isArray(v.crashes) ? v.crashes.filter(isTime) : null
  const telegram = asTelegramStatus(v.telegram)
  return {
    state: v.state,
    at: v.at,
    ...(typeof v.pane === 'string' && v.pane !== '' && { pane: v.pane }),
    ...(isId(v.pid) && { pid: v.pid }),
    ...(typeof v.error === 'string' && { error: v.error }),
    ...(crashes && { crashes }),
    ...(isId(v.port) && Number(v.port) <= 65535 && { port: v.port }),
    ...(telegram && { telegram }),
  }
}

/** What the panel, the toolbar and the doctor show. */
export type WakeState = 'off' | 'starting' | 'running' | 'crashed' | 'notRunning' | 'held' | 'portTaken'

/** How long "Starting…" lasts after the status file's `at` with nothing answering. */
export const STARTING_MS = 60_000

/**
 * Wake's state from the kill switch (`on`), the status file and whether a wake answers on its port:
 * off; held by the old plugin; running while a wake answers; else what the file says (crashed,
 * port taken, starting for at most STARTING_MS); anything else is "not running".
 */
export function wakeState(f: { on: boolean; status: WakeStatusFile | null; answers: boolean; now: number }): WakeState {
  if (!f.on) return 'off'
  const state = f.status?.state
  if (state === 'held') return 'held'
  if (f.answers) return 'running'
  if (state === 'crashed') return 'crashed'
  if (state === 'portTaken') return 'portTaken'
  if (state === 'starting' && f.status && f.now - f.status.at < STARTING_MS) return 'starting'
  return 'notRunning'
}

/** Whether a /status answer is a wake's (the old router's or the new one's): an object with a number `pid` and an object `sessions`. */
export function isWakeStatus(value: unknown): boolean {
  const v = record(value)
  return v !== null && typeof v.pid === 'number' && record(v.sessions) !== null
}

/**
 * Whether a /status answer is the board's own wake's, not the separate herdr-wake plugin's router
 * (which may still hold the port after it was uninstalled): a wake's, with its Telegram router's
 * state, a field the old router never had.
 */
export function isBoardWakeStatus(value: unknown): boolean {
  return isWakeStatus(value) && asTelegramStatus(record(value)?.telegram) !== null
}
