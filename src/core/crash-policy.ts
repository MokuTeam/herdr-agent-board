// When the terminal board (and the web board it serves) starts again after a crash (run.ts).

// The pause before each start: the first crash comes back quickly, one that repeats less often.
export const CRASH_WAITS_MS = [2000, 10_000, 30_000] as const
// This many crashes within CRASH_WINDOW_MS and the board waits for a code change instead.
export const MAX_CRASHES = 5
export const CRASH_WINDOW_MS = 10 * 60_000

export type AfterCrash = {
  /** The recent crashes' times, this one too. */
  crashes: number[]
  /** Ms before the board starts again, or 0: it waits for a code change. */
  wait: number
}

/** A crash at `now`, after the ones in `crashes` (their times). */
export function afterCrash(crashes: readonly number[], now: number): AfterCrash {
  const recent = [...crashes.filter(at => now - at < CRASH_WINDOW_MS), now]
  if (recent.length >= MAX_CRASHES) return { crashes: recent, wait: 0 }
  return { crashes: recent, wait: CRASH_WAITS_MS[Math.min(recent.length, CRASH_WAITS_MS.length) - 1] ?? 0 }
}
