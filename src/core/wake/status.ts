// Wake's status file (wake-status.json in the board's state folder) and the one state the board
// shows of wake (#119). The supervisor in wake's pane writes it (starting, running, crashed,
// stopped), as do wake's start (held, failed, stopped, starting) and the wake process when its
// port is another program's (portTaken). `pane` and `pid` are wake's pane and its supervisor's
// process, as board.json records the board's: a pane whose process is gone is a restored bare shell.

export type WakeStatusState = 'starting' | 'running' | 'crashed' | 'stopped' | 'held' | 'portTaken' | 'failed'

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
}

const STATES: readonly string[] = ['starting', 'running', 'crashed', 'stopped', 'held', 'portTaken', 'failed']

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const isState = (v: unknown): v is WakeStatusState => typeof v === 'string' && STATES.includes(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isId = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0

/** The file's content as the board reads it: a state and a time, the other fields only when of their type; null otherwise. */
export function asWakeStatus(value: unknown): WakeStatusFile | null {
  const v = record(value)
  if (!v || !isState(v.state) || !isTime(v.at)) return null
  const crashes = Array.isArray(v.crashes) ? v.crashes.filter(isTime) : null
  return {
    state: v.state,
    at: v.at,
    ...(typeof v.pane === 'string' && v.pane !== '' && { pane: v.pane }),
    ...(isId(v.pid) && { pid: v.pid }),
    ...(typeof v.error === 'string' && { error: v.error }),
    ...(crashes && { crashes }),
    ...(isId(v.port) && Number(v.port) <= 65535 && { port: v.port }),
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
