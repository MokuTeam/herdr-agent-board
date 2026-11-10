// What the owner has not read of the team yet (#355), and how a new message is worded on the
// desktop. A thread is read up to a time (its mark); what came in after it is unread, and so is
// what came in after `since`, when the board started keeping marks, for a thread never opened:
// the messages from before this board counted are not all news at once. A muted thread counts
// nothing. The marks live in team-reads.json (adapters/team-reads.ts).
import { printable } from './team.ts'

export interface Reads {
  /** When the board started keeping read marks (ms). */
  since: number
  /** A thread's key, `<peer>/<thread id>` or `team/<thread id>`, to when it was last read (ms). */
  threads: Record<string, number>
}

/** A message that came in: its thread and when it was kept. */
export interface Incoming {
  thread: string
  at: number
}

/** A thread's key: a peer's id or `team`, a slash, `general` or a thread's UUID (#216). */
export const THREAD_KEY =
  /^(?:[A-Za-z0-9_-]{43}|team)\/(?:general|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** The unread messages of each thread that has any; a muted thread has none. */
export function unreadByThread(
  incoming: readonly Incoming[],
  reads: Reads,
  muted: (thread: string) => boolean,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of incoming) {
    if (muted(m.thread)) continue
    const mark = Math.max(reads.since, reads.threads[m.thread] ?? 0)
    if (m.at > mark) out[m.thread] = (out[m.thread] ?? 0) + 1
  }
  return out
}

/** All unread messages, the head's count. */
export const unreadCount = (incoming: readonly Incoming[], reads: Reads, muted: (thread: string) => boolean): number =>
  Object.values(unreadByThread(incoming, reads, muted)).reduce((a, b) => a + b, 0)

/** How long the start of a message on the desktop is, at most. */
export const TOAST_CHARS = 140

/**
 * A peer's text for a notification: one line, nothing that is not printable (as the CLI shows it),
 * cut at TOAST_CHARS with an ellipsis.
 */
export function toastBody(text: string): string {
  const line = printable(text.replace(/\s+/g, ' ').trim())
  return line.length > TOAST_CHARS ? `${line.slice(0, TOAST_CHARS).trimEnd()}…` : line
}
