// The board's side of the new wake (#119): the sleeping sessions without ever waiting on it (call
// 10, safeguard 14), whether it answers now, and, with wake off, the sleepers its session file still
// has (call 28). The session file is only read here: the wake process is its one writer. Wake and
// sleep go to wake's API as they go to herdr-wake's (integrations/herdr-wake.ts).
import { peekWakeSessions } from '../adapters/wake-files.ts'
import { isWakeStatus } from '../core/wake/status.ts'
import { createHerdrWake, type SleepingSession, type SleepProvider } from './herdr-wake.ts'

/** down: nothing listens (ECONNREFUSED), wake is off or another program answers; slow: it took the connection but did not answer in time. */
export type Reach = 'up' | 'down' | 'slow'

export interface BoardWake extends SleepProvider {
  /** Whether wake answers now (GET /status, 2 s). */
  reach(): Promise<Reach>
  readonly mode: 'new'
}

/** The background question is asked again this long after the last one started. */
const ASK_EVERY_MS = 5000
/** How long wake has to answer. */
const ANSWER_MS = 2000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A fetch that gave up waiting (AbortSignal.timeout), as opposed to one that could not connect. */
const isTimeout = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'name' in err && (err.name === 'TimeoutError' || err.name === 'AbortError')

/** The sessions asleep in wake's session file, as GET /sleeping lists them, each marked fromFile; the board checks their panes. */
function fileSleepers(sessionsFile: string): SleepingSession[] {
  const list: SleepingSession[] = []
  for (const [pane, s] of Object.entries(peekWakeSessions(sessionsFile))) {
    if (!s.slept_at) continue
    list.push({
      name: s.name || s.title || '',
      pane,
      session: s.session,
      workspace: '',
      slept_at: new Date(s.slept_at).toISOString(),
      exited: !!s.exited,
      ...(s.profileDir && { profile: { dir: s.profileDir, ...(s.profile && { id: s.profile }) } }),
      fromFile: true,
    })
  }
  return list
}

/**
 * Call 10, safeguard 14: sleepers() gives the last list at once and asks again in the background
 * (every 5 s, 2 s timeout); while wake does not answer, or is off, the list is wake's session
 * file's (read only), each entry `fromFile: true`. The first call, with no answer yet, gives the
 * file's list too, so a one-shot command (`board list`) sees the sleepers.
 */
export function createBoardWake(o: {
  url: string
  sessionsFile: string
  fetch?: typeof fetch
  now?: () => number
}): BoardWake {
  const fetchFn = o.fetch ?? fetch
  const now = o.now ?? Date.now
  /** wake's last list, while its last answer was one. */
  let answer: SleepingSession[] | null = null
  let askedAt = Number.NEGATIVE_INFINITY
  let asking = false

  const ask = async (): Promise<void> => {
    asking = true
    askedAt = now()
    try {
      const res = await fetchFn(`${o.url}/sleeping`, { signal: AbortSignal.timeout(ANSWER_MS) })
      const list: unknown = res.ok ? await res.json() : null
      answer = Array.isArray(list) ? list.filter(isObject) : null
    } catch {
      answer = null
    } finally {
      asking = false
    }
  }
  // The answers' own wake and sleep (POST /wake, /sleep { target: pane }), as herdr-wake's.
  const api = createHerdrWake(o.url, fetchFn, now)

  return {
    mode: 'new',
    async sleepers() {
      if (!asking && now() - askedAt >= ASK_EVERY_MS) void ask()
      return answer ?? fileSleepers(o.sessionsFile)
    },
    forget() {
      askedAt = Number.NEGATIVE_INFINITY
    },
    wake: item => api.wake(item),
    sleep: item => api.sleep(item),
    async reach() {
      try {
        const res = await fetchFn(`${o.url}/status`, { signal: AbortSignal.timeout(ANSWER_MS) })
        return res.ok && isWakeStatus(await res.json()) ? 'up' : 'down'
      } catch (err) {
        return isTimeout(err) ? 'slow' : 'down'
      }
    },
  }
}

// One per url and file for the whole process, as sharedHerdrWake: the list the model reads is the
// one the server and the scheduler forget after a wake or a sleep.
const shared = new Map<string, BoardWake>()

export function sharedBoardWake(url: string, sessionsFile: string): BoardWake {
  const key = JSON.stringify([url, sessionsFile])
  const known = shared.get(key)
  if (known) return known
  const created = createBoardWake({ url, sessionsFile })
  shared.set(key, created)
  return created
}

/** Call 28 with wake off: the old provider's list, completed by the file's sleepers (marked fromFile) it does not already have. */
export function withFileSleepers(provider: SleepProvider, sessionsFile: string): SleepProvider {
  return {
    async sleepers() {
      const list = await provider.sleepers()
      const listed = new Set(list.map(s => s.session))
      return [...list, ...fileSleepers(sessionsFile).filter(s => !listed.has(s.session))]
    },
    forget: () => provider.forget(),
    wake: item => provider.wake(item),
    sleep: item => provider.sleep(item),
  }
}

const completed = new Map<string, { provider: SleepProvider; wrapped: SleepProvider }>()

/** withFileSleepers, one per old provider and file for the whole process. */
export function sharedFileSleepers(provider: SleepProvider, sessionsFile: string): SleepProvider {
  const known = completed.get(sessionsFile)
  if (known?.provider === provider) return known.wrapped
  const wrapped = withFileSleepers(provider, sessionsFile)
  completed.set(sessionsFile, { provider, wrapped })
  return wrapped
}
