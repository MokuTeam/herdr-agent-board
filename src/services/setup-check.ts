// What of the board is not set up on this computer (core/setup.ts), for the web board's quiet
// note: { todo, sig } goes with the board, the sig naming the problems (in English, so a language
// switch is no news). Checked at the start, every 10 minutes and whenever the page opens the
// note; requests a few seconds apart, or while a check runs, share one. After Install from the
// Profiles panel it runs again at once.
import { gatherFacts } from '../adapters/setup-facts.ts'
import { t } from '../core/lang.ts'
import { checkSetup, type SetupCheck, type SetupFacts, type SetupSummary, setupSummary } from '../core/setup.ts'
import type { Deps } from './deps.ts'

export interface SetupChecks {
  /** From the last check; null before the first one ends. */
  summary(): SetupSummary | null
  /** The checks in the board's language, run again unless one ran a moment ago. */
  now(): Promise<SetupCheck[]>
  /**
   * The checks run again even if one ran a moment ago: the files changed (Install wrote a
   * settings.json). After a check running now, which may have read them before.
   */
  again(): Promise<SetupCheck[]>
  /** The first check now, then one every 10 minutes. */
  start(): void
  /** No more checks on the clock; one still running publishes nothing when it ends. */
  stop(): void
}

const EVERY_MS = 10 * 60_000
const SHARED_MS = 3000

/** `onChange` publishes the board again; `gather` reads this computer (tests hand in their own). */
export function createSetupChecks({
  deps,
  onChange,
  gather = () => gatherFacts(deps.cfg),
}: {
  deps: Pick<Deps, 'cfg' | 'log'>
  onChange: () => void
  gather?: () => Promise<SetupFacts>
}): SetupChecks {
  let summary: SetupSummary | null = null
  let facts: SetupFacts | null = null
  let at = 0
  let running: Promise<SetupCheck[]> | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false

  function now(): Promise<SetupCheck[]> {
    if (running) return running
    if (facts && Date.now() - at < SHARED_MS) return Promise.resolve(checkSetup(facts, t))
    running = (async () => {
      const next = await gather()
      facts = next
      at = Date.now()
      summary = setupSummary(checkSetup(next))
      if (!stopped) onChange()
      return checkSetup(next, t)
    })().finally(() => {
      running = null
    })
    return running
  }

  async function again(): Promise<SetupCheck[]> {
    await running?.catch(() => {})
    // What the last one read is old news; two asking at once share the check the first starts.
    at = 0
    return now()
  }

  const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
  return {
    summary: () => summary,
    now,
    again,
    start() {
      now().catch(err => deps.log(`setup check: ${messageOf(err)}`))
      timer = setInterval(() => now().catch(() => {}), EVERY_MS)
      timer.unref?.()
    },
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}
