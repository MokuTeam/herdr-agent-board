// Whether a wake answers on its port of 127.0.0.1 (#119). GET /alive is the new wake process's own
// answer, `{ pid }`, which never waits on herdr: the supervisor's health check asks it, so a slow
// herdr never gets wake ended. GET /status asks herdr, and the old herdr-wake router has only that:
// whether the port is held by a wake at all asks /alive first, then /status.
import { isWakeStatus } from '../core/wake/status.ts'
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

/** Whether a wake, the new one or the old router, answers on the port within `timeoutMs` in all: /alive, else /status. */
export async function wakeAnswers(port: number, timeoutMs: number): Promise<boolean> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    return isAlive(await answerOf(port, '/alive', signal)) || isWakeStatus(await answerOf(port, '/status', signal))
  } catch {
    return false
  }
}
