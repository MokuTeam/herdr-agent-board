// A Claude session put to sleep gives its pane back (#204): once Claude has left, wake closes the
// pane, and its tab when nothing but herdr-sidebar's panes is beside it (that plugin adds its pane
// to every tab), so a sleeper holds no shell and no sidebar. It wakes in a new tab of its
// workspace, with its tab's label (services/wake/tabs.ts). What it needs for that is kept with its
// entry in wake's session file (core/wake/sessions.ts WakeEntry.freed).
//
// herdr cannot put a tab back where it was (its CLI has no tab move): a new tab opens at the
// end of its workspace. So a pane is closed only where the session comes back in the same Telegram
// topic (core/wake/topics.ts): a workspace's first tab is `topic:<workspace>`, the others
// `topic:<workspace> / <tab>`. A tab that is not its workspace's first comes back as another tab
// under its label; a workspace's only tab, alone in it but for sidebars, comes back as a new
// workspace's first, unless another sleeper whose pane was closed comes back to that workspace
// (whichever woke first would take its first tab, and the other's topic with it). The first tab of
// a workspace with other tabs, or one with the user's panes beside the sleeper, keeps its pane, as
// before: closing it would move its session, and the next tab, to other topics. Nor is anything
// closed in the tab the user is looking at (herdr's focused pane).
//
// Pure: the caller hands in herdr's snapshot and what the screen shows, and closes only a pane at
// its shell's prompt.
import { isSidebarPane } from '../board-pane.ts'
import { keyFor, type TopicSnapshot, workspaceTabs } from './topics.ts'

/** Where a sleeper whose pane wake closed comes back: what herdr showed of its place when it went. */
export interface FreedPlace {
  /** The pane it slept in, closed since: herdr may give its id to another pane after a restart. */
  pane: string
  /** herdr's workspace id then, and its label: a new tab there, or a new workspace of that label when it is gone. */
  workspace?: string
  workspaceLabel?: string
  /** Its tab's label, which the new tab gets. */
  tabLabel?: string
  /** Its Telegram topic then (core/wake/topics.ts keyFor), by which the router finds it. */
  topic: string
  /** When its pane was closed. */
  at: number
}

/** A pane as herdr's snapshot shows it, the fields read here. */
interface FreedPane {
  pane_id: string
  tab_id?: string
  workspace_id?: string
  agent?: string
  cwd?: string
  label?: string
  focused?: boolean
  tokens?: Record<string, unknown>
}

export interface FreedSnapshot extends TopicSnapshot {
  panes: FreedPane[]
  focused_pane_id?: string
}

/** What freeing a pane takes: herdr's close (the tab, or the pane alone), and what the sleeper keeps. */
export interface FreePlan {
  close: { tab: string } | { pane: string }
  place: FreedPlace
}

/** What else freePlan goes by. */
export interface FreeRules {
  /** The label the pane must still have (a pane kept before, taken back: `💤 <name>`). */
  label?: string
  /** Whether a sleeper whose pane was closed comes back to this workspace (by its id or label). */
  held?(workspace: { workspace_id: string; label?: string }): boolean
}

/**
 * herdr-sidebar's pane: its metadata tokens, or, once they have expired, its label with no agent in
 * it. That plugin adds one to every tab.
 */
const isSidebar = (p: FreedPane): boolean => isSidebarPane(p) || (!p.agent && p.label === 'Sidebar')

/**
 * How to give the sleeper's pane back, or null to leave it as it is: herdr no longer has it, an
 * agent runs in it, its label is not `rules.label`, the user looks at its tab, herdr does not say
 * which tab and workspace it is in, or it could not come back in the same Telegram topic (see the
 * top of the file).
 */
export function freePlan(snap: FreedSnapshot, pane: string, now: number, rules: FreeRules = {}): FreePlan | null {
  const p = snap.panes.find(x => x.pane_id === pane)
  if (!p || p.agent || (rules.label !== undefined && p.label !== rules.label)) return null
  const tab = snap.tabs.find(t => t.tab_id === p.tab_id)
  const ws = snap.workspaces.find(w => w.workspace_id === (tab?.workspace_id ?? p.workspace_id))
  if (!tab || !ws) return null
  const inTab = snap.panes.filter(x => x.tab_id === tab.tab_id)
  if (inTab.some(x => x.focused || x.pane_id === snap.focused_pane_id)) return null
  const tabs = workspaceTabs(snap, ws.workspace_id)
  const index = tabs.findIndex(t => t.tab_id === tab.tab_id)
  const alone = inTab.every(x => x.pane_id === pane || isSidebar(x))
  if (index < 0 || (index === 0 && !(alone && tabs.length === 1 && !rules.held?.(ws)))) return null
  return {
    close: alone ? { tab: tab.tab_id } : { pane },
    place: {
      pane,
      workspace: ws.workspace_id,
      ...(ws.label && { workspaceLabel: ws.label }),
      ...(tab.label && { tabLabel: tab.label }),
      topic: keyFor(snap, pane, p.cwd ?? ''),
      at: now,
    },
  }
}

/**
 * A shell prompt at the start of a screen row, up to its first end mark followed by a space or the
 * row's end: PowerShell's and cmd's `>`, sh's `$` and `#`, zsh's `%`, themes' `❯` and `λ`.
 */
const PROMPT = /^.*?[>$#%❯λ](?=\s|$)/
/** PowerShell's continuation prompt: a command not finished yet. */
const CONTINUED = /^\s*>>/

/**
 * What was typed at the shell's last prompt, as one line without its spaces: the rows after the
 * prompt's row are that line wrapped at the pane's width (an id split anywhere, a space lost at a
 * row's end). null when the screen shows no prompt, or a continuation prompt.
 */
function typedAtPrompt(screen: string): string | null {
  const rows = screen.split('\n').map(r => r.trimEnd())
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] ?? ''
    const prompt = PROMPT.exec(row)
    if (!prompt) continue
    if (CONTINUED.test(row)) return null
    return [row.slice(prompt[0].length), ...rows.slice(i + 1)].join('').replace(/\s+/g, '')
  }
  return null
}

/**
 * The session's wake line, without its spaces: wake's `board resume <id>` (with `--profile <id>`),
 * or the old plugin's `<command> [options] --resume <id>` (`claude-tg --dangerously-skip-permissions
 * --resume <id>`, `cldt --resume <id>`): a program and options only, nothing else on the line.
 */
function isWakeLine(typed: string, session: string): boolean {
  if (typed === `boardresume${session}` || new RegExp(`^boardresume${session}--profile[\\w.-]+$`).test(typed))
    return true
  return typed.endsWith(`--resume${session}`) && /^[\w.:\\/-]+$/.test(typed.slice(0, -`--resume${session}`.length))
}

const SESSION_ID = /^[0-9a-f-]+$/i

/**
 * Whether a shell's visible screen (`herdr pane read`) shows it as a sleep leaves it: at its last
 * prompt nothing typed, or only the session's wake line (wake's or the old plugin's, wrapped or
 * not). Anything else there, a continuation prompt, or no prompt on the screen: the pane is left
 * alone.
 */
export function promptIdle(screen: string, session: string): boolean {
  const typed = typedAtPrompt(screen)
  if (typed === null) return false
  return typed === '' || (SESSION_ID.test(session) && isWakeLine(typed, session))
}

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const time = (v: unknown): v is number => typeof v === 'number' && Math.abs(v) <= 8.64e15
const filled = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** A FreedPlace as wake's session file has it; null for one that does not read as one. */
export function asFreedPlace(value: unknown): FreedPlace | null {
  const f = record(value)
  if (!f || !filled(f.pane) || typeof f.topic !== 'string' || !time(f.at)) return null
  return {
    pane: f.pane,
    ...(filled(f.workspace) && { workspace: f.workspace }),
    ...(filled(f.workspaceLabel) && { workspaceLabel: f.workspaceLabel }),
    ...(filled(f.tabLabel) && { tabLabel: f.tabLabel }),
    topic: f.topic,
    at: f.at,
  }
}
