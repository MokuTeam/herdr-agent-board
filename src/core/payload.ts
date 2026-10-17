// The board as GET /api/board answers and the event stream pushes it (src/server/board-state.ts
// builds it; the web board reads it). One type for both sides, so they cannot drift apart.
import type { LimitWindow } from './limits.ts'
import type { ScheduleEntry } from './schedule-rules.ts'
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

export interface BoardPayload {
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
}
