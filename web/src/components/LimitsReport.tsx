// The usage popover's text: what is used, where the reading comes from and how old it is.
import { useT } from '../i18n/I18nProvider.tsx'
import { forecast, type LimitInfo, windowLabel } from '../models/limits.ts'

const SOURCE_KEYS = { usagebar: 'limits.hintUsagebar', statusline: 'limits.hint', unknown: 'limits.unknownSource' }

export function LimitsReport({ lim }: { lim: LimitInfo }) {
  const t = useT()
  if (!lim.windows.length) return <p>{t('limits.unavailable')}</p>
  const time = lim.observedAt
    ? new Date(lim.observedAt).toLocaleString(t.lang, { dateStyle: 'medium', timeStyle: 'short' })
    : t('limits.unknownTime')
  const used = lim.windows.map(w => `${windowLabel(w, t)}: ${Math.round(w.usedPercentage)}%`).join(' · ')
  const at = (ms: number) =>
    new Date(ms).toLocaleString(t.lang, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  // An old reading predicts nothing: the pace may have changed or the window reset since.
  const ahead = lim.stale
    ? []
    : lim.windows.flatMap(w => {
        const f = forecast(w, lim.observedAt)
        if (!f) return []
        const window = windowLabel(w, t)
        return f.kind === 'out'
          ? [{ out: true, text: t('limits.forecastOut', { window, at: at(f.at), reset: at(f.resetsAt) }) }]
          : [{ out: false, text: t('limits.forecastLasts', { window, reset: at(f.resetsAt) }) }]
      })
  return (
    <>
      <p>
        <b>{t('limits.used')}</b> {used}
      </p>
      {ahead.map(f => (
        <p key={f.text} className={f.out ? 'limits-warning' : ''}>
          {f.text}
        </p>
      ))}
      <p>{t(SOURCE_KEYS[lim.source], { time })}</p>
      <p className={lim.stale ? 'limits-warning' : ''}>
        {t(lim.stale ? 'limits.stale' : 'limits.localReport', { time })}
      </p>
    </>
  )
}
