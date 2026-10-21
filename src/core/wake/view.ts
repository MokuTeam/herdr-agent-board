// What the board shows of wake (#119): its state line, in the payload and the panel (phones read it
// too), and the panel's settings (GET /api/wake). One type for the server and the page.
import type { WakeHooksState } from '../install-plan.ts'
import type { ReaperConfig, TelegramMode } from './config.ts'
import type { TelegramStatus, WakeState } from './status.ts'

export interface WakeView {
  /** The kill switch: config.json's `wake` section. */
  on: boolean
  state: WakeState
  /** Since when it runs (the status file's time), while running; null otherwise. */
  since: number | null
  /** Sessions asleep on the board. */
  asleep: number
  /** Wake's port on 127.0.0.1. */
  port: number
  /** The status file's last error, while it does not run. */
  error?: string
  /** How many crashes stopped it, while crashed. */
  crashes?: number
  /** Since when it is on but not running (the toolbar's note waits a minute); null while running, off or held. */
  downSince?: number | null
  /** Its Telegram router's state, while it runs only (the status file keeps the last one after a crash). */
  telegram?: TelegramStatus
}

/** What "Switch over…" took over from the separate herdr-wake plugin, for the panel's line. */
export interface SwitchSummary {
  reaper: 'on' | 'off'
  /** The reaper's minutes idle. */
  minutes: number
  /** How many names, workspaces or patterns it never puts to sleep. */
  excluded: number
  /** Telegram on Auto: the old router routed it. */
  telegram: boolean
  /** Sleeping sessions taken over. */
  asleep: number
}

/**
 * What the takeover did (services/wake/takeover.ts): each step in a line (wake.log's words), the
 * summary, the launcher the old plugin woke sessions with when it is not the board's (call 25), and
 * herdr key bindings to its actions with their new names (call 26).
 */
export interface Switched {
  did: string[]
  summary: SwitchSummary
  launcher: { old: string; now: string } | null
  bindings: { key: string; old: string; now: string }[]
}

export type SwitchResult = ({ ok: true } & Switched) | { ok: false; error: string }

/** Wake's hooks in a shown profile (core/install-plan.ts wakeHooksState): for the panel's Install. */
export interface WakeHooksView {
  id: string
  title: string
  state: WakeHooksState
}

export interface WakeSettingsView {
  reaper: ReaperConfig
  telegram: TelegramMode
  /** tg-mcp's host and port, when Telegram's url and token are found; never the token. */
  found: { host: string } | null
  /** Telegram's last poll error, as wake answers it. */
  lastError: string | null
  /** wake.log's path. */
  log: string
  hooks: WakeHooksView[]
  /** What the takeover at wake's first start (nobody asked) took over, until the panel has shown it; none or null otherwise. */
  takenOver?: Switched | null
}
