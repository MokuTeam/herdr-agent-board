// The Team panel's conversation as a messenger lays it out (#370): a separator for each day, one
// sender's messages a few minutes apart under one header, the "new messages" line where the
// unread start, a reply's quote, how far a message of this board's got, whose agent wrote one, and
// the times the list and the bubbles show. Pure: the clock, the time zone and the words come in.
import type { OutState } from '../../../src/core/team-wire.ts'
import type { Translator } from '../../../src/core/types.ts'
import { capital, dayLabel, daysFrom, timeOf } from '../../../src/core/when-format.ts'
import type { ThreadLine, ThreadView } from './team.ts'

/** Messages from one sender this close together share one header. */
export const GROUP_MS = 5 * 60_000

/** How much of a message a quote or the list shows: one line of it. */
export const LINE_CHARS = 120

export type ChatItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  /** `first`: it opens a group (its sender's name over it); `last`: it closes one. */
  | { kind: 'msg'; key: string; line: ThreadLine; first: boolean; last: boolean }

const msOf = (l: { ts: string }): number => Date.parse(l.ts)

/** A day in the board's time zone, as a key. */
const dayKey = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** Who a line is from, as far as a group goes: this board or a peer, and through which agent. */
const senderOf = (l: ThreadLine): string =>
  `${l.dir === 'in' ? `in:${l.from ?? l.who ?? ''}` : 'me'}|${l.via ?? ''}|${l.agent ?? ''}`

/**
 * Where the unread start: the first of the thread's last `n` incoming lines (the unread count
 * counts what came in after the thread was last read); -1 when nothing is unread.
 */
export function unreadStart(lines: readonly ThreadLine[], n: number): number {
  if (n <= 0) return -1
  let seen = 0
  let at = -1
  for (let i = lines.length - 1; i >= 0 && seen < n; i--) {
    if (lines[i]?.dir !== 'in') continue
    seen++
    at = i
  }
  return at
}

/** The first unread line's id, by the thread's unread count (unreadStart); null: nothing unread. */
export const firstUnread = (lines: readonly ThreadLine[], n: number): string | null =>
  lines[unreadStart(lines, n)]?.id ?? null

/**
 * A thread's messages (no drafts) as the conversation draws them: a day's separator before its
 * first message, the "new messages" line before the first unread (`unreadFrom`: its id, kept from
 * when the thread opened), and each message with whether it opens or closes its sender's group. A
 * day, the unread line, another sender or a gap of more than GROUP_MS starts a new group.
 */
export function chatItems(
  lines: readonly ThreadLine[],
  opts: { t: Translator; now: number; unreadFrom?: string | null },
): ChatItem[] {
  const out: ChatItem[] = []
  const start = opts.unreadFrom ? lines.findIndex(l => l.id === opts.unreadFrom) : -1
  let day = ''
  let prev: { line: ThreadLine; at: number } | null = null
  lines.forEach((l, i) => {
    const ms = msOf(l)
    let fresh = false
    const d = dayKey(ms)
    if (d !== day) {
      out.push({ kind: 'day', key: `day-${d}`, label: capital(dayLabel(ms, opts.t, opts.now), opts.t) })
      day = d
      fresh = true
    }
    if (i === start) {
      out.push({ kind: 'unread', key: 'unread' })
      fresh = true
    }
    const first =
      fresh || !prev || senderOf(prev.line) !== senderOf(l) || ms - msOf(prev.line) > GROUP_MS || ms < msOf(prev.line)
    if (!first && prev) {
      const was = out[prev.at]
      if (was?.kind === 'msg') was.last = false
    }
    out.push({ kind: 'msg', key: `${l.dir}-${l.id}`, line: l, first, last: true })
    prev = { line: l, at: out.length - 1 }
  })
  return out
}

/** A message's time on its bubble: "14:05". */
export const bubbleTime = (ts: string, t: Translator): string => timeOf(msOf({ ts }), t)

/** A message's full date and time, for hover and the long press: "Wednesday, 11 November 2026, 14:05". */
export function fullWhen(ts: string, t: Translator): string {
  const ms = msOf({ ts })
  const day = new Date(ms).toLocaleDateString(t.lang, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  return `${capital(day, t)}, ${timeOf(ms, t)}`
}

/** A thread's latest time in the list: "14:05" today, "Yesterday", "Mon" this week, else "9 Nov" (and the year when not this one). */
export function listWhen(ts: string, t: Translator, now: number): string {
  const ms = msOf({ ts })
  const days = daysFrom(ms, now)
  if (days >= 0 && days <= 1) return timeOf(ms, t)
  if (days === -1) return capital(t('when.yesterday'), t)
  const d = new Date(ms)
  if (days < 0 && days > -7) return d.toLocaleDateString(t.lang, { weekday: 'short' })
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(t.lang, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** One line of a text: its whitespace folded, cut at `max` characters with an ellipsis. */
export function oneLine(text: string, max = LINE_CHARS): string {
  // By code point: an emoji is never cut in half.
  const line = [...text.replace(/\s+/g, ' ').trim()]
  return line.length > max ? `${line.slice(0, max).join('').trimEnd()}…` : line.join('')
}

/** Who wrote a line, by this board's name for them: "You" for this board's own. */
export const senderName = (l: Pick<ThreadLine, 'dir' | 'who'>, t: Translator): string =>
  l.dir === 'in' ? (l.who ?? t('team.in')) : t('team.you')

/** A reply's quote: the line answered, when this board has it, its sender and a line of its text. */
export interface Quote {
  /** The answered line's id: where a click on the quote goes. */
  id: string
  /** false: this board does not have it (an older message, or a member's copy it never got). */
  found: boolean
  who: string
  /** null: held back from a key that changed, or not found. */
  text: string | null
}

/** The quote of the line `id` names in `lines`; a quote that is not found says so. */
export function quoteOf(id: string, lines: readonly ThreadLine[], t: Translator): Quote {
  const o = lines.find(x => x.id === id && x.dir !== 'draft')
  if (!o) return { id, found: false, who: '', text: null }
  return { id, found: true, who: senderName(o, t), text: o.text === null ? null : oneLine(o.text) }
}

const RANK: Record<OutState, number> = { refused: 0, expired: 1, queued: 2, delivered: 3, acked: 4 }

/**
 * How far a message of this board's got, as its quiet mark shows it: a pair's state, a team
 * post's slowest copy (one refused or expired copy shows as that). null: not this board's.
 */
export function deliveryOf(l: ThreadLine): OutState | null {
  if (l.dir !== 'out') return null
  const states = l.receipts?.length ? l.receipts.map(r => r.state) : l.state ? [l.state] : []
  return states.reduce<OutState | null>((low, s) => (low === null || RANK[s] < RANK[low] ? s : low), null)
}

/**
 * The agent's mark on a message an agent wrote (#370): the session's name as its board gave it,
 * and whose board it is on (the sender's by this board's name for them, or this board). null for
 * a person's message.
 */
export function agentMark(l: ThreadLine, t: Translator): { session: string; board: string } | null {
  if (l.via !== 'agent' || l.dir === 'draft') return null
  return {
    session: l.agent ?? t('team.agentNoName'),
    board: l.dir === 'in' ? t('team.agentBoard', { name: l.who ?? '' }) : t('team.agentBoardMine'),
  }
}

/** One of four tones for a person, the same for them every time: their initial's ring, their name in a group. */
export function toneOf(peer: string): number {
  let h = 0
  for (const c of peer) h = (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0
  return h % 4
}

/** A person's initial for their mark in the list. */
export const initialOf = (name: string): string => ([...name.trim()][0] ?? '?').toLocaleUpperCase()

/** A thread's latest message in the list: "You: …", "anna: …" in a team thread, the text alone with one person. */
export function lastLine(thread: ThreadView, t: Translator): string {
  const last = thread.last
  if (!last) return t('team.threadEmpty')
  const text = last.text === null ? t('team.heldText') : oneLine(last.text)
  if (last.dir === 'out') return `${t('team.you')}: ${text}`
  return thread.scope === 'team' ? `${last.who ?? t('team.in')}: ${text}` : text
}
