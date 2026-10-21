// Which wake the board talks to (#119, call 4). The new one, on 127.0.0.1 at the wake section's
// port, only while wake is on and its status file is there with a state other than `held`.
// Otherwise the old path, exactly as today: `wakeUrl` and the old guard. A missing status file means
// wake's start never ran; the board then starts it once (safeguard 3), which writes the file.
// Pure: services/wake/mode.ts reads the status file.
import type { Config } from '../types.ts'
import { type WakeConfig, wakeConfig } from './config.ts'
import type { WakeStatusFile } from './status.ts'

export type WakeMode =
  | { kind: 'new'; url: string; settings: WakeConfig }
  | { kind: 'old'; url: string | null; on: boolean; held: boolean }

/**
 * Whether config.json turns wake off with a `wake` key of its own: `"wake": false`, or a section
 * that is off. Only then does a refusal of the old path say wake is off (preflight H1); without the
 * key the old path keeps today's texts.
 */
export function wakeOffByKey(cfg: Pick<Config, 'wake'>): boolean {
  return cfg.wake !== undefined && !wakeConfig(cfg.wake).enabled
}

/** Call 4: new only while on and the status file exists with a state other than held. */
export function wakeMode(cfg: Pick<Config, 'wake' | 'wakeUrl'>, status: WakeStatusFile | null): WakeMode {
  const settings = wakeConfig(cfg.wake)
  const held = settings.enabled && status?.state === 'held'
  if (settings.enabled && status && !held) return { kind: 'new', url: `http://127.0.0.1:${settings.port}`, settings }
  return { kind: 'old', url: cfg.wakeUrl, on: settings.enabled, held }
}
