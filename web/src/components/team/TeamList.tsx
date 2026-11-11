// The Team panel's list of conversations (#370), the sidebar of a wide panel and the first screen
// of a narrow one. On top: where the connection stands, People and agents (the roster, the keys,
// the passkeys and the switches have a view of their own: TeamPeople.tsx), New channel, and a new
// member's welcome while it waits. Then the team chat first with the team's topics under it, the
// channels, each person's general with their topics under them, and who left. Every row: its
// mark, title, the latest message's line, its time and the unread count; a muted one is dimmed.
import { useState } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  type AgentsView,
  channelsOf,
  scopeThreads,
  stateLine,
  type TeamRosterPeer,
  type TeamView,
  type ThreadView,
  type Welcome,
} from '../../models/team.ts'
import { initialOf, lastLine, listWhen, toneOf } from '../../models/team-chat.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { WelcomeCard } from './TeamPeople.tsx'

export interface TeamListProps {
  view: TeamView
  threads: ThreadView[]
  selected: string | null
  unread: Record<string, number>
  agents: AgentsView | null
  pending: string[]
  disabled: boolean
  onSelect(key: string): void
  onPeople(): void
  onWelcome?(w: Welcome): void
  onNewChannel?(): void
}

export function TeamList({
  view,
  threads,
  selected,
  unread,
  agents,
  pending,
  disabled,
  onSelect,
  onPeople,
  onWelcome,
  onNewChannel,
}: TeamListProps) {
  const t = useT()
  // A welcome put off for now (Later): the person keeps their mark until it is done.
  const [later, setLater] = useState<string[]>([])
  const welcoming = agents ? view.roster.find(p => pending.includes(p.peer) && !later.includes(p.peer)) : undefined
  const channels = channelsOf(threads)
  const chatMuted = agents?.peers.team?.muted === true
  // Threads with someone no longer in the roster: still there to read, and to clear their count.
  const inRoster = new Set(view.roster.map(p => p.peer))
  const gone = [...new Set(threads.map(x => x.scope))].filter(scope => scope !== 'team' && !inRoster.has(scope))
  const row = (entry: { key: string; thread: ThreadView | null }, mark: Mark, extra: Partial<RowProps> = {}) => (
    <ThreadRow
      key={entry.key}
      entry={entry}
      mark={mark}
      unread={unread[entry.key] ?? 0}
      active={entry.key === selected}
      onSelect={onSelect}
      {...extra}
    />
  )
  const scopeRows = (scope: string, head: Mark, name?: string, extra: Partial<RowProps> = {}) =>
    scopeThreads(scope, threads).map((entry, i) =>
      i === 0
        ? row(entry, head, { ...(name && { title: name }), ...extra })
        : row(entry, { kind: 'topic' }, { sub: true, ...extra }),
    )
  return (
    <nav className="team-side" aria-label={t('team.title')}>
      <div className="team-side-head">
        <p className={classNames('team-state', view.state)} data-state={view.state} title={stateLine(view, t)}>
          <span className="team-state-dot" aria-hidden="true" />
          <span>{stateLine(view, t)}</span>
        </p>
        <div className="team-side-tools">
          <button type="button" className="mini" data-people onClick={onPeople}>
            {t('team.peopleOpen')}
          </button>
          {onNewChannel && view.roster.length > 0 && (
            <button type="button" className="mini" disabled={disabled} onClick={onNewChannel}>
              {t('team.newChannel')}
            </button>
          )}
        </div>
      </div>
      {welcoming && agents && (
        <WelcomeCard
          key={welcoming.peer}
          peer={welcoming}
          agents={agents}
          channels={channels.filter(c => c.by === 'me')}
          disabled={disabled}
          onDone={w => onWelcome?.(w)}
          onLater={() => setLater(l => [...l, welcoming.peer])}
        />
      )}
      <section className={classNames('team-scope', 'team-chat', chatMuted && 'muted')}>
        {scopeRows('team', { kind: 'team' }, t('team.chat'), chatMuted ? { muted: true } : {})}
      </section>
      <section className="team-scope team-channels">
        <h3>{t('team.channels')}</h3>
        {!channels.length && <p className="hint">{t('team.channelsNone')}</p>}
        {channels.map(c =>
          row(
            { key: c.key, thread: c },
            { kind: 'channel' },
            { meta: t('team.membersCount', { n: c.members?.length ?? 0 }) },
          ),
        )}
      </section>
      <section className="team-scope team-roster">
        <h3>{t('team.roster')}</h3>
        {!view.roster.length && <p className="hint">{t('team.rosterEmpty')}</p>}
        {view.roster.map((p: TeamRosterPeer) => (
          <div key={p.peer} className={classNames('team-peer', p.pin === 'changed' && 'changed')} data-peer={p.peer}>
            {scopeRows(p.peer, { kind: 'person', peer: p }, p.name, pending.includes(p.peer) ? { fresh: true } : {})}
          </div>
        ))}
      </section>
      {gone.length > 0 && (
        <section className="team-scope team-gone">
          <h3>{t('team.former')}</h3>
          {gone.map(scope => (
            <div key={scope} className="team-peer">
              {scopeRows(
                scope,
                { kind: 'gone' },
                threads.find(x => x.scope === scope)?.peerName ?? t('team.formerOne'),
              )}
            </div>
          ))}
        </section>
      )}
    </nav>
  )
}

/** A row's mark: the team chat's, a channel's #, a person's initial with their online dot, a topic's none. */
type Mark =
  | { kind: 'team' }
  | { kind: 'channel' }
  | { kind: 'person'; peer: TeamRosterPeer }
  | { kind: 'gone' }
  | { kind: 'topic' }

interface RowProps {
  entry: { key: string; thread: ThreadView | null }
  mark: Mark
  unread: number
  active: boolean
  onSelect(key: string): void
  /** The title when it is not the thread's own (a person, the team chat). */
  title?: string
  /** A word after the title (a channel's member count). */
  meta?: string
  /** A topic under its scope's general. */
  sub?: boolean
  /** Muted from above (the team chat as a whole). */
  muted?: boolean
  /** A new member who waits for a welcome (#355). */
  fresh?: boolean
}

/** A conversation's row: its mark, title, the latest message's line and time, the unread count or the muted mark. */
function ThreadRow({ entry, mark, unread, active, onSelect, title, meta, sub, muted: mutedAbove, fresh }: RowProps) {
  const t = useT()
  const { now } = useBoardContext()
  const thread = entry.thread
  const muted = thread?.muted === true || mutedAbove === true
  const last = thread?.last
  const person = mark.kind === 'person' ? mark.peer : null
  return (
    <button
      type="button"
      className={classNames('team-row', muted && 'muted', active && 'active', sub && 'sub')}
      data-thread={entry.key}
      aria-current={active ? 'true' : undefined}
      onClick={() => onSelect(entry.key)}
    >
      {!sub && <RowMark mark={mark} />}
      <span className="team-row-main">
        <span className="team-row-top">
          <span className="team-row-title">{title ?? thread?.title ?? t('team.general')}</span>
          {meta && <span className="team-row-meta">{meta}</span>}
          {fresh && !sub && (
            <span className="team-new" title={t('team.newMember')} role="img" aria-label={t('team.newMember')} />
          )}
          {person?.pin === 'changed' && <span className="team-row-changed">{t('team.keyChanged')}</span>}
          {last && <span className="team-row-when">{listWhen(last.ts, t, now)}</span>}
        </span>
        <span className="team-row-bottom">
          <span className="team-row-last">{thread ? lastLine(thread, t) : t('team.threadEmpty')}</span>
          {muted ? <MutedMark /> : <Unread n={unread} />}
        </span>
      </span>
    </button>
  )
}

function RowMark({ mark }: { mark: Mark }) {
  if (mark.kind === 'person')
    return (
      <span className={`team-avatar tone-${toneOf(mark.peer.peer)}`} aria-hidden="true">
        {initialOf(mark.peer.name)}
        <span className={classNames('team-avatar-dot', mark.peer.online && 'on')} />
      </span>
    )
  if (mark.kind === 'channel')
    return (
      <span className="team-avatar channel" aria-hidden="true">
        #
      </span>
    )
  if (mark.kind === 'team')
    return (
      <span className="team-avatar team" aria-hidden="true">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="5.5" cy="6" r="2.2" />
          <circle cx="10.5" cy="6" r="2.2" />
          <path d="M1.8 12.5c.6-2 2-3 3.7-3s3.1 1 3.7 3M6.8 12.5c.6-2 2-3 3.7-3s3.1 1 3.7 3" />
        </svg>
      </span>
    )
  return <span className="team-avatar gone" aria-hidden="true" />
}

function Unread({ n }: { n: number }) {
  const t = useT()
  if (n <= 0) return null
  return (
    <span className="n team-unread" title={t('team.unread', { n })}>
      {n}
    </span>
  )
}

function MutedMark() {
  const t = useT()
  return (
    <span className="team-muted" role="img" aria-label={t('team.muted')} title={t('team.muted')}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M6.5 13.5h3M4 11h8l-1-1.5V7a3 3 0 00-5.2-2M5 6.6v2.9L4 11M2.5 2.5l11 11" />
      </svg>
    </span>
  )
}
