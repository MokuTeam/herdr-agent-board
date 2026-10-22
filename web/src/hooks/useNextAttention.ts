// Opens the next card on show that needs the user (the toolbar's "Next" and the N key).
import { useCallback } from 'react'
import { useT } from '../i18n/I18nProvider.tsx'
import { nextAttention } from '../models/attention.ts'
import { laneShown } from '../models/lane-picks.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useBoardView } from './useBoardView.ts'

export function useNextAttention(): () => void {
  const t = useT()
  const { ui, dispatch, toast } = useBoardContext()
  const { visible, categoryOf } = useBoardView()
  const { filter, open, viewed } = ui
  return useCallback(() => {
    const shown = visible.filter(it => !it.launchOnly && laneShown(filter, categoryOf(it)))
    const key = nextAttention(shown, open, viewed)
    if (key) dispatch({ type: 'open', key })
    else toast(t('attention.none'))
  }, [t, visible, categoryOf, filter, open, viewed, dispatch, toast])
}
