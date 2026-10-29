// A snapshot as it leaves this computer (#233): gzip, then AES-256-GCM under a key made from the
// owner's passphrase with scrypt. The file says how its key was made (scrypt's cost and salt), so
// a passphrase alone opens it on a new computer; the board keeps the key itself (backup-key.json),
// never the passphrase, so a routine snapshot asks for nothing and costs no scrypt. GCM's tag
// covers the header too: a file cut short or changed anywhere fails to open instead of restoring
// something else.
//
//   "ABK1" | logN (1 byte) | r (1) | p (1) | salt (16) | nonce (12) | ciphertext | tag (16)
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

const MAGIC = Buffer.from('ABK1', 'ascii')
const HEADER = 4 + 3 + 16 + 12
const TAG = 16

/** scrypt's cost: N = 2^17, r = 8, p = 1 (about 0.25 s and 128 MB, only when a key is made or a passphrase opens a file). */
export const KDF = { logN: 17, r: 8, p: 1 } as const
/** The lowest N a file may name (2^10: the tests' cheap keys); anything outside [MIN_LOG_N, KDF.logN] is refused. */
export const MIN_LOG_N = 10

/** The key the board keeps, and how it was made from the passphrase. */
export interface BackupKey {
  v: 1
  logN: number
  r: number
  p: number
  /** base64 */
  salt: string
  /** base64, 32 bytes */
  key: string
  /** When the passphrase was set. */
  made: number
}

export class BackupFileError extends Error {
  constructor(readonly why: 'notOurs' | 'needPassphrase' | 'wrong' | 'damaged') {
    super(`backup.file.${why}`)
    this.name = 'BackupFileError'
  }
}

function derive(passphrase: string, salt: Buffer, logN: number, r: number, p: number): Buffer {
  return scryptSync(passphrase.normalize('NFC'), salt, 32, { N: 2 ** logN, r, p, maxmem: 2 ** logN * r * 256 })
}

/** A new key from a passphrase, with a fresh salt. */
export function makeKey(
  passphrase: string,
  now: number = Date.now(),
  cost: { logN: number; r: number; p: number } = KDF,
): BackupKey {
  const salt = randomBytes(16)
  const key = derive(passphrase, salt, cost.logN, cost.r, cost.p)
  return { v: 1, ...cost, salt: salt.toString('base64'), key: key.toString('base64'), made: now }
}

export function isBackupKey(v: unknown): v is BackupKey {
  if (typeof v !== 'object' || v === null) return false
  const k = v as Record<string, unknown>
  return (
    k.v === 1 &&
    [k.logN, k.r, k.p].every(n => Number.isInteger(n) && (n as number) > 0 && (n as number) < 256) &&
    typeof k.salt === 'string' &&
    Buffer.from(k.salt, 'base64').length === 16 &&
    typeof k.key === 'string' &&
    Buffer.from(k.key, 'base64').length === 32 &&
    typeof k.made === 'number'
  )
}

/** The snapshot's bytes, packed and sealed with the key. */
export function seal(plain: Uint8Array, k: BackupKey): Buffer {
  const header = Buffer.concat([MAGIC, Buffer.from([k.logN, k.r, k.p]), Buffer.from(k.salt, 'base64'), randomBytes(12)])
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(k.key, 'base64'), header.subarray(23, HEADER))
  cipher.setAAD(header)
  const body = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()])
  return Buffer.concat([header, body, cipher.getAuthTag()])
}

/** Whether the bytes start as a sealed snapshot does. */
export const looksSealed = (file: Uint8Array): boolean =>
  file.length >= HEADER + TAG && Buffer.from(file.subarray(0, 4)).equals(MAGIC)

/**
 * The snapshot's bytes out of a sealed file: with the board's key when the file was sealed with it
 * (same salt and cost), else with `passphrase`. Throws BackupFileError: not a snapshot of ours, a
 * passphrase needed, or the passphrase wrong (or the file changed: GCM cannot tell the two apart).
 */
export function unseal(file: Uint8Array, k: BackupKey | null, passphrase: string | null = null): Buffer {
  if (!looksSealed(file)) throw new BackupFileError('notOurs')
  const buf = Buffer.from(file)
  const header = buf.subarray(0, HEADER)
  const [logN, r, p] = [header[4] ?? 0, header[5] ?? 0, header[6] ?? 0]
  const salt = header.subarray(7, 23)
  const nonce = header.subarray(23, HEADER)
  let key: Buffer
  const ownSalt = k ? Buffer.from(k.salt, 'base64') : null
  const own = !!(
    k &&
    ownSalt &&
    ownSalt.length === salt.length &&
    timingSafeEqual(ownSalt, salt) &&
    k.logN === logN &&
    k.r === r &&
    k.p === p
  )
  if (own && k) key = Buffer.from(k.key, 'base64')
  else if (passphrase !== null) {
    // only the cost this format writes (KDF; a lower N for the tests): a header asking for more is
    // a file made to hang the restore (scrypt at N=2^22, r=32 wants gigabytes), not a snapshot of ours
    if (logN < MIN_LOG_N || logN > KDF.logN || r !== KDF.r || p !== KDF.p) throw new BackupFileError('notOurs')
    key = derive(passphrase, salt, logN, r, p)
  } else throw new BackupFileError('needPassphrase')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(header)
    decipher.setAuthTag(buf.subarray(buf.length - TAG))
    const packed = Buffer.concat([decipher.update(buf.subarray(HEADER, buf.length - TAG)), decipher.final()])
    return gunzipSync(packed)
  } catch {
    // the board's own key matched the file's header, so the file itself is damaged; a typed
    // passphrase cannot tell a wrong one from a changed file
    throw new BackupFileError(own ? 'damaged' : 'wrong')
  }
}

/**
 * A passphrase file's first line, whatever wrote it: UTF-8 with or without a BOM, or UTF-16 (what
 * PowerShell 5.1's `>` writes, told by its BOM or by its zero bytes). The line ending and the
 * spaces at its end off.
 */
export function passphraseFrom(bytes: Buffer): string {
  let text: string
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString('utf16le')
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = Buffer.from(bytes.subarray(2)).swap16().toString('utf16le')
  else if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0) text = bytes.toString('utf16le')
  else text = bytes.toString('utf8').replace(/^﻿/, '')
  return (text.split(/\r?\n/)[0] ?? '').trimEnd()
}
