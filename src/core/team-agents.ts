// Agents of different boards talking through the team hub (#216), the pure rules: thread keys,
// the limits, the checks an agent's post goes through before it may leave without a person, and
// the words of the notices the board types into a session. A notice holds only words the board
// writes (and the sender's name from this board's own roster): a peer's text is read with
// `board team thread`, as a command's output, never typed into a prompt.
import { GENERAL, type ThreadRef } from './team-wire.ts'

/** The scope of the team's threads; a pair's threads have the peer's id as their scope. */
export const TEAM = 'team'

/** A thread's key on this board: `<peer-id>/<id>` in a pair, `team/<id>` in the team. */
export const threadKey = (scope: string, id: string): string => `${scope}/${id}`

export function splitKey(key: string): { scope: string; id: string } | null {
  const i = key.indexOf('/')
  if (i <= 0 || i === key.length - 1) return null
  return { scope: key.slice(0, i), id: key.slice(i + 1) }
}

/** The key a message files under, from who sent it and its thread (none: that pair's general). */
export function inboundKey(from: string, thread: ThreadRef | undefined): string {
  if (!thread) return threadKey(from, GENERAL)
  return threadKey(thread.group ? TEAM : from, thread.id)
}

export interface AgentLimits {
  /** Posts an hour one session may send without a person. */
  sessionHour: number
  /** Posts an hour and a day to one peer (the team counts as one), every session together. */
  peerHour: number
  peerDay: number
  /** The same text in the same thread again within this many minutes is refused. */
  echoMin: number
  /** This many agent messages in a row in a thread (both ways) pause this board's agents there. */
  loopRun: number
  /** More agent messages an hour than this from one peer pause routing for that peer for an hour. */
  inboundHour: number
  /** At most one notice per thread to a session this often, in minutes. */
  noticeGapMin: number
}

export const DEFAULT_LIMITS: AgentLimits = {
  sessionHour: 20,
  peerHour: 60,
  peerDay: 300,
  echoMin: 10,
  loopRun: 8,
  inboundHour: 60,
  noticeGapMin: 2,
}

/** config.json's `team.agentLimits` over the defaults: whole numbers of 1 or more only. */
export function agentLimits(raw: unknown): AgentLimits {
  const out = { ...DEFAULT_LIMITS }
  if (typeof raw !== 'object' || raw === null) return out
  for (const k of Object.keys(out) as (keyof AgentLimits)[]) {
    const v = (raw as Record<string, unknown>)[k]
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) out[k] = v
  }
  return out
}

const SECRETS: [string, RegExp][] = [
  ['an API key (sk-)', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['a GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['an AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]

/** What kind of secret the text seems to carry, or null. */
export function secretHit(text: string): string | null {
  for (const [what, re] of SECRETS) if (re.test(text)) return what
  return null
}

/** Lanes named with everyday words: naming them says nothing about anyone's work. */
const PLAIN_LANES = new Set(['personal', 'other'])

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The first of `lanes` (the ones not shared with the recipient) whose id or title the text names
 * as a whole word, ignoring case; null when none. Lanes with everyday names and names shorter
 * than 3 characters are not looked for.
 */
export function laneHit(text: string, lanes: { id: string; title: string }[]): string | null {
  for (const lane of lanes) {
    if (PLAIN_LANES.has(lane.id)) continue
    for (const word of new Set([lane.id, lane.title])) {
      if (word.trim().length < 3) continue
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(word.trim())}(?![\\p{L}\\p{N}_])`, 'iu')
      if (re.test(text)) return lane.id
    }
  }
  return null
}

/** Whether the last `run` messages of a thread (oldest first, `via` of each) all came from agents. */
export function loopRun(vias: (string | undefined)[], run: number): boolean {
  if (vias.length < run) return false
  return vias.slice(-run).every(v => v === 'agent')
}

/**
 * The text a peer gets whose board does not read threads (no `threads` cap): the thread's title in
 * front, so a person can tell the topics apart.
 */
export function legacyText(text: string, thread: { title?: string | null; group?: boolean } | undefined): string {
  if (!thread) return text
  if (thread.group) return thread.title ? `[team: ${thread.title}] ${text}` : `[team] ${text}`
  return thread.title ? `[${thread.title}] ${text}` : text
}

/** How a notice names a thread for `board team thread | reply | assign`. */
export function threadRef(scope: string, id: string, peerName: string): string {
  if (id !== GENERAL) return id.slice(0, 8)
  if (scope === TEAM) return TEAM
  return /\s/.test(peerName) ? `"${peerName}"` : peerName
}

export interface NoticeParts {
  /** The sender, as this board's roster calls them. */
  who: string
  /** An agent wrote it (the signed mark), not a person. */
  agent: boolean
  ref: string
  /** New messages since the last notice for this thread. */
  count: number
  team: boolean
  /** The thread is new to this board, or nobody here handles it: the listener decides. */
  route: boolean
}

/** The notice typed into a session: who, where, how many, and the commands; never the peer's text. */
export function noticeText(p: NoticeParts): string {
  const who = p.agent ? `${p.who}'s agent` : p.who
  const where = p.team ? `the team thread ${p.ref}` : `thread ${p.ref}`
  const many = p.count > 1 ? ` (${p.count} new messages)` : ''
  const read = `Read it: board team thread ${p.ref}`
  if (p.route)
    return `${who} wrote in ${where}${many}, which no session here handles. ${read}. Then answer (board team reply ${p.ref} "..."), hand it to a session (board team assign ${p.ref} <session>), or ask the owner.`
  return `${who} wrote in ${where}${many}, which you handle. ${read}; answer with board team reply ${p.ref} "...".`
}

/** The line the listener gets once when a peer's agents send too much: routing for it pauses. */
export const pausedText = (who: string, minutes: number): string =>
  `${who}'s board sent more agent messages in the last hour than the limit, so they are not routed to sessions for ${minutes} minutes. They are all in the Team panel.`

/** A thread as `board team` resolves a word against: its key, scope, id and the pair's peer name. */
export interface RefThread {
  key: string
  scope: string
  id: string
  peerName: string | null
}

/**
 * The thread a word names, for `board team thread | reply | assign | release`: `team` (the team's
 * general), a thread's key, a topic thread's id or its first 8 or more characters, or a peer's name
 * or id (that pair's general). An error says what fits more than once or nothing.
 */
export function resolveThreadRef(
  word: string,
  threads: RefThread[],
  roster: { peer: string; name: string }[],
): { ok: true; key: string } | { ok: false; error: string } {
  const w = word.trim()
  if (!w) return { ok: false, error: 'name a thread' }
  if (w.toLowerCase() === TEAM) return { ok: true, key: threadKey(TEAM, GENERAL) }
  if (threads.some(t => t.key === w)) return { ok: true, key: w }
  if (/^[0-9a-f-]{8,36}$/i.test(w)) {
    const hits = threads.filter(t => t.id !== GENERAL && t.id.startsWith(w.toLowerCase()))
    if (hits.length === 1 && hits[0]) return { ok: true, key: hits[0].key }
    if (hits.length > 1) return { ok: false, error: `${w} fits more than one thread: give more of its id` }
  }
  const byId = roster.filter(p => p.peer === w)
  const byName = roster.filter(p => p.name === w)
  const loose = roster.filter(p => p.name.toLowerCase() === w.toLowerCase())
  const hit = byId.length ? byId : byName.length ? byName : loose
  if (hit.length > 1)
    return { ok: false, error: `${w} fits more than one person: use the peer id from board team roster` }
  if (hit[0]) return { ok: true, key: threadKey(hit[0].peer, GENERAL) }
  return { ok: false, error: `no thread or person called ${w}` }
}

/** What `board team post | reply` says when the board held the post as a draft, by its reason. */
export function heldWhy(reason: string, who: string, detail?: string): string {
  switch (reason) {
    case 'off':
      return `the owner has not let agents write to ${who} on their own`
    case 'lane':
      return `this session's lane is not shared with ${who}`
    case 'secret':
      return `it looks like it carries ${detail ?? 'a secret'}`
    case 'lane_name':
      return `it names the lane ${detail ?? ''}, which is not shared with ${who}`
    case 'loop':
      return 'the last messages in this thread all came from agents: a person has to step in'
    default:
      return reason
  }
}

/** What `board team post | reply` says when the board refused the post, by its error code. */
export function refusedWhy(error: string): string {
  switch (error) {
    case 'rate_session':
      return 'this session sent as many posts as an hour allows: try again later'
    case 'rate_peer':
    case 'rate_day':
      return 'agents here sent as many posts to them as the limit allows: try again later'
    case 'echo':
      return 'the same text went to this thread a few minutes ago'
    case 'thread':
      return 'no such thread, or the title or link is not valid (a title of 1 to 80 characters, an http(s) link)'
    case 'text':
      return 'the text is empty or too long'
    case 'peer':
      return 'that person is not on the team any more'
    case 'changed':
      return 'their key changed: the owner has to trust it in the Team panel first'
    case 'nobody':
      return 'nobody else is on the team'
    case 'full':
      return 'too many drafts are waiting: the owner has to send or discard some first'
    case 'off':
      return 'the team is off'
    default:
      return error
  }
}
