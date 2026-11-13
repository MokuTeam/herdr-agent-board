// Shared threads on the board's page (#394, docs/design/threads 11): what the thread's head says of
// its sharing (shared with whom, an agent's request to share, a teammate's offer), where the owner
// can share it to, what an entry's way to the hub says, and a Team topic's thread. Pure; the data
// is the thread's head (GET /api/threads/<key>), the Team view (GET /api/team) and its topics (GET
// /api/team/threads).
import type { Translator } from '../../../src/core/types.ts'
import {
  type EntryOut,
  isThreadStatus,
  type Party,
  requestOf,
  type SharedScope,
  sharingOf,
  type ThreadHead,
  type ThreadStatus,
} from '../../../src/core/work-threads.ts'
import type { TeamView, ThreadView as TopicView } from './team.ts'

/** Where a thread stands with sharing: on this board only, asked to be shared, shared, or no longer. */
export type ShareState =
  | { kind: 'local' }
  | { kind: 'request'; to: string; history: boolean; by: Party }
  | { kind: 'shared'; scope: SharedScope; mine: boolean; offer: boolean }
  | { kind: 'ended'; scope: SharedScope }

export function shareStateOf(head: Pick<ThreadHead, 'scope'>): ShareState {
  const r = requestOf(head)
  if (r) return { kind: 'request', to: r.to, history: r.history, by: r.by }
  const s = sharingOf(head)
  if (!s) return { kind: 'local' }
  if (s.ended !== undefined) return { kind: 'ended', scope: s }
  return { kind: 'shared', scope: s, mine: s.by === 'me', offer: !!s.offer }
}

type Roster = readonly { peer: string; name: string }[]

/** A teammate by this board's name for them, else a word that says it is one. */
export const nameIn = (roster: Roster, peer: string, t: Translator): string =>
  roster.find(p => p.peer === peer)?.name ?? t('wt.share.someone')

/** Who a shared thread goes to, in this board's names: the teammate, the team, a channel's others. */
export function sharedWith(s: SharedScope, roster: Roster, me: string | null, t: Translator): string {
  if (s.kind === 'team') return t('wt.share.theTeam')
  if (s.kind === 'peer') return s.peer ? nameIn(roster, s.peer, t) : t('wt.share.someone')
  const names = (s.members ?? []).filter(m => m !== me).map(m => nameIn(roster, m, t))
  return names.join(', ') || t('wt.share.someone')
}

/** Who shared a thread with this board: its sharer by this board's name. */
export const sharedBy = (s: SharedScope, roster: Roster, t: Translator): string =>
  s.by === 'me' ? t('wt.you') : nameIn(roster, s.by, t)

/**
 * The teammates' boards a shared thread can be offered to (11.6): the pair's peer, any teammate on
 * a team thread, a channel's other members; by this board's names for them (the assignee's own
 * name for one the roster does not know yet).
 */
export function offerPeers(
  s: SharedScope,
  roster: Roster,
  me: string | null,
  t: Translator,
  assignee: Party | null = null,
): { peer: string; name: string }[] {
  const ids =
    s.kind === 'peer' ? (s.peer ? [s.peer] : []) : s.kind === 'team' ? roster.map(p => p.peer) : (s.members ?? [])
  const known = (peer: string): string | undefined =>
    roster.find(p => p.peer === peer)?.name ??
    (assignee?.kind === 'peer' && assignee.peer === peer && assignee.name ? assignee.name : undefined)
  return ids.filter(id => id !== me).map(peer => ({ peer, name: known(peer) ?? t('wt.share.someone') }))
}

/** A place the owner can share a thread to: a teammate, the team, a channel this board started. */
export interface ShareTarget {
  /** What POST /api/threads/<id> {op: 'share'} takes: a peer id, `team`, a channel's key. */
  to: string
  label: string
  kind: 'peer' | 'team' | 'channel'
  /** A teammate whose board keeps no shared threads: it reads the entries as plain lines in the topic. */
  old?: true
}

/**
 * Where a thread can be shared (11.2): each teammate whose key is trusted, the team when it has
 * anyone in it, and the channels this board started (the board refuses the lanes it may not).
 */
export function shareTargets(view: TeamView | null, topics: readonly TopicView[], t: Translator): ShareTarget[] {
  if (!view) return []
  const peers = view.roster.filter(p => p.pin !== 'changed')
  // The roster says `work` of a board that keeps shared threads (while this one does too).
  const out: ShareTarget[] = peers.map(p => ({
    to: p.peer,
    label: p.name,
    kind: 'peer',
    ...((p as { work?: unknown }).work !== true && { old: true as const }),
  }))
  if (view.roster.length) out.push({ to: 'team', label: t('wt.share.theTeam'), kind: 'team' })
  for (const c of topics)
    if (c.scope === 'team' && c.members && c.by === 'me')
      out.push({ to: c.key, label: `# ${c.title ?? c.key}`, kind: 'channel' })
  return out
}

/** The target an agent's request names, when the board knows it: a teammate's name, `team`, a channel's title. */
export function requestTarget(word: string, targets: readonly ShareTarget[]): ShareTarget | null {
  const w = word.trim().toLowerCase()
  return (
    targets.find(x => x.to.toLowerCase() === w || x.label.toLowerCase() === w || x.label.toLowerCase() === `# ${w}`) ??
    null
  )
}

/** What an entry's way to the hub says (11.3), as a key of the page's words; null for none. */
export function outWord(out: EntryOut | undefined): string | null {
  switch (out) {
    case 'held':
      return 'wt.out.held'
    case 'queued':
      return 'wt.out.queued'
    case 'refused':
      return 'wt.out.refused'
    case 'discarded':
      return 'wt.out.discarded'
    case 'copy':
      return 'wt.out.copy'
    default:
      return null
  }
}

/** Whether the owner can press Send on an entry: one that waits for them (11.3). */
export const sendable = (out: EntryOut | undefined): boolean => out === 'held'

/** A teammate's entry by who wrote it: their agent at their board (`atlas-mapper@ben`), or their board. */
export function peerLabel(p: Extract<Party, { kind: 'peer' }>): string {
  const board = p.name || p.peer.slice(0, 8)
  return p.agent ? `${p.agent}@${board}` : board
}

/** A Team topic that is a shared thread (#394): its key and status, from GET /api/team/threads. */
export interface TopicWork {
  key: string
  status: ThreadStatus
  id: string
}

/** The shared thread a topic row carries, or null. */
export function topicWork(row: unknown): TopicWork | null {
  if (typeof row !== 'object' || row === null) return null
  const w = (row as { work?: unknown }).work
  if (typeof w !== 'object' || w === null) return null
  const { key, status, id } = w as Record<string, unknown>
  return typeof key === 'string' && typeof id === 'string' && isThreadStatus(status) ? { key, status, id } : null
}

/** What an owner's write on a shared thread answered of its way to the hub, as a toast; null for nothing to say. */
export function sentToast(reply: Record<string, unknown>, t: Translator): { text: string; error: boolean } | null {
  switch (reply.out) {
    case 'held':
      return { text: t('wt.out.heldToast', { reason: String(reply.reason ?? '') }), error: false }
    case 'queued':
      return { text: t('wt.out.queuedToast'), error: false }
    case 'refused':
      return { text: t('wt.out.refusedToast', { error: String(reply.error ?? '') }), error: true }
    default:
      return null
  }
}
