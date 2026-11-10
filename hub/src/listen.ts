// Where the hub may listen (#231): loopback and Tailscale addresses freely; anything else, the
// wildcard included, only with --allow-public, because the protocol runs over plain ws:// unless a
// proxy in front of the hub adds TLS. And which address a connection came from, for the log, when
// a reverse proxy on the same machine forwards it (#353).
import { isIP } from 'node:net'

export const DEFAULT_LISTEN = '127.0.0.1:7443'

export interface Listen {
  hostname: string
  port: number
}

/** `host:port` or `[v6]:port` as host and port, or null for anything else. */
export function parseListen(s: string): Listen | null {
  const m = /^(?:\[([^\]]+)\]|([^:\]]+)):(\d{1,5})$/.exec(s)
  const hostname = m?.[1] ?? m?.[2]
  const port = Number(m?.[3])
  if (!hostname || port > 65535) return null
  if (isIP(hostname) === 0 && !/^[A-Za-z0-9.-]+$/.test(hostname)) return null
  return { hostname, port }
}

/** The four numbers of a dotted-decimal IPv4 literal (no leading zeros, hex, spaces or short forms), or null. */
const v4 = (h: string): number[] | null => {
  if (isIP(h) !== 4 || !/^(?:(?:0|[1-9]\d{0,2})\.){3}(?:0|[1-9]\d{0,2})$/.test(h)) return null
  const p = h.split('.').map(Number)
  return p.every(n => n <= 255) ? p : null
}

/** Loopback or Tailscale: 127/8, ::1, localhost, 100.64.0.0/10, fd7a:115c:a1e0::/48. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '::1') return true
  const ip = v4(h)
  if (ip) return ip[0] === 127 || (ip[0] === 100 && (ip[1] as number) >= 64 && (ip[1] as number) <= 127)
  return isIP(h) === 6 && h.startsWith('fd7a:115c:a1e0:')
}

/** A loopback address as a socket gives it: 127/8, ::1, or 127/8 mapped into IPv6. */
function isLoopback(address: string): boolean {
  const a = address.toLowerCase()
  if (a === '::1') return true
  const ip = v4(a.startsWith('::ffff:') ? a.slice(7) : a)
  return ip !== null && ip[0] === 127
}

/**
 * The address a connection came from, as the log shows it. With `trustProxy` (`--trust-proxy`: a
 * reverse proxy on this machine forwards to the hub), a connection from a loopback address is the
 * proxy's, and the address is the rightmost entry of its X-Forwarded-For: the one the proxy saw
 * (nginx's `$proxy_add_x_forwarded_for` and Caddy both put it last). That entry counts only as an IP
 * literal; anything else, a header from a peer that is not loopback, or no `trustProxy`, and it is
 * the socket's own address.
 */
export function clientAddress(socket: string | undefined, forwarded: string | null, trustProxy: boolean): string {
  const own = socket ?? '-'
  if (!trustProxy || !socket || !isLoopback(socket) || !forwarded) return own
  const last = forwarded.split(',').pop()?.trim() ?? ''
  return isIP(last) !== 0 ? last : own
}
