// Messages the board sent that the session's thread does not show yet. Each one shows at once
// as a bubble of its own at the foot of the thread, and goes as soon as the transcript has it:
// in Claude Code's queue (the server's `queued`) or as a user line (upstream's web/outbox.js).
import type { QueuedPrompt } from '../../../src/core/queue.ts'

/**
 * A message's words, to find what the board sent in what the transcript shows. On its way
 * Claude Code wraps pasted text in <pasted_content id="…"> tags, turns an image's path into
 * "[Image #1]", drops blank lines and can change a path (a pasted "\a" or "\t" is read as a
 * control character); a long message comes clipped. So: no tags, no image marks, no paths, one
 * space between words.
 */
export function messageKey(text: unknown): string {
  return String(text ?? '')
    .replace(/<\/?pasted_content\b[^>]*>/g, ' ')
    .replace(/\[(?:Image|Pasted text) #\d+[^\]]*\]/g, ' ')
    .replace(/\S*[\\/]\S*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether a message the transcript shows holds what the board sent (its key): the same words,
 * or more of them, since two messages typed in a row can reach Claude as one. A clipped one
 * ("…") is matched by its start.
 */
export function holds(shown: unknown, key: string): boolean {
  if (!key) return false
  const words = messageKey(shown)
  if (` ${words} `.includes(` ${key} `)) return true
  const head = words.replace(/…$/, '').trim()
  return words.endsWith('…') && head.length >= 200 && key.startsWith(head)
}

/**
 * The words the board's message goes by: what was written, or with only files, the line that
 * names them (the text the server types is the message, then "Files:" and their paths).
 */
export const sentKey = (text: string, filesLabel: string): string => messageKey(text) || messageKey(filesLabel)

/** sending: on its way; sent: the session has it, its thread not yet; failed: not sent. */
export type OutState = 'sending' | 'sent' | 'failed'

/** What `unsettled` reads of a message: its state, its words and when it was sent. */
export interface Settling {
  state: OutState
  /** sentKey: the words it goes by. */
  key: string
  /** The newest moment the thread knew of when it was sent: what shows it must come after. */
  after: number
  /** When the session took it (0 until then). */
  sentAt: number
}

/** What the thread shows: its turns and the session's queue (the session's detail). */
export interface ShownThread {
  conversation?: readonly { role: string; text?: unknown; at: number }[] | undefined
  queued?: readonly QueuedPrompt[] | undefined
}

/** A message sent but never seen in the transcript goes after this long. */
export const KEEP_SENT_MS = 30_000

/**
 * The board's messages still to show: a failed one until the user retries or takes it back,
 * any other until the transcript shows it after `after` (the newest moment the thread knew of
 * when it was sent), or, once sent, for `keepMs` at most.
 */
export function unsettled<E extends Settling>(
  entries: readonly E[],
  { conversation = [], queued = [] }: ShownThread = {},
  now = Date.now(),
  keepMs = KEEP_SENT_MS,
): E[] {
  const shown = [...conversation.filter(m => m.role === 'user'), ...queued]
  return entries.filter(e => {
    if (e.state === 'failed') return true
    if (e.state === 'sent' && now - e.sentAt > keepMs) return false
    return !shown.some(m => m.at > e.after && holds(m.text, e.key))
  })
}

/** The newest moment a thread knows of: what a message sent now must come after. */
export const newestAt = (detail: ShownThread | null | undefined): number =>
  Math.max(0, ...[...(detail?.conversation ?? []), ...(detail?.queued ?? [])].map(m => m.at || 0))
