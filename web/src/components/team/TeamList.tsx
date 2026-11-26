// The Team panel's list of conversations (#370, #835), the sidebar of a wide panel and the first
// screen of a narrow one. On top: a sticky bar with where the connection stands, People and agents
// (TeamPeople.tsx), New channel, and a quick filter over topic titles, people and channels. Then a
// new member's welcome while it waits, what the owner's phone asked (TeamWaiting.tsx, #377), and
// the agents' drafts that wait for the owner (TeamDrafts.tsx, #415). Under them, Slack-like
// sections: Team chat, Channels, People, and Former. Per person (and team chat), general and recent
// or unread topics stay visible while older read topics (> 7 days) fold under one quiet "Older (N)"
// row remembered in localStorage.
import { useState } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  type AgentsView,
  archivedChannelsOf,
  channelsOf,
  type DraftLine,
  scopeThreads,
  stateLine,
  type TeamRosterPeer,
  type TeamView,
  type ThreadView,
  type Waiting,
  type Welcome,
} from '../../models/team.ts'
import { initialOf, lastLine, listWhen, toneOf } from '../../models/team-chat.ts'
import {
  filterScope,
  loadExpandedScopes,
  matchesEntry,
  normalizeQuery,
  saveExpandedScopes,
  splitScopeEntries,
  toggleExpandedScope,
} from '../../models/team-list.ts'
import { topicWork } from '../../models/work-share.ts'
import { statusColor } from '../../models/work-threads.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { SearchIcon } from '../icons.tsx'
import { StatusDot, statusWord } from '../threads/bits.tsx'
import { TeamDrafts } from './TeamDrafts.tsx'
import { WelcomeCard } from './TeamPeople.tsx'
import { TeamWaiting } from './TeamWaiting.tsx'

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
  /** The agents' drafts that wait, every thread's (#415), with Send and Discard. */
  drafts?: readonly DraftLine[]
  onSendDraft?(id: string): void
  onDiscardDraft?(id: string): void
  /** What the owner's phone asked and waits for the passkey here (#377), with Confirm. */
  waiting?: readonly Waiting[]
  onConfirmWaiting?(id: string): void
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
  drafts = [],
  onSendDraft,
  onDiscardDraft,
  waiting = [],
  onConfirmWaiting,
}: TeamListProps) {
  const t = useT()
  const { now } = useBoardContext()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => loadExpandedScopes())
  // A welcome put off for now (Later): the person keeps their mark until it is done.
  const [later, setLater] = useState<string[]>([])
  const welcoming = agents ? view.roster.find(p => pending.includes(p.peer) && !later.includes(p.peer)) : undefined
  const channels = channelsOf(threads)
  const archivedChannels = archivedChannelsOf(threads)
  const chatMuted = agents?.peers.team?.muted === true
  // Threads with someone no longer in the roster: still there to read, and to clear their count.
  const inRoster = new Set(view.roster.map(p => p.peer))
  const gone = [...new Set(threads.map(x => x.scope))].filter(scope => scope !== 'team' && !inRoster.has(scope))
  const filtering = normalizeQuery(query) !== ''

  const toggleScope = (scope: string) => {
    setExpanded(prev => {
      const next = toggleExpandedScope(prev, scope)
      saveExpandedScopes(next)
      return next
    })
  }

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

  const renderScope = (scope: string, head: Mark, name?: string, extra: Partial<RowProps> = {}) => {
    const entries = scopeThreads(scope, threads)
    if (filtering) {
      const { general, topics } = filterScope(entries, query, name ?? '')
      if (!general && !topics.length) return null
      return (
        <>
          {general ? (
            row(general, head, { ...(name && { title: name }), ...extra })
          ) : (
            <div className="team-peer-heading">
              <RowMark mark={head} />
              <span>{name}</span>
            </div>
          )}
          {topics.length > 0 && (
            <div className="team-topics">
              {topics.map(entry => row(entry, { kind: 'topic' }, { sub: true, ...extra }))}
            </div>
          )}
        </>
      )
    }
    const { general, visible, older } = splitScopeEntries(entries, { now, unread, selected })
    const isOpen = expanded.has(scope)
    return (
      <>
        {general && row(general, head, { ...(name && { title: name }), ...extra })}
        {(visible.length > 0 || older.length > 0) && (
          <div className="team-topics">
            {visible.map(entry => row(entry, { kind: 'topic' }, { sub: true, ...extra }))}
            {older.length > 0 && (
              <>
                <button
                  type="button"
                  className={classNames('team-older-toggle', isOpen && 'open')}
                  data-older-toggle={scope}
                  aria-expanded={isOpen}
                  aria-label={
                    isOpen ? t('team.olderHide', { n: older.length }) : t('team.olderShow', { n: older.length })
                  }
                  onClick={() => toggleScope(scope)}
                >
                  <ChevronGlyph />
                  <span>{t('team.older', { n: older.length })}</span>
                </button>
                {isOpen && (
                  <div className="team-older-list" data-older-list={scope}>
                    {older.map(entry => row(entry, { kind: 'topic' }, { sub: true, ...extra }))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </>
    )
  }

  const teamContent = renderScope('team', { kind: 'team' }, t('team.chat'), chatMuted ? { muted: true } : {})
  const shownChannels = filtering
    ? channels.filter(c => matchesEntry({ key: c.key, thread: c }, query, c.title ?? ''))
    : channels
  const shownArchivedChannels = filtering
    ? archivedChannels.filter(c => matchesEntry({ key: c.key, thread: c }, query, c.title ?? ''))
    : archivedChannels
  const rosterContent = view.roster.flatMap((p: TeamRosterPeer) => {
    const content = renderScope(
      p.peer,
      { kind: 'person', peer: p },
      p.name,
      pending.includes(p.peer) ? { fresh: true } : {},
    )
    if (!content) return []
    return [
      <div key={p.peer} className={classNames('team-peer', p.pin === 'changed' && 'changed')} data-peer={p.peer}>
        {content}
      </div>,
    ]
  })
  const goneContent = gone.flatMap(scope => {
    const peerName = threads.find(x => x.scope === scope)?.peerName ?? t('team.formerOne')
    const content = renderScope(scope, { kind: 'gone' }, peerName)
    if (!content) return []
    return [
      <div key={scope} className="team-peer">
        {content}
      </div>,
    ]
  })
  const noFilterMatches =
    filtering &&
    !teamContent &&
    !shownChannels.length &&
    !shownArchivedChannels.length &&
    !rosterContent.length &&
    !goneContent.length

  return (
    <nav className="team-side" aria-label={t('team.title')}>
      <div className="team-side-sticky">
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
        <div className="team-filter">
          <label className="team-search">
            <SearchIcon />
            <input
              type="search"
              data-team-filter
              value={query}
              placeholder={t('team.filterPlaceholder')}
              aria-label={t('team.filterPlaceholder')}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault()
                  setQuery('')
                }
              }}
            />
            {query && (
              <button
                type="button"
                className="team-filter-clear"
                data-team-filter-clear
                aria-label={t('team.filterClear')}
                title={t('team.filterClear')}
                onClick={() => setQuery('')}
              >
                <ClearGlyph />
              </button>
            )}
          </label>
        </div>
      </div>
      {welcoming && agents && (
        <WelcomeCard
          key={welcoming.peer}
          peer={welcoming}
          agents={agents}
          channels={channels.filter(c => c.by === 'me' && !c.archived)}
          disabled={disabled}
          onDone={w => onWelcome?.(w)}
          onLater={() => setLater(l => [...l, welcoming.peer])}
        />
      )}
      <TeamWaiting waiting={waiting} disabled={disabled} onConfirm={id => onConfirmWaiting?.(id)} />
      <TeamDrafts
        drafts={drafts}
        threads={threads}
        view={view}
        disabled={disabled}
        onSelect={onSelect}
        onSend={id => onSendDraft?.(id)}
        onDiscard={id => onDiscardDraft?.(id)}
      />
      {teamContent && (
        <section className={classNames('team-scope', 'team-chat', chatMuted && 'muted')}>
          <h3>{t('team.chatSection')}</h3>
          {teamContent}
        </section>
      )}
      {(!filtering || shownChannels.length > 0) && (
        <section className="team-scope team-channels">
          <h3>{t('team.channels')}</h3>
          {!shownChannels.length && <p className="hint">{t('team.channelsNone')}</p>}
          {shownChannels.map(c =>
            row(
              { key: c.key, thread: c },
              { kind: 'channel' },
              { meta: c.archived ? t('team.channelArchived') : t('team.membersCount', { n: c.members?.length ?? 0 }) },
            ),
          )}
        </section>
      )}
      {shownArchivedChannels.length > 0 && (
        <details className="team-scope team-archive" data-channel-archive open={filtering || undefined}>
          <summary>
            <h3>{t('team.channelArchive')}</h3>
          </summary>
          {shownArchivedChannels.map(c =>
            row({ key: c.key, thread: c }, { kind: 'channel' }, { meta: t('team.channelArchived'), muted: true }),
          )}
        </details>
      )}
      {(!filtering || rosterContent.length > 0) && (
        <section className="team-scope team-roster">
          <h3>{t('team.roster')}</h3>
          {!view.roster.length && !filtering && <p className="hint">{t('team.rosterEmpty')}</p>}
          {rosterContent}
        </section>
      )}
      {goneContent.length > 0 && (
        <section className="team-scope team-gone">
          <h3>{t('team.former')}</h3>
          {goneContent}
        </section>
      )}
      {noFilterMatches && (
        <p className="hint team-filter-empty" data-filter-empty>
          {t('team.filterEmpty')}
        </p>
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
  const hasUnread = unread > 0 && !muted
  const last = thread?.last
  const person = mark.kind === 'person' ? mark.peer : null
  // A topic that is a shared thread (#394): its key and status on the row.
  const work = topicWork(thread)
  const preview = thread ? lastLine(thread, t) : t('team.threadEmpty')
  if (sub) {
    return (
      <button
        type="button"
        className={classNames('team-row', 'sub', muted && 'muted', active && 'active', hasUnread && 'unread')}
        data-thread={entry.key}
        aria-current={active ? 'true' : undefined}
        onClick={() => onSelect(entry.key)}
      >
        <span className="team-row-main">
          <span className="team-row-title">{title ?? thread?.title ?? t('team.general')}</span>
          {work && (
            <span
              className="wt-topic-pill"
              style={{ '--c': statusColor(work.status) }}
              title={t('wt.topic.pill', { key: work.key, status: statusWord(work.status, t) })}
            >
              <StatusDot status={work.status} />
              {work.key}
            </span>
          )}
          {last && <span className="team-row-last">{preview}</span>}
          {last && <span className="team-row-when">{listWhen(last.ts, t, now)}</span>}
          {muted ? <MutedMark /> : <Unread n={unread} />}
        </span>
      </button>
    )
  }
  return (
    <button
      type="button"
      className={classNames('team-row', muted && 'muted', active && 'active', hasUnread && 'unread')}
      data-thread={entry.key}
      aria-current={active ? 'true' : undefined}
      onClick={() => onSelect(entry.key)}
    >
      <RowMark mark={mark} />
      <span className="team-row-main">
        <span className="team-row-top">
          <span className="team-row-title">{title ?? thread?.title ?? t('team.general')}</span>
          {work && (
            <span
              className="wt-topic-pill"
              style={{ '--c': statusColor(work.status) }}
              title={t('wt.topic.pill', { key: work.key, status: statusWord(work.status, t) })}
            >
              <StatusDot status={work.status} />
              {work.key}
            </span>
          )}
          {meta && <span className="team-row-meta">{meta}</span>}
          {fresh && (
            <span className="team-new" title={t('team.newMember')} role="img" aria-label={t('team.newMember')} />
          )}
          {person?.pin === 'changed' && <span className="team-row-changed">{t('team.keyChanged')}</span>}
          {last && <span className="team-row-when">{listWhen(last.ts, t, now)}</span>}
        </span>
        <span className="team-row-bottom">
          <span className="team-row-last">{preview}</span>
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

function ChevronGlyph() {
  return (
    <svg className="team-older-chev" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4.5 2.5L8 6l-3.5 3.5" />
    </svg>
  )
}

function ClearGlyph() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  )
}
