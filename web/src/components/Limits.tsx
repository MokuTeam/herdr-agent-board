// Claude's usage windows in a small pill by the live dot; a click opens the popover (LimitsPop.tsx).
import type { RefObject } from 'react'
import { useT } from '../i18n/I18nProvider.tsx'
import { heat, limitInfo, windowLabel } from '../models/limits.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'

export function Limits({ anchor }: { anchor: RefObject<HTMLButtonElement | null> }) {
  const t = useT()
  const { data, connected, ui, dispatch } = useBoardContext()
  const lim = limitInfo(data?.limits, { connected })
  const stale = lim.windows.length > 0 && lim.stale
  return (
    <button
      type="button"
      ref={anchor}
      className={stale ? 'limits stale' : 'limits'}
      id="limits"
      aria-haspopup="dialog"
      aria-expanded={ui.limitsOpen}
      aria-controls="limits-pop"
      aria-label={t('limits.title')}
      title={t('limits.open')}
      onClick={() => dispatch({ type: 'limits', open: !ui.limitsOpen })}
    >
      {lim.windows.length
        ? lim.windows.map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two windows may share a length; the list is redrawn whole per reading
            <span key={i} className={heat(w.usedPercentage) || undefined}>
              {windowLabel(w, t)} <b>{Math.round(w.usedPercentage)}%</b>
            </span>
          ))
        : t('limits.unknown')}
    </button>
  )
}
