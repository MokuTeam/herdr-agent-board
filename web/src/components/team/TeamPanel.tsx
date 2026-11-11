// The team panel (#231), out of Settings → Team… or the head's Team button, while the payload
// carries `teamRev`. Two views, as in a chat app (#355):
//
// - The list: where the connection to the team's hub stands; the team chat first, then each person
//   (online or not, their key's fingerprint, Trust when it changed), each with their general thread
//   and their topics (#216) under them, every thread with its unread count and whether it is muted;
//   on this computer, the owner's agent switches (#216): all agents, the listener, and for the team
//   and each person agents on and the lanes shared.
// - A thread: its title and link, its mute, the messages (each of yours with how far it got, a
//   team post with each member's copy, what came from a changed key held, an agent's draft with
//   Send and Discard), a box to write in it, and in a general thread a new topic.
//
// The data is hooks/useTeam.ts's; the board sends only its revision.
import { useEffect, useState } from 'react'
import { type NewTopic, useTeam } from '../../hooks/useTeam.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  type AgentsChange,
  type AgentsView,
  channelsOf,
  isChannel,
  keyParts,
  lineMeta,
  safeLink,
  scopeThreads,
  seenLine,
  stateLine,
  type TeamRosterPeer,
  type TeamView,
  type ThreadLine,
  type ThreadView,
  type Welcome,
} from '../../models/team.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { Panel } from '../panel/Panel.tsx'
import { Switch } from './Switch.tsx'
import { TeamPasskeys } from './TeamPasskeys.tsx'

export interface TeamPanelProps {
  open: boolean
  onClose(): void
  /** A thread a notification's click asked for (#355): it is shown once, then onFocused. */
  focus?: string | null
  onFocused?(): void
}

export function TeamPanel({ open, onClose, focus, onFocused }: TeamPanelProps) {
  const t = useT()
  const { canEdit } = useBoardContext()
  const team = useTeam(open)
  const { select } = team
  const [draft, setDraft] = useState('')
  const [topic, setTopic] = useState<NewTopic | null>(null)
  const [sending, setSending] = useState(false)
  const show = (key: string | null) => {
    setTopic(null)
    select(key)
  }
  useEffect(() => {
    if (!focus) return
    setTopic(null)
    select(focus)
    onFocused?.()
  }, [focus, select, onFocused])
  // A channel starts in the team chat's general: a title, its members, the first message (#355).
  const newChannel = () => {
    select('team/general')
    setTopic({ title: '', members: [] })
  }
  const send = async () => {
    if (!draft.trim() || (topic && (!topic.title.trim() || topic.members?.length === 0))) return
    setSending(true)
    const ok = await team.send(
      draft,
      topic
        ? {
            title: topic.title.trim(),
            ...(topic.link?.trim() && { link: topic.link.trim() }),
            ...(topic.members && { members: topic.members }),
          }
        : undefined,
    )
    if (ok) {
      setDraft('')
      setTopic(null)
    }
    setSending(false)
  }
  return (
    <Panel
      id="team-sheet"
      kind="team"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('team.title')}</h2>
          <p className="sheet-meta">{t('team.about')}</p>
        </>
      }
    >
      <TeamBody
        view={team.view}
        threads={team.threads}
        selected={team.selected}
        thread={team.thread}
        lines={team.lines}
        unread={team.unread}
        agents={team.agents}
        draft={draft}
        topic={topic}
        disabled={!canEdit || sending}
        onSelect={show}
        onTrust={peer => void team.trust(peer)}
        onSendDraft={id => void team.sendDraft(id)}
        onDiscardDraft={id => void team.discardDraft(id)}
        onDraft={setDraft}
        onTopic={setTopic}
        onSend={() => void send()}
        onMute={(key, muted) => void team.mute(key, muted)}
        onAgents={change => void team.setAgents(change)}
        pending={team.pending}
        onWelcome={w => void team.welcome(w)}
        onNewChannel={newChannel}
        onAddMembers={(key, peers) => void team.addMembers(key, peers)}
      />
    </Panel>
  )
}

export interface TeamBodyProps {
  /** GET /api/team's answer; null while the board is asked. */
  view: TeamView | null
  threads: ThreadView[]
  /** The key of the thread on show; null: the list. */
  selected: string | null
  /** The thread on show as the board keeps it; null while nothing was written in it. */
  thread: ThreadView | null
  lines: ThreadLine[]
  /** Each thread's unread messages (#355); none given: none shown. */
  unread?: Record<string, number>
  /** The owner's switches; null (a remote page): not shown, and the team chat's mute neither. */
  agents: AgentsView | null
  draft: string
  /** A new topic being written in the thread's scope; null: a message in the thread on show. */
  topic: NewTopic | null
  disabled: boolean
  onSelect(key: string | null): void
  onTrust(peer: string): void
  /** Press Send on an agent's draft: it goes out marked as an agent request. */
  onSendDraft(id: string): void
  onDiscardDraft(id: string): void
  onDraft(text: string): void
  onTopic(topic: NewTopic | null): void
  onSend(): void
  onMute(key: string, muted: boolean): void
  onAgents(change: AgentsChange): void
  /** Who joined and waits for a welcome (#355); none given: none offered. */
  pending?: string[]
  onWelcome?(w: Welcome): void
  /** Start a channel: the team chat's general with a new topic for some members (#355). */
  onNewChannel?(): void
  /** More members for a channel this board started (#355). */
  onAddMembers?(key: string, peers: string[]): void
}

/** The list of threads, or the thread on show. */
export function TeamBody(props: TeamBodyProps) {
  if (!props.view) return <div className="sheet-body team-body" />
  return (
    <div className="sheet-body team-body">
      {props.selected ? (
        <ThreadPane {...props} view={props.view} selected={props.selected} />
      ) : (
        <ListPane {...props} view={props.view} />
      )}
    </div>
  )
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

/** A thread's row in the list: its title (General for none), its unread count, muted. */
function ThreadRow({
  entry,
  unread,
  onSelect,
  meta,
}: {
  entry: { key: string; thread: ThreadView | null }
  unread: number
  onSelect(key: string): void
  /** A word after the title (a channel's member count). */
  meta?: string
}) {
  const t = useT()
  const muted = entry.thread?.muted === true
  return (
    <button
      type="button"
      className={classNames('team-row', muted && 'muted')}
      data-thread={entry.key}
      onClick={() => onSelect(entry.key)}
    >
      <span className="team-row-title">{entry.thread?.title ?? t('team.general')}</span>
      {meta && <span className="todo-meta team-muted">{meta}</span>}
      {muted && <span className="todo-meta team-muted">{t('team.muted')}</span>}
      <Unread n={muted ? 0 : unread} />
    </button>
  )
}

function ListPane({
  view,
  threads,
  unread = {},
  agents,
  pending = [],
  disabled,
  onSelect,
  onTrust,
  onAgents,
  onWelcome,
  onNewChannel,
}: TeamBodyProps & { view: TeamView }) {
  const t = useT()
  const { now } = useBoardContext()
  // A welcome put off for now (Later): the person keeps their mark until it is done.
  const [later, setLater] = useState<string[]>([])
  const welcoming = agents ? view.roster.find(p => pending.includes(p.peer) && !later.includes(p.peer)) : undefined
  const channels = channelsOf(threads)
  const chatMuted = agents?.peers.team?.muted === true
  // Threads with someone no longer in the roster: still there to read, and to clear their count.
  const inRoster = new Set(view.roster.map(p => p.peer))
  const gone = [...new Set(threads.map(x => x.scope))].filter(scope => scope !== 'team' && !inRoster.has(scope))
  const rows = (scope: string) =>
    scopeThreads(scope, threads).map(entry => (
      <ThreadRow key={entry.key} entry={entry} unread={unread[entry.key] ?? 0} onSelect={onSelect} />
    ))
  return (
    <>
      <section className="team-me">
        <p className={classNames('team-state', view.state)} data-state={view.state}>
          {stateLine(view, t)}
        </p>
        <p className="sheet-meta">
          {view.me.name ? t('team.me', { name: view.me.name }) : t('team.meUnnamed')}
          {view.me.fingerprint && ` · ${t('team.fingerprint', { fingerprint: view.me.fingerprint })}`}
        </p>
      </section>
      {/* The owner's passkeys (#224): on this computer's board only, as the switches are. */}
      {agents && <TeamPasskeys open disabled={disabled} />}
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
        <div className="team-scope-head">
          <h3>{t('team.chat')}</h3>
          {!agents && chatMuted && <span className="todo-meta team-muted">{t('team.muted')}</span>}
          {agents && <span className="todo-meta team-switch-label">{t('team.notifications')}</span>}
          {agents && (
            <Switch
              name="mute-chat"
              on={!chatMuted}
              label={chatMuted ? t('team.unmuteChat') : t('team.muteChat')}
              disabled={disabled}
              onFlip={on => onAgents({ peer: 'team', muted: !on })}
            />
          )}
        </div>
        {rows('team')}
      </section>
      <section className="team-scope team-channels">
        <div className="team-scope-head">
          <h3>{t('team.channels')}</h3>
          {onNewChannel && view.roster.length > 0 && (
            <button type="button" className="mini" disabled={disabled} onClick={onNewChannel}>
              {t('team.newChannel')}
            </button>
          )}
        </div>
        {!channels.length && <p className="hint">{t('team.channelsNone')}</p>}
        {channels.map(c => (
          <ThreadRow
            key={c.key}
            entry={{ key: c.key, thread: c }}
            unread={unread[c.key] ?? 0}
            onSelect={onSelect}
            meta={t('team.membersCount', { n: c.members?.length ?? 0 })}
          />
        ))}
      </section>
      <section className="team-roster">
        <h3>{t('team.roster')}</h3>
        {!view.roster.length && <p className="hint">{t('team.rosterEmpty')}</p>}
        {view.roster.map((p: TeamRosterPeer) => (
          <div key={p.peer} className={classNames('team-peer', p.pin === 'changed' && 'changed')}>
            <div className="team-pick">
              <span className={classNames('dot', 'team-dot', p.online ? 'on' : 'idle')} aria-hidden="true" />
              <span className="team-name">{p.name}</span>
              {pending.includes(p.peer) && (
                <span className="team-new" title={t('team.newMember')} role="img" aria-label={t('team.newMember')} />
              )}
              <span className="todo-meta">{seenLine(p, now, t)}</span>
              {p.drafts > 0 && (
                <span className="todo-meta team-drafts">{t('team.draftsCount', { n: String(p.drafts) })}</span>
              )}
            </div>
            <span className="todo-meta team-fp">{t('team.fingerprint', { fingerprint: p.fingerprint })}</span>
            {p.pin === 'changed' && (
              <div className="team-changed">
                <p>{t('team.changed', { name: p.name })}</p>
                {agents ? (
                  <button type="button" className="mini" disabled={disabled} onClick={() => onTrust(p.peer)}>
                    {t('team.trust')}
                  </button>
                ) : (
                  <p className="hint">{t('team.trustOnComputer')}</p>
                )}
              </div>
            )}
            <div className="team-rows">{rows(p.peer)}</div>
          </div>
        ))}
      </section>
      {gone.length > 0 && (
        <section className="team-roster team-gone">
          <h3>{t('team.former')}</h3>
          {gone.map(scope => (
            <div key={scope} className="team-peer">
              <span className="team-name">{threads.find(x => x.scope === scope)?.peerName ?? t('team.formerOne')}</span>
              <div className="team-rows">{rows(scope)}</div>
            </div>
          ))}
        </section>
      )}
      {agents && (
        <AgentSwitches view={view} agents={agents} channels={channels} disabled={disabled} onAgents={onAgents} />
      )}
    </>
  )
}

/**
 * The owner's agent switches (#216): everything at once, the listener, and for the team chat, each
 * channel (#355) and each person: agents on, the lanes shared, and the loop pause (#360).
 */
function AgentSwitches({
  view,
  agents,
  channels,
  disabled,
  onAgents,
}: {
  view: TeamView
  agents: AgentsView
  channels: ThreadView[]
  disabled: boolean
  onAgents(change: AgentsChange): void
}) {
  const t = useT()
  const { now } = useBoardContext()
  const scopes = [
    { scope: 'team', name: t('team.chat') },
    ...channels.map(c => ({ scope: c.key, name: c.title ?? t('team.general') })),
    ...view.roster.map(p => ({ scope: p.peer, name: p.name })),
  ]
  return (
    <details className="team-agents">
      <summary>
        <h3>{t('team.agents')}</h3>
      </summary>
      <p className="hint">{t('team.agentsAbout')}</p>
      <div className="team-switch-row">
        <span>{t('team.agentsAll')}</span>
        <Switch
          name="agents"
          on={!agents.off}
          label={t('team.agentsAll')}
          disabled={disabled}
          onFlip={on => onAgents({ off: !on })}
        />
      </div>
      <div className="team-switch-row">
        <span>
          {agents.listener
            ? t('team.listener', { name: agents.listener.name ?? agents.listener.key })
            : t('team.listenerNone')}
        </span>
        {agents.listener && (
          <button type="button" className="mini" disabled={disabled} onClick={() => onAgents({ listener: null })}>
            {t('team.listenerClear')}
          </button>
        )}
      </div>
      {scopes.map(({ scope, name }) => {
        const p = agents.peers[scope] ?? { on: false, lanes: [] }
        const paused = agents.paused[scope] ?? 0
        return (
          <div key={scope} className={classNames('team-agent', agents.off && 'off')} data-scope={scope}>
            <div className="team-switch-row">
              <span className="team-name">{name}</span>
              <Switch
                name={`agents-${scope}`}
                on={p.on}
                label={t('team.agentsWith', { name })}
                disabled={disabled}
                onFlip={on => onAgents({ peer: scope, on })}
              />
            </div>
            {paused > now && (
              <p className="hint">{t('team.paused', { time: new Date(paused).toLocaleTimeString() })}</p>
            )}
            <div className="team-lanes">
              <span className="todo-meta">{t('team.lanes')}</span>
              {agents.lanes.map(l => {
                const shared = p.lanes.includes(l.id)
                return (
                  <button
                    key={l.id}
                    type="button"
                    className="mini team-lane"
                    aria-pressed={shared}
                    disabled={disabled}
                    onClick={() =>
                      onAgents({ peer: scope, lanes: shared ? p.lanes.filter(x => x !== l.id) : [...p.lanes, l.id] })
                    }
                  >
                    {l.title}
                  </button>
                )
              })}
            </div>
            <label className="team-loop">
              <span className="todo-meta">{t('team.loop')}</span>
              <input
                key={`${scope}-${p.loop ?? 'default'}`}
                type="number"
                min={1}
                max={100}
                defaultValue={p.loop ?? ''}
                placeholder={String(agents.loopDefault ?? '')}
                disabled={disabled}
                data-loop={scope}
                onBlur={e => {
                  const v = e.currentTarget.value.trim()
                  const n = v === '' ? null : Number(v)
                  if (n === (p.loop ?? null)) return
                  if (n !== null && !(Number.isInteger(n) && n >= 1 && n <= 100)) return
                  onAgents({ peer: scope, loop: n })
                }}
              />
              <span className="todo-meta">{t('team.loopHint', { n: agents.loopDefault ?? '' })}</span>
            </label>
          </div>
        )
      })}
    </details>
  )
}

/**
 * A new member's one screen (#355): the lanes to open to them, their agents on, the channels of
 * this board's to add them to. Nothing changes until Done; Later puts it off, their mark stays.
 */
function WelcomeCard({
  peer,
  agents,
  channels,
  disabled,
  onDone,
  onLater,
}: {
  peer: TeamRosterPeer
  agents: AgentsView
  channels: ThreadView[]
  disabled: boolean
  onDone(w: Welcome): void
  onLater(): void
}) {
  const t = useT()
  const now = agents.peers[peer.peer]
  const [on, setOn] = useState(now?.on ?? false)
  const [lanes, setLanes] = useState<string[]>(now?.lanes ?? [])
  const [joins, setJoins] = useState<string[]>([])
  const flip = (list: string[], id: string) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id])
  return (
    <section className="team-welcome" data-welcome={peer.peer}>
      <h3>{t('team.welcomeTitle', { name: peer.name })}</h3>
      <p className="hint">{t('team.welcomeAbout')}</p>
      <div className="team-switch-row">
        <span>{t('team.agentsWith', { name: peer.name })}</span>
        <Switch
          name="welcome-on"
          on={on}
          label={t('team.agentsWith', { name: peer.name })}
          disabled={disabled}
          onFlip={setOn}
        />
      </div>
      <div className="team-lanes">
        <span className="todo-meta">{t('team.lanes')}</span>
        {agents.lanes.map(l => (
          <button
            key={l.id}
            type="button"
            className="mini team-lane"
            aria-pressed={lanes.includes(l.id)}
            disabled={disabled}
            onClick={() => setLanes(x => flip(x, l.id))}
          >
            {l.title}
          </button>
        ))}
      </div>
      {channels.length > 0 && (
        <div className="team-lanes">
          <span className="todo-meta">{t('team.welcomeChannels')}</span>
          {channels.map(c => (
            <button
              key={c.key}
              type="button"
              className="mini team-lane"
              aria-pressed={joins.includes(c.key)}
              disabled={disabled}
              data-channel={c.key}
              onClick={() => setJoins(x => flip(x, c.key))}
            >
              {c.title}
            </button>
          ))}
        </div>
      )}
      <div className="team-compose-actions">
        <button type="button" className="mini" onClick={onLater}>
          {t('team.later')}
        </button>
        <button
          type="button"
          className="mini"
          data-welcome-done
          disabled={disabled}
          onClick={() => onDone({ peer: peer.peer, on, lanes, channels: joins })}
        >
          {t('team.done')}
        </button>
      </div>
    </section>
  )
}

function ThreadPane({
  view,
  selected,
  thread,
  lines,
  agents,
  draft,
  topic,
  disabled,
  onSelect,
  onTrust,
  onSendDraft,
  onDiscardDraft,
  onDraft,
  onTopic,
  onSend,
  onMute,
  onNewChannel,
  onAddMembers,
}: TeamBodyProps & { view: TeamView; selected: string }) {
  const t = useT()
  const parts = keyParts(selected)
  const scope = parts?.scope ?? ''
  const general = parts?.id === 'general'
  const peer = scope === 'team' ? null : (view.roster.find(p => p.peer === scope) ?? null)
  const changed = peer?.pin === 'changed'
  const channel = isChannel(thread)
  // A channel's members by this board's names for them, this board left out (#355).
  const memberNames = (thread?.members ?? [])
    .filter(m => m !== view.me.peer)
    .map(m => view.roster.find(p => p.peer === m)?.name ?? t('team.formerOne'))
  const where = channel
    ? t('team.channelOf', { names: memberNames.join(', ') })
    : scope === 'team'
      ? t('team.chat')
      : t('team.with', { name: peer?.name ?? thread?.peerName ?? '' })
  const link = safeLink(thread?.link)
  // The team chat's mute is its own threads', not a channel's.
  const chatMuted = scope === 'team' && !channel && agents?.peers.team?.muted === true
  const name = channel ? (thread?.title ?? '') : scope === 'team' ? t('team.chat') : (peer?.name ?? '')
  // Who may be added: in the roster, not a member yet; only in a channel this board started.
  const addable =
    channel && thread?.by === 'me' && onAddMembers && agents
      ? view.roster.filter(p => !(thread?.members ?? []).includes(p.peer))
      : []
  return (
    <section className="team-thread" data-thread={selected}>
      <div className="team-thread-head">
        <button type="button" className="mini team-back" onClick={() => onSelect(null)}>
          {t('team.back')}
        </button>
        {thread && <span className="todo-meta team-switch-label">{t('team.notifications')}</span>}
        {thread && (
          <Switch
            name="mute"
            on={!thread.muted}
            label={thread.muted ? t('team.unmute') : t('team.mute')}
            disabled={disabled}
            onFlip={on => onMute(selected, !on)}
          />
        )}
      </div>
      <h3 className="team-thread-title">{thread?.title ?? t('team.general')}</h3>
      <p className="sheet-meta">
        {where}
        {link && (
          <>
            {' · '}
            <a href={link} target="_blank" rel="noopener noreferrer">
              {link}
            </a>
          </>
        )}
        {(thread?.muted || chatMuted) && ` · ${t('team.mutedHint')}`}
      </p>
      {addable.length > 0 && thread && (
        <AddMember peers={addable} disabled={disabled} onAdd={id => onAddMembers?.(thread.key, [id])} />
      )}
      {changed && peer && (
        <div className="team-changed">
          <p>{t('team.changed', { name: peer.name })}</p>
          {agents ? (
            <button type="button" className="mini" disabled={disabled} onClick={() => onTrust(peer.peer)}>
              {t('team.trust')}
            </button>
          ) : (
            <p className="hint">{t('team.trustOnComputer')}</p>
          )}
        </div>
      )}
      {!lines.length && <p className="hint">{t('team.threadEmpty')}</p>}
      {lines.map(l => (
        <div
          key={`${l.dir}-${l.id}`}
          className={classNames('todo-row', 'team-msg', l.dir, l.held && 'held')}
          data-line={l.id}
        >
          <p className="todo-text">{l.text ?? t('team.heldText')}</p>
          <div className="todo-foot">
            <span className="todo-meta">{lineMeta(l, t)}</span>
            {l.dir === 'draft' && (
              <>
                <button
                  type="button"
                  className="mini"
                  disabled={disabled || changed}
                  title={t('team.draftSendHint')}
                  onClick={() => onSendDraft(l.id)}
                >
                  {t('team.send')}
                </button>
                <button type="button" className="mini" disabled={disabled} onClick={() => onDiscardDraft(l.id)}>
                  {t('team.discard')}
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {changed && <p className="hint">{t('team.sendChanged')}</p>}
      <div className="team-compose">
        {topic && (
          <>
            <input
              value={topic.title}
              maxLength={80}
              placeholder={topic.members ? t('team.channelTitle') : t('team.topicTitle')}
              aria-label={topic.members ? t('team.channelTitle') : t('team.topicTitle')}
              onChange={e => onTopic({ ...topic, title: e.target.value })}
            />
            <input
              value={topic.link ?? ''}
              type="url"
              placeholder={t('team.topicLink')}
              aria-label={t('team.topicLink')}
              onChange={e => onTopic({ ...topic, link: e.target.value })}
            />
            {topic.members && (
              <div className="team-lanes" data-members>
                <span className="todo-meta">{t('team.channelMembers')}</span>
                {view.roster.map(p => {
                  const picked = topic.members?.includes(p.peer) === true
                  return (
                    <button
                      key={p.peer}
                      type="button"
                      className="mini team-lane"
                      aria-pressed={picked}
                      onClick={() =>
                        onTopic({
                          ...topic,
                          members: picked
                            ? (topic.members ?? []).filter(m => m !== p.peer)
                            : [...(topic.members ?? []), p.peer],
                        })
                      }
                    >
                      {p.name}
                    </button>
                  )
                })}
                <span className="hint">{t('team.channelHint')}</span>
              </div>
            )}
          </>
        )}
        <textarea
          value={draft}
          rows={3}
          placeholder={channel ? t('team.channelPlaceholder') : t('team.placeholder', { name })}
          aria-label={channel ? t('team.channelPlaceholder') : t('team.placeholder', { name })}
          onChange={e => onDraft(e.target.value)}
        />
        <div className="team-compose-actions">
          {general && !topic && (
            <button type="button" className="mini" disabled={disabled} onClick={() => onTopic({ title: '' })}>
              {t('team.newTopic')}
            </button>
          )}
          {general && scope === 'team' && !topic && onNewChannel && view.roster.length > 0 && (
            <button type="button" className="mini" disabled={disabled} onClick={onNewChannel}>
              {t('team.newChannel')}
            </button>
          )}
          {topic && (
            <button type="button" className="mini" onClick={() => onTopic(null)}>
              {t('team.cancel')}
            </button>
          )}
          <button
            type="button"
            className="mini"
            data-send
            disabled={
              disabled ||
              !draft.trim() ||
              changed ||
              (topic !== null && (!topic.title.trim() || topic.members?.length === 0))
            }
            title={t('team.sendHint')}
            onClick={onSend}
          >
            {topic?.members ? t('team.startChannel') : topic ? t('team.startTopic') : t('team.send')}
          </button>
        </div>
      </div>
    </section>
  )
}

/** Add a member to a channel this board started: one of the roster, not a member yet (#355). */
function AddMember({
  peers,
  disabled,
  onAdd,
}: {
  peers: TeamRosterPeer[]
  disabled: boolean
  onAdd(peer: string): void
}) {
  const t = useT()
  const [pick, setPick] = useState(peers[0]?.peer ?? '')
  // The one on show: after an add the list is shorter, and a pick no longer in it is not posted.
  const value = peers.some(p => p.peer === pick) ? pick : (peers[0]?.peer ?? '')
  return (
    <div className="team-switch-row team-add">
      <select
        value={value}
        aria-label={t('team.addMember')}
        disabled={disabled}
        onChange={e => setPick(e.target.value)}
      >
        {peers.map(p => (
          <option key={p.peer} value={p.peer}>
            {p.name}
          </option>
        ))}
      </select>
      <button type="button" className="mini" disabled={disabled || !value} onClick={() => onAdd(value)}>
        {t('team.addMember')}
      </button>
    </div>
  )
}
