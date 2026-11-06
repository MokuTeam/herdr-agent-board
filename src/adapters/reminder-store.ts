// The calendar reminders' state (#335, core/calendar-reminders.ts): calendar-reminders.json in the
// board's state folder, written under its lock. No file is no reminder shown yet; the file appears
// only once a reminder fires, so a calendar without reminders never has one.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isReminderState, NO_REMINDERS, type ReminderState } from '../core/calendar-reminders.ts'
import { readJson, updateJson } from './json-store.ts'
import { stateDir } from './paths.ts'

export const remindersFile = (): string => join(stateDir(), 'calendar-reminders.json')

/** The state on record; none yet when there is no file (or no valid one). */
export const readReminders = (): ReminderState => readJson(remindersFile(), isReminderState) ?? NO_REMINDERS

/** The state changed under the file's lock: what `change` makes of it is written and returned. */
export function updateReminders(change: (state: ReminderState) => ReminderState): ReminderState {
  mkdirSync(stateDir(), { recursive: true })
  return updateJson(remindersFile(), cur => change(cur ?? NO_REMINDERS), isReminderState)
}
