// spawn-agent: opens a new herdr tab, starts a Claude session in it, names it and hands it the
// brief. The board starts new sessions with it when config.json sets no `launch.command` or
// `launch.agent` (launcher.ts), and agents start other sessions with it (entrypoints/spawn-agent.ts).
// The session starts in a Claude profile (core/profiles.ts spawnEnv): the one the board asks for,
// the one named with --profile, or the profile of the agent that runs it. When that cannot be
// sure, it refuses before herdr opens, renames or types anything; with --pane, herdr's `pane get`
// is asked first, as the terminal the pane holds decides whether it is in the profile.
//
// --resume brings back a session that ended (the board's archive, services/archive.ts): Claude
// resumes it by its id, in the folder it ran in, and it keeps the name it had, so no /rename is
// typed. An agent's resume runs in the profile whose folder holds its conversation, never in the
// agent's own (resumeProfile); the board's own starts say the profile, as for any start.
//
// --fork starts a new session with a copy of another one's conversation (`--resume <id>
// --fork-session`, with the new session's own --session-id): named and briefed as any start, in
// the profile that holds that conversation, as a resume is; the session it forks is not touched.
//
// The start command may start pi instead of Claude (a profile's `command` of `pi`, or an alias
// for it): herdr says which agent came up in the tab, and the session is named as that agent
// names one (core/pi.ts namingOf: Claude's /rename, pi's /name). pi's session is keyed by its
// file, which herdr reports once pi is up: the profile it is meant for goes on that card. A start
// asked for pi (--agent pi; the board's, when its request picks pi) types `launch.pi` instead.
//
// --agent codex starts Codex CLI (`launch.codex`, default codex) in a tab of its own: a new session
// only, with no Claude profile. Its options go on the command line (--model -> -m's long form, --effort
// -> -c model_reasoning_effort=, --approval -> -a, --sandbox -> -s); without them Codex runs on the
// user's config.toml. When config.json sets `codexHome` the tab gets CODEX_HOME (and --pane is refused:
// a pane keeps the env it has). Codex names the session with /rename (core/codex.ts CODEX_NAMING),
// and has no session id until its first prompt: the card (`modelWant`) is written once the brief went in.
//
// --model starts the session on that model (#380): `--model <id>` after the start command and the
// profile's arguments, Claude's and pi's alike, never written to the profile's settings. Its card
// says so (`modelWant`), so a start with it gets a session id of its own when none was given. A
// resume without it leaves the card as it was: Claude goes on with the model the session last ran.

import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { readCard, removeCard, writeCard } from '../../adapters/cards.ts'
import { createClaudeHome } from '../../adapters/claude-home.ts'
import { noDaemonArgs } from '../../adapters/codex-flags.ts'
import { cachedCodexModels } from '../../adapters/codex-home.ts'
import { asPane, herdr, herdrText, paneProcesses, tabCreateRoot } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { ownerServices } from '../../adapters/owner-services.ts'
import { pause } from '../../adapters/pacing.ts'
import { memoryTable, nothingUnder } from '../../adapters/pane-facts.ts'
import {
  forgetProfilePane,
  possibleProfilePanes,
  provenProfilePanes,
  recordProfilePane,
} from '../../adapters/profile-panes.ts'
import { type Env, inheritedProfileDir, loadProfiles } from '../../adapters/profiles.ts'
import { AGY_AGENT } from '../../core/agy.ts'
import { isSidebarPane } from '../../core/board-pane.ts'
import { CODEX_AGENT, CODEX_NAMING, codexHooksReview, codexInputReady, codexPromptAt } from '../../core/codex.ts'
import {
  agyTrustDialog,
  importsDialog,
  keyTowardYes,
  ownImports,
  sameFolder,
  type TrustDialog,
  trustDialog,
} from '../../core/dialogs/trust.ts'
import { t } from '../../core/lang.ts'
import { modelArgs } from '../../core/launch/model.ts'
import { sameDir, slugName, ticketSlugName, uniqueSlug } from '../../core/launch/names.ts'
import {
  choosesSession,
  profileCommand,
  type SpawnOptions,
  shellLine,
  stillTyped,
} from '../../core/launch/spawn-args.ts'
import { forkCard } from '../../core/links.ts'
import { isOwnerServiceKey, ownerServiceBy } from '../../core/owner-services.ts'
import { CLAUDE_NAMING, isPiSessionFile, type Naming, namingOf, PI_AGENT } from '../../core/pi.ts'
import {
  DEFAULT_PROFILE,
  defaultProfileDir,
  envRejected,
  type Profile,
  type SpawnEnv,
  spawnEnv,
} from '../../core/profiles.ts'
import { scrub } from '../../core/secrets.ts'
import { agyCallerOf, codexCallerOf } from '../own-session.ts'
import { renameLeft, screenNow } from './prompt.ts'

/** A folder as given, absolute: ~ is the home folder, a relative one is from here. */
export function absoluteDir(p: string): string {
  const s = String(p)
    .trim()
    .replace(/^["']|["']$/g, '')
  return resolve(/^~([\\/]|$)/.test(s) ? homedir() + s.slice(1) : s)
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
const stalled = (err: unknown): boolean => isRecord(err) && /agent_prompt_stalled/.test(`${err.code} ${err.message}`)
const screen = (pane: string): Promise<string> =>
  herdrText(['pane', 'read', pane, '--source', 'visible'], 5000).catch(() => '')
const stringAt = (value: unknown, key: string): string | null =>
  isRecord(value) && typeof value[key] === 'string' ? value[key] : null

/**
 * --trust: Yes on the startup dialog the agent stops at — Claude's folder-trust dialog for `cwd`
 * or external imports dialog for the user's own files, or Antigravity's folder-trust dialog for
 * `cwd` (#648). The cursor moves one key at a time as the screen shows it. True when Enter went on
 * Yes; false leaves the dialog to the user.
 */
async function answerStartup(
  pane: string,
  cwd: string,
  home: string,
  claudeDirs: readonly string[],
  kind: string,
): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    const shown = await screen(pane)
    let d: Pick<TrustDialog, 'options' | 'selected'> | null = null
    if (kind === AGY_AGENT) {
      const trust = agyTrustDialog(shown)
      d = trust && sameFolder(trust.folder, cwd, home) ? trust : null
    } else {
      const trust = trustDialog(shown)
      const imports = importsDialog(shown)
      d = trust && sameFolder(trust.folder, cwd, home) ? trust : ownImports(imports, claudeDirs, home) ? imports : null
    }
    const key = keyTowardYes(d)
    if (key === null) return false
    if (key === '') {
      await herdr(['pane', 'send-keys', pane, 'enter'])
      await pause(1500)
      return true
    }
    await herdr(['pane', 'send-keys', pane, key])
    await pause(300)
  }
  return false
}

/** A pane as `herdr pane get` says: its agent, its status, its tab, the terminal it holds and its agent's session. */
export async function paneInfo(pane: string, timeoutMs?: number) {
  const answer = await herdr(['pane', 'get', pane], timeoutMs)
  const p = isRecord(answer) ? answer.pane : null
  return {
    agent: stringAt(p, 'agent'),
    status: stringAt(p, 'agent_status'),
    tab: stringAt(p, 'tab_id'),
    terminal: stringAt(p, 'terminal_id'),
    session: stringAt(isRecord(p) ? p.agent_session : null, 'value'),
  }
}

/**
 * Closes a newly opened spawn tab (or pane) when startup failed before any agent ever came up in it
 * (#888): never touches a pane that runs an agent, was reassigned to another terminal, or runs
 * another process under its shell.
 */
async function cleanupEmptySpawnTab(created: {
  pane: string
  terminal: string | null
  workspace: string
}): Promise<void> {
  const cur = await paneInfo(created.pane, 5000).catch(() => null)
  if (!cur || cur.agent) return
  if (created.terminal && cur.terminal && cur.terminal !== created.terminal) return
  const procs = await paneProcesses(created.pane, 5000).catch(() => null)
  if (!procs || procs.foreground.some(pr => pr.pid !== procs.shell)) return
  if (process.platform === 'win32') {
    const rows = await memoryTable().catch(() => null)
    if (!rows || nothingUnder(rows, procs.shell) !== true) return
  }
  let closeTab = false
  if (cur.tab && created.workspace) {
    const answer = await herdr(['pane', 'list', '--workspace', created.workspace], 5000).catch(() => null)
    const raw = isRecord(answer) && Array.isArray(answer.panes) ? answer.panes : []
    const inTab = raw
      .map(asPane)
      .filter((x): x is NonNullable<ReturnType<typeof asPane>> => !!x && x.tab_id === cur.tab)
    if (inTab.some(x => x.pane_id === created.pane) && inTab.every(x => x.pane_id === created.pane || isSidebarPane(x)))
      closeTab = true
  }
  await herdr(closeTab && cur.tab ? ['tab', 'close', cur.tab] : ['pane', 'close', created.pane]).catch(() => {})
  forgetProfilePane(created.pane)
}

/** Type a line into the agent's prompt; a leading dash would read as an option to herdr. */
const prompt = (pane: string, text: string) => herdr(['agent', 'prompt', pane, /^-/.test(text) ? ` ${text}` : text])

/** herdr's own name for targeting: [a-z][a-z0-9_-]{0,31}, not one another agent has. */
async function nameInHerdr(pane: string, name: string, ticketNames: boolean): Promise<string> {
  try {
    const answer = await herdr(['agent', 'list'])
    const agents = isRecord(answer) && Array.isArray(answer.agents) ? answer.agents : []
    const others = agents.filter(a => stringAt(a, 'pane_id') !== pane)
    const taken = others.map(a => stringAt(a, 'name')).filter((n): n is string => !!n)
    const agent = uniqueSlug(ticketNames ? ticketSlugName(name) : slugName(name), new Set(taken))
    await herdr(['agent', 'rename', pane, agent])
    return agent
  } catch {
    return pane
  }
}

/** Why spawn-agent does not start in the profile spawnEnv refused. */
export function profileRefusal(target: Extract<SpawnEnv, { ok: false }>): string {
  if (target.error === 'missing') return `no profile "${target.detail}": see the board's Settings → Profiles`
  if (target.error === 'hidden') return `the profile "${target.detail}" is hidden: show it on the board first`
  if (target.error === 'unlisted')
    return `--config-dir ${target.detail} is not the folder of a profile the board knows: see the board's Settings → Profiles`
  return `this session's Claude folder ${target.detail} is not a profile the board knows: pass --profile <id>`
}

type Start = { configDir: string | null; profile: Profile | null }

/** What the profile of a start is decided from: the board's profiles, the agent's env, the home and session folders. */
type StartFacts = { profiles: readonly Profile[]; env: Env; home: string; cwd: string }

/**
 * The profile an agent's resume (--resume without --config-dir or --keep-env) is in: the one whose
 * folder holds the session's conversation (Claude writes it only into the folder it runs with, and
 * resumes it only there). With --profile, that profile as spawnEnv takes it, and it must hold the
 * conversation; without, the one listed profile that does, hidden or not. Never the agent's own
 * folder nor herdr's env: none, or more than one, is refused (throws with the reason).
 */
function resumeProfile(o: SpawnOptions, session: string, { profiles, env, home, cwd }: StartFacts): SpawnEnv {
  const holds = (p: Profile): boolean => !!createClaudeHome(p.dir).transcriptPath(session, cwd)
  if (o.profile !== undefined) {
    const target = spawnEnv(o, inheritedProfileDir(env, home), profiles, home)
    if (target.ok && target.profile && !holds(target.profile))
      throw new Error(t('spawn.err.resumeProfile', { session, profile: target.profile.id }))
    return target
  }
  const holders = profiles.filter(holds)
  if (holders.length > 1)
    throw new Error(t('spawn.err.resumeMany', { session, profiles: holders.map(p => p.id).join(', ') }))
  const own = holders[0]
  if (!own)
    throw new Error(o.fork ? t('fork.err.noTranscript', { session }) : t('archive.err.noTranscript', { name: o.name }))
  // As for --profile: herdr's env is taken to be the default profile's, so that one leaves it alone.
  return { ok: true, configDir: sameDir(own.dir, defaultProfileDir(home)) ? null : own.dir, profile: own }
}

/**
 * The profile the start is in and CLAUDE_CONFIG_DIR for its tab (null: herdr's env); throws with
 * the reason it is refused. A folder to set must be there and named in full: a relative one would
 * be another folder in the tab. A --pane that needs the folder set and is not even recorded in
 * that profile is refused here too; the rest of its check needs herdr (paneCheck).
 */
function startProfile(o: SpawnOptions, facts: StartFacts): Start {
  const { profiles, env, home } = facts
  // The board's own starts (--config-dir, --keep-env) say the profile, of a resume too.
  const boards = o.keepEnv || o.configDir !== undefined
  // A Claude resume and fork go on from a conversation: in the profile that holds it.
  // Antigravity sessions do not live in Claude profile folders.
  const from = o.agent === AGY_AGENT ? undefined : (o.resume ?? o.fork)
  const target =
    from && !boards ? resumeProfile(o, from, facts) : spawnEnv(o, inheritedProfileDir(env, home), profiles, home)
  if (!target.ok) throw new Error(profileRefusal(target))
  const start: Start = { configDir: target.configDir, profile: target.profile }
  const { configDir } = start
  if (configDir !== null && (!isAbsolute(configDir) || !isFolder(configDir)))
    throw new Error(`the profile folder ${configDir} is not there`)
  // A pane that could not even be in this profile is not proven in it once herdr says its terminal.
  if (o.pane && configDir !== null)
    paneCheck(o.pane, possibleProfilePanes(new Map([[o.pane, null]])).get(o.pane), start)
  return start
}

/**
 * A pane given with --pane keeps the env it was opened with (`opened`: the profile its record
 * gives, undefined when none does). A start that sets the folder takes only a pane opened in that
 * profile (`opened` from provenProfilePanes); one that leaves the env alone never takes a pane
 * that could have been opened in another profile (from possibleProfilePanes), where Claude would
 * run in that one. Throws with the reason.
 */
function paneCheck(pane: string, opened: string | undefined, { configDir, profile }: Start): void {
  const setsFolder = configDir !== null
  const fits = setsFolder ? !!profile && opened === profile.id : opened === undefined || opened === profile?.id
  if (fits) return
  const wanted = profile?.id ?? configDir
  throw new Error(
    wanted
      ? `--pane ${pane} was not opened in profile ${wanted}: leave out --pane to get a new tab`
      : `--pane ${pane} was opened in profile ${opened}: leave out --pane to get a new tab`,
  )
}

export interface SpawnResult {
  pane: string
  session: string | null
  name: string
  agent: string
  /** The kind of agent that came up: 'claude', or 'pi' when the start command started pi. */
  kind: string
}

// A card the start wrote before it knew the agent, with nothing on it but what a start writes.
const START_ONLY = [
  'key',
  'category',
  'updatedAt',
  'profileWant',
  'modelWant',
  'forkOf',
  'forkAt',
  'parent',
  'serviceStartBy',
]

/** The session (or pane-<id>) that ran spawn-agent from its own environment, else ''. */
function callerParent(env: Env): string {
  if (codexCallerOf(env, readCard)) return env.CODEX_THREAD_ID ?? ''
  if (agyCallerOf(env, readCard)) return env.ANTIGRAVITY_CONVERSATION_ID ?? ''
  if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID
  if (env.HERDR_PANE_ID) return `pane-${env.HERDR_PANE_ID}`
  return ''
}

/**
 * pi's session is keyed by its file and Antigravity's by its own conversation id, not by the id
 * the start gave it: the lane, profile and model from the start go on that card, and the card
 * written under the start id goes when it holds nothing else.
 */
function moveStartCard(carded: string, target: string, profile: string | undefined, model: string | undefined): void {
  const prior = readCard(carded)
  const category = typeof prior?.category === 'string' && prior.category ? prior.category : undefined
  const profileWant =
    profile ?? (typeof prior?.profileWant === 'string' && prior.profileWant ? prior.profileWant : undefined)
  const modelWant = model ?? (typeof prior?.modelWant === 'string' && prior.modelWant ? prior.modelWant : undefined)
  const parent = typeof prior?.parent === 'string' && prior.parent ? prior.parent : undefined
  const existing = readCard(target)
  const patch = {
    ...(category && !existing?.category && { category }),
    ...(profileWant && { profileWant }),
    ...(modelWant && { modelWant }),
    ...(parent && !existing?.parent && { parent }),
    ...(prior?.serviceStartBy && { serviceStartBy: prior.serviceStartBy }),
  }
  if (Object.keys(patch).length) writeCard(target, patch)
  if (prior && carded !== target && Object.keys(prior).every(k => START_ONLY.includes(k))) removeCard(carded)
}

/**
 * Start Claude (`claude`, the command and its arguments) for the options: in a new tab of the
 * workspace (inside herdr the current one), or in `pane`; wait until herdr sees it ready, name it
 * in herdr and in Claude, then type the brief. Throws with the reason when it cannot. The profile
 * comes from the options, else from `env` (the agent's own); `profiles` are the board's (default:
 * config.json's merged with the folders found in `home`). A profile's start command (its
 * `command`) is typed in place of `claude`, the profile's arguments after it. With `agent` pi,
 * `pi` (`launch.pi`, default: pi) is typed instead, without them: they are Claude's. So is
 * `codex` (`launch.codex`) for `agent` codex, with Codex's own options.
 */
export async function spawnAgent(
  o: SpawnOptions,
  {
    claude = ['claude'],
    pi = ['pi'],
    agy = ['agy'],
    codex = ['codex'],
    codexHome = null,
    log = () => {},
    profiles,
    env = process.env,
    home = homedir(),
    ticketNames = false,
    nodeEnv,
    onAgent,
  }: {
    claude?: string[]
    pi?: string[]
    agy?: string[]
    codex?: string[]
    /** config.json's `codexHome`: CODEX_HOME for a Codex tab; null leaves the env as herdr makes it. */
    codexHome?: string | null
    log?: (text: string) => void
    profiles?: Profile[]
    env?: Env
    home?: string
    /** The setup's ticket convention: 14404 -> case-14404. */
    ticketNames?: boolean
    /** On a node (#507): the variables of a profile's env file, for a new tab beside CLAUDE_CONFIG_DIR. */
    nodeEnv?: (profile: string) => Readonly<Record<string, string>> | null
    /**
     * Told once herdr reports an agent in `pane` (case files, #488): a session runs there from then
     * on, whether or not it gets ready. A start command that never came up as one is never told.
     */
    onAgent?: (pane: string) => void
  } = {},
): Promise<SpawnResult> {
  const cwd = absoluteDir(o.cwd)
  let isDir = false
  try {
    isDir = statSync(cwd).isDirectory()
  } catch {}
  if (!isDir) throw new Error(`No such folder: ${cwd}`)
  const workspace = o.workspace || process.env.HERDR_WORKSPACE_ID
  if (!o.pane && !workspace) throw new Error('No herdr workspace: run it inside herdr or pass --workspace')
  const isCodex = o.agent === CODEX_AGENT
  // Codex has no Claude profile: nothing of the profile's is looked at, the tab's env stays herdr's.
  if (isCodex && o.pane && codexHome)
    throw new Error('--pane keeps the env the pane has, so it cannot get CODEX_HOME: leave out --pane to get a new tab')
  const known = isCodex ? [] : (profiles ?? loadProfiles({ home }))
  const start: Start = isCodex
    ? { configDir: null, profile: null }
    : startProfile(o, { profiles: known, env, home, cwd })
  const { configDir, profile } = start
  // The user's own Claude folders: the profile of the agent that runs it, the default one, and the board's.
  const claudeDirs = [...new Set([inheritedProfileDir(env, home), defaultProfileDir(home), ...known.map(p => p.dir)])]
  const label = o.label?.trim() || o.name
  const text =
    o.briefFile !== undefined
      ? readFileSync(o.briefFile, 'utf8')
          .replace(/^\uFEFF/, '')
          .trim()
      : (o.brief ?? '').trim()
  // The profile's start command, else `claude`; a bad one throws here, before herdr is asked.
  // pi's, agy's and Codex's own commands when asked for.
  const isAgy = o.agent === AGY_AGENT
  const program = isCodex
    ? [...codex]
    : o.agent === 'pi'
      ? [...pi]
      : isAgy
        ? [...agy]
        : [...(profileCommand(profile?.command) ?? claude), ...(profile?.args ?? [])]
  if (isCodex && o.effort) await checkEffort(o.model, o.effort)
  // A launch.claude/launch.agy that picks its own session (--resume, --continue, --conversation) cannot resume another one.
  if (o.resume && choosesSession(program))
    throw new Error(
      `${isAgy ? 'launch.agy' : 'launch.claude'} picks its own session (${program.join(' ')}), so it cannot resume ${o.resume}`,
    )
  if (o.fork && choosesSession(program))
    throw new Error(`launch.claude picks its own session (${program.join(' ')}), so it cannot fork ${o.fork}`)
  // Case files (#488): --thread makes the session the thread's assignee by the id it is given.
  if (o.thread && choosesSession(program))
    throw new Error(
      `launch.claude picks its own session (${program.join(' ')}), so --thread cannot tell which session to give ${o.thread}`,
    )
  // A fork is a new session: its id is the one given, else one of its own, so its card is known.
  // So is a start on a model of its own, whose card says so; not one whose line picks its session, and not agy (no --session-id flag).
  // Codex picks its own id: none is given.
  const ownId = !isAgy && !isCodex && (!!o.fork || (!!o.model && !o.resume && !choosesSession(program)))
  const sessionId = ownId ? (o.sessionId ?? randomUUID()) : isAgy ? undefined : o.sessionId
  // The model goes after the profile's arguments: of two --model, Claude, pi and agy take the last.
  // Codex: the pane's env must reach the session (adapters/codex-flags.ts).
  const line = [
    ...program,
    ...(isCodex ? await noDaemonArgs(program) : []),
    ...modelArgs(o.model),
    ...(isCodex ? codexOptions(o) : []),
  ]
  const argv = o.resume
    ? [...line, isAgy ? '--conversation' : '--resume', o.resume]
    : o.fork
      ? [...line, '--resume', o.fork, '--fork-session', '--session-id', String(sessionId)]
      : sessionId && !choosesSession(program)
        ? [...line, '--session-id', sessionId]
        : line
  const command = shellLine(argv, process.platform === 'win32')

  // The tab is labelled before Claude runs: a launcher may name things after it (a Telegram topic).
  let pane = o.pane
  let createdTab: { pane: string; terminal: string | null; workspace: string } | null = null
  if (pane) {
    const p = await paneInfo(pane)
    // Typed into a running agent, the command would go to it as a prompt.
    if (p.agent) throw new Error(`${pane} already runs ${p.agent}: --pane takes a pane at a shell prompt`)
    // herdr gives a pane's id out again after it starts over. Setting the folder takes the pane
    // only when herdr proves it holds the terminal it was recorded with; leaving the env alone
    // refuses it unless herdr proves it holds another one.
    const live = new Map([[pane, p.terminal]])
    const opened = configDir !== null ? provenProfilePanes(live) : possibleProfilePanes(live)
    paneCheck(pane, opened.get(pane), start)
    if (p.tab) await herdr(['tab', 'rename', p.tab, label]).catch(() => {})
  } else {
    let opened: Awaited<ReturnType<typeof tabCreateRoot>>
    const own =
      configDir !== null
        ? { CLAUDE_CONFIG_DIR: configDir }
        : isCodex && codexHome
          ? { CODEX_HOME: codexHome }
          : undefined
    // On a node, the env file's variables beside it; a pane given with --pane keeps the env it has.
    const vars = nodeEnv?.(profile?.id ?? DEFAULT_PROFILE)
    try {
      opened = await tabCreateRoot(
        workspace ?? '',
        cwd,
        label,
        vars && Object.keys(vars).length ? { ...vars, ...own } : own,
      )
    } catch (err) {
      if (isCodex && codexHome && envRejected(err))
        throw new Error(
          'herdr cannot set CODEX_HOME for the new tab (--env needs herdr 0.9.5 or newer): nothing was started',
        )
      if (configDir !== null && envRejected(err))
        throw new Error(
          'herdr cannot set CLAUDE_CONFIG_DIR for the new tab (--env needs herdr 0.9.5 or newer): nothing was started',
        )
      // herdr's words may quote an --env argument: none of the env file's values goes on.
      const values = Object.values(vars ?? {}).filter(Boolean)
      if (values.length && err instanceof Error) err.message = scrub(err.message, values)
      throw err
    }
    pane = opened.pane
    createdTab = { pane: opened.pane, terminal: opened.terminal, workspace: workspace ?? '' }
    // Before Claude runs: a pane the board cannot tell was opened in the profile is never woken
    // there, and the record of an earlier pane of this id (herdr started over) is not this one's.
    if (configDir !== null && profile) recordProfilePane(pane, profile.id, opened.terminal)
    else forgetProfilePane(pane)
  }
  // The profile it is meant to be in, for the board to check against the one its hooks report: a
  // start that leaves the env as herdr makes it too, as herdr's env may point elsewhere; a resume too.
  const boards = o.keepEnv || o.configDir !== undefined
  const parent = !boards && !o.resume && !o.fork ? callerParent(env) : ''
  const service = isOwnerServiceKey(parent) ? ownerServices().find(s => s.key === parent) : undefined
  const by = service && ownerServiceBy(service.name)
  const carded = sessionId ?? o.sessionId ?? o.resume
  // A fork's card says whose fork it is, and since when: its copied lines are older (core/links.ts).
  // The model it starts on, when one was asked for; and the caller that started it, if any.
  if (carded && (profile || o.model || parent))
    writeCard(carded, {
      ...(profile && { profileWant: profile.id }),
      ...(o.model && { modelWant: o.model }),
      ...(o.fork && forkCard(o.fork)),
      ...(parent && { parent }),
      ...(by && { serviceStartBy: by }),
    })
  let ready = false
  let naming: Naming = isCodex ? CODEX_NAMING : CLAUDE_NAMING
  let kind = 'claude'
  let session: string | null = null
  let seen = false
  try {
    await herdr(['pane', 'run', pane, command])

    const deadline = Date.now() + o.timeoutSec * 1000
    let answered = 0
    // The agent that came up (herdr says): Claude, or pi for a start command that starts it; for
    // --agent codex, Codex and nothing else.
    while (Date.now() < deadline) {
      await pause(1500)
      let p: Awaited<ReturnType<typeof paneInfo>>
      try {
        p = await paneInfo(pane, 10_000)
      } catch (err) {
        if (/not.?found|no such/i.test(messageOf(err)))
          throw new Error(`The tab of ${pane} was closed before ${isCodex ? 'Codex' : 'Claude'} got ready`)
        continue
      }
      const own = isCodex ? (p.agent === CODEX_AGENT ? CODEX_NAMING : null) : namingOf(p.agent)
      if (!own || !p.agent) continue
      if (!seen) {
        seen = true
        onAgent?.(pane)
      }
      naming = own
      kind = p.agent
      session = p.session
      // Codex: herdr calls it idle while its hooks still run and the input takes nothing yet, and a
      // hooks-review screen is no idle either. Only the field on screen counts.
      const shown = isCodex ? await screen(pane) : ''
      if (isCodex && codexHooksReview(shown))
        throw new Error(
          `Codex in ${pane} waits for its hooks to be trusted. Trust them in that tab (t, then esc), then: herdr agent prompt ${pane} "${naming.command(o.name)}" and send the brief.`,
        )
      if ((p.status === 'idle' || p.status === 'done') && (!isCodex || codexInputReady(shown))) {
        ready = true
        break
      }
      if (p.status === 'blocked') {
        if (o.trust && answered < 4 && (await answerStartup(pane, cwd, home, claudeDirs, kind))) {
          answered++
          continue
        }
        throw new Error(
          isCodex
            ? `Codex in ${pane} waits for a dialog (folder trust?). Answer it in that tab, then: herdr agent prompt ${pane} "${naming.command(o.name)}" and send the brief.`
            : kind === PI_AGENT || kind === AGY_AGENT
              ? `${naming.title} in ${pane} waits for a dialog. Answer it in that tab, then: herdr agent prompt ${pane} "${naming.command(o.name)}" and send the brief.`
              : `Claude in ${pane} waits for a dialog (folder trust?). Answer it in that tab, then: herdr agent prompt ${pane} "/rename ${o.name}" and send the brief.`,
        )
      }
    }
    if (!ready)
      throw new Error(
        `${isCodex ? 'Codex' : isAgy ? 'Antigravity' : 'Claude'} did not get ready in ${pane} within ${o.timeoutSec} s`,
      )
  } catch (err) {
    if (createdTab && !seen) await cleanupEmptySpawnTab(createdTab).catch(() => {})
    throw err
  }
  if (kind === PI_AGENT && carded && isPiSessionFile(session)) moveStartCard(carded, session, profile?.id, o.model)
  // agy has no pre-assigned --session-id: move the start card's lane, profile and model (or save
  // --model alone) onto its conversation card once ready without pinning card.name, so herdr agent
  // rename and /rename keep working (#650, #663).
  if (kind === AGY_AGENT && !o.resume && session) {
    if (carded && carded !== session) moveStartCard(carded, session, profile?.id, o.model)
    else if (o.model) writeCard(session, { modelWant: o.model })
  }
  if (parent) {
    const finalKey = session || `pane-${pane}`
    if (finalKey !== carded && (!readCard(finalKey)?.parent || by))
      writeCard(finalKey, { parent, ...(by && { serviceStartBy: by }) })
  }

  const agent = await nameInHerdr(pane, o.name, ticketNames)

  // /rename runs locally, no turn: herdr never sees it working and calls the prompt stalled. The
  // name is cosmetic and Claude runs by now: no failure for it, or a retry would start a second one.
  // A resumed session keeps the name it had.
  let renamed = false
  if (!o.resume) {
    const line = naming.command(o.name)
    try {
      await prompt(pane, line)
    } catch (err) {
      if (!stalled(err)) log(`${line.split(' ')[0]} in ${pane}: ${messageOf(err)}`)
    }
    const named = naming.doneFor?.(o.name) ?? naming.done
    for (let i = 0; i < 10 && !renamed; i++) {
      await pause(500)
      const shown = await screen(pane)
      if (named.test(shown)) renamed = true
      // pi/agy's first Enter on a slash command with an argument can take its completion instead:
      // the line still in the editor gets one more.
      if ((kind === PI_AGENT || kind === AGY_AGENT) && i === 1 && stillTyped(shown, line))
        await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
      // Claude can drop it at a slow start (#479): its line still in the box gets one more too.
      if (kind === 'claude' && (i === 1 || i === 5) && stillTyped(shown, line) && (await renameLeft(pane, line)))
        await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
    }
    // Codex can drop what arrives before its input takes it: typed again, a few times (a name twice is harmless).
    for (let again = 0; isCodex && !renamed && again < 2; again++) {
      const shown = await screen(pane)
      if (codexPromptAt(shown, line) === 'typed') await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
      else await prompt(pane, line).catch(() => {})
      for (let i = 0; i < 6 && !renamed; i++) {
        await pause(500)
        renamed = named.test(await screen(pane))
      }
    }
    if (isCodex && !renamed)
      throw new Error(
        `The name did not reach Codex in ${pane} (it runs). Send it by hand: herdr agent prompt ${pane} "${line}", then the brief: herdr agent prompt ${pane} "<brief>"`,
      )
  }

  // A brief typed into a box that still holds text goes with it as one: after a /rename Claude did
  // not take, the name would eat the brief (#479). It is not typed then; the session runs, so this
  // fails as "did not reach", which the board does not retry. Asked only when no rename showed; a
  // box herdr cannot show (null) holds nothing as far as this goes: the brief goes as before.
  // A dialog in its place (one Claude drew after herdr called it ready, #602) stops the start as a
  // dialog does before it: the board waits for it to be answered and sends the brief then.
  if (text && !o.resume && !renamed && kind === 'claude') {
    const shown = await screenNow(pane)
    if (shown?.kind === 'dialog')
      throw new Error(
        `Claude in ${pane} waits for a dialog. Answer it in that tab, then: herdr agent prompt ${pane} "<brief>"`,
      )
    const left = shown?.draft
    if (left)
      throw new Error(
        `The brief did not reach Claude in ${pane}: its input box still holds "${left.length > 60 ? `${left.slice(0, 59)}…` : left}". Clear it there, then: herdr agent prompt ${pane} "<brief>"`,
      )
  }

  // Right after a slash command Claude can drop typed text, and a short turn can end before herdr
  // sees it working: both read as "agent_prompt_stalled". Text still on screen (or a pasted-text
  // chip) gets an Enter; text that vanished is typed again.
  if (text && isCodex) await codexBrief(pane, text)
  else if (text) {
    let sent = false
    for (let i = 1; i <= 3 && !sent; i++) {
      await pause(800)
      try {
        await prompt(pane, text)
        sent = true
      } catch (err) {
        // "brief did not reach" tells the board the session runs: no retry that starts another.
        if (!stalled(err))
          throw new Error(
            `The brief did not reach ${naming.title} in ${pane}: ${messageOf(err)}. Send it by hand: herdr agent prompt ${pane} "<brief>"`,
          )
        if (stillTyped(await screen(pane), text)) {
          await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
          sent = true
        }
      }
    }
    if (!sent)
      throw new Error(
        `The brief did not reach ${naming.title} in ${pane}. Send it by hand: herdr agent prompt ${pane} "<brief>"`,
      )
  }
  if (isCodex && o.model && text) await cardCodex(pane, o.model)
  return { pane, name: o.name, agent, kind, session }
}

/**
 * The brief for Codex, and proof it arrived: in the conversation with the field empty again, or
 * Codex at work. Typed but not taken gets Enter; dropped gets typed again (twice at most). Nothing
 * that shows it arrived is ever sent a second time.
 */
async function codexBrief(pane: string, text: string): Promise<void> {
  const where = async (): Promise<'typed' | 'sent' | 'missing'> => {
    const p = await paneInfo(pane, 5000).catch(() => null)
    if (p && (p.status === 'working' || p.status === 'blocked')) return 'sent'
    const at = codexPromptAt(await screen(pane), text)
    return at === 'missing' && p?.status === 'done' ? 'sent' : at
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await pause(800)
    try {
      await prompt(pane, text)
    } catch (err) {
      if (!stalled(err))
        throw new Error(
          `The brief did not reach Codex in ${pane}: ${messageOf(err)}. Send it by hand: herdr agent prompt ${pane} "<brief>"`,
        )
    }
    for (let i = 0; i < 10; i++) {
      await pause(500)
      const at = await where()
      if (at === 'sent') return
      if (at === 'typed' && i % 4 === 3) await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
      if (at === 'missing' && i >= 4) break
    }
    // Typed and still not taken after the Enters: sending it again would put it there twice.
    if ((await where()) !== 'missing') {
      await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
      await pause(800)
      if ((await where()) === 'sent') return
      break
    }
  }
  throw new Error(`The brief did not reach Codex in ${pane}. Send it by hand: herdr agent prompt ${pane} "<brief>"`)
}

/** Codex's own options for a start: --effort, --approval and --sandbox as its `-c`, `-a` and `-s`. */
function codexOptions(o: SpawnOptions): string[] {
  return [
    // A plain word: -c takes a value that is no TOML as a string, and `"high"` would not type into PowerShell.
    ...(o.effort ? ['-c', `model_reasoning_effort=${o.effort}`] : []),
    ...(o.approval ? ['-a', o.approval] : []),
    ...(o.sandbox ? ['-s', o.sandbox] : []),
  ]
}

/** An effort only for a model whose levels Codex's cache lists, as the board's own start checks it. */
async function checkEffort(model: string | undefined, effort: string): Promise<void> {
  const levels = model ? (await cachedCodexModels())[model] : undefined
  if (!model) throw new Error('--effort needs --model: the levels are those of the model')
  if (!levels) throw new Error(`--effort: Codex's model list has no model ${model}`)
  if (!levels.includes(effort)) throw new Error(`--effort ${effort}: ${model} takes ${levels.join(', ') || 'none'}`)
}

/**
 * The card of a Codex session started on a model of its own: keyed by the id herdr reports, which
 * Codex has only after its first prompt, so after the brief. Never a reason to fail a start that works.
 */
async function cardCodex(pane: string, model: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const { session } = await paneInfo(pane, 5000).catch(() => ({ session: null }))
    if (session) {
      writeCard(session, { modelWant: model })
      return
    }
    await pause(500)
  }
}
