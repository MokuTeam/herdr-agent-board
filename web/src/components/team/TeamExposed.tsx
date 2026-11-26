// What teammates can address on this board (#832), in People and agents: exposure follows the
// lanes shared in the switches above. Owners can publish an alias alongside the canonical handle. Each session a teammate reaches, by its
// handle (`@Me.handle`), its lane, and who reaches it now. Nothing to turn on here: a session leaves
// the list when it leaves the lane, is archived, or the lane is no longer shared.
import { MAX_CODE } from '../../../../src/core/team-wire.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { AgentsChange, AgentsView, TeamView } from '../../models/team.ts'
import { mentionWord } from '../../models/team.ts'

export function TeamExposed({
  view,
  agents,
  disabled,
  onAgents,
}: {
  view: TeamView
  agents: AgentsView
  disabled: boolean
  onAgents(change: AgentsChange): void
}) {
  const t = useT()
  const exposed = agents.exposed ?? []
  if (!exposed.length) return null
  const me = mentionWord(view.me.name ?? '')
  const nameOf = (peer: string): string => view.roster.find(p => p.peer === peer)?.name ?? peer.slice(0, 8)
  const laneOf = (id: string): string => agents.lanes.find(l => l.id === id)?.title ?? id
  return (
    <details className="team-exposed" data-exposed>
      <summary>
        <h3>{t('team.exposed')}</h3>
      </summary>
      <p className="hint">{t('team.exposedAbout')}</p>
      {exposed.map(e => (
        <div key={e.code} className="team-expose" data-expose={e.code}>
          <div className="team-switch-row">
            <span className="team-expose-code">{me ? `@${me}.${e.code}` : `@${e.code}`}</span>
            <span className="todo-meta">{laneOf(e.lane)}</span>
          </div>
          <span className="todo-meta">{e.session.name || e.session.key.slice(0, 8)}</span>
          <span className="todo-meta">{t('team.exposeReaches', { names: e.reaches.map(nameOf).join(', ') })}</span>
          <form
            key={e.alias ?? ''}
            className="team-switch-row"
            onSubmit={event => {
              event.preventDefault()
              const name = String(new FormData(event.currentTarget).get('alias') ?? '')
              onAgents({ publishAlias: { key: e.session.key, name: name || null } })
            }}
          >
            <label>
              {t('team.publishAlias')}
              <input
                name="alias"
                defaultValue={e.alias ?? ''}
                pattern={String.raw`[A-Za-z0-9][A-Za-z0-9\-]*`}
                maxLength={MAX_CODE}
                disabled={disabled}
              />
            </label>
            <button type="submit" className="mini" disabled={disabled}>
              {t('team.saveAlias')}
            </button>
          </form>
        </div>
      ))}
    </details>
  )
}
