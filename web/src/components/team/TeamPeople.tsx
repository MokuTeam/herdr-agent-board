// People and agents (#370): what the Team panel's list kept before it became a list of
// conversations. This board (its connection, name and key), the owner's passkeys (#224), each
// person (online or not, their key's fingerprint, Trust when it changed, their drafts, a way into
// their conversation), the team chat's mute and the owner's agent switches (#216, #355, #360). The
// passkeys, the mute and the switches are on this computer's board only. A new member's welcome
// (#355) lives here too; the list draws it on top while it waits.
import { useState } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  type AgentsChange,
  type AgentsView,
  allLanesOn,
  channelsOf,
  pairThread,
  seenLine,
  stateLine,
  type TeamRosterPeer,
  type TeamView,
  type ThreadView,
  type Welcome,
} from '../../models/team.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { Switch } from './Switch.tsx'
import { TeamPasskeys } from './TeamPasskeys.tsx'

export interface TeamPeopleProps {
  view: TeamView
  threads: ThreadView[]
  agents: AgentsView | null
  pending: string[]
  disabled: boolean
  onBack(): void
  onSelect(key: string): void
  onTrust(peer: string): void
  onAgents(change: AgentsChange): void
}

export function TeamPeople({
  view,
  threads,
  agents,
  pending,
  disabled,
  onBack,
  onSelect,
  onTrust,
  onAgents,
}: TeamPeopleProps) {
  const t = useT()
  const { now } = useBoardContext()
  const chatMuted = agents?.peers.team?.muted === true
  return (
    <section className="team-people" data-people-view>
      <header className="team-thread-head">
        <div className="team-thread-bar">
          <button
            type="button"
            className="team-icon-button team-back"
            aria-label={t('team.back')}
            title={t('team.back')}
            onClick={onBack}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
          <div className="team-thread-id">
            <h3 className="team-thread-title">{t('team.peopleOpen')}</h3>
          </div>
        </div>
      </header>
      <div className="team-people-body">
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
        <section className="team-roster">
          <h3>{t('team.roster')}</h3>
          {!view.roster.length && <p className="hint">{t('team.rosterEmpty')}</p>}
          {view.roster.map((p: TeamRosterPeer) => (
            <div key={p.peer} className={classNames('team-card', p.pin === 'changed' && 'changed')} data-peer={p.peer}>
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
                <button type="button" className="mini team-open" onClick={() => onSelect(pairThread(p.peer))}>
                  {t('team.general')}
                </button>
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
            </div>
          ))}
        </section>
        {agents && (
          <section className="team-chat-mute">
            <div className="team-switch-row">
              <span>
                {t('team.chat')} · {t('team.notifications')}
              </span>
              <Switch
                name="mute-chat"
                on={!chatMuted}
                label={chatMuted ? t('team.unmuteChat') : t('team.muteChat')}
                disabled={disabled}
                onFlip={on => onAgents({ peer: 'team', muted: !on })}
              />
            </div>
          </section>
        )}
        {agents && (
          <AgentSwitches
            view={view}
            agents={agents}
            channels={channelsOf(threads)}
            disabled={disabled}
            onAgents={onAgents}
          />
        )}
      </div>
    </section>
  )
}

/**
 * The owner's agent switches (#216): everything at once, the listener, and for the team chat, each
 * channel (#355) and each person: agents on, the lanes shared (or all of them, #386), and the loop
 * pause (#360). Agents turned on for an assistant's bridge that shares no lane yet share every lane
 * with it: the owner's default for an assistant (#386).
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
    { scope: 'team', name: t('team.chat'), assistant: false },
    ...channels.map(c => ({ scope: c.key, name: c.title ?? t('team.general'), assistant: false })),
    ...view.roster.map(p => ({ scope: p.peer, name: p.name, assistant: p.assistant === true })),
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
      {scopes.map(({ scope, name, assistant }) => {
        const p = agents.peers[scope] ?? { on: false, lanes: [] }
        const all = allLanesOn(p)
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
                onFlip={on =>
                  onAgents(
                    on && assistant && !all && p.lanes.length === 0
                      ? { peer: scope, on, allLanes: true }
                      : { peer: scope, on },
                  )
                }
              />
            </div>
            {paused > now && (
              <p className="hint">{t('team.paused', { time: new Date(paused).toLocaleTimeString() })}</p>
            )}
            <div className="team-lanes">
              <span className="todo-meta">{t('team.lanes')}</span>
              <button
                type="button"
                className="mini team-lane"
                aria-pressed={all}
                disabled={disabled}
                data-all-lanes={scope}
                onClick={() => onAgents({ peer: scope, allLanes: !all })}
              >
                {t('team.allLanes')}
              </button>
              {agents.lanes.map(l => {
                const shared = p.lanes.includes(l.id)
                return (
                  <button
                    key={l.id}
                    type="button"
                    className="mini team-lane"
                    aria-pressed={all || shared}
                    disabled={disabled || all}
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
 * A new member's one screen (#355): the lanes to open to them (all of them, ticked by default for an
 * assistant's bridge: #386), their agents on, the channels of this board's to add them to. Nothing
 * changes until Done; Later puts it off, their mark stays.
 */
export function WelcomeCard({
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
  const had = allLanesOn(now)
  const [all, setAll] = useState(now ? had : peer.assistant === true)
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
        <button
          type="button"
          className="mini team-lane"
          aria-pressed={all}
          disabled={disabled}
          data-all-lanes={peer.peer}
          onClick={() => setAll(x => !x)}
        >
          {t('team.allLanes')}
        </button>
        {agents.lanes.map(l => (
          <button
            key={l.id}
            type="button"
            className="mini team-lane"
            aria-pressed={all || lanes.includes(l.id)}
            disabled={disabled || all}
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
      <div className="team-welcome-actions">
        <button type="button" className="mini" onClick={onLater}>
          {t('team.later')}
        </button>
        <button
          type="button"
          className="mini"
          data-welcome-done
          disabled={disabled}
          onClick={() =>
            onDone({ peer: peer.peer, on, lanes, ...((all || had) && { allLanes: all }), channels: joins })
          }
        >
          {t('team.done')}
        </button>
      </div>
    </section>
  )
}
