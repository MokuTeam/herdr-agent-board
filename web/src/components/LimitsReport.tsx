// The usage popover's text: what is used, where the reading comes from and how old it is.
import { useT } from '../i18n/I18nProvider.tsx'
import { type LimitInfo, windowLabel } from '../models/limits.ts'

const SOURCE_KEYS = { usagebar: 'limits.hintUsagebar', statusline: 'limits.hint', unknown: 'limits.unknownSource' }

export function LimitsReport({ lim }: { lim: LimitInfo }) {
  const t = useT()
  if (!lim.windows.length) return <p>{t('limits.unavailable')}</p>
  const time = lim.observedAt
    ? new Date(lim.observedAt).toLocaleString(t.lang, { dateStyle: 'medium', timeStyle: 'short' })
    : t('limits.unknownTime')
  const used = lim.windows.map(w => `${windowLabel(w, t)}: ${Math.round(w.usedPercentage)}%`).join(' · ')
  return (
    <>
      <p>
        <b>{t('limits.used')}</b> {used}
      </p>
      <p>{t(SOURCE_KEYS[lim.source], { time })}</p>
      <p className={lim.stale ? 'limits-warning' : ''}>
        {t(lim.stale ? 'limits.stale' : 'limits.localReport', { time })}
      </p>
    </>
  )
}
