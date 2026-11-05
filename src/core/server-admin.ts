// The owner's admin connection to the server (the server-setup spec's "The admin connection"):
// who and which key (config.json's `tunnel.admin`, checked as the tunnel's user and key), the ssh
// line (the tunnel's host and port, its pinned server key strictly or pinned by this first login,
// no prompt but the password's), the remote command that carries a script in base64 behind the
// sudo the admin needs, the probe that finds which, which of ssh's prompts the login's password
// answers, and the hints for what ssh, sudo and sudo-rs say. No password reaches any of these:
// sudo's goes to ssh's stdin, the login's to ssh's askpass (adapters/ssh.ts spawnRemote). Pure,
// with no node: import.
import { t } from './lang.ts'
import type { AdminHint, SudoMode } from './server-view.ts'
import { fieldProblem, sshHint, sshPathArg, type TunnelConfig } from './tunnel.ts'

/** config.json's `tunnel.admin`. Neither is secret; '' for the key is what ssh does by default (the agent, ~/.ssh). */
export interface Admin {
  user: string
  key: string
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** config.json's `tunnel.admin`: strings trimmed, anything else ''. */
export function adminConfig(v: unknown): Admin {
  const a = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  return { user: text(a.user), key: text(a.key) }
}

/** The admin's fields that keep Look from running: checked as the tunnel's user and key (nothing that reaches ssh as an option); a user is needed. */
export function adminProblems(a: Admin): { field: 'user' | 'key'; message: string }[] {
  const problems: { field: 'user' | 'key'; message: string }[] = []
  const user =
    a.user === '' ? t('tunnel.err.required', { field: t('server.field.adminUser') }) : fieldProblem('user', a.user)
  if (user) problems.push({ field: 'user', message: user })
  const key = fieldProblem('key', a.key)
  if (key) problems.push({ field: 'key', message: key })
  return problems
}

/** The password login's methods: a key first (the agent's, ~/.ssh's or the named file), then the password, one try (call 1). */
const PASSWORD_LOGIN = ['PreferredAuthentications=publickey,keyboard-interactive,password', 'NumberOfPasswordPrompts=1']

/**
 * The admin's ssh line, spawned without a shell: no user config, as the tunnel's; the server's
 * key strictly (a changed one is always refused), and with `pin` (none pinned yet: the first
 * admin login, call 2) the one this login meets pinned; the admin's key only when one is named;
 * no forwarding of any kind; the command last. Without `password` no prompt at all (BatchMode),
 * as before the password login; with it the keys, then the password, one try (its askpass
 * answers it, adapters/ssh.ts).
 */
export function adminSshArgs(o: {
  /** The server: the tunnel's, or the backup target's (core/backup.ts). */
  conf: Pick<TunnelConfig, 'host' | 'sshPort'>
  admin: Admin
  knownHosts: string
  command: string
  platform?: string
  password?: boolean
  pin?: boolean
}): string[] {
  const { conf, admin } = o
  const options = [
    ...(o.password ? PASSWORD_LOGIN : ['BatchMode=yes']),
    o.pin ? 'StrictHostKeyChecking=accept-new' : 'StrictHostKeyChecking=yes',
    `UserKnownHostsFile="${sshPathArg(o.knownHosts, o.platform)}"`,
    'ConnectTimeout=15',
    'ServerAliveInterval=15',
    'ServerAliveCountMax=4',
    'ForwardAgent=no',
    'ForwardX11=no',
    'ClearAllForwardings=yes',
  ]
  return [
    '-F',
    'none',
    '-T',
    ...(admin.key ? ['-i', sshPathArg(admin.key, o.platform), '-o', 'IdentitiesOnly=yes'] : []),
    ...options.flatMap(x => ['-o', x]),
    '-p',
    String(conf.sshPort),
    `${admin.user}@${conf.host}`,
    o.command,
  ]
}

/**
 * Run as the admin with sh alone (no sudo, nothing on stdin): the uid, then `@@sudo ok` when `sudo
 * -n` works, else each line it said as `@@sudo <line>` (sudo-rs warns of a `requiretty` it ignores
 * before its own line), `@@sudo none` without sudo; then `sudo --version`'s first line.
 */
export const PROBE_SCRIPT = [
  'exec </dev/null',
  '# agent-board: probe',
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
  'LC_ALL=C; export LC_ALL',
  'echo "@@uid $(id -u)"',
  "if ! command -v sudo >/dev/null 2>&1; then echo '@@sudo none'",
  "elif s=$(sudo -n true 2>&1); then echo '@@sudo ok'",
  "else printf '%s\\n' \"$s\" | sed -n 's/^\\(..*\\)$/@@sudo \\1/p'; fi",
  'echo "@@flavor $(sudo --version 2>/dev/null | head -n 1)"',
  '',
].join('\n')

// sudo's and sudo-rs's own lines, as the spike recorded them on Debian 13 (sudo 1.9.16p2) and
// Ubuntu 26.04 (sudo-rs 0.2.13, which names itself `sudo`). sudo-rs ignores `requiretty` (it only
// warns of it): only classic sudo's "must have a tty" stops.
const NEED_PASSWORD = /sudo: a password is required|sudo: interactive authentication is required/
const WRONG_PASSWORD = /^Sorry, try again\.|incorrect password attempt|sudo: Authentication failed/
const NOT_ATTEMPTED = /sudo: Authentication required but not attempted/
const REQUIRETTY = /must have a tty to run sudo/
const NOT_SUDOER =
  /is not in the sudoers file|I'm sorry .*\. I'm afraid I can't do that|sudo: (command )?not found|^@@sudo none$/

/** The probe's output: how the admin runs as root, and which sudo; null when it is unreadable. */
export function readProbe(lines: readonly string[]): { mode: SudoMode; flavor: 'sudo' | 'sudo-rs' | null } | null {
  const said = (key: string): string[] => lines.filter(l => l.startsWith(`@@${key} `)).map(l => l.slice(key.length + 3))
  const uid = said('uid')[0]?.trim()
  const flavorLine = lines.find(l => l === '@@flavor' || l.startsWith('@@flavor '))
  if (uid === undefined || !/^\d+$/.test(uid) || flavorLine === undefined) return null
  const sudo = said('sudo')
  const version = flavorLine.slice('@@flavor'.length).trim()
  const flavor = version.startsWith('sudo-rs') ? 'sudo-rs' : version.startsWith('Sudo version') ? 'sudo' : null
  let mode: SudoMode
  if (uid === '0') mode = 'root'
  else if (sudo.includes('ok')) mode = 'nopasswd'
  else if (sudo.includes('none') || sudo.some(l => NOT_SUDOER.test(l))) mode = 'none'
  else if (sudo.some(l => REQUIRETTY.test(l))) mode = 'requiretty'
  else if (sudo.some(l => NEED_PASSWORD.test(l))) mode = 'password'
  else mode = 'none'
  return { mode, flavor }
}

/** Standard base64 of the UTF-8 text, in one line. */
function base64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

/**
 * The remote command: fixed text and the script in base64, so no value and no quoting reaches the
 * admin's login shell (bash, zsh and fish read the single quotes alike). Root runs it with sh;
 * NOPASSWD behind `sudo -n`; a password behind `sudo -S -p ''`, which reads it from stdin and
 * prints no prompt. sudo speaks the admin's login locale (pam_env's /etc/default/locale), so it
 * runs under `env LC_ALL=C` (a program: any login shell runs it alike), and its lines are the
 * English ones the hints know. requiretty and no sudo: no way to run it (throws).
 */
export function remoteCommand(script: string, mode: SudoMode): string {
  const sh = `sh -c 'eval "$(echo ${base64(script)} | base64 -d)"'`
  switch (mode) {
    case 'root':
      return sh
    case 'nopasswd':
      return `env LC_ALL=C sudo -n -- ${sh}`
    case 'password':
      return `env LC_ALL=C sudo -S -p '' -- ${sh}`
    default:
      throw new Error(`the admin cannot run a script as root (${mode})`)
  }
}

/**
 * What one of ssh's prompts is, as the askpass hears it: the login's password (ssh's own
 * `user@host's password: `, or the server's `(user@host) Password: ` by keyboard-interactive), a
 * key's passphrase (no answer: ssh skips the key, as BatchMode does, and nothing reaches the
 * server), or anything else, which ends the login: a one-time code, an expired password's change,
 * a PIN, a question (call 4).
 */
export type PromptKind = 'password' | 'passphrase' | 'other'

/** "Password for …:" that is not the login's own. */
const NOT_THE_LOGIN = /\b(new|current|old|retype|re-enter|again|confirm|expired?|one-time|otp)\b/i

export function promptKind(prompt: string): PromptKind {
  const p = prompt.trim()
  if (/^Enter passphrase( for (\w+ )?key '.*')?:$/.test(p)) return 'passphrase'
  // keyboard-interactive's prompts come as `(user@host) <the server's prompt>`
  const said = p.replace(/^\([^()\s]+@[^()\s]+\)\s*/, '')
  if (/^[^\s@']+@[^\s@']+'s password:$/.test(said)) return 'password'
  if (/^(password|пароль)( for [^:]+)?:$/i.test(said) && !NOT_THE_LOGIN.test(said)) return 'password'
  return 'other'
}

/** What the askpass did for one ssh: the password prompts it answered, and the prompt it refused (and ended ssh for). */
export interface AskpassReport {
  answered: number
  refused: string | null
}

/**
 * Whether `ssh -V`'s line names an OpenSSH that takes SSH_ASKPASS_REQUIRE (8.4 and later), so the
 * password reaches it from the askpass and never from a terminal; an ssh it does not know: no.
 */
export function takesAskpass(version: string): boolean {
  const m = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/.exec(version)
  if (!m) return false
  const major = Number(m[1])
  return major > 8 || (major === 8 && Number(m[2]) >= 4)
}

/** The methods ssh's refusal names (`Permission denied (publickey,password).`); null when it said none. */
function deniedMethods(lines: readonly string[]): string[] | null {
  let methods: string[] | null = null
  for (const line of lines) {
    const m = /Permission denied \(([\w,-]+)\)/.exec(line)
    if (m) methods = (m[1] ?? '').split(',')
  }
  return methods
}

/**
 * Why the admin's login itself failed, before ssh's other words (adminHint): a prompt the askpass
 * refused (the password asked again, so it was wrong; or anything else, a one-time code); the
 * password refused (root's, maybe by PermitRootLogin prohibit-password); a server that takes no
 * password; one that wants a password and none was typed; an ssh too old to take one. Null when it
 * was not the login, or ssh's other words say better (too many keys).
 */
export function loginHint(o: {
  lines: readonly string[]
  /** A password was typed for this login. */
  typed: boolean
  /** The askpass's report; null when none ran (no password, or an ssh too old). */
  askpass: AskpassReport | null
  /** A password was typed but ssh is too old for the askpass: the login went with the keys alone. */
  oldSsh: boolean
  root: boolean
}): AdminHint | null {
  const wrong: AdminHint = o.root ? 'rootLogin' : 'wrongLogin'
  const answered = (o.askpass?.answered ?? 0) > 0
  const refused = o.askpass?.refused ?? null
  if (refused !== null) return answered && promptKind(refused) === 'password' ? wrong : 'otherPrompt'
  const methods = deniedMethods(o.lines)
  if (methods === null) return null
  if (answered) return wrong
  if (!methods.includes('password') && !methods.includes('keyboard-interactive'))
    return o.typed ? 'keyOnly' : 'publickey'
  if (o.oldSsh) return 'sshOld'
  return o.typed ? null : 'loginPassword'
}

/** Which field a hint asks the panel for: the login's password (sudo's too), or sudo's own; null for none. */
export function needFor(hint: AdminHint | null): 'password' | 'sudoPassword' | null {
  switch (hint) {
    case 'needPassword':
    case 'loginPassword':
    case 'wrongLogin':
    case 'rootLogin':
      return 'password'
    case 'sudoPassword':
    case 'wrongPassword':
      return 'sudoPassword'
    default:
      return null
  }
}

/** What ssh's, sudo's and a run's lines point to, tried in this order. */
const HINTS: ReadonlyArray<readonly [AdminHint, (line: string) => boolean]> = [
  ['publickey', l => /Permission denied \(publickey/.test(l)],
  ['tooMany', l => /Too many authentication failures/.test(l)],
  ['hostKey', l => /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(l)],
  ['needPassword', l => NEED_PASSWORD.test(l)],
  ['wrongPassword', l => WRONG_PASSWORD.test(l)],
  // sudo-rs with nothing on stdin (a wrong password says "Authentication failed" first)
  ['needPassword', l => NOT_ATTEMPTED.test(l)],
  ['requiretty', l => REQUIRETTY.test(l)],
  ['notSudoer', l => NOT_SUDOER.test(l)],
  ['aptLock', l => /Could not get lock|Waiting for cache lock/.test(l)],
  ['pullLimit', l => /toomanyrequests/.test(l)],
  ['changed', l => /^@@changed( |$)/.test(l)],
  ['busy', l => l === '@@busy'],
  ['network', l => sshHint([l]) === 'network'],
]

/** The hint for the lines (first match in HINTS' order); null when none fits. */
export function adminHint(lines: readonly string[]): AdminHint | null {
  for (const [hint, fits] of HINTS) if (lines.some(fits)) return hint
  return null
}

/** ssh's words for a connection that went after the login (the PC asleep, the network gone). */
const LOST =
  /closed by remote host|^client_loop: |packet_write_wait: |Broken pipe|Connection reset|Timeout, server .* not responding/
/** A connection the server ended before the login: a refusal, not a loss. */
const BEFORE_LOGIN = /exchange_identification/

/** Whether ssh's lines say the connection went once it was up (so a run it launched may go on); not a refusal before it. */
export function connectionLost(lines: readonly string[]): boolean {
  return !lines.some(l => BEFORE_LOGIN.test(l)) && lines.some(l => LOST.test(l))
}

/**
 * Whether known_hosts' text pins a key for the host, as ssh writes it: the host on port 22,
 * `[host]:port` on another; a hashed line may be it (ssh decides then). Markers (@revoked,
 * @cert-authority) and comments are not a pin.
 */
export function pinnedIn(knownHosts: string, host: string, port: number): boolean {
  const name = (port === 22 ? host : `[${host}]:${port}`).toLowerCase()
  return knownHosts.split(/\r?\n/).some(line => {
    const first = line.trim().split(/\s+/)[0] ?? ''
    if (first === '' || first.startsWith('#') || first.startsWith('@')) return false
    return first.startsWith('|1|') || first.toLowerCase().split(',').includes(name)
  })
}
