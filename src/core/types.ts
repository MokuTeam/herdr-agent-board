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
  [extra: string]: unknown
}

export interface Category {
  id: string
  title?: string
  color: string
  paths: string[]
}

export interface LaunchSpec {
  command?: (string | string[])[]
  agent?: string
  args?: string[]
  timeoutSec?: number
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
  /** Its subagents, forks, workflow agents and teammates in short (core/helpers.ts), or null. */
  helpers?: HelperSummary | null
  /** How it works with the board's other sessions (core/links.ts), or null. */
  links?: ItemLinks | null
  /** Its Claude process: whether it runs, since when, the pipe other sessions write to (server only). */
  alive?: boolean
  since?: number | null
  pipe?: string
  transcript?: string | null
  [extra: string]: unknown
}
