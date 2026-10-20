// The board from another device on the computer's Tailscale network: a phone, say. Off unless
// config.json says `"remote": { "on": true }`; then a second listener on the computer's Tailscale
// address takes the web board's routes, for callers Tailscale vouches for and that were paired.
// The rules here; the listener is server/remote.ts, the pairing services/remote.ts.

/** The version of what the board answers a remote caller; an app checks it in /api/hello. */
export const REMOTE_API = 1

export interface RemoteConfig {
  on: boolean
  /** The port on the Tailscale address; null: the web board's own. */
  port: number | null
  /** Tailscale logins that may pair besides the computer's own user, lowercase. */
  allow: string[]
}

const isPort = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) < 65536

/** config.json's `remote`: `true`, or `{ on, port, allow }`; anything else is off. */
export function remoteConfig(value: unknown): RemoteConfig {
  if (value === true) return { on: true, port: null, allow: [] }
  if (!value || typeof value !== 'object') return { on: false, port: null, allow: [] }
  const r = value as Record<string, unknown>
  const allow = Array.isArray(r.allow)
    ? [...new Set(r.allow.filter(a => typeof a === 'string' && a.trim()).map(a => String(a).trim().toLowerCase()))]
    : []
  return { on: r.on === true, port: isPort(r.port) ? r.port : null, allow }
}

/**
 * Whether a Tailscale user may call the board: the user this computer is logged in as, or one
 * config.json allows. A computer shared to the tailnet with tags has no user: then only the list.
 */
export function allowedLogin(login: string | null, owner: string | null, allow: readonly string[]): boolean {
  if (!login) return false
  const l = login.toLowerCase()
  return (!!owner && l === owner.toLowerCase()) || allow.includes(l)
}

/**
 * What acts on this computer's screen, which a caller elsewhere has no use for and must not
 * drive: opening a file or a link here, focusing herdr's window, raising the board's window.
 * Matched on the path as it came (encoded), as the routes are.
 */
const DESKTOP_ONLY: readonly RegExp[] = [
  /^\/api\/fs\/open$/,
  /^\/api\/open-url$/,
  /^\/api\/reveal$/,
  /^\/api\/session\/[^/]+\/focus$/,
  /^\/api\/launch\/[\w-]+\/focus$/,
  /^\/api\/term\/[^/]+\/shell\/focus$/,
]

export const desktopOnly = (rawPath: string): boolean => DESKTOP_ONLY.some(re => re.test(rawPath))

/** A phone asking to pair, until it is answered or 10 minutes pass. */
export interface PairRequest {
  id: string
  /** What the app calls itself ("Pixel 7, agent board"). */
  name: string
  /** Tailscale's name of the device and its owner's login, which the user approves. */
  device: string
  login: string
  /** Tailscale's stable id of the device: the token works from it only. */
  node: string
  os: string
  at: number
  status: 'pending' | 'approved' | 'denied'
}

/** A paired device. The token itself is never kept, only its hash. */
export interface RemoteDevice {
  id: string
  name: string
  device: string
  login: string
  node: string
  os: string
  tokenHash: string
  pairedAt: number
  seenAt: number | null
}

/** What the page shows of the remote mode: never a token or its hash. */
export interface RemoteView {
  on: boolean
  /** Where a phone reaches the board, once it listens. */
  url: string | null
  /** Why it does not listen while on (no Tailscale, the port taken). */
  error: string | null
  pending: Omit<PairRequest, 'status'>[]
  devices: Omit<RemoteDevice, 'tokenHash'>[]
}

export const PAIR_TTL_MS = 10 * 60_000
/** At most this many requests wait at once; more are refused until one is answered or goes. */
export const PAIR_MAX = 5

/** The device a token belongs to, when it is used from that device. */
export function deviceFor(devices: readonly RemoteDevice[], tokenHash: string, node: string): RemoteDevice | null {
  return devices.find(d => d.tokenHash === tokenHash && d.node === node) ?? null
}

/** `Authorization: Bearer <token>`, or null. */
export function bearerOf(header: string | null): string | null {
  const m = /^Bearer\s+([\w-]{20,200})$/i.exec(header?.trim() ?? '')
  return m?.[1] ?? null
}
