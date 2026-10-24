// The session's numbers under its message box: how full its context is, the model it runs and the
// effort it thinks with. Read only: the same facts the card's sheet shows, for reading while you
// type. Changing them is Claude's own /model and /effort for now.
import type { Item } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'

export function SessionMeter({ item }: { item: Item }) {
  const t = useT()
  const context =
    item.contextPct != null
      ? `${Math.round(item.contextPct)}%`
      : item.context
        ? `${Math.round(item.context / 1000)}k`
        : ''
  return (
    <div className="session-meter">
      <span className="meter-ctx" title={t('meter.contextHint')}>
        {context ? t('meter.ctx', { value: context }) : t('meter.ctxNone')}
      </span>
      <span className="meter-fact" title={item.model ?? undefined}>
        {t('meter.model')}: {item.model || t('meter.unknown')}
      </span>
      <span className="meter-fact" title={t('meter.effortHint')}>
        {t('meter.effort')}: {item.effort || t('meter.unknown')}
      </span>
    </div>
  )
}
