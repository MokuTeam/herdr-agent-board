// Antigravity CLI (`agy`) sessions asleep (#631, part of #127). Wake puts an `agy` session to
// sleep by exiting `agy` cleanly and keeps what brings it back in a file of its own
// (`wake-agy.json`, keyed by the conversation UUID, which is the session's key on the board): the
// pane it slept in, its workspace, its folder, and `agy`'s command line as herdr showed it. The
// line typed to wake it is `board resume --agy <id>` (UUID only, no path, no quotes, so every
// shell runs it regardless of spaces, Cyrillic or `%`), and `board resume --agy` runs `agy` with
// `--conversation <id>` and the session flags kept from `argv` (falling back to `launch.agy`).
//
// Pure: the wake process reads herdr, the processes and the files, and hands them in.
import { AGY_AGENT, isAgySession } from '../agy.ts'
import { sameDir } from '../launch/names.ts'

/** An Antigravity CLI session put to sleep. */
export interface AgySleeper {
  /** Its conversation UUID: the card's key. */
  session: string
  name: string
  /** The pane it slept in. */
  pane: string
  /** herdr's workspace id and label then, for a new tab when the pane is gone. */
  workspace?: string
  workspaceLabel?: string
  /** The folder `agy` ran in. */
  cwd: string
  /** `agy`'s command line as herdr showed it; [] when not known (`launch.agy` is used on resume). */
  argv: string[]
  slept_at: number
  [extra: string]: unknown
}

/** Conversation UUID -> its sleeper. */
export type AgySleepers = Record<string, AgySleeper>

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const time = (v: unknown): v is number => typeof v === 'number' && Math.abs(v) <= 8.64e15
const text = (v: unknown): v is string => typeof v === 'string'
const filled = (v: unknown): v is string => typeof v === 'string' && v !== ''

function asSleeper(key: string, value: unknown): AgySleeper | null {
  const e = record(value)
  if (!e || e.session !== key || !isAgySession(key) || !filled(e.pane) || !text(e.cwd) || !time(e.slept_at)) return null
  if (!Array.isArray(e.argv) || !e.argv.every(text)) return null
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
export function asAgySleepers(value: unknown): AgySleepers | null {
  const all = record(value)
  if (!all) return null
  const kept: [string, AgySleeper][] = []
  for (const [key, v] of Object.entries(all)) {
    const s = asSleeper(key, v)
    if (s) kept.push([key, s])
  }
  return Object.fromEntries(kept)
}

/** The line typed into a pane to wake the session; null when `session` is not a conversation UUID. */
export function agyWakeLine(session: string): string | null {
  return isAgySession(session) ? `board resume --agy ${session}` : null
}

export const AGY_RESUME_USAGE = 'board resume --agy <conversation id>'

/** `board resume --agy <id>`'s conversation UUID; throws with the usage. */
export function parseAgyResume(args: readonly string[]): string {
  const rest = args.filter(a => a !== '--agy')
  if (rest.length !== 1) throw new Error(`which Antigravity session? ${AGY_RESUME_USAGE}`)
  const id = String(rest[0])
  if (!isAgySession(id)) throw new Error(`"${id}" is not an Antigravity conversation id. ${AGY_RESUME_USAGE}`)
  return id
}

// `agy --help` options, by what a wake does with them. Kept: interactive session options
// (permissions, workspace dirs, agent/model/effort/mode, sandbox, remote, settings). Dropped:
// what picks/creates another conversation or runs non-interactively.
const VALUE_KEPT: ReadonlySet<string> = new Set([
  '--add-dir',
  '--agent',
  '--effort',
  '--log-file',
  '--mode',
  '--model',
  '--project',
  '--settings',
])
const VALUE_DROPPED: ReadonlySet<string> = new Set([
  '--conversation',
  '--input-format',
  '--json-schema',
  '--output-format',
  '--print-timeout',
])
const FLAG_KEPT: ReadonlySet<string> = new Set([
  '--dangerously-skip-permissions',
  '--remote-agent',
  '--remote-control',
  '--sandbox',
])
const FLAG_DROPPED: ReadonlySet<string> = new Set([
  '-c',
  '--continue',
  '--disable-slash-commands',
  '-i',
  '--prompt-interactive',
  '--new-project',
  '-p',
  '--print',
  '--prompt',
  '-h',
  '--help',
  '-v',
  '--version',
])

/** Whether a program (a name or a path, either separator) is `agy`. */
export function isAgyProgram(program: unknown): boolean {
  const base = (
    String(program ?? '')
      .split(/[\\/]/)
      .pop() ?? ''
  ).toLowerCase()
  return /^agy(\.exe|\.cmd|\.ps1)?$/.test(base)
}

/**
 * The program and arguments that resume `session` with `agy`'s command line `argv` as herdr showed
 * it (or `fallback`, e.g. `launch.agy`, when `argv` is empty): `agy`, the interactive options kept,
 * then `--conversation <session>`. Positional prompts and everything after `--` are left out.
 * Unknown `--name=value` options are kept; an unknown `--name` without `=` returns `{ error }`.
 */
export function agyResumeArgv(
  argv: readonly string[],
  session: string,
  fallback: readonly string[] = [AGY_AGENT],
): { argv: string[] } | { error: string } {
  const source = argv.length ? argv : fallback.length ? fallback : [AGY_AGENT]
  const [first, ...rest] = source
  const program = argv.length ? (first && isAgyProgram(first) ? first : AGY_AGENT) : first || AGY_AGENT
  const kept: string[] = [program]
  for (let i = 0; i < rest.length; i++) {
    const arg = String(rest[i])
    if (arg === '--') break
    if (!arg.startsWith('-') || arg === '-') continue
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
  return { argv: [...kept, '--conversation', session] }
}

/** A pane as herdr's snapshot shows it, the fields read here. */
export interface AgyPane {
  pane_id: string
  workspace_id?: string
  agent?: string | null
  agent_session?: { value?: string | null } | null
  cwd?: string
  label?: string
}

/** herdr's snapshot, the parts read here. */
export interface AgySnapshot {
  workspaces: { workspace_id: string; label?: string }[]
  panes: AgyPane[]
}

/** The label a sleeper's pane gets. */
export const agySleepLabel = (s: Pick<AgySleeper, 'name'>): string => `💤 ${s.name}`

/**
 * The sleeper's own pane, while herdr still has it as it was left: a shell (no agent) labelled
 * `💤 <name>` or in the sleeper's folder. Any other pane, or none: undefined (it wakes in a new tab).
 */
export function agySleeperPane(
  snap: Pick<AgySnapshot, 'panes'>,
  s: Pick<AgySleeper, 'pane' | 'name' | 'cwd'>,
): AgyPane | undefined {
  const p = snap.panes.find(x => x.pane_id === s.pane)
  if (!p || p.agent) return undefined
  return p.label === agySleepLabel(s) || sameDir(p.cwd, s.cwd) ? p : undefined
}

/** An `agy` sleeper as `GET /sleeping?agents=all` lists it. */
export interface AgySleepingAnswer {
  name: string
  /** Its own pane while herdr has it as it was left; '' when it wakes in a new tab. */
  pane: string
  session: string
  workspace: string
  slept_at: string
  exited: false
  agent: 'agy'
  cwd: string
}

/** Every `agy` sleeper, its pane only while still its own (`agySleeperPane`), its workspace's label as herdr has it now. */
export function agySleepingOf(snap: AgySnapshot, sleepers: AgySleepers): AgySleepingAnswer[] {
  const labels = new Map(snap.workspaces.map(w => [w.workspace_id, w.label]))
  return Object.values(sleepers).map(s => {
    const own = agySleeperPane(snap, s)
    const workspace = (s.workspace === undefined ? undefined : labels.get(s.workspace)) ?? s.workspaceLabel ?? ''
    return {
      name: s.name,
      pane: own?.pane_id ?? '',
      session: s.session,
      workspace,
      slept_at: new Date(s.slept_at).toISOString(),
      exited: false,
      agent: AGY_AGENT,
      cwd: s.cwd,
    }
  })
}

/** The sleepers whose session runs again in a pane (woken by hand, by the board or after a restart). */
export function agyWoken(snap: Pick<AgySnapshot, 'panes'>, sleepers: AgySleepers): string[] {
  const running = new Set(
    snap.panes.flatMap(p =>
      p.agent === AGY_AGENT && p.agent_session?.value ? [p.agent_session.value.toLowerCase()] : [],
    ),
  )
  return Object.keys(sleepers).filter(id => running.has(id.toLowerCase()))
}

/** A sleeper by its conversation UUID, its pane or its name (any case, optional ` [hex]` stripped); the first that fits. */
export function findAgySleeper(target: unknown, sleepers: AgySleepers): AgySleeper | undefined {
  const raw = String(target ?? '').trim()
  if (!raw) return undefined
  const t = raw.replace(/\s*\[[0-9a-f]+\]\s*$/i, '').trim()
  const lower = t.toLowerCase()
  const all = Object.values(sleepers)
  return (
    sleepers[raw] ??
    all.find(s => s.session.toLowerCase() === lower) ??
    all.find(s => s.pane === raw) ??
    all.find(s => s.name !== '' && s.name.toLowerCase() === lower)
  )
}
