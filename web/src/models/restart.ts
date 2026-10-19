// A restart on its way, as the page shows it (web/app.js restartOf, restartPending, restartOn,
// restartText): a schedule entry of kind 'restart' that the scheduler carries out once the session
// is free (src/services/scheduler.ts), how far it got (`step`), what holds it (`why`), and one
// that gave up (`failed`) and still has to tell the session so.
import type { ScheduleEntry } from '../../../src/core/schedule-rules.ts'
import type { Translator } from '../../../src/core/types.ts'

/**
 * The restart of a session on its way, if one is (the scheduler does it once the session is free).
 * One that gave up and still has to tell the session so does not stop another being asked for.
 */
export const restartOf = (schedules: readonly ScheduleEntry[], key: string): ScheduleEntry | undefined =>
  schedules.find(e => e.kind === 'restart' && e.key === key)

export function restartPending(schedules: readonly ScheduleEntry[], key: string): boolean {
  const e = restartOf(schedules, key)
  return !!e && !e.failed
}

/** Claude is out and coming back: put to sleep, or being woken. */
export const restartOn = (e: ScheduleEntry): boolean => (e.step === 'sleep' || e.step === 'wake') && !e.failed

const HELD: Readonly<Record<string, string>> = {
  tasks: 'sched.tasks',
  draft: 'sched.draft',
  dialog: 'sched.dialog',
  gone: 'sched.gone',
}

/** How a restart stands, in a line: under way, waiting for the session (and on what), or given up. */
export function restartText(e: ScheduleEntry, t: Translator): string {
  if (e.failed) return t('restart.title.failed', { why: String(e.failed) })
  if (e.step === 'note') return t('restart.title.note')
  if (e.step) return t('restart.title.on')
  const why = typeof e.why === 'string' ? e.why : ''
  const held = Object.hasOwn(HELD, why) ? HELD[why] : undefined
  if (held) return `${t('restart.title.wait')}. ${t(held)}`
  // What herdr-wake said when it refused, until the session is held for one of the reasons above.
  return e.attempts && why && why !== 'busy' ? t('restart.title.retry', { why }) : t('restart.title.wait')
}

/** A restart's line: on (tinted, its arrows turning) while Claude exits and comes back, its badge and how it stands. */
export interface RestartView {
  on: boolean
  badge: string
  title: string
}

export function restartView(e: ScheduleEntry, t: Translator): RestartView {
  const on = restartOn(e)
  return { on, badge: t(on ? 'restart.badge.on' : 'restart.badge.wait'), title: restartText(e, t) }
}
