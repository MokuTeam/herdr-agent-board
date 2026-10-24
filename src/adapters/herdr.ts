// Thin async wrapper over the herdr CLI. HERDR_BIN_PATH hides the socket transport
// (Unix socket or Windows named pipe), so plugins should call herdr through it.
import { execFile } from 'node:child_process'
import { isAgentStatus } from '../core/board.ts'
import type { PaneProcesses } from '../core/board-pane.ts'
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
  /** The terminal the pane holds: herdr gives a pane's id out again after it starts over, never a terminal's. */
  terminal_id?: string
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

/** `env`: herdr's environment instead of this process's. */
function run(args: string[], timeoutMs: number | undefined, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      BIN,
      args,
      { encoding: 'utf8', timeout: timeoutMs ?? 0, windowsHide: true, maxBuffer: 32 << 20, ...(env && { env }) },
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

/** `record` (a copy of herdr's) without those of `keys` whose value is not a string. */
function stringsOnly<T extends Record<string, unknown>>(record: T, keys: readonly string[]): T {
  for (const key of keys) if (key in record && typeof record[key] !== 'string') Reflect.deleteProperty(record, key)
  return record
}

const PANE_STRINGS = [
  'tab_id',
  'workspace_id',
  'agent',
  'agent_status',
  'cwd',
  'label',
  'terminal_title_stripped',
  'terminal_id',
]

/** A pane in herdr's answers as the board reads it (asSnapshot's); null without a `pane_id`. */
export function asPane(v: unknown): HerdrPane | null {
  if (!isRecord(v) || typeof v.pane_id !== 'string') return null
  const pane: HerdrPane = stringsOnly({ ...v, pane_id: v.pane_id }, PANE_STRINGS)
  const session = pane.agent_session
  if (isRecord(session))
    pane.agent_session = { ...session, value: typeof session.value === 'string' ? session.value : null }
  else delete pane.agent_session
  if (!isRecord(pane.tokens)) delete pane.tokens
  return pane
}

function asWorkspace(v: unknown): HerdrWorkspace | null {
  if (!isRecord(v) || typeof v.workspace_id !== 'string') return null
  return stringsOnly({ ...v, workspace_id: v.workspace_id }, ['label'])
}

function asTab(v: unknown): HerdrTab | null {
  if (!isRecord(v) || typeof v.tab_id !== 'string' || typeof v.workspace_id !== 'string') return null
  return { ...v, tab_id: v.tab_id, workspace_id: v.workspace_id }
}

const listOf = <T>(v: unknown, as: (item: unknown) => T | null): T[] =>
  Array.isArray(v) ? v.map(as).filter((item): item is T => item !== null) : []

/**
 * herdr's `api snapshot` answer as the board reads it: its workspaces, tabs and panes that have
 * an id, each field of the type the board takes (others dropped); unknown fields kept.
 */
export function asSnapshot(result: unknown): HerdrSnapshot {
  const snap = isRecord(result) ? result.snapshot : null
  if (!isRecord(snap)) throw new Error('herdr api snapshot: no snapshot in its answer')
  return stringsOnly(
    {
      ...snap,
      workspaces: listOf(snap.workspaces, asWorkspace),
      tabs: listOf(snap.tabs, asTab),
      panes: listOf(snap.panes, asPane),
    },
    ['focused_pane_id'],
  )
}

/** Workspaces, tabs, panes and agents in one call. */
export async function snapshot(): Promise<HerdrSnapshot> {
  return asSnapshot(await herdr(['api', 'snapshot']))
}

/** Every pane in a snapshot, with the terminal it holds (null when herdr did not say). */
export function paneTerminals(snap: Pick<HerdrSnapshot, 'panes'>): Map<string, string | null> {
  return new Map(snap.panes.map(p => [p.pane_id, p.terminal_id || null]))
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

/** herdr's `agent get` answer as the board reads it; null when the pane has no agent. */
export function asAgent(answer: unknown): HerdrAgent | null {
  const agent = isRecord(answer) ? answer.agent : null
  if (!isRecord(agent)) return null
  return {
    kind: stringAt(agent, 'agent'),
    status: isAgentStatus(agent.agent_status) ? agent.agent_status : 'unknown',
    session: stringAt(agent.agent_session, 'value'),
    name: stringAt(agent, 'name'),
  }
}

/** The agent in a pane, or null when the pane has none. */
export async function agentGet(pane: string, timeoutMs = 30_000): Promise<HerdrAgent | null> {
  return asAgent(await herdr(['agent', 'get', pane], timeoutMs))
}

const isPid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

/**
 * herdr's `pane process-info` answer as the board reads it: the pane's own process (`shell_pid`) and
 * the foreground ones with a pid, each with its argv (its `cmdline` when there is no argv, else
 * nothing). Null without the pane's own process: nothing to go by.
 */
export function asPaneProcesses(answer: unknown): PaneProcesses | null {
  const info = isRecord(answer) ? answer.process_info : null
  if (!isRecord(info) || !isPid(info.shell_pid)) return null
  const list = Array.isArray(info.foreground_processes) ? info.foreground_processes : []
  const foreground = list.flatMap(p => {
    if (!isRecord(p) || !isPid(p.pid)) return []
    const argv = Array.isArray(p.argv) ? p.argv.filter((a): a is string => typeof a === 'string') : []
    const args = argv.length ? argv : typeof p.cmdline === 'string' && p.cmdline ? [p.cmdline] : []
    return [{ pid: p.pid, args }]
  })
  return { shell: info.shell_pid, foreground }
}

/** What runs in a pane (herdr 0.9.5 and newer); null when herdr's answer says nothing to go by. */
export async function paneProcesses(pane: string, timeoutMs = 10_000): Promise<PaneProcesses | null> {
  return asPaneProcesses(await herdr(['pane', 'process-info', '--pane', pane], timeoutMs))
}

/** The names herdr's agents go by. */
export async function agentNames(): Promise<Set<string>> {
  const answer = await herdr(['agent', 'list'])
  const agents = isRecord(answer) && Array.isArray(answer.agents) ? answer.agents : []
  return new Set(agents.map(a => stringAt(a, 'name')).filter((name): name is string => !!name))
}

/** `--env KEY=VALUE` for each entry (herdr 0.9.5 and newer); nothing without any. */
const envArgs = (env: Readonly<Record<string, string>> | undefined): string[] =>
  Object.entries(env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`])

/**
 * A new workspace: its id, and the tab and pane it comes with, with the terminal that pane holds
 * (herdr gives a pane id out again after it starts over, never a terminal's); `env` is added to
 * its shell's.
 */
export async function workspaceCreate(
  cwd: string,
  label: string,
  env?: Readonly<Record<string, string>>,
): Promise<{ id: string; tab: string | null; pane: string | null; terminal: string | null }> {
  const args = ['workspace', 'create', '--cwd', cwd, '--label', label, ...envArgs(env), '--no-focus']
  const answer = await herdr(args)
  const id = isRecord(answer) ? stringAt(answer.workspace, 'workspace_id') : null
  if (!isRecord(answer) || !id) throw new HerdrError(args, undefined, 'no workspace in its answer')
  return {
    id,
    tab: stringAt(answer.tab, 'tab_id'),
    pane: stringAt(answer.root_pane, 'pane_id'),
    terminal: stringAt(answer.root_pane, 'terminal_id'),
  }
}

/** A worktree herdr opened: the workspace it links, its first tab and pane, and whether it was already open. */
export interface HerdrWorktree {
  id: string
  tab: string | null
  pane: string | null
  terminal: string | null
  alreadyOpen: boolean
  label: string
}

function asWorktree(answer: unknown, args: string[]): HerdrWorktree {
  const record = isRecord(answer) ? answer : null
  const workspace = record && isRecord(record.workspace) ? record.workspace : null
  const id = workspace ? stringAt(workspace, 'workspace_id') : null
  if (!workspace || !id) throw new HerdrError(args, undefined, 'no workspace in its answer')
  return {
    id,
    tab: stringAt(record?.tab, 'tab_id'),
    pane: stringAt(record?.root_pane, 'pane_id'),
    terminal: stringAt(record?.root_pane, 'terminal_id'),
    alreadyOpen: record?.already_open === true,
    label: stringAt(workspace, 'label') ?? '',
  }
}

/** Open the workspace of an existing checkout, linked to its repository (no --env). */
export async function worktreeOpen(cwd: string, path: string, label: string): Promise<HerdrWorktree> {
  const args = ['worktree', 'open', '--cwd', cwd, '--path', path, '--label', label, '--no-focus']
  return asWorktree(await herdr(args), args)
}

/** Create a worktree and open its linked workspace (no --env), based on `base`. */
export async function worktreeCreate(
  cwd: string,
  branch: string,
  base: string,
  path: string,
  label: string,
): Promise<HerdrWorktree> {
  const args = [
    'worktree',
    'create',
    '--cwd',
    cwd,
    '--branch',
    branch,
    '--base',
    base,
    '--path',
    path,
    '--label',
    label,
    '--no-focus',
  ]
  return asWorktree(await herdr(args), args)
}

/** A workspace's new name, in herdr's sidebar and for every pane in it. */
export async function workspaceRename(workspace: string, label: string): Promise<void> {
  await herdr(['workspace', 'rename', workspace, label])
}

/** A new tab in a workspace, `env` added to its shell's; returns the pane it comes with. */
export async function tabCreate(
  workspace: string,
  cwd: string,
  label: string,
  env?: Readonly<Record<string, string>>,
): Promise<string> {
  return (await tabCreateRoot(workspace, cwd, label, env)).pane
}

/** tabCreate, with the terminal the new pane holds (null when herdr does not say). */
export async function tabCreateRoot(
  workspace: string,
  cwd: string,
  label: string,
  env?: Readonly<Record<string, string>>,
): Promise<{ pane: string; terminal: string | null }> {
  const args = [
    'tab',
    'create',
    '--workspace',
    workspace,
    '--cwd',
    cwd,
    '--label',
    label,
    ...envArgs(env),
    '--no-focus',
  ]
  const answer = await herdr(args)
  const pane = isRecord(answer) ? stringAt(answer.root_pane, 'pane_id') : null
  if (!isRecord(answer) || !pane) throw new HerdrError(args, undefined, 'no pane in its answer')
  return { pane, terminal: stringAt(answer.root_pane, 'terminal_id') }
}

/**
 * herdr's Claude integration (its own SessionStart hook, from which herdr learns the session a
 * pane runs) into the Claude profile folder `dir`: herdr writes it into the folder
 * CLAUDE_CONFIG_DIR names, so that is `dir` and the rest of the environment this process's.
 * What herdr printed.
 */
export function claudeIntegrationInstall(dir: string, timeoutMs = 30_000): Promise<string> {
  return run(['integration', 'install', 'claude'], timeoutMs, { ...process.env, CLAUDE_CONFIG_DIR: dir })
}

/** Codex's own identity hook, in the same CODEX_HOME as the board's Codex hooks. */
export function codexIntegrationInstall(dir: string, timeoutMs = 30_000): Promise<string> {
  return run(['integration', 'install', 'codex'], timeoutMs, { ...process.env, CODEX_HOME: dir })
}

/** A herdr notification with its "request" sound; what herdr prints is not read. */
export async function notify(title: string, body: string): Promise<void> {
  await run(['notification', 'show', title, '--body', body, '--sound', 'request'], 10_000)
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
