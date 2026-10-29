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
  /** The board in a phone's browser, over HTTPS through `tailscale serve` (core/pwa.ts). */
  pwa: PwaConfig
}

export interface PwaConfig {
  on: boolean
  /** The HTTPS port on the computer's Tailscale name. */
  https: number
  /** The port on 127.0.0.1 that `tailscale serve` forwards to; null: the web board's own plus one. */
  port: number | null
}

const isPort = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) < 65536

const PWA_OFF: PwaConfig = { on: false, https: 443, port: null }

/** `remote.pwa`: `true`, or `{ on, https, port }`; anything else is off. */
function pwaConfig(value: unknown): PwaConfig {
  if (value === true) return { ...PWA_OFF, on: true }
  if (!value || typeof value !== 'object') return PWA_OFF
  const p = value as Record<string, unknown>
  return { on: p.on === true, https: isPort(p.https) ? p.https : 443, port: isPort(p.port) ? p.port : null }
}

/** config.json's `remote`: `true`, or `{ on, port, allow, pwa }`; anything else is off. */
export function remoteConfig(value: unknown): RemoteConfig {
  if (value === true) return { on: true, port: null, allow: [], pwa: PWA_OFF }
  if (!value || typeof value !== 'object') return { on: false, port: null, allow: [], pwa: PWA_OFF }
  const r = value as Record<string, unknown>
  const allow = Array.isArray(r.allow)
    ? [...new Set(r.allow.filter(a => typeof a === 'string' && a.trim()).map(a => String(a).trim().toLowerCase()))]
    : []
  return { on: r.on === true, port: isPort(r.port) ? r.port : null, allow, pwa: pwaConfig(r.pwa) }
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

/**
 * For the board on this computer only: the remote mode's and Remote access's management (approving
 * pairings, the login, the tunnel), wake's switches, Start and Log (#119), the backup's setup
 * (#233: it logs in to the owner's server as the admin), Settings → Time (#237: clients, lanes and
 * billing settings), and the peer network's roster, threads and sends (#231: /api/team, not
 * /api/peers). Refused on every remote listener, in both spellings of a path.
 */
export const localOnly = (path: string): boolean =>
  /^\/api\/(remote|access|wake|backup|time-settings|team)(\/|$)/.test(path)

/**
 * What pairs: the app, or the board in a phone's browser (core/pwa.ts). A phone can have both,
 * each with a token of its own.
 */
export type DeviceKind = 'app' | 'browser'

/** A phone asking to pair, until it is answered or 10 minutes pass. */
export interface PairRequest {
  id: string
  /** What the app calls itself ("Pixel 7, agent board"). */
  name: string
  /** Absent: the app (what the remote mode paired before the browser could). */
  kind?: DeviceKind
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
  kind?: DeviceKind
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
  /** The board in a phone's browser (core/pwa.ts). */
  pwa: PwaView
}

export interface PwaView {
  /** config.json turns it on. */
  on: boolean
  /** The HTTPS port on the computer's Tailscale name. */
  https: number
  /** Where a phone's browser opens the board, once `tailscale serve` forwards it here. */
  url: string | null
  /** The tailnet gives this computer HTTPS certificates (the admin console's DNS page). */
  certs: boolean
  /** What `tailscale serve` does with the HTTPS port: forwards it here, nothing, or something else. */
  serve: ServeUse | null
  error: string | null
}

export type ServeUse = 'ours' | 'free' | 'other'

export const PAIR_TTL_MS = 10 * 60_000
/** At most this many requests wait at once; more are refused until one is answered or goes. */
export const PAIR_MAX = 5

/** The device a token belongs to, when it is used from that device. */
export function deviceFor(devices: readonly RemoteDevice[], tokenHash: string, node: string): RemoteDevice | null {
  return devices.find(d => d.tokenHash === tokenHash && d.node === node) ?? null
}

export const kindOf = (d: { kind?: DeviceKind | undefined }): DeviceKind => d.kind ?? 'app'

/** Whether pairing `next` replaces `d`: the same Tailscale device, the same kind (the app, the browser). */
export const samePairing = (d: RemoteDevice, next: { node: string; kind?: DeviceKind | undefined }): boolean =>
  d.node === next.node && kindOf(d) === kindOf(next)

/** `Authorization: Bearer <token>`, or null. */
export function bearerOf(header: string | null): string | null {
  const m = /^Bearer\s+([\w-]{20,200})$/i.exec(header?.trim() ?? '')
  return m?.[1] ?? null
}

/**
 * When to look at Tailscale again after a look that failed (`tailscale status` did not answer, or
 * it said it was starting): the listeners stay up meanwhile. A relay switch or a busy tailscaled
 * passes within these; failures for all of them, about fifty seconds, take the listeners down (#108).
 */
export const STATUS_RETRY_MS: readonly number[] = [5_000, 15_000, 30_000]

/** After `failures` failed looks in a row: keep the listeners and look again in `retryMs`, or take them down. */
export function statusVerdict(failures: number): { down: false; retryMs: number } | { down: true } {
  const retryMs = STATUS_RETRY_MS[failures - 1]
  return failures >= 1 && retryMs !== undefined ? { down: false, retryMs } : { down: true }
}

/** How long a caller Tailscale vouched for keeps its word while `tailscale whois` does not answer. */
export const WHOIS_GRACE_MS = 10 * 60_000
