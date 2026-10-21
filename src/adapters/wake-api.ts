// Whether a wake answers on its port of 127.0.0.1 (#119). GET /alive is the new wake process's own
// answer, `{ pid }`, which never waits on herdr: the supervisor's health check asks it, so a slow
// herdr never gets wake ended. GET /status asks herdr. The separate herdr-wake plugin's router has
// only /status, without the Telegram router's state the board's wake has there (isBoardWakeStatus):
// after the plugin is uninstalled its router may still hold the port, and it is never taken for
// the board's wake (oldRouterAt tells it apart).
import { isBoardWakeStatus, isWakeStatus } from '../core/wake/status.ts'
import { isRecord } from './json-store.ts'

/** The JSON GET <path> answers with a 200, or null (another status, or no JSON). Throws when no answer comes. */
async function answerOf(port: number, path: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal })
  if (!res.ok) {
    await res.body?.cancel()
    return null
  }
  return res.json().catch(() => null)
}

/** /alive's answer: an object with a number `pid`. */
const isAlive = (v: unknown): boolean => isRecord(v) && typeof v.pid === 'number'

/** Whether the new wake process answers GET /alive on the port within `timeoutMs`. */
export async function wakeAlive(port: number, timeoutMs: number): Promise<boolean> {
  try {
    return isAlive(await answerOf(port, '/alive', AbortSignal.timeout(timeoutMs)))
  } catch {
    return false
  }
}

/** Whether the board's wake answers on the port within `timeoutMs` in all: /alive, else its /status; never the old router. */
export async function wakeAnswers(port: number, timeoutMs: number): Promise<boolean> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    return isAlive(await answerOf(port, '/alive', signal)) || isBoardWakeStatus(await answerOf(port, '/status', signal))
  } catch {
    return false
  }
}

/**
 * The separate herdr-wake plugin's router on the port, within `timeoutMs`: its pid, as its /status
 * gives it (a wake's /status, not the board's wake's); null for the board's wake, another program,
 * or nothing answering in time.
 */
export async function oldRouterAt(port: number, timeoutMs: number): Promise<number | null> {
  try {
    const status = await answerOf(port, '/status', AbortSignal.timeout(timeoutMs))
    return isWakeStatus(status) && !isBoardWakeStatus(status) && isRecord(status) && typeof status.pid === 'number'
      ? status.pid
      : null
  } catch {
    return null
  }
}
