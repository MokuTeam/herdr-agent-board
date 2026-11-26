// The NetSuite session store (#860, thread agent-board-149, contract ns-contract-final.md): the
// newest session of every (account, user), kept in this process's memory only, so a browser on
// any machine that lands on NetSuite's login page takes the newest session instead of logging in
// again (and kicking the other machine out: NetSuite keeps one UI session per user per account).
//
// A session is the cookies of the account's host (<account>.app.netsuite.com). Their values live
// in this store's memory and nowhere else: never on disk, in the payload, SSE, a journal, a log or
// an error. What leaves the store is metadata: names, hosts, times and `fp`, the first 8 hex
// characters of sha256(JSESSIONID). `take` is the one call that hands values out, to the route
// that answers a bridge holding its board's token.
//
// No I/O here: the clock is passed in, so the routes and the tests drive it.
import { createHash, randomUUID } from 'node:crypto'
import { hasUnprintable } from './team.ts'

export const NS_ABS_MS = 12 * 3600_000
export const NS_IDLE_MS = 3 * 3600_000
/** An entry turns `dying` this long before either predicted expiry. */
export const NS_DYING_MS = 20 * 60_000
export const NS_LOCK_DEFAULT_S = 120
export const NS_LOCK_MAX_S = 120
/** A dead entry stays in the list (metadata only) this long, then goes. */
export const NS_DEAD_KEPT_MS = 24 * 3600_000
export const NS_MAX_ENTRIES = 500
export const NS_MAX_COOKIES = 60
export const NS_MAX_BODY = 64 * 1024
const MAX_VALUE = 8192
/** The dead fingerprints a key remembers, so a dead session is never published again. */
const DEAD_FPS = 32

export type NsState = 'live' | 'dying' | 'dead'
export type NsDeadReason = 'login_redirect' | 'import_bounced' | 'switch' | 'logout' | 'expired'
const DEAD_REASONS: ReadonlySet<string> = new Set(['login_redirect', 'import_bounced', 'switch', 'logout', 'expired'])
export type NsEventKind = 'published' | 'imported' | 'activity' | 'dead' | 'expired'

export interface NsLastEvent {
  kind: NsEventKind
  at: number
  where: NsWhere | null
  reason?: NsDeadReason | null
}

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

/** A machine and its browser profile: a publisher, a holder, where activity was seen. */
export interface NsWhere {
  machine: string
  profile: string
}

export interface NsHolder extends NsWhere {
  run_id: string
}

export interface NsPublish {
  account: string
  user: string | null
  host: string
  role: string | null
  role_id: string | number | null
  fp: string
  cookies: NsCookie[]
  origin: NsWhere
  login_at: number | null
  seen_at?: number | null
  auto_renew?: boolean | null
}

/** What the list shows of an entry: never a value. */
export interface NsMeta {
  account: string
  user: string | null
  host: string
  role: string | null
  fp: string
  state: NsState
  generation: number
  login_at: number | null
  first_seen: number
  abs_expiry: number
  abs_expiry_estimated: boolean
  idle_expiry: number
  last_activity: number
  last_where: NsWhere
  origin: NsWhere
  holders: string[]
  dead_at: number | null
  dead_reason: NsDeadReason | null
  auto_renew: boolean | null
  last_event: NsLastEvent | null
  lock: { holder: NsHolder; until: number } | null
}

interface Entry {
  account: string
  user: string | null
  host: string
  role: string | null
  roleId: string | number | null
  /** Null once the entry is dead: the values go with it. */
  cookies: NsCookie[] | null
  fp: string
  generation: number
  origin: NsWhere
  loginAt: number | null
  firstSeen: number
  lastActivity: number
  lastWhere: NsWhere
  deadAt: number | null
  deadReason: NsDeadReason | null
  /** Which prediction a death matched (abs, idle or none): kept for tuning the policies (phase 3), not shown yet. */
  deadMatched: 'abs' | 'idle' | 'none' | null
  autoRenew: boolean | null
  lastEvent: NsLastEvent | null
  holders: Set<string>
  /** Fingerprints this key saw die, newest last. */
  deadFps: string[]
}

interface Lock {
  id: string
  holder: NsHolder
  until: number
}

/** A field that is wrong, by name: the routes answer it as 400 bad_request. Never holds a value. */
export class NsBodyError extends Error {
  constructor(readonly field: string) {
    super(`bad ${field}`)
  }
}

export type NsPublishResult =
  | { ok: true; stored: boolean; generation: number; state: NsState }
  | { ok: false; code: 'dead_fp' | 'store_full' }

export interface NsTaken {
  account: string
  user: string | null
  host: string
  role: string | null
  role_id: string | number | null
  fp: string
  generation: number
  state: NsState
  login_at: number | null
  last_activity: number
  cookies: NsCookie[]
}

export type NsTakeResult =
  | ({ ok: true } & NsTaken)
  | { ok: false; code: 'none' }
  | { ok: false; code: 'ambiguous_user'; users: { user: string | null; last_activity: number }[] }

export type NsLockResult =
  | { ok: true; lock_id: string; until: number }
  | { ok: false; code: 'locked'; holder: NsHolder; until: number }

/** `1234567-sb1.app.netsuite.com` and the like: an account's own UI host. */
const HOST = /^([0-9a-z]+(?:-[0-9a-z]+)?)\.app\.netsuite\.com$/
const ACCOUNT = /^[0-9A-Z]+(?:_[0-9A-Z]+)?$/
const EMAIL = /^[^\s@]+@[^\s@]+$/
const FP = /^[0-9a-f]{8}$/

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

export const isNsFp = (v: unknown): v is string => typeof v === 'string' && FP.test(v)
export const isNsDeadReason = (v: unknown): v is NsDeadReason => typeof v === 'string' && DEAD_REASONS.has(v)

export const nsLabel = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length >= 1 && v.length <= max && !hasUnprintable(v) ? v : null

/** A {machine, profile} read field by field, or null. */
export function nsWhereOf(v: unknown): NsWhere | null {
  if (!isObject(v)) return null
  const machine = nsLabel(v.machine, 64)
  const profile = nsLabel(v.profile, 64)
  return machine && profile ? { machine, profile } : null
}

/** A lock holder {machine, profile, run_id}, or null. */
export function nsHolderOf(v: unknown): NsHolder | null {
  const where = nsWhereOf(v)
  const runId = isObject(v) ? nsLabel(v.run_id, 128) : null
  return where && runId ? { ...where, run_id: runId } : null
}

/** `user` of a body: a user, null (unknown), or undefined when it is wrong. */
export function nsUserField(v: unknown): string | null | undefined {
  if (v === null || v === undefined || v === '') return null
  return nsUser(v) ?? undefined
}

const time = (v: unknown): number | null | undefined => {
  if (v === null || v === undefined) return null
  const t = typeof v === 'string' ? Date.parse(v) : v
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : undefined
}

/** A published body read field by field; NsBodyError names the first field that is wrong, never its value. */
export function nsPublishOf(raw: unknown): NsPublish {
  if (!isObject(raw)) throw new NsBodyError('body')
  const account = nsAccount(raw.account)
  if (!account) throw new NsBodyError('account')
  const user = nsUserField(raw.user)
  if (user === undefined) throw new NsBodyError('user')
  const host = typeof raw.host === 'string' ? raw.host.trim().toLowerCase() : ''
  if (nsHostAccount(host) !== account) throw new NsBodyError('host')
  let role: string | null = null
  if (raw.role !== undefined && raw.role !== null) {
    role = typeof raw.role === 'number' && Number.isFinite(raw.role) ? String(raw.role) : nsLabel(raw.role, 128)
    if (role === null) throw new NsBodyError('role')
  }
  let roleId: string | number | null = null
  if (raw.role_id !== undefined && raw.role_id !== null) {
    if (typeof raw.role_id === 'number' && Number.isFinite(raw.role_id)) roleId = raw.role_id
    else if (nsLabel(raw.role_id, 64)) roleId = raw.role_id as string
    else throw new NsBodyError('role_id')
  }
  const origin = nsWhereOf(raw.origin)
  if (!origin) throw new NsBodyError('origin')
  const loginAt = time(raw.login_at)
  if (loginAt === undefined) throw new NsBodyError('login_at')
  const seenAt = time(raw.seen_at)
  if (seenAt === undefined) throw new NsBodyError('seen_at')
  let autoRenew: boolean | null = null
  if (raw.auto_renew !== undefined && raw.auto_renew !== null) {
    if (typeof raw.auto_renew !== 'boolean') throw new NsBodyError('auto_renew')
    autoRenew = raw.auto_renew
  }
  if (!Array.isArray(raw.cookies) || raw.cookies.length < 1 || raw.cookies.length > NS_MAX_COOKIES)
    throw new NsBodyError('cookies')
  const cookies = raw.cookies.map((c, i) => cookieOf(c, host, i))
  const jsid =
    cookies.find(c => c.name === 'JSESSIONID' && c.path === '/') ?? cookies.find(c => c.name === 'JSESSIONID')
  if (!jsid) throw new NsBodyError('cookies.JSESSIONID')
  // The bridge's fp, recomputed: one that does not match is refused.
  if (!isNsFp(raw.fp) || raw.fp !== nsFingerprint(jsid.value)) throw new NsBodyError('fp')
  return {
    account,
    user,
    host,
    role,
    role_id: roleId,
    fp: raw.fp,
    cookies,
    origin,
    login_at: loginAt,
    seen_at: seenAt,
    auto_renew: autoRenew,
  }
}

function cookieOf(raw: unknown, host: string, i: number): NsCookie {
  const at = `cookies[${i}]`
  if (!isObject(raw)) throw new NsBodyError(at)
  const name = nsLabel(raw.name, 256)
  if (!name || /[\s=;,]/.test(name)) throw new NsBodyError(`${at}.name`)
  if (typeof raw.value !== 'string' || raw.value.length > MAX_VALUE || /[\0\r\n]/.test(raw.value))
    throw new NsBodyError(`${at}.value`)
  const domain = typeof raw.domain === 'string' ? raw.domain.trim().toLowerCase() : ''
  // The account host's own cookies only (host-only, or its dot-domain): never another site's.
  if (domain !== host && domain !== `.${host}`) throw new NsBodyError(`${at}.domain`)
  const path = raw.path === undefined ? '/' : nsLabel(raw.path, 1024)
  if (!path?.startsWith('/')) throw new NsBodyError(`${at}.path`)
  const sameSite = raw.sameSite === undefined ? 'unspecified' : nsLabel(raw.sameSite, 32)
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
  max?: number
  newId?: () => string
}

export interface NsStore {
  publish(p: NsPublish): NsPublishResult
  /** The values of the live entry of (account, user); with no user, the account's only live one. */
  take(account: string, user: string | null, where?: NsWhere | null): NsTakeResult
  touch(account: string, fp: string, where: NsWhere): { matched: boolean; state: NsState | null }
  dead(account: string, fp: string, reason: NsDeadReason, where?: NsWhere | null): boolean
  lock(account: string, user: string | null, holder: NsHolder, ttlS: number): NsLockResult
  /** Releases the lock of (account, user) when `holder` holds it. */
  unlock(account: string, user: string | null, holder: NsHolder): boolean
  /** Drops the entry of (account, user) and its cookie values from the store. */
  forget(account: string, user: string | null): boolean
  /** Which prediction the entry's death matched, for tests and phase 3. */
  deadMatched(account: string, user: string | null): 'abs' | 'idle' | 'none' | null
  list(account?: string | null): NsMeta[]
  /** Next timestamp (epoch ms) when a live/dying entry transitions state, or null when none do. */
  nextTransitionAt(t?: number): number | null
  /** Subscribe to store metadata/state mutations; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Every value dropped (the board stops). */
  clear(): void
}

const keyOf = (account: string, user: string | null): string => `${account}\u0000${user ?? ''}`
// One machine and profile is one seat: it may extend its own lock whatever run asks. A release
// names the run as well when both sides know it, so a late unlock from an earlier run of the same
// seat does not drop the lock of the run that holds it now.
const sameSeat = (a: NsHolder, b: NsHolder): boolean => a.machine === b.machine && a.profile === b.profile
const sameRun = (a: NsHolder, b: NsHolder): boolean =>
  sameSeat(a, b) && (!a.run_id || !b.run_id || a.run_id === b.run_id)

export function createNsStore(o: NsStoreOptions = {}): NsStore {
  const now = o.now ?? Date.now
  const absMs = o.absMs ?? NS_ABS_MS
  const idleMs = o.idleMs ?? NS_IDLE_MS
  const max = o.max ?? NS_MAX_ENTRIES
  const newId = o.newId ?? randomUUID
  const entries = new Map<string, Entry>()
  const locks = new Map<string, Lock>()
  const firstSeenByFp = new Map<string, number>()
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const fn of [...listeners]) {
      try {
        fn()
      } catch {}
    }
  }

  const absOf = (e: Entry): number => (e.loginAt ?? e.firstSeen) + absMs
  const idleOf = (e: Entry): number => e.lastActivity + idleMs

  function recordFirstSeen(account: string, fp: string, seenAt: number | null | undefined, t: number): number {
    const seen = seenAt !== undefined && seenAt !== null && seenAt <= t ? seenAt : t
    const fk = keyOf(account, fp)
    const prev = firstSeenByFp.get(fk)
    const earliest = prev !== undefined ? Math.min(prev, seen) : seen
    if (!firstSeenByFp.has(fk) && firstSeenByFp.size >= Math.max(max * 4, 2000)) {
      const oldest = firstSeenByFp.keys().next().value
      if (oldest !== undefined) firstSeenByFp.delete(oldest)
    }
    firstSeenByFp.set(fk, earliest)
    return earliest
  }

  function kill(e: Entry, reason: NsDeadReason, at: number, where: NsWhere | null = null): void {
    if (e.deadAt !== null) return
    e.deadMatched = at >= absOf(e) - NS_DYING_MS ? 'abs' : at >= idleOf(e) - NS_DYING_MS ? 'idle' : 'none'
    e.deadAt = at
    e.deadReason = reason
    e.cookies = null
    e.lastEvent = {
      kind: reason === 'expired' ? 'expired' : 'dead',
      at,
      where: where ? { ...where } : null,
      reason,
    }
    e.deadFps = [...e.deadFps.filter(f => f !== e.fp), e.fp].slice(-DEAD_FPS)
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

  /** The account's entry whose current session is `fp`. */
  const byFp = (account: string, fp: string): Entry | undefined =>
    [...entries.values()].find(e => e.account === account && e.fp === fp)

  /** Room for one more key: the oldest dead entry goes; a live one never does. */
  function makeRoom(): boolean {
    if (entries.size < max) return true
    const dead = [...entries.entries()]
      .filter(([, e]) => e.deadAt !== null)
      .sort((a, b) => (a[1].deadAt ?? 0) - (b[1].deadAt ?? 0))[0]
    if (!dead) return false
    entries.delete(dead[0])
    return true
  }

  function releaseBy(account: string, user: string | null, origin: NsWhere): boolean {
    const k = keyOf(account, user)
    const l = locks.get(k)
    if (l && l.holder.machine === origin.machine && l.holder.profile === origin.profile) {
      locks.delete(k)
      return true
    }
    return false
  }

  function merge(e: Entry, p: NsPublish, firstSeen: number, realLoginAt: number | null): boolean {
    let changed = false
    if (firstSeen < e.firstSeen) {
      e.firstSeen = firstSeen
      changed = true
    }
    if (e.loginAt === null && realLoginAt !== null) {
      e.loginAt = realLoginAt
      changed = true
    }
    if (e.role === null && p.role !== null) {
      e.role = p.role
      changed = true
    }
    if (e.roleId === null && p.role_id !== null) {
      e.roleId = p.role_id
      changed = true
    }
    if (p.auto_renew !== undefined && p.auto_renew !== null && e.autoRenew !== p.auto_renew) {
      e.autoRenew = p.auto_renew
      changed = true
    }
    if (!e.holders.has(p.origin.machine)) {
      e.holders.add(p.origin.machine)
      changed = true
    }
    return changed
  }

  return {
    publish(p) {
      const t = now()
      prune(t)
      const realLoginAt = p.login_at !== null && p.login_at <= t ? p.login_at : null
      // No user known (no loaded tab): the entry with this session, else one kept as unknown.
      if (p.user === null) {
        const same = byFp(p.account, p.fp)
        if (same) {
          if (stateOf(same, t) === 'dead') return { ok: false, code: 'dead_fp' }
          const firstSeen = recordFirstSeen(p.account, p.fp, p.seen_at, t)
          const changed = merge(same, p, firstSeen, realLoginAt)
          const unlocked = releaseBy(p.account, same.user, p.origin)
          if (changed || unlocked) emit()
          return { ok: true, stored: false, generation: same.generation, state: stateOf(same, t) }
        }
      }
      const k = keyOf(p.account, p.user)
      const cur = entries.get(k)
      if (cur?.deadFps.includes(p.fp)) return { ok: false, code: 'dead_fp' }
      if (cur && cur.fp === p.fp) {
        if (stateOf(cur, t) === 'dead') return { ok: false, code: 'dead_fp' }
        const firstSeen = recordFirstSeen(p.account, p.fp, p.seen_at, t)
        const changed = merge(cur, p, firstSeen, realLoginAt)
        const unlocked = releaseBy(p.account, p.user, p.origin)
        if (changed || unlocked) emit()
        return { ok: true, stored: false, generation: cur.generation, state: stateOf(cur, t) }
      }
      // The same session kept as unknown gets its user now.
      const unknown = p.user !== null ? entries.get(keyOf(p.account, null)) : undefined
      const inheritedLoginAt = unknown?.fp === p.fp ? unknown.loginAt : null
      if (!cur && !makeRoom()) return { ok: false, code: 'store_full' }
      if (unknown?.fp === p.fp) entries.delete(keyOf(p.account, null))
      const firstSeen = recordFirstSeen(p.account, p.fp, p.seen_at, t)
      const e: Entry = {
        account: p.account,
        user: p.user,
        host: p.host,
        role: p.role ?? cur?.role ?? null,
        roleId: p.role_id ?? cur?.roleId ?? null,
        cookies: p.cookies,
        fp: p.fp,
        generation: (cur?.generation ?? 0) + 1,
        origin: p.origin,
        loginAt: realLoginAt ?? inheritedLoginAt,
        firstSeen,
        lastActivity: t,
        lastWhere: p.origin,
        deadAt: null,
        deadReason: null,
        deadMatched: null,
        autoRenew: p.auto_renew ?? cur?.autoRenew ?? null,
        lastEvent: { kind: 'published', at: t, where: { ...p.origin } },
        holders: new Set([p.origin.machine]),
        deadFps: cur?.deadFps ?? [],
      }
      entries.set(k, e)
      releaseBy(p.account, p.user, p.origin)
      emit()
      return { ok: true, stored: true, generation: e.generation, state: stateOf(e, t) }
    },

    take(account, user, where = null) {
      const t = now()
      prune(t)
      let e: Entry | undefined
      if (user !== null) e = entries.get(keyOf(account, user))
      else {
        const alive = [...entries.values()].filter(x => x.account === account && stateOf(x, t) !== 'dead')
        if (alive.length > 1)
          return {
            ok: false,
            code: 'ambiguous_user',
            users: alive
              .map(x => ({ user: x.user, last_activity: x.lastActivity }))
              .sort((a, b) => b.last_activity - a.last_activity),
          }
        e = alive[0]
      }
      if (!e?.cookies || stateOf(e, t) === 'dead') return { ok: false, code: 'none' }
      if (where) e.holders.add(where.machine)
      e.lastEvent = { kind: 'imported', at: t, where: where ? { ...where } : null }
      emit()
      return {
        ok: true,
        account: e.account,
        user: e.user,
        host: e.host,
        role: e.role,
        role_id: e.roleId,
        fp: e.fp,
        generation: e.generation,
        state: stateOf(e, t),
        login_at: e.loginAt,
        last_activity: e.lastActivity,
        cookies: e.cookies.map(c => ({ ...c })),
      }
    },

    touch(account, fp, where) {
      const t = now()
      const e = byFp(account, fp)
      if (!e || stateOf(e, t) === 'dead') return { matched: false, state: null }
      e.lastActivity = t
      e.lastWhere = where
      e.holders.add(where.machine)
      e.lastEvent = { kind: 'activity', at: t, where: { ...where } }
      const state = stateOf(e, t)
      emit()
      return { matched: true, state }
    },

    dead(account, fp, reason, where = null) {
      const t = now()
      const e = byFp(account, fp)
      if (!e || stateOf(e, t) === 'dead') return false
      kill(e, reason, t, where)
      emit()
      return true
    },

    lock(account, user, holder, ttlS) {
      const t = now()
      prune(t)
      const k = keyOf(account, user)
      const held = locks.get(k)
      const until = t + Math.min(Math.max(1, Math.floor(ttlS)), NS_LOCK_MAX_S) * 1000
      if (held && held.until > t) {
        if (!sameSeat(held.holder, holder)) return { ok: false, code: 'locked', holder: held.holder, until: held.until }
        held.holder = holder
        held.until = until
        emit()
        return { ok: true, lock_id: held.id, until }
      }
      const id = newId()
      locks.set(k, { id, holder, until })
      emit()
      return { ok: true, lock_id: id, until }
    },

    unlock(account, user, holder) {
      const t = now()
      const k = keyOf(account, user)
      const held = locks.get(k)
      if (!held || held.until <= t || !sameRun(held.holder, holder)) return false
      locks.delete(k)
      emit()
      return true
    },

    forget(account, user) {
      const k = keyOf(account, user)
      const e = entries.get(k)
      if (e) {
        e.cookies = null
        firstSeenByFp.delete(keyOf(account, e.fp))
      }
      const hadEntry = entries.delete(k)
      const hadLock = locks.delete(k)
      if (hadEntry || hadLock) emit()
      return hadEntry
    },

    deadMatched(account, user) {
      return entries.get(keyOf(account, user))?.deadMatched ?? null
    },

    list(account) {
      const t = now()
      prune(t)
      return [...entries.values()]
        .filter(e => !account || e.account === account)
        .map((e): NsMeta => {
          const state = stateOf(e, t)
          const l = locks.get(keyOf(e.account, e.user))
          return {
            account: e.account,
            user: e.user,
            host: e.host,
            role: e.role,
            fp: e.fp,
            state,
            generation: e.generation,
            login_at: e.loginAt,
            first_seen: e.firstSeen,
            abs_expiry: absOf(e),
            abs_expiry_estimated: e.loginAt === null,
            idle_expiry: idleOf(e),
            last_activity: e.lastActivity,
            last_where: { ...e.lastWhere },
            origin: { ...e.origin },
            holders: [...e.holders].sort(),
            dead_at: e.deadAt,
            dead_reason: e.deadReason,
            auto_renew: e.autoRenew,
            last_event: e.lastEvent
              ? {
                  ...e.lastEvent,
                  where: e.lastEvent.where ? { ...e.lastEvent.where } : null,
                }
              : null,
            lock: l && l.until > t ? { holder: { ...l.holder }, until: l.until } : null,
          }
        })
        .sort((a, b) => a.account.localeCompare(b.account) || (a.user ?? '').localeCompare(b.user ?? ''))
    },

    nextTransitionAt(t = now()) {
      let min: number | null = null
      for (const e of entries.values()) {
        if (e.deadAt !== null) continue
        const absAt = absOf(e)
        if (absAt <= t) return t
        const dyingAt = Math.min(absAt, idleOf(e)) - NS_DYING_MS
        const next = dyingAt > t ? dyingAt : absAt
        if (min === null || next < min) min = next
      }
      return min
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    clear() {
      const had = entries.size > 0 || locks.size > 0
      for (const e of entries.values()) e.cookies = null
      entries.clear()
      locks.clear()
      firstSeenByFp.clear()
      if (had) emit()
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
  const endsAt = Math.min(m.abs_expiry, m.idle_expiry)
  const endsLabel = m.abs_expiry_estimated && m.abs_expiry <= m.idle_expiry ? 'ends about' : 'ends'
  const parts = [
    m.account,
    m.user ?? '(user unknown)',
    m.state + (m.dead_reason ? ` (${m.dead_reason})` : ''),
    `fp ${m.fp}`,
    `gen ${m.generation}`,
    m.login_at !== null ? `login ${ago(m.login_at)} ago` : `login unknown (seen ${ago(m.first_seen)} ago)`,
    ...(m.state === 'dead' ? [] : [`${endsLabel} ${left(endsAt)}`]),
    `active ${ago(m.last_activity)} ago on ${m.last_where.machine}/${m.last_where.profile}`,
    ...(m.lock ? [`locked by ${m.lock.holder.machine}/${m.lock.holder.profile}`] : []),
  ]
  return parts.join(' · ')
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
