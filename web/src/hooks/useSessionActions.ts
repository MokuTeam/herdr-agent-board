// What the board does to a session through the server: move its card, go to it in herdr, wake it,
// put it to sleep, restart it, dismiss its question, call in MokuPilot with a fork of it. Each says
// how it went in a toast.
import { useMemo } from 'react'
import type { Item, Translator } from '../../../src/core/types.ts'
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
  /** "Wake": the sleeping session comes back in its pane. */
  wakeSession(key: string): Promise<void>
  /** Claude exits through herdr-wake; the pane stays as 💤 and wakes on a message or "Wake". */
  sleepSession(key: string): Promise<void>
  /**
   * Claude exits and resumes in its pane once the session is free, through herdr-wake: MCP
   * servers, settings, hooks and skills load anew, the conversation stays. The scheduler does it
   * (a schedule entry of kind 'restart'), so the card says how it goes and a board restart in the
   * middle loses nothing.
   */
  restartSession(key: string): Promise<void>
  /** A question that does not need an answer: off the "Needs me" column until the next one. */
  dismissAsk(key: string): Promise<void>
  /** Kept in sight (first in its column, whole), or back among the others; the board shows it once the server has it. */
  setFavorite(key: string, on: boolean): Promise<void>
  /** A MokuPilot call whose agent is a fork of the session (services/mokupilot.ts): the session goes on as it was. */
  callMokuPilot(key: string): Promise<void>
}

export interface CallDeps {
  t: Translator
  itemOf(key: string): Item | undefined
  act(key: string, action: string): Promise<ActResult>
  toast(text: string, error?: boolean): void
}

/** A MokuPilot call whose agent is a fork of the session (services/mokupilot.ts): the session goes on as it was. */
export async function callMokuPilot(key: string, { t, itemOf, act, toast }: CallDeps): Promise<void> {
  const it = itemOf(key)
  if (!it) return
  const r = await act(key, 'mokupilot')
  toast(r.ok ? t('mokupilot.started', { name: it.name }) : r.error, !r.ok)
}

/**
 * Claude exits and resumes in its pane once the session is free (a schedule entry the server
 * keeps): asked for, or on its way already, or why not. Asleep, waking it is the restart.
 */
export async function restartSession(key: string, { t, itemOf, act, toast }: CallDeps): Promise<void> {
  const it = itemOf(key)
  if (!it || it.sleeping) return
  const r = await act(key, 'restart')
  toast(r.ok ? t(r.again ? 'restart.again' : 'restart.asked', { name: it.name }) : r.error, !r.ok)
}

// What goes through herdr also needs fresh herdr data, or it would act on a session that may have moved on.
const HERDR_ACTIONS = [
  'focus',
  'wake',
  'sleep',
  'restart',
  'archive',
  'message',
  'answer',
  'permit',
  'workspace',
  'fork',
]

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

    async function wakeSession(key: string): Promise<void> {
      busy(key, latest.current.t('busy.waking'))
      const r = await act(key, 'wake')
      busy(key, null)
      toast(r.ok ? latest.current.t('toast.woke') : r.error, !r.ok)
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

    async function setFavorite(key: string, on: boolean): Promise<void> {
      const r = await act(key, 'card', { favorite: on })
      if (!r.ok) toast(r.error, true)
    }

    return {
      act,
      moveCard,
      focusSession,
      wakeSession,
      sleepSession,
      restartSession: key => restartSession(key, { t: latest.current.t, itemOf, act, toast }),
      dismissAsk,
      setFavorite,
      callMokuPilot: key => callMokuPilot(key, { t: latest.current.t, itemOf, act, toast }),
    }
  }, [latest, dispatch, toast])
}
