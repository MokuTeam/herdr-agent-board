// herdr-wake: the router that puts idle Claude sessions to sleep and wakes them, spoken to over
// HTTP. Kept behind SleepProvider so another sleep/wake backend can take its place later.
import { t } from '../core/lang.ts'
import type { Item } from '../core/types.ts'

/** A session herdr-wake put to sleep, as GET /sleeping lists it. */
export interface SleepingSession {
  session?: string
  pane?: string
  workspace?: string
  name?: string
  slept_at?: string
  /** Read from the new wake's session file, not answered by a wake (integrations/wake.ts): the board checks its pane. */
  fromFile?: true
  /** The profile folder it ran in, and that folder's listed id (the new wake's answers and file). */
  profile?: { dir: string; id?: string }
  [extra: string]: unknown
}

/** `{ ok: true }`, or `{ ok: false, error }` with a message for the user. */
export type WakeResult = { ok: true } | { ok: false; error: string }
export type SleepResult = WakeResult

export interface SleepProvider {
  /** Sessions put to sleep; `[]` on error, timeout (2 s) or no url. Cached for 5 s. */
  sleepers(): Promise<SleepingSession[]>
  /** After a wake or sleep: the next sleepers() reads again. */
  forget(): void
  /** Wake a session (takes 10 to 30 s). */
  wake(item: Item): Promise<WakeResult>
  /** Put an idle session to sleep: Claude exits, the pane stays as "💤 <name>". */
  sleep(item: Item): Promise<SleepResult>
}

const CACHE_MS = 5000
const SLEEPERS_TIMEOUT_MS = 2000
const WAKE_TIMEOUT_MS = 180_000
const SLEEP_TIMEOUT_MS = 60_000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Which wake answers at the url: the separate herdr-wake plugin's router, or the board's own (#119), each named so. */
export type WakeName = 'herdr-wake' | 'wake'

/** The texts that name the wake that answers. */
const NAMED: Record<WakeName, { down: string; unknown: string }> = {
  'herdr-wake': { down: 'err.wakeDown', unknown: 'err.sleep.unknown' },
  wake: { down: 'err.boardWakeDown', unknown: 'err.sleep.unknownToWake' },
}

/** Why herdr-wake refused to sleep a session, in the user's words. */
function sleepRefusal(why: string, who: WakeName): string {
  if (/not idle/.test(why)) return t('err.sleep.busy')
  if (/did not go to sleep/.test(why)) return t('err.sleep.stayed')
  if (/no running session/.test(why)) return t(NAMED[who].unknown)
  return why || t('err.noAnswer')
}

export function createHerdrWake(
  url: string | null,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
  who: WakeName = 'herdr-wake',
): SleepProvider {
  let cache: { at: number; list: SleepingSession[] } = { at: 0, list: [] }

  const post = async (path: string, item: Item, timeoutMs: number): Promise<Record<string, unknown>> => {
    const res = await fetchFn(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: item.pane }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body: unknown = await res.json()
    return isObject(body) ? body : {}
  }

  return {
    async sleepers() {
      if (!url) return []
      if (now() - cache.at < CACHE_MS) return cache.list
      let list: unknown = []
      try {
        const res = await fetchFn(`${url}/sleeping`, { signal: AbortSignal.timeout(SLEEPERS_TIMEOUT_MS) })
        if (res.ok) list = await res.json()
      } catch {}
      cache = { at: now(), list: Array.isArray(list) ? list.filter(isObject) : [] }
      return cache.list
    },

    forget() {
      cache.at = 0
    },

    async wake(item) {
      try {
        const r = await post('/wake', item, WAKE_TIMEOUT_MS)
        return r.ok
          ? { ok: true }
          : { ok: false, error: t('err.wake', { name: item.name, why: String(r.error ?? t('err.noAnswer')) }) }
      } catch (err) {
        return { ok: false, error: t(NAMED[who].down, { why: messageOf(err) }) }
      }
    },

    async sleep(item) {
      try {
        const r = await post('/sleep', item, SLEEP_TIMEOUT_MS)
        if (r.ok) return { ok: true }
        return { ok: false, error: t('err.sleep', { name: item.name, why: sleepRefusal(String(r.error ?? ''), who) }) }
      } catch (err) {
        return { ok: false, error: t(NAMED[who].down, { why: messageOf(err) }) }
      }
    },
  }
}

const ANSWER_TIMEOUT_MS = 5000

/**
 * Whether herdr-wake answers at `url` now (GET /sleeping, 5 s at most), not cached: { ok }, or
 * { ok: false, why } with the reason as it came (an HTTP status, the connection's error code, the
 * error's message).
 */
export async function herdrWakeAnswers(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; why: string }> {
  try {
    const res = await fetchFn(`${url.replace(/\/+$/, '')}/sleeping`, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) })
    return res.ok ? { ok: true } : { ok: false, why: `HTTP ${res.status}` }
  } catch (err) {
    const cause = err instanceof Error && isObject(err.cause) ? err.cause.code : undefined
    const code = isObject(err) ? err.code : undefined
    return {
      ok: false,
      why: String((typeof cause === 'string' && cause) || (typeof code === 'string' && code) || messageOf(err)),
    }
  }
}

// One provider per url for the whole process, so the 5 s cache the model reads is the one the
// server and scheduler invalidate after a wake or sleep.
const shared = new Map<string | null, SleepProvider>()

export function sharedHerdrWake(url: string | null): SleepProvider {
  const known = shared.get(url)
  if (known) return known
  const created = createHerdrWake(url)
  shared.set(url, created)
  return created
}
