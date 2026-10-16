// Thin async wrapper over the herdr CLI. HERDR_BIN_PATH hides the socket transport
// (Unix socket or Windows named pipe), so plugins should call herdr through it.
import { execFile } from 'node:child_process'
import { isAgentStatus } from '../core/board.ts'
import type { AgentStatus } from '../core/types.ts'
import { isRecord } from './json-store.ts'

const BIN = process.env.HERDR_BIN_PATH || 'herdr'

export class HerdrError extends Error {
  code: string | undefined
  constructor(args: string[], code: string | undefined, message: string) {
    super(`herdr ${args.slice(0, 2).join(' ')}: ${code ? `${code}: ` : ''}${message}`)
    this.code = code
  }
}

/** A herdr token value, e.g. `agent_session: { value: '<claude session id>' }`. */
export interface HerdrToken {
  value?: string | null
  [key: string]: unknown
}

export interface HerdrWorkspace {
  workspace_id: string
  label?: string
  [key: string]: unknown
}

export interface HerdrTab {
  tab_id: string
  workspace_id: string
  [key: string]: unknown
}

export interface HerdrPane {
  pane_id: string
  tab_id?: string
  workspace_id?: string
  /** The agent kind running in the pane ('claude', ...); absent for plain terminals. */
  agent?: string
  agent_status?: string
  agent_session?: HerdrToken | null
  cwd?: string
  label?: string
  terminal_title_stripped?: string
  tokens?: Record<string, unknown>
  [key: string]: unknown
}

export interface HerdrSnapshot {
  workspaces: HerdrWorkspace[]
  tabs: HerdrTab[]
  panes: HerdrPane[]
  focused_pane_id?: string
  [key: string]: unknown
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

function run(args: string[], timeoutMs: number | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      BIN,
      args,
      { encoding: 'utf8', timeout: timeoutMs ?? 0, windowsHide: true, maxBuffer: 32 << 20 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout)
        const out = `${asString(stdout)}${asString(stderr)}`.trim()
        let code: string | undefined
        let message = out || err.message
        try {
          const e = (JSON.parse(out) as { error?: { code?: string; message?: string } }).error
          code = e?.code
          message = e?.message ?? message
        } catch {}
        reject(new HerdrError(args, code, message))
      },
    )
  })
}

/** Run a herdr command and return the `result` of its JSON answer (null for commands that print nothing). */
export async function herdr<T = unknown>(args: string[], timeoutMs = 30_000): Promise<T> {
  const out = await run(args, timeoutMs)
  return (out.trim() ? (JSON.parse(out) as { result: T }).result : null) as T
}

/** Run a herdr command that prints plain text (pane read, agent read). */
export function herdrText(args: string[], timeoutMs = 30_000): Promise<string> {
  return run(args, timeoutMs)
}

/** Workspaces, tabs, panes and agents in one call. */
export async function snapshot(): Promise<HerdrSnapshot> {
  return (await herdr<{ snapshot: HerdrSnapshot }>(['api', 'snapshot'])).snapshot
}

/** What `herdr agent get` says about a pane's agent. */
export interface HerdrAgent {
  /** The agent kind ('claude', ...). */
  kind: string | null
  /** herdr's status; anything it does not know is 'unknown'. */
  status: AgentStatus
  /** The Claude session id the pane hosts, if herdr knows one. */
  session: string | null
  /** herdr's name for the agent, if it has one. */
  name: string | null
}

/** `value[key]` when it is a string, else null. */
const stringAt = (value: unknown, key: string): string | null =>
  isRecord(value) && typeof value[key] === 'string' ? value[key] : null

/** The agent in a pane, or null when the pane has none. */
export async function agentGet(pane: string, timeoutMs = 30_000): Promise<HerdrAgent | null> {
  const answer = await herdr(['agent', 'get', pane], timeoutMs)
  const agent = isRecord(answer) ? answer.agent : null
  if (!isRecord(agent)) return null
  return {
    kind: stringAt(agent, 'agent'),
    status: isAgentStatus(agent.agent_status) ? agent.agent_status : 'unknown',
    session: stringAt(agent.agent_session, 'value'),
    name: stringAt(agent, 'name'),
  }
}

/** The names herdr's agents go by. */
export async function agentNames(): Promise<Set<string>> {
  const answer = await herdr(['agent', 'list'])
  const agents = isRecord(answer) && Array.isArray(answer.agents) ? answer.agents : []
  return new Set(agents.map(a => stringAt(a, 'name')).filter((name): name is string => !!name))
}

/** A new workspace: its id, and the tab and pane it comes with. */
export async function workspaceCreate(
  cwd: string,
  label: string,
): Promise<{ id: string; tab: string | null; pane: string | null }> {
  const args = ['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus']
  const answer = await herdr(args)
  const id = isRecord(answer) ? stringAt(answer.workspace, 'workspace_id') : null
  if (!isRecord(answer) || !id) throw new HerdrError(args, undefined, 'no workspace in its answer')
  return { id, tab: stringAt(answer.tab, 'tab_id'), pane: stringAt(answer.root_pane, 'pane_id') }
}

/** A new tab in a workspace; returns the pane it comes with. */
export async function tabCreate(workspace: string, cwd: string, label: string): Promise<string> {
  const args = ['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label, '--no-focus']
  const answer = await herdr(args)
  const pane = isRecord(answer) ? stringAt(answer.root_pane, 'pane_id') : null
  if (!pane) throw new HerdrError(args, undefined, 'no pane in its answer')
  return pane
}

/** The tab a pane is in, or null when herdr does not say. */
export async function paneTab(pane: string): Promise<string | null> {
  const answer = await herdr(['pane', 'get', pane])
  return isRecord(answer) ? stringAt(answer.pane, 'tab_id') : null
}

/** A workspace's panes: the tab each is in and the agent it runs (null for a shell). */
export async function workspacePanes(
  workspace: string,
): Promise<{ pane: string | null; tab: string | null; agent: string | null }[]> {
  const answer = await herdr(['pane', 'list', '--workspace', workspace])
  const panes = isRecord(answer) && Array.isArray(answer.panes) ? answer.panes : []
  return panes.map(p => ({ pane: stringAt(p, 'pane_id'), tab: stringAt(p, 'tab_id'), agent: stringAt(p, 'agent') }))
}

/** herdr's workspaces: id, label, and whether it has the focus. */
export async function workspaceList(
  timeoutMs?: number,
): Promise<{ id: string; label: string | undefined; focused: boolean }[]> {
  const answer = await herdr(['workspace', 'list'], timeoutMs)
  const list = isRecord(answer) && Array.isArray(answer.workspaces) ? answer.workspaces : []
  return list.flatMap(w => {
    const id = stringAt(w, 'workspace_id')
    return id ? [{ id, label: stringAt(w, 'label') ?? undefined, focused: isRecord(w) && !!w.focused }] : []
  })
}
