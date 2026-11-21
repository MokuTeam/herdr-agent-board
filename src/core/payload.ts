// The board as GET /api/board answers and the event stream pushes it (src/server/board-state.ts
// builds it; the web board reads it). One type for both sides, so they cannot drift apart.
import type { BoardArchive } from './archive.ts'
import type { FoldMode } from './fold-mode.ts'
import type { LimitWindow } from './limits.ts'
import type { DeviceView, LinkStatus } from './nodes.ts'
import type { PresenceView } from './presence.ts'
import type { RemoteView } from './remote.ts'
import type { ScheduleEntry } from './schedule-rules.ts'
import type { SetupSummary } from './setup.ts'
import type { TodosConfig } from './todos.ts'
import type { ColumnId, Item, Lang, LaunchView } from './types.ts'
import type { WakeView } from './wake/view.ts'
import type { WorkdeskPayload } from './workdesk.ts'
import type { DialogStatus } from './workdesk-dialog.ts'

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
  /** Whether the board can fork a session into a new tab here (services/launch/fork.ts canFork). */
  fork?: boolean
  /** Whether the board can ask a session a side question here (services/aside.ts: /btw typed into the session). */
  aside?: boolean
  /** What of the board is not set up on this computer (core/setup.ts); null before the first check. */
  setup?: SetupSummary | null
  /** Sleep and wake's state line (#119), once wake ships, while it is on, or while its file has sleepers; phones read it too. */
  wake?: WakeView
  /** Every profile, shown and hidden, in the list's order (core/profiles.ts); a board before profiles sent none. */
  profiles?: BoardProfile[]
  /** The program `launch.claude` types (`claude` when it is unset or not valid): what a profile without a start command types. */
  claudeProgram?: string
  /** How a session asleep in "Waiting" folds (core/fold-mode.ts); a board before the setting sent none. */
  foldWaiting?: FoldMode
  /** Auto-compact's default limit as written (#378, core/compact.ts: `300k`, `60%`), '' for off; a board before it sent none. */
  compactDefault?: string
  /** The remote mode (core/remote.ts), only while it is on. */
  remote?: RemoteView
  /** The user's presence (#172, core/presence.ts), only while config.json turns it on. */
  presence?: PresenceView
  /** Tasks (#202, core/todos.ts), only while config.json turns them on; items carry theirs only then. */
  todos?: TodosConfig
  /**
   * The backup of the board's database (#233): only once there is a database or a target is set.
   * `last`: the newest good backup over all targets; `problem`: the first thing wrong as a short
   * code and its target (core/backup.ts BackupProblem's kind), null when nothing is. Never an ssh
   * error's or a check's text: those stay on this computer (Settings → Backup…, board doctor).
   */
  backup?: BackupPayload
  /**
   * Time tracking (#233), only while config.json turns it on: the journal's last seq (an open panel
   * reads again when it moves) and today's billed seconds by lane (a lane's header shows them).
   */
  time?: TimePayload
  /**
   * The calendar (#328), only while config.json turns it on: a revision that moves when any
   * source's copy or the board's own events change (an open panel reads again then), whether a
   * fetch runs, how many sources fail, and the next call of the coming hours for the toolbar.
   */
  calendar?: CalendarPayload
  /**
   * Threads (#379), only while config.json turns them on: the threads revision (the journal seq of
   * the last entry; a page that shows threads reads its own routes again when it moves) and how
   * many wait on the owner. The threads themselves never ride in the payload.
   */
  threads?: ThreadsPayload
  /** Workdesk queue and last poll, only while the watcher is configured. */
  workdesk?: WorkdeskPayload
  workdeskDialog?: DialogStatus
  /**
   * The Remote access view's revision (GET /api/access, local only): it changes when the view does,
   * and the panel fetches the view again then; the view itself never goes out with the board. The
   * server always sends it; a board before it sent none.
   */
  accessRev?: number
  /**
   * The peer network's revision (#231): the panel's cue to fetch GET /api/team again. Only while
   * config.json's `team` is on; a board without it sends none.
   */
  teamRev?: number
  /** The team's unread messages (#355), only while `team` is on. */
  teamUnread?: number
  /** What the owner's phone asked and waits for the passkey on this computer (#377), only while some does. */
  teamWaiting?: number
  /**
   * The Omarchy theme the Terminal style takes its colors from (src/adapters/omarchy.ts): a stamp
   * that changes with it, only on a computer with Omarchy. The page loads omarchy-theme.css again.
   */
  omarchy?: string
  /**
   * The devices of config.json's `nodes` in their order, this computer among them (#500): only
   * while this board is a master. Their items, launches and schedule entries are among the board's
   * own, each with its `device`.
   */
  devices?: BoardDevice[]
}

/**
 * A device as the master's payload shows it (#500): its link and its last status as `GET
 * /api/nodes` has them (core/nodes.ts DeviceView), with what config.json sets for it. The link's
 * detail stays on this computer (`GET /api/nodes`, `board nodes`): it is what ssh said, and
 * the payload goes to phones too. `link.heardAt` is cut to the minute, so a ping does not push
 * the board to every page. `payloadAt`: when its cards were last heard, from the offline
 * copy while the link has heard none since the board started. `status` (this computer's own for
 * `local`) is the last one whose shown figures moved (core/nodes.ts statusShown): its other
 * fields (`at`, free disk, launches) may be older than `GET /api/nodes`'s.
 */
export interface BoardDevice extends DeviceView {
  /** The link's state, without its detail; `heardAt` to the minute. */
  link: Omit<LinkStatus, 'detail'> | null
  paused: boolean
  drain: boolean
  /** The thresholds placement holds it to; null until the board writes them from its first status. */
  maxSessions: number | null
  minFreeMemMb: number | null
  maxLoad: number | null
}

/** What the board's payload says of the backup (#233). */
export interface BackupPayload {
  last: number | null
  problem: { kind: string; target?: string } | null
}

/** What the board's payload says of time tracking (#233). */
export interface TimePayload {
  seq: number
  /** Today in the board's zone, YYYY-MM-DD. */
  date: string
  today: Record<string, number>
  /** config.json's `time` does not check out (the panel says what): no entry is written. */
  problems?: boolean
}

/** What the board's payload says of threads (#379). */
export interface ThreadsPayload {
  rev: number
  needsOwner: number
  /** Moves when a shared entry's way to the hub changed (#394): absent until one did. */
  out?: number
  /** Threads are the owner's (config.json's `agents: false`, #410): absent while agents write too. */
  agents?: false
  /** Kept on this board also with Team on (`share: false`, #410): absent while they may be shared. */
  share?: false
}

/** What the board's payload says of the calendar (#328). */
export interface CalendarPayload {
  rev: string
  busy: boolean
  /** Sources with a problem in config.json or whose last fetch failed. */
  failing: number
  /** The next timed call not declined, ongoing or within twelve hours. */
  next: {
    source: string
    id: string
    title: string
    start: string
    end: string
    join?: string
    label: string
    color: string | null
    lane: string | null
  } | null
  /** Reminders on show (#335): only while one is; snoozed or dismissed ones are not. */
  reminders?: RemindersPayload
}

/** The calendar's reminders on show (#335), for the page's banner. */
export interface RemindersPayload {
  /** Minutes a Snooze puts one off. */
  snoozeMin: number
  items: {
    /** The reminder's id, for its buttons (POST /api/calendar-reminders). */
    id: string
    source: string
    /** The event's id in its source. */
    event: string
    title: string
    start: string
    end: string
    join?: string
    /** The source as the page names it (with its kind and lane). */
    label: string
    kind: string
    color: string | null
    lane: string | null
  }[]
}
