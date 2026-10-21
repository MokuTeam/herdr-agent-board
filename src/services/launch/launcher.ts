// Starting the agent of a new session: the one step that differs between the three ways the
// board starts one. Everything around it (worktree, workspace, the folder-trust dialog, naming and
// the first message when the launcher does not, the card's lane) is launches.ts.
//   spawn-agent (default)  the board's own launcher, entrypoints/spawn-agent.ts, run as
//                    `launch.command` would be: a tab, `launch.claude` typed into it, the names,
//                    the first message.
//   command          `launch.command` in config.json: an executable and its arguments, with
//                    {placeholders} filled in per argument. No shell, nothing from the request
//                    becomes a command; it should print `pane=<id>` when the session is up.
//   herdr            `launch.agent` set: the agent started by `herdr agent start --kind <agent>`
//                    in a tab of its own (or the first one of a new workspace); the board names
//                    it and types the first message.
// A Claude started by the board gets its id up front (--session-id, {sessionId}), so even its
// first brief knows the lane. One coming back from the archive is resumed by its id instead
// (--resume, {resume}): a launch.command without {resume} leaves that to the board's own
// spawn-agent, and launch.agent whose arguments pick a session cannot do it. A fork starts a new
// session with a copy of another one's conversation (`--resume <id> --fork-session` with its own
// --session-id; {fork} and {sessionId}), under the same rules.
// It starts in the Claude profile the launch was checked for (request.ts): in the board's own one
// with the env exactly as inherited; in any other with CLAUDE_CONFIG_DIR set, by herdr's --env on
// the tab (spawn-agent's --config-dir; herdr's launcher), or in a launcher command's process env.
// A start that asks for pi (core/launch/agents.ts) is the board's own launcher's: spawn-agent is
// run with --agent pi and types `launch.pi` in place of the profile's start command and arguments.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { herdr, tabCreateRoot } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { launchDir, ROOT } from '../../adapters/paths.ts'
import { runTree } from '../../adapters/process.ts'
import { forgetProfilePane, recordProfilePane } from '../../adapters/profile-panes.ts'
import { t } from '../../core/lang.ts'
import { CLAUDE_AGENT, piCommand } from '../../core/launch/agents.ts'
import {
  commandArgs,
  failureKind,
  launcherError,
  launcherLabel,
  parseLauncherOutput,
  usesPlaceholder,
} from '../../core/launch/launcher-command.ts'
import { slugName, uniqueSlug } from '../../core/launch/names.ts'
import { choosesSession, claudeCommand } from '../../core/launch/spawn-args.ts'
import { envRejected } from '../../core/profiles.ts'
import type { LaunchFailure, LaunchSpec, LaunchStep } from '../../core/types.ts'
import { takenNames } from './prompt.ts'

export class LaunchError extends Error {
  readonly kind: LaunchFailure
  constructor(message: string, kind: LaunchFailure) {
    super(message)
    this.kind = kind
  }
}

/** What a launcher is asked to start: the launch as the board knows it at this moment. */
export interface LaunchContext {
  /** The launch's id; it names the first-message file. */
  readonly id: string
  readonly name: string
  readonly label: string
  readonly cwd: string
  readonly workspaceId: string
  readonly workspaceLabel: string
  readonly category: string
  readonly message: string
  /** The id of the Claude profile it starts in, and its folder (set or inherited). */
  readonly profile: string
  readonly profileDir: string
  /** CLAUDE_CONFIG_DIR for the start; null: the env as the board inherited it. */
  readonly configDir: string | null
  /** The profile's own Claude arguments. */
  readonly profileArgs: readonly string[]
  /**
   * The profile's start command as the request check read it (the board's own launcher only;
   * null: none, `launch.claude` is typed). spawn-agent reads it from config.json itself.
   */
  readonly profileCommand: readonly string[] | null
  /** The agent the board's own launcher starts (core/launch/agents.ts): `claude` unless the request asked for pi. */
  readonly agent: string
  /** A new workspace's first pane and tab: herdr's launcher starts the agent there, not in a new tab. */
  readonly rootPane: string | null
  readonly rootTab: string | null
  /** As far as the board knows: it may match a pane to a launch whose launcher has not said one yet. */
  readonly sessionId: string | null
  /** The id of the session it resumes (Return, from the archive), null for a new one. */
  readonly resume: string | null
  /** The id of the session whose conversation it starts with (a fork), null for none. */
  readonly fork: string | null
  readonly pane: string | null
}

/** What a launcher tells the board while it works, so the card can show it and go to it. */
export interface LaunchEvents {
  step(step: LaunchStep): void
  /** The pane the session is in. */
  pane(pane: string): void
  /** The id the launcher gives the Claude it starts; the board writes its card (and lane) before Claude exists. */
  session(id: string): void
}

/** How far a launcher got, and what is left for the board. */
export interface LaunchResult {
  pane: string | null
  sessionId: string | null
  /** The agent kind the pane runs; 'claude' gets Claude's /rename. */
  agent: string
  /** Claude stopped at a dialog on the way up instead of waiting for input. */
  dialog: boolean
  /** The launcher gave up at that dialog: the launch fails with this unless it is the folder-trust one. */
  failure: LaunchError | null
  /** herdr knows the agent by the session's name (herdr's launcher starts it under one). */
  named: boolean
  /**
   * The launcher named the session and typed its first message itself (a launcher command, given
   * {name} and {message}; the board's spawn-agent unless a dialog stopped it first).
   */
  typed: boolean
}

/** What the new-session window says about the launcher. */
export type LauncherInfo = { kind: 'herdr'; agent: string } | { kind: 'command'; name: string }

export interface Launcher {
  readonly kind: 'herdr' | 'command' | 'builtin'
  describe(): LauncherInfo
  start(l: LaunchContext, on: LaunchEvents): Promise<LaunchResult>
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const codeOf = (err: unknown): string | undefined =>
  isRecord(err) && typeof err.code === 'string' ? err.code : undefined

type Env = Readonly<Record<string, string>>

/** CLAUDE_CONFIG_DIR for what the board opens or runs for a launch: none when it keeps the env it inherited. */
const profileEnv = (l: Pick<LaunchContext, 'configDir'>): Env | undefined =>
  l.configDir === null ? undefined : { CLAUDE_CONFIG_DIR: l.configDir }

/**
 * Open a tab or a workspace for a launch, with its profile's env when it sets one. herdr that does
 * not take --env (older than 0.9.5) fails the launch saying so, before any Claude runs.
 */
export async function openInProfile<T>(
  l: Pick<LaunchContext, 'configDir'>,
  open: (env: Env | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await open(profileEnv(l))
  } catch (err) {
    if (l.configDir !== null && envRejected(err))
      throw new LaunchError(t('launch.err.env', { dir: l.configDir }), 'launcher')
    throw err
  }
}

/**
 * A pane the board opened for a launch, before Claude runs in it: recorded as opened in the
 * profile when the env was set (it may be woken there, spawn-agent --pane takes it), else a record
 * of an earlier pane of that id dropped (herdr gives pane ids out again after it starts over).
 */
export function notePane(l: Pick<LaunchContext, 'configDir' | 'profile'>, pane: string, terminal: string | null): void {
  if (l.configDir !== null) recordProfilePane(pane, l.profile, terminal)
  else forgetProfilePane(pane)
}

/**
 * The launcher the config asks for: `launch.command`, else herdr's for `launch.agent`, else the
 * board's spawn-agent. A launcher of one's own resumes a session (`resume`) only when it takes
 * {resume}, and forks one (`fork`) only when it takes {fork}; else the next one does.
 */
export function launcherFor(
  spec: LaunchSpec | undefined,
  { resume = false, fork = false }: { resume?: boolean; fork?: boolean } = {},
): Launcher {
  const takes = (key: 'resume' | 'fork') => usesPlaceholder(spec?.command, key)
  if (spec?.command && (!resume || takes('resume')) && (!fork || takes('fork'))) return commandLauncher(spec)
  if (spec?.agent) return herdrLauncher(spec)
  return spawnAgentLauncher(spec ?? {})
}

/** The agent herdr's launcher starts, with its arguments (the profile's own for Claude). */
function herdrAgent(spec: LaunchSpec, profileArgs: readonly string[]): { kind: string; args: string[] } {
  const kind = String(spec.agent ?? 'claude')
  const args = (Array.isArray(spec.args) ? spec.args : []).map(String)
  // The profile's own arguments are Claude's.
  if (kind === 'claude') args.push(...profileArgs)
  return { kind, args }
}

const picksSession = (args: readonly string[]): boolean =>
  args.some(a => /^(--session-id|-r|--resume|-c|--continue)$/.test(a))

/** Whether herdr's launcher (launch.agent) cannot resume a session by its id: another agent, or arguments that pick one. */
export function herdrCannotResume(spec: LaunchSpec, profileArgs: readonly string[]): boolean {
  const { kind, args } = herdrAgent(spec, profileArgs)
  return kind !== 'claude' || picksSession(args)
}

/** `herdr agent start <name> --kind <agent> … -- --session-id <id>` in a tab of its own. */
export function herdrLauncher(spec: LaunchSpec): Launcher {
  const kind = String(spec.agent ?? 'claude')
  return {
    kind: 'herdr',
    describe: () => ({ kind: 'herdr', agent: kind }),
    async start(l, on) {
      const { args } = herdrAgent(spec, l.profileArgs)
      const chooses = picksSession(args)
      // A session is resumed (or forked) by its id: not by another agent, nor by arguments that
      // pick one (launches.ts refuses it before the launch; said here too before a tab is opened).
      if ((l.resume || l.fork) && herdrCannotResume(spec, l.profileArgs))
        throw new LaunchError(t('archive.err.cannotResume'), 'launcher')
      on.step('tab')
      let pane: string
      if (l.rootPane) {
        pane = l.rootPane
        if (l.rootTab) await herdr(['tab', 'rename', l.rootTab, l.label]).catch(() => {})
      } else {
        const opened = await openInProfile(l, env => tabCreateRoot(l.workspaceId, l.cwd, l.label, env))
        pane = opened.pane
        notePane(l, pane, opened.terminal)
      }
      on.pane(pane)
      let sessionId: string | null = null
      if (l.resume) {
        sessionId = l.resume
        args.push('--resume', l.resume)
      } else if (l.fork) {
        sessionId = randomUUID()
        on.session(sessionId)
        args.push('--resume', l.fork, '--fork-session', '--session-id', sessionId)
      } else if (kind === 'claude' && !chooses) {
        sessionId = randomUUID()
        on.session(sessionId)
        args.push('--session-id', sessionId)
      }
      const name = uniqueSlug(slugName(l.name), await takenNames())
      on.step('agent')
      const ms = Math.max(10, Number(spec.timeoutSec) || 120) * 1000
      let dialog = false
      try {
        await herdr(
          [
            'agent',
            'start',
            name,
            '--kind',
            kind,
            '--pane',
            pane,
            '--timeout',
            String(Math.min(ms, 300_000)),
            ...(args.length ? ['--', ...args] : []),
          ],
          ms + 15_000,
        )
      } catch (err) {
        const message = messageOf(err)
        if (codeOf(err) !== 'agent_not_ready' && !/agent_not_ready/.test(message)) {
          const agent = kind === 'claude' ? 'Claude' : kind
          throw new LaunchError(
            /timeout|timed out/i.test(message) ? t('launch.err.notReady', { s: ms / 1000, agent }) : message,
            failureKind(message),
          )
        }
        // A dialog holds it (the folder trust, say): the board takes it from there.
        dialog = true
      }
      return { pane, sessionId, agent: kind, dialog, failure: null, named: true, typed: false }
    },
  }
}

/** `launch.command`, run without a shell; a timeout ends it with everything it started. */
export function commandLauncher(spec: LaunchSpec): Launcher {
  const template = spec.command
  return {
    kind: 'command',
    describe: () => ({ kind: 'command', name: launcherLabel(template) }),
    async start(l, on) {
      const vars = {
        name: l.name,
        label: l.label,
        cwd: l.cwd,
        workspace: l.workspaceId,
        workspaceLabel: l.workspaceLabel,
        category: l.category,
        message: l.message,
        messageFile: '',
        sessionId: '',
        resume: l.resume ?? '',
        fork: l.fork ?? '',
        profile: l.profile,
        profileDir: l.profileDir,
      }
      // A resumed session has its own id.
      let sessionId: string | null = l.resume
      if (!l.resume && usesPlaceholder(template, 'sessionId')) {
        sessionId = randomUUID()
        on.session(sessionId)
        vars.sessionId = sessionId
      }
      return runLauncher(l, on, {
        command: messageFile => commandArgs(template, { ...vars, messageFile }),
        messageFile: usesPlaceholder(template, 'messageFile'),
        step: 'command',
        timeout: Math.max(1, Number(spec.timeoutSec) || 180) * 1000,
        sessionId,
        builtin: false,
        // The launcher starts the session in the profile through its own env; the board never
        // records the panes it opens.
        env: profileEnv(l),
      })
    },
  }
}

const SPAWN_AGENT = join(ROOT, 'src', 'entrypoints', 'spawn-agent.ts')

/**
 * The board's own spawn-agent (entrypoints/spawn-agent.ts) as the launcher, run as a
 * `launch.command` would be: a tab, the profile's start command or `launch.claude` typed into it,
 * the names, the first message.
 * A new workspace's first pane is used as it is (--pane), as herdr's path does, rather than a
 * second tab beside it. The new-session window words it as before the board had its own launcher.
 */
export function spawnAgentLauncher(spec: LaunchSpec): Launcher {
  // How long spawn-agent waits for Claude to be ready.
  const readySec = Math.max(10, Number(spec.timeoutSec) || 120)
  return {
    kind: 'builtin',
    describe: () => ({ kind: 'herdr', agent: 'claude' }),
    async start(l, on) {
      // A line that picks its own session (--resume, in the profile's start command, launch.claude
      // or the profile's arguments; in launch.pi for pi) gets no id from the board; a resumed
      // session has its own. A fork gets one (spawn-agent refuses a line that picks its own session for it).
      const pi = l.agent !== CLAUDE_AGENT
      const line = pi
        ? piCommand(spec.pi)
        : [...(l.profileCommand ?? claudeCommand(spec.claude, spec.args)), ...l.profileArgs]
      let sessionId: string | null = l.resume
      if (!l.resume && (l.fork || !choosesSession(line))) {
        sessionId = randomUUID()
        on.session(sessionId)
      }
      const where = l.rootPane ? ['--pane', l.rootPane] : ['--workspace', l.workspaceId]
      const args = [SPAWN_AGENT, '--name', l.name, '--cwd', l.cwd, '--label', l.label]
      args.push('--timeout-sec', String(readySec), ...where)
      // The profile: the env as herdr makes it, or the folder the board checked.
      args.push(...(l.configDir === null ? ['--keep-env'] : ['--config-dir', l.configDir]))
      if (pi) args.push('--agent', l.agent)
      return runLauncher(l, on, {
        command: messageFile => ({
          file: process.execPath,
          args: [
            ...args,
            ...(messageFile ? ['--brief-file', messageFile] : []),
            ...(l.fork ? ['--fork', l.fork] : []),
            ...(l.resume ? ['--resume', l.resume] : sessionId ? ['--session-id', sessionId] : []),
          ],
        }),
        messageFile: true,
        step: 'agent',
        timeout: (readySec + 60) * 1000,
        sessionId,
        builtin: true,
        env: undefined,
      })
    },
  }
}

interface RunSpec {
  /** The program and its arguments, given the first message's file ('' when there is none). */
  command(messageFile: string): { file: string; args: string[] }
  /** Whether the first message goes to the launcher in a file. */
  messageFile: boolean
  step: LaunchStep
  timeout: number
  sessionId: string | null
  /** The board's own spawn-agent: it stops at any dialog before the names and the first message. */
  builtin: boolean
  /** Added to the launcher's env (CLAUDE_CONFIG_DIR for a profile other than the board's own). */
  env: Env | undefined
}

/** Run a launcher without a shell, the first message in a file only this launch reads, gone after. */
async function runLauncher(l: LaunchContext, on: LaunchEvents, run: RunSpec): Promise<LaunchResult> {
  let file: string | null = null
  let pane: string | null = null
  if (l.message && run.messageFile) {
    // Only this user may read it; a new file every time, never one someone put there.
    mkdirSync(launchDir(), { recursive: true, mode: 0o700 })
    file = join(launchDir(), `${l.id}.txt`)
    writeFileSync(file, l.message, { mode: 0o600, flag: 'wx' })
  }
  try {
    const { file: exe, args } = run.command(file ?? '')
    on.step(run.step)
    // The board runs in a pane of its own workspace: the launcher must not take that for "here".
    const env: Record<string, string | undefined> = { ...process.env, ...run.env, HERDR_WORKSPACE_ID: l.workspaceId }
    delete env.HERDR_PANE_ID
    delete env.HERDR_TAB_ID
    const r = await runTree(exe, args, { timeout: run.timeout, env, cwd: l.cwd })
    const out = parseLauncherOutput(r.stdout)
    if (out.pane) {
      pane = out.pane
      on.pane(pane)
    }
    if (r.code === 0)
      return {
        pane,
        sessionId: run.sessionId,
        // The board's spawn-agent says when its start command started pi; a launcher of one's own is taken as before.
        agent: (run.builtin && out.kind) || 'claude',
        dialog: false,
        failure: null,
        named: false,
        typed: true,
      }
    if (r.error?.code === 'ENOENT') throw new LaunchError(t('launch.err.launcherMissing', { file: exe }), 'launcher')
    if (r.killed) throw new LaunchError(t('launch.err.launcherTimeout', { s: run.timeout / 1000 }), 'timeout')
    const e = launcherError(r.stdout, r.stderr)
    // The pane its error names, unless the board knows one already.
    if (!l.pane && e.pane) {
      pane = e.pane
      on.pane(pane)
    }
    const kind = failureKind(e.message, codeOf(r.error))
    const error = new LaunchError(e.message || r.error?.message || t('err.status', { code: r.code }), kind)
    if (kind !== 'dialog') throw error
    // A launcher gives up where Claude asks to trust the folder; the session may be there, waiting.
    // Another dialog (a project's MCP servers, say) stopped the board's own launcher before the
    // names and the message: in a pane it said, the board waits for it to be answered in herdr.
    const waits = run.builtin && !!(pane ?? l.pane)
    return {
      pane,
      sessionId: run.sessionId,
      agent: 'claude',
      dialog: true,
      failure: waits ? null : error,
      named: false,
      typed: !run.builtin,
    }
  } finally {
    if (file)
      try {
        unlinkSync(file)
      } catch {}
  }
}

/** First messages a launcher never got to read (the board stopped mid-launch) do not stay on disk. */
export function removeLeftoverMessages(): void {
  try {
    for (const f of readdirSync(launchDir())) if (/^[0-9a-f]{8}\.txt$/.test(f)) unlinkSync(join(launchDir(), f))
  } catch {}
}
