// The peer network (#231) on the page: what GET /api/team, GET /api/team/threads and one thread's
// GET /api/team/threads/<scope>/<id> answer (#216; src/server/routes/team.ts, the shapes are
// services/team-hub.ts's), the owner's agent switches (GET /api/team/agents), and the lines the
// panel draws from them. The panel exists only on the local board's page and the owner's own phone
// or login (#355), while the payload carries `teamRev` (config.json's `team` is on).
import { OUT_STATES, type OutState, VIAS } from '../../../src/core/team-wire.ts'
import type { Translator } from '../../../src/core/types.ts'
import type { TeamRosterPeer, TeamState, TeamView, ThreadLine, ThreadView } from '../../../src/services/team-hub.ts'
import { ago } from './card.ts'
import { remotePage, teamPage } from './remote-page.ts'

export type { TeamRosterPeer, TeamView, ThreadLine, ThreadView }

const STATES: readonly TeamState[] = ['off', 'connecting', 'online', 'reconnecting', 'revoked', 'error']

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isRosterPeer = (v: unknown): v is TeamRosterPeer =>
  isObj(v) &&
  typeof v.peer === 'string' &&
  typeof v.name === 'string' &&
  typeof v.online === 'boolean' &&
  (v.lastSeen === null || typeof v.lastSeen === 'number') &&
  typeof v.fingerprint === 'string' &&
  typeof v.drafts === 'number' &&
  (v.pin === 'trusted' || v.pin === 'changed')

export const isTeamView = (v: unknown): v is TeamView =>
  isObj(v) &&
  typeof v.state === 'string' &&
  STATES.some(s => s === v.state) &&
  (v.error === undefined || typeof v.error === 'string') &&
  (v.nextAt === undefined || typeof v.nextAt === 'number') &&
  isObj(v.me) &&
  (v.me.peer === null || typeof v.me.peer === 'string') &&
  typeof v.me.fingerprint === 'string' &&
  (v.me.name === null || typeof v.me.name === 'string') &&
  typeof v.hub === 'string' &&
  Array.isArray(v.roster) &&
  v.roster.every(isRosterPeer)

const isDelivery = (v: unknown): v is OutState => OUT_STATES.some(s => s === v)

/**
 * Whether the page offers the Team panel, its Settings entry and the head's Team button: while the
 * payload carries `teamRev`, on the local board, or on the owner's own phone or domain login (#355,
 * hello's `team`). Anywhere else nothing of it is drawn and /api/team is never asked.
 */
export const offersTeam = (
  payload?: { teamRev?: number | undefined } | null,
  remote: boolean = remotePage(),
  team: boolean = teamPage(),
): boolean => (!remote || team) && payload?.teamRev !== undefined

/** A pair's thread without a topic. */
export const pairThread = (peer: string): string => `${peer}/general`

/** The team chat's thread without a topic, the first in the list. */
export const TEAM_CHAT = 'team/general'

/** A thread key's scope (a peer's id or `team`) and id (`general` or a UUID). */
export function keyParts(key: string): { scope: string; id: string } | null {
  const i = key.indexOf('/')
  return i > 0 && i < key.length - 1 ? { scope: key.slice(0, i), id: key.slice(i + 1) } : null
}

const isSession = (v: unknown): v is { key: string; name?: string } =>
  isObj(v) && typeof v.key === 'string' && (v.name === undefined || typeof v.name === 'string')

const isThreadView = (v: unknown): v is ThreadView =>
  isObj(v) &&
  typeof v.key === 'string' &&
  typeof v.scope === 'string' &&
  typeof v.id === 'string' &&
  (v.title === null || typeof v.title === 'string') &&
  (v.link === null || typeof v.link === 'string') &&
  (v.handler === null || isSession(v.handler)) &&
  typeof v.muted === 'boolean' &&
  typeof v.lastAt === 'number' &&
  (v.peerName === null || typeof v.peerName === 'string') &&
  (v.members === undefined || (Array.isArray(v.members) && v.members.every(m => typeof m === 'string')))

/** GET /api/team/threads. */
export const isThreadList = (v: unknown): v is { threads: ThreadView[] } =>
  isObj(v) && Array.isArray(v.threads) && v.threads.every(isThreadView)

const isReceipt = (v: unknown): boolean =>
  isObj(v) && typeof v.peer === 'string' && typeof v.name === 'string' && isDelivery(v.state)

const isThreadLine = (v: unknown): v is ThreadLine =>
  isObj(v) &&
  typeof v.id === 'string' &&
  (v.dir === 'in' || v.dir === 'out' || v.dir === 'draft') &&
  (typeof v.text === 'string' || (v.text === null && v.held === true)) &&
  typeof v.ts === 'string' &&
  (v.from === undefined || typeof v.from === 'string') &&
  (v.who === undefined || typeof v.who === 'string') &&
  (v.state === undefined || isDelivery(v.state)) &&
  (v.code === undefined || typeof v.code === 'string') &&
  (v.receipts === undefined || (Array.isArray(v.receipts) && v.receipts.every(isReceipt))) &&
  (v.held === undefined || typeof v.held === 'boolean') &&
  (v.pressed === undefined || typeof v.pressed === 'boolean') &&
  (v.via === undefined || VIAS.some(x => x === v.via)) &&
  (v.agent === undefined || typeof v.agent === 'string') &&
  (v.reason === undefined || typeof v.reason === 'string')

/** GET /api/team/threads/<scope>/<id>. */
export const isThreadLines = (v: unknown): v is { thread: ThreadView; lines: ThreadLine[] } =>
  isObj(v) && isThreadView(v.thread) && Array.isArray(v.lines) && v.lines.every(isThreadLine)

/**
 * The owner's agent switches (#216, GET /api/team/agents), as the panel shows them: by a peer's id,
 * `team`, or a channel's key (#355). `loop` (#360): a pause after that many agent messages in a row,
 * the board's `loopDefault` when none is set.
 */
export interface AgentsView {
  off: boolean
  listener: { key: string; name?: string } | null
  peers: Record<string, { on: boolean; lanes: string[]; muted?: boolean; loop?: number }>
  paused: Record<string, number>
  lanes: { id: string; title: string }[]
  loopDefault?: number
}

const isPeerAgents = (v: unknown): boolean =>
  isObj(v) &&
  typeof v.on === 'boolean' &&
  Array.isArray(v.lanes) &&
  v.lanes.every(l => typeof l === 'string') &&
  (v.muted === undefined || typeof v.muted === 'boolean') &&
  (v.loop === undefined || typeof v.loop === 'number')

export const isAgentsView = (v: unknown): v is AgentsView =>
  isObj(v) &&
  typeof v.off === 'boolean' &&
  (v.listener === null || isSession(v.listener)) &&
  isObj(v.peers) &&
  Object.values(v.peers).every(isPeerAgents) &&
  isObj(v.paused) &&
  Object.values(v.paused).every(n => typeof n === 'number') &&
  Array.isArray(v.lanes) &&
  v.lanes.every(l => isObj(l) && typeof l.id === 'string' && typeof l.title === 'string') &&
  (v.loopDefault === undefined || typeof v.loopDefault === 'number')

/** One change of the switches, as POST /api/team/agents takes it. */
export type AgentsChange =
  | { off: boolean }
  | { listener: null }
  | { peer: string; on?: boolean; lanes?: string[]; muted?: boolean; loop?: number | null }

/** A new member's welcome, as POST /api/team/welcome takes it (#355). */
export interface Welcome {
  peer: string
  on: boolean
  lanes: string[]
  channels: string[]
}

/** GET /api/team/welcome: who joined and is not welcomed yet. */
export const isWelcomeList = (v: unknown): v is { pending: string[] } =>
  isObj(v) && Array.isArray(v.pending) && v.pending.every(p => typeof p === 'string')

/** A channel (#355): a team thread for some members only. */
export const isChannel = (t: ThreadView | null | undefined): boolean => !!t?.members

/** The channels, the latest first. */
export const channelsOf = (threads: readonly ThreadView[]): ThreadView[] =>
  threads.filter(t => t.scope === 'team' && t.members).sort((a, b) => b.lastAt - a.lastAt)

/**
 * A scope's threads as the list shows them: its general first (there before anything was written
 * in it, as null), then its topics, the latest first.
 */
export function scopeThreads(
  scope: string,
  threads: readonly ThreadView[],
): { key: string; thread: ThreadView | null }[] {
  const general = `${scope}/general`
  // A channel is the team's but listed on its own (#355).
  const topics = threads
    .filter(t => t.scope === scope && t.key !== general && !t.members)
    .sort((a, b) => b.lastAt - a.lastAt)
  return [
    { key: general, thread: threads.find(t => t.key === general) ?? null },
    ...topics.map(t => ({ key: t.key, thread: t })),
  ]
}

/** A thread's link, only when it is http(s): a peer's word is never a script to run. */
export function safeLink(link: string | null | undefined): string | null {
  if (!link) return null
  try {
    const u = new URL(link)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

/** The peer a thread's key is with; null for the team's own threads. */
export const peerOfThread = (thread: string): string | null => {
  const scope = thread.split('/')[0] ?? ''
  return scope && scope !== 'team' ? scope : null
}

/** GET /api/team/unread: the head's count and each thread's. */
export const isUnread = (v: unknown): v is { unread: number; threads: Record<string, number> } =>
  isObj(v) &&
  typeof v.unread === 'number' &&
  isObj(v.threads) &&
  Object.values(v.threads).every(n => typeof n === 'number')

/** A thread a team notification's click asked for (#355: the stream's `team-open`); `n` tells two asks apart. */
export interface TeamOpen {
  thread: string
  n: number
}

/** Listens for the stream's `team-open` event: its thread becomes the one to show. */
export function listenForTeamOpens(
  stream: { addEventListener(type: 'team-open', listener: (event: MessageEvent) => void): void },
  set: (next: (prev: TeamOpen | null) => TeamOpen) => void,
): void {
  stream.addEventListener('team-open', event => {
    try {
      const v: unknown = JSON.parse(String(event.data))
      if (isObj(v) && typeof v.thread === 'string') {
        const thread = v.thread
        set(prev => ({ thread, n: (prev?.n ?? 0) + 1 }))
      }
    } catch {}
  })
}

/** The connection line: where it stands, and for reconnecting when the next try is. */
export function stateLine(view: TeamView, t: Translator): string {
  const line = t(`team.state.${view.state}`, { hub: view.hub })
  if (view.state === 'error' && view.error === 'unknown_peer') return t('team.state.unknownPeer', { hub: view.hub })
  if (view.state === 'error' && view.error) return `${line}: ${view.error}`
  if (view.state === 'reconnecting' && view.nextAt)
    return `${line} (${t('team.nextAt', { time: new Date(view.nextAt).toLocaleTimeString() })})`
  return line
}

/** When a person was last in the network. */
export const seenLine = (p: TeamRosterPeer, now: number, t: Translator): string =>
  p.online ? t('team.online') : p.lastSeen ? t('team.lastSeen', { when: ago(p.lastSeen, now, t) }) : t('team.neverSeen')

/** How far a message got; refused with the hub's code when there is one. */
const delivery = (state: OutState, code: string | undefined, t: Translator): string =>
  state === 'refused' && !code ? t('team.delivery.refusedPlain') : t(`team.delivery.${state}`, { code: code ?? '' })

const WHY = ['off', 'lane', 'secret', 'lane_name', 'loop']

/**
 * A line's small print: who wrote it (this board's name for them, never the message's), how far
 * it got (each member's copy for a team post), whose agent, held, and why a draft waits.
 */
export function lineMeta(l: ThreadLine, t: Translator): string {
  const out: string[] = []
  if (l.dir === 'draft') out.push(t('team.draftFromAgent'))
  else if (l.dir === 'in') out.push(l.who ?? t('team.in'))
  else out.push(t('team.out'))
  if (l.dir === 'out' && l.state) out.push(delivery(l.state, l.code, t))
  if (l.dir === 'out' && l.receipts?.length)
    out.push(l.receipts.map(r => `${r.name}: ${delivery(r.state, undefined, t)}`).join(', '))
  if (l.held) out.push(t('team.held'))
  if (l.via === 'agent' && l.dir === 'in') out.push(t('team.agentRequest', { name: l.who ?? '' }))
  if (l.via === 'agent' && l.dir === 'out') out.push(l.pressed ? t('team.pressed') : t('team.agentRequestOut'))
  if (l.dir === 'draft' && l.reason) out.push(WHY.includes(l.reason) ? t(`team.why.${l.reason}`) : l.reason)
  return out.join(' · ')
}

/** What a refused send says (the route's error code). */
export const sendError = (code: unknown, t: Translator): string =>
  t('team.sendFailed', {
    why:
      code === 'peer' ||
      code === 'text' ||
      code === 'too_big' ||
      code === 'changed' ||
      code === 'draft' ||
      code === 'passkey' ||
      code === 'blocked' ||
      code === 'cancelled' ||
      code === 'loopback'
        ? t(`team.err.${code}`)
        : String(code ?? ''),
  })
