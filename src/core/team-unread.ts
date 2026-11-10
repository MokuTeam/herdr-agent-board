// What the owner has not read of the team yet (#355), and how a new message is worded on the
// desktop. A thread is read up to a time (its mark); what came in after it is unread, and so is
// what came in after `since`, when the board started keeping marks, for a thread never opened:
// the messages from before this board counted are not all news at once. A muted thread counts
// nothing. The marks live in team-reads.json (adapters/team-reads.ts).
import { isPeerId, isThreadId, printable } from './team.ts'
import { splitKey, TEAM } from './team-agents.ts'

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

/** A thread's key as #216 makes it: a peer's id or `team`, a slash, `general` or a thread's UUID. */
export function isThreadKey(key: unknown): key is string {
  if (typeof key !== 'string') return false
  const parts = splitKey(key)
  return !!parts && (parts.scope === TEAM || isPeerId(parts.scope)) && isThreadId(parts.id)
}

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

/** How long the start of a message on the desktop is, at most. */
export const TOAST_CHARS = 140

/**
 * A peer's text for a notification: one line, nothing that is not printable (as the CLI shows it),
 * cut at `max` characters (TOAST_CHARS) with an ellipsis.
 */
export function toastBody(text: string, max = TOAST_CHARS): string {
  const line = printable(text.replace(/\s+/g, ' ').trim())
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line
}
