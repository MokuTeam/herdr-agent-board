// The rules that sort a session into a column and write the line a card shows. Pure: the board's
// data (src/services/board.ts) feeds them herdr's status, the session's card and what Claude recorded.
import { t } from './lang.ts'
import { pendingOf, requestsOf } from './secrets.ts'
import type { AgentStatus, Attention, Card, ColumnId, Item, Pin, TranscriptInfo } from './types.ts'

// Titles read in the board's language at the moment they are used.
const column = (id: ColumnId, icon: string, color: string) => ({
  id,
  icon,
  color,
  get title(): string {
    return t(`col.${id}`)
  },
})
export const COLUMNS: readonly { id: ColumnId; icon: string; color: string; readonly title: string }[] = [
  column('work', '▶', 'green'),
  column('me', '!', 'red'),
  column('ext', '◷', 'yellow'),
  column('done', '✓', 'cyan'),
  column('idle', '·', 'gray'),
]

/** herdr's agent status in words: "working", "asleep". */
export function statusText(status: string): string {
  const key = `status.${status}`
  const text = t(key)
  return text === key ? status : text
}

/** Columns the user can drag a card to. "Working" is herdr's to say. */
export const PINS: ReadonlySet<Pin> = new Set<Pin>(['me', 'ext', 'done', 'idle'])
const isPin = (v: unknown): v is Pin => PINS.has(v as Pin)

/** A secret request of the session's (#273) waits for the user now; a card without any asks nothing more. */
const secretWaits = (card?: Card | null): boolean =>
  Array.isArray(card?.secrets) && pendingOf(requestsOf(card.secrets), Date.now()).length > 0

/** A turn is on: the session works, or a dialog in it waits in the middle of the work. */
export const busy = (status: AgentStatus | string): boolean => status === 'working' || status === 'blocked'

/**
 * Why a session needs the user, or '':
 *   decision  a dialog in the terminal holds it (permission, a question form): herdr says blocked
 *   ask       the agent said so with `board ask` (cleared when the user replies), or it waits on a
 *             secret request only the user can fill (#273), even in the middle of its turn
 *   question  it ended its turn with a question nobody answered yet (unless the user waved that
 *             exact question off on the board: card.dismissed)
 *   later     the user dragged it to "Needs me" to look at it later (card.pin)
 * A card the user dragged elsewhere (card.pin) shows no question until the pin goes.
 */
export function attentionOf(status: AgentStatus | string, card?: Card | null, info?: TranscriptInfo | null): Attention {
  const secret = secretWaits(card)
  if (status === 'working' && !secret) return ''
  if (status === 'blocked') return 'decision'
  const own: Attention =
    card?.ask || secret
      ? 'ask'
      : !card?.wait && info?.question && !info.replied && card?.dismissed !== info.question
        ? 'question'
        : ''
  if (isPin(card?.pin)) return card.pin === 'me' ? own || 'later' : ''
  return own
}

export function columnOf(status: AgentStatus | string, card?: Card | null, info?: TranscriptInfo | null): ColumnId {
  if (status === 'working' && !secretWaits(card)) return 'work'
  if (attentionOf(status, card, info)) return 'me'
  if (status === 'working') return 'work'
  if (isPin(card?.pin)) return card.pin
  if (card?.wait) return 'ext'
  if (status === 'done') return 'done'
  return 'idle'
}

/** The one line a card shows under the name. */
export function noteOf(item: Item): string {
  if (item.column === 'ext') return item.wait || t('note.parked')
  // Claude's own title of the session beats the last prompt, which is often just "ok" or "go on".
  const title = item.title && item.title !== item.name ? item.title : ''
  const auto = title || item.prompt || ''
  if (item.attention === 'later') return t('note.parkedWith', { what: item.doing || auto || t('note.look') })
  if (item.column === 'me') return item.question || item.doing || auto || t('note.decision')
  if (item.column === 'done' || item.column === 'idle') return item.result || item.doing || auto
  return item.doing || auto
}

const AGENT_STATUSES: ReadonlySet<unknown> = new Set<AgentStatus>([
  'idle',
  'working',
  'blocked',
  'done',
  'unknown',
  'sleeping',
])
export const isAgentStatus = (v: unknown): v is AgentStatus => AGENT_STATUSES.has(v)
