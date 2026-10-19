// When the terminal board (and the web board it serves) starts again after a crash (run.mjs).

// The pause before each start: the first crash comes back quickly, one that repeats less often.
export const CRASH_WAITS_MS = [2000, 10_000, 30_000]
// This many crashes within CRASH_WINDOW_MS and the board waits for a code change instead.
export const MAX_CRASHES = 5
export const CRASH_WINDOW_MS = 10 * 60_000

/**
 * A crash at `now`, after the ones in `crashes` (their times): { crashes (the recent ones, this
 * one too), wait (ms before the board starts again, or 0: it waits for a code change) }.
 */
export function afterCrash(crashes, now) {
  const recent = [...crashes.filter(at => now - at < CRASH_WINDOW_MS), now]
  if (recent.length >= MAX_CRASHES) return { crashes: recent, wait: 0 }
  return { crashes: recent, wait: CRASH_WAITS_MS[Math.min(recent.length, CRASH_WAITS_MS.length) - 1] }
}
