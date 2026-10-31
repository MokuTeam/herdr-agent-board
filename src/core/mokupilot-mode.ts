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
