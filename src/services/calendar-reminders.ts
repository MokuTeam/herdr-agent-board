// Reminders before events (#335) at work in the web board's process, so they come with the
// board's window closed or not drawn: one timeout armed for the next reminder due (a minute at the
// most, and again soon after the calendar changes), the reminders that come due written down
// before they show (adapters/reminder-store.ts: none shows twice, a restart neither), each shown on
// the desktop (integrations/reminder-toast.ts) and on the page through the payload while it is on
// show. A button (the page's, or a notification's through web-open.ts) snoozes it or is done with it.
// core/calendar-reminders.ts has the rules.
//
// Off (the calendar off, or its reminders): no timer, nothing read, nothing in the payload.
import { readReminders, updateReminders } from '../adapters/reminder-store.ts'
import type { CalEvent, CalendarConfig, CalSource } from '../core/calendar.ts'
import {
  actOn,
  LINGER_MS,
  leadOf,
  planReminders,
  type Reminder,
  type ReminderAct,
  reminderId,
  reminderKey,
  shownAt,
  startsLater,
} from '../core/calendar-reminders.ts'
import { lang, t } from '../core/lang.ts'
import type { RemindersPayload } from '../core/payload.ts'
import { localZone } from '../core/time.ts'
import type { Config } from '../core/types.ts'
import { type ReminderDesktop, type ReminderToast, reminderDesktop } from '../integrations/reminder-toast.ts'
import { calendarOf, readEvents, withCalendarDb } from './calendar.ts'

/** How far back events are read: a reminder snoozed for hours after its start still comes. */
const BACK_MS = 12 * 3_600_000
/** The longest the timer waits: an event an agent adds without telling the board is found by then. */
const MAX_WAIT_MS = 60_000
/** How soon after the calendar changes it is looked at again: a sync's start and end are one look. */
const SETTLE_MS = 250

export type ActResult =
  | { ok: true; join?: string; event: { source: string; id: string; start: string } }
  | { ok: false; code: 'off' | 'gone' }

export interface CalendarReminders {
  /** config.json changed: the timer started or stopped as the calendar and its reminders are on or off. */
  configChanged(): void
  /** The calendar changed (a sync, an event of the board's): looked at again soon. */
  changed(): void
  /** The payload's reminders on show, or null for none (and while off). */
  line(): RemindersPayload | null
  /** A button: the reminder snoozed or done with; `desktop` when it came from its own notification. */
  act(id: string, act: ReminderAct | 'open', o?: { desktop?: boolean }): ActResult
  stop(): void
}

interface Options {
  cfg: Pick<Config, 'calendar'>
  log(msg: string): void
  /** The reminders on show changed: the board goes out again. */
  onChange(): void
  desktop?: ReminderDesktop
  /** Every source's events in [from, to): the copies and the board's own. */
  events?: (c: CalendarConfig, from: number, to: number) => CalEvent[]
  now?: () => number
  zone?: () => string
}

/** The source's label as a notification says it. */
function whoseOf(s: CalSource | undefined, source: string): string {
  if (!s) return source
  if (s.label && s.label !== s.id) return s.label
  return s.kind === 'board' ? t('cal.board') : s.label || s.id
}

/** "in 10 min · 14:30 - 15:00", or "started 3 min ago · …": when, as a notification says it. */
export function whenText(e: Pick<CalEvent, 'start' | 'end'>, now: number, zone: string): string {
  const start = Date.parse(e.start)
  const end = Date.parse(e.end)
  const clock = new Intl.DateTimeFormat(lang() === 'ru' ? 'ru-RU' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: zone,
  })
  const span = end > start ? `${clock.format(start)} - ${clock.format(end)}` : clock.format(start)
  const min = Math.round((start - now) / 60_000)
  const until =
    min > 59
      ? t('cal.inHours', { n: Math.round(min / 60) })
      : min > 0
        ? t('cal.inMin', { n: min })
        : min === 0
          ? t('cal.rem.now')
          : t('cal.rem.started', { n: -min })
  return `${until} · ${span}`
}

export function createCalendarReminders({
  cfg,
  log,
  onChange,
  desktop: given,
  now = Date.now,
  zone = localZone,
  events = (c, from, to) => withCalendarDb(false, db => readEvents(c, db, from, to, zone())),
}: Options): CalendarReminders {
  let timer: ReturnType<typeof setTimeout> | undefined
  let on = false
  let active: Reminder[] = []
  let shownSig = ''
  let snoozeMin = 5
  // looked for only once a reminder shows: a board with the calendar off asks nothing of its platform
  let made: ReminderDesktop | undefined
  const desktop = (): ReminderDesktop => {
    made ??= given ?? reminderDesktop(log)
    return made
  }
  // shown in this process while the state could not be written: once each, not at every look
  const shownHere = new Set<string>()

  const arm = (at: number | null): void => {
    clearTimeout(timer)
    const wait = at === null ? MAX_WAIT_MS : Math.min(Math.max(at - now(), 50), MAX_WAIT_MS)
    timer = setTimeout(tick, wait)
  }

  /** The events a reminder may come from at `at`: back a while, ahead as far as the longest lead. */
  const read = (c: CalendarConfig, at: number): CalEvent[] => {
    const leads = c.sources.map(s => leadOf(c, s) ?? 0)
    return events(c, at - BACK_MS, at + Math.max(0, ...leads) * 60_000 + MAX_WAIT_MS)
  }

  const toastOf = (r: Reminder, c: CalendarConfig, at: number): ReminderToast => {
    const s = c.sources.find(x => x.id === r.event.source)
    return {
      id: r.id,
      title: r.event.title || t('cal.rem.noTitle'),
      body: whenText(r.event, at, zone()),
      whose: whoseOf(s, r.event.source),
      join: r.event.join,
      expires: Math.max(r.start, at) + LINGER_MS,
      labels: {
        join: t('cal.join'),
        open: t('cal.rem.open'),
        snooze: t('cal.rem.snoozeFor', { n: c.reminders.snoozeMin }),
        ...(startsLater(r.start, at) && { start: t('cal.rem.atStart') }),
      },
    }
  }

  const publish = (): void => {
    // what the page shows of each: a title or a link changed while it is up goes out too
    const sig = JSON.stringify(active.map(r => [r.id, r.event.title, r.event.join, r.event.start, r.event.end]))
    if (sig === shownSig) return
    shownSig = sig
    onChange()
  }

  function tick(): void {
    const c = calendarOf(cfg)
    if (!c?.reminders.on) {
      off()
      return
    }
    snoozeMin = c.reminders.snoozeMin
    const at = now()
    let plan: ReturnType<typeof planReminders>
    try {
      plan = planReminders(c, read(c, at), readReminders(), at)
    } catch (err) {
      log(`calendar reminders: ${err instanceof Error ? err.message : String(err)}`)
      arm(null)
      return
    }
    const fired = plan.fire
    if (fired.length) {
      // written down first, so a restart does not show it again; one that cannot be written shows
      // once in this process all the same, and is on show until its grace is over
      let fresh = fired
      try {
        updateReminders(s =>
          shownAt(
            s,
            fired.map(r => r.key),
            at,
          ),
        )
      } catch (err) {
        log(`calendar reminders: ${err instanceof Error ? err.message : String(err)}`)
        fresh = fired.filter(r => !shownHere.has(r.key))
        for (const r of fresh) shownHere.add(r.key)
      }
      for (const r of fresh) desktop().show(toastOf(r, c, at))
    }
    active = [...plan.active, ...fired].sort((a, b) => a.start - b.start || a.key.localeCompare(b.key))
    publish()
    arm(plan.next)
  }

  function off(): void {
    clearTimeout(timer)
    timer = undefined
    on = false
    active = []
    publish()
  }

  return {
    configChanged() {
      const c = calendarOf(cfg)
      if (c?.reminders.on) {
        on = true
        tick()
      } else if (on || timer) off()
    },
    changed() {
      if (on) arm(now() + SETTLE_MS)
    },
    line() {
      if (!on || !active.length) return null
      const c = calendarOf(cfg)
      if (!c) return null
      return {
        snoozeMin,
        items: active.map(r => {
          const s = c.sources.find(x => x.id === r.event.source)
          return {
            id: r.id,
            source: r.event.source,
            event: r.event.id,
            title: r.event.title,
            start: r.event.start,
            end: r.event.end,
            ...(r.event.join && { join: r.event.join }),
            label: s?.label ?? r.event.source,
            kind: s?.kind ?? 'push',
            color: s?.color ?? null,
            lane: s?.lane ?? null,
          }
        }),
      }
    },
    act(id, act, o = {}) {
      const c = calendarOf(cfg)
      if (!on || !c?.reminders.on) return { ok: false, code: 'off' }
      const at = now()
      const r = read(c, at).find(e => reminderId(reminderKey(e)) === id)
      if (!r) return { ok: false, code: 'gone' }
      const event = { source: r.source, id: r.id, start: r.start }
      if (act === 'open') return { ok: true, event, ...(r.join && { join: r.join }) }
      updateReminders(s => actOn(s, reminderKey(r), Date.parse(r.start), act, c.reminders.snoozeMin, at))
      if (!o.desktop) desktop().clear(id)
      tick()
      return { ok: true, event, ...(r.join && { join: r.join }) }
    },
    stop() {
      clearTimeout(timer)
      timer = undefined
      on = false
    },
  }
}
