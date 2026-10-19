// The reminders' two buttons, in the schedule panel and in a session's sheet alike, without the DOM
// (web/app.js cancelSchedule, toggleMode, disarm, postSchedule). Cancelling takes two clicks: the
// first arms the button ("Cancel?") for four seconds, the second folds the entry's rows away while
// the server removes it. The delivery switch (on time / when the session is free) shows at once and
// goes back if the server says no. Both reach the board through `edit` until its next board.
// While rows fold away, the panel's and the sheet's reminders keep what they showed when the fold
// began (the old page's render() drew neither while it was `collapsing`): `held`.
import type { ScheduleEntry } from '../../../src/core/schedule-rules.ts'
import type { Translator } from '../../../src/core/types.ts'
import type { BoardEdit } from './board-edits.ts'
import { plain } from './card.ts'

export type ScheduleResult = { ok: true } | { ok: false; error: string }

export interface ScheduleDeskDeps<Row, View> {
  t(): Translator
  /** The board can edit (it is connected). */
  canEdit(): boolean
  /** The entries on the board now (with the page's edits). */
  entries(): ScheduleEntry[]
  /** POST /api/schedule. */
  post(body: Record<string, unknown>): Promise<ScheduleResult>
  /** The entry's rows on the page: in the schedule panel and in the sheet. */
  rows(id: string): Row[]
  /** A row folds away; resolves once it is gone. */
  collapse(row: Row): Promise<void>
  /** A row the server would not let go unfolds again. */
  restore(row: Row): void
  edit(edit: BoardEdit): void
  toast(text: string, error?: boolean): void
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(timer: number): void
  /** What the page shows of the schedule now (the board and its clock), to keep while rows fold away. */
  view(): View
  /** What the buttons show changed: draw again. */
  changed(): void
}

/** What the reminders keep showing while rows fold away: the page as it was, its button asking "Cancel?". */
export interface Held<View> {
  view: View
  armed: string | null
}

export interface ScheduleDesk<View> {
  /** The entry whose cancel button asks "Cancel?". */
  armed(): string | null
  /** While rows are on their way out: what the reminders keep showing until they are gone; else null. */
  held(): Held<View> | null
  cancel(id: string): Promise<void>
  mode(id: string): Promise<void>
  /** The button asking "Cancel?" asks no more (the schedule panel closed). */
  disarm(): void
}

/** How long a cancel button asks "Cancel?". */
export const ARMED_MS = 4000

export function scheduleDesk<Row, View>(deps: ScheduleDeskDeps<Row, View>): ScheduleDesk<View> {
  let armed: { id: string; timer: number } | null = null
  let collapsing = 0
  let held: Held<View> | null = null

  function disarm(redraw = true): void {
    if (!armed) return
    deps.clearTimeout(armed.timer)
    armed = null
    if (redraw) deps.changed()
  }

  async function postSchedule(body: Record<string, unknown>): Promise<ScheduleResult> {
    if (!deps.canEdit()) return { ok: false, error: deps.t()('live.off') }
    return deps.post(body)
  }

  async function cancel(id: string): Promise<void> {
    if (armed?.id !== id) {
      disarm(false)
      armed = { id, timer: deps.setTimeout(() => disarm(), ARMED_MS) }
      return deps.changed()
    }
    // The rows fold away as they are, "Cancel?" and all; a fold already on keeps what it holds.
    const before: Held<View> = held ?? { view: deps.view(), armed: id }
    disarm(false)
    const entry = deps.entries().find(e => e.id === id)
    const rows = deps.rows(id)
    collapsing++
    held = before
    deps.changed()
    let r: ScheduleResult
    try {
      ;[r] = await Promise.all([postSchedule({ op: 'cancel', id }), ...rows.map(row => deps.collapse(row))])
    } finally {
      collapsing--
      if (!collapsing) held = null
    }
    const t = deps.t()
    if (r.ok) {
      // Off the board at once; the live stream confirms it.
      deps.edit({ type: 'cancelled', id })
      deps.toast(t('sched.cancelled', { text: plain(entry?.text ?? '').slice(0, 60) }))
    } else {
      for (const row of rows) deps.restore(row)
      deps.toast(r.error, true)
    }
    deps.changed()
  }

  async function mode(id: string): Promise<void> {
    const entry = deps.entries().find(e => e.id === id)
    if (!entry) return
    const idle = !entry.idle
    // On screen at once; the live stream confirms it.
    deps.edit({ type: 'idle', id, idle })
    const r = await postSchedule({ op: 'mode', id: entry.id, idle })
    const t = deps.t()
    if (!r.ok) {
      deps.edit({ type: 'idle', id, idle: null })
      return deps.toast(r.error, true)
    }
    deps.toast(t('sched.mode.set', { mode: t(idle ? 'sched.mode.idle' : 'sched.mode.onTime') }))
  }

  return { armed: () => armed?.id ?? null, held: () => held, cancel, mode, disarm: () => disarm() }
}
