// Which wake the board talks to now (core/wake/mode.ts): wake's status file read at most once a
// second, and read again only when it changed. While wake is off the file is not looked at: the
// board's path stays today's.
import { statSync } from 'node:fs'
import { readWakeStatus, wakeStatusFile } from '../../adapters/wake-files.ts'
import type { Config } from '../../core/types.ts'
import { wakeConfig } from '../../core/wake/config.ts'
import { type WakeMode, wakeMode } from '../../core/wake/mode.ts'
import type { WakeStatusFile } from '../../core/wake/status.ts'

export type { WakeMode }

/** How often the status file is looked at, at most. */
const LOOK_MS = 1000

/** The last look per status file: when, the file's modification time (null: no file), what it said. */
const looked = new Map<string, { at: number; mtimeMs: number | null; status: WakeStatusFile | null }>()

/** The status file as it is now, from the last look when that was under a second ago or the file is unchanged. */
function statusNow(file: string, now: number): WakeStatusFile | null {
  const last = looked.get(file)
  if (last && now - last.at < LOOK_MS && now >= last.at) return last.status
  let mtimeMs: number | null = null
  try {
    mtimeMs = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null
  } catch {} // not readable now: as no file
  const status = last && last.mtimeMs === mtimeMs ? last.status : mtimeMs === null ? null : readWakeStatus(file)
  looked.set(file, { at: now, mtimeMs, status })
  return status
}

/** wakeMode with the status file read now (at most once a second); `now` and `file` for the tests. */
export function currentWakeMode(
  cfg: Pick<Config, 'wake' | 'wakeUrl'>,
  { now = Date.now, file = wakeStatusFile() }: { now?: () => number; file?: string } = {},
): WakeMode {
  if (!wakeConfig(cfg.wake).enabled) return wakeMode(cfg, null)
  return wakeMode(cfg, statusNow(file, now()))
}
