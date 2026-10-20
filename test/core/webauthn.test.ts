// Passkeys' data and signatures (core/webauthn.ts), checked against a software authenticator
// (test/support/soft-authenticator.ts) that builds and signs what a browser hands the page, with a
// CBOR encoder and a signer of its own.
import { beforeAll, describe, expect, test } from 'bun:test'
import { b64url, decodeCbor, verifyAssertion, verifyRegistration, type WhyNot } from '../../src/core/webauthn.ts'
import { type SoftAuthenticator, softAuthenticator } from '../support/soft-authenticator.ts'

const E = { challenge: 'Y2hhbGxlbmdl', origin: 'https://board.example.com', rpId: 'board.example.com' }
const USER = 'dGVzdC11c2VyLWlkLTAwMQ' // test-user-id-001
const OTHER_USER = Buffer.from('test-user-id-002').toString('base64url')
const ZERO_AAGUID = '00000000-0000-0000-0000-000000000000'

const hex = (text: string) => new Uint8Array(Buffer.from(text.replace(/\s/g, ''), 'hex'))

type Change = { origin?: string; rpId?: string; challenge?: string; uv?: boolean; up?: boolean; type?: string }
/** Each way a passkey's answer can be for another page or made without the owner, and why it is refused. */
const refusals: [Change, WhyNot][] = [
  [{ origin: 'https://evil.example.com' }, 'origin'],
  [{ rpId: 'example.com' }, 'rpId'],
  [{ challenge: 'b3RoZXI' }, 'challenge'],
  [{ uv: false }, 'verification'],
  [{ up: false }, 'presence'],
]

describe.each([-7, -257] as const)('alg %d', alg => {
  let auth: SoftAuthenticator
  beforeAll(async () => {
    auth = await softAuthenticator(alg)
  })

  /** The passkey as the board keeps it after a registration with E, its counter as given. */
  function kept(counter = 0) {
    const r = verifyRegistration(auth.register(E).response, E)
    if (!r.ok) throw new Error(`registration refused: ${r.why}`)
    return { jwk: r.credential.jwk, alg: r.credential.alg, counter, userId: USER }
  }
  function signIn(change: Change & { counter?: number; userHandle?: string } = {}, stored = kept()) {
    const a = auth.assert({ ...E, ...change })
    return verifyAssertion({ id: a.id, ...a.response }, E, stored)
  }

  test('a registration verifies, and a sign-in with its passkey gives its counter', () => {
    const made = auth.register(E)
    expect(made.id).toBe(auth.id)
    const r = verifyRegistration(made.response, E)
    expect(r).toEqual({
      ok: true,
      credential: { id: auth.id, jwk: expect.any(Object), alg, counter: 0, aaguid: ZERO_AAGUID },
    })
    if (!r.ok) return
    const a = auth.assert({ ...E, counter: 1, userHandle: USER })
    expect(a.id).toBe(auth.id)
    expect(verifyAssertion({ id: a.id, ...a.response }, E, { ...r.credential, userId: USER })).toEqual({
      ok: true,
      counter: 1,
    })
  })

  test.each([...refusals, [{ type: 'webauthn.get' }, 'type'] as [Change, WhyNot]])(
    'a registration with %j is refused: %s',
    (change, why) => {
      expect(verifyRegistration(auth.register({ ...E, ...change }).response, E)).toEqual({ ok: false, why })
    },
  )

  test.each([...refusals, [{ type: 'webauthn.create' }, 'type'] as [Change, WhyNot]])(
    'a sign-in with %j is refused: %s',
    (change, why) => {
      expect(signIn(change)).toEqual({ ok: false, why })
    },
  )

  test('a signature with one bit changed is refused', () => {
    const a = auth.assert(E)
    const signature = Buffer.from(a.response.signature, 'base64url')
    const last = signature.length - 1
    signature[last] = (signature[last] ?? 0) ^ 1
    const changed = { id: a.id, ...a.response, signature: signature.toString('base64url') }
    expect(verifyAssertion(changed, E, kept())).toEqual({ ok: false, why: 'signature' })
  })

  test('a user handle, when given, is the board’s own', () => {
    expect(signIn({ userHandle: USER })).toEqual({ ok: true, counter: 0 })
    expect(signIn({ userHandle: OTHER_USER })).toEqual({ ok: false, why: 'user' })
  })

  test('the counter, once either one is not zero, only goes up', () => {
    expect(signIn({ counter: 3 }, kept(5))).toEqual({ ok: false, why: 'counter' })
    expect(signIn({ counter: 5 }, kept(5))).toEqual({ ok: false, why: 'counter' })
    expect(signIn({ counter: 0 }, kept(5))).toEqual({ ok: false, why: 'counter' })
    expect(signIn({ counter: 6 }, kept(5))).toEqual({ ok: true, counter: 6 })
    expect(signIn({ counter: 0 }, kept(0))).toEqual({ ok: true, counter: 0 })
    expect(signIn({ counter: 7 }, kept(0))).toEqual({ ok: true, counter: 7 })
  })
})

test('a passkey of another algorithm (Ed25519) is refused', async () => {
  const ed = await softAuthenticator(-8)
  expect(verifyRegistration(ed.register(E).response, E)).toEqual({ ok: false, why: 'algorithm' })
})

test('what is not a passkey’s data is refused as such', async () => {
  const { response } = (await softAuthenticator(-7)).register(E)
  const shape = { ok: false, why: 'shape' } as const
  expect(verifyRegistration({ ...response, clientDataJSON: '***' }, E)).toEqual(shape)
  expect(verifyRegistration({ ...response, clientDataJSON: Buffer.from('{').toString('base64url') }, E)).toEqual(shape)
  const longer = Buffer.concat([Buffer.from(response.attestationObject, 'base64url'), Buffer.from([0])])
  expect(verifyRegistration({ ...response, attestationObject: longer.toString('base64url') }, E)).toEqual(shape)
})

test('CBOR: a map with negative keys, nested arrays, byte and text strings, and nothing after it', () => {
  // {1: 2, -2: h'0102', -3: [1, [h'ff', -1, true, false, null]], "fmt": "none"}
  const bytes = hex('a4 01 02 21 42 0102 22 82 01 85 41 ff 20 f5 f4 f6 63 666d74 64 6e6f6e65')
  const want = new Map<unknown, unknown>([
    [1, 2],
    [-2, new Uint8Array([1, 2])],
    [-3, [1, [new Uint8Array([0xff]), -1, true, false, null]]],
    ['fmt', 'none'],
  ])
  expect(decodeCbor(bytes)).toEqual(want)
  expect(() => decodeCbor(hex('01 00'))).toThrow()
  expect(() => decodeCbor(hex('f9 3c00'))).toThrow() // a float
  expect(() => decodeCbor(hex('c0 60'))).toThrow() // a tag
  expect(() => decodeCbor(hex('42 01'))).toThrow() // shorter than it says
})

test('base64url: no padding, and null for what is not base64url', () => {
  expect(b64url.encode(new Uint8Array([0xfb, 0xff, 0x00]))).toBe('-_8A')
  expect(b64url.decode('-_8A')).toEqual(new Uint8Array([0xfb, 0xff, 0x00]))
  expect(b64url.encode(new Uint8Array([0xfb]))).toBe('-w')
  expect(b64url.decode('-w')).toEqual(new Uint8Array([0xfb]))
  expect(b64url.decode('***')).toBeNull()
  expect(b64url.decode('A')).toBeNull()
})
