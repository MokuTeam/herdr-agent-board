// The node's active one-time join code (<state>/node/join.json, mode 0600) for claiming a
// computer behind NAT (#513, docs/design/nodes 20.2). Written by the one-command installer and
// deleted on expiry, after 5 wrong claim codes, or on successful claim.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  type HelloJoin,
  JOIN_CODE,
  JOIN_HEX64,
  JOIN_MAX_WRONG,
  type JoinRecord,
  joinProof,
  parseJoinRecord,
  sameJoinCode,
} from '../core/node-join.ts'
import { relayKeyBody } from '../core/relay-texts.ts'
import { replaceFile } from './json-store.ts'
import { nodeDir } from './node-store.ts'
import { generateKey } from './ssh.ts'

export type ClaimAttempt =
  | { ok: true; expiresAt: number }
  | { ok: false; status: 410 }
  | { ok: false; status: 403; remaining: number; ended: boolean }

export interface NodeJoinStore {
  /** The active join record, or null if missing, malformed, expired, or exhausted (cleaning it up). */
  active(): JoinRecord | null
  /** Stores a new join record (mode 0600, attempts = 0). */
  write(rec: { code: string; expiresAt: number }): void
  /** The `node.join` payload for GET /api/hello when active and cert fingerprint is known; null otherwise. */
  hello(nodeId: string, fingerprint: string): HelloJoin | null
  /** Checks a submitted claim code: clears on match (unless clearOnMatch is false) or after JOIN_MAX_WRONG failures. */
  attempt(code: string, opts?: { clearOnMatch?: boolean }): ClaimAttempt
  /** Deletes join.json if present. */
  clear(): void
}

export interface NodeJoinStoreOptions {
  dir?: string
  now?: () => number
}

export function createNodeJoinStore({ dir = nodeDir(), now = Date.now }: NodeJoinStoreOptions = {}): NodeJoinStore {
  const file = join(dir, 'join.json')

  function clear(): void {
    rmSync(file, { force: true })
  }

  function active(): JoinRecord | null {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
    const rec = parseJoinRecord(raw)
    if (!rec || now() >= rec.expiresAt || rec.attempts >= JOIN_MAX_WRONG) {
      clear()
      return null
    }
    return rec
  }

  function save(rec: JoinRecord): void {
    mkdirSync(dir, { recursive: true })
    replaceFile(file, `${JSON.stringify(rec)}\n`, undefined, 0o600)
  }

  return {
    active,
    write({ code, expiresAt }) {
      if (!JOIN_CODE.test(code)) throw new Error('invalid join code')
      if (!Number.isFinite(expiresAt) || expiresAt <= 0) throw new Error('invalid join expiry')
      save({ code, expiresAt, attempts: 0 })
    },
    hello(nodeId, fingerprint) {
      const fp = fingerprint.trim().toLowerCase()
      if (!nodeId || !JOIN_HEX64.test(fp)) return null
      const rec = active()
      if (!rec) return null
      return { fingerprint: fp, proof: joinProof(rec.code, fp, nodeId), expiresAt: rec.expiresAt }
    },
    attempt(code, opts) {
      const rec = active()
      if (!rec) return { ok: false, status: 410 }
      if (typeof code === 'string' && sameJoinCode(code, rec.code)) {
        if (opts?.clearOnMatch !== false) clear()
        return { ok: true, expiresAt: rec.expiresAt }
      }
      const attempts = rec.attempts + 1
      if (attempts >= JOIN_MAX_WRONG) {
        clear()
        return { ok: false, status: 403, remaining: 0, ended: true }
      }
      save({ ...rec, attempts })
      return { ok: false, status: 403, remaining: JOIN_MAX_WRONG - attempts, ended: false }
    },
    clear,
  }
}

/** Stages a fresh relay keypair (`relay-key.next` / `relay-key.next.pub`) in `dir` before rotation. */
export async function stageNodeRelayKey(
  dir = nodeDir(),
): Promise<{ ok: true; publicKey: string } | { ok: false; error: string }> {
  const nextPriv = join(dir, 'relay-key.next')
  const nextPub = `${nextPriv}.pub`
  mkdirSync(dir, { recursive: true })
  rmSync(nextPriv, { force: true })
  rmSync(nextPub, { force: true })
  return await generateKey('agent-board relay node', nextPriv)
}

/**
 * Promotes the staged `relay-key.next` matching `publicKey` into `<dir>/relay-key` (0600).
 * Idempotent if `<dir>/relay-key.pub` already carries `publicKey`.
 */
export function activateNodeRelayKey(
  publicKey: string,
  dir = nodeDir(),
): { ok: true; rotated: boolean } | { ok: false; status: number; error: string } {
  const want = relayKeyBody(publicKey)
  if (!want) return { ok: false, status: 400, error: 'invalid relay public key' }
  const priv = join(dir, 'relay-key')
  const pub = `${priv}.pub`
  const nextPriv = join(dir, 'relay-key.next')
  const nextPub = `${nextPriv}.pub`
  if (existsSync(nextPriv) && existsSync(nextPub)) {
    const body = relayKeyBody(readFileSync(nextPub, 'utf8'))
    if (body === want) {
      chmodSync(nextPriv, 0o600)
      chmodSync(nextPub, 0o600)
      renameSync(nextPriv, priv)
      renameSync(nextPub, pub)
      return { ok: true, rotated: true }
    }
  }
  if (existsSync(priv) && existsSync(pub)) {
    const activeBody = relayKeyBody(readFileSync(pub, 'utf8'))
    if (activeBody === want) return { ok: true, rotated: false }
  }
  return { ok: false, status: 409, error: 'no matching staged relay key' }
}
