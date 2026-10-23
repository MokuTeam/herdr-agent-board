// pi sessions asleep (#178). Wake puts a pi session to sleep by stopping pi and everything it
// started, and keeps what brings it back in a file of its own (`wake-pi.json`, keyed by the
// session file, which is the session's key on the board): the pane it slept in, its folder,
// pi's command line as herdr showed it, and the Claude account folder pi's bridge ran with. The
// line typed to wake it is `board resume --pi <id>` (ids only, as for Claude: no path, no quotes),
// and `board resume --pi` runs pi on the same session file with what this module keeps of the
// command line. pi takes the session's model and provider back from the file itself, so no
// --model is passed: a session moved to another account mid-way comes back on that one.
//
// Pure: the wake process reads herdr, the processes and the files, and hands them in.
import { posix, win32 } from 'node:path'
import { sameDir } from '../launch/names.ts'
import { isPiSessionFile, piSessionId } from '../pi.ts'
import { defaultProfileDir, resolveProfileDir } from '../profiles.ts'

/** A pi session put to sleep. */
export interface PiSleeper {
  /** Its session file: the card's key. */
  session: string
  name: string
  /** The pane it slept in. */
  pane: string
  /** herdr's workspace id and label then, for a new tab when the pane is gone. */
  workspace?: string
  workspaceLabel?: string
  /** The folder pi ran in. */
  cwd: string
  /** pi's command line as herdr showed it; [] when not known (taken over from a pane stopped by hand). */
  argv: string[]
  /**
   * The Claude account folder pi's bridge ran with: its CLAUDE_CONFIG_DIR (the default folder when
   * it had none). Unset when it could not be told: the wake leaves the shell's as it is.
   */
  account?: string
  /** The provider the session goes on with, as its file says (for the log and the checks). */
  provider?: string
  slept_at: number
  /** Taken over from a pane where pi was stopped by hand (`board sleep <pane> --pi-session <file>`). */
  adopted?: true
  [extra: string]: unknown
}

/** Session file → its sleeper. */
export type PiSleepers = Record<string, PiSleeper>

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const time = (v: unknown): v is number => typeof v === 'number' && Math.abs(v) <= 8.64e15
const text = (v: unknown): v is string => typeof v === 'string'
const filled = (v: unknown): v is string => typeof v === 'string' && v !== ''

function asSleeper(key: string, value: unknown): PiSleeper | null {
  const e = record(value)
  if (!e || e.session !== key || !isPiSessionFile(key) || !filled(e.pane) || !text(e.cwd) || !time(e.slept_at))
    return null
  if (!Array.isArray(e.argv) || !e.argv.every(text)) return null
  if (e.account !== undefined && !filled(e.account)) return null
  return {
    ...e,
    session: key,
    name: text(e.name) ? e.name : '',
    pane: e.pane,
    cwd: e.cwd,
    argv: e.argv,
    slept_at: e.slept_at,
  }
}

/** null for what is not an object; entries that do not read as sleepers dropped; unknown fields kept. */
export function asPiSleepers(value: unknown): PiSleepers | null {
  const all = record(value)
  if (!all) return null
  const kept: [string, PiSleeper][] = []
  for (const [key, v] of Object.entries(all)) {
    const s = asSleeper(key, v)
    if (s) kept.push([key, s])
  }
  return Object.fromEntries(kept)
}

// A pi session id as the wake line carries it: what `board resume --pi` takes.
const PLAIN_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/

/** The line typed into a pane to wake the session; null when its file's name has no id the line can carry. */
export function piWakeLine(file: string): string | null {
  const id = piSessionId(file)
  return PLAIN_ID.test(id) ? `board resume --pi ${id}` : null
}

export const PI_RESUME_USAGE = 'board resume --pi <pi session id>'

/** `board resume --pi <id>`'s id; throws with the usage. */
export function parsePiResume(args: readonly string[]): string {
  const rest = args.filter(a => a !== '--pi')
  if (rest.length !== 1) throw new Error(`which pi session? ${PI_RESUME_USAGE}`)
  const id = String(rest[0])
  if (!PLAIN_ID.test(id)) throw new Error(`"${id}" is not a pi session id. ${PI_RESUME_USAGE}`)
  return id
}

// pi 1.3's options (`pi --help`), by what a wake does with them. Kept: what shapes the session's
// tools, extensions and look. Dropped: what picks or starts another conversation, names it, or
// sets the model (the session file has the model it goes on with), and what is no interactive run.
const VALUE_KEPT: ReadonlySet<string> = new Set([
  '--api-key',
  '--system-prompt',
  '--append-system-prompt',
  '--session-dir',
  '--models',
  '--tools',
  '-t',
  '--exclude-tools',
  '-xt',
  '--extension',
  '-e',
  '--skill',
  '--prompt-template',
  '--theme',
  '--use-theme',
  '--tui-mode',
])
const VALUE_DROPPED: ReadonlySet<string> = new Set([
  '--provider',
  '--model',
  '--mode',
  '--session',
  '--session-id',
  '--fork',
  '--name',
  '-n',
  '--thinking',
  '--export',
])
const FLAG_KEPT: ReadonlySet<string> = new Set([
  '--no-tools',
  '-nt',
  '--no-builtin-tools',
  '-nbt',
  '--no-extensions',
  '-ne',
  '--no-mcp',
  '--no-skills',
  '-ns',
  '--no-prompt-templates',
  '-np',
  '--no-themes',
  '--no-context-files',
  '-nc',
  '--verbose',
  '--approve',
  '-a',
  '--no-approve',
  '-na',
  '--offline',
])
const FLAG_DROPPED: ReadonlySet<string> = new Set([
  '--print',
  '-p',
  '--continue',
  '-c',
  '--resume',
  '-r',
  '--no-session',
  '--list-models',
  '--help',
  '-h',
  '--version',
  '-v',
])

/** Whether a program (a name or a path, either separator) is pi. */
export function isPiProgram(program: unknown): boolean {
  const base = (
    String(program ?? '')
      .split(/[\\/]/)
      .pop() ?? ''
  ).toLowerCase()
  return /^pi(\.exe|\.cmd|\.ps1)?$/.test(base)
}

/**
 * The program and arguments that resume the session in `file` with pi's command line `argv` as
 * herdr showed it: pi (argv's first word when it is pi, else `pi`), the options kept, then
 * `--session <file>`. Messages, `@files` and everything after `--` are left out. An option pi
 * does not list (an extension's) is kept in its `--name=value` form; in the `--name value` form
 * nobody can tell whether the next word is its value or a message, so there is no line: `error`.
 */
export function piResumeArgv(argv: readonly string[], file: string): { argv: string[] } | { error: string } {
  const [first, ...rest] = argv
  const kept: string[] = [first && isPiProgram(first) ? first : 'pi']
  for (let i = 0; i < rest.length; i++) {
    const arg = String(rest[i])
    if (arg === '--') break
    if (!arg.startsWith('-') || arg === '-') continue // a message or an @file
    const eq = arg.indexOf('=')
    const name = eq > 0 ? arg.slice(0, eq) : arg
    if (VALUE_KEPT.has(name)) {
      if (eq > 0) kept.push(arg)
      else if (i + 1 < rest.length) kept.push(arg, String(rest[++i]))
    } else if (VALUE_DROPPED.has(name)) {
      if (eq < 0) i++
    } else if (FLAG_KEPT.has(name)) kept.push(arg)
    else if (FLAG_DROPPED.has(name)) continue
    else if (eq > 0) kept.push(arg)
    else return { error: `its command line has an option wake cannot read: ${arg}` }
  }
  return { argv: [...kept, '--session', file] }
}

type Env = Record<string, string | undefined>

/**
 * The env pi resumes in: the shell's, with CLAUDE_CONFIG_DIR for the account it slept with, as
 * `board resume` sets a Claude session's (core/resume.ts resumePlan): left as it is when it points
 * there already, unset for the default folder, set for any other. No account kept: as it is.
 */
export function piResumeEnv(
  env: Env,
  account: string | undefined,
  home: string,
  platform: string = process.platform,
): Env {
  if (!account || sameDir(resolveProfileDir(env.CLAUDE_CONFIG_DIR, home, platform), account)) return env
  const out: Env = { ...env }
  if (sameDir(account, defaultProfileDir(home, platform))) delete out.CLAUDE_CONFIG_DIR
  else out.CLAUDE_CONFIG_DIR = account
  return out
}

/**
 * The account folder a running pi's bridge uses, from its CLAUDE_CONFIG_DIR as read from its
 * process ('' when it has none: the default folder); undefined when it could not be read.
 */
export function accountOf(
  configDir: string | null,
  home: string,
  platform: string = process.platform,
): string | undefined {
  if (configDir === null) return undefined
  const dir = resolveProfileDir(configDir, home, platform)
  return (platform === 'win32' ? win32 : posix).isAbsolute(dir) ? dir : undefined
}

/** A pane as herdr's snapshot shows it, the fields read here. */
export interface PiPane {
  pane_id: string
  workspace_id?: string
  agent?: string | null
  agent_session?: { value?: string | null } | null
  cwd?: string
  label?: string
}

/** herdr's snapshot, the parts read here. */
export interface PiSnapshot {
  workspaces: { workspace_id: string; label?: string }[]
  panes: PiPane[]
}

/**
 * The sleeper's own pane, while herdr still has it as it was left: a shell (no agent) labelled
 * `💤 <name>` or in the sleeper's folder. Any other pane, or none: undefined (it wakes in a new tab).
 */
export function piSleeperPane(
  snap: Pick<PiSnapshot, 'panes'>,
  s: Pick<PiSleeper, 'pane' | 'name' | 'cwd'>,
): PiPane | undefined {
  const p = snap.panes.find(x => x.pane_id === s.pane)
  if (!p || p.agent) return undefined
  return p.label === sleepLabel(s) || sameDir(p.cwd, s.cwd) ? p : undefined
}

/** The label a sleeper's pane gets. */
export const sleepLabel = (s: Pick<PiSleeper, 'name'>): string => `💤 ${s.name}`

/** A pi sleeper as `GET /sleeping?agents=all` lists it: the old router's fields, then pi's own. */
export interface PiSleepingAnswer {
  name: string
  /** Its own pane while herdr has it as it was left; '' when it wakes in a new tab. */
  pane: string
  session: string
  workspace: string
  slept_at: string
  exited: false
  agent: 'pi'
  cwd: string
}

/** Every pi sleeper, its pane only while it is still its own (piSleeperPane), its workspace's label as herdr has it now. */
export function piSleepingOf(snap: PiSnapshot, sleepers: PiSleepers): PiSleepingAnswer[] {
  const labels = new Map(snap.workspaces.map(w => [w.workspace_id, w.label]))
  return Object.values(sleepers).map(s => {
    const own = piSleeperPane(snap, s)
    const workspace = (s.workspace === undefined ? undefined : labels.get(s.workspace)) ?? s.workspaceLabel ?? ''
    return {
      name: s.name,
      pane: own?.pane_id ?? '',
      session: s.session,
      workspace,
      slept_at: new Date(s.slept_at).toISOString(),
      exited: false,
      agent: 'pi',
      cwd: s.cwd,
    }
  })
}

/** The sleepers whose session runs again in a pane (woken by hand, by the board or after a restart). */
export function piWoken(snap: Pick<PiSnapshot, 'panes'>, sleepers: PiSleepers): string[] {
  const running = new Set(
    snap.panes.flatMap(p => (p.agent === 'pi' && p.agent_session?.value ? [p.agent_session.value] : [])),
  )
  return Object.keys(sleepers).filter(file => running.has(file))
}

/** A sleeper by its session file, its id, its pane or its name (any case); the first that fits. */
export function findPiSleeper(target: unknown, sleepers: PiSleepers): PiSleeper | undefined {
  const t = String(target ?? '').trim()
  if (!t) return undefined
  const lower = t.toLowerCase()
  const all = Object.values(sleepers)
  return (
    sleepers[t] ??
    all.find(s => piSessionId(s.session).toLowerCase() === lower) ??
    all.find(s => s.pane === t) ??
    all.find(s => s.name !== '' && s.name.toLowerCase() === lower)
  )
}
