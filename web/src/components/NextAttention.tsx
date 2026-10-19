// "Next · 2": opens the next card on show with a question or a result not viewed yet.
import { useBoardView } from '../hooks/useBoardView.ts'
import { useNextAttention } from '../hooks/useNextAttention.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { attentionCount } from '../models/toolbar.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { ArrowIcon } from './icons.tsx'

export function NextAttention() {
  const t = useT()
  const { data, ui } = useBoardContext()
  const { visible, categoryOf } = useBoardView()
  const openNext = useNextAttention()
  // Before the first board: the button as the page starts.
  if (!data)
    return (
      <button
        type="button"
        className="pill-toggle"
        id="next-attention"
        title={t('attention.nextHint')}
        onClick={openNext}
      >
        <ArrowIcon />
        <span>{t('attention.next')}</span>
      </button>
    )
  const n = attentionCount(visible, ui.filter, categoryOf, ui.viewed)
  return (
    <button
      type="button"
      className="pill-toggle"
      id="next-attention"
      title={t(n ? 'attention.nextHint' : 'attention.none')}
      aria-label={n ? t('attention.nextCount', { n }) : t('attention.none')}
      disabled={!n}
      onClick={openNext}
    >
      <ArrowIcon />
      <span>{n ? `${t('attention.next')} · ${n}` : t('attention.noneShort')}</span>
    </button>
  )
}
