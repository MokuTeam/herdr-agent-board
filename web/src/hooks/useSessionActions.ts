// What the board does to a session through the server: move its card, go to it in herdr, put it
// to sleep, dismiss its question. Each says how it went in a toast.
import { useMemo } from 'react'
import type { Item } from '../../../src/core/types.ts'
import { ApiError, api, errorText, type Reply } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { categoryInfo, type DropTarget } from '../models/board-view.ts'
import { inTurn } from '../models/card.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'

export type ActResult = Reply & ({ ok: true } | { ok: false; error: string })

export interface SessionActions {
  /** POST /api/session/<key>/<action>; refused here first when the board cannot do it now. */
  act(key: string, action: string, body?: Record<string, unknown>): Promise<ActResult>
  /**
   * Move a card to another lane and/or column: on screen at once, then on the server. A column is
   * a pin that holds until the session works again; dragged while it works, the card stays under
   * "Working" and moves when that turn is over. Its own column (`auto`) takes the pin off.
   */
  moveCard(key: string, to: DropTarget): Promise<void>
  focusSession(key: string): Promise<void>
  /** Claude exits through herdr-wake; the pane stays as 💤 and wakes on a message or "Wake". */
  sleepSession(key: string): Promise<void>
  /** A question that does not need an answer: off the "Needs me" column until the next one. */
  dismissAsk(key: string): Promise<void>
}

// What goes through herdr also needs fresh herdr data, or it would act on a session that may have moved on.
const HERDR_ACTIONS = ['focus', 'wake', 'sleep', 'message', 'answer', 'permit']

export function useSessionActions(): SessionActions {
  const t = useT()
  const board = useBoardContext()
  const latest = useLatest({ board, t })
  const { dispatch, toast } = board

  return useMemo(() => {
    const itemOf = (key: string): Item | undefined => latest.current.board.data?.items.find(i => i.key === key)
    const busy = (key: string, label: string | null) => dispatch({ type: 'busy', key, label })

    async function act(key: string, action: string, body: Record<string, unknown> = {}): Promise<ActResult> {
      const { board, t } = latest.current
      if (!itemOf(key)) return { ok: false, error: t('detail.missing') }
      if (HERDR_ACTIONS.includes(action) ? !board.canMutate : !board.canEdit)
        return { ok: false, error: t(board.canEdit ? 'mobile.readOnly' : 'live.off') }
      try {
        const reply = await api.post(`/api/session/${encodeURIComponent(key)}/${action}`, body)
        return { ...reply, ok: true }
      } catch (err) {
        return { ...(err instanceof ApiError ? err.reply : {}), ok: false, error: errorText(err, latest.current.t) }
      }
    }

    async function moveCard(key: string, { cat, column }: DropTarget): Promise<void> {
      const it = itemOf(key)
      if (!it || (!cat && !column)) return
      const turn = inTurn(it)
      dispatch({ type: 'move', key, cat, column: column && !turn ? column : null, at: Date.now() })
      const r = await act(key, 'card', { ...(cat ? { category: cat } : {}), ...(column ? { column } : {}) })
      if (!r.ok) {
        dispatch({ type: 'unmove', key })
        return toast(r.error, true)
      }
      const { board, t } = latest.current
      const q = (s: string) => t('q', { s })
      const parts = cat ? [categoryInfo(board.data?.categories ?? [], cat).title] : []
      if (column) {
        const title = t(`col.${column}`)
        parts.push(t(column === it.auto ? 'move.auto' : turn ? 'move.afterTurn' : 'q', { col: q(title), s: title }))
      }
      toast(t('moved', { name: it.name, where: parts.join(', ') }))
    }

    async function focusSession(key: string): Promise<void> {
      const it = itemOf(key)
      if (!it) return
      if (it.sleeping) busy(key, latest.current.t('busy.waking'))
      const r = await act(key, 'focus')
      busy(key, null)
      toast(r.ok ? latest.current.t('toast.focused', { name: it.name }) : r.error, !r.ok)
    }

    async function sleepSession(key: string): Promise<void> {
      const it = itemOf(key)
      if (!it || it.sleeping) return
      busy(key, latest.current.t('busy.sleeping'))
      const r = await act(key, 'sleep')
      busy(key, null)
      toast(r.ok ? latest.current.t('asleep', { name: it.name }) : r.error, !r.ok)
    }

    async function dismissAsk(key: string): Promise<void> {
      const it = itemOf(key)
      const r = await act(key, 'card', { dismiss: true })
      const { t } = latest.current
      const name = it?.name ?? t('session')
      const done =
        it?.attention === 'later'
          ? t('toast.unparked', { name, col: t('q', { s: t('col.me') }) })
          : t('toast.dismissed', { name })
      toast(r.ok ? done : r.error, !r.ok)
    }

    return { act, moveCard, focusSession, sleepSession, dismissAsk }
  }, [latest, dispatch, toast])
}
