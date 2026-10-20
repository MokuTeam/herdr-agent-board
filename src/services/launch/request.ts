// A launch request from the new-session window, checked before anything runs: the name, a folder
// that is there, a lane the board has, a workspace herdr takes, the first message, a branch, the
// Claude profile it starts in, refused when the board cannot be sure of it, and the agent it
// starts as (core/launch/agents.ts), one the board offers.
import { resolvePath } from '../../adapters/files.ts'
import { SLOW, statOf } from '../../adapters/folders.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { t } from '../../core/lang.ts'
import { CLAUDE_AGENT, type LaunchAgent, type LaunchAgentId, piCommand } from '../../core/launch/agents.ts'
import { checkBranch, checkName, NAME_MAX, UNSAFE_CHARS } from '../../core/launch/names.ts'
import { profileCommand } from '../../core/launch/spawn-args.ts'
import { type LaunchTarget, launchTarget, type ProfileSet } from '../../core/profiles.ts'
import type { Item, Vars } from '../../core/types.ts'

const MESSAGE_MAX = 20_000
const WORKSPACE_ID = /^[A-Za-z0-9][\w:-]{0,39}$/
const CATEGORY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** A workspace name herdr takes as a value: no control characters, no leading dash. */
const workspaceName = (s: string, max: number): boolean =>
  !!s && s.length <= max && !UNSAFE_CHARS.test(s) && !s.startsWith('-')

/** A value the request gives: undefined when it is left out or empty. */
const given = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v))

/** What a checked request asks for. `newWorkspace`: make the workspace `workspaceLabel` first. */
export interface LaunchRequest {
  /** A Codex fork selected by the server, independently of the new-session agent picker. */
  codexFork?: true
  name: string
  label: string
  cwd: string
  category: string
  workspaceId: string
  workspaceLabel: string
  newWorkspace: boolean
  message: string
  worktree: { branch: string } | null
  /** The id of the Claude profile it starts in, and that profile's folder. */
  profile: string
  profileDir: string
  /** CLAUDE_CONFIG_DIR for the start; null leaves the env as the board inherited it (its own profile). */
  configDir: string | null
  /** The key of the card it was started from ("New here"), whose profile it keeps; null for none. */
  parent: string | null
  /** The profile's own Claude arguments. */
  profileArgs: string[]
  /** The profile's start command, typed instead of `launch.claude`; null for none, or a launcher that types none. */
  profileCommand: string[] | null
  /** The agent the board's own launcher starts: the one the request picked, else the board's default. */
  agent: LaunchAgentId | 'codex'
}

export type CheckResult = { ok: true; launch: LaunchRequest } | { ok: false; field: string; error: string }

/** A card a start keeps the profile of, as the server hands it in: its key, its name and what tells its profile. */
export type ParentFacts = { key: string } & Pick<Item, 'name' | 'profile' | 'profileFolder' | 'profileWanted'>

/**
 * Check a launch request: { ok, launch }, or { ok: false, field, error } for the field at fault.
 * `profiles`: the board's; `items`: the board now, for the session a "New here" names;
 * `typesCommand`: the launcher types a command into the tab (the board's own spawn-agent), so the
 * profile's start command is read and checked; other launchers never read it. `parent`: the card
 * the start keeps the profile of, given by the server in place of the body's (a session coming
 * back from the archive, which is not among the board's items). `agents`: the agents a start may
 * pick (core/launch/agents.ts launchAgents), asked only when the request names one or `standard`
 * asks; `standard`: the agent of a request that names none (agents.ts defaultAgent), Claude Code
 * when not given; `pi`: config's `launch.pi`, checked when pi is the one.
 */
export async function checkRequest(
  body: unknown,
  {
    categories = null,
    profiles,
    items = [],
    typesCommand = false,
    parent: heldTo,
    agents = () => [],
    standard = () => CLAUDE_AGENT,
    pi,
    codexFork,
  }: {
    categories?: Set<string> | null
    items?: Item[]
    typesCommand?: boolean
    parent?: ParentFacts
    agents?: () => readonly LaunchAgent[]
    standard?: (offered: () => readonly LaunchAgent[]) => LaunchAgentId
    pi?: unknown
  } & ({ codexFork: true; profiles?: never } | { codexFork?: never; profiles: ProfileSet }),
): Promise<CheckResult> {
  const fail = (field: string, key: string, vars?: Vars): CheckResult => ({ ok: false, field, error: t(key, vars) })
  const b = isRecord(body) ? body : {}
  const name = String(b.name ?? '').trim()
  const bad = checkName(name)
  if (bad) return fail('name', bad, { max: NAME_MAX })
  const { path: cwd } = resolvePath(b.cwd)
  if (!cwd) return fail('cwd', 'launch.err.cwdEmpty')
  const st = await statOf(cwd, 3000)
  if (st === SLOW) return fail('cwd', 'launch.err.cwdSlow', { path: cwd })
  if (!st) return fail('cwd', 'launch.err.cwdMissing', { path: cwd })
  if (!st.isDirectory()) return fail('cwd', 'launch.err.cwdFile', { path: cwd })
  // A lane the board has (configured, or one an agent made), or "other" when none was given.
  const category = String(b.category ?? '') || 'other'
  if (!CATEGORY_ID.test(category) || (categories && category !== 'other' && !categories.has(category)))
    return fail('category', 'launch.err.category', { id: category })
  const ws = isRecord(b.workspace) ? b.workspace : {}
  let workspaceId = ''
  let workspaceLabel = ''
  if (ws.id) {
    if (!WORKSPACE_ID.test(String(ws.id))) return fail('workspace', 'launch.err.workspace')
    workspaceId = String(ws.id)
    workspaceLabel = String(ws.label ?? '').trim()
    if (workspaceLabel && !workspaceName(workspaceLabel, 60)) workspaceLabel = ''
  } else {
    workspaceLabel = String(ws.create ?? '').trim()
    if (!workspaceName(workspaceLabel, 40)) return fail('workspace', 'launch.err.workspaceName')
  }
  const message = String(b.message ?? '').trim()
  if (message.length > MESSAGE_MAX) return fail('message', 'launch.err.message', { n: MESSAGE_MAX })
  let worktree: LaunchRequest['worktree'] = null
  if (b.worktree) {
    const branch = String((isRecord(b.worktree) ? b.worktree.branch : undefined) ?? '').trim()
    const why = checkBranch(branch)
    if (why) return fail('worktree', why)
    worktree = { branch }
  }
  // The profile: the one chosen, or the parent's. A parent the board does not have now is one
  // whose profile it does not know, unless the server hands it in.
  const parent = heldTo?.key ?? given(b.parent) ?? null
  const from = heldTo ?? (parent === null ? undefined : items.find(i => i.key === parent))
  const parentName = from?.name || parent || ''
  const common = {
    name,
    label: name,
    cwd,
    category,
    workspaceId,
    workspaceLabel,
    newWorkspace: !workspaceId,
    message,
    worktree,
    parent,
  }
  if (codexFork)
    return {
      ok: true,
      launch: {
        ...common,
        codexFork,
        agent: 'codex',
        profile: '',
        profileDir: '',
        configDir: null,
        profileArgs: [],
        profileCommand: null,
      },
    }
  const target = launchTarget(
    given(b.profile),
    parent === null ? null : (from ?? { name: parentName, profile: null }),
    profiles,
  )
  if (!target.ok) return fail('profile', ...refusal(target, parentName, profiles))
  const { profile, configDir } = target
  // A folder to set must be there: Claude would make a new, empty profile of it.
  if (configDir !== null) {
    const st = await statOf(configDir, 3000)
    if (!st || st === SLOW || !st.isDirectory())
      return fail('profile', 'launch.err.profileFolder', { title: profile.title, path: configDir })
  }
  // The profile's start command, for a launcher that types one: a bad one is refused here, before
  // a worktree, a workspace or a tab.
  let profileCommandWords: string[] | null = null
  if (typesCommand) {
    try {
      profileCommandWords = profileCommand(profile.command)
    } catch (err) {
      return { ok: false, field: 'profile', error: err instanceof Error ? err.message : String(err) }
    }
  }
  // The agent: the one the request names, which the board must offer; else the board's default.
  // pi's command must be one the tab's shell can type.
  let agent: LaunchAgentId
  const asked = given(b.agent)
  if (asked !== undefined) {
    const offered = agents()
    const pick = offered.find(a => a.id === asked)
    if (!pick) return fail('agent', offered.length ? 'launch.err.agent' : 'launch.err.agentLauncher', { id: asked })
    agent = pick.id
  } else agent = standard(agents)
  if (agent !== CLAUDE_AGENT)
    try {
      piCommand(pi)
    } catch (err) {
      return { ok: false, field: 'agent', error: err instanceof Error ? err.message : String(err) }
    }
  return {
    ok: true,
    launch: {
      ...common,
      profile: profile.id,
      profileDir: profile.dir,
      configDir,
      profileArgs: (profile.args ?? []).filter((a): a is string => typeof a === 'string'),
      profileCommand: profileCommandWords,
      agent,
    },
  }
}

/** The text and its values for a profile a launch is refused. */
function refusal(target: Extract<LaunchTarget, { ok: false }>, name: string, profiles: ProfileSet): [string, Vars] {
  const title = profiles.list.find(p => p.id === target.id)?.title ?? target.id
  switch (target.error) {
    case 'choose':
      return ['launch.err.profileChoose', {}]
    case 'hidden':
      return ['launch.err.profileHidden', { title }]
    case 'missing':
      return ['err.profile.missing', { id: target.id }]
    case 'parent':
      return ['launch.err.profileParent', { name, title }]
    case 'unknownParent':
      return ['launch.err.profileUnknown', { name }]
  }
}
