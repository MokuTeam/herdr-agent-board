// The owner's admin connection to the server (the server-setup spec's "The admin connection"):
// who and which key (config.json's `tunnel.admin`, checked as the tunnel's user and key), the ssh
// line (the tunnel's host and port, its pinned server key strictly, no prompt), the remote command
// that carries a script in base64 behind the sudo the admin needs, the probe that finds which, and
// the hints for what ssh, sudo and sudo-rs say. The sudo password never reaches any of these: it
// goes to ssh's stdin only (adapters/ssh.ts spawnRemote). Pure, with no node: import.
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

/**
 * The admin's ssh line, spawned without a shell: no user config and no prompt, as the tunnel's;
 * the tunnel's pinned server key strictly (an unpinned or changed one is refused, never pinned
 * here); the admin's key only when one is named; no forwarding of any kind; the command last.
 */
export function adminSshArgs(o: {
  conf: TunnelConfig
  admin: Admin
  knownHosts: string
  command: string
  platform?: string
}): string[] {
  const { conf, admin } = o
  const options = [
    'BatchMode=yes',
    'StrictHostKeyChecking=yes',
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
 * prints no prompt. requiretty and no sudo: no way to run it (throws).
 */
export function remoteCommand(script: string, mode: SudoMode): string {
  const sh = `sh -c 'eval "$(echo ${base64(script)} | base64 -d)"'`
  switch (mode) {
    case 'root':
      return sh
    case 'nopasswd':
      return `sudo -n -- ${sh}`
    case 'password':
      return `sudo -S -p '' -- ${sh}`
    default:
      throw new Error(`the admin cannot run a script as root (${mode})`)
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
