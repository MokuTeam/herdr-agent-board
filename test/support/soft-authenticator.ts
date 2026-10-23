// A software passkey authenticator for the tests. It makes what a browser hands the page after
// navigator.credentials.create() and .get() (as PublicKeyCredential.toJSON() gives it: base64url,
// no padding), with a CBOR encoder and a signer of its own, so that the board's reading of
// passkeys (src/core/webauthn.ts) is checked against data it did not make itself.
// - Registration: attestation 'none' (fmt 'none', attStmt {}), an aaguid of zeros, the public key
//   as a COSE key. Assertion: authenticator data without a credential, signed over
//   authData ‖ SHA-256(clientDataJSON).
// - ES256 is signed as WebCrypto does (raw r‖s) and turned into the DER an authenticator sends.
// - Options left out: user present and verified, counter 0, no user handle.
import { createHash, generateKeyPair, type KeyObject, randomBytes, sign } from 'node:crypto'

export interface SoftAuthenticator {
  id: string // base64url credential id
  register(o: {
    challenge: string
    origin: string
    rpId: string
    uv?: boolean
    up?: boolean
    type?: string
    counter?: number
  }): {
    id: string
    rawId: string
    response: { clientDataJSON: string; attestationObject: string }
  }
  assert(o: {
    challenge: string
    origin: string
    rpId: string
    uv?: boolean
    up?: boolean
    counter?: number
    userHandle?: string
    type?: string
  }): {
    id: string
    rawId: string
    response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null }
  }
}

type SoftAlg = -7 | -257 | -8
type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>

const UP = 0x01
const UV = 0x04
const AT = 0x40

const concat = (...parts: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts))
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
const sha256 = (data: Uint8Array | string): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest())

/** A CBOR item's head: major type and its argument, in the shortest form. */
function head(major: number, n: number): Uint8Array {
  const m = major << 5
  if (n < 24) return Uint8Array.of(m | n)
  if (n < 0x100) return Uint8Array.of(m | 24, n)
  if (n < 0x10000) return Uint8Array.of(m | 25, n >> 8, n & 0xff)
  return Uint8Array.of(m | 26, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)
}

function cbor(v: Cbor): Uint8Array {
  if (typeof v === 'number') return v < 0 ? head(1, -1 - v) : head(0, v)
  if (typeof v === 'string') {
    const text = new TextEncoder().encode(v)
    return concat(head(3, text.length), text)
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v)
  if (Array.isArray(v)) return concat(head(4, v.length), ...v.map(cbor))
  return concat(head(5, v.size), ...[...v].flatMap(([key, value]) => [cbor(key), cbor(value)]))
}

/** An ECDSA signature as an authenticator sends it, DER SEQUENCE { INTEGER r, INTEGER s }, from raw r‖s. */
function der(raw: Uint8Array): Uint8Array {
  const integer = (half: Uint8Array) => {
    let start = 0
    while (start < half.length - 1 && half[start] === 0) start++
    const digits = half.subarray(start)
    const body = (digits[0] ?? 0) & 0x80 ? concat(Uint8Array.of(0), digits) : digits
    return concat(Uint8Array.of(0x02, body.length), body)
  }
  const r = integer(raw.subarray(0, raw.length / 2))
  const s = integer(raw.subarray(raw.length / 2))
  return concat(Uint8Array.of(0x30, r.length + s.length), r, s)
}

function keyPair(alg: SoftAlg): Promise<{ publicKey: KeyObject; privateKey: KeyObject }> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, publicKey: KeyObject, privateKey: KeyObject) =>
      err ? reject(err) : resolve({ publicKey, privateKey })
    if (alg === -7) generateKeyPair('ec', { namedCurve: 'P-256' }, done)
    else if (alg === -257) generateKeyPair('rsa', { modulusLength: 2048 }, done)
    else generateKeyPair('ed25519', done)
  })
}

/** The public key as a COSE key: EC2 P-256, RSA, or OKP Ed25519. */
function coseKey(alg: SoftAlg, publicKey: KeyObject): Map<Cbor, Cbor> {
  const jwk = publicKey.export({ format: 'jwk' })
  const bytes = (field: unknown) => new Uint8Array(Buffer.from(String(field), 'base64url'))
  if (alg === -7)
    return new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, bytes(jwk.x)],
      [-3, bytes(jwk.y)],
    ])
  if (alg === -257)
    return new Map<Cbor, Cbor>([
      [1, 3],
      [3, -257],
      [-1, bytes(jwk.n)],
      [-2, bytes(jwk.e)],
    ])
  return new Map<Cbor, Cbor>([
    [1, 1],
    [3, -8],
    [-1, 6],
    [-2, bytes(jwk.x)],
  ])
}

function signer(alg: SoftAlg, privateKey: KeyObject): (data: Uint8Array) => Uint8Array {
  if (alg === -7) return data => der(sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }))
  if (alg === -257) return data => new Uint8Array(sign('sha256', data, privateKey))
  return data => new Uint8Array(sign(null, data, privateKey))
}

/** rpIdHash ‖ flags ‖ counter (big-endian), the start of all authenticator data. */
function authHead(o: { rpId: string; up?: boolean; uv?: boolean; counter?: number }, attested: number): Uint8Array {
  const flags = (o.up === false ? 0 : UP) | (o.uv === false ? 0 : UV) | attested
  const counter = new Uint8Array(4)
  new DataView(counter.buffer).setUint32(0, o.counter ?? 0)
  return concat(sha256(o.rpId), Uint8Array.of(flags), counter)
}

const clientData = (type: string, o: { challenge: string; origin: string }): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ type, challenge: o.challenge, origin: o.origin, crossOrigin: false }))

/** A new authenticator holding one passkey of the given algorithm (-8: Ed25519, which the board refuses). */
export async function softAuthenticator(alg: SoftAlg): Promise<SoftAuthenticator> {
  const { publicKey, privateKey } = await keyPair(alg)
  const rawId = new Uint8Array(randomBytes(32))
  const id = b64(rawId)
  const cose = coseKey(alg, publicKey)
  const signed = signer(alg, privateKey)
  return {
    id,
    register(o) {
      const attested = concat(
        new Uint8Array(16),
        Uint8Array.of(rawId.length >> 8, rawId.length & 0xff),
        rawId,
        cbor(cose),
      )
      const authData = concat(authHead(o, AT), attested)
      const attestationObject = cbor(
        new Map<Cbor, Cbor>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      )
      const clientDataJSON = clientData(o.type ?? 'webauthn.create', o)
      return {
        id,
        rawId: id,
        response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject) },
      }
    },
    assert(o) {
      const clientDataJSON = clientData(o.type ?? 'webauthn.get', o)
      const authenticatorData = authHead(o, 0)
      const signature = signed(concat(authenticatorData, sha256(clientDataJSON)))
      return {
        id,
        rawId: id,
        response: {
          clientDataJSON: b64(clientDataJSON),
          authenticatorData: b64(authenticatorData),
          signature: b64(signature),
          userHandle: o.userHandle ?? null,
        },
      }
    },
  }
}
