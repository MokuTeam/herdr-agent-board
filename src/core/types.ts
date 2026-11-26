// Types shared across the board. Grows with each ported module.

import type { BgTaskSummary, RunningBgTask } from './bg-task.ts'
import type { CallView } from './call-agent.ts'
import type { Checklist } from './checklist.ts'
import type { CompactView } from './compact.ts'
import type { CardDecision, DecisionAnswer } from './decisions.ts'
import type { FormQuestion } from './dialogs/question-form.ts'
import type { HelperSummary } from './helpers.ts'
import type { FailureKind } from './launch/launcher-command.ts'
import type { ItemLinks } from './links.ts'
import type { LostAccess } from './lost-access.ts'
import type { LaunchPlace } from './placement.ts'
import type { Todo } from './todos.ts'

export type Lang = 'en' | 'ru'
export type Vars = Record<string, string | number>
export interface Translator {
  (key: string, vars?: Vars): string
  lang: Lang
}

// herdr's agent status; 'sleeping' is the board's own, for sessions herdr-wake put to sleep.
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown' | 'sleeping'
export type ColumnId = 'work' | 'me' | 'ext' | 'done' | 'idle'
/** Columns the user can drag a card to. */
export type Pin = 'me' | 'ext' | 'done' | 'idle'
export type Attention = '' | 'decision' | 'ask' | 'question' | 'later' | 'access'

/**
 * A Claude session observed mid-turn (#633, core/turn-resume.ts): kept on its card while
 * working and cleared when the turn ends. If still present after a restart, the board sends
 * one continue through the schedule once the same session is back and idle, dropping the mark first.
 */
export interface TurnMark {
  session: string
  startedAt: number
  pane?: string
  /** Claude's process start time (item.since), when known: distinguishes a real restart from a board-only reload. */
  processStartedAt?: number
}

/** The agent's card: what it (or the user) wrote about a session. Unknown fields survive. */
export interface Card {
  /** The owner marked this session as a master of its lane or project (#867). */
  teamMaster?: true
  key?: string
  category?: string
  doing?: string
  /** When `doing` was last written (#321): a recap newer than it takes the card's line. */
  doingAt?: number
  wait?: string
  waitSince?: number
  result?: string
  ask?: string
  askSince?: number
  pin?: Pin | ''
  pinAt?: number | ''
  /** Dragged during a turn (the web board writes 1). */
  pinBusy?: boolean | 1 | ''
  dismissed?: string
  name?: string
  updatedAt?: number
  /** The id of the profile its hooks reported (absent when the folder is no known profile). */
  profile?: string
  /** Its Claude config folder as the hooks resolved it. */
  profileDir?: string
  /** The profile a start asked for (the board's launch or spawn-agent). */
  profileWant?: string
  /** The model a start asked for (#380: spawn-agent --model, the board's launch); absent: the profile's default. */
  modelWant?: string
  /** The model family the owner allowed it from its card (#429, core/model-check.ts): no warning while it runs on it. */
  modelOk?: string
  /** The Claude id inherited by the root Codex hook, false when none. A Claude child has its own id. */
  codexParentClaude?: string | false
  /** The Claude id inherited by the root Antigravity hook, false when none. A Claude child has its own id. */
  agyParentClaude?: string | false
  /** The trajectory step count at the start of the last Antigravity user turn (PreInvocation initialNumSteps). */
  agyTurnSteps?: number
  /** A fork's: the id of the session it is a fork of, and when it started (its copied lines are older). */
  forkOf?: string
  forkAt?: number
  /** The session key or pane-<id> of the parent session that started this one with spawn-agent (#632). */
  parent?: string
  /** The user keeps it in sight: first in its column, whole, left out of a tidy-up. */
  favorite?: boolean
  /** The last question form its PreToolUse hook reported (core/held-question.ts). */
  asking?: HeldQuestion
  /**
   * The presence change this session was last told of (core/presence.ts: its `since`), -1 for one
   * the board marked to hear it on its next prompt; absent where presence was never on.
   */
  presenceSeen?: number
  /** Its tasks (#202, core/todos.ts): the user's pins and the agent's `board todo`; absent when none. */
  todos?: Todo[]
  /** The last task number given on this card (#319, core/todos.ts numberTodos). */
  todoSeq?: number
  /** The open tasks this session was last told of (#319, core/todos.ts todosNews). */
  todosSeen?: string
  /** Its own auto-compact limit (#378, core/compact.ts): tokens, `60%` of the window, or `never`; absent: Settings' default. */
  compactAt?: number | string
  /** What its summary must keep, typed after /compact (#378); absent: Settings' default's. */
  compactNote?: string
  /** The board's last /compact for it (#378, core/compact.ts CompactRun). */
  compactRun?: unknown
  /** When the board's compactions of it ended (#378, the newest 20), for its conversation's lines. */
  compactDone?: unknown
  /** Active mid-turn mark (#633, core/turn-resume.ts): present while a Claude turn runs, cleared when it ends. */
  midTurn?: TurnMark
  [extra: string]: unknown
}

/** An AskUserQuestion call as the board's PreToolUse hook reported it, before its dialog opened. */
export interface HeldQuestion {
  id: string
  /** Its first question, as a transcript's call gives it (core/transcript.ts toolDetail). */
  detail: string
  /** Its questions as questionsOf read them (null: the board cannot answer it). */
  questions: FormQuestion[] | null
  /** When the hook reported it. */
  at: number
}

export interface Category {
  id: string
  title?: string
  color: string
  paths: string[]
  /** The lane's usual profile. */
  profile?: string
}

export interface LaunchSpec {
  command?: (string | string[])[]
  agent?: string
  args?: string[]
  timeoutSec?: number
  /** What the board's own spawn-agent types into a new tab: a program, or the program and its arguments. */
  claude?: string | string[]
  /** What it types for a start that asks for pi (core/launch/agents.ts): as `claude`; `pi` when unset. */
  pi?: string | string[]
  /** What it types for a start that asks for Antigravity (core/launch/agents.ts): as `claude`; `agy` when unset. */
  agy?: string | string[]
  /** What spawn-agent --agent codex types: as `claude`; `codex` when unset. */
  codex?: string | string[]
  /** The agent a start that names none starts as (core/launch/agents.ts): `claude`, `pi` or `agy`; Claude Code when unset. */
  default?: string
  /**
   * The setup's ticket conventions: workspaces linked through herdr worktree for any checkout,
   * new worktrees under `<parent>/<repo>-wt/<ticket>`, and ticket agent names (`case-14404`).
   * Off (the default) leaves every setup as it was.
   */
  linkedWorkspaces?: boolean
}

/**
 * Where a launch from the board is: waiting for a dialog answered in herdr, or at the folder-trust
 * one. `queued`: a master's start that waits for room on its devices (#504, services/nodes/placer.ts).
 */
export type LaunchState = 'starting' | 'waiting' | 'trust' | 'done' | 'failed' | 'queued'
/** The step a launch is at, shown on its card (`launch.step.<step>`). */
export type LaunchStep =
  | 'prepare'
  | 'worktree'
  | 'workspace'
  | 'tab'
  | 'agent'
  | 'dialog'
  | 'rename'
  | 'message'
  | 'command'
  | 'trust'
  | 'trusting'
  // A master's start (#504): choosing a device, the profile synced to it (T10), the repository cloned there.
  | 'placing'
  | 'syncing'
  | 'cloning'

/** What kind of failure a launch had, for the hint on its card; 'message': only its first message did not go. */
export type LaunchFailure = FailureKind | 'message'

/** A launch as the board payload shows it. */
export interface LaunchView {
  id: string
  /** The id of the session it resumes (Return, from the archive), null for a new one; a board before the archive sent none. */
  resume?: string | null
  /** The id of the session whose conversation it starts with (a fork), null for none. */
  fork?: string | null
  name: string
  cwd: string
  category: string
  workspace: string
  workspaceId: string | null
  state: LaunchState
  step: LaunchStep
  error: string
  kind: LaunchFailure | ''
  pane: string | null
  key: string | null
  startedAt: number
  doneAt: number | null
  message: string
  /** What a retry starts from: null once this launch made its worktree. */
  worktree: { branch: string } | null
  newWorkspace: boolean
  /** The id of the Claude profile it starts in. */
  profile?: string
  /** The key of the card it was started from ("New here"): it runs in that session's profile. */
  parent?: string | null
  /** The agent the request asked for (core/launch/agents.ts); `claude` when it named none. */
  agent?: string
  /** The model it starts on (#380), null for the profile's default. */
  model?: string | null
  /** The device it starts on, when that is not this computer (#500): its ids carry the device's prefix. */
  device?: string
  /** A master's start (#504): where it goes, why it waits or was refused, as data the page words. Absent without `nodes`. */
  place?: LaunchPlace
}

export interface Config {
  language: string
  categories: Category[]
  placement: 'workspace' | 'tab' | 'overlay'
  workspace: string
  refreshSec: number
  wakeUrl: string | null
  scheduleWaitMin: number
  launch?: LaunchSpec
  /** The web board's port (12422 when not set), as config.json has it. */
  port?: unknown
  /** The app window's browser (a path), as config.json has it. */
  browser?: unknown
  /**
   * How long a session put in the archive keeps its pane, for Return in the page's toast, in
   * seconds, as config.json has it (a number from 0 up counts; else 8).
   */
  archiveUndoSec?: unknown
  /** How the web board folds a session asleep in "Waiting" (core/fold-mode.ts), as config.json has it. */
  foldWaiting?: unknown
  /** Wake's section (`true`, `false` or an object), as config.json has it: read through core/wake/config.ts wakeConfig. */
  wake?: unknown
  /**
   * "terminal": the terminal board in its Terminal style (src/tui/render-terminal.ts), and the web
   * board starting in it in a browser that has not picked a style (core/omarchy-theme.ts
   * pageWithLook); else Classic.
   */
  look?: unknown
  /** The user's presence (`true` or an object), as config.json has it: read through core/presence.ts presenceConfig. */
  presence?: unknown
  /** Tasks (#202, `true` or an object), as config.json has it: read through core/todos.ts todosConfig. */
  todos?: unknown
  /** The peer network (#231, an object with the hub's ws:// or wss:// address), as config.json has it: read through core/team.ts teamConfig. */
  team?: unknown
  /** The backup of the board's database (#233), as config.json has it: read through core/backup.ts backupConfig. */
  backup?: unknown
  /** Node housekeeping (#652: memory guard and leftover browser tab sweep), off by default: read through core/housekeeping.ts. */
  housekeeping?: unknown
  /** The board's update of itself from git (#617), as config.json has it: read through core/self-update.ts autoUpdateConfig. */
  autoUpdate?: unknown
  /** Time tracking (#233), as config.json has it: read through core/time.ts timeConfig. */
  time?: unknown
  /** Secrets through the board (#273), as config.json has it: read through core/secrets.ts secretsConfig. */
  secrets?: unknown
  /** The calendar (#328), as config.json has it: read through core/calendar.ts calendarConfig. */
  calendar?: unknown
  /** Auto-compact's default (#378, `{ at, note }`), as config.json has it: read through core/compact.ts compactConfig. */
  compact?: unknown
  /** Threads (#379, `true` or an object), as config.json has it: read through core/work-threads.ts threadsConfig. */
  threads?: unknown
  /** Watches (#486, `true` or an object), as config.json has it: read through core/watches.ts watchesConfig. */
  watches?: unknown
  /** Decisions (#487, `true` or `{ defaults: false }`), as config.json has it: read through core/decisions.ts decisionsConfig. */
  decisions?: unknown
  /** Trusted local Workdesk watcher settings, read only by the board server. */
  workdesk?: unknown
  workdeskDialog?: unknown
  boardEvents?: unknown
  /** The away journal (#489, `true` or an object), as config.json has it: read through core/journal.ts journalConfig. */
  journal?: unknown
  /** The model rule (#429, an object), as config.json has it: read through core/model-check.ts modelsConfig. */
  models?: unknown
  /** Nodes, this board as a master (#496, an object), as config.json has it: read through core/nodes.ts nodesConfig. */
  nodes?: unknown
  /** Nodes, this board as a node (#496, an object), as config.json has it: read through core/nodes.ts nodeConfig. */
  node?: unknown
  /** Continue mid-turn Claude sessions after a restart (#633): boolean or `{ on?, waitSec?, waitMin? }`. */
  turnResume?: unknown
  /** Minutes before a running background task is flagged as potentially stuck (#676); default 30, 0 disables. */
  bgTaskStuckMin?: unknown
  /** Limits on the starts sessions make (#815, an object): read through core/spawn-limits.ts spawnLimitsOf. */
  spawnLimits?: unknown
  [extra: string]: unknown
}

export interface ToolCall {
  id: string
  name: string
  input?: unknown
  label?: string
  detail?: string
  pending?: boolean
  /** An AskUserQuestion call's questions as questionsOf read them (null: the board cannot answer it). */
  questions?: FormQuestion[] | null
  /** A call the transcript does not have yet: when the hook reported it (core/held-question.ts). */
  reported?: number
}

export interface TranscriptInfo {
  title?: string
  prompt?: string
  lastText?: string
  tool?: ToolCall | null
  question?: string
  replied?: boolean
  /** lastText is Claude Code's own API error message (isApiErrorMessage on its line, #489). */
  apiError?: boolean
  /** The newest turn ended in a lost-access error (usage limit, logged out, expired login) with no success after (#632). */
  lostAccess?: LostAccess
  /** The time of its newest user or assistant line. */
  lastAt?: number
  /** Claude Code's newest recap of the session (away_summary, #321) and its time; absent with none. */
  recap?: string
  recapAt?: number
  activity?: number
  tokens?: number
  context?: number | null
  /** The model its last assistant message ran, when the status line has not said. */
  model?: string | null
  /** When that message was written (#429, core/model-check.ts); absent without a time. */
  modelAt?: number
  /** The effort its last assistant message was sent with (low, medium, high, xhigh, max). */
  effort?: string | null
  /** Latest active TodoWrite checklist (#637); absent when none or all completed. */
  checklist?: Checklist
  /** Active non-daemon background tasks parsed from the transcript (#676); absent when none. */
  bgTasks?: RunningBgTask[]
  /** Active daemon background tasks (`IsDaemon: true`) parsed from the transcript (#676); absent when none. */
  daemonBgTasks?: RunningBgTask[]
  [extra: string]: unknown
}

/** A board item: one agent session, merged from herdr, its card and its transcript. */
export interface Item {
  teamMaster?: true
  key: string
  session: string | null
  pane: string | null
  workspace: string | null
  cwd: string
  status: AgentStatus
  name: string
  autoName: string
  category: string
  categorySet: boolean
  column: ColumnId
  attention: Attention
  sleeping?: boolean
  /** Panes it had before, closed by wake as it went to sleep (#204), from its card: the board's links find it by them. */
  formerPanes?: string[]
  /** A sleeper read from the new wake's session file, not answered by a wake (integrations/wake.ts); absent for the others. */
  fromFile?: true
  agent?: string
  focused?: boolean
  doing?: string
  /** When `doing` was written (#321), else null. */
  doingAt?: number | null
  wait?: string
  waitSince?: number | null
  result?: string
  title?: string
  prompt?: string
  lastText?: string
  /** Its last words are Claude Code's own API error message (isApiErrorMessage, #489); absent otherwise. Kept off the payload. */
  apiError?: true
  /** Lost-access state from the session's transcript (#632); cleared on the next successful turn. */
  lostAccess?: LostAccess
  /** The time of its transcript's newest user or assistant line (#321), else null. */
  lastAt?: number | null
  /** Claude Code's newest recap of the session and its time (#321): '' and null with none. */
  recap?: string
  recapAt?: number | null
  context?: number | null
  contextPct?: number | null
  contextSize?: number | null
  /** The model it runs, as Claude's status line names it. */
  model?: string | null
  /** The model its start asked for (#380, card.modelWant): not the profile's default. Absent for the others. */
  modelAsked?: string
  /**
   * It runs on another model family than config.json's `models` expects of it (#429, core/model-check.ts):
   * the model it runs and the family expected. Absent for the others, and always while the rule is off.
   */
  modelWrong?: { runs: string; want: string }
  /**
   * The effort it thinks with (low, medium, high, xhigh, max): what Claude's status line last said
   * (null when it said none), else from its transcript or its profile's settings.
   */
  effort?: string | null
  /**
   * `effort` is the one Claude's status line last reported, the live level (#193); absent when it
   * came from the transcript or settings. The card shows effort only then.
   */
  effortLive?: true
  tool?: ToolCall | null
  question?: string
  askSince?: number | null
  activity?: number
  pin?: Pin | ''
  auto?: ColumnId
  /** A favorite (card.favorite); absent for the others. */
  favorite?: boolean
  /** Its subagents, forks, workflow agents and teammates in short (core/helpers.ts), or null. */
  helpers?: HelperSummary | null
  /** How it works with the board's other sessions (core/links.ts), or null. */
  links?: ItemLinks | null
  /** A fork's card: the session it is a fork of and when it started (core/links.ts), or none. */
  fork?: { of: string; at: number } | null
  /** A MokuPilot call agent's (#326, core/call-agent.ts): its call and its task board; absent for the others. */
  call?: CallView | null
  /** A MokuPilot day session (#331, core/mokupilot-day.ts): it has no pane, messages go to its day's inbox. */
  day?: true
  /**
   * The owner's service agent (#819, core/team-services.ts): a program with no pane that writes in
   * Team through the board's MCP as this card. Never woken, put to sleep or archived; absent for the others.
   */
  service?: true
  /** Its Claude process: whether it runs, since when, the pipe other sessions write to (server only). */
  alive?: boolean
  since?: number | null
  pipe?: string
  transcript?: string | null
  /** Its known profile's id (core/profiles.ts sessionProfile); null when not known. */
  profile?: string | null
  /** The folder it reported when no profile has it ("unknown profile"). */
  profileFolder?: string
  /** The id a start asked for, when it reports another ("wrong profile"). */
  profileWanted?: string
  /** The Claude folder its records were read from (server only). */
  claudeRoot?: string | null
  /** Its tasks from its card (#202), while config.json turns them on; absent when none. */
  todos?: Todo[]
  /** Latest active TodoWrite checklist from a Claude transcript (#637); absent when none or all completed. */
  checklist?: Checklist
  /** Active background tasks keeping the session busy or potentially stuck (#676); absent when none. */
  bgTasks?: BgTaskSummary
  /** Its open question's options, recommendation and default (#487), while config.json turns decisions on; absent when none. */
  decision?: CardDecision
  /**
   * On a node (#784): the owner's answer typed in the terminal to the question its master held, as
   * the hook noted it on the card; the master records it as the owner's. Absent on any other board.
   */
  decisionAnswer?: DecisionAnswer
  /** Its auto-compact (#378, core/compact.ts compactView): absent when neither it nor Settings has a limit. */
  compact?: CompactView
  /**
   * The device it runs on, when that is not this computer (#500, core/node-items.ts): its key then
   * carries the device's prefix. Absent for this computer's own, and always without `nodes`.
   */
  device?: string
  /**
   * The device its card says it moved to (#616, services/move-out.ts finish): carried on an awake
   * source card so the master's payload and target resolution can drop it deterministically when
   * the session has a card on that device (#642). Absent when unmarked.
   */
  movedTo?: string
  /** When that move mark was written (`card.moved.at`); absent when unmarked or unrecorded. */
  movedAt?: number
  /** The Telegram routing key (`topic:...` or cwd) for this session, populated on nodes (#701). */
  tgKey?: string
  [extra: string]: unknown
}
