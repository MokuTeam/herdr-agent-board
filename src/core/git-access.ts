// The owner's git identity and GitHub login on a node (#609, docs/design/nodes 10, item 3): what
// travels, checked, and what the node decides with it. Pure: the programs are run by
// adapters/git-access.ts, the node's side is services/node/git-access.ts.
//
// The identity (global `user.name` and `user.email` of the master) goes with every bundle as plain
// values. The login (the token gh holds for a host, and the account) goes only in the secrets
// request of a device given its secrets (#604), and lives in memory and on the link: a record keeps
// hosts, accounts and the token's SHA-256, never the token.

/** A git identity: global `user.name` and `user.email`. */
export interface GitIdentity {
  name: string
  email: string
}

/** A login the master gives a node: the host, the account, the token (in memory only). */
export interface GitLogin {
  host: string
  user: string
  token: string
}

/** What a node says it has for git (its status, #609): looked once per run, and again after a secrets request. */
export interface GitFacts {
  /** A global user.name and user.email are both set. */
  identity: boolean
  /** The hosts it holds a login for, by gh's hosts file or the logins the bundle stored in git's own store. */
  logins: { host: string; user: string }[]
}

/** Why the master gave no login: no gh on it, or gh logged in to no host. */
export type NoLogin = 'no-gh' | 'no-login'

/** A host gh may be logged in to: a name, a port at most. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/
/** An account's name on that host. */
const USER = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_])?$/
/** A token as gh prints it: printable, no space. */
const TOKEN = /^[\x21-\x7e]{8,1024}$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character is refused
const CONTROL = /[\u0000-\u001f\u007f]/

export const isHost = (v: unknown): v is string => typeof v === 'string' && HOST.test(v)
export const isAccount = (v: unknown): v is string => typeof v === 'string' && USER.test(v)
export const isToken = (v: unknown): v is string => typeof v === 'string' && TOKEN.test(v)

/** An identity from two values, or null: both set, one line each, at most 256 characters. */
export function identityOf(name: unknown, email: unknown): GitIdentity | null {
  const fits = (v: unknown): v is string =>
    typeof v === 'string' && v.trim() !== '' && v.length <= 256 && !CONTROL.test(v)
  return fits(name) && fits(email) ? { name: name.trim(), email: email.trim() } : null
}

/** The same identity. */
export const sameIdentity = (a: GitIdentity | null, b: GitIdentity | null): boolean =>
  a !== null && b !== null && a.name === b.name && a.email === b.email

/**
 * The hosts and accounts of gh's hosts file (`hosts.yml`): each top-level key is a host, its
 * `user:` the active account. Anything else in the file (a token gh keeps there where no keyring
 * is) is not read into the answer.
 */
export function ghHostsOf(text: string): { host: string; user: string }[] {
  const out: { host: string; user: string }[] = []
  let host: string | null = null
  let indent = -1
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    const top = /^([^\s:#][^:]*):\s*$/.exec(raw)
    if (top) {
      const name = (top[1] ?? '').trim().replace(/^["']|["']$/g, '')
      host = isHost(name) ? name : null
      indent = -1
      continue
    }
    if (host === null) continue
    const at = raw.length - raw.trimStart().length
    if (indent < 0) indent = at
    if (at !== indent) continue
    const user = /^\s+user:\s*["']?([^"'\s#]+)["']?\s*$/.exec(raw)?.[1]
    if (user && isAccount(user) && !out.some(o => o.host === host)) out.push({ host, user })
  }
  return out
}

/** One login of a node's record: never the token, its SHA-256 only. */
export interface LoginRecord {
  host: string
  user: string
  /** SHA-256 of the token the node took. */
  sha: string
  /** gh took it, or git's own store (a node without gh). */
  via: 'gh' | 'store'
  /** The store's helper for this host was set by the node for it (`credential.https://<host>.helper`). */
  helper?: true
  /** The master that gave it (masters.json's id). */
  master: string
}

/**
 * What a node does with a login it is given (#609), by SHA-256: the token there now (`current`,
 * null for none, undefined for a login there whose token cannot be read), the one the bundle gave
 * before (`recorded`) and the one it is given (`given`). The same there: taken over, nothing run.
 * None there, or the one the bundle gave: logged in. Another the node's owner put there: kept. One
 * that cannot be read is the bundle's when it gave one before (the same, or replaced when the master's
 * changed), else the owner's.
 */
export function loginStep(
  given: string,
  recorded: string | null,
  current: string | null | undefined,
): 'same' | 'login' | 'kept' {
  if (current === undefined) return recorded === null ? 'kept' : recorded === given ? 'same' : 'login'
  if (current === given) return 'same'
  if (current === null || current === recorded) return 'login'
  return 'kept'
}

/** What a node does with the identity it is given: set it, leave it (the same, or the owner's own). */
export function identityStep(
  given: GitIdentity,
  recorded: GitIdentity | null,
  current: GitIdentity | null,
): 'same' | 'set' | 'kept' {
  if (sameIdentity(current, given)) return 'same'
  if (current === null || sameIdentity(current, recorded)) return 'set'
  return 'kept'
}

/** `git credential`'s input for one host, or null when a value would break its lines. */
export function credentialInput(host: string, user: string, token?: string): string | null {
  if (!isHost(host) || !isAccount(user) || (token !== undefined && !isToken(token))) return null
  return `protocol=https\nhost=${host}\nusername=${user}\n${token !== undefined ? `password=${token}\n` : ''}\n`
}

/** What a device's row says an agent there cannot do (#609), from its status; none from a node of an older board. */
export type GitLack = 'git' | 'identity' | 'login' | 'gh'

export function gitLacks(status: { programs?: readonly string[]; git?: GitFacts } | null): GitLack[] {
  if (!status?.git || !status.programs) return []
  if (!status.programs.includes('git')) return ['git']
  const out: GitLack[] = []
  if (!status.git.identity) out.push('identity')
  if (!status.git.logins.length) out.push('login')
  else if (!status.programs.includes('gh')) out.push('gh')
  return out
}

/** A status's `git`, checked field by field; undefined for anything else. */
export function gitFactsOf(v: unknown): GitFacts | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (typeof o.identity !== 'boolean' || !Array.isArray(o.logins)) return undefined
  const logins = o.logins
    .filter(
      (l): l is { host: string; user: string } =>
        typeof l === 'object' &&
        l !== null &&
        isHost((l as Record<string, unknown>).host) &&
        isAccount((l as Record<string, unknown>).user),
    )
    .map(l => ({ host: l.host, user: l.user }))
  return { identity: o.identity, logins }
}
