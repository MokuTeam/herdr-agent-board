// New sessions' calls (src/server/routes/launch.ts and the folder picker's POST /api/fs/dirs): what
// the window offers, folders, starting one and what its card's buttons do. Answers are narrowed
// before use; the folder picker and the options read any answer's body, as the old page did.
import type { Translator } from '../../../src/core/types.ts'
import type { DirListing, LauncherInfo } from '../models/launch.ts'
import type { AgentOption } from '../models/launch-agent.ts'
import type { StartBody, WorkspaceOption } from '../models/launch-form.ts'
import { ApiError, api, errorText, isReply, postJson } from './client.ts'

/** What the window offers (GET /api/launch/options). */
export interface LaunchOptions {
  launcher: LauncherInfo
  /** The agents a start may pick (Claude Code first); none from a board before the choice, or a launcher of the config's own. */
  agents: AgentOption[]
  /** The one a start that names none starts as: the board's default. */
  agent: string
  workspaces: WorkspaceOption[]
  /** The workspace herdr has the focus in. */
  focused: string
  /** The board's own workspace, never offered. */
  board: string
  /** Folders of recent Claude sessions. */
  recent: string[]
  /** The setup's ticket conventions: linked workspaces, -wt/<ticket> paths, case- names. */
  linkedWorkspaces: boolean
}

/** What the window offers before the server said: herdr opening Claude, nothing else. */
export const NO_OPTIONS: LaunchOptions = {
  launcher: { kind: 'herdr', agent: 'claude' },
  agents: [],
  agent: 'claude',
  workspaces: [],
  focused: '',
  board: '',
  recent: [],
  linkedWorkspaces: false,
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(v => typeof v === 'string') : [])

function launcherOf(value: unknown): LauncherInfo | null {
  if (!isReply(value)) return null
  if (value.kind === 'command') return { kind: 'command', name: text(value.name) ?? '' }
  const agent = text(value.agent)
  return agent === undefined ? null : { kind: 'herdr', agent }
}

const isAgent = (value: unknown): value is AgentOption =>
  isReply(value) && typeof value.id === 'string' && !!value.id && typeof value.title === 'string'

export function asOptions(value: unknown): LaunchOptions | null {
  if (!isReply(value) || !Array.isArray(value.workspaces)) return null
  const launcher = launcherOf(value.launcher)
  if (!launcher) return null
  return {
    launcher,
    agents: Array.isArray(value.agents) ? value.agents.filter(isAgent).map(a => ({ id: a.id, title: a.title })) : [],
    agent: text(value.agent) ?? 'claude',
    workspaces: value.workspaces.filter(isReply).map(w => ({ id: String(w.id ?? ''), label: text(w.label) })),
    focused: text(value.focused) ?? '',
    board: text(value.board) ?? '',
    recent: strings(value.recent),
    linkedWorkspaces: value.linkedWorkspaces === true,
  }
}

const isRoot = (value: unknown): value is { name: string; path: string } =>
  isReply(value) && typeof value.name === 'string' && typeof value.path === 'string'

/** A folder listing as far as the window reads it; what is missing stays missing. */
export function asListing(value: unknown): DirListing | null {
  if (!isReply(value)) return null
  const out: DirListing = {}
  if (typeof value.path === 'string') out.path = value.path
  if (typeof value.exists === 'boolean') out.exists = value.exists
  if (typeof value.dir === 'boolean') out.dir = value.dir
  if (typeof value.slow === 'boolean') out.slow = value.slow
  if (Array.isArray(value.roots)) out.roots = value.roots.filter(isRoot)
  if (Array.isArray(value.entries)) out.entries = strings(value.entries)
  if (typeof value.sep === 'string') out.sep = value.sep
  if (typeof value.error === 'string' || value.error === null) out.error = value.error
  if (value.git === null) out.git = null
  else if (isReply(value.git) && typeof value.git.root === 'string' && typeof value.git.branch === 'string')
    out.git = { root: value.git.root, branch: value.git.branch }
  return out
}

/** A POST's outcome as the window and the cards read it: the error to show, the field it is about. */
export type LaunchReply = { ok: true; id: string } | { ok: false; error: string; field: string }

async function post(path: string, body: unknown, t: Translator): Promise<LaunchReply> {
  try {
    const r = await api.post(path, body)
    return { ok: true, id: text(r.id) ?? '' }
  } catch (err) {
    return { ok: false, error: errorText(err, t), field: err instanceof ApiError ? (text(err.reply.field) ?? '') : '' }
  }
}

const launchPath = (id: string, what: string) => `/api/launch/${encodeURIComponent(id)}/${what}`

export const launchApi = {
  /** null when the server could not say (the window works without it). */
  options: (): Promise<LaunchOptions | null> =>
    fetch('/api/launch/options')
      .then(r => r.json())
      .then(asOptions)
      .catch(() => null),
  /** The folders in `path` ('' the roots); `git`: also the checkout it is in. null when there is no answer. */
  dirs: (path: string, git: boolean): Promise<DirListing | null> =>
    postJson('/api/fs/dirs', { path, git })
      .then(r => r.json())
      .then(asListing)
      .catch(() => null),
  start: (body: StartBody, t: Translator): Promise<LaunchReply> => post('/api/launch', body, t),
  dismiss: (id: string, t: Translator): Promise<LaunchReply> => post(launchPath(id, 'dismiss'), {}, t),
  trust: (id: string, t: Translator): Promise<LaunchReply> => post(launchPath(id, 'trust'), {}, t),
  closeTab: (id: string, t: Translator): Promise<LaunchReply> => post(launchPath(id, 'close'), {}, t),
}

export type LaunchApi = typeof launchApi

/** Goes to a launch's tab in herdr; that needs fresh data. */
export async function focusLaunch(
  id: string,
  { t, canMutate, toast }: { t: Translator; canMutate: boolean; toast(text: string, error?: boolean): void },
): Promise<void> {
  if (!canMutate) return toast(t('mobile.readOnly'), true)
  try {
    await api.post(launchPath(id, 'focus'), {})
  } catch (err) {
    toast(errorText(err, t), true)
  }
}
