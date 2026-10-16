// Types shared across the board. Grows with each ported module.

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
  pinBusy?: boolean | ''
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

export interface Config {
  language: string
  categories: Category[]
  placement: 'workspace' | 'tab' | 'overlay'
  workspace: string
  refreshSec: number
  wakeUrl: string | null
  scheduleWaitMin: number
  launch?: LaunchSpec
  [extra: string]: unknown
}

export interface ToolCall {
  id: string
  name: string
  input?: unknown
  label?: string
  detail?: string
  pending?: boolean
  questions?: unknown
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
  transcript?: string | null
  [extra: string]: unknown
}
