// Starting the agent of a new session: the one step that differs between the two ways the board
// starts one. Everything around it (worktree, workspace, the folder-trust dialog, naming and the
// first message when the launcher does not, the card's lane) is launches.ts.
//   herdr (default)  the agent started by `herdr agent start` in a tab of its own (or the first
//                    one of a new workspace); the board names it and types the first message.
//   command          `launch.command` in config.json: an executable and its arguments, with
//                    {placeholders} filled in per argument. No shell, nothing from the request
//                    becomes a command; it should print `pane=<id>` when the session is up.
// A Claude started by the board gets its id up front (--session-id, {sessionId}), so even its
// first brief knows the lane.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { herdr, tabCreate } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { launchDir } from '../../adapters/paths.ts'
import { runTree } from '../../adapters/process.ts'
import { t } from '../../core/lang.ts'
import {
  commandArgs,
  failureKind,
  launcherError,
  launcherLabel,
  parseLauncherOutput,
  usesPlaceholder,
} from '../../core/launch/launcher-command.ts'
import { slugName, uniqueSlug } from '../../core/launch/names.ts'
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
  /** A new workspace's first pane and tab: herdr's launcher starts the agent there, not in a new tab. */
  readonly rootPane: string | null
  readonly rootTab: string | null
  /** As far as the board knows: it may match a pane to a launch whose launcher has not said one yet. */
  readonly sessionId: string | null
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
  /** The launcher named the session and typed its first message itself (a launcher command, given {name} and {message}). */
  typed: boolean
}

/** What the new-session window says about the launcher. */
export type LauncherInfo = { kind: 'herdr'; agent: string } | { kind: 'command'; name: string }

export interface Launcher {
  readonly kind: 'herdr' | 'command'
  describe(): LauncherInfo
  start(l: LaunchContext, on: LaunchEvents): Promise<LaunchResult>
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const codeOf = (err: unknown): string | undefined =>
  isRecord(err) && typeof err.code === 'string' ? err.code : undefined

/** The launcher the config asks for: `launch.command` when there is one, else herdr's. */
export function launcherFor(spec: LaunchSpec | undefined): Launcher {
  return spec?.command ? commandLauncher(spec) : herdrLauncher(spec ?? {})
}

/** `herdr agent start <name> --kind <agent> … -- --session-id <id>` in a tab of its own. */
export function herdrLauncher(spec: LaunchSpec): Launcher {
  const kind = String(spec.agent ?? 'claude')
  return {
    kind: 'herdr',
    describe: () => ({ kind: 'herdr', agent: kind }),
    async start(l, on) {
      on.step('tab')
      let pane: string
      if (l.rootPane) {
        pane = l.rootPane
        if (l.rootTab) await herdr(['tab', 'rename', l.rootTab, l.label]).catch(() => {})
      } else {
        pane = await tabCreate(l.workspaceId, l.cwd, l.label)
      }
      on.pane(pane)
      const args = (Array.isArray(spec.args) ? spec.args : []).map(String)
      let sessionId: string | null = null
      if (kind === 'claude' && !args.some(a => /^(--session-id|-r|--resume|-c|--continue)$/.test(a))) {
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
      }
      let sessionId: string | null = null
      if (usesPlaceholder(template, 'sessionId')) {
        sessionId = randomUUID()
        on.session(sessionId)
        vars.sessionId = sessionId
      }
      let file: string | null = null
      let pane: string | null = null
      let failure: LaunchError | null = null
      if (l.message && usesPlaceholder(template, 'messageFile')) {
        // Only this user may read it; a new file every time, never one someone put there.
        mkdirSync(launchDir(), { recursive: true, mode: 0o700 })
        file = join(launchDir(), `${l.id}.txt`)
        writeFileSync(file, l.message, { mode: 0o600, flag: 'wx' })
        vars.messageFile = file
      }
      try {
        const { file: exe, args } = commandArgs(template, vars)
        on.step('command')
        // The board runs in a pane of its own workspace: the launcher must not take that for "here".
        const env: Record<string, string | undefined> = { ...process.env, HERDR_WORKSPACE_ID: l.workspaceId }
        delete env.HERDR_PANE_ID
        delete env.HERDR_TAB_ID
        const timeout = Math.max(1, Number(spec.timeoutSec) || 180) * 1000
        const r = await runTree(exe, args, { timeout, env, cwd: l.cwd })
        const out = parseLauncherOutput(r.stdout)
        if (out.pane) {
          pane = out.pane
          on.pane(pane)
        }
        if (r.code !== 0) {
          if (r.error?.code === 'ENOENT')
            throw new LaunchError(t('launch.err.launcherMissing', { file: exe }), 'launcher')
          if (r.killed) throw new LaunchError(t('launch.err.launcherTimeout', { s: timeout / 1000 }), 'timeout')
          const e = launcherError(r.stdout, r.stderr)
          // The pane its error names, unless the board knows one already.
          if (!l.pane && e.pane) {
            pane = e.pane
            on.pane(pane)
          }
          const kind = failureKind(e.message, codeOf(r.error))
          const error = new LaunchError(e.message || r.error?.message || t('err.status', { code: r.code }), kind)
          // A launcher gives up where Claude asks to trust the folder; the session may be there, waiting.
          if (kind !== 'dialog') throw error
          failure = error
        }
      } finally {
        if (file)
          try {
            unlinkSync(file)
          } catch {}
      }
      return { pane, sessionId, agent: 'claude', dialog: failure !== null, failure, named: false, typed: true }
    },
  }
}

/** First messages a launcher never got to read (the board stopped mid-launch) do not stay on disk. */
export function removeLeftoverMessages(): void {
  try {
    for (const f of readdirSync(launchDir())) if (/^[0-9a-f]{8}\.txt$/.test(f)) unlinkSync(join(launchDir(), f))
  } catch {}
}
