// The NetSuite session store (#860, thread agent-board-149): the newest session of every
// (account, user), kept in this process's memory only, so a browser on any machine that lands on
// NetSuite's login page takes the newest session instead of logging in again (and kicking the
// other machine out: NetSuite keeps one UI session per user per account, the newest wins).
//
// A session is the cookies of the account's host (<account>.app.netsuite.com). Their values live
// in this store's memory and nowhere else: never on disk, in the payload, SSE, a journal, a log or
// an error. What leaves the store is metadata: names, hosts, times and `fp`, the first 8 hex
// characters of sha256(JSESSIONID). `take` is the one call that hands values out, to the route
// that answers a bridge holding the store's token.
//
// No I/O here: the clock is passed in, so the routes and the tests drive it.
import { createHash } from 'node:crypto'
import { hasUnprintable } from './team.ts'

export const NS_ABS_MS = 12 * 3600_000
export const NS_IDLE_MS = 3 * 3600_000
/** An entry turns `dying` this long before either predicted expiry. */
export const NS_DYING_MS = 20 * 60_000
/** The longest a login lock is held. */
export const NS_LOCK_MAX_S = 120
/** A dead entry stays in the list (metadata only) this long, then goes. */
export const NS_DEAD_KEPT_MS = 24 * 3600_000
export const NS_MAX_ENTRIES = 500
export const NS_MAX_COOKIES = 64
const MAX_VALUE = 8192
/** The past fingerprints a key remembers, so a session it has seen replaced is stale when published again. */
const PAST_FPS = 16

export type NsState = 'live' | 'dying' | 'dead'
export type NsDeadReason = 'login-redirect' | 'switch' | 'logout' | 'expired'
const DEAD_REASONS: ReadonlySet<string> = new Set(['login-redirect', 'switch', 'logout', 'expired'])

export interface NsCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: string
  expirationDate?: number
}

export interface NsOrigin {
  machine: string
  profile: string
}

export interface NsPublish {
  account: string
  user: string
  role?: string
  host: string
  cookies: NsCookie[]
  origin: NsOrigin
  login_at?: number
}

export interface NsActivity {
  at: number
  where: string
}

/** What the list shows of an entry: never a value. */
export interface NsMeta {
  account: string
  user: string
  role: string | null
  host: string
  state: NsState
  dead_reason: NsDeadReason | null
  /** Which prediction a death matched (abs, idle or none), to tune the policies from data. */
  dead_matched: 'abs' | 'idle' | 'none' | null
  fp: string
  generation: number
  origin: NsOrigin
  login_at: number
  abs_expiry: number
  idle_expiry: number
  last_activity: NsActivity
  holders: string[]
  lock: { holder: string; until: number } | null
}

interface Entry {
  account: string
  user: string
  role: string | null
  host: string
  /** Null once the entry is dead: the values go with it. */
  cookies: NsCookie[] | null
  fp: string
  generation: number
  origin: NsOrigin
  loginAt: number
  lastActivity: NsActivity
  deadAt: number | null
  deadReason: NsDeadReason | null
  deadMatched: 'abs' | 'idle' | 'none' | null
  holders: Set<string>
  /** Fingerprints this key held before, newest last. */
  past: string[]
}

interface Lock {
  holder: string
  until: number
}

/** A field that is wrong, by name: the routes answer it as 400 { error: 'body', field }. */
export class NsBodyError extends Error {
  constructor(readonly field: string) {
    super(`ns-sessions: bad ${field}`)
  }
}

export type NsPublishResult =
  | { ok: true; fp: string; generation: number; state: NsState; changed: boolean }
  | { ok: false; error: 'stale'; fp: string }

export type NsTakeResult =
  | {
      ok: true
      fp: string
      generation: number
      cookies: NsCookie[]
      role: string | null
      login_at: number
      user: string
    }
  | { ok: false; error: 'none' }
  | { ok: false; error: 'ambiguous'; users: string[] }

export type NsLockResult = { ok: true; until: number } | { ok: false; holder: string; until: number }

/** `1234567-sb1.app.netsuite.com` and the like: an account's own UI host. */
const HOST = /^([0-9a-z]+(?:-[0-9a-z]+)*)\.app\.netsuite\.com$/
const ACCOUNT = /^[0-9A-Z]+(?:_[0-9A-Z]+)*$/
const EMAIL = /^[^\s@]+@[^\s@]+$/

/** The account as the store keys it (upper case), or null. */
export function nsAccount(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const a = v.trim().toUpperCase()
  return a.length >= 1 && a.length <= 64 && ACCOUNT.test(a) ? a : null
}

/** The user as the store keys it (a lower-case email), or null. */
export function nsUser(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const u = v.trim().toLowerCase()
  return u.length >= 3 && u.length <= 254 && EMAIL.test(u) && !hasUnprintable(u) ? u : null
}

/** The account a host belongs to (`1234567-sb1.app.netsuite.com` is 1234567_SB1), or null. */
export function nsHostAccount(host: string): string | null {
  const m = HOST.exec(host)
  return m?.[1] ? m[1].replace(/-/g, '_').toUpperCase() : null
}

/** The 8-hex fingerprint of a JSESSIONID value: the only trace of a value that leaves the store. */
export const nsFingerprint = (jsessionid: string): string =>
  createHash('sha256').update(jsessionid).digest('hex').slice(0, 8)

const label = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length >= 1 && v.length <= max && !hasUnprintable(v) ? v : null

const FP = /^[0-9a-f]{8}$/
export const isNsFp = (v: unknown): v is string => typeof v === 'string' && FP.test(v)

export const isNsDeadReason = (v: unknown): v is NsDeadReason => typeof v === 'string' && DEAD_REASONS.has(v)

/** A published body read field by field; NsBodyError names the first field that is wrong, never its value. */
export function nsPublishOf(raw: unknown): NsPublish {
  if (!isObject(raw)) throw new NsBodyError('body')
  const account = nsAccount(raw.account)
  if (!account) throw new NsBodyError('account')
  const user = nsUser(raw.user)
  if (!user) throw new NsBodyError('user')
  const host = typeof raw.host === 'string' ? raw.host.trim().toLowerCase() : ''
  if (nsHostAccount(host) !== account) throw new NsBodyError('host')
  let role: string | undefined
  if (raw.role !== undefined && raw.role !== null) {
    const r = typeof raw.role === 'number' && Number.isInteger(raw.role) ? String(raw.role) : label(raw.role, 64)
    if (!r) throw new NsBodyError('role')
    role = r
  }
  if (!isObject(raw.origin)) throw new NsBodyError('origin')
  const machine = label(raw.origin.machine, 64)
  const profile = label(raw.origin.profile, 64)
  if (!machine || !profile) throw new NsBodyError('origin')
  let loginAt: number | undefined
  if (raw.login_at !== undefined && raw.login_at !== null) {
    const t = typeof raw.login_at === 'string' ? Date.parse(raw.login_at) : raw.login_at
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) throw new NsBodyError('login_at')
    loginAt = t
  }
  if (!Array.isArray(raw.cookies) || raw.cookies.length < 1 || raw.cookies.length > NS_MAX_COOKIES)
    throw new NsBodyError('cookies')
  const cookies = raw.cookies.map((c, i) => cookieOf(c, host, i))
  if (!cookies.some(c => c.name === 'JSESSIONID')) throw new NsBodyError('cookies.JSESSIONID')
  return {
    account,
    user,
    host,
    cookies,
    origin: { machine, profile },
    ...(role !== undefined && { role }),
    ...(loginAt !== undefined && { login_at: loginAt }),
  }
}

function cookieOf(raw: unknown, host: string, i: number): NsCookie {
  const at = `cookies[${i}]`
  if (!isObject(raw)) throw new NsBodyError(at)
  const name = label(raw.name, 256)
  if (!name || /[\s=;,]/.test(name)) throw new NsBodyError(`${at}.name`)
  if (typeof raw.value !== 'string' || raw.value.length > MAX_VALUE || /[\0\r\n]/.test(raw.value))
    throw new NsBodyError(`${at}.value`)
  const domain = typeof raw.domain === 'string' ? raw.domain.trim().toLowerCase() : ''
  // The account host's own cookies only (host-only, or its dot-domain): never another site's.
  if (domain !== host && domain !== `.${host}`) throw new NsBodyError(`${at}.domain`)
  const path = raw.path === undefined ? '/' : label(raw.path, 1024)
  if (!path?.startsWith('/')) throw new NsBodyError(`${at}.path`)
  const sameSite = raw.sameSite === undefined ? 'unspecified' : label(raw.sameSite, 32)
  if (!sameSite) throw new NsBodyError(`${at}.sameSite`)
  if (
    raw.expirationDate !== undefined &&
    (typeof raw.expirationDate !== 'number' || !Number.isFinite(raw.expirationDate))
  )
    throw new NsBodyError(`${at}.expirationDate`)
  return {
    name,
    value: raw.value,
    domain,
    path,
    secure: raw.secure === true,
    httpOnly: raw.httpOnly === true,
    sameSite,
    ...(typeof raw.expirationDate === 'number' && { expirationDate: raw.expirationDate }),
  }
}

export interface NsStoreOptions {
  now?: () => number
  absMs?: number
  idleMs?: number
}

export interface NsStore {
  publish(p: NsPublish): NsPublishResult
  /** The values of the live entry of (account, user); with no user, the account's only live one. */
  take(account: string, user: string | null): NsTakeResult
  touch(account: string, user: string, fp: string, where: string): boolean
  dead(account: string, user: string, fp: string, reason: NsDeadReason): boolean
  lock(account: string, user: string, holder: string, ttlS: number): NsLockResult
  unlock(account: string, user: string, holder: string): boolean
  list(): NsMeta[]
  /** Every value dropped (the board stops). */
  clear(): void
}

const keyOf = (account: string, user: string): string => `${account}\u0000${user}`

export function createNsStore(o: NsStoreOptions = {}): NsStore {
  const now = o.now ?? Date.now
  const absMs = o.absMs ?? NS_ABS_MS
  const idleMs = o.idleMs ?? NS_IDLE_MS
  const entries = new Map<string, Entry>()
  const locks = new Map<string, Lock>()

  const absOf = (e: Entry): number => e.loginAt + absMs
  const idleOf = (e: Entry): number => e.lastActivity.at + idleMs

  function kill(e: Entry, reason: NsDeadReason, at: number): void {
    if (e.deadAt !== null) return
    const abs = absOf(e)
    const idle = idleOf(e)
    e.deadAt = at
    e.deadReason = reason
    e.deadMatched = at >= abs - NS_DYING_MS ? 'abs' : at >= idle - NS_DYING_MS ? 'idle' : 'none'
    e.cookies = null
  }

  /** The entry's state now; past its absolute expiry it dies here and its values go. */
  function stateOf(e: Entry, t: number): NsState {
    if (e.deadAt === null && t >= absOf(e)) kill(e, 'expired', t)
    if (e.deadAt !== null) return 'dead'
    return t >= Math.min(absOf(e), idleOf(e)) - NS_DYING_MS ? 'dying' : 'live'
  }

  function prune(t: number): void {
    for (const [k, e] of entries) {
      stateOf(e, t)
      if (e.deadAt !== null && t - e.deadAt > NS_DEAD_KEPT_MS) entries.delete(k)
    }
    for (const [k, l] of locks) if (l.until <= t) locks.delete(k)
  }

  return {
    publish(p) {
      const t = now()
      prune(t)
      const jsid =
        p.cookies.find(c => c.name === 'JSESSIONID' && c.path === '/') ?? p.cookies.find(c => c.name === 'JSESSIONID')
      const fp = nsFingerprint(jsid?.value ?? '')
      const k = keyOf(p.account, p.user)
      const cur = entries.get(k)
      if (cur) {
        stateOf(cur, t)
        if (cur.fp === fp) {
          // The same session again: dead stays dead (its values went), live gets the fresh copy.
          if (cur.deadAt !== null) return { ok: false, error: 'stale', fp }
          cur.cookies = p.cookies
          cur.host = p.host
          if (p.role !== undefined) cur.role = p.role
          cur.holders.add(p.origin.machine)
          return { ok: true, fp, generation: cur.generation, state: stateOf(cur, t), changed: false }
        }
        // A session this key held before and has seen replaced: the newer one won.
        if (cur.past.includes(fp)) return { ok: false, error: 'stale', fp }
      } else if (entries.size >= NS_MAX_ENTRIES) {
        // Room for a new key: the oldest dead entry goes first, else the least recently active one.
        const victim =
          [...entries.entries()]
            .filter(([, e]) => e.deadAt !== null)
            .sort((a, b) => (a[1].deadAt ?? 0) - (b[1].deadAt ?? 0))[0] ??
          [...entries.entries()].sort((a, b) => a[1].lastActivity.at - b[1].lastActivity.at)[0]
        if (victim) entries.delete(victim[0])
      }
      const where = `${p.origin.machine}/${p.origin.profile}`
      const loginAt = p.login_at !== undefined && p.login_at <= t ? p.login_at : t
      const e: Entry = {
        account: p.account,
        user: p.user,
        role: p.role ?? cur?.role ?? null,
        host: p.host,
        cookies: p.cookies,
        fp,
        generation: (cur?.generation ?? 0) + 1,
        origin: p.origin,
        loginAt,
        lastActivity: { at: t, where },
        deadAt: null,
        deadReason: null,
        deadMatched: null,
        holders: new Set([p.origin.machine]),
        past: cur ? [...cur.past, cur.fp].slice(-PAST_FPS) : [],
      }
      entries.set(k, e)
      return { ok: true, fp, generation: e.generation, state: stateOf(e, t), changed: true }
    },

    take(account, user) {
      const t = now()
      prune(t)
      const alive = [...entries.values()].filter(e => e.account === account && stateOf(e, t) !== 'dead')
      let e: Entry | undefined
      if (user !== null) e = alive.find(x => x.user === user)
      else if (alive.length > 1) return { ok: false, error: 'ambiguous', users: alive.map(x => x.user).sort() }
      else e = alive[0]
      if (!e?.cookies) return { ok: false, error: 'none' }
      return {
        ok: true,
        fp: e.fp,
        generation: e.generation,
        cookies: e.cookies.map(c => ({ ...c })),
        role: e.role,
        login_at: e.loginAt,
        user: e.user,
      }
    },

    touch(account, user, fp, where) {
      const t = now()
      const e = entries.get(keyOf(account, user))
      if (!e || e.fp !== fp || stateOf(e, t) === 'dead') return false
      e.lastActivity = { at: t, where }
      const machine = where.split('/')[0]
      if (machine) e.holders.add(machine)
      return true
    },

    dead(account, user, fp, reason) {
      const t = now()
      const e = entries.get(keyOf(account, user))
      if (!e || e.fp !== fp || stateOf(e, t) === 'dead') return false
      kill(e, reason, t)
      return true
    },

    lock(account, user, holder, ttlS) {
      const t = now()
      prune(t)
      const k = keyOf(account, user)
      const held = locks.get(k)
      if (held && held.until > t && held.holder !== holder) return { ok: false, holder: held.holder, until: held.until }
      const until = t + Math.min(Math.max(1, Math.floor(ttlS)), NS_LOCK_MAX_S) * 1000
      locks.set(k, { holder, until })
      return { ok: true, until }
    },

    unlock(account, user, holder) {
      const k = keyOf(account, user)
      const held = locks.get(k)
      if (!held || held.holder !== holder) return false
      locks.delete(k)
      return true
    },

    list() {
      const t = now()
      prune(t)
      return [...entries.values()]
        .map((e): NsMeta => {
          const state = stateOf(e, t)
          const l = locks.get(keyOf(e.account, e.user))
          return {
            account: e.account,
            user: e.user,
            role: e.role,
            host: e.host,
            state,
            dead_reason: e.deadReason,
            dead_matched: e.deadMatched,
            fp: e.fp,
            generation: e.generation,
            origin: { ...e.origin },
            login_at: e.loginAt,
            abs_expiry: absOf(e),
            idle_expiry: idleOf(e),
            last_activity: { ...e.lastActivity },
            holders: [...e.holders].sort(),
            lock: l && l.until > t ? { holder: l.holder, until: l.until } : null,
          }
        })
        .sort((a, b) => a.account.localeCompare(b.account) || a.user.localeCompare(b.user))
    },

    clear() {
      for (const e of entries.values()) e.cookies = null
      entries.clear()
      locks.clear()
    },
  }
}

/** One line of `board ns-sessions list`: metadata only. */
export function nsListLine(m: NsMeta, t: number): string {
  const span = (ms: number): string => {
    const min = Math.max(0, Math.round(ms / 60_000))
    return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`
  }
  const ago = (at: number): string => span(t - at)
  const left = (at: number): string => (at <= t ? 'now' : `in ${span(at - t)}`)
  const parts = [
    m.account,
    m.user,
    m.state + (m.dead_reason ? ` (${m.dead_reason})` : ''),
    `fp ${m.fp}`,
    `gen ${m.generation}`,
    `login ${ago(m.login_at)} ago`,
    ...(m.state === 'dead' ? [] : [`ends ${left(Math.min(m.abs_expiry, m.idle_expiry))}`]),
    `active ${ago(m.last_activity.at)} ago on ${m.last_activity.where}`,
    ...(m.lock ? [`locked by ${m.lock.holder}`] : []),
  ]
  return parts.join(' · ')
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
