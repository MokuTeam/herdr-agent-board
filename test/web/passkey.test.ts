// Passkeys on the page (models/passkey.ts): base64url both ways, the board's options turned into
// what navigator.credentials takes (bytes where WebAuthn wants bytes), the credential it gives
// turned back into the JSON the board reads, and this browser's own note that it made one.
import { expect, test } from 'bun:test'
import {
  assertionJson,
  attestationJson,
  creationOptions,
  fromB64url,
  markPasskeyMade,
  passkeyMade,
  requestOptions,
  toB64url,
} from '../../web/src/models/passkey.ts'
import { FakeWorld } from './support/fake-dom.ts'

const bytesOf = (buffer: unknown): number[] => {
  if (!(buffer instanceof ArrayBuffer)) throw new Error('not an ArrayBuffer')
  return [...new Uint8Array(buffer)]
}
const buffer = (...bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer
const ascii = (text: string): number[] => [...text].map(c => c.charCodeAt(0))

test('base64url both ways, without padding', () => {
  expect(toB64url(new Uint8Array([0xfb, 0xff, 0x00]))).toBe('-_8A')
  expect(toB64url(buffer(0xfb, 0xff, 0x00))).toBe('-_8A')
  expect(bytesOf(fromB64url('-_8A'))).toEqual([0xfb, 0xff, 0x00])
  expect(toB64url(new Uint8Array())).toBe('')
  expect(bytesOf(fromB64url(''))).toEqual([])
  // Every length, so every padding the base64 would have had.
  for (let n = 1; n <= 33; n++) {
    const bytes = Array.from({ length: n }, (_, i) => (i * 97 + n * 13) % 256)
    const text = toB64url(new Uint8Array(bytes))
    expect(text).toMatch(/^[A-Za-z0-9_-]*$/)
    expect(bytesOf(fromB64url(text))).toEqual(bytes)
  }
})

test('the options to sign in: the challenge as bytes, the rest kept', () => {
  const options = requestOptions({
    challenge: 'Y2hhbGxlbmdl',
    rpId: 'board.example.com',
    timeout: 120000,
    userVerification: 'required',
  })
  if (!options) throw new Error('no options')
  const { challenge, ...rest } = options
  expect(bytesOf(challenge)).toEqual(ascii('challenge'))
  expect(rest).toEqual({ rpId: 'board.example.com', timeout: 120000, userVerification: 'required' })
  // Credentials named: their ids as bytes too.
  const named = requestOptions({ challenge: 'AA', allowCredentials: [{ type: 'public-key', id: '-_8A' }] })
  expect(named?.allowCredentials?.map(c => [c.type, bytesOf(c.id)])).toEqual([['public-key', [0xfb, 0xff, 0x00]]])
  // No challenge, or not the board's answer: none.
  for (const json of [{ rpId: 'board.example.com' }, { challenge: 5 }, null, 'x', [], { challenge: '!!' }])
    expect([json, requestOptions(json)]).toEqual([json, null])
})

test('the options to add a passkey: the challenge, the user id and each excluded id as bytes, the rest kept', () => {
  const json = {
    challenge: 'Y2hhbGxlbmdl',
    rp: { id: 'board.example.com', name: 'Agent board' },
    user: { id: 'dGVzdC11c2VyLWlkLTAwMQ', name: 'owner', displayName: 'Agent board' },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
    excludeCredentials: [
      { type: 'public-key', id: '-_8A' },
      { type: 'public-key', id: 'AQID' },
    ],
    timeout: 120000,
  }
  const options = creationOptions(json)
  if (!options) throw new Error('no options')
  const { challenge, user, excludeCredentials, ...rest } = options
  expect(bytesOf(challenge)).toEqual(ascii('challenge'))
  const { id, ...person } = user
  expect(bytesOf(id)).toEqual(ascii('test-user-id-001'))
  expect(person).toEqual({ name: 'owner', displayName: 'Agent board' })
  expect(excludeCredentials?.map(c => [c.type, bytesOf(c.id)])).toEqual([
    ['public-key', [0xfb, 0xff, 0x00]],
    ['public-key', [1, 2, 3]],
  ])
  expect(rest as unknown).toEqual({
    rp: json.rp,
    pubKeyCredParams: json.pubKeyCredParams,
    authenticatorSelection: json.authenticatorSelection,
    attestation: 'none',
    timeout: 120000,
  })
  // None excluded yet: an empty list stays one.
  expect(creationOptions({ ...json, excludeCredentials: [] })?.excludeCredentials).toEqual([])
  // No challenge, no user id, an excluded credential without an id: none.
  const { challenge: _, ...noChallenge } = json
  expect(creationOptions(noChallenge)).toBeNull()
  expect(creationOptions({ ...json, user: { name: 'owner' } })).toBeNull()
  expect(creationOptions({ ...json, excludeCredentials: [{ type: 'public-key' }] })).toBeNull()
  expect(creationOptions(null)).toBeNull()
})

test('the credential back to the board: every byte field base64url', () => {
  const signIn = {
    id: '-_8A',
    rawId: buffer(0xfb, 0xff, 0x00),
    type: 'public-key',
    response: {
      clientDataJSON: buffer(1, 2),
      authenticatorData: buffer(3),
      signature: buffer(4, 5, 6),
      userHandle: buffer(0xff),
    },
  }
  expect(assertionJson(signIn as never)).toEqual({
    id: '-_8A',
    rawId: '-_8A',
    type: 'public-key',
    response: { clientDataJSON: 'AQI', authenticatorData: 'Aw', signature: 'BAUG', userHandle: '_w' },
  })
  const noHandle = { ...signIn, response: { ...signIn.response, userHandle: null } }
  expect((assertionJson(noHandle as never).response as { userHandle: unknown }).userHandle).toBeNull()

  const made = {
    id: 'AQID',
    rawId: buffer(1, 2, 3),
    type: 'public-key',
    response: {
      clientDataJSON: buffer(1, 2),
      attestationObject: buffer(0xa3, 0x63),
      getTransports: () => ['internal', 'hybrid'],
    },
  }
  expect(attestationJson(made as never)).toEqual({
    id: 'AQID',
    rawId: 'AQID',
    type: 'public-key',
    response: { clientDataJSON: 'AQI', attestationObject: 'o2M', transports: ['internal', 'hybrid'] },
  })
  // A browser that cannot say its transports: none.
  const { getTransports: _, ...older } = made.response
  expect(
    (attestationJson({ ...made, response: older } as never).response as { transports: unknown }).transports,
  ).toEqual([])
})

test("this browser's note that it made a passkey", () => {
  const world = new FakeWorld({ viewport: { w: 820, h: 1180 } })
  world.install()
  try {
    expect(passkeyMade()).toBe(false)
    markPasskeyMade()
    expect(passkeyMade()).toBe(true)
    expect(world.storage.get('agent-board:passkey-made')).toBe('1')
    // A browser that refuses storage: none made, and noting one throws nothing.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage is off')
      },
    })
    expect(passkeyMade()).toBe(false)
    markPasskeyMade()
  } finally {
    world.uninstall()
  }
})
