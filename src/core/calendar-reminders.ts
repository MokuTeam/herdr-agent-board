// Reminders before events (#335): which events get one, when it comes, what Snooze and dismiss
// do to it, and which ones are on show. No I/O: the state is kept by adapters/reminder-store.ts,
// the timer and the notifications are services/calendar-reminders.ts.
//
// A reminder goes by its event's key and start (an event moved to another time is a new one), and
// its state says when it showed last, until when it is snoozed, and when it was done with. One that
// came due while the board was down fires when it comes up only within GRACE_MS of the event's
// start (or of a snooze's end); one that showed is on show until LINGER_MS after the start.
import { createHash } from 'node:crypto'
import { type CalEvent, type CalendarConfig, type CalSource, eventKey } from './calendar.ts'

/** How late a reminder still fires: the board coming up, the computer waking. */
export const GRACE_MS = 5 * 60_000
/** How long after the event's start (or its last showing) a reminder stays on show. */
export const LINGER_MS = 10 * 60_000
/** How long a reminder's state is kept after its event's start. */
export const KEEP_MS = 2 * 86_400_000

/** One reminder's state as it is kept. */
export interface ReminderRecord {
  /** When it showed last (fired, or came back after a snooze). */
  shown?: number
  /** Snoozed until then. */
  snooze?: number
  /** Dismissed or joined then: it does not show again. */
  done?: number
}

/** The reminders' state: by reminder key. */
export interface ReminderState {
  items: Record<string, ReminderRecord>
}

export const NO_REMINDERS: ReminderState = { items: {} }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const optTime = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isFinite(v))

export function isReminderState(v: unknown): v is ReminderState {
  if (!isObject(v) || !isObject(v.items)) return false
  return Object.values(v.items).every(r => isObject(r) && optTime(r.shown) && optTime(r.snooze) && optTime(r.done))
}

/** A reminder's key: its event's and the start, as an instant (the same time written two ways is one). */
export const reminderKey = (e: Pick<CalEvent, 'source' | 'id' | 'start'>): string =>
  `${eventKey(e)}@${Date.parse(e.start)}`

/** A reminder's id where it travels (a notification's buttons, the page): short, no title or address in it. */
export const reminderId = (key: string): string => createHash('sha256').update(key).digest('base64url').slice(0, 16)

/** What an id looks like: a notification's button and the route take nothing else. */
export const REMINDER_ID = /^[A-Za-z0-9_-]{16}$/

/** An event that may get a reminder: a timed one, not cancelled, not declined, a meeting by its kind. */
export const remindable = (e: CalEvent): boolean =>
  !e.allDay && e.status !== 'cancelled' && e.response !== 'declined' && (!e.kind || e.kind === 'default')

/** Minutes before an event of this source its reminder comes; null: none. */
export function leadOf(c: Pick<CalendarConfig, 'reminders'>, s: Pick<CalSource, 'remindMin'> | null): number | null {
  if (!c.reminders.on) return null
  const n = s?.remindMin ?? c.reminders.beforeMin
  return n > 0 ? n : null
}

/** A reminder as the plan has it: its event, key, id and when it came due. */
export interface Reminder {
  key: string
  id: string
  event: CalEvent
  /** The event's start, as an instant. */
  start: number
}

export interface ReminderPlan {
  /** Due now: they fire (each shows once, its state written first). */
  fire: Reminder[]
  /** On show (fired before, not snoozed or done, not past their linger). */
  active: Reminder[]
  /** When to look again: the next one due, or one on show going; null for none. */
  next: number | null
}

/**
 * What the reminders do at `now`, for these events (any window around now; the plan looks only at
 * the ones it may remind of): the ones to fire, the ones on show, and when to look again.
 */
export function planReminders(
  c: Pick<CalendarConfig, 'reminders' | 'sources'>,
  events: readonly CalEvent[],
  state: ReminderState,
  now: number,
): ReminderPlan {
  const plan: ReminderPlan = { fire: [], active: [], next: null }
  if (!c.reminders.on) return plan
  const leads = new Map(c.sources.map(s => [s.id, leadOf(c, s)]))
  const later = (at: number) => {
    if (plan.next === null || at < plan.next) plan.next = at
  }
  const seen = new Set<string>()
  for (const event of events) {
    if (!remindable(event)) continue
    const lead = leads.get(event.source)
    if (!lead) continue
    const start = Date.parse(event.start)
    if (!Number.isFinite(start)) continue
    const key = reminderKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    const r: Reminder = { key, id: reminderId(key), event, start }
    const rec = state.items[key]
    if (rec?.done) continue
    const fire = () => {
      plan.fire.push(r)
      later(Math.max(start, now) + LINGER_MS)
    }
    if (rec?.snooze !== undefined) {
      if (now < rec.snooze) later(rec.snooze)
      else if (now <= rec.snooze + GRACE_MS) fire()
      continue
    }
    if (rec?.shown !== undefined) {
      const until = Math.max(start, rec.shown) + LINGER_MS
      if (now < until) {
        plan.active.push(r)
        later(until)
      }
      continue
    }
    const due = start - lead * 60_000
    if (now < due) later(due)
    else if (now <= start + GRACE_MS) fire()
  }
  return plan
}

/** The state with these reminders shown at `now` (a snooze that ended gone), and the ones past keeping dropped. */
export function shownAt(state: ReminderState, keys: readonly string[], now: number): ReminderState {
  const items = pruned(state, now)
  for (const key of keys) items[key] = { ...withoutSnooze(items[key] ?? {}), shown: now }
  return { items }
}

/** What a reminder's buttons do: put it off for the snooze, until the start, or be done with it. */
export type ReminderAct = 'snooze' | 'start' | 'dismiss' | 'join'
export const REMINDER_ACTS: readonly ReminderAct[] = ['snooze', 'start', 'dismiss', 'join']

/** How soon before the start "At start" still means something: closer, it is a plain snooze. */
const AT_START_MIN_MS = 60_000

/** Whether "At start" is offered: the start is more than a minute away. */
export const startsLater = (start: number, now: number): boolean => start - now > AT_START_MIN_MS

/** The state after a button: snoozed for `snoozeMin`, until the start, or done. */
export function actOn(
  state: ReminderState,
  key: string,
  start: number,
  act: ReminderAct,
  snoozeMin: number,
  now: number,
): ReminderState {
  const items = pruned(state, now)
  const was = items[key] ?? {}
  if (act === 'dismiss' || act === 'join') items[key] = { ...withoutSnooze(was), done: now }
  else {
    const until = act === 'start' && startsLater(start, now) ? start : now + snoozeMin * 60_000
    items[key] = { ...was, snooze: until }
  }
  return { items }
}

const withoutSnooze = ({ snooze: _s, ...rest }: ReminderRecord): ReminderRecord => rest

/** The records still worth keeping: their event started at most KEEP_MS ago. */
function pruned(state: ReminderState, now: number): Record<string, ReminderRecord> {
  const out: Record<string, ReminderRecord> = {}
  for (const [key, rec] of Object.entries(state.items)) {
    const at = Number(key.slice(key.lastIndexOf('@') + 1))
    if (Number.isFinite(at) && at >= now - KEEP_MS) out[key] = rec
  }
  return out
}
