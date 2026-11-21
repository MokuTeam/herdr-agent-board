// git and gh for the owner's identity and GitHub login on a node (#609, docs/design/nodes 10): on the
// master, what a sync gives (the global identity, and per host gh is logged in to, the token
// `gh auth token` prints, which is the way to it on every system: Windows keeps it in the keyring);
// on a node, taking it (`gh auth login --with-token`, the token on stdin, never an argument; or
// git's own store where there is no gh) and taking it out again. A token is held in memory for one
// command's stdin and never logged, recorded or put on a command line.
//
// BOARD_GIT_BIN_PATH and BOARD_GH_BIN_PATH name other binaries (tests); one named that is not there
// is no such program, so a test never reaches the owner's own git or gh.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  credentialInput,
  type GitIdentity,
  type GitLogin,
  ghHostsOf,
  identityOf,
  isToken,
  type NoLogin,
} from '../core/git-access.ts'
import { runTree } from './process.ts'

/** The programs and where they look: found once by the caller (gitTools), passed to each call. */
export interface GitTools {
  git: string | null
  gh: string | null
  env: Record<string, string | undefined>
  platform: string
  home: string
}

/** One call of git or gh has this long: none of them waits on anything but the machine (and gh login, on GitHub). */
export const TOOL_MS = 30_000

/** git and gh as this process finds them: the test binaries when named, else PATH. */
export function gitTools(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): GitTools {
  const find = (name: string, key: string): string | null => {
    const named = env[key]
    if (named) return existsSync(named) ? named : null
    return Bun.which(name, { PATH: env.PATH ?? env.Path ?? '' })
  }
  return { git: find('git', 'BOARD_GIT_BIN_PATH'), gh: find('gh', 'BOARD_GH_BIN_PATH'), env, platform, home }
}

/** The environment a call runs with: nothing asks a person, nothing checks for updates. */
function quiet(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_SPINNER_DISABLED: '1',
  }
}

async function call(
  t: GitTools,
  bin: string,
  args: string[],
  input?: string,
  ms: number = TOOL_MS,
): Promise<{ ok: boolean; out: string }> {
  const r = await runTree(bin, args, { timeout: ms, env: quiet(t.env), ...(input !== undefined && { input }) })
  return { ok: r.code === 0 && !r.killed, out: r.stdout }
}

/** gh's own folder, in gh's order: GH_CONFIG_DIR, XDG_CONFIG_HOME, "GitHub CLI" under %AppData% on Windows, ~/.config. */
export function ghConfigDir(t: Pick<GitTools, 'env' | 'platform' | 'home'>): string {
  if (t.env.GH_CONFIG_DIR) return t.env.GH_CONFIG_DIR
  if (t.env.XDG_CONFIG_HOME) return join(t.env.XDG_CONFIG_HOME, 'gh')
  if (t.platform === 'win32' && t.env.APPDATA) return join(t.env.APPDATA, 'GitHub CLI')
  return join(t.home, '.config', 'gh')
}

/** The hosts and accounts gh is logged in to, by its hosts file: a file read, no program, no network. */
export function ghHosts(t: GitTools): { host: string; user: string }[] {
  if (!t.gh) return []
  try {
    return ghHostsOf(readFileSync(join(ghConfigDir(t), 'hosts.yml'), 'utf8'))
  } catch {
    return []
  }
}

/** The global identity (`git config --global`), or null: no git, or either one not set. */
export async function globalIdentity(t: GitTools): Promise<GitIdentity | null> {
  const parts = await identityParts(t)
  return identityOf(parts.name, parts.email)
}

/** The global user.name and user.email each as set, null where not: one set alone is an owner's too. */
export async function identityParts(t: GitTools): Promise<{ name: string | null; email: string | null }> {
  if (!t.git) return { name: null, email: null }
  const [name, email] = await Promise.all([
    call(t, t.git, ['config', '--global', '--get', 'user.name']),
    call(t, t.git, ['config', '--global', '--get', 'user.email']),
  ])
  const value = (r: { ok: boolean; out: string }): string | null => (r.ok && r.out.trim() ? r.out.trim() : null)
  return { name: value(name), email: value(email) }
}

/** The global identity set to these. */
export async function setIdentity(t: GitTools, id: GitIdentity): Promise<boolean> {
  if (!t.git) return false
  const name = await call(t, t.git, ['config', '--global', 'user.name', id.name])
  const email = name.ok && (await call(t, t.git, ['config', '--global', 'user.email', id.email]))
  return name.ok && !!email && email.ok
}

/** The global identity taken out. */
export async function unsetIdentity(t: GitTools): Promise<void> {
  if (!t.git) return
  await call(t, t.git, ['config', '--global', '--unset', 'user.name'])
  await call(t, t.git, ['config', '--global', '--unset', 'user.email'])
}

/** The token gh holds for a host, or null. In memory only: the caller hashes it and lets it go. */
export async function ghToken(t: GitTools, host: string, ms?: number): Promise<string | null> {
  if (!t.gh) return null
  const r = await call(t, t.gh, ['auth', 'token', '--hostname', host], undefined, ms)
  const token = r.out.trim()
  return r.ok && isToken(token) ? token : null
}

/**
 * The token gh holds for a host on a node: the token, null for no login, or undefined when gh's hosts
 * file has the host and the token cannot be read (a gh older than 2.17 has no `gh auth token`, a
 * keyring that failed): a login is there and what it holds is not known.
 */
export async function ghTokenThere(t: GitTools, host: string, ms?: number): Promise<string | null | undefined> {
  const token = await ghToken(t, host, ms)
  if (token !== null) return token
  return ghHosts(t).some(h => h.host === host) ? undefined : null
}

/** What the master gives (#609): per host gh is logged in to, its account and token; or why none. */
export async function masterLogins(t: GitTools): Promise<{ logins: GitLogin[]; none?: NoLogin }> {
  if (!t.gh) return { logins: [], none: 'no-gh' }
  const logins: GitLogin[] = []
  for (const { host, user } of ghHosts(t)) {
    const token = await ghToken(t, host)
    if (token) logins.push({ host, user, token })
  }
  return logins.length ? { logins } : { logins: [], none: 'no-login' }
}

/** The master's side (#609): its identity for every bundle, its logins for a device given its secrets. */
export interface MasterGit {
  identity(): Promise<GitIdentity | null>
  logins(): Promise<{ logins: GitLogin[]; none?: NoLogin }>
}

export const masterGit = (t: GitTools): MasterGit => ({
  identity: () => globalIdentity(t),
  logins: () => masterLogins(t),
})

/** gh logged in to a host with this token (on stdin), and git told to ask gh for it. */
export async function ghLogin(t: GitTools, host: string, token: string, ms?: number): Promise<boolean> {
  if (!t.gh || !isToken(token)) return false
  const login = await call(
    t,
    t.gh,
    ['auth', 'login', '--hostname', host, '--git-protocol', 'https', '--with-token'],
    `${token}\n`,
    ms,
  )
  return login.ok && (await ghSetupGit(t, host, ms))
}

/** git asks gh for this host's credentials (`gh auth setup-git`). */
export async function ghSetupGit(t: GitTools, host: string, ms?: number): Promise<boolean> {
  if (!t.gh) return false
  return (await call(t, t.gh, ['auth', 'setup-git', '--hostname', host], undefined, ms)).ok
}

/** gh logged out of a host: the account named (gh 2.40 and later), else the host's only one. */
export async function ghLogout(t: GitTools, host: string, user: string): Promise<boolean> {
  if (!t.gh) return false
  if ((await call(t, t.gh, ['auth', 'logout', '--hostname', host, '--user', user])).ok) return true
  return (await call(t, t.gh, ['auth', 'logout', '--hostname', host])).ok
}

/** git's own store, alone: the owner's other helpers are neither asked nor told. */
const STORE = ['-c', 'credential.helper=', '-c', 'credential.helper=store']
const helperKey = (host: string): string => `credential.https://${host}.helper`

/** The token git's store holds for a host and account, or null. */
export async function storeToken(t: GitTools, host: string, user: string, ms?: number): Promise<string | null> {
  const input = credentialInput(host, user)
  if (!t.git || input === null) return null
  const r = await call(t, t.git, [...STORE, 'credential', 'fill'], input, ms)
  const token = /^password=(.*)$/m.exec(r.out)?.[1]?.trim() ?? ''
  return r.ok && isToken(token) ? token : null
}

/**
 * The token into git's store for a host (a node without gh), the store's file private, and git
 * told to use the store for that host when nothing is set for it yet. `helper`: the node set it.
 */
export async function storeLogin(
  t: GitTools,
  host: string,
  user: string,
  token: string,
  ms?: number,
): Promise<{ ok: boolean; helper: boolean }> {
  const input = credentialInput(host, user, token)
  if (!t.git || input === null) return { ok: false, helper: false }
  // The store's files, private before and after: git's store writes ~/.git-credentials, or the XDG one
  // where that one is there.
  const home = t.env.HOME || t.home
  const files = [
    join(home, '.git-credentials'),
    join(t.env.XDG_CONFIG_HOME || join(home, '.config'), 'git', 'credentials'),
  ]
  const keepPrivate = (): void => {
    if (t.platform === 'win32') return
    for (const f of files) if (existsSync(f)) chmodSync(f, 0o600)
  }
  if (t.platform !== 'win32' && !files.some(existsSync)) writeFileSync(files[0] as string, '', { mode: 0o600 })
  const approve = await call(t, t.git, [...STORE, 'credential', 'approve'], input, ms)
  keepPrivate()
  if (!approve.ok) return { ok: false, helper: false }
  const set = await call(t, t.git, ['config', '--global', '--get-all', helperKey(host)])
  if (set.out.trim()) return { ok: true, helper: false }
  const helper = await call(t, t.git, ['config', '--global', helperKey(host), 'store'])
  return { ok: helper.ok, helper: helper.ok }
}

/** The host's token out of git's store, and the helper the node set for it; false when git's store said no. */
export async function storeLogout(t: GitTools, host: string, user: string, helper: boolean): Promise<boolean> {
  const input = credentialInput(host, user)
  if (!t.git || input === null) return false
  const reject = await call(t, t.git, [...STORE, 'credential', 'reject'], input)
  if (reject.ok && helper) await call(t, t.git, ['config', '--global', '--unset', helperKey(host), '^store$'])
  return reject.ok
}
