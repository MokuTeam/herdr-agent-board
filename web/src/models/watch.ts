// A watch on the page (#486, core/watches.ts): the session's watch from the payload's schedule, and
// what the card, the sheet and the schedule panel say of it. The payload carries watches only while
// config.json's `watches` is on, so with it off none of this finds anything.
import type { ScheduleEntry } from '../../../src/core/schedule-rules.ts'
import type { Translator } from '../../../src/core/types.ts'
import { isWatch, type WatchEntry, watchState } from '../../../src/core/watches.ts'
import { span } from '../../../src/core/when-format.ts'

/** The session's watch, if it has one (one per session). */
export const watchOf = (schedules: readonly ScheduleEntry[], key: string): WatchEntry | undefined =>
  schedules.find((e): e is WatchEntry => e.key === key && isWatch(e))

export interface WatchView {
  /** "checked 4 min ago, nothing yet", "probe error: …, next try in 20 min". */
  state: string
  /** The whole command line, as the board runs it. */
  cmd: string
  /** "every 10 min". */
  every: string
  /** Its last run was an error. */
  error: boolean
}

export function watchView(w: WatchEntry, now: number, t: Translator): WatchView {
  return {
    state: watchState(w, now, t),
    cmd: w.probe.cmd,
    every: t('watch.every', { every: span(w.probe.everyMs, t) }),
    error: !!w.errors,
  }
}

/**
 * The watches' stylesheet (web/styles/watches.css), linked once a watch is on the page, before the
 * Terminal look's sheet, which stays last: a page with no watch loads exactly what it did.
 */
export function linkWatchesSheet(doc: Document = document): void {
  if (doc.getElementById('watches-css')) return
  const link = doc.createElement('link')
  link.id = 'watches-css'
  link.rel = 'stylesheet'
  link.href = 'styles/watches.css'
  const look = doc.querySelector('link[href$="look-terminal.css"]')
  if (look?.parentNode) look.parentNode.insertBefore(link, look)
  else doc.head.append(link)
}
