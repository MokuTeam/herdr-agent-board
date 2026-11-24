// Where a MokuPilot call starts (core/mokupilot.ts says what a call is), config.json's
// `"mokupilot": { "mode": ... }`, set in Settings → MokuPilot…:
//   auto   (the default) the computer the board is looked at from: the board's own when the
//          viewer is at it, else that one, by a mokupilot:// link
//   local  this machine: the board starts MokuPilot here, as it always did
//   link   the viewer's computer: the page opens a mokupilot:// link, nothing starts here
// The older `"link": true` reads as `link`; a `mode` written beside it wins. Nothing here writes
// config.json: only the panel's save does (adapters/config-file.ts editMokupilot).
//
// Who looks, for `auto`: the board listens on 127.0.0.1 and is often reached through a proxy on
// this very computer (`tailscale serve`, the tunnel's Caddy over ssh), so a loopback peer alone
// says nothing. Behind a loopback peer the viewer is X-Forwarded-For's last entry, the one the
// proxy added (a program here that forges it is on this computer, and trusted as the board's own
// page is); else the peer itself. The viewer is at this computer when that address is a loopback
// one or one of this computer's own (its LAN and Tailscale addresses included).
import { forwardedAddress } from './access.ts'

export const MOKUPILOT_MODES = ['auto', 'local', 'link'] as const
export type MokupilotMode = (typeof MOKUPILOT_MODES)[number]

export const isMokupilotMode = (v: unknown): v is MokupilotMode =>
  typeof v === 'string' && (MOKUPILOT_MODES as readonly string[]).includes(v)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** The mode config.json's `mokupilot` asks for: its `mode`, else `link: true` as `link`, else `auto`. */
export function mokupilotMode(set: unknown): MokupilotMode {
  if (!isRecord(set)) return 'auto'
  if (isMokupilotMode(set.mode)) return set.mode
  return set.link === true ? 'link' : 'auto'
}

/** An address as a peer or a proxy writes it, compared plainly: no brackets, zone or IPv4-mapped prefix, lower case. */
export function plainAddress(address: string): string {
  return address
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '')
    .toLowerCase()
}

/** 127.0.0.0/8, ::1 and their IPv4-mapped spelling. */
export function isLoopback(address: string): boolean {
  const a = plainAddress(address)
  return a === '::1' || a === '0:0:0:0:0:0:0:1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

function parseIpv4Octets(addr: string): [number, number, number, number] | null {
  const parts = addr.split('.')
  if (parts.length !== 4) return null
  const nums: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n < 0 || n > 255 || String(n) !== part) return null
    nums.push(n)
  }
  return nums as [number, number, number, number]
}

function isRoutableIpv4Octets(a: number, b: number): boolean {
  if (a === 0) return false // 0.0.0.0/8 unspecified
  if (a === 10) return false // 10.0.0.0/8 RFC 1918 private LAN
  if (a === 127) return false // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return false // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return false // 172.16.0.0/12 RFC 1918 private LAN
  if (a === 192 && b === 168) return false // 192.168.0.0/16 RFC 1918 private LAN
  if (a >= 224) return false // 224.0.0.0/4 multicast and reserved
  return true
}

function parseIpv6Groups(addr: string): number[] | null {
  if (!addr.includes(':')) return null
  const expandSide = (side: string): number[] | null => {
    if (!side) return []
    const raw = side.split(':')
    const out: number[] = []
    for (let i = 0; i < raw.length; i++) {
      const seg = raw[i] ?? ''
      if (i === raw.length - 1 && seg.includes('.')) {
        const v4 = parseIpv4Octets(seg)
        if (!v4) return null
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(seg)) return null
        out.push(Number.parseInt(seg, 16))
      }
    }
    return out
  }

  const dbl = addr.split('::')
  if (dbl.length > 2) return null
  if (dbl.length === 2) {
    const head = expandSide(dbl[0] ?? '')
    const tail = expandSide(dbl[1] ?? '')
    if (!head || !tail) return null
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null
    return [...head, ...Array<number>(fill).fill(0), ...tail]
  }
  const full = expandSide(addr)
  return full && full.length === 8 ? full : null
}

/**
 * Whether `address` is a routable non-private address suitable for matching a remote node viewer:
 * accepts Tailscale (`100.64.0.0/10` / `fd7a:115c:a1e0::/48`) and global unicast IPv4/IPv6;
 * rejects loopback, RFC 1918 private LAN, link-local, unspecified, multicast, and other ULA ranges.
 */
export function isRoutableNodeAddress(address: string): boolean {
  const addr = plainAddress(address)
  if (!addr) return false
  const v4 = parseIpv4Octets(addr)
  if (v4) return isRoutableIpv4Octets(v4[0], v4[1])
  const v6 = parseIpv6Groups(addr)
  if (!v6) return false
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0] = v6
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isRoutableIpv4Octets(g6 >> 8, g6 & 0xff)
  }
  const isTailscaleV6 = g0 === 0xfd7a && g1 === 0x115c && g2 === 0xa1e0
  const isGlobalUnicastV6 = (g0 & 0xe000) === 0x2000
  return isTailscaleV6 || isGlobalUnicastV6
}

/** What the request says about who looks: the TCP peer's address ('' unknown) and its X-Forwarded-For. */
export interface Viewer {
  peer: string
  forwardedFor: string | null
}

/**
 * Which branch decided where a call starts: the mode itself (`mode-local`, `mode-link`), or for
 * `auto` what was looked at.
 */
export type ResolvedWhy =
  | 'mode-local'
  | 'mode-link'
  | 'no-peer'
  | 'loopback-direct'
  | 'forwarded-loopback'
  | 'forwarded-own'
  | 'forwarded-other'
  | 'forwarded-unreadable'
  | 'peer-own'
  | 'peer-other'

export interface ViewerPlace {
  local: boolean
  /** The address taken for the viewer ('' none). */
  address: string
  why: Exclude<ResolvedWhy, 'mode-local' | 'mode-link'>
}

/**
 * Whether the viewer is at this computer, by the request (`own`: this computer's own addresses,
 * loopback left out). An unknown peer (none given) counts as this computer, as before the modes.
 * A loopback peer with an X-Forwarded-For that is no address came through a proxy here for someone
 * we cannot place: not this computer, so nothing starts on it for them.
 */
export function viewerPlace(viewer: Viewer | null | undefined, own: readonly string[]): ViewerPlace {
  const peer = plainAddress(viewer?.peer ?? '')
  if (!peer) return { local: true, address: '', why: 'no-peer' }
  const mine = new Set(own.map(plainAddress))
  const header = viewer?.forwardedFor ?? null
  if (isLoopback(peer)) {
    if (header === null || header.trim() === '') return { local: true, address: peer, why: 'loopback-direct' }
    const address = plainAddress(forwardedAddress(header))
    if (!address) return { local: false, address: '', why: 'forwarded-unreadable' }
    if (isLoopback(address)) return { local: true, address, why: 'forwarded-loopback' }
    return mine.has(address)
      ? { local: true, address, why: 'forwarded-own' }
      : { local: false, address, why: 'forwarded-other' }
  }
  return mine.has(peer)
    ? { local: true, address: peer, why: 'peer-own' }
    : { local: false, address: peer, why: 'peer-other' }
}

/** The viewer's resolved address from `peer` or proxy `x-forwarded-for`, or '' when unknown. */
export function viewerAddress(viewer: Viewer | null | undefined): string {
  const peer = plainAddress(viewer?.peer ?? '')
  if (!peer) return ''
  const header = viewer?.forwardedFor ?? null
  if (isLoopback(peer)) {
    if (header === null || header.trim() === '') return peer
    return plainAddress(forwardedAddress(header))
  }
  return peer
}

/**
 * Whether `viewer` resolves to a routable non-private address matching one of `nodeAddresses`
 * (an opted-in registered node machine): only then may link mode return a `mokupilot://` link
 * instead of local refusal guards.
 */
export function isRegisteredNodeViewer(viewer: Viewer | null | undefined, nodeAddresses: readonly string[]): boolean {
  const addr = viewerAddress(viewer)
  if (!addr || !isRoutableNodeAddress(addr)) return false
  for (const entry of nodeAddresses) {
    const plain = plainAddress(entry)
    if (plain && isRoutableNodeAddress(plain) && plain === addr) return true
  }
  return false
}

export interface Resolved {
  mode: MokupilotMode
  resolved: 'local' | 'link'
  why: ResolvedWhy
  /** The address taken for the viewer, under `auto`. */
  viewer?: string
}

/** Where a call by `viewer` starts under `mode`: `local` (here) or `link` (the viewer's computer), and why. */
export function resolveMode(mode: MokupilotMode, viewer: Viewer | null | undefined, own: readonly string[]): Resolved {
  if (mode === 'local') return { mode, resolved: 'local', why: 'mode-local' }
  if (mode === 'link') return { mode, resolved: 'link', why: 'mode-link' }
  const place = viewerPlace(viewer, own)
  return { mode, resolved: place.local ? 'local' : 'link', why: place.why, viewer: place.address }
}
