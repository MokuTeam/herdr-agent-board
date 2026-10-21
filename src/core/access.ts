// The board's own login through the owner's domain (core/tunnel.ts brings the domain to the
// tunnel listener): its rules and the shapes of what it keeps. A login is one signed-in browser,
// with a password and a TOTP code (core/totp.ts) or a passkey (core/webauthn.ts); its token rides in
// a cookie of its own, apart from the PWA's (core/pwa.ts). Here: the cookie, the password's one
// rule, the lockout's waits, the rate limits, the device label and the caller's address.
// Pure, with no node: import: the page imports it too.
import { t } from './lang.ts'
import { clearCookie, cookieToken, IP, tokenCookie } from './pwa.ts'
import type { TunnelConfig, TunnelProblem, TunnelStatus } from './tunnel.ts'

/** A login lasts 30 days from sign-in, fixed, not sliding. */
export const LOGIN_MS = 30 * 24 * 3600_000

/** `__Host-`, as the PWA's cookie, under a name of its own so the two token stores never mix. */
export const LOGIN_COOKIE = '__Host-board-login'

/** Set-Cookie for a login: `maxAgeS` is what is left of its 30 days, in whole seconds. */
export const loginCookie = (token: string, maxAgeS: number): string =>
  tokenCookie(token, LOGIN_COOKIE, Math.max(0, Math.floor(maxAgeS)))

/** Set-Cookie that drops a login's cookie. */
export const clearLoginCookie = (): string => clearCookie(LOGIN_COOKIE)

/** The 43-character base64url token (32 bytes) of LOGIN_COOKIE only; null otherwise. */
export function loginToken(cookieHeader: string | null): string | null {
  return cookieToken(cookieHeader, LOGIN_COOKIE, /^[\w-]{43}$/)
}

export const PASSWORD_MIN = 12

/** What is wrong with a new password, in the board's language; null when it will do. The one rule: its length. */
export function passwordProblem(password: unknown): string | null {
  return typeof password === 'string' && [...password].length >= PASSWORD_MIN ? null : t('access.err.password')
}

const LOCK_FROM = 5
const LOCK_FIRST_MS = 60_000
const LOCK_MOST_MS = 3_600_000

/** How long sign-in stays locked after `failures` failed password + code sign-ins in a row: from the 5th, 1 minute doubling to 1 hour. */
export function lockWaitMs(failures: number): number {
  return failures < LOCK_FROM ? 0 : Math.min(LOCK_MOST_MS, LOCK_FIRST_MS * 2 ** (failures - LOCK_FROM))
}

/** At most `perAddress` from one address and `overall` from all, in any `windowMs`. */
export interface RateRule {
  perAddress: number
  overall: number
  windowMs: number
}

/** The public routes' limits: password sign-in, passkey sign-in (counted apart, so a full password limit never stops it), and the rest (hello, the probe). */
export const RATES: { password: RateRule; passkey: RateRule; open: RateRule } = {
  password: { perAddress: 10, overall: 30, windowMs: 60_000 },
  passkey: { perAddress: 20, overall: 60, windowMs: 60_000 },
  open: { perAddress: 120, overall: 600, windowMs: 60_000 },
}

/** Sliding windows per address and overall, kept in memory. */
export class RateLimiter {
  private readonly byAddress = new Map<string, number[]>()
  private all: number[] = []

  constructor(private readonly rule: RateRule) {}

  /**
   * Records a request at `now` while both windows have room. A refusal records nothing and says
   * when the full window (the later one, when both are) has room again.
   */
  take(address: string, now: number): { ok: true } | { ok: false; retryAfterS: number } {
    const { perAddress, overall, windowMs } = this.rule
    const live = (times: readonly number[]): number[] => times.filter(at => now - at < windowMs)
    this.all = live(this.all)
    const mine = live(this.byAddress.get(address) ?? [])
    const full: number[][] = []
    if (mine.length >= perAddress) full.push(mine)
    if (this.all.length >= overall) full.push(this.all)
    if (!full.length) {
      mine.push(now)
      this.all.push(now)
    }
    if (mine.length) this.byAddress.set(address, mine)
    else this.byAddress.delete(address)
    this.sweep(now)
    if (!full.length) return { ok: true }
    const wait = Math.max(...full.map(times => Math.min(...times) + windowMs - now))
    return { ok: false, retryAfterS: Math.max(1, Math.ceil(wait / 1000)) }
  }

  /** Requests in the window are at most `overall`, so more addresses than that means stale ones: dropped. */
  private sweep(now: number): void {
    if (this.byAddress.size <= this.rule.overall) return
    for (const [address, times] of this.byAddress)
      if (!times.some(at => now - at < this.rule.windowMs)) this.byAddress.delete(address)
  }
}

const BROWSERS: [RegExp, string][] = [
  [/Edg(A|iOS)?\//, 'Edge'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]
const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'Mac'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
]

/**
 * A device's label from its User-Agent, such as "Safari on iPad" (iPadOS Safari says it is a Mac
 * and is labelled so). Not translated: it is stored with the login or passkey.
 */
export function deviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? ''
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1]
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1]
  if (browser && system) return `${browser} on ${system}`
  return browser ?? system ?? 'A browser'
}

/**
 * The caller's address: X-Forwarded-For's rightmost entry, the one the proxy (Caddy) added; ''
 * for none or for anything but an address. For showing and for grouping rate limits, never for
 * letting anyone in.
 */
export function forwardedAddress(header: string | null): string {
  const last = (header ?? '').split(',').pop() ?? ''
  const value = last.trim().replace(/^::ffff:/i, '')
  return IP.test(value) ? value : ''
}

export type LoginMethod = 'password' | 'passkey'

/** One signed-in browser on one device. Only the token's hash is kept. */
export interface Login {
  id: string
  tokenHash: string
  method: LoginMethod
  /** The passkey it signed in with. */
  passkeyId?: string
  /** deviceLabel at sign-in. */
  label: string
  /** forwardedAddress at sign-in. */
  address: string
  signedInAt: number
  /** signedInAt + LOGIN_MS. */
  expiresAt: number
  /** Last active, written at most once a minute. */
  seenAt: number | null
}

export type PublicLogin = Omit<Login, 'tokenHash'>

/** A passkey (WebAuthn credential) for the domain; its id is the credential id, base64url. */
export interface Passkey {
  id: string
  jwk: JsonWebKey
  /** ES256 (-7) or RS256 (-257). */
  alg: -7 | -257
  /** The signature counter; checked only when it is not zero. */
  counter: number
  transports: string[]
  /** deviceLabel when it was added. */
  label: string
  addedAt: number
  usedAt: number | null
}

export type PublicPasskey = Pick<Passkey, 'id' | 'label' | 'addedAt' | 'usedAt'>

export type AttemptReason = 'wrong' | 'locked' | 'limited'

/** A failed sign-in. */
export interface Attempt {
  at: number
  address: string
  label: string
  method: LoginMethod
  reason: AttemptReason
}

/** What the "Remote access…" panel on the local board shows (GET /api/access). Never a secret. */
export interface AccessView {
  tunnel: {
    settings: TunnelConfig
    problems: TunnelProblem[]
    /** Why On is refused now; null when it may be turned on. */
    blocked: string | null
    listenPort: number
    status: TunnelStatus
    ssh: string | null
    key: { path: string; generated: boolean; exists: boolean; publicKey: string | null; error: string | null }
    /** The pinned server key: 'SHA256:… (ED25519)', or null. */
    hostKey: string | null
  }
  login: { password: boolean; totp: boolean; passkeys: PublicPasskey[]; lockout: { until: number } | null }
  logins: PublicLogin[]
  attempts: Attempt[]
}

type Fields = Record<string, unknown>
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isText = (v: unknown): v is string => typeof v === 'string'
const textOrNull = (v: unknown): boolean => v === null || isText(v)
const numOrNull = (v: unknown): boolean => v === null || isNum(v)
const listOf = (v: unknown, each: (x: unknown) => boolean): boolean => Array.isArray(v) && v.every(each)
const STATES: ReadonlySet<unknown> = new Set(['off', 'connecting', 'connected', 'reconnecting', 'error'])
const METHODS: ReadonlySet<unknown> = new Set(['password', 'passkey'])
const REASONS: ReadonlySet<unknown> = new Set(['wrong', 'locked', 'limited'])

const isSettings = (v: unknown): boolean =>
  isFields(v) &&
  typeof v.on === 'boolean' &&
  ['host', 'user', 'key', 'socket', 'domain'].every(k => isText(v[k])) &&
  isNum(v.sshPort) &&
  numOrNull(v.port)

const isStatus = (v: unknown): boolean =>
  isFields(v) &&
  STATES.has(v.state) &&
  isNum(v.since) &&
  (v.attempt === undefined || isNum(v.attempt)) &&
  (v.nextAt === undefined || isNum(v.nextAt)) &&
  (v.error === undefined || isText(v.error)) &&
  (v.hint === undefined || textOrNull(v.hint)) &&
  (v.probe === undefined ||
    v.probe === null ||
    (isFields(v.probe) && typeof v.probe.ok === 'boolean' && isNum(v.probe.at) && isText(v.probe.detail)))

const isKey = (v: unknown): boolean =>
  isFields(v) &&
  isText(v.path) &&
  typeof v.generated === 'boolean' &&
  typeof v.exists === 'boolean' &&
  textOrNull(v.publicKey) &&
  textOrNull(v.error)

const isTunnelView = (v: unknown): boolean =>
  isFields(v) &&
  isSettings(v.settings) &&
  listOf(v.problems, p => isFields(p) && isText(p.field) && isText(p.message)) &&
  textOrNull(v.blocked) &&
  isNum(v.listenPort) &&
  isStatus(v.status) &&
  textOrNull(v.ssh) &&
  isKey(v.key) &&
  textOrNull(v.hostKey)

const isLoginView = (v: unknown): boolean =>
  isFields(v) &&
  typeof v.password === 'boolean' &&
  typeof v.totp === 'boolean' &&
  listOf(v.passkeys, p => isFields(p) && isText(p.id) && isText(p.label) && isNum(p.addedAt) && numOrNull(p.usedAt)) &&
  (v.lockout === null || (isFields(v.lockout) && isNum(v.lockout.until)))

const isPublicLogin = (v: unknown): boolean =>
  isFields(v) &&
  isText(v.id) &&
  METHODS.has(v.method) &&
  (v.passkeyId === undefined || isText(v.passkeyId)) &&
  isText(v.label) &&
  isText(v.address) &&
  isNum(v.signedInAt) &&
  isNum(v.expiresAt) &&
  numOrNull(v.seenAt)

const isAttempt = (v: unknown): boolean =>
  isFields(v) && isNum(v.at) && isText(v.address) && isText(v.label) && METHODS.has(v.method) && REASONS.has(v.reason)

/** GET /api/access's answer, as far as the panel and `board tunnel` rely on it. */
export function isAccessView(v: unknown): v is AccessView {
  return (
    isFields(v) &&
    isTunnelView(v.tunnel) &&
    isLoginView(v.login) &&
    listOf(v.logins, isPublicLogin) &&
    listOf(v.attempts, isAttempt)
  )
}
