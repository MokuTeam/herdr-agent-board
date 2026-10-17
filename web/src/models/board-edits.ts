// What the page changed on the board it shows, before the server's next board says so: lanes put
// in a new order, a reminder cancelled, a reminder's delivery switched. The old page wrote these
// into the board it held; here they lie over it until the next board comes in.
import type { BoardPayload } from '../../../src/core/payload.ts'
import type { ScheduleEntry } from '../../../src/core/schedule-rules.ts'

export interface BoardEdits {
  /** Category ids in the order the user dragged them to. */
  order: readonly string[] | null
  /** Reminders cancelled. */
  cancelled: ReadonlySet<string>
  /** Reminder id -> "when the session is free" (true) or "on time" (false). */
  idle: ReadonlyMap<string, boolean>
}

export const NO_EDITS: BoardEdits = { order: null, cancelled: new Set(), idle: new Map() }

export type BoardEdit =
  | { type: 'order'; ids: string[] }
  | { type: 'cancelled'; id: string }
  /** `idle: null` takes the switch back (the server said no). */
  | { type: 'idle'; id: string; idle: boolean | null }

export function withEdit(edits: BoardEdits, edit: BoardEdit): BoardEdits {
  switch (edit.type) {
    case 'order':
      return { ...edits, order: edit.ids }
    case 'cancelled':
      return { ...edits, cancelled: new Set(edits.cancelled).add(edit.id) }
    case 'idle': {
      const idle = new Map(edits.idle)
      if (edit.idle === null) idle.delete(edit.id)
      else idle.set(edit.id, edit.idle)
      return { ...edits, idle }
    }
  }
}

/** An entry as the old page left it: `idle: true`, or no `idle` at all. */
function withIdle(e: ScheduleEntry, idle: boolean): ScheduleEntry {
  const { idle: _was, ...rest } = e
  return idle ? { ...rest, idle: true } : rest
}

/** The board with the page's edits on it; the same board when there are none. */
export function withEdits(data: BoardPayload, edits: BoardEdits): BoardPayload {
  if (edits === NO_EDITS) return data
  const { order, cancelled, idle } = edits
  // Ids the order does not name go first, as Array.prototype.sort put them (indexOf -1).
  const categories = order
    ? [...data.categories].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    : data.categories
  const schedules =
    cancelled.size || idle.size
      ? data.schedules
          .filter(e => !cancelled.has(e.id))
          .map(e => {
            const own = idle.get(e.id)
            return own === undefined ? e : withIdle(e, own)
          })
      : data.schedules
  return { ...data, categories, schedules }
}
