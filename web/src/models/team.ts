// The peer network (#231) on the page: what GET /api/team and GET /api/team/thread/<peer> answer
// (src/server/routes/team.ts, the shapes are services/team-hub.ts's), and the lines the panel
// draws from them. The panel exists only on the local board's page, while the payload carries
// `teamRev` (config.json's `team` is on).
import { OUT_STATES, type OutState } from '../../../src/core/team-wire.ts'
import type { Translator } from '../../../src/core/types.ts'
import type { TeamRosterPeer, TeamState, TeamView, ThreadMessage } from '../../../src/services/team-hub.ts'
import { ago } from './card.ts'
import { remotePage } from './remote-page.ts'

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
  (v.dir === 'in' || v.dir === 'out') &&
  (typeof v.text === 'string' || (v.text === null && v.held === true)) &&
  typeof v.ts === 'string' &&
  (v.state === undefined || isDelivery(v.state)) &&
  (v.code === undefined || typeof v.code === 'string') &&
  (v.held === undefined || typeof v.held === 'boolean')

/** GET /api/team/thread/<peer>. */
export const isThread = (v: unknown): v is { peer: string; messages: ThreadMessage[] } =>
  isObj(v) && typeof v.peer === 'string' && Array.isArray(v.messages) && v.messages.every(isThreadMessage)

/**
 * Whether the page offers the Team panel and its Settings entry: on the local board only, while the
 * payload carries `teamRev`. Anywhere else nothing of it is drawn and /api/team is never asked.
 */
export const offersTeam = (
  payload?: { teamRev?: number | undefined } | null,
  remote: boolean = remotePage(),
): boolean => !remote && payload?.teamRev !== undefined

/** The connection line: where it stands, and for reconnecting when the next try is. */
export function stateLine(view: TeamView, t: Translator): string {
  const line = t(`team.state.${view.state}`, { hub: view.hub })
  if (view.state === 'error' && view.error) return `${line}: ${view.error}`
  if (view.state === 'reconnecting' && view.nextAt)
    return `${line} (${t('team.nextAt', { time: new Date(view.nextAt).toLocaleTimeString() })})`
  return line
}

/** When a person was last in the network. */
export const seenLine = (p: TeamRosterPeer, now: number, t: Translator): string =>
  p.online ? t('team.online') : p.lastSeen ? t('team.lastSeen', { when: ago(p.lastSeen, now, t) }) : t('team.neverSeen')

/** What a refused send says (the route's error code). */
export const sendError = (code: unknown, t: Translator): string =>
  t('team.sendFailed', {
    why:
      code === 'peer' || code === 'text' || code === 'too_big' || code === 'changed'
        ? t(`team.err.${code}`)
        : String(code ?? ''),
  })
