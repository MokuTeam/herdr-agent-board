import { expect, spyOn, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  accessFile,
  addAttempt,
  attemptsFile,
  loginsFile,
  passkeysFile,
  readAttempts,
  readLogins,
  readSecrets,
  updatePasskeys,
  updateSecrets,
} from '../../src/adapters/access-store.ts'
import { LOGIN_MS, type Passkey } from '../../src/core/access.ts'
import { TOTP_STEP_MS, totpCode, totpStep, totpUri } from '../../src/core/totp.ts'
import { type Access, createAccess, type SignIn, type Who } from '../../src/services/access.ts'
import { hashToken } from '../../src/services/remote.ts'
import { isolatedHome } from '../support/env.ts'

/** RFC 6238's SHA-1 test secret, and the same in base32. */
const RFC = new TextEncoder().encode('12345678901234567890')
const SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const PASSWORD = 'correct horse battery'
const DOMAIN = 'board.example.com'
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const phone: Who = { address: '203.0.113.9', userAgent: IPHONE }
const other: Who = { address: '203.0.113.10', userAgent: null }
const WRONG: SignIn = { ok: false, status: 401, error: 'wrong' }
const MAX_TIMER = 2_147_483_647

interface Timer {
  fn: () => void
  ms: number
  live: boolean
}

/** As a real timer does: it fires once, and is spent. */
function fire(timer: Timer | undefined): void {
  if (!timer) throw new Error('no timer')
  timer.live = false
  timer.fn()
}

function setup({ random }: { random?: (n: number) => Uint8Array } = {}) {
  isolatedHome()
  // On a whole minute, so a step starts there.
  let clock = Date.UTC(2026, 9, 20, 12, 0, 0)
  let changes = 0
  const timers: Timer[] = []
  const access: Access = createAccess({
    onChange: () => changes++,
    now: () => clock,
    random: random ?? (n => (n === 20 ? RFC : new Uint8Array(randomBytes(n)))),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    },
  })
  const code = (at = clock): string => totpCode(RFC, totpStep(at))
  const signIn = (body: { password?: unknown; code?: unknown }, who: Who = phone): Promise<SignIn> =>
    access.signInPassword(body, who)
  /** Password and TOTP set up; the clock then moves to the next step, so its code is unused. */
  async function ready(): Promise<void> {
    expect(await access.setPassword(PASSWORD)).toEqual({ ok: true })
    access.beginTotp(DOMAIN)
    expect(access.confirmTotp(code())).toEqual({ ok: true })
    clock += TOTP_STEP_MS
  }
  /** A password + code sign-in in a step of its own. */
  async function signedIn(who: Who = phone): Promise<Extract<SignIn, { ok: true }>> {
    clock += TOTP_STEP_MS
    const r = await signIn({ password: PASSWORD, code: code() }, who)
    if (!r.ok) throw new Error(`refused: ${r.error}`)
    return r
  }
  return {
    access,
    timers,
    code,
    signIn,
    ready,
    signedIn,
    now: () => clock,
    tick: (ms: number) => (clock += ms),
    changes: () => changes,
  }
}

test('not ready until both are set up; the password has 12 characters or more and only its hash is kept', async () => {
  const s = setup()
  expect(s.access.ready()).toBe(false)
  const short = { ok: false, error: 'A password has at least 12 characters' }
  expect(await s.access.setPassword('x'.repeat(11))).toEqual(short)
  expect(await s.access.setPassword(123456789012)).toEqual(short)
  expect(await s.access.setPassword('x'.repeat(1025))).toEqual({
    ok: false,
    error: 'A password has at most 1024 characters',
  })
  expect(readSecrets().passwordHash).toBeNull()
  expect(s.changes()).toBe(0)
  expect(await s.access.setPassword(PASSWORD)).toEqual({ ok: true })
  expect(readSecrets().passwordHash).toStartWith('$argon2id$')
  expect(s.access.ready()).toBe(false)
  expect(s.access.beginTotp(DOMAIN)).toEqual({ secret: SECRET_B32, uri: totpUri(SECRET_B32, DOMAIN) })
  expect(s.access.ready()).toBe(false)
  expect(s.access.confirmTotp(s.code())).toEqual({ ok: true })
  expect(s.access.ready()).toBe(true)
})

test('the password and the TOTP secret are in no file or view but the secret in access.json', async () => {
  const s = setup()
  await s.ready()
  const r = await s.signedIn()
  expect(await s.signIn({ password: `${PASSWORD}!`, code: s.code() })).toEqual(WRONG)
  const passkey: Passkey = {
    id: 'cred-1',
    jwk: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
    alg: -7,
    counter: 0,
    transports: ['internal'],
    label: 'Safari on iPhone',
    addedAt: s.now(),
    usedAt: null,
  }
  updatePasskeys(() => [passkey])
  for (const file of [accessFile(), loginsFile(), passkeysFile(), attemptsFile()]) {
    const text = readFileSync(file, 'utf8')
    expect([file, text.includes(PASSWORD), text.includes(r.token)]).toEqual([file, false, false])
    expect([file, text.includes(SECRET_B32)]).toEqual([file, file === accessFile()])
  }
  expect(readSecrets().totp?.secret).toBe(SECRET_B32)
  const view = s.access.view()
  const text = JSON.stringify(view)
  for (const secret of [
    PASSWORD,
    SECRET_B32,
    readSecrets().passwordHash ?? '?',
    r.token,
    hashToken(r.token),
    'public-x',
  ])
    expect([secret, text.includes(secret)]).toEqual([secret, false])
  expect(text).not.toContain('tokenHash')
  expect(view).toEqual({
    password: true,
    totp: true,
    passkeys: [{ id: 'cred-1', label: 'Safari on iPhone', addedAt: s.now(), usedAt: null }],
    lockout: null,
    logins: [r.login],
    attempts: [{ at: s.now(), address: '203.0.113.9', label: 'Safari on iPhone', method: 'password', reason: 'wrong' }],
  })
})

test('the view shows the 20 newest failed attempts, newest first', () => {
  const s = setup()
  for (let at = 1; at <= 25; at++)
    addAttempt({ at, address: '203.0.113.9', label: 'A browser', method: 'password', reason: 'wrong' })
  const attempts = s.access.view().attempts
  expect(attempts.map(a => a.at)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i))
})

test('TOTP is saved only after a right code, and waits 10 minutes for it', () => {
  const s = setup()
  const noTotp = { ok: false, error: 'Set up the code first: it expired, or was never asked for' }
  const badCode = { ok: false, error: 'That code is not the one the app shows now' }
  expect(s.access.confirmTotp(s.code())).toEqual(noTotp)
  s.access.beginTotp(DOMAIN)
  const later = s.code(s.now() + 10 * TOTP_STEP_MS)
  expect(later).not.toBe(s.code())
  expect(s.access.confirmTotp(later)).toEqual(badCode)
  expect(s.access.confirmTotp('12345')).toEqual(badCode)
  expect(s.access.confirmTotp(null)).toEqual(badCode)
  expect(readSecrets().totp).toBeNull()
  expect(s.changes()).toBe(0)
  // A wrong code leaves the pending secret: the right one still works.
  expect(s.access.confirmTotp(s.code())).toEqual({ ok: true })
  expect(readSecrets().totp).toEqual({ secret: SECRET_B32, lastStep: totpStep(s.now()) })
  expect(s.changes()).toBe(1)
  // It went with that.
  expect(s.access.confirmTotp(s.code())).toEqual(noTotp)

  s.access.beginTotp(DOMAIN)
  s.tick(10 * 60_000 + 1)
  expect(s.access.confirmTotp(s.code())).toEqual(noTotp)
  // A new begin replaces the one before, and its 10 minutes start again.
  s.access.beginTotp(DOMAIN)
  s.tick(9 * 60_000)
  s.access.beginTotp(DOMAIN)
  s.tick(9 * 60_000)
  expect(s.access.confirmTotp(s.code())).toEqual({ ok: true })
})

test('a TOTP secret that is not 20 bytes is refused, pending or stored', async () => {
  const s = setup({ random: n => new Uint8Array(randomBytes(n === 20 ? 19 : n)) })
  s.access.beginTotp(DOMAIN)
  expect(s.access.confirmTotp(s.code())).toEqual({
    ok: false,
    error: 'Set up the code first: it expired, or was never asked for',
  })
  expect(await s.access.setPassword(PASSWORD)).toEqual({ ok: true })
  updateSecrets(x => ({ ...x, totp: { secret: SECRET_B32, lastStep: 0 } }))
  expect(s.access.ready()).toBe(true)
  // By hand: a secret of 5 bytes.
  const raw = JSON.parse(readFileSync(accessFile(), 'utf8'))
  writeFileSync(accessFile(), JSON.stringify({ ...raw, totp: { secret: 'GEZDGNBV', lastStep: 0 } }))
  expect(s.access.ready()).toBe(false)
  expect(s.access.view().totp).toBe(false)
  const code = totpCode(new TextEncoder().encode('12345'), totpStep(s.now()))
  expect(await s.signIn({ password: PASSWORD, code })).toEqual(WRONG)
})

test('a sign-in: a 43-character token whose hash only is kept, for 30 days, labelled from the User-Agent', async () => {
  const s = setup()
  await s.ready()
  const r = await s.signedIn()
  expect(r.token).toMatch(/^[\w-]{43}$/)
  expect(r.maxAgeS).toBe(2592000)
  expect(r.login).toEqual({
    id: expect.any(String),
    method: 'password',
    label: 'Safari on iPhone',
    address: '203.0.113.9',
    signedInAt: s.now(),
    expiresAt: s.now() + LOGIN_MS,
    seenAt: null,
  })
  const saved = readFileSync(loginsFile(), 'utf8')
  expect(saved).toContain(hashToken(r.token))
  expect(saved).not.toContain(r.token)
  expect(readLogins()).toEqual([{ ...r.login, tokenHash: hashToken(r.token) }])
  expect(readSecrets().totp?.lastStep).toBe(totpStep(s.now()))
  expect(s.access.verify(r.token)?.id).toBe(r.login.id)
  expect(s.access.verify('x'.repeat(43))).toBeNull()
  expect(s.access.verify('')).toBeNull()
  // From another address, with no User-Agent.
  const again = await s.signedIn(other)
  expect([again.login.address, again.login.label]).toEqual(['203.0.113.10', 'A browser'])
})

test('a wrong password or a wrong code: one answer; the hash is checked either way; a failed code is not used up', async () => {
  const s = setup()
  await s.ready()
  const code = s.code()
  const wrongCode = s.code(s.now() + 10 * TOTP_STEP_MS)
  expect(wrongCode).not.toBe(code)
  const verify = spyOn(Bun.password, 'verify')
  try {
    expect(await s.signIn({ password: 'not the password', code })).toEqual(WRONG)
    expect(await s.signIn({ password: PASSWORD, code: wrongCode })).toEqual(WRONG)
    expect(verify).toHaveBeenCalledTimes(2)
    expect(await s.signIn({})).toEqual(WRONG)
    // Too long to be the password: refused without hashing it.
    expect(await s.signIn({ password: 'x'.repeat(1025), code })).toEqual(WRONG)
    expect(verify).toHaveBeenCalledTimes(2)
  } finally {
    verify.mockRestore()
  }
  // The code the failed sign-ins carried still works once.
  const r = await s.signIn({ password: PASSWORD, code })
  expect(r.ok).toBe(true)
  expect(await s.signIn({ password: PASSWORD, code })).toEqual(WRONG)
  expect(readAttempts().map(a => [a.method, a.reason, a.address, a.label])).toEqual(
    Array(5).fill(['password', 'wrong', '203.0.113.9', 'Safari on iPhone']),
  )
})

test('two sign-ins at once with one code: one gets in, the other is a replay', async () => {
  const s = setup()
  await s.ready()
  const body = { password: PASSWORD, code: s.code() }
  const answers = await Promise.all([s.signIn(body), s.signIn(body, other)])
  expect(answers.map(a => a.ok).sort()).toEqual([false, true])
  expect(answers.find(a => !a.ok)).toEqual(WRONG)
  expect(readLogins()).toHaveLength(1)
})

test('a login ends 30 days after its sign-in; when it was seen is written at most once a minute', async () => {
  const s = setup()
  await s.ready()
  const r = await s.signedIn()
  const seen = (): number | null | undefined => readLogins()[0]?.seenAt
  expect(seen()).toBeNull()
  expect(s.access.verify(r.token)?.seenAt).toBe(s.now())
  const first = s.now()
  expect(seen()).toBe(first)
  s.tick(30_000)
  s.access.verify(r.token)
  expect(seen()).toBe(first)
  s.tick(31_000)
  s.access.verify(r.token)
  expect(seen()).toBe(s.now())
  s.tick(r.login.expiresAt - s.now() - 1)
  expect(s.access.verify(r.token)).not.toBeNull()
  const before = s.changes()
  s.tick(2)
  expect(s.access.verify(r.token)).toBeNull()
  expect(readLogins()).toEqual([])
  expect(s.changes()).toBe(before + 1)
})

test('5 failures in a row lock sign-in for a minute, each one more doubles it up to an hour', async () => {
  const s = setup()
  await s.ready()
  const bad = (): Promise<SignIn> => s.signIn({ password: 'not the password', code: s.code() })
  for (let i = 0; i < 4; i++) expect(await bad()).toEqual(WRONG)
  expect(readSecrets().lockout).toEqual({ failures: 4, until: null })
  expect(s.access.view().lockout).toBeNull()
  expect(await bad()).toEqual(WRONG)
  const until = s.now() + 60_000
  expect(readSecrets().lockout).toEqual({ failures: 5, until })
  expect(s.access.view().lockout).toEqual({ until })
  const locked: SignIn = { ok: false, status: 423, error: 'locked', until }
  expect(await bad()).toEqual(locked)
  // The right pair too: locked is locked.
  expect(await s.signIn({ password: PASSWORD, code: s.code() })).toEqual(locked)
  expect(readAttempts().map(a => a.reason)).toEqual(['wrong', 'wrong', 'wrong', 'wrong', 'wrong', 'locked', 'locked'])
  expect(readSecrets().lockout.failures).toBe(5)

  s.tick(61_000)
  expect(await bad()).toEqual(WRONG)
  expect(readSecrets().lockout).toEqual({ failures: 6, until: s.now() + 120_000 })
  s.tick(121_000)
  expect((await s.signIn({ password: PASSWORD, code: s.code() })).ok).toBe(true)
  expect(readSecrets().lockout).toEqual({ failures: 0, until: null })

  updateSecrets(x => ({ ...x, lockout: { failures: 20, until: null } }))
  expect(await bad()).toEqual(WRONG)
  expect(readSecrets().lockout).toEqual({ failures: 21, until: s.now() + 3_600_000 })
  const before = s.changes()
  s.access.liftLockout()
  expect(s.changes()).toBe(before + 1)
  expect(readSecrets().lockout).toEqual({ failures: 0, until: null })
  expect(s.access.view().lockout).toBeNull()
  expect((await s.signedIn()).ok).toBe(true)
})

test('10 password sign-ins a minute from one address; the 11th is limited, others and passkeys go on', async () => {
  const s = setup()
  await s.ready()
  const statuses: number[] = []
  for (let i = 0; i < 10; i++) {
    const r = await s.signIn({ password: 'not the password', code: s.code() })
    statuses.push(r.ok ? 200 : r.status)
  }
  expect(statuses).toEqual([401, 401, 401, 401, 401, 423, 423, 423, 423, 423])
  expect(await s.signIn({ password: PASSWORD, code: s.code() })).toEqual({
    ok: false,
    status: 429,
    error: 'limited',
    retryAfterS: 60,
  })
  expect(readAttempts().at(-1)).toEqual({
    at: s.now(),
    address: '203.0.113.9',
    label: 'Safari on iPhone',
    method: 'password',
    reason: 'limited',
  })
  // Another address is past the limit's check (and meets the board's lockout).
  expect(await s.signIn({ password: PASSWORD, code: s.code() }, other)).toMatchObject({ status: 423 })
  expect(s.access.rate('password', phone.address)).toEqual({ ok: false, retryAfterS: 60 })
  expect(s.access.rate('passkey', phone.address)).toEqual({ ok: true })
  expect(s.access.rate('open', phone.address)).toEqual({ ok: true })
  s.tick(60_000)
  expect(s.access.rate('password', phone.address)).toEqual({ ok: true })
})

test('ending logins: one, by its token, all, a new password and a new TOTP; watchers hear it once', async () => {
  const s = setup()
  await s.ready()
  const gone: string[] = []
  const signedIn = async (name: string) => {
    const r = await s.signedIn()
    s.access.watch(r.login.id, () => gone.push(name))
    return r
  }
  const a = await signedIn('a')
  const b = await signedIn('b')
  const unwatch = s.access.watch(b.login.id, () => gone.push('never'))
  unwatch()
  let before = s.changes()
  expect(s.access.end(a.login.id)).toBe(true)
  expect(s.changes()).toBe(before + 1)
  expect(gone).toEqual(['a'])
  expect(s.access.verify(a.token)).toBeNull()
  expect(s.access.verify(b.token)).not.toBeNull()
  expect(s.access.end(a.login.id)).toBe(false)

  before = s.changes()
  expect(s.access.endToken(b.token)).toBe(true)
  expect(s.changes()).toBe(before + 1)
  expect(gone).toEqual(['a', 'b'])
  expect(s.access.verify(b.token)).toBeNull()
  expect(s.access.endToken(b.token)).toBe(false)
  expect(s.access.endToken('')).toBe(false)

  const c = await signedIn('c')
  const d = await signedIn('d')
  before = s.changes()
  s.access.endAll()
  expect(s.changes()).toBe(before + 1)
  expect(gone).toEqual(['a', 'b', 'c', 'd'])
  expect([s.access.verify(c.token), s.access.verify(d.token)]).toEqual([null, null])

  const e = await signedIn('e')
  expect(await s.access.setPassword('another long password')).toEqual({ ok: true })
  expect(gone).toEqual(['a', 'b', 'c', 'd', 'e'])
  expect(s.access.verify(e.token)).toBeNull()

  s.tick(TOTP_STEP_MS)
  const f = await s.signIn({ password: 'another long password', code: s.code() })
  if (!f.ok) throw new Error(f.error)
  s.access.watch(f.login.id, () => gone.push('f'))
  s.access.beginTotp(DOMAIN)
  expect(s.access.confirmTotp(s.code())).toEqual({ ok: true })
  expect(gone).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  expect(s.access.verify(f.token)).toBeNull()
  expect(readLogins()).toEqual([])
  // Every watcher's expiry timer went with it.
  expect(s.timers.filter(t => t.live)).toEqual([])
})

test("a watched login's expiry ends it: gone is called once, and verify gives null", async () => {
  const s = setup()
  await s.ready()
  const r = await s.signedIn()
  let gone = 0
  s.access.watch(r.login.id, () => gone++)
  // 30 days does not fit a timer: it is re-armed until the login expires.
  const first = s.timers.at(-1)
  expect(first?.ms).toBe(MAX_TIMER)
  s.tick(MAX_TIMER)
  fire(first)
  expect(gone).toBe(0)
  const second = s.timers.at(-1)
  expect(second?.ms).toBe(LOGIN_MS - MAX_TIMER)
  s.tick(LOGIN_MS - MAX_TIMER)
  fire(second)
  expect(gone).toBe(1)
  expect(s.access.verify(r.token)).toBeNull()
  expect(readLogins()).toEqual([])
  second?.fn()
  expect(gone).toBe(1)
  expect(s.timers.filter(t => t.live)).toEqual([])

  // A login already gone when it is watched: gone comes on the next timer, not at once.
  let late = 0
  const stop = s.access.watch(r.login.id, () => late++)
  expect(late).toBe(0)
  const timer = s.timers.at(-1)
  expect(timer?.ms).toBe(0)
  fire(timer)
  expect(late).toBe(1)
  stop()
  // The unwatch clears the timer.
  const live = await s.signedIn()
  const unwatch = s.access.watch(live.login.id, () => late++)
  const armed = s.timers.at(-1)
  expect(armed?.live).toBe(true)
  unwatch()
  expect(armed?.live).toBe(false)
  expect(late).toBe(1)
})

test('every change calls onChange; a refusal that changes nothing does not', async () => {
  const s = setup()
  const changed = async (what: string, act: () => unknown, expected = true): Promise<void> => {
    const before = s.changes()
    await act()
    expect([what, s.changes() > before]).toEqual([what, expected])
  }
  await changed('short password', () => s.access.setPassword('short'), false)
  await changed('password', () => s.access.setPassword(PASSWORD))
  await changed('begin TOTP', () => s.access.beginTotp(DOMAIN), false)
  await changed('wrong TOTP code', () => s.access.confirmTotp('12345'), false)
  await changed('TOTP', () => s.access.confirmTotp(s.code()))
  s.tick(TOTP_STEP_MS)
  let token = ''
  await changed('sign-in', async () => {
    const r = await s.signIn({ password: PASSWORD, code: s.code() })
    if (r.ok) token = r.token
  })
  await changed('failed sign-in', () => s.signIn({ password: 'not the password', code: s.code() }))
  updateSecrets(x => ({ ...x, lockout: { failures: 5, until: s.now() + 60_000 } }))
  await changed('locked', () => s.signIn({ password: PASSWORD, code: s.code() }))
  await changed('lift lockout', () => s.access.liftLockout())
  await changed('sign out', () => s.access.endToken(token))
  await changed('end nothing', () => s.access.end('nope'), false)
  for (let i = 0; i < 10; i++) await s.signIn({ password: 'not the password', code: s.code() }, other)
  await changed('limited', () => s.signIn({ password: PASSWORD, code: s.code() }, other))
})
