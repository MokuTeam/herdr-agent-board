// Self-signed TLS certificate for a node's master door (#512, docs/design/nodes 6.1, 20.1) and
// the master's SHA-256 certificate pinning. Built in pure TypeScript over node:crypto (no external
// openssl binary required on Linux, macOS, or Windows).
import {
  createHash,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { replaceFile } from './json-store.ts'
import { nodeDir } from './paths.ts'

export interface DoorCert {
  cert: string
  key: string
  /** Lowercase 64-character hex SHA-256 of the certificate's DER bytes. */
  fingerprint: string
}

export const doorCertPath = (dir = nodeDir()): string => join(dir, 'door-cert.pem')
export const doorKeyPath = (dir = nodeDir()): string => join(dir, 'door-key.pem')

// ---------------------------------------------------------------- minimal ASN.1 DER X.509 v3 builder

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (let v = n; v > 0; v >>>= 8) bytes.unshift(v & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body])
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts)
const set = (...parts: Buffer[]): Buffer => tlv(0x31, ...parts)

function derInt(bytes: Buffer): Buffer {
  let i = 0
  while (i < bytes.length - 1 && bytes[i] === 0) i++
  let s = bytes.subarray(i)
  if ((s[0] ?? 0) & 0x80) s = Buffer.concat([Buffer.from([0]), s])
  return tlv(0x02, s)
}

const bitString = (bytes: Buffer): Buffer => tlv(0x03, Buffer.from([0]), bytes)
const octetString = (bytes: Buffer): Buffer => tlv(0x04, bytes)
const utf8String = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'))

function oid(nums: readonly number[]): Buffer {
  const out = [(nums[0] ?? 0) * 40 + (nums[1] ?? 0)]
  for (const n of nums.slice(2)) {
    const tmp = [n & 0x7f]
    for (let v = n >>> 7; v > 0; v >>>= 7) tmp.unshift((v & 0x7f) | 0x80)
    out.push(...tmp)
  }
  return tlv(0x06, Buffer.from(out))
}

/** RFC 5280 validity time: UTCTime (0x17) before 2050, GeneralizedTime (0x18) from 2050 on. */
function derTime(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]|\.\d+/g, '')
  if (d.getUTCFullYear() < 2050) return tlv(0x17, Buffer.from(iso.slice(2), 'ascii'))
  return tlv(0x18, Buffer.from(iso, 'ascii'))
}

function toPem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/**
 * Generates an ECDSA P-256 self-signed X.509 v3 certificate for `nodeId` valid for 10 years,
 * with SANs for localhost, 127.0.0.1, and ::1 (what loopback forwards connect to).
 */
export function generateDoorCert(nodeId: string): DoorCert {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  // ecdsa-with-SHA256 (1.2.840.10045.4.3.2)
  const sigAlg = seq(oid([1, 2, 840, 10045, 4, 3, 2]))
  // CN=agent-board-node:<nodeId> (id-at-commonName 2.5.4.3)
  const name = seq(set(seq(oid([2, 5, 4, 3]), utf8String(`agent-board-node:${nodeId}`))))
  const now = Date.now()
  const notBefore = new Date(now - 3600_000)
  const notAfter = new Date(now + 10 * 365 * 86_400_000)
  const serial = randomBytes(16)
  serial[0] = (serial[0] ?? 1) & 0x7f || 1
  // BasicConstraints (2.5.29.19), critical TRUE, CA:FALSE (empty SEQUENCE)
  const basicConstraints = seq(oid([2, 5, 29, 19]), tlv(0x01, Buffer.from([0xff])), octetString(seq()))
  // SubjectAltName (2.5.29.17): DNS:localhost, IP:127.0.0.1, IP:::1
  const sanVal = seq(
    tlv(0x82, Buffer.from('localhost', 'ascii')),
    tlv(0x87, Buffer.from([127, 0, 0, 1])),
    tlv(0x87, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])),
  )
  const san = seq(oid([2, 5, 29, 17]), octetString(sanVal))
  const extensions = tlv(0xa3, seq(basicConstraints, san))
  const tbs = seq(
    tlv(0xa0, derInt(Buffer.from([2]))),
    derInt(serial),
    sigAlg,
    name,
    seq(derTime(notBefore), derTime(notAfter)),
    name,
    spki,
    extensions,
  )
  const sig = createSign('SHA256').update(tbs).sign(privateKey)
  const der = seq(tbs, sigAlg, bitString(sig))
  const cert = toPem('CERTIFICATE', der)
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  return { cert, key, fingerprint: certFingerprint(cert) }
}

/** Lowercase 64-char hex SHA-256 fingerprint of an X.509 certificate PEM. */
export function certFingerprint(certPem: string): string {
  const x509 = new X509Certificate(certPem)
  return createHash('sha256').update(x509.raw).digest('hex')
}

/** Whether `pem` parses as a valid X.509 certificate PEM. */
export function isValidCertPem(pem: string): boolean {
  if (typeof pem !== 'string') return false
  const trimmed = pem.trim()
  if (!trimmed.startsWith('-----BEGIN CERTIFICATE-----')) return false
  try {
    new X509Certificate(trimmed)
    return true
  } catch {
    return false
  }
}

/**
 * Reads an existing door certificate and key from `dir`; null when no cert file is present
 * (including a key-only state left by an interrupted first write, so `ensureDoorCert` can
 * regenerate). Throws if `door-cert.pem` exists without a key, does not parse, or the key does not
 * match the cert, so a pinned door identity is never rotated silently.
 */
export function readDoorCert(dir = nodeDir()): DoorCert | null {
  const cPath = doorCertPath(dir)
  const kPath = doorKeyPath(dir)
  const readOpt = (path: string): string | null => {
    try {
      return readFileSync(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }
  const cert = readOpt(cPath)
  const key = readOpt(kPath)
  if (cert === null) return null
  if (key === null) {
    throw new Error(`door TLS files in ${dir} are incomplete: door-cert.pem exists without door-key.pem`)
  }
  const x509 = new X509Certificate(cert)
  const pubFromKey = createPublicKey(key).export({ type: 'spki', format: 'der' })
  const pubFromCert = x509.publicKey.export({ type: 'spki', format: 'der' })
  if (pubFromKey.length !== pubFromCert.length || !timingSafeEqual(pubFromKey, pubFromCert)) {
    throw new Error(`door TLS key in ${dir} does not match door-cert.pem`)
  }
  return { cert, key, fingerprint: createHash('sha256').update(x509.raw).digest('hex') }
}

/**
 * Loads the node's door cert and key from `dir`, or generates and persists them (mode 0600) when
 * absent.
 */
export function ensureDoorCert(nodeId: string, dir = nodeDir()): DoorCert {
  const existing = readDoorCert(dir)
  if (existing) return existing
  const made = generateDoorCert(nodeId)
  mkdirSync(dir, { recursive: true })
  replaceFile(doorKeyPath(dir), made.key, undefined, 0o600)
  replaceFile(doorCertPath(dir), made.cert, undefined, 0o600)
  return made
}

/**
 * Bun `fetch` TLS options that pin the exact certificate `certPem` (both as trust anchor `ca` and by
 * raw DER SHA-256 comparison in `checkServerIdentity`).
 */
export function pinnedTls(certPem: string): NonNullable<BunFetchRequestInit['tls']> {
  const expected = createHash('sha256').update(new X509Certificate(certPem).raw).digest()
  return {
    ca: certPem,
    rejectUnauthorized: true,
    checkServerIdentity(_host, cert) {
      const raw = (cert as { raw?: Uint8Array } | null | undefined)?.raw
      if (!(raw instanceof Uint8Array)) {
        return Object.assign(new Error('door certificate missing raw DER bytes'), { code: 'ERR_DOOR_CERT_MISMATCH' })
      }
      const got = createHash('sha256').update(raw).digest()
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        return Object.assign(new Error('door certificate does not match the pinned certificate'), {
          code: 'ERR_DOOR_CERT_MISMATCH',
        })
      }
      return undefined
    },
  }
}

const CERT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ERR_DOOR_CERT_MISMATCH',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
])

/**
 * Whether `err` is a TLS certificate verification/pinning failure (vs. a transient socket reset,
 * timeout, or non-TLS port error).
 */
export function isCertError(err: unknown): boolean {
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const obj = cur as { code?: unknown; message?: unknown; cause?: unknown }
    if (typeof obj.code === 'string' && CERT_ERROR_CODES.has(obj.code)) return true
    if (
      typeof obj.message === 'string' &&
      /self signed certificate|certificate.*mismatch|does not match the pinned certificate|door certificate missing raw DER bytes|ERR_DOOR_CERT_MISMATCH/i.test(
        obj.message,
      )
    )
      return true
    cur = obj.cause
  }
  return false
}
