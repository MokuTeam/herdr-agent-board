import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { accessFile, readAttempts, readLogins, readPasskeys, readSecrets } from '../../src/adapters/access-store.ts'
import { LOGIN_MS } from '../../src/core/access.ts'
import { TOTP_STEP_MS, totpCode, totpStep } from '../../src/core/totp.ts'
import { b64url } from '../../src/core/webauthn.ts'
import { type Access, type CreationOptions, createAccess, type SignIn, type Who } from '../../src/services/access.ts'
import { isolatedHome } from '../support/env.ts'
import { type SoftAuthenticator, softAuthenticator } from '../support/soft-authenticator.ts'

/** RFC 6238's SHA-1 test secret. */
const RFC = new TextEncoder().encode('12345678901234567890')
const PASSWORD = 'correct horse battery'
const RP = { origin: 'https://board.example.com', rpId: 'board.example.com' }
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const phone: Who = { address: '203.0.113.9', userAgent: IPHONE }
const other: Who = { address: '203.0.113.10', userAgent: null }
const WRONG: SignIn = { ok: false, status: 401, error: 'wrong' }
const CODE = { ok: false, status: 403, error: 'code' } as const
const CHALLENGE_MS = 2 * 60_000

type Assert = Parameters<SoftAuthenticator['assert']>[0]

/** As the page sends a credential: the authenticator's JSON with its `type`. */
const page = <T extends object>(credential: T): T & { type: 'public-key' } => ({ ...credential, type: 'public-key' })

function setup() {
  isolatedHome()
  // On a whole minute, so a step starts there.
  let clock = Date.UTC(2026, 9, 20, 12, 0, 0)
  let changes = 0
  const make = (): Access =>
    createAccess({
      onChange: () => changes++,
      now: () => clock,
      random: n => (n === 20 ? RFC : new Uint8Array(randomBytes(n))),
      setTimer: () => () => {},
    })
  const access = make()
  const code = (at = clock): string => totpCode(RFC, totpStep(at))
  const tick = (ms: number): number => (clock += ms)
  /** Password and TOTP set up; the clock then moves to the next step, so its code is unused. */
  async function ready(): Promise<void> {
    expect(await access.setPassword(PASSWORD)).toEqual({ ok: true })
    access.beginTotp(RP.rpId)
    expect(access.confirmTotp(code())).toEqual({ ok: true })
    tick(TOTP_STEP_MS)
  }
  /** A password + code sign-in in a step of its own. */
  async function signedIn(who: Who = phone): Promise<Extract<SignIn, { ok: true }>> {
    tick(TOTP_STEP_MS)
    const r = await access.signInPassword({ password: PASSWORD, code: code() }, who)
    if (!r.ok) throw new Error(`refused: ${r.error}`)
    return r
  }
  /** The options to add a passkey for `loginId`, with the next step's code (the clock moves to it). */
  function addOptions(loginId: string): CreationOptions {
    tick(TOTP_STEP_MS)
    const r = access.passkeyAddOptions(loginId, code(), { id: RP.rpId })
    if (!r.ok) throw new Error(`refused: ${r.error}`)
    return r.options
  }
  /** `auth`'s passkey added by `loginId`. */
  function add(auth: SoftAuthenticator, loginId: string, userAgent: string | null = IPHONE) {
    const { challenge } = addOptions(loginId)
    return access.addPasskey(loginId, page(auth.register({ challenge, ...RP })), RP, userAgent)
  }
  /** A passkey sign-in with `auth` on a new challenge; `o` changes what the authenticator signs. */
  function passkeyIn(auth: SoftAuthenticator, o: Partial<Assert> = {}, who: Who = phone): Promise<SignIn> {
    const { challenge } = access.passkeyLoginOptions(RP.rpId)
    return access.signInPasskey(page(auth.assert({ challenge, ...RP, ...o })), RP, who)
  }
  return {
    access,
    make,
    code,
    tick,
    ready,
    signedIn,
    addOptions,
    add,
    passkeyIn,
    now: () => clock,
    changes: () => changes,
  }
}

test('adding a passkey asks for a later code than the sign-in used; its options; listed; the next add excludes it', async () => {
  const s = setup()
  await s.ready()
  const auth = await softAuthenticator(-7)
  const r = await s.signedIn()
  const rp = { id: RP.rpId }
  // The code just used to sign in, and codes that are none.
  expect(s.access.passkeyAddOptions(r.login.id, s.code(), rp)).toEqual(CODE)
  expect(s.access.passkeyAddOptions(r.login.id, '12345', rp)).toEqual(CODE)
  expect(s.access.passkeyAddOptions(r.login.id, null, rp)).toEqual(CODE)
  expect(readSecrets().userId).toBeNull()

  s.tick(TOTP_STEP_MS)
  const changes = s.changes()
  const answer = s.access.passkeyAddOptions(r.login.id, s.code(), rp)
  if (!answer.ok) throw new Error('refused')
  const userId = readSecrets().userId
  expect(b64url.decode(userId ?? '')?.length).toBe(16)
  expect(answer.options).toEqual({
    challenge: expect.stringMatching(/^[\w-]{43}$/),
    rp: { id: 'board.example.com', name: 'Agent board' },
    user: { id: userId ?? '?', name: 'owner', displayName: 'Agent board' },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
    excludeCredentials: [],
    timeout: 120000,
  })
  // That code is used up.
  expect(readSecrets().totp?.lastStep).toBe(totpStep(s.now()))
  expect(s.access.passkeyAddOptions(r.login.id, s.code(), rp)).toEqual(CODE)
  expect(s.changes()).toBe(changes)

  const registration = auth.register({ challenge: answer.options.challenge, ...RP })
  const body = page({ ...registration, response: { ...registration.response, transports: ['internal', 'hybrid'] } })
  expect(s.access.addPasskey(r.login.id, body, RP, IPHONE)).toEqual({ ok: true, id: auth.id })
  expect(s.changes()).toBe(changes + 1)
  expect(s.access.view().passkeys).toEqual([{ id: auth.id, label: 'Safari on iPhone', addedAt: s.now(), usedAt: null }])
  expect(readPasskeys()).toEqual([
    {
      id: auth.id,
      jwk: { kty: 'EC', crv: 'P-256', x: expect.any(String), y: expect.any(String) },
      alg: -7,
      counter: 0,
      transports: ['internal', 'hybrid'],
      label: 'Safari on iPhone',
      addedAt: s.now(),
      usedAt: null,
    },
  ])

  const second = s.addOptions(r.login.id)
  expect(second.excludeCredentials).toEqual([{ type: 'public-key', id: auth.id }])
  expect(second.user.id).toBe(userId ?? '?')
  // The same authenticator again: not twice.
  const again = s.access.addPasskey(r.login.id, page(auth.register({ challenge: second.challenge, ...RP })), RP, null)
  expect(again).toEqual({ ok: false, error: 'exists' })
  expect(readPasskeys()).toHaveLength(1)
})

test('a code used to ask for add options does not sign in after', async () => {
  const s = setup()
  await s.ready()
  const r = await s.signedIn()
  s.addOptions(r.login.id)
  expect(await s.access.signInPassword({ password: PASSWORD, code: s.code() }, phone)).toEqual(WRONG)
})

test('a registration that does not check out is refused, and nothing is kept', async () => {
  const s = setup()
  await s.ready()
  const r = await s.signedIn()
  const auth = await softAuthenticator(-7)
  const tries: [string, (challenge: string) => unknown, string][] = [
    ['origin', c => page(auth.register({ challenge: c, ...RP, origin: 'https://evil.example' })), 'origin'],
    ['rpId', c => page(auth.register({ challenge: c, ...RP, rpId: 'evil.example' })), 'rpId'],
    ['no verification', c => page(auth.register({ challenge: c, ...RP, uv: false })), 'verification'],
    ['a sign-in', c => page(auth.register({ challenge: c, ...RP, type: 'webauthn.get' })), 'type'],
    ['another type', c => ({ ...auth.register({ challenge: c, ...RP }), type: 'password' }), 'shape'],
    ['another id', c => page({ ...auth.register({ challenge: c, ...RP }), id: 'AAAA', rawId: 'AAAA' }), 'shape'],
    ['rawId apart from id', c => page({ ...auth.register({ challenge: c, ...RP }), rawId: 'AAAA' }), 'shape'],
    ['no response', () => page({ id: auth.id, rawId: auth.id }), 'shape'],
    ['not an object', () => 'credential', 'shape'],
  ]
  for (const [what, body, error] of tries) {
    const { challenge } = s.addOptions(r.login.id)
    expect([what, s.access.addPasskey(r.login.id, body(challenge), RP, IPHONE)]).toEqual([what, { ok: false, error }])
  }
  const ed25519 = await softAuthenticator(-8)
  const { challenge } = s.addOptions(r.login.id)
  expect(s.access.addPasskey(r.login.id, page(ed25519.register({ challenge, ...RP })), RP, IPHONE)).toEqual({
    ok: false,
    error: 'algorithm',
  })
  expect(readPasskeys()).toEqual([])
})

test('only known transports are kept', async () => {
  const s = setup()
  await s.ready()
  const r = await s.signedIn()
  const auth = await softAuthenticator(-7)
  const { challenge } = s.addOptions(r.login.id)
  const registration = auth.register({ challenge, ...RP })
  const transports = ['usb', 5, 'x'.repeat(40), 'Hybrid', 'nfc']
  const body = page({ ...registration, response: { ...registration.response, transports } })
  expect(s.access.addPasskey(r.login.id, body, RP, null)).toEqual({ ok: true, id: auth.id })
  expect(readPasskeys()[0]?.transports).toEqual(['usb', 'nfc'])
})

test('a passkey signs in: a login of its own, never locked; when it was used and its counter are saved', async () => {
  const s = setup()
  await s.ready()
  const auth = await softAuthenticator(-7)
  const r = await s.signedIn()
  expect(s.add(auth, r.login.id)).toEqual({ ok: true, id: auth.id })
  s.tick(5000)
  const options = s.access.passkeyLoginOptions(RP.rpId)
  expect(options).toEqual({
    challenge: expect.stringMatching(/^[\w-]{43}$/),
    rpId: 'board.example.com',
    timeout: 120000,
    userVerification: 'required',
  })
  const changes = s.changes()
  const assertion = auth.assert({
    challenge: options.challenge,
    ...RP,
    counter: 3,
    userHandle: readSecrets().userId ?? '',
  })
  const res = await s.access.signInPasskey(page(assertion), RP, other)
  if (!res.ok) throw new Error(res.error)
  expect(s.changes()).toBe(changes + 1)
  expect(res.token).toMatch(/^[\w-]{43}$/)
  expect(res.maxAgeS).toBe(2592000)
  expect(res.login).toEqual({
    id: expect.any(String),
    method: 'passkey',
    passkeyId: auth.id,
    label: 'A browser',
    address: '203.0.113.10',
    signedInAt: s.now(),
    expiresAt: s.now() + LOGIN_MS,
    seenAt: null,
  })
  expect(s.access.verify(res.token)?.passkeyId).toBe(auth.id)
  expect(readPasskeys()[0]).toMatchObject({ counter: 3, usedAt: s.now() })
  expect(s.access.view().passkeys).toEqual([
    { id: auth.id, label: 'Safari on iPhone', addedAt: s.now() - 5000, usedAt: s.now() },
  ])
  // The same challenge again.
  expect(await s.access.signInPasskey(page(assertion), RP, other)).toEqual(WRONG)
  // As a test hands it on, without `type`; and a counter of 0 stays 0 for a passkey that keeps none.
  const synced = await softAuthenticator(-7)
  expect(s.add(synced, r.login.id)).toEqual({ ok: true, id: synced.id })
  const { challenge } = s.access.passkeyLoginOptions(RP.rpId)
  expect((await s.access.signInPasskey(synced.assert({ challenge, ...RP }), RP, phone)).ok).toBe(true)
  expect((await s.passkeyIn(synced)).ok).toBe(true)
  expect(readPasskeys()[1]).toMatchObject({ counter: 0, usedAt: s.now() })
})

test('an RS256 passkey (Windows Hello) is added and signs in', async () => {
  const s = setup()
  await s.ready()
  const auth = await softAuthenticator(-257)
  const r = await s.signedIn()
  expect(s.add(auth, r.login.id)).toEqual({ ok: true, id: auth.id })
  expect(readPasskeys()[0]).toMatchObject({ alg: -257, jwk: { kty: 'RSA' } })
  expect((await s.passkeyIn(auth)).ok).toBe(true)
})

test('a challenge is used once, lives 2 minutes, is for what it was made for, and 50 wait at most', async () => {
  const s = setup()
  await s.ready()
  const auth = await softAuthenticator(-7)
  const a = await s.signedIn()
  const b = await s.signedIn(other)
  expect(s.add(auth, a.login.id)).toEqual({ ok: true, id: auth.id })
  const signIn = (challenge: string, o: Partial<Assert> = {}): Promise<SignIn> =>
    s.access.signInPasskey(page(auth.assert({ challenge, ...RP, ...o })), RP, phone)

  // Used once, also when two come at once.
  const once = s.access.passkeyLoginOptions(RP.rpId).challenge
  const answers = await Promise.all([signIn(once), signIn(once)])
  expect(answers.map(x => x.ok)).toEqual([true, false])
  expect(await signIn(once)).toEqual(WRONG)
  // A failed check uses it up too.
  const failed = s.access.passkeyLoginOptions(RP.rpId).challenge
  expect(await signIn(failed, { origin: 'https://evil.example' })).toEqual(WRONG)
  expect(await signIn(failed)).toEqual(WRONG)
  // One the board never made.
  expect(await signIn(b64url.encode(new Uint8Array(randomBytes(32))))).toEqual(WRONG)

  // 2 minutes, not a millisecond more.
  const fresh = s.access.passkeyLoginOptions(RP.rpId).challenge
  const stale = s.access.passkeyLoginOptions(RP.rpId).challenge
  s.tick(CHALLENGE_MS)
  expect((await signIn(fresh)).ok).toBe(true)
  s.tick(1)
  expect(await signIn(stale)).toEqual(WRONG)
  const late = s.addOptions(a.login.id).challenge
  s.tick(CHALLENGE_MS + 1)
  expect(s.access.addPasskey(a.login.id, page(auth.register({ challenge: late, ...RP })), RP, null)).toEqual({
    ok: false,
    error: 'challenge',
  })

  // An add challenge does not sign in, and a sign-in's does not add.
  expect(await signIn(s.addOptions(a.login.id).challenge)).toEqual(WRONG)
  const second = await softAuthenticator(-7)
  const forLogin = s.access.passkeyLoginOptions(RP.rpId).challenge
  expect(s.access.addPasskey(a.login.id, page(second.register({ challenge: forLogin, ...RP })), RP, null)).toEqual({
    ok: false,
    error: 'challenge',
  })
  // One login's add challenge is not another's, nor is it any more once its login ended.
  const mine = s.addOptions(a.login.id).challenge
  expect(s.access.addPasskey(b.login.id, page(second.register({ challenge: mine, ...RP })), RP, null)).toEqual({
    ok: false,
    error: 'challenge',
  })
  const before = s.addOptions(b.login.id).challenge
  expect(s.access.end(b.login.id)).toBe(true)
  expect(s.access.addPasskey(b.login.id, page(second.register({ challenge: before, ...RP })), RP, null)).toEqual({
    ok: false,
    error: 'challenge',
  })
  expect(readPasskeys().map(p => p.id)).toEqual([auth.id])

  // The 51st drops the first.
  const fifty = Array.from({ length: 51 }, () => s.access.passkeyLoginOptions(RP.rpId).challenge)
  expect(await signIn(fifty[0] ?? '')).toEqual(WRONG)
  expect((await signIn(fifty[1] ?? '')).ok).toBe(true)
  expect((await signIn(fifty[50] ?? '')).ok).toBe(true)
})

test('a sign-in that does not check out is 401 wrong, recorded as a passkey one', async () => {
  const s = setup()
  await s.ready()
  const auth = await softAuthenticator(-7)
  const r = await s.signedIn()
  const { challenge: registered } = s.addOptions(r.login.id)
  expect(
    s.access.addPasskey(r.login.id, page(auth.register({ challenge: registered, ...RP, counter: 5 })), RP, null),
  ).toEqual({ ok: true, id: auth.id })
  const stranger = await softAuthenticator(-7)
  const tries: [string, () => Promise<SignIn>][] = [
    ['a lower counter', () => s.passkeyIn(auth, { counter: 4 })],
    ['the same counter', () => s.passkeyIn(auth, { counter: 5 })],
    ['another origin', () => s.passkeyIn(auth, { counter: 6, origin: 'https://evil.example' })],
    ['another rpId', () => s.passkeyIn(auth, { counter: 6, rpId: 'evil.example' })],
    ['no verification', () => s.passkeyIn(auth, { counter: 6, uv: false })],
    ['another user', () => s.passkeyIn(auth, { counter: 6, userHandle: 'b3RoZXItdXNlci1pZC0wMDE' })],
    ['a passkey never added', () => s.passkeyIn(stranger)],
    [
      'another type',
      () => {
        const { challenge } = s.access.passkeyLoginOptions(RP.rpId)
        return s.access.signInPasskey({ ...auth.assert({ challenge, ...RP, counter: 6 }), type: 'x' }, RP, phone)
      },
    ],
    ['nothing', () => s.access.signInPasskey(null, RP, phone)],
    ['no response', () => s.access.signInPasskey(page({ id: auth.id }), RP, phone)],
  ]
  for (const [what, attempt] of tries) {
    const changes = s.changes()
    expect([what, await attempt()]).toEqual([what, WRONG])
    expect([what, s.changes()]).toEqual([what, changes + 1])
  }
  expect(readAttempts().map(a => [a.method, a.reason, a.address, a.label])).toEqual(
    Array(tries.length).fill(['passkey', 'wrong', '203.0.113.9', 'Safari on iPhone']),
  )
  expect(readPasskeys()[0]).toMatchObject({ counter: 5, usedAt: null })
  expect(readSecrets().lockout).toEqual({ failures: 0, until: null })
  expect((await s.passkeyIn(auth, { counter: 6, userHandle: readSecrets().userId ?? '' })).ok).toBe(true)
  expect(readPasskeys()[0]?.counter).toBe(6)
})

test('password locked out and its rate full: a passkey still signs in; its failures do not count, its rate is its own', async () => {
  const s = setup()
  await s.ready()
  const auth = await softAuthenticator(-7)
  // From another address: the phone's 10 password sign-ins a minute are all the loop's.
  const r = await s.signedIn(other)
  expect(s.add(auth, r.login.id)).toEqual({ ok: true, id: auth.id })
  const statuses: number[] = []
  for (let i = 0; i < 11; i++) {
    const x = await s.access.signInPassword({ password: 'not the password', code: s.code() }, phone)
    statuses.push(x.ok ? 200 : x.status)
  }
  expect(statuses).toEqual([401, 401, 401, 401, 401, 423, 423, 423, 423, 423, 429])
  const lockout = readSecrets().lockout
  expect(lockout).toEqual({ failures: 5, until: s.now() + 60_000 })

  expect((await s.passkeyIn(auth, {}, phone)).ok).toBe(true)
  const changes = s.changes()
  expect(await s.passkeyIn(auth, { origin: 'https://evil.example' }, phone)).toEqual(WRONG)
  expect(s.changes()).toBe(changes + 1)
  expect(readAttempts().at(-1)).toEqual({
    at: s.now(),
    address: '203.0.113.9',
    label: 'Safari on iPhone',
    method: 'passkey',
    reason: 'wrong',
  })
  expect(readSecrets().lockout).toEqual(lockout)

  // Passkey sign-in's own limit: 20 a minute from one address.
  let taken = 2
  while (s.access.rate('passkey', phone.address).ok) taken++
  expect(taken).toBe(20)
  expect(await s.passkeyIn(auth, {}, phone)).toEqual({ ok: false, status: 429, error: 'limited', retryAfterS: 60 })
  expect(readAttempts().at(-1)).toMatchObject({ method: 'passkey', reason: 'limited', address: '203.0.113.9' })
  expect((await s.passkeyIn(auth, {}, other)).ok).toBe(true)
  expect(readSecrets().lockout).toEqual(lockout)
})

test('removing a passkey ends the logins made with it; a new domain removes every passkey and ends every login', async () => {
  const s = setup()
  await s.ready()
  const a = await softAuthenticator(-7)
  const b = await softAuthenticator(-7)
  expect(s.access.hasPasskeysOrLogins()).toBe(false)
  const password = await s.signedIn()
  expect(s.access.hasPasskeysOrLogins()).toBe(true)
  expect(s.add(a, password.login.id)).toEqual({ ok: true, id: a.id })
  expect(s.add(b, password.login.id)).toEqual({ ok: true, id: b.id })
  const viaA = await s.passkeyIn(a)
  const viaA2 = await s.passkeyIn(a, {}, other)
  const viaB = await s.passkeyIn(b)
  if (!viaA.ok || !viaA2.ok || !viaB.ok) throw new Error('refused')
  const gone: string[] = []
  for (const [name, login] of [
    ['password', password],
    ['a', viaA],
    ['a2', viaA2],
    ['b', viaB],
  ] as const)
    s.access.watch(login.login.id, () => gone.push(name))

  let changes = s.changes()
  expect(s.access.removePasskey(a.id)).toBe(true)
  expect(s.changes()).toBe(changes + 1)
  expect(gone).toEqual(['a', 'a2'])
  expect([s.access.verify(viaA.token), s.access.verify(viaA2.token)]).toEqual([null, null])
  expect(s.access.verify(viaB.token)?.id).toBe(viaB.login.id)
  expect(s.access.verify(password.token)?.id).toBe(password.login.id)
  expect(s.access.view().passkeys.map(p => p.id)).toEqual([b.id])
  expect(await s.passkeyIn(a)).toEqual(WRONG)
  changes = s.changes()
  expect(s.access.removePasskey(a.id)).toBe(false)
  expect(s.changes()).toBe(changes)

  // A challenge from before the domain changed is for the old one.
  const old = s.access.passkeyLoginOptions(RP.rpId).challenge
  changes = s.changes()
  s.access.domainChanged()
  expect(s.changes()).toBe(changes + 1)
  expect(readPasskeys()).toEqual([])
  expect(readLogins()).toEqual([])
  expect(gone).toEqual(['a', 'a2', 'password', 'b'])
  expect(s.access.hasPasskeysOrLogins()).toBe(false)
  changes = s.changes()
  s.access.domainChanged()
  expect(s.changes()).toBe(changes)

  const again = await s.signedIn()
  expect(s.add(b, again.login.id)).toEqual({ ok: true, id: b.id })
  expect(await s.access.signInPasskey(page(b.assert({ challenge: old, ...RP })), RP, phone)).toEqual(WRONG)
  s.access.endAll()
  expect(s.access.hasPasskeysOrLogins()).toBe(true)
})

test('the WebAuthn user id is made once and kept in access.json; one that is not base64url is made again', async () => {
  const s = setup()
  await s.ready()
  const r = await s.signedIn()
  const first = s.addOptions(r.login.id).user.id
  expect(readSecrets().userId).toBe(first)
  const again = s.make()
  s.tick(TOTP_STEP_MS)
  const answer = again.passkeyAddOptions(r.login.id, s.code(), { id: RP.rpId })
  expect(answer.ok && answer.options.user.id).toBe(first)
  expect(readSecrets().userId).toBe(first)

  const raw = JSON.parse(readFileSync(accessFile(), 'utf8'))
  writeFileSync(accessFile(), JSON.stringify({ ...raw, userId: 'not base64url!' }))
  const made = s.addOptions(r.login.id).user.id
  expect(b64url.decode(made)?.length).toBe(16)
  expect(made).not.toBe(first)
  expect(readSecrets().userId).toBe(made)
})
