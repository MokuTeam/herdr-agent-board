// A launch request from the new-session window, checked before anything runs: the name, a folder
// that is there, a lane the board has, a workspace herdr takes, the first message, a branch, the
// Claude profile it starts in, refused when the board cannot be sure of it, and the agent it
// starts as (core/launch/agents.ts), one the board offers, and the model it starts on, if one is
// asked for (core/launch/model.ts): empty is the profile's default.
import { cachedCodexModels } from '../../adapters/codex-home.ts'
import { resolvePath } from '../../adapters/files.ts'
import { SLOW, statOf } from '../../adapters/folders.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { LANE_ID } from '../../core/categories.ts'
import { CODEX_AGENT } from '../../core/codex.ts'
import { t } from '../../core/lang.ts'
import {
  AGY_AGENT,
  agyCommand,
  CLAUDE_AGENT,
  type LaunchAgent,
  type LaunchAgentId,
  piCommand,
} from '../../core/launch/agents.ts'
import { MODEL_MAX, readModel } from '../../core/launch/model.ts'
import { checkBranch, checkName, NAME_MAX, UNSAFE_CHARS } from '../../core/launch/names.ts'
import { profileCommand } from '../../core/launch/spawn-args.ts'
import { DEVICE_ID, LOCAL } from '../../core/nodes.ts'
import { PI_AGENT } from '../../core/pi.ts'
import { type LaunchTarget, launchTarget, type ProfileSet } from '../../core/profiles.ts'
import type { Item, Vars } from '../../core/types.ts'

const MESSAGE_MAX = 20_000
const WORKSPACE_ID = /^[A-Za-z0-9][\w:-]{0,39}$/

/** A workspace name herdr takes as a value: no control characters, no leading dash. */
const workspaceName = (s: string, max: number): boolean =>
  !!s && s.length <= max && !UNSAFE_CHARS.test(s) && !s.startsWith('-')

/** A tab label herdr takes: no control characters, no leading dash, 60 characters at most; '' when not one. */
const labelOf = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim() : ''
  return workspaceName(s, 60) ? s : ''
}

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
  /** True when `profile` is already the target node's own profile id (#675), not a master profile. */
  nodeProfile?: true
  /** The key of the card it was started from ("New here"), whose profile it keeps; null for none. */
  parent: string | null
  /** The profile's own Claude arguments. */
  profileArgs: string[]
  /** The profile's start command, typed instead of `launch.claude`; null for none, or a launcher that types none. */
  profileCommand: string[] | null
  /** The agent the board's own launcher starts: the one the request picked, else the board's default. */
  agent: LaunchAgentId
  /** The model it starts on (`--model`), null for the profile's default. */
  model: string | null
  /** "Where" (#504): a device or a tag it must run on. Read only while config.json has `nodes`; absent when not given. */
  pin?: LaunchPin
  /**
   * The device whose folder `cwd` is (#504): a start pinned to a node with a folder of that node,
   * which this computer does not have. Absent for a folder of this computer.
   */
  remote?: string
  /** Codex's reasoning effort (`-c model_reasoning_effort=…`), one its model supports. */
  effort?: string
  /**
   * spawn-agent --trust (#798): the board that runs it answers Claude's folder-trust dialog for the
   * launch's own folder instead of asking on its card. Read only while the board places.
   */
  trust?: true
}

/** "Where" in a launch request (#504): a device of `nodes` (`local` for this computer), or a tag. */
export type LaunchPin = { device: string } | { tag: string }

const TAG = /^[A-Za-z0-9][\w.-]{0,63}$/

/** A request's `pin`, or undefined when it is not one. */
function pinOf(v: unknown): LaunchPin | undefined {
  if (!isRecord(v)) return undefined
  const keys = Object.keys(v)
  if (keys.length !== 1) return undefined
  if (typeof v.device === 'string' && (v.device === LOCAL || DEVICE_ID.test(v.device))) return { device: v.device }
  if (typeof v.tag === 'string' && TAG.test(v.tag)) return { tag: v.tag }
  return undefined
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
 * when not given; `pi`: config's `launch.pi`, checked when pi is the one. `pins`: config.json has
 * `nodes` (#504), so the request's `pin` is read, and a folder this computer lacks is taken as the
 * pinned node's; without it neither is looked at.
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
    agy,
    pins = false,
    remote: forcedRemote,
    nodeProfile: isNodeProfile = false,
    anyPin = false,
    codexFork,
  }: {
    categories?: Set<string> | null
    items?: Item[]
    typesCommand?: boolean
    parent?: ParentFacts
    agents?: () => readonly LaunchAgent[]
    standard?: (offered: () => readonly LaunchAgent[]) => LaunchAgentId
    pi?: unknown
    agy?: unknown
    pins?: boolean
    remote?: string
    nodeProfile?: boolean
    /**
     * A node's own start (#760): `remote` is the folder's device whatever the pin says, as the
     * placer may still send the start elsewhere by the folder's checkout.
     */
    anyPin?: boolean
  } & ({ codexFork: true; profiles?: never } | { codexFork?: never; profiles: ProfileSet }),
): Promise<CheckResult> {
  const fail = (field: string, key: string, vars?: Vars): CheckResult => ({ ok: false, field, error: t(key, vars) })
  const b = isRecord(body) ? body : {}
  const name = String(b.name ?? '').trim()
  const bad = checkName(name)
  if (bad) return fail('name', bad, { max: NAME_MAX })
  let pin: LaunchPin | undefined
  if (pins && b.pin !== undefined && b.pin !== null) {
    pin = pinOf(b.pin)
    if (!pin) return fail('pin', 'launch.err.pin')
  }
  let cwd = ''
  let remote: string | undefined
  if (pins && forcedRemote && (anyPin || (pin && 'device' in pin && pin.device === forcedRemote))) {
    // A node's own folder (#675): never resolved or stat'd on the master, even when the same path exists here.
    cwd = String(b.cwd ?? '').trim()
    if (!cwd) return fail('cwd', 'launch.err.cwdEmpty')
    remote = forcedRemote
  } else {
    cwd = resolvePath(b.cwd).path
    if (!cwd) return fail('cwd', 'launch.err.cwdEmpty')
    const st = await statOf(cwd, 3000)
    if (st === SLOW) return fail('cwd', 'launch.err.cwdSlow', { path: cwd })
    if (!st && pin && 'device' in pin && pin.device !== LOCAL) {
      // A folder of the pinned node, as that node names it: taken as written, never resolved here.
      remote = pin.device
      cwd = String(b.cwd).trim()
    } else if (!st) return fail('cwd', 'launch.err.cwdMissing', { path: cwd })
    else if (!st.isDirectory()) return fail('cwd', 'launch.err.cwdFile', { path: cwd })
  }
  // A lane the board has (configured, or one an agent made), or "other" when none was given.
  const category = String(b.category ?? '') || 'other'
  if (!LANE_ID.test(category) || (categories && category !== 'other' && !categories.has(category)))
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
  // A model as Claude or pi takes it on its command line; blank is the profile's default.
  const read = readModel(b.model)
  if (!read.ok)
    return fail('model', read.why === 'long' ? 'launch.err.modelLong' : 'launch.err.model', { max: MODEL_MAX })
  const model = read.model
  let worktree: LaunchRequest['worktree'] = null
  if (b.worktree) {
    const branch = String((isRecord(b.worktree) ? b.worktree.branch : undefined) ?? '').trim()
    const why = checkBranch(branch)
    if (why) return fail('worktree', why)
    worktree = { branch }
  }
  // The profile: the one chosen, or the parent's. A parent the board does not have now is one
  // whose profile it does not know, unless the server hands it in. Antigravity does not use
  // Claude profiles, so an explicit agy launch/resume without a profile is not blocked by
  // multi-profile disambiguation.
  const parent = heldTo?.key ?? given(b.parent) ?? null
  const from = heldTo ?? (parent === null ? undefined : items.find(i => i.key === parent))
  const parentName = from?.name || parent || ''
  const common = {
    name,
    // A spawn-agent start's tab label (#505), read only while the board places; else the name, as before.
    label: (pins && labelOf(b.label)) || name,
    cwd,
    category,
    workspaceId,
    workspaceLabel,
    newWorkspace: !workspaceId,
    message,
    worktree,
    parent,
    ...(pins && b.trust === true && { trust: true as const }),
  }
  const none = { profile: '', profileDir: '', configDir: null, profileArgs: [], profileCommand: null }
  if (codexFork) return { ok: true, launch: { ...common, codexFork, agent: CODEX_AGENT, model: null, ...none } }
  // The agent: the one the request names, which the board must offer; else the board's default.
  // Picked here, but refused only after the profile, as before Codex: Codex has no Claude profile.
  const asked = given(b.agent)
  const offered = asked === undefined ? null : agents()
  const agent: LaunchAgentId | undefined = offered === null ? standard(agents) : offered.find(a => a.id === asked)?.id
  if (agent === CODEX_AGENT) {
    // An effort only with a model whose effort levels Codex's cache lists.
    const effort = given(b.effort)
    if (effort) {
      const models = await cachedCodexModels()
      if (!model || !Object.hasOwn(models, model) || !models[model]?.includes(effort))
        return fail('model', 'launch.err.codexEffort')
    }
    return {
      ok: true,
      launch: {
        ...common,
        agent,
        model,
        ...(effort && { effort }),
        ...none,
        ...(pin && { pin }),
        ...(remote && { remote }),
      },
    }
  }
  if (pins && isNodeProfile && remote) {
    const askedProfile = given(b.profile)
    if (!askedProfile) return fail('profile', 'launch.err.profileChoose')
    if (!agent)
      return fail('agent', offered?.length ? 'launch.err.agent' : 'launch.err.agentLauncher', { id: asked ?? '' })
    if (agent === PI_AGENT)
      try {
        piCommand(pi)
      } catch (err) {
        return { ok: false, field: 'agent', error: err instanceof Error ? err.message : String(err) }
      }
    if (agent === AGY_AGENT)
      try {
        agyCommand(agy)
      } catch (err) {
        return { ok: false, field: 'agent', error: err instanceof Error ? err.message : String(err) }
      }
    return {
      ok: true,
      launch: {
        ...common,
        profile: askedProfile,
        profileDir: '',
        configDir: null,
        profileArgs: [],
        profileCommand: null,
        nodeProfile: true,
        agent,
        model,
        ...(pin && { pin }),
        remote,
      },
    }
  }
  const target = launchTarget(
    given(b.profile),
    parent === null ? null : (from ?? { name: parentName, profile: null }),
    profiles,
  )
  let profile: Extract<LaunchTarget, { ok: true }>['profile']
  let configDir: string | null
  if (!target.ok) {
    if (target.error === 'choose' && given(b.agent) === AGY_AGENT && parent === null && profiles.list[0]) {
      profile = profiles.list[0]
      configDir = null
    } else return fail('profile', ...refusal(target, parentName, profiles))
  } else {
    profile = target.profile
    configDir = target.configDir
  }
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
  // An agent the board does not offer; pi's command must be one the tab's shell can type.
  if (!agent)
    return fail('agent', offered?.length ? 'launch.err.agent' : 'launch.err.agentLauncher', { id: asked ?? '' })
  if (agent === PI_AGENT)
    try {
      piCommand(pi)
    } catch (err) {
      return { ok: false, field: 'agent', error: err instanceof Error ? err.message : String(err) }
    }
  if (agent === AGY_AGENT)
    try {
      agyCommand(agy)
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
      model,
      ...(pin && { pin }),
      ...(remote && { remote }),
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
