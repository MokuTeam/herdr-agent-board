// The profile bundle (design: docs/design/nodes, 9): what of a Claude profile folder a node gets.
// A copy does not work (2, items 8 and 9): a Windows master's hooks and stdio MCP servers name
// C:\ paths and PowerShell. So the bundle is a translation with a report. Skills, agents,
// commands and CLAUDE.md travel as files; the plain settings as keys; a hook or an MCP server only
// when it can run on the node, rewritten where the profile folder's path is in it. What stays
// behind, and every secret the node has to be given instead, is a line of the report that
// `board doctor --node` prints. Pure: adapters/bundle-files.ts walks the folder,
// services/nodes/bundle-sync.ts sends the bundle and services/node/bundle.ts applies it.

import { createHash } from 'node:crypto'
import { isBoardCommand, normPath } from './install-plan.ts'
import { claudeCommand } from './launch/spawn-args.ts'
import { pathsIn } from './portable.ts'
import { isHerdrHook, SKILL, TEAM_SKILL, THREADS_SKILL } from './setup.ts'

/** The manifest's shape; a node refuses one it does not know. */
export const BUNDLE_FORMAT = 1

/**
 * What a rewritten command has where the master's profile folder was. The node puts its own
 * folder there when it applies the bundle. Braces, so a node that did not fill it in fails loudly
 * instead of running a path of its own.
 */
export const PROFILE_DIR = '{{profile-dir}}'

/** A file of the bundle: its path in the profile folder (forward slashes), its content's SHA-256 (hex), its mode. */
export interface BundleFile {
  path: string
  sha256: string
  mode: number
}

export type ReportKind = 'skill' | 'hook' | 'mcp' | 'env' | 'file' | 'launcher' | 'ack'
export type Verdict = 'sent' | 'translated' | 'not-sent' | 'needs-secret' | 'bound'
/** Why an entry got its verdict; doctor turns it into words. */
export type ReportWhy =
  | 'copied' // sent as it is
  | 'profile-path' // the profile folder's path in it became PROFILE_DIR
  | 'script-sent' // as profile-path, and the files it names there travel; what they need is not checked
  | 'program-renamed' // the hook's program has another name on the node (detail: `python → python3`)
  | 'program-missing' // the node said it has no such program (detail: the program)
  | 'program-unchecked' // a program a node of that platform may lack; the node did not say (detail: the program)
  | 'secret-file' // a file beside a sent script that the script names and that holds a secret (detail: the script)
  | 'script-state' // a file beside a sent script that the script names and that holds none: maybe its own state (detail: the script)
  | 'acknowledged' // the owner's answer to a notice, from the profile's .claude.json (detail: what turns the notice on)
  | 'script-missing' // it names a file of the profile folder the walk did not read (detail: the path)
  | 'local-path' // it names a path of this computer
  | 'windows-only' // PowerShell, cmd, a Windows script or program, for a node that is not Windows
  | 'secret-inline' // a hook with a value that looks like a secret in its command
  | 'credentials' // a setting that fetches credentials: the node logs in on its own
  | 'secret-name' // an env name that looks like a secret: give the node the value
  | 'secret-value' // a header or a value that looks like a secret became a ${VAR}
  | 'reference' // the server refers to a ${VAR}: the node's sessions must have it, as a secret or in the env file (not always a secret: it may be the session's own environment)
  | 'launcher' // a stdio server run by a launcher the node has
  | 'unwrapped' // the launcher's path, `.cmd` or `cmd /c` taken off
  | 'local-command' // a stdio server whose program is not a launcher
  | 'local-url' // a server on this computer's loopback
  | 'override' // nodes.devices.<id>.mcp gives this node its own command
  | 'off' // nodes.devices.<id>.mcp switches it off for this node
  | 'invalid' // an entry Claude Code could not run either
  | 'own-launcher' // launch.claude runs a program of the owner's own
  | 'board-own' // a skill the board's install puts into every profile: the node's install writes its own
  | 'unsafe-name' // a name a node does not write (a control character, a backslash, a Windows device name)
  | SkipWhy
  | 'link-followed' // a link in the profile folder: its target's content travels

/** Why the walk left a file or folder out. */
export type SkipWhy =
  | 'too-big' // over MAX_FILE_BYTES
  | 'skipped-folder' // node_modules, .git, .venv, __pycache__
  | 'link-broken' // a link whose target is not there
  | 'link-into-profile' // a link to a part of the profile folder that is never sent
  | 'link-loop' // a link back to a folder the walk is already in
  | 'missing' // a file a hook names that is not there, or is not a file
  | 'denied' // credentials, .claude.json or .ssh, wherever a link leads to them
  | 'unreadable' // gone or locked while the walk read it

export interface ReportEntry {
  kind: ReportKind
  /** A skill's folder name, a hook's script, a server's name, a variable to give, a file's path. */
  name: string
  verdict: Verdict
  why: ReportWhy
  /** The command, path or server it is about. Never a value. */
  detail?: string
  /** The owner has seen this difference and accepts it (`nodes.devices.<id>.accept`, `<kind>:<name>`). */
  accepted?: true
}

/** The board's own part of the node's config.json (7.2): the four keys the master owns, and launch.claude when it travels. */
export interface BoardSlice {
  categories?: unknown
  language?: unknown
  models?: unknown
  /** This node's `secrets.sinks`, from `nodes.devices.<id>.sinks`. */
  sinks: unknown
  launch?: { claude: unknown }
}

export interface BundleManifest {
  format: number
  files: BundleFile[]
  /** settings.json's portable keys, `env` without the secrets, `hooks` apart. */
  settings: Record<string, unknown>
  /** settings.json's portable hooks by event, the profile folder rewritten. */
  hooks: Record<string, unknown[]>
  /** The portable MCP servers of the user scope, by name. */
  mcp: Record<string, unknown>
  board: BoardSlice
  /**
   * The keys of ACKNOWLEDGMENTS the master's profile has as true: the node puts them into its
   * profile's .claude.json. Absent when there are none, so a bundle without them hashes as before.
   */
  acks?: string[]
  /** Not part of the hash: accepting a difference changes nothing on the node. */
  report: ReportEntry[]
}

/**
 * Where the bundle goes and where it comes from. Windows to Linux, Linux to Linux and macOS to
 * Linux are each this data with other values.
 */
export interface BundleContext {
  /** The master's platform. */
  from: string
  /** The node's platform. */
  to: string
  /** The master's profile folder. */
  profileDir: string
  /** The master's home folder: `~/.claude` in a command is the profile folder too. */
  home?: string
  /** The board's own folder on the master: a hook running a file in it is the board's even under another name. */
  boardDir?: string
  /** `nodes.devices.<id>.mcp`: per server, false, or `{ command, args, env }`. */
  mcp?: Readonly<Record<string, unknown>>
  /** `nodes.devices.<id>.accept`. */
  accept?: readonly string[]
  /**
   * The programs of NODE_PROGRAMS the node said it has (its status); undefined when it did not say
   * (a node of an older board, or no status yet).
   */
  programs?: readonly string[]
}

/** The launchers a node is expected to have (9.1). */
export const LAUNCHERS: ReadonlySet<string> = new Set(['npx', 'uvx', 'bunx', 'node', 'python', 'python3', 'docker'])
/**
 * Names that look like a secret's: their value never goes into a bundle. A count of tokens
 * (`MAX_THINKING_TOKENS`) is a number, not a secret.
 */
export const SECRET_NAME = /token(?!s)|key|secret|password/i
/**
 * Keys of a profile's .claude.json that hold the owner's answer to a notice which a setting turns
 * on, by that setting (#602). Without the answer Claude Code asks again at every start on the node,
 * and the start stops there. Read from Claude Code itself: it shows the Code Mode notice until both
 * of its keys are true, and runs `permissions.defaultMode: "bypassPermissions"` as default mode
 * until the third is. Each travels whenever the master has it as true, whether or not the bundle
 * sends its setting this time: it is the owner's answer, wherever the setting comes from. Only
 * these keys travel, only as true, and the node writes no other key of that file.
 */
export const ACKNOWLEDGMENTS: Readonly<Record<string, string>> = {
  codeModeCaveatsAcceptedV1: 'env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE',
  codeModeAutoModeCaveatAcceptedV1: 'env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE',
  bypassPermissionsModeAccepted: 'permissions.defaultMode',
}

/** The keys of ACKNOWLEDGMENTS a profile's .claude.json has as true, sorted. */
export function acknowledgmentsOf(state: unknown): string[] {
  if (!isRecord(state)) return []
  return Object.keys(ACKNOWLEDGMENTS)
    .filter(k => Object.hasOwn(state, k) && state[k] === true)
    .sort()
}

/**
 * The programs a hook may run that a node may lack or name otherwise (#603): a node's status says
 * which of them it has, asked once (services/node/status.ts).
 */
export const NODE_PROGRAMS = ['python', 'python3', 'py', 'pwsh', 'powershell', 'node', 'bash'] as const

/** Settings whose command fetches credentials: never sent, a node logs in with its own profile. */
const CREDENTIAL_KEYS = new Set(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'])
const WINDOWS_SHELLS = new Set(['powershell', 'pwsh', 'cmd'])
const WINDOWS_ONLY = /\.(ps1|bat|cmd|exe)$/i
// Paths every POSIX node has, and Git Bash on a Windows master has the same: not a path of this computer.
const EVERYWHERE = /^\/(dev\/[\w.-]+|bin\/(ba)?sh|usr\/bin\/env|tmp(\/[^\s]*)?)$/
// A path from a home or a variable: ~/x, $HOME/x, ${HOME}/x, %USERPROFILE%\x.
const HOME_PATH = /(?<![\w$%{}~])(~|\$HOME|\$\{HOME\}|%[A-Za-z_]+%)[\\/][^\s"'`]*/
const PLACED = /\{\{profile-dir\}\}[^\s"'`]*/g

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** An own key, `__proto__` too, as JSON.parse gives it: config and settings are what the owner typed. */
const put = (o: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true })
}
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))
const entriesOf = (v: unknown): [string, unknown][] => (isRecord(v) ? Object.entries(v) : [])
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const caseFree = (platform: string): boolean => platform === 'win32' || platform === 'darwin'

/** A command's words as a shell splits them, quotes taken off. Enough to find its program and paths. */
export function wordsOf(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = ''
  let any = false
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = ''
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      any = true
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur)
      cur = ''
      any = false
    } else cur += ch
  }
  if (cur || any) out.push(cur)
  return out
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path
/** A program's name for comparing: no folder, no `.exe` or `.cmd`, lower case. */
const programName = (word: string): string =>
  baseName(word)
    .toLowerCase()
    .replace(/\.(exe|cmd)$/, '')
/** The program of a command: its first word that is not a `NAME=value` before it. */
const programOf = (words: readonly string[]): string => words.find(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? ''

/**
 * Every way a command may name the master's profile folder, with forward slashes: as given, Git
 * Bash's `/c/...` on Windows, and from the home folder (`~`, `$HOME`, `%USERPROFILE%`).
 */
function profileForms(ctx: BundleContext): string[] {
  const trim = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const dir = trim(ctx.profileDir)
  const forms = new Set([dir])
  const drive = /^([A-Za-z]):\/(.*)$/.exec(dir)
  if (ctx.from === 'win32' && drive) forms.add(`/${(drive[1] ?? '').toLowerCase()}/${drive[2] ?? ''}`)
  const home = ctx.home ? trim(ctx.home) : ''
  const under =
    home && (caseFree(ctx.from) ? dir.toLowerCase().startsWith(`${home.toLowerCase()}/`) : dir.startsWith(`${home}/`))
  if (under) {
    const rel = dir.slice(home.length + 1)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${HOME}
    for (const start of ['~', '$HOME', '${HOME}', ...(ctx.from === 'win32' ? ['%USERPROFILE%'] : [])])
      forms.add(`${start}/${rel}`)
  }
  return [...forms].filter(Boolean).sort((a, b) => b.length - a.length)
}

/**
 * The command with the profile folder, in any of its forms and either slash, as PROFILE_DIR, and
 * the rest of each such path in forward slashes. A folder only matches whole: `.claude` is not
 * the start of `.claude-work`.
 */
export function withProfileDir(command: string, ctx: BundleContext): string {
  let out = command
  for (const form of profileForms(ctx)) {
    const body = escapeRe(form).replace(/\//g, '[\\\\/]')
    const re = new RegExp(`(?<![\\w\\\\/.~-])${body}(?=[\\\\/"'\`\\s]|$)`, caseFree(ctx.from) ? 'gi' : 'g')
    out = out.replace(re, () => PROFILE_DIR)
  }
  return ctx.from === 'win32' ? out.replace(PLACED, run => run.replace(/\\/g, '/')) : out
}

/** The paths of this computer a command or an argument names, PROFILE_DIR's excepted. */
function localPaths(text: string): string[] {
  const masked = text.replace(PLACED, ' ')
  const found = pathsIn(masked).filter(p => !EVERYWHERE.test(p))
  const home = HOME_PATH.exec(masked)
  return home ? [...found, home[0]] : found
}

const holdsValue = (v: unknown): v is string => typeof v === 'string' && v !== '' && !v.includes('${')
const SECRET_HEADER = /^(authorization|proxy-authorization|[\w-]*(token|key|secret|password)[\w-]*)\s*:\s*(.+)$/i

/**
 * Where a value that looks like a secret is in a command's words: `NAME=value`, `--name=value`,
 * `--name value` and a header `Name: value`, each with a name like a secret's. `at` is the word,
 * `name` the name, `value` the value as written; `next`: the value is the word after.
 */
export function secretsIn(words: readonly string[]): { at: number; name: string; value: string; next: boolean }[] {
  const found: { at: number; name: string; value: string; next: boolean }[] = []
  words.forEach((w, at) => {
    const assign = /^(-{0,2})([A-Za-z_][\w.-]*)=(.*)$/s.exec(w)
    if (assign) {
      const [, , name = '', value = ''] = assign
      if (SECRET_NAME.test(name) && holdsValue(value)) found.push({ at, name, value, next: false })
      return
    }
    const flag = /^--?([A-Za-z][\w-]*)$/.exec(w)
    const after = words[at + 1]
    if (flag && SECRET_NAME.test(flag[1] ?? '') && after !== undefined && !after.startsWith('-') && holdsValue(after)) {
      found.push({ at, name: flag[1] ?? '', value: after, next: true })
      return
    }
    const header = SECRET_HEADER.exec(w)
    if (header && holdsValue(header[3])) found.push({ at, name: header[1] ?? '', value: header[3] ?? '', next: false })
  })
  return found
}

/** A command for the report: each value that looks like a secret (secretsIn) as `***`. */
export function redacted(command: string): string {
  let out = command
  for (const s of secretsIn(wordsOf(command))) out = out.split(s.value).join('***')
  return out
}

type CommandVerdict =
  | { ok: true; command: string; translated: boolean; files: string[] }
  | { ok: false; why: 'local-path' | 'windows-only' | 'secret-inline' }

/** Whether a node of platform `to` may lack `program` or have it under another name, when it did not say which it has. */
const mayLack = (program: string, to: string): boolean =>
  ((program === 'python' || program === 'py') && to !== 'win32') || program === 'pwsh'

/** The name a program has on a node that lacks it, when that is no guess: Python 3's own on a POSIX node. */
const OTHER_NAME: Readonly<Record<string, string>> = { python: 'python3' }

export type ProgramVerdict =
  | { ok: true; command: string; renamed?: { from: string; to: string }; unchecked?: string }
  | { ok: false; why: 'program-missing'; program: string }

/**
 * A command that runs on the node (classifyCommand) against the programs the node has (#603), when
 * its program is a bare name of NODE_PROGRAMS. With the node's list: one it has goes as it is;
 * `python` it lacks while it has `python3` goes as `python3`; any other it lacks is not sent.
 * Without the list: one a node of that platform may lack goes as it is, and `unchecked` says so.
 * Any other program, or one named with a folder (a profile's own venv), is not this rule's.
 */
export function programRule(command: string, ctx: Pick<BundleContext, 'to' | 'programs'>): ProgramVerdict {
  const word = programOf(wordsOf(command))
  const program = programName(word)
  if (/[\\/]/.test(word) || !(NODE_PROGRAMS as readonly string[]).includes(program)) return { ok: true, command }
  if (!ctx.programs) return mayLack(program, ctx.to) ? { ok: true, command, unchecked: program } : { ok: true, command }
  if (ctx.programs.includes(program)) return { ok: true, command }
  const other = OTHER_NAME[program]
  if (other && ctx.programs.includes(other)) {
    const renamed = renameProgram(command, other)
    if (renamed !== null) return { ok: true, command: renamed, renamed: { from: program, to: other } }
  }
  return { ok: false, why: 'program-missing', program }
}

/** The command with its program (its first word after any `NAME=value`) as `to`; null when the word is not plain there. */
function renameProgram(command: string, to: string): string | null {
  const m = /^(\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']*)+\s+)*)(["']?)([^\s"']+)\2(?=\s|$)/.exec(
    command,
  )
  return m ? `${m[1] ?? ''}${to}${command.slice(m[0].length)}` : null
}

/**
 * Whether a hook's command is never sent: the board's own (any copy's, or one running a file of
 * `boardDir`), or herdr's own SessionStart hook, which the node's herdr installs with its paths.
 */
export function isBoardHook(command: string, ctx: Pick<BundleContext, 'boardDir'>): boolean {
  if (isBoardCommand(command) || isHerdrHook(command)) return true
  return !!ctx.boardDir && normPath(command).includes(`${normPath(ctx.boardDir)}/`)
}

/**
 * Whether a command runs on the node (9.1, hooks): it lives in the profile folder (rewritten to
 * PROFILE_DIR) or is a bare command the node finds on its PATH, and names no other path of this
 * computer. PowerShell, cmd and Windows scripts do not run on a node that is not Windows.
 */
export function classifyCommand(command: string, ctx: BundleContext): CommandVerdict {
  const rewritten = withProfileDir(command, ctx)
  const words = wordsOf(rewritten)
  if (ctx.to !== 'win32') {
    if (WINDOWS_SHELLS.has(programName(programOf(words)))) return { ok: false, why: 'windows-only' }
    if (words.some(w => WINDOWS_ONLY.test(w))) return { ok: false, why: 'windows-only' }
  }
  if (localPaths(rewritten).length) return { ok: false, why: 'local-path' }
  // `{{profile-dir}}/../x` leaves the folder.
  if ([...rewritten.matchAll(PLACED)].some(m => /(^|\/)\.\.(\/|$)/.test(m[0].slice(PROFILE_DIR.length))))
    return { ok: false, why: 'local-path' }
  if (secretsIn(words).length) return { ok: false, why: 'secret-inline' }
  return { ok: true, command: rewritten, translated: rewritten !== command, files: filesIn(rewritten) }
}

/**
 * The files of the profile folder a rewritten command names, by path in the folder: the script a
 * hook runs and whatever else it names there. They travel with it (9.1); what they read or run in
 * turn is not followed.
 */
export function filesIn(command: string): string[] {
  const paths = [...command.matchAll(PLACED)].map(m =>
    m[0]
      .slice(PROFILE_DIR.length)
      .replace(/^\/+/, '')
      .replace(/[;&|)]+$/, ''),
  )
  return [...new Set(paths.filter(p => p && !p.endsWith('/')))]
}

/** A file a script may read as data: JSON, env, ini, toml or yaml (#603). */
export const dataFile = (name: string): boolean => /\.(json|env|ini|toml|ya?ml)$/i.test(name)

/**
 * Whether a script's text names a file by its base name as a string: in quotes, or at the end of a
 * path in quotes (`"config.json"`, `'./config.json'`). A word in a comment or a longer name is not it.
 */
export function namedIn(script: string, name: string): boolean {
  return new RegExp(`["'\`/\\\\]${escapeRe(name)}["'\`]`).test(script)
}

const KEY_LINE = /^\s*(?:-\s+)?(?:export\s+)?["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*(.*?)\s*,?\s*$/

/**
 * The keys of a data file (dataFile) named like a secret's (SECRET_NAME) that hold a value: JSON at
 * any depth, else each `name = value` or `name: value` line (env, ini, toml, yaml). Names only,
 * never a value.
 */
export function secretKeysIn(text: string): string[] {
  const found = new Set<string>()
  const filled = (v: unknown): boolean =>
    (typeof v === 'string' && holdsValue(v.trim())) || (typeof v === 'number' && Number.isFinite(v))
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    json = undefined
  }
  if (json !== undefined && typeof json === 'object') {
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (isRecord(v))
        for (const [k, x] of Object.entries(v)) {
          if (SECRET_NAME.test(k) && filled(x)) found.add(k)
          walk(x)
        }
    }
    walk(json)
    return [...found].sort()
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[#;[]/.test(line)) continue
    const m = KEY_LINE.exec(line)
    if (!m) continue
    const value = (m[2] ?? '').replace(/^(["'])(.*)\1$/, '$2')
    if (SECRET_NAME.test(m[1] ?? '') && holdsValue(value) && value !== 'null' && value !== '~') found.add(m[1] ?? '')
  }
  return [...found].sort()
}

/** A hook's name in the report: the script it runs without its extension, or its program. */
export function hookName(command: string): string {
  const words = wordsOf(command)
  const paths = words.map(w => w.replace(/^\d*[<>]+&?/, '')).filter(w => /[\\/]/.test(w) && !EVERYWHERE.test(w))
  const script = paths.at(-1) ?? programOf(words)
  return baseName(script).replace(/\.[^.]+$/, '') || command.trim().slice(0, 40)
}

export interface SettingsPart {
  settings: Record<string, unknown>
  hooks: Record<string, unknown[]>
  report: ReportEntry[]
  /** The files of the profile folder the hooks and command settings that travel name (filesIn). */
  scripts: string[]
}

/**
 * settings.json for the node (9.1): plain keys copied; `env` copied but for names that look like
 * a secret, which are reported to be given to the node; the board's own hooks never sent (the
 * node's install writes them with its paths); another hook, and a status line, only when its
 * command runs there (classifyCommand), with the files it names in the profile folder; a setting
 * that fetches credentials never. `walked`: the files the walk read; a command naming one it did
 * not read is not sent. The input is not changed.
 */
export function classifySettings(settings: unknown, ctx: BundleContext, walked?: ReadonlySet<string>): SettingsPart {
  const out: Record<string, unknown> = {}
  const hooks: Record<string, unknown[]> = {}
  const report: ReportEntry[] = []
  const scripts: string[] = []
  // A command's verdict with its files: sent when its program is on the node (programRule) and the
  // walk read every one of its files.
  type Judged =
    | { ok: true; command: string; translated: boolean; files: string[]; program: ProgramVerdict & { ok: true } }
    | { ok: false; why: ReportWhy; detail?: string }
  const judge = (command: string): Judged => {
    const v = classifyCommand(command, ctx)
    if (!v.ok) return v
    const program = programRule(v.command, ctx)
    if (!program.ok) return { ok: false, why: program.why, detail: program.program }
    const missing = walked && v.files.find(f => !walked.has(f))
    if (missing) return { ok: false, why: 'script-missing', detail: missing }
    scripts.push(...v.files)
    return { ...v, command: program.command, program }
  }
  const sentLine = (kind: ReportKind, name: string, v: { translated: boolean; files: string[] }): ReportEntry =>
    v.files.length ? { kind, name, verdict: 'translated', why: 'script-sent' } : sentEntry(kind, name, v.translated)
  // What the program rule did to a sent command, as a line of its own; none when nothing.
  const programLine = (name: string, p: ProgramVerdict & { ok: true }): ReportEntry[] =>
    p.renamed
      ? [
          {
            kind: 'hook',
            name,
            verdict: 'translated',
            why: 'program-renamed',
            detail: `${p.renamed.from} → ${p.renamed.to}`,
          },
        ]
      : p.unchecked
        ? [{ kind: 'hook', name, verdict: 'sent', why: 'program-unchecked', detail: p.unchecked }]
        : []
  const notSent = (name: string, v: { why: ReportWhy; detail?: string }, command: string): ReportEntry => ({
    kind: 'hook',
    name,
    verdict: 'not-sent',
    why: v.why,
    detail: v.detail ?? redacted(command),
  })
  for (const [key, value] of entriesOf(settings)) {
    if (key === 'hooks') continue
    if (key === 'env') {
      const env: Record<string, unknown> = {}
      for (const [name, v] of entriesOf(value)) {
        if (SECRET_NAME.test(name)) report.push({ kind: 'env', name, verdict: 'needs-secret', why: 'secret-name' })
        else {
          put(env, name, clone(v))
          report.push({ kind: 'env', name, verdict: 'sent', why: 'copied' })
        }
      }
      if (Object.keys(env).length) put(out, key, env)
    } else if (CREDENTIAL_KEYS.has(key)) {
      report.push({ kind: 'hook', name: key, verdict: 'not-sent', why: 'credentials' })
    } else if (isRecord(value) && value.type === 'command' && typeof value.command === 'string') {
      // The status line, and any other setting Claude runs as a command, by the hooks' rule.
      if (isBoardHook(value.command, ctx)) continue
      const v = judge(value.command)
      if (v.ok) {
        put(out, key, { ...clone(value), command: v.command })
        report.push(sentLine('hook', key, v), ...programLine(key, v.program))
      } else report.push(notSent(key, v, value.command))
    } else put(out, key, clone(value))
  }
  const source = isRecord(settings) ? settings.hooks : undefined
  for (const [event, list] of entriesOf(source)) {
    if (!Array.isArray(list)) continue
    const kept: unknown[] = []
    for (const entry of list) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue
      const sent: unknown[] = []
      for (const hook of entry.hooks) {
        if (!isRecord(hook)) continue
        // A prompt or agent hook has no command: nothing in it is bound to this computer.
        if (typeof hook.command !== 'string') {
          sent.push(clone(hook))
          continue
        }
        if (isBoardHook(hook.command, ctx)) continue
        const name = hookName(hook.command)
        const v = judge(hook.command)
        if (v.ok) {
          sent.push({ ...clone(hook), command: v.command })
          report.push({ ...sentLine('hook', name, v), detail: event }, ...programLine(name, v.program))
        } else report.push(notSent(name, v, hook.command))
      }
      if (sent.length) kept.push({ ...clone(entry), hooks: sent })
    }
    if (kept.length) put(hooks, event, kept)
  }
  return { settings: out, hooks, report: accepted(report, ctx.accept), scripts: [...new Set(scripts)].sort() }
}

const sentEntry = (kind: ReportKind, name: string, translated: boolean): ReportEntry =>
  translated
    ? { kind, name, verdict: 'translated', why: 'profile-path' }
    : { kind, name, verdict: 'sent', why: 'copied' }

/** The variable a secret of a server is asked for as: `MCP_<SERVER>_<NAME>`, letters, digits and `_`. */
export function secretVar(server: string, name: string): string {
  const slug = (s: string): string =>
    s
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  return ['MCP', slug(server), slug(name)].filter(Boolean).join('_')
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i

/** Whether a URL is a server on this computer. */
function onLoopback(url: string): boolean {
  try {
    return LOOPBACK.test(new URL(url).hostname)
  } catch {
    return false
  }
}

export interface McpPart {
  mcp: Record<string, unknown>
  report: ReportEntry[]
}

/**
 * The user scope's MCP servers for the node (9.1). `http` and `sse`: copied, each header that
 * holds a value, and a query parameter named like a secret, turned into a `${VAR}` reference
 * whose value is reported as a secret to give; one on this computer's loopback is bound to it.
 * `stdio`: portable when its program is a launcher (LAUNCHERS) and no argument is a path of this
 * computer; any other is bound to this computer. The device's own entry
 * (`nodes.devices.<id>.mcp`: false, or `{ command, args, env }`) wins. The input is not changed.
 */
export function classifyMcp(servers: unknown, ctx: BundleContext, values?: Map<string, string>): McpPart {
  const mcp: Record<string, unknown> = {}
  const report: ReportEntry[] = []
  for (const [name, raw] of entriesOf(servers)) {
    const own = ctx.mcp && Object.hasOwn(ctx.mcp, name) ? ctx.mcp[name] : undefined
    if (own === false) {
      report.push({ kind: 'mcp', name, verdict: 'not-sent', why: 'off' })
      continue
    }
    if (isRecord(own)) {
      if (typeof own.command !== 'string' || !own.command.trim()) {
        report.push({ kind: 'mcp', name, verdict: 'not-sent', why: 'invalid' })
        continue
      }
      const secrets: string[] = []
      const server: Record<string, unknown> = {
        type: 'stdio',
        command: own.command,
        args: secretArgs(name, Array.isArray(own.args) ? own.args.map(String) : [], secrets, values),
      }
      if (isRecord(own.env)) server.env = secretEnv(name, own.env, secrets, values)
      done(name, server, { verdict: 'translated', why: 'override' }, secrets, mcp, report)
      continue
    }
    if (!isRecord(raw)) {
      report.push({ kind: 'mcp', name, verdict: 'not-sent', why: 'invalid' })
      continue
    }
    const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : typeof raw.url === 'string' ? 'http' : 'stdio'
    if (type === 'http' || type === 'sse') remoteServer(name, raw, mcp, report, values)
    else if (type === 'stdio') stdioServer(name, raw, ctx, mcp, report, values)
    else report.push({ kind: 'mcp', name, verdict: 'not-sent', why: 'invalid', detail: type })
  }
  return { mcp, report: accepted(report, ctx.accept) }
}

const decoded = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** An env with each value whose name looks like a secret's as a reference to \${MCP_<SERVER>_<NAME>}. */
function secretEnv(
  server: string,
  env: Record<string, unknown>,
  secrets: string[],
  values?: Map<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_NAME.test(key) && holdsValue(value)) {
      const v = secretVar(server, key)
      secrets.push(v)
      values?.set(v, value)
      put(out, key, `\${${v}}`)
    } else put(out, key, clone(value))
  }
  return out
}

/** Arguments with each value that looks like a secret (secretsIn) as a reference. */
function secretArgs(
  server: string,
  args: readonly string[],
  secrets: string[],
  values?: Map<string, string>,
): string[] {
  const out = [...args]
  for (const s of secretsIn(args)) {
    const v = secretVar(server, s.name)
    secrets.push(v)
    values?.set(v, s.value)
    const at = s.next ? s.at + 1 : s.at
    out[at] = (out[at] ?? '').split(s.value).join(`\${${v}}`)
  }
  return out
}

/** Variables herdr sets in every pane it starts: a node's sessions have them, nothing to give. */
const HERDR_VAR = /^HERDR_/

/**
 * The names a server refers to as \${NAME}, anywhere in it, but herdr's own (HERDR_PANE_ID and the
 * rest), which every pane on the node has. One referred to only with a default (\${NAME:-x}) is
 * the session's own environment, which may as well not have it: nothing to give, so not one of these.
 */
function refsIn(server: unknown): string[] {
  const text = JSON.stringify(server ?? null)
  const bare = [...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(m => m[1] ?? '')
  return [...new Set(bare)].filter(n => !HERDR_VAR.test(n))
}

/**
 * A server that travels: in the bundle, its line in the report, a line for each secret it now
 * refers to, and one for each reference it already had (its value is the node's to be given).
 */
function done(
  name: string,
  server: Record<string, unknown>,
  line: Pick<ReportEntry, 'verdict' | 'why'>,
  secrets: readonly string[],
  mcp: Record<string, unknown>,
  report: ReportEntry[],
): void {
  put(mcp, name, server)
  report.push({ kind: 'mcp', name, ...line })
  for (const v of secrets)
    report.push({ kind: 'mcp', name: v, verdict: 'needs-secret', why: 'secret-value', detail: name })
  for (const v of refsIn(server))
    if (!secrets.includes(v))
      report.push({ kind: 'mcp', name: v, verdict: 'needs-secret', why: 'reference', detail: name })
}

function remoteServer(
  name: string,
  raw: Record<string, unknown>,
  mcp: Record<string, unknown>,
  report: ReportEntry[],
  values?: Map<string, string>,
): void {
  const url = typeof raw.url === 'string' ? raw.url : ''
  if (!url) {
    report.push({ kind: 'mcp', name, verdict: 'not-sent', why: 'invalid' })
    return
  }
  if (onLoopback(url)) {
    report.push({ kind: 'mcp', name, verdict: 'bound', why: 'local-url', detail: withoutSecrets(url) })
    return
  }
  const server = clone(raw)
  const secrets: string[] = []
  // A user and password in the address, then the query, by hand: URL and URLSearchParams would
  // percent-encode the reference's `${}`.
  server.url = url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/?#]*)@/i, (_whole, scheme: string, info: string) => {
      const [user = '', password] = info.split(/:(.*)/s)
      const parts = [user, password].map((part, i) => {
        if (part === undefined || !holdsValue(part)) return part
        const v = secretVar(name, i ? 'password' : 'user')
        secrets.push(v)
        values?.set(v, part)
        return `\${${v}}`
      })
      return parts[1] === undefined ? `${scheme}${parts[0]}@` : `${scheme}${parts[0]}:${parts[1]}@`
    })
    .replace(/([?&])([^=&#]+)=([^&#]*)/g, (whole, sep: string, key: string, value: string) => {
      if (!SECRET_NAME.test(decoded(key)) || !holdsValue(value)) return whole
      const v = secretVar(name, key)
      secrets.push(v)
      values?.set(v, value)
      return `${sep}${key}=\${${v}}`
    })
  if (isRecord(raw.headers)) {
    const headers: Record<string, unknown> = {}
    for (const [header, value] of Object.entries(raw.headers)) {
      if (holdsValue(value)) {
        const v = secretVar(name, header)
        secrets.push(v)
        values?.set(v, value)
        put(headers, header, `\${${v}}`)
      } else put(headers, header, clone(value))
    }
    server.headers = headers
  }
  const line = secrets.length
    ? ({ verdict: 'translated', why: 'secret-value' } as const)
    : ({ verdict: 'sent', why: 'copied' } as const)
  done(name, server, line, secrets, mcp, report)
}

/** A URL for the report: no user, password or query. */
const withoutSecrets = (url: string): string =>
  url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i, '$1').replace(/[?#].*$/, '')

function stdioServer(
  name: string,
  raw: Record<string, unknown>,
  ctx: BundleContext,
  mcp: Record<string, unknown>,
  report: ReportEntry[],
  values?: Map<string, string>,
): void {
  let command = typeof raw.command === 'string' ? raw.command.trim() : ''
  let args = Array.isArray(raw.args) ? raw.args.map(String) : []
  if (!command) {
    report.push({ kind: 'mcp', name, verdict: 'not-sent', why: 'invalid' })
    return
  }
  const given = command
  let unwrapped = false
  if (ctx.to !== 'win32') {
    // Windows' usual `cmd /c npx ...`: the launcher is what runs.
    if (programName(command) === 'cmd' && /^\/[ck]$/i.test(args[0] ?? '') && args[1]) {
      command = args[1]
      args = args.slice(2)
    }
    if (LAUNCHERS.has(programName(command))) command = programName(command)
    unwrapped = command !== given
  }
  if (!LAUNCHERS.has(programName(command))) {
    report.push({ kind: 'mcp', name, verdict: 'bound', why: 'local-command', detail: given })
    return
  }
  const local = args.flatMap(localPaths)
  if (local.length) {
    report.push({ kind: 'mcp', name, verdict: 'bound', why: 'local-path', detail: local[0] ?? '' })
    return
  }
  // `npx mcp-remote http://localhost:3000/sse`: a server on this computer behind a launcher.
  const loop = args.flatMap(a => a.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi) ?? []).find(onLoopback)
  if (loop) {
    report.push({ kind: 'mcp', name, verdict: 'bound', why: 'local-url', detail: withoutSecrets(loop) })
    return
  }
  const secrets: string[] = []
  const server: Record<string, unknown> = { ...clone(raw), command, args: secretArgs(name, args, secrets, values) }
  if (isRecord(raw.env)) server.env = secretEnv(name, raw.env, secrets, values)
  const why: ReportWhy = unwrapped ? 'unwrapped' : secrets.length ? 'secret-value' : 'launcher'
  done(name, server, { verdict: unwrapped || secrets.length ? 'translated' : 'sent', why }, secrets, mcp, report)
}

/**
 * The board's slice for the node (9.1): `categories`, `language` and `models` as config.json has
 * them, the node's sinks, and `launch.claude` only when its program is plain `claude` (its flags
 * travel with it); a launcher of the owner's own stays on the master and the report says so.
 */
export function boardSlice(
  config: unknown,
  sinks: unknown,
  accept?: readonly string[],
): { board: BoardSlice; report: ReportEntry[] } {
  const cfg = isRecord(config) ? config : {}
  const board: BoardSlice = { sinks: clone(sinks ?? {}) }
  for (const key of ['categories', 'language', 'models'] as const)
    if (cfg[key] !== undefined) board[key] = clone(cfg[key])
  const report: ReportEntry[] = []
  const claude = isRecord(cfg.launch) ? cfg.launch.claude : undefined
  if (claude !== undefined && claude !== null && claude !== '') {
    let program = ''
    try {
      program = claudeCommand(claude)[0] ?? ''
    } catch {
      program = ''
    }
    if (program === 'claude') board.launch = { claude: clone(claude) }
    else
      report.push({
        kind: 'launcher',
        name: 'launch.claude',
        verdict: 'not-sent',
        why: program ? 'own-launcher' : 'invalid',
        ...(program && { detail: program }),
      })
  }
  return { board, report: accepted(report, accept) }
}

/** What the walk of a profile folder found (adapters/bundle-files.ts). */
export interface ProfileParts {
  files: readonly BundleFile[]
  /** What the walk left out, by path in the profile folder. */
  skipped: readonly { path: string; why: SkipWhy }[]
  /** Links whose target's content is in `files`. */
  followed: readonly string[]
  /** settings.json as parsed; undefined when there is none. */
  settings: unknown
  /** `mcpServers` of the profile's .claude.json, and of the rest of it only acks. */
  mcpServers: unknown
  /** The keys of ACKNOWLEDGMENTS the profile's .claude.json has as true (acknowledgmentsOf). */
  acks?: readonly string[]
  /**
   * The data files beside a script a hook runs that the script names (#603), by path in the
   * profile folder, with that script; `secret` when one holds a key named like a secret's with a
   * value (secretKeysIn). Never sent as files of the bundle.
   */
  beside?: readonly { path: string; script: string; secret: boolean }[]
}

/** A file's part of the report: a skill by its folder, anything else by its path. */
const partOf = (path: string): { kind: ReportKind; name: string } => {
  const skill = /^skills\/([^/]+)/.exec(path)
  return skill ? { kind: 'skill', name: skill[1] ?? path } : { kind: 'file', name: path }
}

/** The bundle of one profile for one node: the walk's files, the settings and servers classified, the board's slice. */
export function buildManifest(
  parts: ProfileParts,
  board: { config: unknown; sinks: unknown },
  ctx: BundleContext,
): BundleManifest {
  const report: ReportEntry[] = []
  // What a node would refuse whole stays here, said: the board's own skills, a name it does not write.
  const files = [...parts.files]
    .filter(f => {
      if (bundlePath(f.path) !== null) return true
      report.push({
        ...partOf(f.path),
        name: f.path,
        verdict: 'not-sent',
        why: boardSkill(f.path) ? 'board-own' : 'unsafe-name',
      })
      return false
    })
    .map(f => ({ path: f.path, sha256: f.sha256, mode: f.mode }))
    .sort(byPath)
  const seen = new Set<string>()
  for (const f of files) {
    const { kind, name } = partOf(f.path)
    if (seen.has(`${kind}:${name}`)) continue
    seen.add(`${kind}:${name}`)
    report.push({ kind, name, verdict: 'sent', why: 'copied' })
  }
  for (const path of [...parts.followed].sort())
    report.push({ ...partOf(path), name: path, verdict: 'translated', why: 'link-followed' })
  for (const s of [...parts.skipped].sort(byPath))
    report.push({ ...partOf(s.path), name: s.path, verdict: 'not-sent', why: s.why })
  const settings = classifySettings(parts.settings, ctx, new Set(files.map(f => f.path)))
  // A file a script names beside it stays here, said: one with a secret always, one without only
  // when nothing else sends it (it may be the script's own state). One in a folder that travels
  // whole (a skill's) goes with it as before, and one a hook's command names is that hook's file.
  const held = heldBeside(parts.beside, settings.scripts, files)
  const heldPaths = new Set(held.map(b => b.path))
  const sentFiles = files.filter(f => !heldPaths.has(f.path))
  for (const b of held)
    report.push({
      kind: 'file',
      name: b.path,
      verdict: b.secret ? 'needs-secret' : 'not-sent',
      why: b.secret ? 'secret-file' : 'script-state',
      detail: b.script,
    })
  const acks = [...new Set(parts.acks ?? [])].filter(k => Object.hasOwn(ACKNOWLEDGMENTS, k)).sort()
  for (const k of acks)
    report.push({ kind: 'ack', name: k, verdict: 'sent', why: 'acknowledged', detail: ACKNOWLEDGMENTS[k] ?? '' })
  const mcp = classifyMcp(parts.mcpServers, ctx)
  const slice = boardSlice(board.config, board.sinks, ctx.accept)
  return {
    format: BUNDLE_FORMAT,
    files: sentFiles,
    settings: settings.settings,
    hooks: settings.hooks,
    mcp: mcp.mcp,
    board: slice.board,
    ...(acks.length > 0 && { acks }),
    report: [...accepted(report, ctx.accept), ...settings.report, ...mcp.report, ...slice.report],
  }
}

/**
 * The files beside a script the bundle holds back (#603): one with a secret always, one without
 * only when nothing else sends it. One a hook's command names (`scripts`) is that hook's file.
 */
function heldBeside(
  beside: ProfileParts['beside'],
  scripts: readonly string[],
  files: readonly { path: string }[],
): { path: string; script: string; secret: boolean }[] {
  const walked = new Set(files.map(f => f.path))
  return (beside ?? []).filter(b => !scripts.includes(b.path) && (b.secret || !walked.has(b.path))).sort(byPath)
}

/** What the bundle held back as secrets, to give a node whose owner lets it have them (#604). Values: in memory only. */
export interface BundleSecrets {
  /**
   * By the name the bundle refers to them as: each value an MCP server's ${MCP_<SERVER>_<NAME>}
   * stands for, and each settings.json `env` value held back for its name.
   */
  env: Record<string, string>
  /** The secret files beside a sent script, by path in the profile folder: the caller reads their text when it sends them. */
  files: string[]
}

/**
 * The secrets of one profile's bundle for one node (#604): the same translation as buildManifest,
 * the values it took out instead of the references it left. Nothing here is logged or kept: the
 * caller sends it and lets it go.
 */
export function bundleSecrets(parts: ProfileParts, ctx: BundleContext): BundleSecrets {
  const env: Record<string, string> = Object.create(null)
  // The files buildManifest keeps, so both see the same scripts.
  const files = parts.files.filter(f => bundlePath(f.path) !== null)
  const settings = classifySettings(parts.settings, ctx, new Set(files.map(f => f.path)))
  const raw = isRecord(parts.settings) ? parts.settings.env : undefined
  for (const [name, v] of entriesOf(raw))
    if (
      SECRET_NAME.test(name) &&
      (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') &&
      v !== ''
    )
      env[name] = String(v)
  const values = new Map<string, string>()
  classifyMcp(parts.mcpServers, ctx, values)
  for (const [name, v] of values) env[name] = v
  const secretFiles = heldBeside(parts.beside, settings.scripts, files)
    .filter(b => b.secret)
    .map(b => b.path)
  return { env: { ...env }, files: secretFiles }
}

const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** The report with the differences the owner accepts marked (`<kind>:<name>`). */
function accepted(report: ReportEntry[], accept: readonly string[] | undefined): ReportEntry[] {
  if (!accept?.length) return report
  const ok = new Set(accept)
  return report.map(e => (e.verdict !== 'sent' && ok.has(`${e.kind}:${e.name}`) ? { ...e, accepted: true } : e))
}

/** JSON with every object's keys sorted: the same value gives the same text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? 'null' : canonical(v))).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter(k => value[k] !== undefined)
      .sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The bundle's version (9.2): SHA-256 (hex) of the sorted manifest, the report left out. The same
 * whatever order the files were walked in.
 */
export function bundleHash(
  m: Pick<BundleManifest, 'files' | 'settings' | 'hooks' | 'mcp' | 'board' | 'acks'> & { format?: number },
): string {
  const files = m.files.map(f => ({ path: f.path, sha256: f.sha256, mode: f.mode })).sort(byPath)
  const body = {
    format: m.format ?? BUNDLE_FORMAT,
    files,
    settings: m.settings,
    hooks: m.hooks,
    mcp: m.mcp,
    board: m.board,
    // Only when there are any: a bundle without them keeps the hash it had.
    ...(m.acks?.length ? { acks: [...m.acks].sort() } : {}),
  }
  return createHash('sha256').update(canonical(body)).digest('hex')
}

/** A profile's bundle version on the master: the last hash and how many hashes it has seen. */
export interface BundleVersion {
  hash: string
  seq: number
}

/** The version after a build: the same while the hash is, else one more (9.2). */
export function nextVersion(previous: BundleVersion | null, hash: string): BundleVersion {
  if (!previous) return { hash, seq: 1 }
  return previous.hash === hash ? previous : { hash, seq: previous.seq + 1 }
}

/** How many changes a node is behind: 0 when it has the master's hash, at least 1 when it has another. */
export function behindBy(master: BundleVersion, node: BundleVersion | null): number {
  if (!node) return master.seq
  if (node.hash === master.hash) return 0
  return Math.max(1, master.seq - node.seq)
}

/**
 * What a bundle owns on a node (9.3, item 4): its files, its settings keys (`env.<NAME>` for each
 * variable, so one the node's owner added stays his), its hooks by event, its MCP server names.
 */
export interface Owned {
  files: string[]
  settings: string[]
  /** A hook by its event and its entry's matcher and the hook itself, in canonical form. */
  hooks: { event: string; key: string }[]
  mcp: string[]
}

/** A hook's identity in Owned: its matcher and the hook, canonical. */
export const hookKey = (matcher: unknown, hook: unknown): string => canonical({ matcher: matcher ?? null, hook })

/** What a manifest owns; nothing for none. */
export function owned(m: BundleManifest | null): Owned {
  if (!m) return { files: [], settings: [], hooks: [], mcp: [] }
  const settings: string[] = []
  for (const [key, value] of Object.entries(m.settings)) {
    if (key === 'env' && isRecord(value)) for (const name of Object.keys(value)) settings.push(`env.${name}`)
    else settings.push(key)
  }
  const hooks: Owned['hooks'] = []
  for (const [event, list] of Object.entries(m.hooks))
    for (const entry of list)
      if (isRecord(entry) && Array.isArray(entry.hooks))
        for (const hook of entry.hooks) hooks.push({ event, key: hookKey(entry.matcher, hook) })
  return { files: m.files.map(f => f.path).sort(), settings: settings.sort(), hooks, mcp: Object.keys(m.mcp).sort() }
}

/**
 * What the node owns after applying `next` over `previous` (the manifest it recorded last): all of
 * `next` but the files it kept because they were the node's own (`kept`: in `next`, there, not
 * owned before, different). A file it owned before is never the node's.
 */
export function ownedAfter(previous: BundleManifest | null, next: BundleManifest, kept: readonly string[] = []): Owned {
  const before = new Set(owned(previous).files)
  const foreign = new Set(kept.filter(p => !before.has(p)))
  const all = owned(next)
  return { ...all, files: all.files.filter(p => !foreign.has(p)) }
}

/** The manifest the node records after applying `next`: `next` with only the files it owns (ownedAfter). */
export function recorded(
  previous: BundleManifest | null,
  next: BundleManifest,
  kept: readonly string[] = [],
): BundleManifest {
  const mine = new Set(ownedAfter(previous, next, kept).files)
  return { ...next, files: next.files.filter(f => mine.has(f.path)) }
}

/** What applying `next` removes: owned under `previous` and absent from `next`. */
export function toRemove(previous: BundleManifest | null, next: BundleManifest): Owned {
  const was = owned(previous)
  const now = owned(next)
  const keep = (list: string[], still: string[]): string[] => list.filter(x => !still.includes(x))
  const nowHooks = new Set(now.hooks.map(h => `${h.event}\\n${h.key}`))
  return {
    files: keep(was.files, now.files),
    settings: keep(was.settings, now.settings),
    hooks: was.hooks.filter(h => !nowHooks.has(`${h.event}\\n${h.key}`)),
    mcp: keep(was.mcp, now.mcp),
  }
}

// ------------------------------------------------------------------ applying on the node (9.3)

/** A bundle file never goes where the node's own state is, whatever the manifest says: written apart or never. */
const NEVER_WRITTEN: ReadonlySet<string> = new Set([
  '.credentials.json',
  '.claude.json',
  '.ssh',
  'node_modules',
  '.git',
  '.venv',
  '__pycache__',
])
/** The skills the board's install puts into every profile folder: the node's own install writes them. */
const BOARD_SKILLS: ReadonlySet<string> = new Set([SKILL, TEAM_SKILL, THREADS_SKILL])
/** Names Windows gives to devices, with any extension: no file of a bundle is one. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** Whether a path is one of the board's own skills, which never travel. */
export const boardSkill = (path: string): boolean =>
  path.startsWith('skills/') && BOARD_SKILLS.has(path.split('/')[1] ?? '')

/** Written by the node from the manifest's keys, never as a file of it. */
const ROOT_FILES: ReadonlySet<string> = new Set(['settings.json', 'settings.local.json'])

/**
 * A manifest's file path as the node takes it, or null: relative, forward slashes, no `.` or
 * `..` part, no drive, nothing unprintable, nothing under the node's own state (credentials,
 * `.claude.json`, `.ssh`), not settings.json, which the node writes from the keys, not a name
 * Windows writes as another (`x.`, `nul`), and not the board's own skills, which the node's install
 * writes. The master's
 * word is never trusted for where a file goes; a link on the way is the adapter's to find.
 */
export function bundlePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 1024) return null
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a control character is refused
  if (/[\\\u0000-\u001f\u007f]/.test(raw) || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null
  const parts = raw.split('/')
  if (parts.some(p => p === '' || p === '.' || p === '..' || NEVER_WRITTEN.has(p.toLowerCase()))) return null
  // A part Windows would write under another name: a trailing dot or space, a device's name.
  if (parts.some(p => /[. ]$/.test(p) || DEVICE_NAME.test(p))) return null
  if (boardSkill(raw)) return null
  if (parts.length === 1 && ROOT_FILES.has(raw.toLowerCase())) return null
  return raw
}

const SHA256 = /^[0-9a-f]{64}$/

/**
 * The manifest a commit carries, checked field by field, or null when it is not one this node
 * knows (another `format`, a file without a path or hash). Its report is left out: it is the
 * master's, for doctor.
 */
export function manifestOf(raw: unknown): BundleManifest | null {
  if (!isRecord(raw) || raw.format !== BUNDLE_FORMAT || !Array.isArray(raw.files)) return null
  const files: BundleFile[] = []
  for (const f of raw.files) {
    if (!isRecord(f) || typeof f.path !== 'string' || typeof f.sha256 !== 'string' || !SHA256.test(f.sha256))
      return null
    files.push({ path: f.path, sha256: f.sha256, mode: typeof f.mode === 'number' ? f.mode : 0o644 })
  }
  if (!isRecord(raw.settings) || !isRecord(raw.hooks) || !isRecord(raw.mcp) || !isRecord(raw.board)) return null
  if (!Object.values(raw.hooks).every(Array.isArray)) return null
  // Only keys of this node's own ACKNOWLEDGMENTS: the master's word never names another key of .claude.json.
  const acks = Array.isArray(raw.acks)
    ? [
        ...new Set(raw.acks.filter((k): k is string => typeof k === 'string' && Object.hasOwn(ACKNOWLEDGMENTS, k))),
      ].sort()
    : []
  return {
    format: BUNDLE_FORMAT,
    files,
    settings: clone(raw.settings),
    hooks: clone(raw.hooks) as Record<string, unknown[]>,
    mcp: clone(raw.mcp),
    board: clone(raw.board) as unknown as BoardSlice,
    ...(acks.length > 0 && { acks }),
    report: [],
  }
}

/**
 * The manifest with PROFILE_DIR filled in with the node's own profile folder, forward slashes, in
 * its settings, hooks and MCP servers. Matching a hook the node owns goes through this too: the
 * node's settings.json holds its own path (hookKey is over what the hook says there).
 */
export function withProfileDirFilled(m: BundleManifest, dir: string): BundleManifest {
  const at = JSON.stringify(dir.replace(/\\/g, '/')).slice(1, -1)
  const fill = <T>(v: T): T => JSON.parse(JSON.stringify(v).split(PROFILE_DIR).join(at)) as T
  return { ...m, settings: fill(m.settings), hooks: fill(m.hooks), mcp: fill(m.mcp) }
}

/**
 * The node's settings.json after a bundle (9.3, item 4): the keys and `env` variables `previous`
 * owned and `next` does not are removed, `next`'s are put in, its hooks added where the same hook
 * is not there yet and the hooks `previous` owned and `next` does not taken out. A key, variable
 * or hook the node's owner added by hand stays. Both manifests with the node's folder filled in
 * (withProfileDirFilled). The input is not changed.
 */
export function appliedSettings(
  current: unknown,
  previous: BundleManifest | null,
  next: BundleManifest,
): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(current) ? clone(current) : {}
  const gone = toRemove(previous, next)
  for (const key of gone.settings) {
    if (key.startsWith('env.')) {
      const env = out.env
      if (!isRecord(env)) continue
      delete env[key.slice(4)]
      if (!Object.keys(env).length) delete out.env
    } else if (key !== 'hooks') delete out[key]
  }
  for (const [key, value] of Object.entries(next.settings)) {
    if (key === 'hooks') continue
    if (key === 'env' && isRecord(value)) {
      const env = isRecord(out.env) ? out.env : {}
      for (const [name, v] of Object.entries(value)) put(env, name, clone(v))
      put(out, 'env', env)
    } else put(out, key, clone(value))
  }
  const owned = Object.entries(next.hooks).some(([, list]) => list.length)
  if (!gone.hooks.length && !owned) return out
  const hooks: Record<string, unknown> = isRecord(out.hooks) ? out.hooks : {}
  const had = canonical(hooks)
  for (const { event, key } of gone.hooks) {
    const list = hooks[event]
    if (!Array.isArray(list)) continue
    const left = list.flatMap(entry => {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) return [entry]
      const kept = entry.hooks.filter(h => hookKey(entry.matcher, h) !== key)
      if (kept.length === entry.hooks.length) return [entry]
      return kept.length ? [{ ...entry, hooks: kept }] : []
    })
    if (left.length) hooks[event] = left
    else delete hooks[event]
  }
  for (const [event, list] of Object.entries(next.hooks)) {
    for (const entry of list) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue
      for (const hook of entry.hooks) {
        const there = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
        const key = hookKey(entry.matcher, hook)
        if (there.some(e => isRecord(e) && Array.isArray(e.hooks) && e.hooks.some(h => hookKey(e.matcher, h) === key)))
          continue
        const same = there.find(
          e =>
            isRecord(e) && Array.isArray(e.hooks) && canonical(e.matcher ?? null) === canonical(entry.matcher ?? null),
        ) as Record<string, unknown> | undefined
        if (same) same.hooks = [...(same.hooks as unknown[]), clone(hook)]
        else put(hooks, event, [...there, { ...clone(entry), hooks: [clone(hook)] }])
      }
    }
  }
  if (canonical(hooks) === had) return out
  if (Object.keys(hooks).length) put(out, 'hooks', hooks)
  else delete out.hooks
  return out
}

/**
 * The profile's `mcpServers` after a bundle: the names `previous` owned and `next` does not
 * removed, `next`'s put in; a server the node's owner added by hand stays.
 */
export function appliedMcp(
  current: unknown,
  previous: BundleManifest | null,
  next: BundleManifest,
): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(current) ? clone(current) : {}
  for (const name of toRemove(previous, next).mcp) delete out[name]
  for (const [name, server] of Object.entries(next.mcp)) put(out, name, clone(server))
  return out
}

/**
 * The node's config.json after a bundle (7.2): the four keys the master owns (`categories`,
 * `language`, `models`, `secrets.sinks`) and `launch.claude` when it is sent. A key the master
 * sent before and sends no more is removed; one it never sent stays the node's. Everything else
 * in the file is the node's and is not touched. The input is not changed.
 */
export function appliedSlice(config: unknown, previous: BoardSlice | null, next: BoardSlice): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(config) ? clone(config) : {}
  for (const key of ['categories', 'language', 'models'] as const) {
    if (next[key] !== undefined) put(out, key, clone(next[key]))
    else if (previous?.[key] !== undefined) delete out[key]
  }
  const sinks = isRecord(next.sinks) ? next.sinks : {}
  const secrets = isRecord(out.secrets) ? out.secrets : null
  // No sinks sent and none there: the file gets no `secrets` it did not have.
  if (Object.keys(sinks).length || (secrets && secrets.sinks !== undefined)) {
    const s = secrets ?? {}
    put(s, 'sinks', clone(sinks))
    put(out, 'secrets', s)
  }
  if (next.launch) {
    const launch = isRecord(out.launch) ? out.launch : {}
    put(launch, 'claude', clone(next.launch.claude))
    put(out, 'launch', launch)
  } else if (previous?.launch && isRecord(out.launch)) delete out.launch.claude
  return out
}

/**
 * A file's mode on the node. A Windows master's walk keeps no executable bit, so the node decides
 * from the file itself: a script the bundle sends (`.sh`, or one that starts with `#!`) is 0755,
 * anything else 0644, whatever the manifest says.
 */
export function nodeMode(path: string, head: Uint8Array): number {
  return /\.sh$/i.test(path) || (head[0] === 0x23 && head[1] === 0x21) ? 0o755 : 0o644
}
