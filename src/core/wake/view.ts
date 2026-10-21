// What the board shows of wake (#119): its state line, in the payload and the panel (phones read it
// too), and the panel's settings (GET /api/wake). One type for the server and the page.
import type { WakeHooksState } from '../install-plan.ts'
import type { ReaperConfig, TelegramMode } from './config.ts'
import type { WakeState } from './status.ts'

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
}

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
}
