// Starting a MokuPilot call with a fork of a session (core/mokupilot.ts says what that is): the
// launcher config.json names or the one found on this computer (adapters/setup-facts.ts), run on
// its own past the board's lifetime, in the folder the session started in; when the call goes to
// the viewer's computer (core/mokupilot-mode.ts: mode `link`, or `auto` for a viewer elsewhere)
// nothing runs here, the page gets a mokupilot:// link for the viewer's own MokuPilot. And whether
// MokuPilot is here at all, for the page: looked up again when its setting changes, and once a
// minute for one installed or removed meanwhile.
import { type SpawnOptions, spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { cwdOf } from '../adapters/claude-home.ts'
import { mokupilotCommand } from '../adapters/setup-facts.ts'
import { t } from '../core/lang.ts'
import { callable, callCommand, callLink } from '../core/mokupilot.ts'
import { mokupilotMode, type Resolved, resolveMode, type Viewer } from '../core/mokupilot-mode.ts'
import { inBoardProfile, type ProfileSet, profileLabel } from '../core/profiles.ts'
import type { Config, Item } from '../core/types.ts'

/** What starting the launcher gives back: it started, or why not. */
export interface CallChild {
  once(event: 'spawn', listener: () => void): unknown
  once(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown
  unref(): void
}

export interface CallOptions {
  platform?: string
  env?: Record<string, string | undefined>
  /** child_process.spawn. */
  run?: (file: string, args: string[], options: SpawnOptions) => CallChild
  /** The profiles (Deps.profiles): a call is taken only from a session in the board's own. */
  profiles?: ProfileSet
  /** Who asks (the request's peer and X-Forwarded-For), for mode `auto`; none: this computer. */
  viewer?: Viewer | null | undefined
  /** This computer's own addresses (services/tunnel.ts ownAddresses), asked only under `auto` with a viewer. */
  own?: () => readonly string[]
}

/** Where the call went and why (core/mokupilot-mode.ts resolveMode), on every answer past the checks. */
type Where = Pick<Resolved, 'resolved' | 'why'> & { viewer?: string }

/**
 * `launched`: MokuPilot's launcher started, and no more; `link`: nothing started, the page opens
 * `url` in the viewer's browser for their MokuPilot (startCall).
 */
export type CallResult =
  | ({ ok: true; state: 'launched'; file: string } & Where)
  | ({ ok: true; state: 'link'; url: string } & Where)
  | ({ ok: false; error: string } & Partial<Where>)

const isDir = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

const reason = (err: unknown): string => {
  const e = err as NodeJS.ErrnoException | null
  return String(e?.code || e?.message || err)
}

/**
 * Start a MokuPilot call with a fork of the session `item` (a board item with its transcript):
 * { ok, state: 'launched' } once MokuPilot's launcher started, { ok, state: 'link', url } when the
 * call goes to the viewer's computer (nothing runs here: the page opens the link), { ok: false,
 * error } when it could not; past the first checks each says where it went and why (`resolved`,
 * `why`, the viewer's address under `auto`). It runs on its own, past the board's lifetime. This is NOT an application-ready,
 * call-started or recording-started acknowledgement: an IPC handshake is required for those. The
 * folder is the one the session started in. A running MokuPilot takes the call over in its own
 * env, so with `profiles` a session in another profile than the board's own is refused before
 * anything starts.
 */
export async function startCall(
  cfg: Partial<Config>,
  item: Pick<Item, 'agent' | 'session' | 'cwd' | 'transcript' | 'profile' | 'profileFolder'> | null | undefined,
  { platform = process.platform, env = process.env, run = spawn, profiles, viewer, own = () => [] }: CallOptions = {},
): Promise<CallResult> {
  if (!item || !callable(item)) return { ok: false, error: t('mokupilot.err.notClaude') }
  if (profiles && !inBoardProfile(item, profiles)) {
    const board = profiles.inherited?.title || profiles.inheritedDir
    return { ok: false, error: t('mokupilot.err.profile', { board, profile: profileLabel(item, profiles) }) }
  }
  if (cfg.mokupilot === false) return { ok: false, error: t('mokupilot.err.off') }
  // Here or on the viewer's computer: by the mode, and under `auto` by who asks.
  const mode = mokupilotMode(cfg.mokupilot)
  const decided = resolveMode(mode, viewer, mode === 'auto' && viewer ? own() : [])
  const where: Where = {
    resolved: decided.resolved,
    why: decided.why,
    ...(decided.viewer && { viewer: decided.viewer }),
  }
  const launcher = decided.resolved === 'link' ? null : mokupilotCommand(cfg, { platform, env })
  if (launcher?.state === 'off') return { ok: false, error: t('mokupilot.err.off'), ...where }
  if (launcher?.state === 'missing')
    return { ok: false, error: launcher.error ?? t('mokupilot.err.missing', { file: launcher.file }), ...where }
  // --resume finds a session only from its own folder: the transcript says which that is.
  const recorded = (item.transcript && (await cwdOf(item.transcript))) || item.cwd || ''
  const cwd = recorded && isDir(recorded) ? recorded : ''
  // The viewer's MokuPilot runs the fork here over ssh, from this folder: nothing starts here.
  if (!launcher || launcher.state === 'link') {
    try {
      const url = callLink(item, cwd)
      return url
        ? { ok: true, state: 'link', url, ...where }
        : { ok: false, error: t('mokupilot.err.notClaude'), ...where }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ...where }
    }
  }
  let cmd: { file: string; args: string[] }
  try {
    cmd = callCommand(launcher, { session: String(item.session), cwd })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), ...where }
  }
  // Not one of the board's own panes: herdr's variables stay with the board.
  const childEnv = { ...env }
  delete childEnv.HERDR_PANE_ID
  delete childEnv.HERDR_TAB_ID
  return new Promise(res => {
    let child: CallChild
    try {
      child = run(cmd.file, cmd.args, {
        cwd: cwd || undefined,
        env: childEnv,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
    } catch (err) {
      return res({ ok: false, error: t('mokupilot.err.start', { why: reason(err) }), ...where })
    }
    child.once('error', err =>
      res({
        ok: false,
        error: t('mokupilot.err.start', {
          why: err.code === 'ENOENT' ? t('mokupilot.err.notFound', { file: cmd.file }) : err.code || err.message,
        }),
        ...where,
      }),
    )
    child.once('spawn', () => {
      child.unref()
      res({ ok: true, state: 'launched', file: cmd.file, ...where })
    })
  })
}

export interface CheckOptions {
  now?: () => number
  /** How the board would start MokuPilot (adapters/setup-facts.ts mokupilotCommand). */
  find?: (cfg: Partial<Config>) => { state: string }
}

/**
 * Whether a session's sheet offers a MokuPilot call: looked up again when `cfg.mokupilot` (the
 * live config) changes, and once a minute for one installed or removed meanwhile.
 */
export function mokupilotCheck(
  cfg: Partial<Config>,
  { now = Date.now, find = c => mokupilotCommand(c) }: CheckOptions = {},
): () => boolean {
  let seen: { key: string | null; at: number; on: boolean } = { key: null, at: 0, on: false }
  return () => {
    const key = JSON.stringify(cfg.mokupilot ?? null)
    if (key !== seen.key || now() - seen.at > 60_000)
      seen = { key, at: now(), on: ['ok', 'link'].includes(find(cfg).state) }
    return seen.on
  }
}
