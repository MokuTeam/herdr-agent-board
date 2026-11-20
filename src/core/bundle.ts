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

export type ReportKind = 'skill' | 'hook' | 'mcp' | 'env' | 'file' | 'launcher'
export type Verdict = 'sent' | 'translated' | 'not-sent' | 'needs-secret' | 'bound'
/** Why an entry got its verdict; doctor turns it into words. */
export type ReportWhy =
  | 'copied' // sent as it is
  | 'profile-path' // the profile folder's path in it became PROFILE_DIR
  | 'local-path' // it names a path of this computer
  | 'windows-shell' // PowerShell, cmd or a Windows script, for a node that is not Windows
  | 'credentials' // a setting that fetches credentials: the node logs in on its own
  | 'secret-name' // an env name that looks like a secret: give the node the value
  | 'secret-value' // a header or a value that looks like a secret became a ${VAR}
  | 'launcher' // a stdio server run by a launcher the node has
  | 'unwrapped' // the launcher's path, `.cmd` or `cmd /c` taken off
  | 'local-command' // a stdio server whose program is not a launcher
  | 'local-url' // a server on this computer's loopback
  | 'override' // nodes.devices.<id>.mcp gives this node its own command
  | 'off' // nodes.devices.<id>.mcp switches it off for this node
  | 'invalid' // an entry Claude Code could not run either
  | 'own-launcher' // launch.claude runs a program of the owner's own
  | SkipWhy
  | 'link-followed' // a link in the profile folder: its target's content travels

/** Why the walk left a file or folder out. */
export type SkipWhy =
  | 'too-big' // over MAX_FILE_BYTES
  | 'skipped-folder' // node_modules, .git, .venv, __pycache__
  | 'link-broken' // a link whose target is not there
  | 'link-into-profile' // a link to a part of the profile folder that is never sent
  | 'link-loop' // a link back to a folder the walk is already in

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
}

/** The launchers a node is expected to have (9.1). */
export const LAUNCHERS: ReadonlySet<string> = new Set(['npx', 'uvx', 'bunx', 'node', 'python', 'python3', 'docker'])
/** Names that look like a secret's: their value never goes into a bundle. */
export const SECRET_NAME = /token|key|secret|password/i
/** Settings whose command fetches credentials: never sent, a node logs in with its own profile. */
const CREDENTIAL_KEYS = new Set(['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'])
const WINDOWS_SHELLS = new Set(['powershell', 'pwsh', 'cmd'])
const WINDOWS_SCRIPT = /\.(ps1|bat|cmd)$/i
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
  return out.replace(PLACED, run => run.replace(/\\/g, '/'))
}

/** The paths of this computer a command or an argument names, PROFILE_DIR's excepted. */
function localPaths(text: string): string[] {
  const masked = text.replace(PLACED, ' ')
  const found = pathsIn(masked).filter(p => !EVERYWHERE.test(p))
  const home = HOME_PATH.exec(masked)
  return home ? [...found, home[0]] : found
}

type CommandVerdict =
  | { ok: true; command: string; translated: boolean }
  | { ok: false; why: 'local-path' | 'windows-shell' }

/** Whether a hook's command is the board's own (any copy's, or one running a file of `boardDir`). */
export function isBoardHook(command: string, ctx: Pick<BundleContext, 'boardDir'>): boolean {
  if (isBoardCommand(command)) return true
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
    if (WINDOWS_SHELLS.has(programName(programOf(words)))) return { ok: false, why: 'windows-shell' }
    if (words.some(w => WINDOWS_SCRIPT.test(w))) return { ok: false, why: 'windows-shell' }
  }
  if (localPaths(rewritten).length) return { ok: false, why: 'local-path' }
  return { ok: true, command: rewritten, translated: rewritten !== command }
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
}

/**
 * settings.json for the node (9.1): plain keys copied; `env` copied but for names that look like
 * a secret, which are reported to be given to the node; the board's own hooks never sent (the
 * node's install writes them with its paths); another hook, and a status line, only when its
 * command runs there (classifyCommand); a setting that fetches credentials never. The input is
 * not changed.
 */
export function classifySettings(settings: unknown, ctx: BundleContext): SettingsPart {
  const out: Record<string, unknown> = {}
  const hooks: Record<string, unknown[]> = {}
  const report: ReportEntry[] = []
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
    } else if (key === 'statusLine' && isRecord(value) && typeof value.command === 'string') {
      if (isBoardHook(value.command, ctx)) continue
      const v = classifyCommand(value.command, ctx)
      if (v.ok) {
        put(out, key, { ...clone(value), command: v.command })
        report.push(sentEntry('hook', key, v.translated))
      } else report.push({ kind: 'hook', name: key, verdict: 'not-sent', why: v.why, detail: value.command })
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
        const v = classifyCommand(hook.command, ctx)
        if (v.ok) {
          sent.push({ ...clone(hook), command: v.command })
          report.push({ ...sentEntry('hook', name, v.translated), detail: event })
        } else report.push({ kind: 'hook', name, verdict: 'not-sent', why: v.why, detail: hook.command })
      }
      if (sent.length) kept.push({ ...clone(entry), hooks: sent })
    }
    if (kept.length) put(hooks, event, kept)
  }
  return { settings: out, hooks, report: accepted(report, ctx.accept) }
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
export function classifyMcp(servers: unknown, ctx: BundleContext): McpPart {
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
      put(mcp, name, {
        type: 'stdio',
        command: own.command,
        args: Array.isArray(own.args) ? own.args.map(String) : [],
        ...(isRecord(own.env) && { env: clone(own.env) }),
      })
      report.push({ kind: 'mcp', name, verdict: 'translated', why: 'override' })
      continue
    }
    if (!isRecord(raw)) {
      report.push({ kind: 'mcp', name, verdict: 'not-sent', why: 'invalid' })
      continue
    }
    const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : typeof raw.url === 'string' ? 'http' : 'stdio'
    if (type === 'http' || type === 'sse') remoteServer(name, raw, mcp, report)
    else if (type === 'stdio') stdioServer(name, raw, ctx, mcp, report)
    else report.push({ kind: 'mcp', name, verdict: 'bound', why: 'local-command', detail: type })
  }
  return { mcp, report: accepted(report, ctx.accept) }
}

const holdsValue = (v: unknown): v is string => typeof v === 'string' && v !== '' && !v.includes('${')

function remoteServer(
  name: string,
  raw: Record<string, unknown>,
  mcp: Record<string, unknown>,
  report: ReportEntry[],
): void {
  const url = typeof raw.url === 'string' ? raw.url : ''
  if (!url) {
    report.push({ kind: 'mcp', name, verdict: 'not-sent', why: 'invalid' })
    return
  }
  if (onLoopback(url)) {
    report.push({ kind: 'mcp', name, verdict: 'bound', why: 'local-url', detail: url.replace(/[?#].*$/, '') })
    return
  }
  const server = clone(raw)
  const secrets: string[] = []
  // The query by hand: URLSearchParams would percent-encode the reference's `${}`.
  server.url = url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (whole, sep: string, key: string, value: string) => {
    if (!SECRET_NAME.test(decodeURIComponent(key)) || !holdsValue(value)) return whole
    const v = secretVar(name, key)
    secrets.push(v)
    return `${sep}${key}=\${${v}}`
  })
  if (isRecord(raw.headers)) {
    const headers: Record<string, unknown> = {}
    for (const [header, value] of Object.entries(raw.headers)) {
      if (holdsValue(value)) {
        const v = secretVar(name, header)
        secrets.push(v)
        put(headers, header, `\${${v}}`)
      } else put(headers, header, clone(value))
    }
    server.headers = headers
  }
  put(mcp, name, server)
  report.push(
    secrets.length
      ? { kind: 'mcp', name, verdict: 'translated', why: 'secret-value' }
      : { kind: 'mcp', name, verdict: 'sent', why: 'copied' },
  )
  for (const v of secrets)
    report.push({ kind: 'mcp', name: v, verdict: 'needs-secret', why: 'secret-value', detail: name })
}

function stdioServer(
  name: string,
  raw: Record<string, unknown>,
  ctx: BundleContext,
  mcp: Record<string, unknown>,
  report: ReportEntry[],
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
  const server: Record<string, unknown> = { ...clone(raw), command, args }
  const secrets: string[] = []
  if (isRecord(raw.env)) {
    const env: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw.env)) {
      if (SECRET_NAME.test(key) && holdsValue(value)) {
        secrets.push(key)
        put(env, key, `\${${key}}`)
      } else put(env, key, clone(value))
    }
    server.env = env
  }
  put(mcp, name, server)
  const why: ReportWhy = unwrapped ? 'unwrapped' : secrets.length ? 'secret-value' : 'launcher'
  report.push({ kind: 'mcp', name, verdict: unwrapped || secrets.length ? 'translated' : 'sent', why })
  for (const v of secrets)
    report.push({ kind: 'mcp', name: v, verdict: 'needs-secret', why: 'secret-value', detail: name })
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
  /** `mcpServers` of the profile's .claude.json, nothing else of that file. */
  mcpServers: unknown
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
  const files = [...parts.files].map(f => ({ path: f.path, sha256: f.sha256, mode: f.mode })).sort(byPath)
  const report: ReportEntry[] = []
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
  const settings = classifySettings(parts.settings, ctx)
  const mcp = classifyMcp(parts.mcpServers, ctx)
  const slice = boardSlice(board.config, board.sinks, ctx.accept)
  return {
    format: BUNDLE_FORMAT,
    files,
    settings: settings.settings,
    hooks: settings.hooks,
    mcp: mcp.mcp,
    board: slice.board,
    report: [...accepted(report, ctx.accept), ...settings.report, ...mcp.report, ...slice.report],
  }
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
  m: Pick<BundleManifest, 'files' | 'settings' | 'hooks' | 'mcp' | 'board'> & { format?: number },
): string {
  const files = m.files.map(f => ({ path: f.path, sha256: f.sha256, mode: f.mode })).sort(byPath)
  const body = {
    format: m.format ?? BUNDLE_FORMAT,
    files,
    settings: m.settings,
    hooks: m.hooks,
    mcp: m.mcp,
    board: m.board,
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
