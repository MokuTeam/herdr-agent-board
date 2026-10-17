// Another session, from a link to it (a card's "started by", the sheet's sessions, a name in the
// thread): its sheet, and its card brought into sight with a glint (the old page's goToSession).
import { useCallback } from 'react'
import { useT } from '../i18n/I18nProvider.tsx'
import { reducedMotion } from '../models/spring.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'

/** The board's card of `key`. */
function cardOf(key: string): HTMLElement | null {
  const cards = document.getElementById('board')?.querySelectorAll<HTMLElement>('.card[data-key]') ?? []
  return [...cards].find(card => card.dataset.key === key) ?? null
}

export function useGoToSession(): (key: string) => void {
  const t = useT()
  const board = useBoardContext()
  const latest = useLatest({ board, t })
  return useCallback(
    (key: string) => {
      const { board, t } = latest.current
      if (!board.data?.items.some(i => i.key === key)) return board.toast(t('rel.notOnBoard'), true)
      board.dispatch({ type: 'open', key })
      const card = cardOf(key)
      if (!card?.offsetParent) return
      card.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' })
      if (!reducedMotion.matches)
        card.animate(
          [
            { boxShadow: 'var(--shadow-card), 0 0 0 4px color-mix(in srgb, var(--accent) 45%, transparent)' },
            { boxShadow: 'var(--shadow-card), 0 0 0 2px var(--accent)' },
          ],
          { duration: 900, easing: 'ease-out' },
        )
    },
    [latest],
  )
}
