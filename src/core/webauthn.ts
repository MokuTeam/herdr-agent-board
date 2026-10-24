// Passkeys (WebAuthn) without a library: what the board reads from a passkey's registration and
// sign-in, and the checks on them. The page sends everything as base64url without padding.
// - Client data (JSON): its type (webauthn.create, webauthn.get), the board's challenge, the
//   page's origin.
// - Registration: the attestation object, CBOR {fmt, attStmt, authData}. Any fmt is accepted and
//   attStmt is ignored: the board asks for attestation 'none' and trusts no attestation.
// - Authenticator data: SHA-256 of the rpId (32 bytes), flags (UP 0x01, UV 0x04, AT 0x40, ED 0x80),
//   the signature counter (4, big-endian); with AT the credential: aaguid (16), id length (2), id,
//   public key (a COSE key in CBOR); with ED the extensions (CBOR).
// - Sign-in: a signature over authData ‖ SHA-256(clientDataJSON), ES256 (ECDSA P-256 with SHA-256,
//   DER-encoded) or RS256 (RSASSA-PKCS1-v1_5 with SHA-256).
// Pure computation (node:crypto for hashes and signatures); the page never imports this file.

import { constants, createHash, createPublicKey, verify } from 'node:crypto'

export type Alg = -7 | -257

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const SIXTET = new Map([...ALPHABET].map((c, i) => [c, i]))

export const b64url = {
  encode(bytes: Uint8Array): string {
    let text = ''
    for (let i = 0; i < bytes.length; i += 3) {
      const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
      const chars = Math.min(4, bytes.length - i + 1) // 1 byte: 2 chars, 2: 3, 3: 4
      for (let j = 0; j < chars; j++) text += ALPHABET.charAt((n >> (18 - 6 * j)) & 63)
    }
    return text
  },
  decode(text: string): Uint8Array | null {
    if (text.length % 4 === 1) return null
    const bytes = new Uint8Array(Math.floor((text.length * 3) / 4))
    let bits = 0
    let acc = 0
    let at = 0
    for (const c of text) {
      const v = SIXTET.get(c)
      if (v === undefined) return null
      acc = ((acc << 6) | v) & 0x3fff
      bits += 6
      if (bits >= 8) {
        bits -= 8
        bytes[at++] = (acc >> bits) & 0xff
      }
    }
    return bytes
  },
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
/** Deeper than a passkey's data ever goes. */
const MAX_DEPTH = 16

function byteAt(bytes: Uint8Array, at: number): number {
  const b = bytes[at]
  if (b === undefined) throw new Error('CBOR ends early')
  return b
}

function take(bytes: Uint8Array, at: number, length: number): Uint8Array {
  if (at + length > bytes.length) throw new Error('CBOR ends early')
  return bytes.subarray(at, at + length)
}

/** A head's argument (a count, a length or the integer itself) and where the item's content starts. */
function argument(bytes: Uint8Array, at: number, info: number): [number, number] {
  if (info < 24) return [info, at + 1]
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
  if (size === 0) throw new Error('CBOR: indefinite lengths are not read')
  let n = 0
  for (let i = 1; i <= size; i++) n = n * 256 + byteAt(bytes, at + i)
  if (n > Number.MAX_SAFE_INTEGER) throw new Error('CBOR: integer too large')
  return [n, at + 1 + size]
}

/** One CBOR item at `at`, and where it ends. */
function readItem(bytes: Uint8Array, at: number, depth: number): [unknown, number] {
  if (depth > MAX_DEPTH) throw new Error('CBOR nested too deep')
  const first = byteAt(bytes, at)
  const major = first >> 5
  const info = first & 0x1f
  if (major === 7) {
    if (info === 20) return [false, at + 1]
    if (info === 21) return [true, at + 1]
    if (info === 22) return [null, at + 1]
    throw new Error('CBOR: floats and other simple values are not read')
  }
  const [n, start] = argument(bytes, at, info)
  if (major === 0) return [n, start]
  if (major === 1) return [-1 - n, start]
  if (major === 2) return [new Uint8Array(take(bytes, start, n)), start + n]
  if (major === 3) return [utf8.decode(take(bytes, start, n)), start + n]
  if (major === 4) {
    const items: unknown[] = []
    let pos = start
    for (let i = 0; i < n; i++) {
      const [item, end] = readItem(bytes, pos, depth + 1)
      items.push(item)
      pos = end
    }
    return [items, pos]
  }
  if (major === 5) {
    const map = new Map<unknown, unknown>()
    let pos = start
    for (let i = 0; i < n; i++) {
      const [key, keyEnd] = readItem(bytes, pos, depth + 1)
      const [value, end] = readItem(bytes, keyEnd, depth + 1)
      if (map.has(key)) throw new Error('CBOR: a map key twice')
      map.set(key, value)
      pos = end
    }
    return [map, pos]
  }
  throw new Error('CBOR: tags are not read')
}

/** The CBOR the board reads: maps (as Map), arrays, byte and text strings, unsigned and negative integers, true, false, null. Throws on anything else and on trailing bytes. */
export function decodeCbor(bytes: Uint8Array): unknown {
  const [value, end] = readItem(bytes, 0, 0)
  if (end !== bytes.length) throw new Error('CBOR: bytes after the item')
  return value
}

export interface AuthData {
  rpIdHash: Uint8Array
  up: boolean
  uv: boolean
  counter: number
  credential: { aaguid: string; id: Uint8Array; key: Map<unknown, unknown> } | null
}

const UP = 0x01
const UV = 0x04
const AT = 0x40
const ED = 0x80

const hex = (bytes: Uint8Array): string => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')

/** Authenticator data, as described at the top. Throws when it is cut short or has bytes after its last part. */
export function parseAuthData(bytes: Uint8Array): AuthData {
  const flags = byteAt(bytes, 32)
  const counter = [33, 34, 35, 36].reduce((n, at) => n * 256 + byteAt(bytes, at), 0)
  let pos = 37
  let credential: AuthData['credential'] = null
  if (flags & AT) {
    const aaguid = hex(take(bytes, pos, 16)).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
    const length = (byteAt(bytes, pos + 16) << 8) | byteAt(bytes, pos + 17)
    const id = new Uint8Array(take(bytes, pos + 18, length))
    const [key, end] = readItem(bytes, pos + 18 + length, 0)
    if (!(key instanceof Map)) throw new Error('authenticator data: the public key is not a map')
    credential = { aaguid, id, key }
    pos = end
  }
  if (flags & ED) pos = readItem(bytes, pos, 0)[1]
  if (pos !== bytes.length) throw new Error('authenticator data: bytes after its last part')
  return {
    rpIdHash: new Uint8Array(bytes.subarray(0, 32)),
    up: !!(flags & UP),
    uv: !!(flags & UV),
    counter,
    credential,
  }
}

const isBytes = (v: unknown, length?: number): v is Uint8Array =>
  v instanceof Uint8Array && v.length > 0 && (length === undefined || v.length === length)

/** EC2 P-256 (kty 2, crv 1, -2 x, -3 y) with alg -7, or RSA (kty 3, -1 n, -2 e) with alg -257; null for anything else. */
export function coseKey(key: Map<unknown, unknown>): { alg: Alg; jwk: JsonWebKey } | null {
  const kty = key.get(1)
  const alg = key.get(3)
  if (kty === 2 && alg === -7 && key.get(-1) === 1) {
    const x = key.get(-2)
    const y = key.get(-3)
    if (isBytes(x, 32) && isBytes(y, 32))
      return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64url.encode(x), y: b64url.encode(y) } }
  }
  if (kty === 3 && alg === -257) {
    const n = key.get(-1)
    const e = key.get(-2)
    if (isBytes(n) && isBytes(e)) return { alg, jwk: { kty: 'RSA', n: b64url.encode(n), e: b64url.encode(e) } }
  }
  return null
}

export interface Expect {
  challenge: string
  origin: string
  rpId: string
}
export type WhyNot =
  | 'shape'
  | 'type'
  | 'challenge'
  | 'origin'
  | 'rpId'
  | 'presence'
  | 'verification'
  | 'algorithm'
  | 'signature'
  | 'counter'
  | 'user'
export type Checked<T> = ({ ok: true } & T) | { ok: false; why: WhyNot }

const no = (why: WhyNot): { ok: false; why: WhyNot } => ({ ok: false, why })
const sha256 = (data: Uint8Array | string): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest())
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

/** The client data's bytes when it is of this type and for this challenge and origin; else why not. */
function clientData(encoded: string, type: string, e: Expect): Uint8Array | WhyNot {
  const bytes = b64url.decode(encoded)
  if (!bytes) return 'shape'
  let data: unknown
  try {
    data = JSON.parse(utf8.decode(bytes))
  } catch {
    return 'shape'
  }
  if (!isRecord(data) || ![data.type, data.challenge, data.origin].every(v => typeof v === 'string')) return 'shape'
  if (data.type !== type) return 'type'
  if (data.challenge !== e.challenge) return 'challenge'
  if (data.origin !== e.origin) return 'origin'
  return bytes
}

/** The authenticator data when it is for this rpId, with the owner present and verified; else why not. */
function authData(bytes: Uint8Array, rpId: string): AuthData | WhyNot {
  let auth: AuthData
  try {
    auth = parseAuthData(bytes)
  } catch {
    return 'shape'
  }
  if (!sameBytes(auth.rpIdHash, sha256(rpId))) return 'rpId'
  if (!auth.up) return 'presence'
  if (!auth.uv) return 'verification'
  return auth
}

function loads(jwk: JsonWebKey): boolean {
  try {
    createPublicKey({ key: jwk, format: 'jwk' })
    return true
  } catch {
    return false
  }
}

export function verifyRegistration(
  r: { clientDataJSON: string; attestationObject: string },
  e: Expect,
): Checked<{ credential: { id: string; jwk: JsonWebKey; alg: Alg; counter: number; aaguid: string } }> {
  const client = clientData(r.clientDataJSON, 'webauthn.create', e)
  if (typeof client === 'string') return no(client)
  const encoded = b64url.decode(r.attestationObject)
  if (!encoded) return no('shape')
  let object: unknown
  try {
    object = decodeCbor(encoded)
  } catch {
    return no('shape')
  }
  if (!(object instanceof Map) || typeof object.get('fmt') !== 'string') return no('shape')
  const bytes = object.get('authData')
  if (!(bytes instanceof Uint8Array)) return no('shape')
  const auth = authData(bytes, e.rpId)
  if (typeof auth === 'string') return no(auth)
  if (!auth.credential) return no('shape')
  const key = coseKey(auth.credential.key)
  if (!key) return no('algorithm')
  if (!loads(key.jwk)) return no('shape')
  const { id, aaguid } = auth.credential
  return { ok: true, credential: { id: b64url.encode(id), jwk: key.jwk, alg: key.alg, counter: auth.counter, aaguid } }
}

const KTY: Record<Alg, string> = { [-7]: 'EC', [-257]: 'RSA' }

function signedBy(jwk: JsonWebKey, alg: Alg, data: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key =
      alg === -7
        ? { key: jwk, format: 'jwk' as const, dsaEncoding: 'der' as const }
        : { key: jwk, format: 'jwk' as const, padding: constants.RSA_PKCS1_PADDING }
    return verify('sha256', data, key, signature)
  } catch {
    return false
  }
}

export function verifyAssertion(
  a: { id: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null },
  e: Expect,
  stored: { jwk: JsonWebKey; alg: Alg; counter: number; userId: string },
): Checked<{ counter: number }> {
  const client = clientData(a.clientDataJSON, 'webauthn.get', e)
  if (typeof client === 'string') return no(client)
  const bytes = b64url.decode(a.authenticatorData)
  const signature = b64url.decode(a.signature)
  if (!bytes || !signature) return no('shape')
  const auth = authData(bytes, e.rpId)
  if (typeof auth === 'string') return no(auth)
  const kty: string | undefined = KTY[stored.alg] // stored is read back from disk
  if (!kty || kty !== stored.jwk.kty) return no('algorithm')
  const signed = new Uint8Array(bytes.length + 32)
  signed.set(bytes)
  signed.set(sha256(client), bytes.length)
  if (!signedBy(stored.jwk, stored.alg, signed, signature)) return no('signature')
  if (a.userHandle != null && a.userHandle !== stored.userId) return no('user')
  if ((stored.counter !== 0 || auth.counter !== 0) && auth.counter <= stored.counter) return no('counter')
  return { ok: true, counter: auth.counter }
}
