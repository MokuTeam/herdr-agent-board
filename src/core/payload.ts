// The board as GET /api/board answers and the event stream pushes it (src/server/board-state.ts
// builds it; the web board reads it). One type for both sides, so they cannot drift apart.
import type { BoardArchive } from './archive.ts'
import type { LimitWindow } from './limits.ts'
import type { ScheduleEntry } from './schedule-rules.ts'
import type { SetupSummary } from './setup.ts'
import type { ColumnId, Item, Lang, LaunchView } from './types.ts'

/** A lane as the page shows it: the configured category or one a session picked. */
export interface BoardCategory {
  id: string
  title: string
  /** The color as hex. */
  color: string
  /** The color as the config names it. */
  colorName: string
  paths: string[]
  configured: boolean
  fallback: boolean
  /** The lane's usual profile, when the config gives it one. */
  profile?: string
}

/** A color the category editor offers. */
export type Swatch = { name: string; hex: string }

/** Claude's usage windows from the board's status line or the usagebar cache. */
export interface BoardLimits {
  source: 'statusline' | 'usagebar'
  observedAt: number | null
  stale: boolean
  windows: LimitWindow[]
}

/** A Claude profile (a config folder sessions run in, core/profiles.ts) as the page shows it. */
export interface BoardProfile {
  id: string
  title: string
  /** The color as hex. */
  color: string
  /** The color as the config names it. */
  colorName: string
  dir: string
  hidden: boolean
  /** The board's own environment points to it. */
  inherited: boolean
  /** Its folder is there. */
  exists: boolean
  /**
   * The hooks its sessions need are in its settings.json: the board's, and herdr's own Claude hook
   * (from which herdr learns the session a pane runs); null for a hidden one, which the board does not read.
   */
  hooks: boolean | null
  /** The sessions on the board that run in it now. */
  sessions: number
  /** Its usage windows: from the board's status line in its sessions, else its usagebar cache. */
  limits: BoardLimits | null
  /**
   * Its start command, typed instead of `launch.claude`, as one line ('' for none). The server
   * always sends it; a board before start commands sent none.
   */
  command?: string
}

export interface BoardPayload {
  /** What became of the latest sessions put in the archive (core/archive.ts); a board before the archive sent none. */
  archive?: BoardArchive
  /** The page's version: an open page reloads when it changes. */
  version: string
  lang: Lang
  /** The config's `language` ("auto", "en", "ru"). */
  language: string
  languages: Record<Lang, string>
  fsToken: string
  stale: boolean
  lastSuccessfulRefreshAt: number | null
  limits: BoardLimits | null
  items: Item[]
  launches: LaunchView[]
  categories: BoardCategory[]
  swatches: Swatch[]
  columns: { id: ColumnId; title: string }[]
  /** Without the scheduler's bookkeeping (claim, tried, waited). */
  schedules: ScheduleEntry[]
  /** The newest runs, newest first: the scheduler's log lines as parsed, not checked. */
  scheduleLog: unknown[]
  /** Whether the board offers its terminal (config `terminal`); the server always says, the page reads a missing one as on. */
  terminal?: boolean
  /** The sessions the board has a shell open for (services/terminals.ts). */
  shells?: string[]
  /** Whether a session's sheet offers a MokuPilot call with a fork of it (services/mokupilot.ts). */
  mokupilot?: boolean
  /** What of the board is not set up on this computer (core/setup.ts); null before the first check. */
  setup?: SetupSummary | null
  /** Every profile, shown and hidden, in the list's order (core/profiles.ts); a board before profiles sent none. */
  profiles?: BoardProfile[]
  /** The program `launch.claude` types (`claude` when it is unset or not valid): what a profile without a start command types. */
  claudeProgram?: string
}
