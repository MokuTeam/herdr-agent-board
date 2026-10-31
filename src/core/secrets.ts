// The owner's secrets for the agents (API tokens and keys): their names, their three scopes, which
// one a session gets, and how a value goes into a shell. A secret is for every session (global),
// for the sessions of one board profile (profile, by its id), or for one Claude session (session,
// by its id, which sleep and resume keep). The same name in several scopes: the session's wins
// over the profile's, the profile's over the global one. Values never leave the store but to a
// session they are for (adapters/secret-store.ts): never in a view, a log line, an error or a card.
// All agents run as one user: the scopes keep a secret from the sessions it is not for by
// accident, not from an agent set on reading it. Pure.

/** Where a secret applies. */
export type SecretScope = 'global' | 'profile' | 'session'
export const SECRET_SCOPES: readonly SecretScope[] = ['global', 'profile', 'session']

/** A secret's place: its scope, and the profile's or session's id (null for global). */
export interface SecretPlace {
  scope: SecretScope
  target: string | null
}

/** What anyone may see of a secret: never its value. */
export interface SecretMeta extends SecretPlace {
  /** `scope:target:name`, the secret's own key in the store. */
  id: string
  name: string
  /** For a session's: the session's name when it was set, shown while the board does not know it. */
  targetName?: string
  /** When it was set (ms). */
  setAt: number
  /** When a session last got it (ms), and which session (its key), and how. */
  usedAt?: number
  usedBy?: string
  usedHow?: SecretUse
}

/** How a session got a secret: in its Bash commands, at Claude's start, `board secret get` or `file`. */
export type SecretUse = 'env' | 'launch' | 'get' | 'file'
export const SECRET_USES: readonly SecretUse[] = ['env', 'launch', 'get', 'file']

/** GET /api/secrets: the list, and what a page may pick a profile or a session from. */
export interface SecretsView {
  secrets: SecretMeta[]
}

/** A name as a shell variable is named: a letter or `_` first, then letters, digits and `_`, 128 at most. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** The most a value may hold (UTF-8 bytes). */
export const SECRET_MOST = 64 * 1024

/**
 * Names a secret may not take: the ones a shell, the system's loader, Bun, herdr, Claude Code and
 * the board read themselves. Set from the store, they would change how the session runs (PATH,
 * CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY: another account), not hand it a key.
 */
const RESERVED =
  /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|IFS|TERM|LANG|TMPDIR|TMP|TEMP|ENV|BASH_ENV|CDPATH|PS[1-4]|PROMPT_COMMAND|SHLVL|NODE_OPTIONS|USERPROFILE|APPDATA|LOCALAPPDATA|SystemRoot|ComSpec|LC_\w*|LD_\w*|DYLD_\w*|BASH_\w*|BUN_\w*|CLAUDE\w*|ANTHROPIC_\w*|HERDR_\w*|XDG_\w*|PI_\w*)$/i

/** Why a name is refused ('name': not a variable's name; 'reserved': one the setup reads), or null. */
export function nameProblem(name: unknown): 'name' | 'reserved' | null {
  if (typeof name !== 'string' || !SECRET_NAME.test(name)) return 'name'
  return RESERVED.test(name) ? 'reserved' : null
}

/** Why a value is refused ('empty', 'nul': a NUL, which no environment holds; 'long'), or null. */
export function valueProblem(value: unknown): 'empty' | 'nul' | 'long' | null {
  if (typeof value !== 'string' || value === '') return 'empty'
  if (value.includes('\0')) return 'nul'
  return new TextEncoder().encode(value).length > SECRET_MOST ? 'long' : null
}

/** A secret's key in the store: its scope, target and name (the target may hold `:`; the name never does). */
export const secretId = (p: SecretPlace, name: string): string => `${p.scope}:${p.target ?? ''}:${name}`

/** The place and name back from an id; null when it is not one. */
export function parseSecretId(id: unknown): (SecretPlace & { name: string }) | null {
  if (typeof id !== 'string') return null
  const first = id.indexOf(':')
  const last = id.lastIndexOf(':')
  if (first < 0 || last === first) return null
  const scope = id.slice(0, first) as SecretScope
  const target = id.slice(first + 1, last)
  const name = id.slice(last + 1)
  if (!SECRET_SCOPES.includes(scope) || nameProblem(name) === 'name') return null
  if ((scope === 'global') !== (target === '')) return null
  return { scope, target: scope === 'global' ? null : target, name }
}

/** A place as given (scope and target): null when it is not one. */
export function placeOf(scope: unknown, target: unknown): SecretPlace | null {
  if (scope === 'global') return { scope, target: null }
  if ((scope === 'profile' || scope === 'session') && typeof target === 'string' && target.trim() !== '')
    return { scope, target: target.trim() }
  return null
}

/** Who asks: the session's profile id and its key (either may be unknown). */
export interface SecretCaller {
  profile: string | null
  session: string | null
}

/** Whether a secret at `p` is for the caller. */
export const appliesTo = (p: SecretPlace, who: SecretCaller): boolean =>
  p.scope === 'global' ||
  (p.scope === 'profile' && who.profile !== null && p.target === who.profile) ||
  (p.scope === 'session' && who.session !== null && p.target === who.session)

const RANK: Record<SecretScope, number> = { global: 0, profile: 1, session: 2 }

/**
 * Of `entries`, the one per name the caller gets: the session's over the profile's over the
 * global one. In the order of the names.
 */
export function pickFor<T extends SecretPlace & { name: string }>(entries: readonly T[], who: SecretCaller): T[] {
  const best = new Map<string, T>()
  for (const e of entries) {
    if (!appliesTo(e, who)) continue
    const had = best.get(e.name)
    if (!had || RANK[e.scope] > RANK[had.scope]) best.set(e.name, e)
  }
  return [...best.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * A value as one POSIX shell word: in single quotes, each `'` as `'"'"'`. What Claude Code reads
 * as a plain assignment too (its PowerShell takes those only), and bash and zsh source as is.
 */
export const shellWord = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`

/** `export NAME='value'` lines, one per secret. */
export const exportLines = (secrets: readonly { name: string; value: string }[]): string =>
  secrets.map(s => `export ${s.name}=${shellWord(s.value)}\n`).join('')

const BLOCK_START = '# agent-board secrets (begin)'
const BLOCK_END = '# agent-board secrets (end)'
const BLOCK = /# agent-board secrets \(begin\)\n[\s\S]*?# agent-board secrets \(end\)\n?/g

/**
 * Claude Code's env file ($CLAUDE_ENV_FILE) with the board's block set to `body` (none: taken
 * out), whatever else other hooks wrote in it kept as it was.
 */
export function withBoardBlock(file: string, body: string | null): string {
  const rest = file.replace(BLOCK, '')
  if (!body) return rest
  const lead = rest === '' || rest.endsWith('\n') ? rest : `${rest}\n`
  return `${lead}${BLOCK_START}\n${body.endsWith('\n') ? body : `${body}\n`}${BLOCK_END}\n`
}

/** The line that sources a session's own env file, while it is there (it lives in memory only). */
export const sourceLine = (file: string): string => `[ -r ${shellWord(file)} ] && . ${shellWord(file)}\n`

/** A session key as a folder name: a Claude session id as it is, any other (a pi file's path) as a hash. */
export function sessionFolder(key: string, hash: (s: string) => string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key) ? key.toLowerCase() : hash(key)
}

/**
 * The session `claude` resumes or starts with, from its arguments: `--resume <id>` (`-r`,
 * `--resume=<id>`) or `--session-id <id>`; null for a new session it names itself, `--continue`.
 */
export function sessionInArgs(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i])
    if (a === '--') break
    const eq = /^(--resume|--session-id)=(.+)$/.exec(a)
    if (eq) return eq[2] ?? null
    if ((a === '--resume' || a === '-r' || a === '--session-id') && args[i + 1] && !String(args[i + 1]).startsWith('-'))
      return String(args[i + 1])
  }
  return null
}
