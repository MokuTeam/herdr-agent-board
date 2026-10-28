// Where the hub may listen (#231): loopback and Tailscale addresses freely; anything else, the
// wildcard included, only with --allow-public, because the protocol runs over plain ws:// unless a
// proxy in front of the hub adds TLS.
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

const v4 = (h: string): number[] | null => {
  const p = h.split('.').map(Number)
  return p.length === 4 && p.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null
}

/** Loopback or Tailscale: 127/8, ::1, localhost, 100.64.0.0/10, fd7a:115c:a1e0::/48. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '::1') return true
  const ip = v4(h)
  if (ip) return ip[0] === 127 || (ip[0] === 100 && (ip[1] as number) >= 64 && (ip[1] as number) <= 127)
  return h.startsWith('fd7a:115c:a1e0:')
}
