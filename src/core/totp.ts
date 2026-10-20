// The login's second factor: time-based one-time codes (TOTP, RFC 6238), as an authenticator app
// makes them. HMAC-SHA1 over the 30 s step's number, 6 digits; the secret is 20 random bytes,
// shown to the owner in base32 and as an otpauth:// URI in a QR code (core/qr.ts).
// Pure computation (node:crypto for the HMAC and the constant-time compare); the page never
// imports this file.
import { createHmac, timingSafeEqual } from 'node:crypto'

export const TOTP_STEP_MS = 30_000

/** RFC 4648's base32 alphabet. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
/** The most a QR code of core/qr.ts holds (version 10, level M, byte mode). */
const QR_BYTES = 213
const ISSUER = 'Agent board'

/** Base32 without padding, as authenticator apps take a key. */
export function base32(bytes: Uint8Array): string {
  let text = ''
  let acc = 0
  let bits = 0
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xfff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      text += ALPHABET.charAt((acc >> bits) & 31)
    }
  }
  if (bits > 0) text += ALPHABET.charAt((acc << (5 - bits)) & 31)
  return text
}

/** The bytes of a base32 key, case and spaces ignored; null when it holds another character. */
export function base32Bytes(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, '').toUpperCase()
  const bytes = new Uint8Array(Math.floor((clean.length * 5) / 8))
  let acc = 0
  let bits = 0
  let at = 0
  for (const c of clean) {
    const v = ALPHABET.indexOf(c)
    if (v < 0) return null
    acc = ((acc << 5) | v) & 0x1fff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes[at++] = (acc >> bits) & 0xff
    }
  }
  return bytes
}

/** The number of the 30 s step `nowMs` falls in. */
export const totpStep = (nowMs: number): number => Math.floor(nowMs / TOTP_STEP_MS)

/** The code for `step`: HMAC-SHA1 of the step as 8 bytes big-endian, truncated (RFC 4226), zero-padded. */
export function totpCode(secret: Uint8Array, step: number, digits = 6): string {
  const counter = new DataView(new ArrayBuffer(8))
  counter.setUint32(0, Math.floor(step / 2 ** 32))
  counter.setUint32(4, step >>> 0)
  const mac = createHmac('sha1', secret).update(new Uint8Array(counter.buffer)).digest()
  const offset = mac.readUInt8(mac.length - 1) & 0xf
  const value = mac.readUInt32BE(offset) & 0x7fffffff
  return String(value % 10 ** digits).padStart(digits, '0')
}

/** The step a code is for: now's, one before or one after, and later than lastStep; compared in constant time. null otherwise. */
export function totpMatch(secret: Uint8Array, code: unknown, nowMs: number, lastStep: number): number | null {
  if (typeof code !== 'string') return null
  const given = code.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(given)) return null
  const now = totpStep(nowMs)
  const want = Buffer.from(given)
  let match: number | null = null
  // every candidate is compared, so the time taken does not tell which step matched
  for (const step of [now - 1, now, now + 1]) {
    const same = timingSafeEqual(Buffer.from(totpCode(secret, step)), want)
    if (same && step > lastStep && match === null) match = step
  }
  return match
}

/** otpauth://totp/<label>?secret=…&issuer=Agent%20board&algorithm=SHA1&digits=6&period=30, label `Agent board:<domain>`, or `Agent board` when that would pass 213 bytes (core/qr.ts's limit). */
export function totpUri(secretB32: string, domain: string): string {
  const query = `?secret=${secretB32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`
  const uri = (label: string): string => `otpauth://totp/${encodeURIComponent(label)}${query}`
  const withDomain = uri(`${ISSUER}:${domain}`)
  return new TextEncoder().encode(withDomain).length <= QR_BYTES ? withDomain : uri(ISSUER)
}
