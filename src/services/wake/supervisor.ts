// Wake's supervisor, what wake's pane runs (entrypoints/wake-run.ts): it starts the wake process and
// keeps it going (#119, safeguards 4 and 5). A crash starts it again after a pause (afterCrash in
// core/crash-policy.ts: 2 s, 10 s, 30 s); five crashes in ten minutes stop it, with the last error
// on screen and in wake's status file, until the next code change or "Start again". A process whose
// API stops answering is ended, which counts as a crash. Wake turned off: the process ends with 0
// and the supervisor with it. A code change asks the process to restart; it ends with 75 once
// nothing is under way and starts again at once. A port another program holds (76, status
// portTaken) is final too, until a code change or "Start again".
// The status file records the pane and this process, as board.json does the board's.
import { afterCrash } from '../../core/crash-policy.ts'
import type { WakeStatusFile } from '../../core/wake/status.ts'

/** The wake process as the supervisor sees it. */
export interface WakeChild {
  /** Its end: the exit code, null when it was killed. */
  onExit(cb: (code: number | null) => void): void
  onMessage(cb: (m: unknown) => void): void
  /** Each line it writes to stderr. */
  onErrorLine(cb: (line: string) => void): void
  send(m: unknown): void
  kill(): void
}

export interface SupervisorDeps {
  spawn(): WakeChild
  /** Whether a wake answers its /status (within 5 s). */
  health(): Promise<boolean>
  writeStatus(s: WakeStatusFile): void
  /** On the pane's screen. */
  print(text: string): void
  /** In wake.log. */
  log(text: string): void
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(t: unknown): void
  exit(code: number): void
  /** HERDR_PANE_ID: the pane this runs in. */
  pane?: string
  /** This process. */
  pid: number
}

/** How often the API is asked once it listens. */
export const HEALTH_EVERY_MS = 15_000
/** Missed answers in a row that end the process. */
export const HEALTH_MISSES = 3
/** A process that does not say it listens is asked from this long after its start on. */
export const UP_GRACE_MS = 30_000
/** The wake process's exit for a restart (a code change): started again at once. */
export const RESTART_EXIT = 75
/** The wake process's exit when another program holds its port (status portTaken): not started again. */
export const PORT_TAKEN_EXIT = 76

/** The port in the wake process's `{ up: <port> }`, or null for another message. */
function upPort(m: unknown): number | null {
  if (!m || typeof m !== 'object') return null
  const up = (m as Record<string, unknown>).up
  return typeof up === 'number' ? up : null
}

export function createSupervisor(deps: SupervisorDeps): { start(): void; codeChanged(): void } {
  let child: WakeChild | null = null
  /** The recent crashes' times. */
  let crashes: number[] = []
  /** The start after a crash, while it waits. */
  let retry: unknown = null
  /** The next health check. */
  let check: unknown = null
  /** Crashed five times, or its port taken: no start until a code change. */
  let parked = false
  /** A restart was asked for: the exit that follows is no crash. */
  let wanted = false

  const mark = (): { at: number; pane?: string; pid: number } => ({
    at: deps.now(),
    ...(deps.pane !== undefined && { pane: deps.pane }),
    pid: deps.pid,
  })

  function say(text: string): void {
    deps.print(text)
    deps.log(text)
  }

  function writeStatus(s: WakeStatusFile): void {
    try {
      deps.writeStatus(s)
    } catch (err) {
      deps.log(`could not write wake's status: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function stopChecks(): void {
    if (check !== null) deps.clearTimer(check)
    check = null
  }

  function start(): void {
    if (retry !== null) deps.clearTimer(retry)
    retry = null
    parked = false
    wanted = false
    writeStatus({ state: 'starting', ...mark() })
    const c = deps.spawn()
    child = c
    let lastError = ''
    let misses = 0
    let hung = false

    const checkIn = (ms: number): void => {
      stopChecks()
      check = deps.setTimer(() => void healthCheck(), ms)
    }
    async function healthCheck(): Promise<void> {
      check = null
      const ok = await deps.health().catch(() => false)
      if (child !== c) return
      misses = ok ? 0 : misses + 1
      if (misses < HEALTH_MISSES) return checkIn(HEALTH_EVERY_MS)
      hung = true
      say(`wake did not answer ${HEALTH_MISSES} health checks in a row: ended`)
      c.kill()
    }

    c.onErrorLine(line => {
      if (line.trim()) lastError = line.trim()
    })
    c.onMessage(m => {
      const port = upPort(m)
      if (child !== c || port === null) return
      writeStatus({ state: 'running', ...mark(), port })
      misses = 0
      checkIn(HEALTH_EVERY_MS)
    })
    c.onExit(code => {
      if (child !== c) return
      child = null
      stopChecks()
      if (hung) return crashed(code, `no answer to ${HEALTH_MISSES} health checks in a row`)
      if (code === 0) return void turnedOff()
      if (code === RESTART_EXIT || wanted) return start()
      if (code === PORT_TAKEN_EXIT) {
        // The wake process wrote portTaken itself: so it stays, until a code change or Start again.
        parked = true
        return say(lastError || 'wake ended: another program holds its port')
      }
      crashed(code, lastError)
    })
    checkIn(UP_GRACE_MS)
  }

  /** The process ended with 0: wake turned off (status stopped), or another wake answers on its port (its status left to that one). */
  async function turnedOff(): Promise<void> {
    if (await deps.health().catch(() => false)) say('another wake answers on its port: this one ends')
    else {
      writeStatus({ state: 'stopped', ...mark() })
      say('wake turned off: ended')
    }
    deps.exit(0)
  }

  function crashed(code: number | null, lastError: string): void {
    const how = code ?? 'killed'
    const error = lastError || `exit ${how}`
    const next = afterCrash(crashes, deps.now())
    crashes = next.crashes
    if (next.wait) {
      writeStatus({ state: 'starting', ...mark(), error, crashes })
      say(`wake stopped (exit ${how}). It starts again in ${next.wait / 1000} s.`)
      retry = deps.setTimer(start, next.wait)
      return
    }
    parked = true
    writeStatus({ state: 'crashed', ...mark(), error, crashes })
    say(
      `wake stopped (exit ${how}) ${crashes.length} times in 10 minutes. It starts again on the next code change, or with Start again. The last error: ${error}`,
    )
  }

  return {
    start,
    codeChanged() {
      crashes = []
      if (child) {
        wanted = true
        try {
          child.send('restart')
        } catch {
          child.kill()
        }
        return
      }
      if (retry !== null || parked) start()
    },
  }
}
