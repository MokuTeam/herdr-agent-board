// What teammates can address on this board (#832), in People and agents: exposure follows the
// lanes shared in the switches above, so this only shows it. Each session a teammate reaches, by its
// handle (`@Me.handle`), its lane, and who reaches it now. Nothing to turn on here: a session leaves
// the list when it leaves the lane, is archived, or the lane is no longer shared.
import { useT } from '../../i18n/I18nProvider.tsx'
import type { AgentsView, TeamView } from '../../models/team.ts'
import { mentionWord } from '../../models/team.ts'

export function TeamExposed({ view, agents }: { view: TeamView; agents: AgentsView }) {
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
        </div>
      ))}
    </details>
  )
}
