// Per-account NetSuite session notification preferences (#897, core/ns-sessions-notify.ts):
// stored in ns-sessions-prefs.json under the board's state folder. No file means default behavior
// (only written when the owner toggles an account).
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isNsNotifyPrefs, NO_NS_NOTIFY_PREFS, type NsNotifyPrefs } from '../core/ns-sessions-notify.ts'
import { readJson, updateJson } from './json-store.ts'
import { stateDir } from './paths.ts'

export const nsNotifyPrefsFile = (): string => join(stateDir(), 'ns-sessions-prefs.json')

/** Reads persisted per-account notification preferences; returns empty defaults when absent. */
export const readNsNotifyPrefs = (file: string = nsNotifyPrefsFile()): NsNotifyPrefs =>
  readJson(file, isNsNotifyPrefs) ?? NO_NS_NOTIFY_PREFS

/** Updates notification preferences atomically under file lock. */
export function updateNsNotifyPrefs(
  change: (prefs: NsNotifyPrefs) => NsNotifyPrefs,
  file: string = nsNotifyPrefsFile(),
): NsNotifyPrefs {
  mkdirSync(dirname(file), { recursive: true })
  return updateJson(file, cur => change(cur ?? NO_NS_NOTIFY_PREFS), isNsNotifyPrefs)
}
