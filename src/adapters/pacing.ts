// The board's own pacing: a poll interval while it waits for an agent to come up, the moment a
// terminal UI takes to draw before its screen is read, the gap before a retry. Real agents need
// these; the tests' fake herdr answers at once, and a test that sits each of them out takes
// seconds where it needs milliseconds (#358). Every variable here is for tests only and unset in
// production, where each wait is as written.

/**
 * BOARD_TEST_PACE: a factor above 0 and at most 1 that every pause(), and every delay of the same
 * kind given to a timer, is multiplied by. Anything else, or none, is 1: the waits as written.
 */
export function pace(): number {
  const f = Number(process.env.BOARD_TEST_PACE)
  return f > 0 && f <= 1 ? f : 1
}

/**
 * Wait `ms` (times the test pace). For pacing only: a deadline the user is promised ("within
 * 30 s") is measured with Date.now() and never paced.
 */
export function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms * pace()))
}

/**
 * A wait a test sits out on purpose (a lock that stays held, a wake that stays slow), from the
 * variable `name` when it is a whole number of ms above 0, else `fallback`.
 */
export function knobMs(name: string, fallback: number): number {
  const ms = Number(process.env[name])
  return Number.isInteger(ms) && ms > 0 ? ms : fallback
}
