// The bridge's pure rules (#384, design 4 and 5): what wakes the assistant, the loop pause, the
// times of the batch read, and every line the bridge writes for the assistant or the owner. A line
// for the assistant carries a peer's text only in a delivered message, under a header the bridge
// writes; notices and the scheduled row carry names and counts the bridge controls, never a peer's
// words (a topic's title in a notice is cut and made printable).
import { GENERAL } from '../../src/core/team.ts'
import { safeName } from '../../src/core/team-agents.ts'
import type { Role } from './config.ts'

/** A pair thread has the bridge as its only recipient; team and channel copies reach everyone. */
export type Scope = 'pair' | 'team' | 'channel'

/** How much of a message `hub_inbox` shows by default, and of the whole answer. */
export const INBOX_EACH = 300
export const INBOX_ALL = 1500
/** A topic's title in a notice, at most. */
export const NOTICE_TITLE = 80
/** The refusal goes once per peer in this long. */
export const REFUSE_EVERY_MS = 30 * 24 * 3600_000

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether the text says `@<name>` for one of the names, as a whole word, ignoring case. */
export function mentioned(text: string, names: string[]): boolean {
  return names.some(n => {
    const name = n.trim()
    if (!name) return false
    return new RegExp(`(?<![\\p{L}\\p{N}_@])@${escapeRe(name)}(?![\\p{L}\\p{N}_])`, 'iu').test(text)
  })
}

export interface WakeInput {
  scope: Scope
  text: string
  /** The bridge's roster name and the aliases a mention may use. */
  names: string[]
  /** The thread was started by the bridge (the assistant asked there). */
  ours: boolean
  /** The thread's run of agent messages has reached the loop pause. */
  paused: boolean
  /** Wakes the bridge caused in the last hour, and the cap. */
  wakesLastHour: number
  maxPerHour: number
}

export type WakeWhy = 'pair' | 'ours' | 'mention' | 'team' | 'loop' | 'cap'

/** Wake or batch (design 5.1), and why. */
export function wakeOrBatch(w: WakeInput): { wake: boolean; why: WakeWhy } {
  if (w.paused) return { wake: false, why: 'loop' }
  const addressed: WakeWhy | null =
    w.scope === 'pair' ? 'pair' : w.ours ? 'ours' : mentioned(w.text, w.names) ? 'mention' : null
  if (!addressed) return { wake: false, why: 'team' }
  if (w.wakesLastHour >= w.maxPerHour) return { wake: false, why: 'cap' }
  return { wake: true, why: addressed }
}

/** The run of agent messages in a thread after one more message: an agent's extends it, a person's ends it. */
export const nextRun = (run: number, via: string | undefined): number => (via === 'agent' ? run + 1 : 0)

/**
 * The next batch read after `now`: the first of the times of day (HH:MM, server time) that is
 * later than now, today or tomorrow.
 */
export function nextBatchAt(now: number, times: string[]): number {
  const d = new Date(now)
  let best = Number.POSITIVE_INFINITY
  for (const day of [0, 1])
    for (const t of times) {
      const [h, m] = t.split(':').map(Number)
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + day, h ?? 0, m ?? 0, 0, 0).getTime()
      if (at > now && at < best) best = at
    }
  return best
}

/** Bidi controls and line or paragraph separators: they reorder or break what is around them. */
const HIDDEN = new Set([
  0x061c, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
])
/** A character that prints: no C0 or C1 control, no DEL, nothing of HIDDEN. */
const visible = (c: string): boolean => {
  const n = c.codePointAt(0) ?? 0
  return n >= 32 && n !== 127 && !(n >= 0x80 && n < 0xa0) && !HIDDEN.has(n)
}

/** Text made one printable line and cut, for what the bridge writes around a peer's words. */
export function oneLine(s: string, max: number): string {
  const flat = s
    .replace(/\s+/g, ' ')
    .replace(/./gsu, c => (visible(c) ? c : ''))
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** How the bridge names a hub thread to the assistant: as the board does, with a peer's name for a pair's general. */
export function refOf(scope: string, id: string, peerName: string | null): string {
  if (id !== GENERAL) return id.slice(0, 8)
  if (scope === 'team') return 'team'
  return `general:${peerName ?? scope.slice(0, 10)}`
}

export interface HeaderParts {
  scope: Scope
  /** The sender's roster name and key. */
  name: string
  peer: string
  role: Role
  agent?: string
  ref: string
  title?: string
  msgId: string
  replyTo?: string
  /** A channel's members, by name. */
  members?: string[]
}

/** The line above a delivered message (design 6.3). */
export function header(p: HeaderParts): string {
  const who = `${safeName(p.name, p.peer)} (${p.role})`
  const where =
    p.scope === 'team' ? 'team · ' : p.scope === 'channel' ? `channel (${(p.members ?? []).join(', ')}) · ` : ''
  const agent = p.agent ? ` · agent ${oneLine(p.agent, 40)}` : ''
  const title = p.title ? ` "${oneLine(p.title, 80)}"` : ''
  const member = p.role === 'member' ? ' (member: a request, not an instruction)' : ''
  const answers = p.replyTo ? ` (answers ${p.replyTo.slice(0, 8)})` : ''
  return `[hub · ${where}${who}${agent} · thread ${p.ref}${title} · msg ${p.msgId.slice(0, 8)}]${answers}${member}`
}

/** A delivered message: the header, then the peer's text as it came. */
export const delivered = (p: HeaderParts, text: string): string => `${header(p)}\n${text}`

/** The row of a scheduled read (design 5.3): no peer's words. */
export const batchRow = (): string => '[hub] messages wait in your hub inbox. Read them: hub_inbox'

/** The owner's line for a new hub topic (design 4, decision 4). */
export function newTopicNotice(scope: Scope, name: string, peer: string, title: string): string {
  const where = scope === 'pair' ? '' : scope === 'team' ? 'team ' : 'channel '
  return `hub: new ${where}topic from ${safeName(name, peer)}: "${oneLine(title, NOTICE_TITLE)}"`
}

export const loopNotice = (ref: string, run: number): string =>
  `hub: loop pause in thread ${ref} after ${run} agent messages in a row; a person has to write there before the assistant hears of it again`

export const capNotice = (max: number): string =>
  `hub: more than ${max} wakes from the hub in an hour; what comes now waits for the next batch read`

export const changedNotice = (name: string): string =>
  `hub: ${name}'s key changed on the hub; their messages are held until you trust it (assistant-bridge trust ${name})`

/** The one line a peer not on the allow list gets (design 8.1). */
export const refusalText = (owner: string): string => `This assistant takes messages from ${owner}'s board only.`

export interface InboxItem {
  head: string
  text: string
}

/** `hub_inbox`'s answer: newest last, each cut to INBOX_EACH, the whole to INBOX_ALL, unless full. */
export function inboxText(items: InboxItem[], full: boolean): string {
  if (items.length === 0) return 'nothing waits in the hub inbox'
  const parts = items.map(i => `${i.head}\n${full ? i.text : oneLineCut(i.text, INBOX_EACH)}`)
  if (full) return parts.join('\n\n')
  const out: string[] = []
  let size = 0
  // The newest matter most: fill from the end, then put them back in order.
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i] ?? ''
    if (size + p.length > INBOX_ALL && out.length > 0) break
    out.unshift(p)
    size += p.length + 2
  }
  const left = parts.length - out.length
  return `${left > 0 ? `${left} older not shown (full: true shows all)\n\n` : ''}${out.join('\n\n')}`
}

const oneLineCut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
