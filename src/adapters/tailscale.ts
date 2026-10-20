// The Tailscale CLI, for the remote mode (core/remote.ts): this computer's address and user, the
// other devices, and who is calling (`whois`); for the board in a phone's browser (core/pwa.ts),
// what `tailscale serve` forwards, and setting it. TAILSCALE_BIN_PATH names another binary (tests).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { isRecord } from './json-store.ts'

/** Where Tailscale's installers put the CLI. */
export function installedPaths(platform: string, env: Record<string, string | undefined>): string[] {
  if (platform === 'win32') return [win32.join(env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
  if (platform === 'darwin') return [posix.join('/Applications', 'Tailscale.app', 'Contents', 'MacOS', 'Tailscale')]
  return []
}

export interface BinOptions {
  env?: Record<string, string | undefined>
  platform?: string
  onPath?: (name: string) => boolean
  exists?: (path: string) => boolean
}

/**
 * The CLI to run: TAILSCALE_BIN_PATH, else `tailscale` from PATH as always, else where the
 * installer puts it. Tailscale installed while herdr ran is on the system's PATH but not on herdr's
 * panes', the board's among them, until herdr restarts. Asked on every run, so an install after the
 * board started is found too.
 */
export function tailscaleBin({
  env = process.env,
  platform = process.platform,
  onPath = name => !!Bun.which(name),
  exists = existsSync,
}: BinOptions = {}): string {
  if (env.TAILSCALE_BIN_PATH) return env.TAILSCALE_BIN_PATH
  if (onPath('tailscale')) return 'tailscale'
  return installedPaths(platform, env).find(path => exists(path)) ?? 'tailscale'
}

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      tailscaleBin(),
      args,
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20 },
      (err, out) =>
        err ? reject(new Error(`tailscale ${args[0]}: ${String(out || err.message).trim()}`)) : resolve(out),
    )
  })
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])
/** MagicDNS names end with a dot. */
const bare = (name: string): string => name.replace(/\.$/, '')

export interface TailscaleNode {
  /** The short name ("nicholas-omarchy"), the full one ("nicholas-omarchy.tail0.ts.net"). */
  name: string
  dnsName: string
  ips: string[]
  os: string
  online: boolean
  login: string | null
}

export interface TailscaleStatus {
  /** Logged in and connected. */
  running: boolean
  self: TailscaleNode | null
  peers: TailscaleNode[]
  /** The names this computer can have an HTTPS certificate for: none while the tailnet has them off. */
  certDomains: string[]
}

function nodeOf(raw: unknown, users: Record<string, unknown>): TailscaleNode | null {
  if (!isRecord(raw)) return null
  const user = users[String(raw.UserID ?? '')]
  const dnsName = bare(str(raw.DNSName))
  return {
    name: dnsName.split('.')[0] || str(raw.HostName),
    dnsName,
    ips: strings(raw.TailscaleIPs),
    os: str(raw.OS),
    online: raw.Online === true,
    login: isRecord(user) && str(user.LoginName) ? str(user.LoginName) : null,
  }
}

/** `tailscale status --json` as the board reads it. */
export function parseStatus(text: string): TailscaleStatus {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw)) return { running: false, self: null, peers: [], certDomains: [] }
  const users = isRecord(raw.User) ? raw.User : {}
  const peers = isRecord(raw.Peer) ? Object.values(raw.Peer) : []
  return {
    running: raw.BackendState === 'Running',
    self: nodeOf(raw.Self, users),
    peers: peers.map(p => nodeOf(p, users)).filter((p): p is TailscaleNode => !!p),
    certDomains: strings(raw.CertDomains).map(bare),
  }
}

export async function tailscaleStatus(timeoutMs = 5000): Promise<TailscaleStatus> {
  return parseStatus(await run(['status', '--json'], timeoutMs))
}

export interface Caller {
  login: string
  /** Tailscale's stable id of the calling device. */
  node: string
  device: string
  os: string
}

/** `tailscale whois --json` as the board reads it; null when Tailscale does not know the address. */
export function parseWhois(text: string): Caller | null {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw) || !isRecord(raw.Node) || !isRecord(raw.UserProfile)) return null
  const node = raw.Node
  const hostinfo = isRecord(node.Hostinfo) ? node.Hostinfo : {}
  const login = str(raw.UserProfile.LoginName)
  const id = str(node.StableID) || String(node.ID ?? '')
  if (!login || !id) return null
  return {
    login,
    node: id,
    device: str(node.ComputedName) || bare(str(node.Name)).split('.')[0] || '',
    os: str(hostinfo.OS),
  }
}

/** Who calls from a Tailscale address; null for an address that is not on the tailnet. */
export async function whois(address: string, timeoutMs = 3000): Promise<Caller | null> {
  try {
    return parseWhois(await run(['whois', '--json', address], timeoutMs))
  } catch {
    return null
  }
}

/** What `tailscale serve` does with one port of this computer's name. */
export interface ServePort {
  /** HTTPS, plain HTTP, or a raw TCP forward. */
  kind: 'https' | 'http' | 'tcp'
  /** Where it forwards `/` (`http://127.0.0.1:12423`), when it does. */
  proxy: string | null
}

/** `tailscale serve status --json` as the board reads it: the ports in use, by number. */
export function parseServe(text: string): Map<number, ServePort> {
  const raw: unknown = JSON.parse(text || '{}')
  const ports = new Map<number, ServePort>()
  if (!isRecord(raw)) return ports
  const tcp = isRecord(raw.TCP) ? raw.TCP : {}
  const web = isRecord(raw.Web) ? raw.Web : {}
  for (const [port, conf] of Object.entries(tcp)) {
    if (!isRecord(conf)) continue
    const kind = conf.HTTPS === true ? 'https' : conf.HTTP === true ? 'http' : 'tcp'
    let proxy: string | null = null
    // Web is keyed by "<name>:<port>"; the root handler is what a browser opening the address gets.
    for (const [hostPort, site] of Object.entries(web)) {
      if (!hostPort.endsWith(`:${port}`) || !isRecord(site) || !isRecord(site.Handlers)) continue
      const root = site.Handlers['/']
      if (isRecord(root) && str(root.Proxy)) proxy = str(root.Proxy)
    }
    ports.set(Number(port), { kind, proxy })
  }
  return ports
}

export async function serveStatus(timeoutMs = 5000): Promise<Map<number, ServePort>> {
  return parseServe(await run(['serve', 'status', '--json'], timeoutMs))
}

/** `tailscale serve --bg`: HTTPS on `https` of this computer's name, forwarded to `target`; kept across restarts. */
export async function serveOn(https: number, target: string): Promise<void> {
  await run(['serve', '--bg', `--https=${https}`, target], 15_000)
}

export async function serveOff(https: number): Promise<void> {
  await run(['serve', `--https=${https}`, 'off'], 15_000)
}
