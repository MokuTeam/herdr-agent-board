// "New session" from the toolbar, a lane's +, Shift+N (and later the sheet and the menus). New
// sessions go through herdr: without fresh data the board says why instead.
import { useCallback } from 'react'
import type { NewSessionContext } from '../components/Lane.tsx'
import { useT } from '../i18n/I18nProvider.tsx'
import { useBoardContext } from '../state/BoardProvider.tsx'

export type OpenLaunch = (ctx: NewSessionContext, from: HTMLElement | null) => void

/** `open`: the launch window, which grows out of `from` (Task 27). */
export function useNewSession(open?: OpenLaunch): OpenLaunch {
  const t = useT()
  const { canMutate, canEdit, toast } = useBoardContext()
  return useCallback(
    (ctx, from) => {
      if (!canMutate) return toast(t(canEdit ? 'mobile.readOnly' : 'live.off'), true)
      open?.(ctx, from)
    },
    [t, canMutate, canEdit, toast, open],
  )
}

/** The context of a session started from the toolbar or Shift+N: the lane on show. */
export const laneContext = (filter: string): NewSessionContext => (filter !== 'all' ? { category: filter } : {})
