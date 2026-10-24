// The session's numbers beside its message box: how full its context is, the model it runs, and
// the effort it thinks with. The two are changed the way Claude asks for them: /model and /effort
// typed into its prompt, so the change is for this session and takes effect on its next turn.
import { useState } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import { useSessionActions } from '../../hooks/useSessionActions.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { useBoardContext } from '../../state/BoardProvider.tsx'

const MODELS = ['default', 'opus', 'sonnet', 'haiku', 'fable']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export function SessionMeter({ item, disabled = false }: { item: Item; disabled?: boolean }) {
  const t = useT()
  const actions = useSessionActions()
  const { toast } = useBoardContext()
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const context =
    item.contextPct != null
      ? `${Math.round(item.contextPct)}%`
      : item.context
        ? `${Math.round(item.context / 1000)}k`
        : ''
  async function change(kind: 'model' | 'effort', value: string) {
    if (!value) return
    const command = `${kind} ${value}`
    const r = await actions.act(item.key, 'message', { text: `/${command}` })
    toast(r.ok ? t('meter.sent', { command }) : r.error, !r.ok)
  }
  return (
    <div className="session-meter">
      <span className="meter-ctx" title={t('meter.contextHint')}>
        {context ? t('meter.ctx', { value: context }) : t('meter.ctxNone')}
      </span>
      <label className="meter-pick" title={t('meter.modelHint')}>
        <span>{t('meter.model')}</span>
        <select
          value={model}
          disabled={disabled}
          onChange={e => {
            setModel(e.target.value)
            void change('model', e.target.value)
          }}
        >
          <option value="">{item.model || t('meter.unknown')}</option>
          {MODELS.map(id => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      <label className="meter-pick" title={t('meter.effortHint')}>
        <span>{t('meter.effort')}</span>
        <select
          value={effort}
          disabled={disabled}
          onChange={e => {
            setEffort(e.target.value)
            void change('effort', e.target.value)
          }}
        >
          <option value="">{t('meter.unknown')}</option>
          {EFFORTS.map(id => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
