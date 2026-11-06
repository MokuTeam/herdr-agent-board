// A queued message that went in (#330): it leaves the foot of the session's thread and shows as an
// ordinary message in its conversation. The bubble that takes its place settles from the queued
// look into its own once, so the change reads as one calm step rather than one bubble gone and
// another come. Pure apart from what it remembers for the page.

/** How long a message that left the queue may take to show in the conversation and still settle. */
export const SETTLE_WINDOW_MS = 10_000

const lastQueue = new Map<string, readonly string[]>()
const settling = new Map<string, number>()

/**
 * The session `key`'s queue as shown now: a text that was in it the last time and is not any more
 * went in (or was pulled back); its bubble may settle within SETTLE_WINDOW_MS.
 */
export function noteQueue(key: string, texts: readonly string[], now = Date.now()): void {
  const before = lastQueue.get(key)
  lastQueue.set(key, texts)
  for (const text of before ?? []) if (!texts.includes(text)) settling.set(text, now + SETTLE_WINDOW_MS)
}

/** Whether a user's message with `text`, newly shown, is one that just left the queue: once. */
export function takeSettling(text: string, now = Date.now()): boolean {
  const until = settling.get(text)
  if (until === undefined) return false
  settling.delete(text)
  return now <= until
}
