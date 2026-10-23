// The board through the owner's own domain: the PC keeps a reverse SSH tunnel to a server of the
// owner's, where Caddy hands the domain to a Unix socket that ssh forwards to the board's tunnel
// listener on 127.0.0.1. Here: the tunnel's settings (config.json's `tunnel`) and their checks,
// the ssh line built from them, and how to read what ssh says. Pure, with no node: import: the
// page imports it too.
import { t } from './lang.ts'
import { pwaPort } from './pwa.ts'
import { remoteConfig } from './remote.ts'
import type { SetupCheck } from './setup.ts'
import type { Translator } from './types.ts'

/** The socket on the server by default, in a folder only the tunnel's user and Caddy reach. */
export const TUNNEL_SOCKET = '/var/lib/boardtunnel/board.sock'

/** config.json's `tunnel`. None of it is secret. */
export interface TunnelConfig {
  on: boolean
  /** The server: a host name or an address. */
  host: string
  sshPort: number
  /** The tunnel's user on the server. */
  user: string
  /** The private key's path; '' is the key the board generated. */
  key: string
  /** The Unix socket on the server that the forward listens on. */
  socket: string
  /** A bare host name, such as board.example.com. */
  domain: string
  /** The tunnel listener's port on 127.0.0.1; null: the board's default (tunnelPort). */
  port: number | null
  /** The port the domain is served on, on the server (https://<domain>:<publicPort>); null: 443. */
  publicPort: number | null
}

const isPort = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) < 65536
const text = (v: unknown, fallback: string): string => (typeof v === 'string' ? v.trim() : fallback)

/**
 * config.json's `tunnel`: strings trimmed; a wrong type, or a port outside 1–65535, gives the
 * default; nothing else is checked here (tunnelProblems does, before use).
 */
export function tunnelConfig(value: unknown): TunnelConfig {
  const c = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    on: c.on === true,
    host: text(c.host, ''),
    sshPort: isPort(c.sshPort) ? c.sshPort : 22,
    user: text(c.user, ''),
    key: text(c.key, ''),
    socket: text(c.socket, TUNNEL_SOCKET),
    domain: text(c.domain, ''),
    port: isPort(c.port) ? c.port : null,
    publicPort: isPort(c.publicPort) ? c.publicPort : null,
  }
}

/** The domain's own origin: 'https://<domain>', with ':<publicPort>' unless it is null or 443. */
export function publicOrigin(c: TunnelConfig): string {
  return c.publicPort === null || c.publicPort === 443 ? `https://${c.domain}` : `https://${c.domain}:${c.publicPort}`
}

/** The Host the tunnel listener accepts: '<domain>' (and '<domain>:443'), or exactly '<domain>:<publicPort>'. */
export function publicHosts(c: TunnelConfig): string[] {
  return c.publicPort === null || c.publicPort === 443 ? [c.domain, `${c.domain}:443`] : [`${c.domain}:${c.publicPort}`]
}

export type TunnelField = 'host' | 'sshPort' | 'user' | 'key' | 'socket' | 'domain' | 'publicPort' | 'port'
export interface TunnelProblem {
  field: TunnelField
  message: string
}

/** The board's other ports: the web board, the remote listener's (`remote.port`), the phone's browser's (`remote.pwa.port ?? web + 1`). */
export interface Ports {
  web: number
  remote: number | null
  pwa: number
}

/** From config.json's `remote` (remoteConfig, pwaPort) and the web port. */
export function boardPorts(remote: unknown, webPort: number): Ports {
  const r = remoteConfig(remote)
  return { web: webPort, remote: r.port, pwa: pwaPort(r.pwa, webPort) }
}

/** The tunnel listener's port: config.json's, or the web board's plus two. */
export const tunnelPort = (conf: TunnelConfig, webPort: number): number => conf.port ?? webPort + 2

// A value starting with `-` would reach ssh as an option (`-oProxyCommand=…`), and a `:` in the
// socket would split the forward: these checks are a security matter, not cosmetics.
const HOST = /^[A-Za-z0-9.-]+$/
const IPV6 = /^[0-9A-Fa-f:]+$/
const USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/
const SOCKET = /^(\/[A-Za-z0-9._-]+)+$/
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
const CONTROL = /\p{Cc}/u
/** Linux takes a socket's path up to 108 bytes, BSD and macOS up to 104. */
const SOCKET_BYTES = 100
/** Folders where anyone may make a name, so could take the socket's path first. */
const SHARED_FOLDERS = ['/', '/tmp', '/var/tmp', '/dev/shm', '/run', '/var/run']

const goodHost = (v: string): boolean => !v.startsWith('-') && (HOST.test(v) || (IPV6.test(v) && v.includes(':')))
const goodKey = (v: string): boolean => !v.startsWith('-') && !v.includes('"') && !v.includes('${') && !CONTROL.test(v)
const fieldName = (field: TunnelField): string => t(`tunnel.field.${field}`)

function socketProblem(v: string): string | null {
  if (!SOCKET.test(v) || v.split('/').some(part => part === '.' || part === '..')) return t('tunnel.err.socket')
  // only ASCII passes the check above: a character is a byte
  if (v.length > SOCKET_BYTES) return t('tunnel.err.socketLong')
  const folder = v.slice(0, v.lastIndexOf('/')) || '/'
  return SHARED_FOLDERS.includes(folder) ? t('tunnel.err.socketShared', { folder }) : null
}

/** One field's own check: null when it is fine (an empty host, user or domain is fine here: tunnelProblems says it is missing). */
export function fieldProblem(field: TunnelField, value: unknown, ports?: Ports): string | null {
  switch (field) {
    case 'host':
      return value === '' || (typeof value === 'string' && goodHost(value)) ? null : t('tunnel.err.host')
    case 'user':
      return value === '' || (typeof value === 'string' && USER.test(value)) ? null : t('tunnel.err.user')
    case 'sshPort':
      return isPort(value) ? null : t('tunnel.err.port', { field: fieldName(field) })
    case 'key':
      return value === '' || (typeof value === 'string' && goodKey(value)) ? null : t('tunnel.err.key')
    case 'socket':
      return typeof value === 'string' ? socketProblem(value) : t('tunnel.err.socket')
    case 'domain':
      return value === '' || (typeof value === 'string' && value.length <= 253 && DOMAIN.test(value))
        ? null
        : t('tunnel.err.domain')
    // The server's port, not this computer's: none of the board's own ports is in its way.
    case 'publicPort':
      return value === null || isPort(value) ? null : t('tunnel.err.port', { field: fieldName(field) })
    case 'port':
      if (value === null) return null
      if (!isPort(value)) return t('tunnel.err.port', { field: fieldName(field) })
      return ports && [ports.web, ports.remote, ports.pwa].includes(value)
        ? t('tunnel.err.portTaken', { port: value })
        : null
  }
}

const FIELDS: readonly TunnelField[] = ['host', 'sshPort', 'user', 'key', 'socket', 'domain', 'publicPort', 'port']
const NEEDED: ReadonlySet<TunnelField> = new Set(['host', 'user', 'domain'])

/**
 * Every field's check, in TunnelField order; empty host, user and domain are named as missing.
 * The port checked is the one the listener takes, the default (web + 2) too.
 */
export function tunnelProblems(conf: TunnelConfig, ports: Ports): TunnelProblem[] {
  const problems: TunnelProblem[] = []
  for (const field of FIELDS) {
    const value = field === 'port' ? tunnelPort(conf, ports.web) : conf[field]
    const message =
      NEEDED.has(field) && value === ''
        ? t('tunnel.err.required', { field: fieldName(field) })
        : fieldProblem(field, value, ports)
    if (message) problems.push({ field, message })
  }
  return problems
}

/**
 * A path as ssh reads it: forward slashes on win32, `%` doubled (ssh expands `%` tokens in both
 * `-i` and `UserKnownHostsFile`).
 */
export function sshPathArg(path: string, platform: string = process.platform): string {
  return (platform === 'win32' ? path.replaceAll('\\', '/') : path).replaceAll('%', '%%')
}

export interface SshLine {
  conf: TunnelConfig
  /** The private key's path: config.json's, or the one the board generated. */
  key: string
  /** The board's own known_hosts, never the user's. */
  knownHosts: string
  /** The tunnel listener's port: the forward always goes to 127.0.0.1 there. */
  target: number
  platform?: string
}

/** ssh's options, each one argument: no prompt, a forward the server refuses ends ssh, a dead link is noticed. */
const OPTIONS = [
  'IdentitiesOnly=yes',
  'BatchMode=yes',
  'ExitOnForwardFailure=yes',
  'ServerAliveInterval=15',
  'ServerAliveCountMax=3',
  'TCPKeepAlive=yes',
  'ConnectTimeout=15',
  'StrictHostKeyChecking=accept-new',
]

/**
 * The whole ssh line, spawned without a shell. `-F none`: the user's ~/.ssh/config cannot change
 * the tunnel; `-v`: ssh says when the server took the forward (forwardAccepted).
 */
export function sshArgs(l: SshLine): string[] {
  const { conf } = l
  const knownHosts = `UserKnownHostsFile="${sshPathArg(l.knownHosts, l.platform)}"`
  return [
    '-F',
    'none',
    '-N',
    '-T',
    '-v',
    '-i',
    sshPathArg(l.key, l.platform),
    ...[...OPTIONS, knownHosts].flatMap(o => ['-o', o]),
    '-p',
    String(conf.sshPort),
    '-R',
    forwardSpec(conf.socket, l.target),
    `${conf.user}@${conf.host}`,
  ]
}

/** `-R`'s value: the socket on the server to 127.0.0.1 on the PC. */
export const forwardSpec = (socket: string, target: number): string => `${socket}:127.0.0.1:${target}`

export type TunnelHint = 'publickey' | 'listenPath' | 'keyPermissions' | 'hostKey' | 'network' | 'noSsh' | 'passphrase'

/**
 * What ssh's lines point to, tried in this order. ssh skips a key refused for its rights or its
 * passphrase and then also says `Permission denied (publickey).`: the cause comes first.
 */
const HINTS: ReadonlyArray<readonly [TunnelHint, RegExp]> = [
  ['keyPermissions', /UNPROTECTED PRIVATE KEY FILE|Bad permissions|are too open/],
  ['passphrase', /passphrase/i],
  ['hostKey', /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/],
  ['listenPath', /remote port forwarding failed for listen path/],
  ['publickey', /Permission denied \(publickey/],
  [
    'network',
    /Connection timed out|Connection refused|Could not resolve hostname|Operation timed out|No route to host|Network is unreachable/,
  ],
]

/** The hint for ssh's lines (newest last); null when none fits. `noSsh` comes from the spawn, not from here. */
export function sshHint(lines: readonly string[]): TunnelHint | null {
  for (const [hint, re] of HINTS) if (lines.some(line => re.test(line))) return hint
  return null
}

/** Errors that do not heal by themselves: shown as `error`, retried every 60 s. */
export function isLasting(hint: TunnelHint | null): boolean {
  return hint !== null && hint !== 'network'
}

/**
 * ssh -v saying the server took the forward of `socket`, the socket matched whole:
 * `debug1: remote forward success for: listen /var/lib/boardtunnel/board.sock:-2, connect 127.0.0.1:12424`.
 */
export function forwardAccepted(line: string, socket: string): boolean {
  const said = `remote forward success for: listen ${socket}`
  for (let at = line.indexOf(said); at >= 0; at = line.indexOf(said, at + 1)) {
    const next = line.charAt(at + said.length)
    if (next === '' || next === ':' || /\s/.test(next)) return true
  }
  return false
}

/** The wait before attempt `attempt` (1, 2, …): 1 s doubling up to 60 s, ±20 %. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  return Math.min(60_000, Math.round(1000 * 2 ** (attempt - 1) * (0.8 + 0.4 * random())))
}

export type TunnelState = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'error'

/** The last probe through the domain: whether it reached this board, and what came back if not. */
export interface ProbeNote {
  ok: boolean
  at: number
  detail: string
}

export interface TunnelStatus {
  state: TunnelState
  since: number
  /** reconnecting: the attempt's number and when it starts. */
  attempt?: number
  nextAt?: number
  /** reconnecting, error: ssh's own last lines, trimmed. */
  error?: string
  hint?: TunnelHint | null
  /** While connected: a failed probe is a warning, the state stays `connected`. */
  probe?: ProbeNote | null
}

/** A fetch of the board's own probe through the domain. */
export type ProbeResult =
  | { ok: true }
  | { ok: false; kind: 'status' | 'tls' | 'network' | 'answer'; detail: string; status?: number }

export type StepHint = TunnelHint | 'caddy502' | 'tls' | 'answer' | 'notConnected'

/** One step of Test connection: ✓ (true), ✗ (false) or not run (null). */
export interface TestStep {
  id: 'ssh' | 'forward' | 'domain'
  ok: boolean | null
  detail: string
  hint: StepHint | null
  /** The domain step of a Test told to find the public port ("Do it myself"): the one the board answered on. */
  port?: number
}

/** What `board doctor` finds of the tunnel on this computer (services/tunnel-facts.ts), while it is on. */
export interface TunnelFacts {
  ssh: string | null
  key: { ok: true } | { ok: false; error: string; hint: TunnelHint | null }
  problems: TunnelProblem[]
  ready: boolean
  /** From the running board's GET /api/access; null when no board answers. */
  status: TunnelStatus | null
}

/**
 * `board doctor`'s checks of the tunnel, the shape of phoneChecks: ssh found, the key there and
 * taken, the settings, the login set up, the state the running board has it in, and its last
 * probe through the domain.
 */
export function tunnelChecks(f: TunnelFacts, t: Translator): SetupCheck[] {
  const check = (c: Partial<SetupCheck> & Pick<SetupCheck, 'id' | 'level' | 'title'>): SetupCheck => ({
    detail: '',
    fix: '',
    code: '',
    ...c,
  })
  const hintText = (hint: TunnelHint | null | undefined): string => (hint ? t(`tunnel.hint.${hint}`) : '')
  const checks = [
    f.ssh
      ? check({ id: 'tunnel-ssh', level: 'ok', title: t('tunnel.check.ssh'), detail: f.ssh })
      : check({ id: 'tunnel-ssh', level: 'error', title: t('tunnel.check.noSsh'), fix: hintText('noSsh') }),
    f.key.ok
      ? check({ id: 'tunnel-key', level: 'ok', title: t('tunnel.check.key') })
      : check({
          id: 'tunnel-key',
          level: 'error',
          title: t('tunnel.check.keyBad'),
          detail: f.key.error,
          fix: hintText(f.key.hint),
        }),
    f.problems.length
      ? check({
          id: 'tunnel-fields',
          level: 'error',
          title: t('tunnel.check.fieldsBad'),
          detail: f.problems.map(p => p.message).join('\n'),
        })
      : check({ id: 'tunnel-fields', level: 'ok', title: t('tunnel.check.fields') }),
    f.ready
      ? check({ id: 'tunnel-login', level: 'ok', title: t('tunnel.check.login') })
      : check({
          id: 'tunnel-login',
          level: 'error',
          title: t('tunnel.check.noLogin'),
          fix: t('tunnel.check.noLoginFix'),
        }),
  ]
  const s = f.status
  if (!s) return [...checks, check({ id: 'tunnel-state', level: 'warn', title: t('tunnel.check.noBoard') })]
  const why = { detail: s.error ?? '', fix: hintText(s.hint) }
  checks.push(
    s.state === 'connected'
      ? check({ id: 'tunnel-state', level: 'ok', title: t('tunnel.check.connected') })
      : s.state === 'error'
        ? check({ id: 'tunnel-state', level: 'error', title: t('tunnel.check.error'), ...why })
        : s.state === 'off'
          ? check({ id: 'tunnel-state', level: 'warn', title: t('tunnel.check.off'), fix: t('tunnel.check.offFix') })
          : check({ id: 'tunnel-state', level: 'warn', title: t(`tunnel.check.${s.state}`), ...why }),
  )
  if (s.probe)
    checks.push(
      s.probe.ok
        ? check({ id: 'tunnel-probe', level: 'ok', title: t('tunnel.check.probe') })
        : check({ id: 'tunnel-probe', level: 'warn', title: t('tunnel.check.probeBad'), detail: s.probe.detail }),
    )
  return checks
}
