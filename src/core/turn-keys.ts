// Stop and Send now (#330): the keys that stop a session's running turn, and the keys that send a
// message waiting in its queue into that turn at once, by herdr's name for the program in the pane.
// Only where they are known: Claude Code's were checked on 2.1.319 (Esc interrupts; ctrl+enter is
// its chat:sendNow, which takes every message waiting in the queue into the running turn). pi,
// Codex and the others get neither until theirs are known, and so no button. Pure: the keys are
// pressed by services/turn.ts.
import type { Item } from './types.ts'

export type TurnAction = 'stop' | 'sendNow'

const KEYS: Readonly<Record<string, Readonly<Record<TurnAction, readonly string[]>>>> = {
  claude: { stop: ['esc'], sendNow: ['ctrl+enter'] },
}

type TurnItem = Pick<Item, 'agent' | 'pane' | 'session' | 'sleeping'>

/**
 * The keys that do `action` in `item`'s pane, or null where the board cannot press them: a program
 * whose keys are not known, no pane (a MokuPilot call agent or day session, #326, #331), no session
 * id to check the pane still holds it, or asleep (no turn runs).
 */
export function turnKeys(item: TurnItem | null | undefined, action: TurnAction): readonly string[] | null {
  if (!item?.pane || !item.session || item.sleeping) return null
  const agent = item.agent ?? ''
  return Object.hasOwn(KEYS, agent) ? (KEYS[agent]?.[action] ?? null) : null
}

/** Whether the board offers Stop on `item`: its turn runs and its program's interrupt key is known. */
export const canStop = (item: (TurnItem & Pick<Item, 'status'>) | null | undefined): boolean =>
  item?.status === 'working' && turnKeys(item, 'stop') !== null

/** Whether the board offers Send now on `item`'s queued messages: as canStop, with the send-now key. */
export const canSendNow = (item: (TurnItem & Pick<Item, 'status'>) | null | undefined): boolean =>
  item?.status === 'working' && turnKeys(item, 'sendNow') !== null

// Claude Code's mark of an interrupted turn: a user line "[Request interrupted by user]", or
// "[Request interrupted by user for tool use]" when a tool was running.
const INTERRUPTED = /^\[Request interrupted by user\b/

/**
 * Whether the transcript says a turn was interrupted at `since` (ms) or later: the line Claude
 * Code writes once Esc took. herdr's status alone cannot say it: a message waiting in the queue
 * starts the next turn at once, and the session stays working.
 */
export function interruptedSince(transcript: unknown, since: number): boolean {
  for (const line of String(transcript ?? '').split('\n')) {
    if (!line.includes('[Request interrupted by user')) continue
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!o || typeof o !== 'object') continue
    const rec = o as Record<string, unknown>
    if (rec.type !== 'user' || rec.isSidechain) continue
    const at = Date.parse(String(rec.timestamp ?? ''))
    if (!(at >= since)) continue
    const content = (rec.message as Record<string, unknown> | undefined)?.content
    const texts =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? content.map(b => (b && typeof b === 'object' ? (b as Record<string, unknown>).text : null))
          : []
    if (texts.some(s => typeof s === 'string' && INTERRUPTED.test(s))) return true
  }
  return false
}
