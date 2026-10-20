// Types shared across the board. Grows with each ported module.

import type { FormQuestion } from './dialogs/question-form.ts'
import type { HelperSummary } from './helpers.ts'
import type { FailureKind } from './launch/launcher-command.ts'
import type { ItemLinks } from './links.ts'

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
export type Attention = '' | 'decision' | 'ask' | 'question' | 'later'

/** The agent's card: what it (or the user) wrote about a session. Unknown fields survive. */
export interface Card {
  key?: string
  category?: string
  doing?: string
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
  /** A fork's: the id of the session it is a fork of, and when it started (its copied lines are older). */
  forkOf?: string
  forkAt?: number
  /** The user keeps it in sight: first in its column, whole, left out of a tidy-up. */
  favorite?: boolean
  [extra: string]: unknown
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
}

/** Where a launch from the board is: waiting for a dialog answered in herdr, or at the folder-trust one. */
export type LaunchState = 'starting' | 'waiting' | 'trust' | 'done' | 'failed'
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
}

export interface TranscriptInfo {
  title?: string
  prompt?: string
  lastText?: string
  tool?: ToolCall | null
  question?: string
  replied?: boolean
  activity?: number
  tokens?: number
  context?: number | null
  [extra: string]: unknown
}

/** A board item: one agent session, merged from herdr, its card and its transcript. */
export interface Item {
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
  agent?: string
  focused?: boolean
  doing?: string
  wait?: string
  waitSince?: number | null
  result?: string
  title?: string
  prompt?: string
  lastText?: string
  context?: number | null
  contextPct?: number | null
  contextSize?: number | null
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
  [extra: string]: unknown
}
