// The peer network (#231) on the page: what GET /api/team and GET /api/team/thread/<peer> answer
// (src/server/routes/team.ts, the shapes are services/team-hub.ts's), and the lines the panel
// draws from them. The panel exists only on the local board's page, while the payload carries
// `teamRev` (config.json's `team` is on).
import { OUT_STATES, type OutState, VIAS } from '../../../src/core/team-wire.ts'
import type { Translator } from '../../../src/core/types.ts'
import type { TeamRosterPeer, TeamState, TeamView, ThreadMessage } from '../../../src/services/team-hub.ts'
import { ago } from './card.ts'
import { remotePage, teamPage } from './remote-page.ts'

export type { TeamRosterPeer, TeamView, ThreadMessage }

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

const isThreadMessage = (v: unknown): v is ThreadMessage =>
  isObj(v) &&
  typeof v.id === 'string' &&
  (v.dir === 'in' || v.dir === 'out' || v.dir === 'draft') &&
  (typeof v.text === 'string' || (v.text === null && v.held === true)) &&
  typeof v.ts === 'string' &&
  (v.state === undefined || isDelivery(v.state)) &&
  (v.code === undefined || typeof v.code === 'string') &&
  (v.held === undefined || typeof v.held === 'boolean') &&
  (v.via === undefined || VIAS.some(x => x === v.via)) &&
  (v.agentOf === undefined || typeof v.agentOf === 'string')

/** GET /api/team/thread/<peer>. */
export const isThread = (v: unknown): v is { peer: string; messages: ThreadMessage[] } =>
  isObj(v) && typeof v.peer === 'string' && Array.isArray(v.messages) && v.messages.every(isThreadMessage)

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

/** A pair's thread without a topic, the one today's panel shows (#216 adds topics). */
export const pairThread = (peer: string): string => `${peer}/general`

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

/** The label on a message that came from an agent's draft: whose agent. The name is the roster's, never the message's. */
export const agentLine = (m: ThreadMessage, t: Translator): string | null =>
  m.via !== 'agent' || m.dir === 'draft'
    ? null
    : m.dir === 'in'
      ? t('team.agentRequest', { name: m.agentOf ?? '' })
      : t('team.agentRequestOut')

/** What a refused send says (the route's error code). */
export const sendError = (code: unknown, t: Translator): string =>
  t('team.sendFailed', {
    why:
      code === 'peer' || code === 'text' || code === 'too_big' || code === 'changed' || code === 'draft'
        ? t(`team.err.${code}`)
        : String(code ?? ''),
  })
