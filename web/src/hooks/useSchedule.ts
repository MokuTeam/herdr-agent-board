// The reminders' buttons for the whole page (models/schedule-desk.ts): one desk, so the schedule
// panel and the session's sheet share the button that asks "Cancel?". A cancelled entry's rows,
// in both, fold away with a spring (collapse) while POST /api/schedule removes it.
import { useState } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { api, errorText } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { type ScheduleDesk, type ScheduleResult, scheduleDesk } from '../models/schedule-desk.ts'
import { reducedMotion, Spring } from '../models/spring.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { Store, useStore } from '../state/store.ts'
import { useLatest } from './useLatest.ts'

/** A row folds away: its height and opacity spring to nothing. */
export function collapse(el: HTMLElement): Promise<void> {
  if (reducedMotion.matches || !el.isConnected) return Promise.resolve()
  const h = el.offsetHeight
  const cs = getComputedStyle(el)
  const pt = Number.parseFloat(cs.paddingTop)
  const pb = Number.parseFloat(cs.paddingBottom)
  el.style.overflow = 'hidden'
  return new Promise(resolve => {
    const s = new Spring({
      value: 1,
      damping: 1,
      response: 0.32,
      precision: 0.004,
      onUpdate: v => {
        el.style.height = `${h * v}px`
        el.style.paddingTop = `${pt * v}px`
        el.style.paddingBottom = `${pb * v}px`
        el.style.opacity = String(v * v)
      },
      onRest: () => resolve(),
    })
    s.to(0)
  })
}

/** POST /api/schedule (X-Board); a refusal or no answer says why, as the board words it. */
export async function postSchedule(body: Record<string, unknown>, t: Translator): Promise<ScheduleResult> {
  try {
    await api.post('/api/schedule', body)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errorText(err, t) }
  }
}

/** The entry's rows: in the schedule panel and in the session's sheet. */
const rowsOf = (id: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(
    `.sched-entry[data-id="${CSS.escape(id)}"], .sched-mini[data-id="${CSS.escape(id)}"]`,
  ),
]

export interface Schedule {
  /** The entry whose cancel button asks "Cancel?". */
  armed: string | null
  /** Rows on their way out: the schedule panel keeps what it shows until they are gone. */
  collapsing: number
  cancel(id: string): void
  mode(id: string): void
  disarm(): void
}

export function useSchedule(): Schedule {
  const t = useT()
  const board = useBoardContext()
  const latest = useLatest({ t, board })
  const [version] = useState(() => new Store(0))
  const [desk] = useState<ScheduleDesk>(() =>
    scheduleDesk<HTMLElement>({
      t: () => latest.current.t,
      canEdit: () => latest.current.board.canEdit,
      entries: () => latest.current.board.data?.schedules ?? [],
      post: body => postSchedule(body, latest.current.t),
      rows: rowsOf,
      collapse,
      restore: row => row.removeAttribute('style'),
      edit: edit => latest.current.board.dispatch({ type: 'edit', edit }),
      toast: (text, error) => latest.current.board.toast(text, error),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: timer => window.clearTimeout(timer),
      changed: () => version.set(version.get() + 1),
    }),
  )
  useStore(version)
  const [controls] = useState(() => ({
    cancel: (id: string) => void desk.cancel(id),
    mode: (id: string) => void desk.mode(id),
    disarm: () => desk.disarm(),
  }))
  return { armed: desk.armed(), collapsing: desk.collapsing(), ...controls }
}
