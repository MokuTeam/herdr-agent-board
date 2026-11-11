// Sealing to the boards' box keys (#371): each board's X25519 key, a secret wrapped for several
// boards with one ephemeral key, and AES-256-GCM, all from Web Crypto (Bun's, BoringSSL on every
// platform). Nothing here knows files: a file (core/team-file.ts) is the first user, a message's
// text may be the next. The shape is HPKE's base mode without its labelled KDF: X25519, then
// HKDF-SHA256 over the shared secret with both public keys as the salt and what the secret is for
// as the info, then AES-256-GCM. Keys and nonces come from crypto.getRandomValues unless a test
// hands them in for its known answers.
import { b64u, unb64u } from './team.ts'

/** A board's box key: PKCS#8 and the raw 32-byte public key, both base64url. */
export interface BoxKeyPair {
  pkcs8: string
  pub: string
}

/** One board a secret is wrapped for: its peer id and its box key (verified by the caller). */
export interface BoxRecipient {
  peer: string
  box: string
}

/** A secret wrapped for several boards: the one ephemeral public key, and the wrapped secret per peer. */
export interface Wrapped {
  eph: string
  keys: Record<string, string>
}

export const NONCE_BYTES = 12
export const TAG_BYTES = 16
const KEY_BYTES = 32

/** The DER head of an X25519 private key in PKCS#8 (RFC 8410), before its 32 bytes. */
const PKCS8_HEAD = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
])

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const buf = (b: Uint8Array): BufferSource => b as BufferSource

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n))

/** The bytes one after the other. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A new box key. */
export async function generateBoxKey(): Promise<BoxKeyPair> {
  const k = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.privateKey))
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))
  return { pkcs8: b64u(pkcs8), pub: b64u(pub) }
}

/** The box key of a 32-byte private scalar (RFC 7748), for known answers. */
export async function boxKeyOf(scalar: Uint8Array): Promise<BoxKeyPair> {
  if (scalar.length !== KEY_BYTES) throw new TypeError('boxKeyOf: a scalar is 32 bytes')
  const der = concat(PKCS8_HEAD, scalar)
  const key = await crypto.subtle.importKey('pkcs8', buf(der), { name: 'X25519' }, true, ['deriveBits'])
  const jwk = await crypto.subtle.exportKey('jwk', key)
  if (typeof jwk.x !== 'string') throw new TypeError('boxKeyOf: no public key')
  return { pkcs8: b64u(der), pub: jwk.x }
}

/**
 * X25519 of a private key (PKCS#8, base64url) and a raw public key. Null for a key that does not
 * import, or a public key of low order (an all-zero secret), which would make the secret known.
 */
export async function x25519(pkcs8: string, pub: Uint8Array): Promise<Uint8Array | null> {
  const der = unb64u(pkcs8)
  if (!der || pub.length !== KEY_BYTES) return null
  try {
    const priv = await crypto.subtle.importKey('pkcs8', buf(der), { name: 'X25519' }, false, ['deriveBits'])
    const other = await crypto.subtle.importKey('raw', buf(pub), { name: 'X25519' }, false, [])
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: other }, priv, 256))
    return bits.some(b => b !== 0) ? bits : null
  } catch {
    return null
  }
}

/** HKDF-SHA256 (RFC 5869), extract and expand in one. */
export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length = KEY_BYTES,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) },
      key,
      length * 8,
    ),
  )
}

/** AES-256-GCM: the nonce, then the ciphertext with its tag. `aad` binds it to what it is for. */
export async function seal(
  key: Uint8Array,
  plain: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array = randomBytes(NONCE_BYTES),
): Promise<Uint8Array> {
  if (key.length !== KEY_BYTES || nonce.length !== NONCE_BYTES)
    throw new TypeError('seal: a 32-byte key, a 12-byte nonce')
  const k = await crypto.subtle.importKey('raw', buf(key), 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aad) }, k, buf(plain)),
  )
  return concat(nonce, ct)
}

/** The plaintext of what seal() made with this key and `aad`; null when anything differs by a bit. */
export async function open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array | null> {
  if (key.length !== KEY_BYTES || sealed.length < NONCE_BYTES + TAG_BYTES) return null
  try {
    const k = await crypto.subtle.importKey('raw', buf(key), 'AES-GCM', false, ['decrypt'])
    const iv = sealed.subarray(0, NONCE_BYTES)
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad) },
        k,
        buf(sealed.subarray(NONCE_BYTES)),
      ),
    )
  } catch {
    return null
  }
}

/** What a wrap is for, as its HKDF info and its AAD: the context and the board it is for. */
const wrapInfo = (context: string, peer: string): Uint8Array => enc(`hab-team/1 wrap\n${context}\n${peer}`)

/** The key that wraps a secret for one board: HKDF over the X25519 secret, both public keys as the salt. */
async function kekOf(shared: Uint8Array, eph: Uint8Array, box: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  return hkdf(shared, concat(eph, box), info)
}

/** What a test fixes for its known answers: the ephemeral scalar, and one nonce per recipient in order. */
export interface WrapFixed {
  eph?: Uint8Array
  nonces?: Uint8Array[]
}

/**
 * Wraps `secret` for each recipient with one ephemeral key: per recipient, X25519 with its box,
 * HKDF to a key of its own, AES-256-GCM over the secret. `context` says what the secret is for (a
 * file's blob, a message's id), so a wrapped key is good for that and that board only. Throws on a
 * box that is no key or of low order: the caller verified each one already.
 */
export async function wrapSecret(
  secret: Uint8Array,
  recipients: BoxRecipient[],
  context: string,
  fixed: WrapFixed = {},
): Promise<Wrapped> {
  const eph = fixed.eph ? await boxKeyOf(fixed.eph) : await generateBoxKey()
  const ephPub = unb64u(eph.pub) as Uint8Array
  const keys: Record<string, string> = Object.create(null)
  for (const [i, r] of recipients.entries()) {
    const box = unb64u(r.box)
    const shared = box ? await x25519(eph.pkcs8, box) : null
    if (!box || !shared) throw new TypeError('wrapSecret: a box that is no usable key')
    const info = wrapInfo(context, r.peer)
    const kek = await kekOf(shared, ephPub, box, info)
    keys[r.peer] = b64u(await seal(kek, secret, info, fixed.nonces?.[i]))
  }
  return { eph: eph.pub, keys }
}

/** The secret wrapped for this board (`me`: its peer id and box key), or null when it does not open. */
export async function unwrapSecret(
  wrapped: string,
  eph: string,
  me: { peer: string; box: BoxKeyPair },
  context: string,
): Promise<Uint8Array | null> {
  const sealed = unb64u(wrapped)
  const ephPub = unb64u(eph)
  const mine = unb64u(me.box.pub)
  if (!sealed || !ephPub || !mine) return null
  const shared = await x25519(me.box.pkcs8, ephPub)
  if (!shared) return null
  const info = wrapInfo(context, me.peer)
  return open(await kekOf(shared, ephPub, mine, info), sealed, info)
}
