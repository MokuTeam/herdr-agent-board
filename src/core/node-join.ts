// Join codes and HMAC proofs for claiming a computer behind NAT (#513, docs/design/nodes 20.2).
// Pure computation + node:crypto; never imported by web/.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { RELAY_KEY_NAME } from './relay-texts.ts'

/** How long a join code and its enrolled relay key live before expiry (10 minutes). */
export const JOIN_TTL_MS = 10 * 60_000

/** How many wrong claim codes end the active join code. */
export const JOIN_MAX_WRONG = 5

/** A join code: URL-safe token of 16..128 characters. */
export const JOIN_CODE = /^[A-Za-z0-9_-]{16,128}$/

/** Lower-case SHA-256 hex digest (cert fingerprint or HMAC proof). */
export const JOIN_HEX64 = /^[0-9a-f]{64}$/

export interface JoinRecord {
  code: string
  expiresAt: number
  attempts: number
}

export interface HelloJoin {
  fingerprint: string
  proof: string
  expiresAt: number
}

/** Generates a 192-bit URL-safe one-time join code. */
export function generateJoinCode(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * Generates a unique relay socket name matching RELAY_KEY_NAME (`^[a-z0-9][a-z0-9-]{0,63}$`).
 * A short sanitized prefix from `hint` helps humans tell sockets apart without colliding.
 */
export function generateSocketName(hint = 'node'): string {
  const clean = hint
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .replace(/-+$/, '')
  const prefix = clean && /^[a-z0-9]/.test(clean) ? clean : 'node'
  const name = `${prefix}-${randomBytes(6).toString('hex')}`
  return RELAY_KEY_NAME.test(name) ? name : `node-${randomBytes(6).toString('hex')}`
}

/**
 * Computes the HMAC-SHA256 proof a node returns in GET /api/hello (`node.join.proof`):
 * binds the join code to the door's TLS certificate fingerprint and the node's id so a relay
 * server or impostor holding another cert or socket cannot pass verification.
 */
export function joinProof(code: string, fingerprint: string, nodeId: string): string {
  const fp = fingerprint.trim().toLowerCase()
  return createHmac('sha256', code).update(`agent-board-node-join-v1\n${fp}\n${nodeId}`).digest('hex')
}

/** Constant-time verification of a hello proof against the expected join code, cert fingerprint, and node id. */
export function verifyJoinProof(code: string, fingerprint: string, nodeId: string, proof: string): boolean {
  if (!JOIN_CODE.test(code)) return false
  const fp = fingerprint.trim().toLowerCase()
  const got = proof.trim().toLowerCase()
  if (!JOIN_HEX64.test(fp) || !JOIN_HEX64.test(got)) return false
  const expected = joinProof(code, fp, nodeId)
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(got, 'hex'))
}

/** Constant-time equality for two join codes (hashes compared so differing lengths leak nothing). */
export function sameJoinCode(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validates a join.json record on disk; returns null if malformed. */
export function parseJoinRecord(raw: unknown): JoinRecord | null {
  if (!isObj(raw)) return null
  if (typeof raw.code !== 'string' || !JOIN_CODE.test(raw.code)) return null
  if (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt) || raw.expiresAt <= 0) return null
  if (!Number.isInteger(raw.attempts) || (raw.attempts as number) < 0) return null
  return { code: raw.code, expiresAt: raw.expiresAt, attempts: raw.attempts as number }
}

/** Validates `hello.node.join` received from a node door; returns null if missing or malformed. */
export function parseHelloJoin(raw: unknown): HelloJoin | null {
  if (!isObj(raw)) return null
  if (typeof raw.fingerprint !== 'string' || typeof raw.proof !== 'string') return null
  const fingerprint = raw.fingerprint.trim().toLowerCase()
  const proof = raw.proof.trim().toLowerCase()
  if (!JOIN_HEX64.test(fingerprint) || !JOIN_HEX64.test(proof)) return null
  if (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt) || raw.expiresAt <= 0) return null
  return { fingerprint, proof, expiresAt: raw.expiresAt }
}
