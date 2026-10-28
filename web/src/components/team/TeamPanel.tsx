// The team panel (#231), out of Settings → Team… on the local board, while the payload carries
// `teamRev`: where the connection to the team's hub stands, who is in the team (online or not,
// their key's fingerprint), a person whose key changed with Trust, and the messages with the one
// picked: each of yours with how far it got (queued at the hub, delivered, received, expired, refused by the hub), what
// came in from a changed key marked held. Under the thread a box to ask them a question. The view
// is hooks/useTeam.ts's; the board sends only its revision.
import { useState } from 'react'
import { useTeam } from '../../hooks/useTeam.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { seenLine, stateLine, type TeamRosterPeer, type TeamView, type ThreadMessage } from '../../models/team.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { Panel } from '../panel/Panel.tsx'

export interface TeamPanelProps {
  open: boolean
  onClose(): void
}

export function TeamPanel({ open, onClose }: TeamPanelProps) {
  const t = useT()
  const { canEdit } = useBoardContext()
  const team = useTeam(open)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const send = async () => {
    if (!team.peer || !draft.trim()) return
    setSending(true)
    if (await team.send(team.peer, draft)) setDraft('')
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
        peer={team.peer}
        thread={team.thread}
        draft={draft}
        disabled={!canEdit || sending}
        onSelect={team.select}
        onTrust={peer => void team.trust(peer)}
        onDraft={setDraft}
        onSend={() => void send()}
      />
    </Panel>
  )
}

export interface TeamBodyProps {
  /** GET /api/team's answer; null while the board is asked. */
  view: TeamView | null
  peer: string | null
  thread: ThreadMessage[]
  draft: string
  disabled: boolean
  onSelect(peer: string | null): void
  onTrust(peer: string): void
  onDraft(text: string): void
  onSend(): void
}

/** The connection line, the roster, and the thread with the person picked. */
export function TeamBody({ view, peer, thread, draft, disabled, onSelect, onTrust, onDraft, onSend }: TeamBodyProps) {
  const t = useT()
  const { now } = useBoardContext()
  if (!view) return <div className="sheet-body team-body" />
  const picked = view.roster.find(p => p.peer === peer)
  return (
    <div className="sheet-body team-body">
      <section className="team-me">
        <p className={classNames('team-state', view.state)} data-state={view.state}>
          {stateLine(view, t)}
        </p>
        <p className="sheet-meta">
          {view.me.name ? t('team.me', { name: view.me.name }) : t('team.meUnnamed')}
          {view.me.fingerprint && ` · ${t('team.fingerprint', { fingerprint: view.me.fingerprint })}`}
        </p>
      </section>
      <section className="team-roster">
        <h3>{t('team.roster')}</h3>
        {!view.roster.length && <p className="hint">{t('team.rosterEmpty')}</p>}
        {view.roster.map((p: TeamRosterPeer) => (
          <div
            key={p.peer}
            className={classNames('team-peer', p.peer === peer && 'on', p.pin === 'changed' && 'changed')}
          >
            <button type="button" className="team-pick" aria-pressed={p.peer === peer} onClick={() => onSelect(p.peer)}>
              <span className={classNames('dot', 'team-dot', p.online ? 'on' : 'idle')} aria-hidden="true" />
              <span className="team-name">{p.name}</span>
              <span className="todo-meta">{seenLine(p, now, t)}</span>
            </button>
            <span className="todo-meta team-fp">{t('team.fingerprint', { fingerprint: p.fingerprint })}</span>
            {p.pin === 'changed' && (
              <div className="team-changed">
                <p>{t('team.changed', { name: p.name })}</p>
                <button type="button" className="mini" disabled={disabled} onClick={() => onTrust(p.peer)}>
                  {t('team.trust')}
                </button>
              </div>
            )}
          </div>
        ))}
      </section>
      <section className="team-thread">
        {!picked && <p className="hint">{t('team.pick')}</p>}
        {picked && (
          <>
            <h3>{t('team.thread', { name: picked.name })}</h3>
            {!thread.length && <p className="hint">{t('team.threadEmpty')}</p>}
            {thread.map(m => (
              <div key={`${m.dir}-${m.id}`} className={classNames('todo-row', 'team-msg', m.dir, m.held && 'held')}>
                <p className="todo-text">{m.text}</p>
                <div className="todo-foot">
                  <span className="todo-meta">
                    {m.dir === 'in' ? t('team.in') : t('team.out')}
                    {m.dir === 'out' && m.state && ` · ${t(`team.delivery.${m.state}`, { code: m.code ?? '' })}`}
                    {m.held && ` · ${t('team.held')}`}
                  </span>
                </div>
              </div>
            ))}
            <div className="team-compose">
              <textarea
                value={draft}
                rows={3}
                placeholder={t('team.placeholder', { name: picked.name })}
                aria-label={t('team.placeholder', { name: picked.name })}
                onChange={e => onDraft(e.target.value)}
              />
              <button
                type="button"
                className="mini"
                disabled={disabled || !draft.trim()}
                title={t('team.sendHint')}
                onClick={onSend}
              >
                {t('team.send')}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
