// What every writer of time entries asks first (#233): `board time` and the board's own routes.
// An entry is written only while config.json's `time` checks out (its dates and rules are not
// guesses) and once the database has a backup off this computer that went through: a target and
// a passphrase set up, and a snapshot or a Test that went the whole way round on one of them. A
// target that is down now does not stop a write; one that never worked does.
//
// A project typed as new (`--new-project`, the editor's "New project…", #237) goes into the
// client's list in config.json with the entry that has it, under the file's lock (withNewProject).
import { readKey, readStatus } from '../adapters/backup-store.ts'
import { configBusy, readConfigFile, withConfigFile, withTimeProjects } from '../adapters/config-file.ts'
import { TimeError } from '../adapters/time-store.ts'
import { activeTargets, backupConfig, targetWhere } from '../core/backup.ts'
import { t } from '../core/lang.ts'
import type { SetupCheck } from '../core/setup.ts'
import { problemsText, type TimeConfig, type TimeEntry, timeConfig } from '../core/time.ts'
import type { Config, Translator } from '../core/types.ts'

/** Why no entry may be written now, or null: it may. */
export function writeRefusal(cfg: Pick<Config, 'backup'>, conf: TimeConfig): TimeError | null {
  if (conf.problems.length) return new TimeError('time.err.config', { problems: problemsText(conf.problems, t) })
  const c = backupConfig(cfg.backup)
  const targets = activeTargets(c)
  if (!targets.length || !readKey()) return new TimeError('time.err.noBackup')
  const states = readStatus().targets
  // to this target as it is set now: a folder or server changed since has not taken one
  const went = (target: (typeof targets)[number]) => {
    const s = states[target]
    return !!(s?.lastOk || s?.tested) && s?.where === targetWhere(c, target)
  }
  if (!targets.some(went)) return new TimeError('time.err.notBackedUp')
  return null
}

/** `board doctor`'s line for time tracking, while it is on: its zone, or what does not check out. */
export function timeChecks(cfg: Pick<Config, 'time'>, tr: Translator): SetupCheck[] {
  const conf = timeConfig(cfg.time)
  if (!conf) return []
  const base = { id: 'time', title: tr('time.doctor.title'), fix: '', code: '' }
  return [
    conf.problems.length
      ? { ...base, level: 'error', detail: tr('time.doctor.problems', { problems: problemsText(conf.problems, tr) }) }
      : { ...base, level: 'ok', detail: tr('time.doctor.ok', { zone: conf.zone }) },
  ]
}

/**
 * An entry written with its project typed as new, under config.json's lock: `write` gets the
 * config as the file has it now (a project another writer added a moment ago is there, so the
 * entry takes the client's own name for it, case and spaces aside), then the entry's project goes
 * into the client's list when it is not in it. Two writers at once never lose each other's. With
 * no file to read, the config the caller has (`conf`); with time off in it since, refused.
 */
export function withNewProject<T>(
  conf: TimeConfig,
  write: (conf: TimeConfig) => T,
  entryOf: (written: T) => TimeEntry,
): T {
  // no file to add it to (a board that never wrote its config): the entry alone, as before
  if (!readConfigFile()) return write(conf)
  try {
    return withConfigFile((raw, save) => {
      const now = raw ? timeConfig(raw.time) : conf
      if (!now) throw new TimeError('time.err.off')
      const written = write(now)
      const e = entryOf(written)
      if (raw && withTimeProjects(raw, e.client, [e.project]).length) save(raw)
      return written
    })
  } catch (err) {
    // the lock still taken: nothing written, the entry neither
    if (configBusy(err)) throw new TimeError('err.configBusy')
    throw err
  }
}
