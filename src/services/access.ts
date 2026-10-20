// The board's own login through the owner's domain (core/access.ts: its rules; adapters/
// access-store.ts: its files). The password and the TOTP code are set up on the local board and
// checked together on a sign-in through the domain; a sign-in makes a login of 30 days, whose
// token goes out once and is kept as its hash only. Failed sign-ins are recorded and lock
// sign-in after 5 in a row; the public routes are rate-limited in memory. Ending a login tells
// whoever watches it (its open event streams), as services/remote.ts does for phones.
// Sign-ins refused for the rate are recorded at a capped rate of their own (10 an address, 30 a
// minute), so a flood of them never rewrites the attempts file, or tells the panel, at the
// flood's own rate.
// Passkeys (core/webauthn.ts checks them): one is added on the device itself, through the domain,
// by a login that gives a fresh TOTP code (a later step than the last one used, so never the code
// it signed in with); a passkey sign-in is never locked out, has rate counters of its own, and its
// failures never count toward the lockout. A challenge (32 random bytes) is kept in memory for one
// use within 2 minutes, at most 50 at once; a sign-in's never adds, and an add's adds only for
// its own login. The WebAuthn user id (16 random bytes) is made once and kept in access.json.
import { randomBytes } from 'node:crypto'
import {
  type AccessSecrets,
  accessReady,
  addAttempt,
  readAttempts,
  readLogins,
  readPasskeys,
  readSecrets,
  updateLogins,
  updatePasskeys,
  updateSecrets,
} from '../adapters/access-store.ts'
import type { EditResult } from '../adapters/config-file.ts'
import { isRecord } from '../adapters/json-store.ts'
import {
  type AccessView,
  type AttemptReason,
  deviceLabel,
  LOGIN_MS,
  type Login,
  type LoginMethod,
  lockWaitMs,
  type Passkey,
  type PublicLogin,
  passwordProblem,
  RATES,
  RateLimiter,
} from '../core/access.ts'
import { t } from '../core/lang.ts'
import { base32, base32Bytes, totpMatch, totpUri } from '../core/totp.ts'
import { b64url, verifyAssertion, verifyRegistration } from '../core/webauthn.ts'
import { hashToken } from './remote.ts'

/** Longer than this is never the password: refused before argon2 spends any time on it. */
const PASSWORD_MAX = 1024
/** A TOTP secret being set up waits this long, in memory, for its first right code. */
const PENDING_TOTP_MS = 10 * 60_000
const TOTP_BYTES = 20
/** The most a timer waits (2^31 - 1 ms, about 24.8 days); a longer one would fire at once. */
const TIMER_MAX_MS = 2_147_483_647
/** When a login was last seen goes to the file at most this often. */
const SEEN_EVERY_MS = 60_000
const ATTEMPTS_SHOWN = 20
/** A passkey challenge: its bytes, how long it waits for its one use, and how many wait at most. */
const CHALLENGE_BYTES = 32
const CHALLENGE_MS = 2 * 60_000
const CHALLENGES_MAX = 50
const USER_ID_BYTES = 16
/** WebAuthn's longest user id and credential id, in bytes. */
const USER_ID_MAX = 64
const CREDENTIAL_ID_MAX = 1023
/** How a passkey's authenticator is reached (WebAuthn's AuthenticatorTransport): only these are kept. */
const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'smart-card', 'hybrid', 'internal'])

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Who signs in: the address from the proxy (forwardedAddress) and the browser's User-Agent. */
export interface Who {
  address: string
  userAgent: string | null
}

export type SignIn =
  | { ok: true; token: string; maxAgeS: number; login: PublicLogin }
  | { ok: false; status: 401 | 423 | 429; error: 'wrong' | 'locked' | 'limited'; retryAfterS?: number; until?: number }

/** What navigator.credentials.create() takes to add a passkey, its bytes in base64url (the page turns them into bytes). */
export interface CreationOptions {
  challenge: string
  rp: { id: string; name: 'Agent board' }
  user: { id: string; name: 'owner'; displayName: 'Agent board' }
  pubKeyCredParams: { type: 'public-key'; alg: -7 | -257 }[]
  authenticatorSelection: { residentKey: 'required'; requireResidentKey: true; userVerification: 'required' }
  attestation: 'none'
  excludeCredentials: { type: 'public-key'; id: string }[]
  timeout: number
}

export interface Access {
  /** Password and TOTP are set up. */
  ready(): boolean
  /** A new password (no old one asked: this is the local board); ends every login. */
  setPassword(password: unknown): Promise<EditResult>
  /** A new TOTP secret, kept in memory for 10 minutes until confirmTotp; a new begin replaces it. */
  beginTotp(domain: string): { secret: string; uri: string }
  /** Saves the pending secret once `code` is one of its codes; ends every login. */
  confirmTotp(code: unknown): EditResult
  /** The password and the code, checked together; one answer for any failure. */
  signInPassword(body: { password?: unknown; code?: unknown }, who: Who): Promise<SignIn>
  /** The live login a token is; null for any other. */
  verify(token: string): Login | null
  end(id: string): boolean
  endAll(): void
  /** Signs a login out by its own token. */
  endToken(token: string): boolean
  /** Calls `gone` once the login ends or expires; returns the unwatch. */
  watch(id: string, gone: () => void): () => void
  liftLockout(): void
  rate(kind: 'open' | 'password' | 'passkey', address: string): { ok: true } | { ok: false; retryAfterS: number }
  /** For the local panel: never a hash, a secret or a token's hash. */
  view(): AccessView['login'] & Pick<AccessView, 'logins' | 'attempts'>
  /** A new sign-in challenge for any passkey of `rpId` (discoverable: none is named). */
  passkeyLoginOptions(rpId: string): { challenge: string; rpId: string; timeout: number; userVerification: 'required' }
  /** Never locked out; any failure is 401 'wrong'. Rate: rate('passkey', …), taken here. */
  signInPasskey(body: unknown, expect: { origin: string; rpId: string }, who: Who): Promise<SignIn>
  /** A fresh TOTP code (later than the last used step), for the login asking. */
  passkeyAddOptions(
    loginId: string,
    code: unknown,
    rp: { id: string },
  ): { ok: true; options: CreationOptions } | { ok: false; status: 403; error: 'code' }
  /** The passkey made on one of `loginId`'s add challenges; `error` says why not, in a word. */
  addPasskey(
    loginId: string,
    body: unknown,
    expect: { origin: string; rpId: string },
    userAgent: string | null,
  ): { ok: true; id: string } | { ok: false; error: string }
  /** Ends the logins made with it; whether it was there. */
  removePasskey(id: string): boolean
  /** Removes every passkey (they belong to the old domain) and ends every login. */
  domainChanged(): void
  hasPasskeysOrLogins(): boolean
}

export interface AccessOptions {
  /** Called after every change the panel could show. */
  onChange: () => void
  now?: () => number
  random?: (n: number) => Uint8Array
  /** Runs `fn` once after `ms`; returns its cancel. */
  setTimer?: (fn: () => void, ms: number) => () => void
  /** A line for the board's log (web.log): a failed sign-in that could not be recorded. */
  log?: (text: string) => void
}

function realTimer(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms)
  // a login's expiry never keeps the process up
  timer.unref()
  return () => clearTimeout(timer)
}

const publicLogin = (l: Login): PublicLogin => ({
  id: l.id,
  method: l.method,
  ...(l.passkeyId === undefined ? {} : { passkeyId: l.passkeyId }),
  label: l.label,
  address: l.address,
  signedInAt: l.signedInAt,
  expiresAt: l.expiresAt,
  seenAt: l.seenAt,
})

/** Whether `password` is the one `hash` was made of. Not a string, too long, or no hash: no, without hashing. */
async function passwordMatches(password: unknown, hash: string | null): Promise<boolean> {
  if (typeof password !== 'string' || !password || password.length > PASSWORD_MAX || hash === null) return false
  try {
    return await Bun.password.verify(password, hash)
  } catch {
    return false // a hash edited by hand into something argon2 cannot read
  }
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** The credential as the page sends it, { id, rawId, type, response } (base64url); rawId and type may be left out. */
function credentialOf(body: unknown): { id: string; response: Record<string, unknown> } | null {
  if (!isRecord(body) || !isText(body.id) || !isRecord(body.response)) return null
  if (body.rawId !== undefined && body.rawId !== body.id) return null
  if (body.type !== undefined && body.type !== 'public-key') return null
  return { id: body.id, response: body.response }
}

/** A passkey sign-in (navigator.credentials.get) as core/webauthn.ts checks it; null for any other shape. */
function assertionOf(body: unknown): Parameters<typeof verifyAssertion>[0] | null {
  const c = credentialOf(body)
  if (!c) return null
  const { clientDataJSON, authenticatorData, signature, userHandle } = c.response
  if (!isText(clientDataJSON) || !isText(authenticatorData) || !isText(signature)) return null
  if (userHandle != null && typeof userHandle !== 'string') return null
  return { id: c.id, clientDataJSON, authenticatorData, signature, userHandle: userHandle ?? null }
}

/** A passkey made (navigator.credentials.create) as core/webauthn.ts checks it, with its known transports; null for any other shape. */
function registrationOf(
  body: unknown,
): { id: string; clientDataJSON: string; attestationObject: string; transports: string[] } | null {
  const c = credentialOf(body)
  if (!c) return null
  const { clientDataJSON, attestationObject, transports } = c.response
  if (!isText(clientDataJSON) || !isText(attestationObject)) return null
  const known = Array.isArray(transports)
    ? transports.filter((x): x is string => typeof x === 'string' && TRANSPORTS.has(x))
    : []
  return { id: c.id, clientDataJSON, attestationObject, transports: [...new Set(known)] }
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The challenge a credential's client data carries; null when there is none to read. */
function challengeOf(clientDataJSON: string): string | null {
  const bytes = b64url.decode(clientDataJSON)
  if (!bytes) return null
  try {
    const data: unknown = JSON.parse(utf8.decode(bytes))
    return isRecord(data) && typeof data.challenge === 'string' ? data.challenge : null
  } catch {
    return null
  }
}

/** A user id the page can turn into bytes: base64url of 1 to 64 bytes. */
function usableUserId(id: string | null): id is string {
  const bytes = id === null ? null : b64url.decode(id)
  return !!bytes && bytes.length > 0 && bytes.length <= USER_ID_MAX
}

/** What a passkey challenge is for: signing in, or adding a passkey by one login. */
type Purpose = { kind: 'login' } | { kind: 'add'; loginId: string }

export function createAccess({
  onChange,
  now = Date.now,
  random = n => randomBytes(n),
  setTimer = realTimer,
  log = () => {},
}: AccessOptions): Access {
  const limits = {
    open: new RateLimiter(RATES.open),
    password: new RateLimiter(RATES.password),
    passkey: new RateLimiter(RATES.passkey),
  }
  /** Room to record a `limited` attempt: password sign-in's numbers, apart from its counters. */
  const limitedRows = new RateLimiter(RATES.password)
  let pendingTotp: { bytes: Uint8Array; at: number } | null = null
  const seen = new Map<string, number>()
  const watchers = new Map<string, Set<() => void>>()
  /** The passkey challenges waiting for their one use, oldest first, by their base64url. */
  const challenges = new Map<string, Purpose & { at: number }>()

  /** Tells the watchers of each ended login, once; its add challenges go. */
  function ended(ids: readonly string[]): void {
    for (const [challenge, p] of challenges)
      if (p.kind === 'add' && ids.includes(p.loginId)) challenges.delete(challenge)
    for (const id of ids) {
      seen.delete(id)
      const set = watchers.get(id)
      watchers.delete(id)
      for (const gone of set ?? []) gone()
    }
  }

  /** A new challenge for `purpose`; the expired go, and the oldest past the 50 kept. */
  function newChallenge(purpose: Purpose): string {
    const at = now()
    for (const [challenge, p] of challenges) if (at - p.at > CHALLENGE_MS) challenges.delete(challenge)
    const challenge = b64url.encode(random(CHALLENGE_BYTES))
    challenges.set(challenge, { ...purpose, at })
    for (const oldest of challenges.keys()) {
      if (challenges.size <= CHALLENGES_MAX) break
      challenges.delete(oldest)
    }
    return challenge
  }

  /**
   * The challenge a credential's client data carries, taken out of the waiting ones (used once,
   * whatever comes of it), when it is still live and `fits` what it was made for; else null.
   */
  function takeChallenge(clientDataJSON: string, fits: (p: Purpose) => boolean): string | null {
    const challenge = challengeOf(clientDataJSON)
    const pending = challenge === null ? undefined : challenges.get(challenge)
    if (challenge === null || pending === undefined) return null
    challenges.delete(challenge)
    return now() - pending.at <= CHALLENGE_MS && fits(pending) ? challenge : null
  }

  /** The step `code` is for in `s`'s TOTP, when later than the last one used; else null. */
  function freshStep(s: AccessSecrets, code: unknown, at: number): number | null {
    const secret = s.totp ? base32Bytes(s.totp.secret) : null
    return s.totp && secret ? totpMatch(secret, code, at, s.totp.lastStep) : null
  }

  /** The passkey a sign-in's body proves, its counter and use saved; null when it proves none. */
  function passkeySignedIn(body: unknown, e: { origin: string; rpId: string }): Passkey | null {
    const a = assertionOf(body)
    const challenge = a ? takeChallenge(a.clientDataJSON, p => p.kind === 'login') : null
    if (!a || challenge === null) return null
    const passkey = readPasskeys().find(p => p.id === a.id)
    if (!passkey) return null
    const { jwk, alg, counter } = passkey
    const userId = readSecrets().userId ?? ''
    const checked = verifyAssertion(a, { challenge, origin: e.origin, rpId: e.rpId }, { jwk, alg, counter, userId })
    if (!checked.ok) return null
    // No await since the read: no other sign-in has moved its counter meanwhile.
    const at = now()
    updatePasskeys(list => list.map(p => (p.id === passkey.id ? { ...p, counter: checked.counter, usedAt: at } : p)))
    return passkey
  }

  /** Ends the logins `which` picks (every one by default) and tells their watchers; returns their ids. */
  function endLogins(which: (l: Login) => boolean = () => true): string[] {
    if (!readLogins().some(which)) return []
    let ids: string[] = []
    updateLogins(list => {
      ids = list.filter(which).map(l => l.id)
      return list.filter(l => !which(l))
    })
    ended(ids)
    return ids
  }

  /** The logins on file; expired ones are dropped from it, and their watchers told. */
  function logins(): Login[] {
    const at = now()
    const list = readLogins()
    if (list.every(l => l.expiresAt > at)) return list
    endLogins(l => l.expiresAt <= at)
    onChange()
    return list.filter(l => l.expiresAt > at)
  }

  /** A new login for `who`, kept by its token's hash: the answer to a sign-in that passed. */
  function newLogin(method: LoginMethod, who: Who, passkeyId?: string): Extract<SignIn, { ok: true }> {
    const at = now()
    const token = Buffer.from(random(32)).toString('base64url')
    const login: Login = {
      id: Buffer.from(random(6)).toString('hex'),
      tokenHash: hashToken(token),
      method,
      ...(passkeyId === undefined ? {} : { passkeyId }),
      label: deviceLabel(who.userAgent),
      address: who.address,
      signedInAt: at,
      expiresAt: at + LOGIN_MS,
      seenAt: null,
    }
    updateLogins(list => [...list, login])
    return { ok: true, token, maxAgeS: Math.round((login.expiresAt - at) / 1000), login: publicLogin(login) }
  }

  /**
   * Records a failed sign-in; whether it did. A `limited` one only while `limitedRows` has room.
   * A file that cannot be written is logged, and the sign-in is refused all the same.
   */
  function failed(who: Who, method: LoginMethod, reason: AttemptReason): boolean {
    const at = now()
    if (reason === 'limited' && !limitedRows.take(who.address, at).ok) return false
    try {
      addAttempt({ at, address: who.address, label: deviceLabel(who.userAgent), method, reason })
      return true
    } catch (err) {
      log(`access: a failed sign-in was not recorded: ${messageOf(err)}`)
      return false
    }
  }

  /** 423 while the lockout holds; recorded, not counted. */
  function locked(who: Who, until: number): SignIn {
    if (failed(who, 'password', 'locked')) onChange()
    return { ok: false, status: 423, error: 'locked', until }
  }

  return {
    ready: accessReady,

    async setPassword(password) {
      const problem = passwordProblem(password)
      if (problem !== null || typeof password !== 'string')
        return { ok: false, error: problem ?? t('access.err.password') }
      if (password.length > PASSWORD_MAX)
        return { ok: false, error: t('access.err.passwordLong', { max: PASSWORD_MAX }) }
      const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })
      updateSecrets(s => ({ ...s, passwordHash }))
      endLogins()
      onChange()
      return { ok: true }
    },

    beginTotp(domain) {
      const bytes = random(TOTP_BYTES)
      pendingTotp = { bytes, at: now() }
      const secret = base32(bytes)
      return { secret, uri: totpUri(secret, domain) }
    },

    confirmTotp(code) {
      const pending = pendingTotp
      if (!pending || now() - pending.at > PENDING_TOTP_MS || pending.bytes.length !== TOTP_BYTES) {
        pendingTotp = null
        return { ok: false, error: t('access.err.noTotp') }
      }
      // A new secret: any of its codes is new.
      const step = totpMatch(pending.bytes, code, now(), -1)
      if (step === null) return { ok: false, error: t('access.err.code') }
      pendingTotp = null
      updateSecrets(s => ({ ...s, totp: { secret: base32(pending.bytes), lastStep: step } }))
      endLogins()
      onChange()
      return { ok: true }
    },

    async signInPassword(body, who) {
      const password = isRecord(body) ? body.password : undefined
      const code = isRecord(body) ? body.code : undefined
      const room = limits.password.take(who.address, now())
      if (!room.ok) {
        if (failed(who, 'password', 'limited')) onChange()
        return { ok: false, status: 429, error: 'limited', retryAfterS: room.retryAfterS }
      }
      const { passwordHash, lockout } = readSecrets()
      if (lockout.until !== null && lockout.until > now()) return locked(who, lockout.until)
      // The hash is checked whatever the code is, so the time taken never tells which was wrong.
      const passwordOk = await passwordMatches(password, passwordHash)
      const at = now()
      // What the check under the lock found (its callback sets it).
      const found: { passed: boolean; lockedUntil: number | null } = { passed: false, lockedUntil: null }
      // Under access.json's lock: the lockout again, which sign-ins at the same moment may have
      // set while this one's hash was checked (then refused uncounted, the right pair too); and
      // the code against the file, so a code a sign-in at the same moment used is used up here
      // too. A failed sign-in's code is not used up.
      updateSecrets(s => {
        if (s.lockout.until !== null && s.lockout.until > at) {
          found.lockedUntil = s.lockout.until
          return s
        }
        const secret = s.totp ? base32Bytes(s.totp.secret) : null
        const step = s.totp && secret ? totpMatch(secret, code, at, s.totp.lastStep) : null
        if (passwordOk && s.passwordHash === passwordHash && s.totp && step !== null) {
          found.passed = true
          return { ...s, totp: { ...s.totp, lastStep: step }, lockout: { failures: 0, until: null } }
        }
        const failures = s.lockout.failures + 1
        const wait = lockWaitMs(failures)
        return { ...s, lockout: { failures, until: wait ? at + wait : s.lockout.until } }
      })
      if (found.lockedUntil !== null) return locked(who, found.lockedUntil)
      if (!found.passed) {
        // the lockout's count changed, recorded or not
        failed(who, 'password', 'wrong')
        onChange()
        return { ok: false, status: 401, error: 'wrong' }
      }
      const answer = newLogin('password', who)
      onChange()
      return answer
    },

    verify(token) {
      if (typeof token !== 'string' || !token) return null
      const hash = hashToken(token)
      const login = logins().find(l => l.tokenHash === hash)
      if (!login) return null
      // Not onChange: when it was seen is bookkeeping, as for phones (services/remote.ts).
      const at = now()
      const last = seen.get(login.id) ?? login.seenAt ?? 0
      if (at - last <= SEEN_EVERY_MS) return login
      seen.set(login.id, at)
      updateLogins(list => list.map(l => (l.id === login.id ? { ...l, seenAt: at } : l)))
      return { ...login, seenAt: at }
    },

    end(id) {
      if (!endLogins(l => l.id === id).length) return false
      onChange()
      return true
    },

    endAll() {
      if (endLogins().length) onChange()
    },

    endToken(token) {
      if (typeof token !== 'string' || !token) return false
      const hash = hashToken(token)
      if (!endLogins(l => l.tokenHash === hash).length) return false
      onChange()
      return true
    },

    watch(id, gone) {
      const set = watchers.get(id) ?? new Set<() => void>()
      watchers.set(id, set)
      let cancel: (() => void) | null = null
      let done = false
      const stop = (): void => {
        done = true
        cancel?.()
        cancel = null
        set.delete(call)
        if (!set.size && watchers.get(id) === set) watchers.delete(id)
      }
      function call(): void {
        if (done) return
        stop()
        gone()
      }
      // Up to the login's expiry, in waits a timer can take; a login gone already is told on the
      // timer too, never before watch returns.
      const arm = (login: Login | undefined): void => {
        cancel = setTimer(check, login ? Math.min(Math.max(0, login.expiresAt - now()), TIMER_MAX_MS) : 0)
      }
      function check(): void {
        cancel = null
        if (done) return
        // drops the expired logins, so this one's watchers (this one too) are told there
        const login = logins().find(l => l.id === id)
        if (done) return
        if (login) arm(login)
        else call()
      }
      set.add(call)
      arm(readLogins().find(l => l.id === id && l.expiresAt > now()))
      return stop
    },

    liftLockout() {
      updateSecrets(s => ({ ...s, lockout: { failures: 0, until: null } }))
      onChange()
    },

    rate(kind, address) {
      return limits[kind].take(address, now())
    },

    view() {
      const s = readSecrets()
      const until = s.lockout.until
      return {
        password: s.passwordHash !== null,
        totp: s.totp !== null,
        passkeys: readPasskeys().map(p => ({ id: p.id, label: p.label, addedAt: p.addedAt, usedAt: p.usedAt })),
        lockout: until !== null && until > now() ? { until } : null,
        logins: logins().map(publicLogin),
        attempts: readAttempts()
          .slice(-ATTEMPTS_SHOWN)
          .reverse()
          .map(a => ({ at: a.at, address: a.address, label: a.label, method: a.method, reason: a.reason })),
      }
    },

    passkeyLoginOptions(rpId) {
      return { challenge: newChallenge({ kind: 'login' }), rpId, timeout: CHALLENGE_MS, userVerification: 'required' }
    },

    async signInPasskey(body, expect, who) {
      // Its own counters, never the password's; and never the lockout.
      const room = limits.passkey.take(who.address, now())
      if (!room.ok) {
        if (failed(who, 'passkey', 'limited')) onChange()
        return { ok: false, status: 429, error: 'limited', retryAfterS: room.retryAfterS }
      }
      const passkey = passkeySignedIn(body, expect)
      if (!passkey) {
        if (failed(who, 'passkey', 'wrong')) onChange()
        return { ok: false, status: 401, error: 'wrong' }
      }
      const answer = newLogin('passkey', who, passkey.id)
      onChange()
      return answer
    },

    passkeyAddOptions(loginId, code, rp) {
      const refused = { ok: false, status: 403, error: 'code' } as const
      const at = now()
      // A wrong code writes nothing. A right one is checked again under access.json's lock, and
      // used up there, so a sign-in or another add at the same moment cannot use it too.
      if (freshStep(readSecrets(), code, at) === null) return refused
      const found: { passed: boolean } = { passed: false }
      const saved = updateSecrets(s => {
        const step = freshStep(s, code, at)
        if (step === null || !s.totp) return s
        found.passed = true
        const userId = usableUserId(s.userId) ? s.userId : b64url.encode(random(USER_ID_BYTES))
        return { ...s, totp: { ...s.totp, lastStep: step }, userId }
      })
      if (!found.passed || saved.userId === null) return refused
      return {
        ok: true,
        options: {
          challenge: newChallenge({ kind: 'add', loginId }),
          rp: { id: rp.id, name: 'Agent board' },
          user: { id: saved.userId, name: 'owner', displayName: 'Agent board' },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
          attestation: 'none',
          excludeCredentials: readPasskeys().map(p => ({ type: 'public-key', id: p.id })),
          timeout: CHALLENGE_MS,
        },
      }
    },

    addPasskey(loginId, body, expect, userAgent) {
      const r = registrationOf(body)
      if (!r) return { ok: false, error: 'shape' }
      const challenge = takeChallenge(r.clientDataJSON, p => p.kind === 'add' && p.loginId === loginId)
      if (challenge === null) return { ok: false, error: 'challenge' }
      const checked = verifyRegistration(r, { challenge, origin: expect.origin, rpId: expect.rpId })
      if (!checked.ok) return { ok: false, error: checked.why }
      const { id, jwk, alg, counter } = checked.credential
      const idBytes = b64url.decode(id)?.length ?? 0
      if (id !== r.id || idBytes > CREDENTIAL_ID_MAX) return { ok: false, error: 'shape' }
      const passkey: Passkey = {
        id,
        jwk,
        alg,
        counter,
        transports: r.transports,
        label: deviceLabel(userAgent),
        addedAt: now(),
        usedAt: null,
      }
      const found: { added: boolean } = { added: false }
      updatePasskeys(list => {
        if (list.some(p => p.id === id)) return list
        found.added = true
        return [...list, passkey]
      })
      if (!found.added) return { ok: false, error: 'exists' }
      onChange()
      return { ok: true, id }
    },

    removePasskey(id) {
      if (typeof id !== 'string' || !id) return false
      const there = readPasskeys().some(p => p.id === id)
      if (there) updatePasskeys(list => list.filter(p => p.id !== id))
      const ids = endLogins(l => l.passkeyId === id)
      if (there || ids.length) onChange()
      return there
    },

    domainChanged() {
      challenges.clear()
      const had = readPasskeys().length > 0
      if (had) updatePasskeys(() => [])
      const ids = endLogins()
      if (had || ids.length) onChange()
    },

    hasPasskeysOrLogins() {
      return readPasskeys().length > 0 || logins().length > 0
    },
  }
}
