// What the setup checks (core/setup.ts) look at, read from this computer: the commands on PATH,
// Claude Code's settings.json, the agents' skill and herdr's own Claude hook in each shown profile,
// herdr's config.toml, herdr-wake or the board's own wake (#119), how new sessions start, and how
// the board would start MokuPilot (core/mokupilot.ts).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, resolve, win32 } from 'node:path'
import { cardStore } from '../core/card-store.ts'
import { DEFAULT_CONFIG } from '../core/categories.ts'
import { shimTarget } from '../core/install-plan.ts'
import { t } from '../core/lang.ts'
import { isRefusedProgram, launcherLabel } from '../core/launch/launcher-command.ts'
import { claudeCommand, shellLine } from '../core/launch/spawn-args.ts'
import { type CommandPart, type MokupilotLauncher, placeholdersIn } from '../core/mokupilot.ts'
import { defaultProfileDir, mergeProfiles, type Profile, shownProfiles } from '../core/profiles.ts'
import {
  boardFiles,
  type CommandFinds,
  type CommandHit,
  type LauncherFacts,
  type ProfileSettings,
  type ProgramFound,
  type SetupFacts,
} from '../core/setup.ts'
import type { Config } from '../core/types.ts'
import { WAKE_SHIPPED, wakeConfig } from '../core/wake/config.ts'
import { wakeState } from '../core/wake/status.ts'
import { skillIn } from './agents-skill.ts'
import { herdrHookOf, readSettings } from './hook-settings.ts'
import { ROOT } from './paths.ts'
import { findProfileDirs, inheritedProfileDir } from './profiles.ts'
import { oldRouterAt, wakeAlive } from './wake-api.ts'
import { peekWakeSessions, readWakeStatus, unseenWakeTakeover, wakeLogFile } from './wake-files.ts'

type Env = Record<string, string | undefined>

/** How long a probe waits for an answer by default. */
const PROBE_MS = 1500

/** herdr's config.toml: under %APPDATA% on Windows, ~/.config elsewhere (as the plugin config). */
export const herdrConfigFile = (env: Env = process.env, home = homedir()): string =>
  join(env.APPDATA || join(home, '.config'), 'herdr', 'config.toml')

/** A text file as a string (a BOM taken off, as Windows PowerShell writes one), or null. */
export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

// Our command files are a few hundred bytes; claude.exe or bun.exe on PATH is not read.
const SHIM_MAX = 4096
const sizeOf = (file: string): number => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
const isFolder = (file: string): boolean => {
  try {
    return statSync(file).isDirectory()
  } catch {
    return false
  }
}

export interface FindOptions {
  env?: Env
  platform?: string
  exists?: (file: string) => boolean
  read?: (file: string) => string | null
  size?: (file: string) => number
}

/**
 * Where each shell finds a command: { ps, sh } with the file and, for one of ours, the script it
 * runs. PowerShell takes a .ps1 before a .cmd in the same folder, Git Bash and Unix shells the
 * file of that very name.
 */
export function findCommand(
  name: string,
  {
    env = process.env,
    platform = process.platform,
    exists = existsSync,
    read = readText,
    size = sizeOf,
  }: FindOptions = {},
): CommandFinds {
  // Paths as `platform` writes them, which need not be the system this runs on (the tests).
  const paths = platform === 'win32' ? win32 : posix
  const dirs = String(env.PATH ?? env.Path ?? '')
    .split(paths.delimiter)
    .filter(Boolean)
  const exts = [
    '.ps1',
    ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean)
      .map(e => e.toLowerCase()),
  ]
  const hit = (list: string[]): CommandHit | null => {
    for (const dir of dirs) {
      for (const n of list) {
        const file = paths.join(dir, n)
        if (!exists(file) || isFolder(file)) continue
        const target = size(file) <= SHIM_MAX ? shimTarget(read(file)) : null
        return { file, target, ...(target && !exists(target) && { gone: true as const }) }
      }
    }
    return null
  }
  return platform === 'win32'
    ? { ps: hit(exts.map(e => name + e)), sh: hit([name, `${name}.exe`]) }
    : { sh: hit([name]) }
}

/** GET `url` within `timeoutMs`: whether it answered 2xx, its status, why not; with `withBody`, the JSON it answered (null: none). */
async function probe(
  url: string,
  timeoutMs = PROBE_MS,
  withBody = false,
): Promise<{ ok: boolean; status?: number; error?: string; body?: unknown }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!withBody) return { ok: res.ok, status: res.status }
    const body: unknown = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    const e = err as { cause?: { code?: unknown }; name?: unknown; message?: unknown }
    return { ok: false, error: String(e?.cause?.code || e?.name || e?.message || err) }
  }
}

/** The program a launcher runs, found the way the board would: a path as it is, else on PATH. */
function program(name: string, env: Env, platform: string): ProgramFound | null {
  if (!name) return null
  if (isAbsolute(name) || /[\\/]/.test(name)) return { file: resolve(name), found: existsSync(resolve(name)) }
  const f = findCommand(name, { env, platform })
  const found = f.ps ?? f.sh
  return { file: found?.file ?? name, found: !!found }
}

/** How new sessions start, from `launch` in config.json. */
function launcherFacts(launch: Config['launch'], env: Env, platform: string): LauncherFacts {
  if (launch?.command) {
    const cmd: unknown[] = Array.isArray(launch.command) ? launch.command : []
    const script = cmd
      .flat()
      .map(String)
      .find(s => /\.(ps1|sh|mjs|cjs|js|py)$/i.test(s) && !/\{/.test(s))
    return {
      kind: 'command',
      name: launcherLabel(cmd),
      program: program(String(cmd[0] ?? ''), env, platform),
      script: script ? { file: script, found: existsSync(script) } : null,
    }
  }
  if (launch?.agent) return { kind: 'herdr', agent: String(launch.agent) }
  let claude: string[] | null = null
  let error = ''
  try {
    claude = claudeCommand(launch?.claude, launch?.args)
    shellLine(claude, platform === 'win32')
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  return { kind: 'builtin', claude, error, program: claude ? program(claude[0] ?? '', env, platform) : null }
}

export interface MokupilotOptions {
  platform?: string
  env?: Env
  exists?: (file: string) => boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/**
 * How to start MokuPilot here (core/mokupilot.ts says what config.json's `mokupilot` may be): a
 * program and the arguments before the board's own, what was looked for and is not there, a link
 * for the viewer's browser, or off.
 */
export function mokupilotCommand(
  cfg: Partial<Config> | null | undefined,
  { platform = process.platform, env = process.env, exists = existsSync }: MokupilotOptions = {},
): MokupilotLauncher {
  const set = cfg?.mokupilot
  if (set === false) return { state: 'off', configured: true }
  const own = isRecord(set) ? set : {}
  // A link the viewer's browser opens: nothing to find here.
  if (own.link === true) return { state: 'link', configured: true }
  const win = platform === 'win32'
  const path = win ? win32 : posix
  const onPath = (name: string): string | null => {
    const f = findCommand(name, { env, platform, exists, read: () => null, size: () => 0 })
    return (f.ps ?? f.sh)?.file ?? null
  }
  // A program by its path, or by its name on PATH.
  const program = (file: string): string | null => (/[\\/]/.test(file) ? (exists(file) ? file : null) : onPath(file))
  // Found on PATH, a .cmd or .bat (a pyenv shim, say) runs only through a shell: not one to start.
  const runnable = (file: string | null): string | null => (file && !isRefusedProgram(file) ? file : null)
  // A checkout: the Python of its .venv (pythonw: no console window), as meet.cmd falls back to
  // the one on PATH; elsewhere its own `meet`.
  const checkout = (dir: string): { file: string; args: string[] } | { missing: string } => {
    if (!win) {
      const meet = path.join(dir, 'meet')
      return exists(meet) ? { file: meet, args: [] } : { missing: meet }
    }
    const run = path.join(dir, 'run.py')
    const scripts = path.join(dir, '.venv', 'Scripts')
    const python =
      [path.join(scripts, 'pythonw.exe'), path.join(scripts, 'python.exe')].find(f => exists(f)) ??
      runnable(onPath('pythonw')) ??
      runnable(onPath('python'))
    return exists(run) && python
      ? { file: python, args: [run] }
      : { missing: exists(run) ? path.join(scripts, 'pythonw.exe') : run }
  }

  if (own.command !== undefined) {
    const cmd = own.command
    const first = Array.isArray(cmd) ? cmd[0] : undefined
    if (!Array.isArray(cmd) || typeof first !== 'string' || !first.trim())
      return { state: 'missing', configured: true, file: '', error: t('mokupilot.err.command') }
    if (isRefusedProgram(first))
      return { state: 'missing', configured: true, file: first, error: t('mokupilot.err.commandShell') }
    const file = program(first)
    // A name PATH gives as a .cmd or .bat (["meet"] as meet.cmd): said as plainly as one written so.
    if (file && isRefusedProgram(file))
      return { state: 'missing', configured: true, file, error: t('mokupilot.err.commandShell') }
    const rest: CommandPart[] = cmd.slice(1).map(part => (Array.isArray(part) ? part.map(String) : String(part)))
    const template = cmd.flat().some(s => placeholdersIn(s).length) ? rest : null
    return file
      ? { state: 'ok', configured: true, file, args: template ? [] : cmd.slice(1).flat().map(String), template }
      : { state: 'missing', configured: true, file: first }
  }
  if (own.dir) {
    const c = checkout(String(own.dir))
    return 'file' in c
      ? { state: 'ok', configured: true, ...c }
      : { state: 'missing', configured: true, file: c.missing }
  }
  if (win) {
    const local = env.LOCALAPPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : '')
    const exe = local ? path.join(local, 'Programs', 'MokuPilot', 'MokuPilot.exe') : ''
    if (exe && exists(exe)) return { state: 'ok', configured: false, file: exe, args: [] }
  }
  const meet = onPath('meet')
  if (!meet) return { state: 'missing', configured: false, file: win ? 'MokuPilot.exe, meet.cmd' : 'meet' }
  if (!win) return { state: 'ok', configured: false, file: meet, args: [] }
  const c = checkout(path.dirname(meet))
  return 'file' in c
    ? { state: 'ok', configured: false, ...c }
    : { state: 'missing', configured: false, file: c.missing }
}

/**
 * The board's own wake for `board doctor` (#119), once it ships or while config.json turns it on:
 * the kill switch, the status file, whether wake answers GET /alive on its port, as the board's
 * state line asks (never waiting on herdr; not asked while off or held; the separate plugin's
 * router left there has no /alive), the sessions asleep (its /status answer's while it runs, else
 * its session file's, only read), and, while another program holds the port, whether that is the
 * separate plugin's router (its pid), and what the takeover at wake's first start took over while
 * the panel has not shown it (its marker); null: the line is herdr-wake's at wakeUrl, as before
 * (wake off before it ships is today's setup).
 */
async function wakeFacts(cfg: Partial<Config> | null | undefined, probeMs = PROBE_MS): Promise<SetupFacts['wakeNew']> {
  const s = wakeConfig(cfg?.wake)
  if (!WAKE_SHIPPED && !s.enabled) return null
  const status = s.enabled ? readWakeStatus() : null
  const up = s.enabled && status?.state !== 'held' ? await wakeAlive(s.port, probeMs) : false
  const state = wakeState({ on: s.enabled, status, answers: up, now: Date.now() })
  const answer = up ? await probe(`http://127.0.0.1:${s.port}/status`, probeMs, true) : null
  const body = answer?.ok && isRecord(answer.body) ? answer.body : null
  const sleeping = Array.isArray(body?.sleeping) ? body.sleeping.length : null
  const router = state === 'portTaken' ? await oldRouterAt(s.port, probeMs) : null
  const wakeUrl = typeof cfg?.wakeUrl === 'string' ? cfg.wakeUrl.trim().replace(/\/+$/, '') : ''
  const takenOver = unseenWakeTakeover()
  return {
    state,
    port: s.port,
    ...(state !== 'running' && status?.error !== undefined && { error: status.error }),
    ...(router !== null && { router }),
    asleep: sleeping ?? Object.values(peekWakeSessions()).filter(e => e.slept_at !== undefined).length,
    log: wakeLogFile(),
    wakeUrlSet: wakeUrl !== '' && wakeUrl !== DEFAULT_CONFIG.wakeUrl,
    ...(takenOver && { takenOver: takenOver.summary.asleep }),
  }
}

export interface GatherOptions {
  root?: string
  env?: Env
  platform?: string
  home?: string
  /** How long herdr-wake's /status (or the board's wake's /alive) may take before it counts as down. */
  probeMs?: number
  /** The profiles whose settings.json is checked; by default the shown ones (config.json's, with the folders found). */
  profiles?: Profile[]
}

/** Everything the checks look at, read from this computer. */
export async function gatherFacts(
  cfg: Partial<Config> | null | undefined,
  {
    root = ROOT,
    env = process.env,
    platform = process.platform,
    home = homedir(),
    probeMs,
    profiles: given,
  }: GatherOptions = {},
): Promise<SetupFacts> {
  const shown =
    given ??
    shownProfiles(mergeProfiles(cfg?.profiles, findProfileDirs(home), home, inheritedProfileDir(env, home)).list)
  // The board's own copy of the agents' skill, which each profile's is compared with.
  const source = readText(boardFiles(root).skill)
  const settingsIn = (
    dir: string,
  ): Pick<ProfileSettings, 'settingsFile' | 'settings' | 'settingsError' | 'skill' | 'herdrHook'> => {
    const read = readSettings(dir)
    return {
      settingsFile: read.file,
      settings: read.settings,
      settingsError: read.error,
      skill: skillIn(dir, source),
      herdrHook: herdrHookOf(read.settings),
    }
  }
  const profiles: ProfileSettings[] = shown.map(p => ({
    id: p.id,
    title: p.title,
    dir: p.dir,
    exists: isFolder(p.dir),
    ...settingsIn(p.dir),
  }))
  // The first one's at the top, where the checks with one profile and the notification check read
  // it (none shown, in a hand-edited config.json: ~/.claude's, as before).
  const first = profiles[0] ?? settingsIn(defaultProfileDir(home))
  const configFile = herdrConfigFile(env, home)
  const wakeUrl = typeof cfg?.wakeUrl === 'string' && cfg.wakeUrl ? cfg.wakeUrl : null
  const wakeNew = await wakeFacts(cfg, probeMs)
  let storage: SetupFacts['cardStore']
  try {
    storage = cardStore(env, home, platform)
  } catch (err) {
    storage = { error: err instanceof Error ? err.message : String(err) }
  }
  return {
    platform,
    root,
    cardStore: storage,
    node: process.versions.node ?? '',
    binDir: join(home, '.local', 'bin'),
    path: String(env.PATH ?? env.Path ?? ''),
    files: boardFiles(root),
    commands: {
      board: findCommand('board', { env, platform }),
      'spawn-agent': findCommand('spawn-agent', { env, platform }),
    },
    settingsFile: first.settingsFile,
    settings: first.settings,
    settingsError: first.settingsError,
    profiles,
    skill: first.skill,
    herdrHook: first.herdrHook,
    herdrConfigFile: configFile,
    herdrConfig: readText(configFile),
    wakeUrl,
    // herdr-wake at wakeUrl, unless the board's own wake has the line.
    wake: wakeUrl && !wakeNew ? await probe(`${wakeUrl.replace(/\/+$/, '')}/status`, probeMs) : null,
    ...(wakeNew && { wakeNew }),
    launcher: launcherFacts(cfg?.launch, env, platform),
    // MokuPilot for calls with a fork of a session: how the board would start it.
    mokupilot: mokupilotCommand(cfg, { platform, env }),
  }
}
