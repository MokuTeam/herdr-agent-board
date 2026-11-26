// The owner's direct addressing policy and the resulting directory (#832, #867).
import { useState } from 'react'
import { MAX_CODE } from '../../../../src/core/team-wire.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { AgentsChange, AgentsView, TeamView } from '../../models/team.ts'
import { mentionWord } from '../../models/team.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'

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
  const { data } = useBoardContext()
  const [key, setKey] = useState('')
  const items = data?.items ?? []
  const item = items.find(i => i.key === key)
  const exposed = agents.exposed ?? []
  const me = mentionWord(view.me.name ?? '')
  const nameOf = (peer: string): string => view.roster.find(p => p.peer === peer)?.name ?? peer.slice(0, 8)
  const laneOf = (id: string): string => agents.lanes.find(l => l.id === id)?.title ?? id
  return (
    <details className="team-exposed" data-exposed>
      <summary>
        <h3>{t('team.exposed')}</h3>
      </summary>
      <p className="hint">{t('team.exposedAbout')}</p>
      <label className="team-exposure-control">
        <span>{t('team.exposureMode')}</span>
        <select
          value={agents.mastersOnly ? 'masters' : 'all'}
          disabled={disabled}
          onChange={e => onAgents({ mastersOnly: e.currentTarget.value === 'masters' })}
        >
          <option value="all">{t('team.exposureAll')}</option>
          <option value="masters">{t('team.exposureMasters')}</option>
        </select>
      </label>
      <div className="team-expose">
        <label className="team-exposure-control">
          <span>{t('team.masterCard')}</span>
          <select value={item?.key ?? ''} disabled={disabled} onChange={e => setKey(e.currentTarget.value)}>
            <option value="">{t('team.pickMasterCard')}</option>
            {items.map(i => (
              <option key={i.key} value={i.key}>
                {i.name || i.key} · {laneOf(i.category)}
                {i.teamMaster ? ` · ${t('card.teamMaster')}` : ''}
              </option>
            ))}
          </select>
        </label>
        {item && (
          <button
            className="mini"
            type="button"
            disabled={disabled}
            onClick={() => onAgents({ master: { key: item.key, on: !item.teamMaster } })}
          >
            {t(item.teamMaster ? 'team.unmarkMaster' : 'team.markMaster')}
          </button>
        )}
      </div>
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
