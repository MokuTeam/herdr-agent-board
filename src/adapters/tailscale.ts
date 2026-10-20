// The Tailscale CLI, for the remote mode (core/remote.ts): this computer's address and user, the
// other devices, and who is calling (`whois`). TAILSCALE_BIN_PATH names another binary (tests).
import { execFile } from 'node:child_process'
import { isRecord } from './json-store.ts'

const BIN = process.env.TAILSCALE_BIN_PATH || 'tailscale'

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(BIN, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) =>
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
  if (!isRecord(raw)) return { running: false, self: null, peers: [] }
  const users = isRecord(raw.User) ? raw.User : {}
  const peers = isRecord(raw.Peer) ? Object.values(raw.Peer) : []
  return {
    running: raw.BackendState === 'Running',
    self: nodeOf(raw.Self, users),
    peers: peers.map(p => nodeOf(p, users)).filter((p): p is TailscaleNode => !!p),
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
