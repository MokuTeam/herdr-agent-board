// The board's own login on disk (core/access.ts has its rules and shapes), four files in the
// state folder, each written through json-store.ts with mode 0o600 and its unknown fields kept:
//   access.json           { "passwordHash": "$argon2id$…" | null,
//                           "totp": { "secret": "<base32 of 20 bytes>", "lastStep": <30 s step> } | null,
//                           "userId": "<base64url WebAuthn user id>" | null,
//                           "lockout": { "failures": <in a row>, "until": <ms> | null } }
//   access-logins.json    [{ "id", "tokenHash": hashToken(token), "method": "password" | "passkey",
//                            "passkeyId"?, "label", "address", "signedInAt", "expiresAt",
//                            "seenAt": <ms> | null }, …]          (core/access.ts's Login; never the token)
//   access-passkeys.json  [{ "id": "<credential id, base64url>", "jwk", "alg": -7 | -257, "counter",
//                            "transports": [], "label", "addedAt", "usedAt": <ms> | null }, …]   (Passkey)
//   access-attempts.json  [{ "at", "address", "label", "method", "reason" }, …]   (Attempt) oldest
//                         first, the 100 newest
// Times are ms since the epoch.
// The TOTP secret is in access.json only. An entry that is not what it says is left out when read.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Attempt, Login, Passkey } from '../core/access.ts'
import { base32Bytes } from '../core/totp.ts'
import { type Guard, isRecord, readJson, updateJson } from './json-store.ts'
import { stateDir } from './paths.ts'

export const accessFile = (): string => join(stateDir(), 'access.json')
export const passkeysFile = (): string => join(stateDir(), 'access-passkeys.json')
export const loginsFile = (): string => join(stateDir(), 'access-logins.json')
export const attemptsFile = (): string => join(stateDir(), 'access-attempts.json')

const ATTEMPTS_KEPT = 100
/** A TOTP secret is 20 bytes. */
const TOTP_BYTES = 20

export interface AccessSecrets {
  passwordHash: string | null
  /** `secret` in base32, as the authenticator app took it. */
  totp: { secret: string; lastStep: number } | null
  userId: string | null
  lockout: { failures: number; until: number | null }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A secret that is not 20 bytes of base32 (an empty one too) is no TOTP. */
function totpOf(v: unknown): AccessSecrets['totp'] {
  if (!isRecord(v) || typeof v.secret !== 'string' || !Number.isSafeInteger(v.lastStep)) return null
  if (base32Bytes(v.secret)?.length !== TOTP_BYTES) return null
  return { secret: v.secret, lastStep: Number(v.lastStep) }
}

function lockoutOf(v: unknown): AccessSecrets['lockout'] {
  const r = isRecord(v) ? v : {}
  return {
    failures: Number.isSafeInteger(r.failures) && Number(r.failures) > 0 ? Number(r.failures) : 0,
    until: num(r.until) ? r.until : null,
  }
}

const secretsOf = (raw: Record<string, unknown> | null): AccessSecrets => ({
  passwordHash: text(raw?.passwordHash),
  totp: totpOf(raw?.totp),
  userId: text(raw?.userId),
  lockout: lockoutOf(raw?.lockout),
})

export const readSecrets = (): AccessSecrets => secretsOf(readJson(accessFile(), isRecord))

/** Changes access.json under its lock; fields it does not know stay. Returns what was saved. */
export function updateSecrets(change: (s: AccessSecrets) => AccessSecrets): AccessSecrets {
  mkdirSync(stateDir(), { recursive: true })
  let saved = secretsOf(null)
  updateJson(
    accessFile(),
    raw => {
      saved = change(secretsOf(raw))
      return { ...raw, ...saved }
    },
    isRecord,
    { mode: 0o600 },
  )
  return saved
}

const isList: Guard<unknown[]> = (v): v is unknown[] => Array.isArray(v)

const isLogin = (v: unknown): v is Login =>
  isRecord(v) &&
  typeof v.id === 'string' &&
  typeof v.tokenHash === 'string' &&
  (v.method === 'password' || v.method === 'passkey') &&
  (v.passkeyId === undefined || typeof v.passkeyId === 'string') &&
  typeof v.label === 'string' &&
  typeof v.address === 'string' &&
  num(v.signedInAt) &&
  num(v.expiresAt) &&
  (v.seenAt === null || num(v.seenAt))

const isPasskey = (v: unknown): v is Passkey =>
  isRecord(v) &&
  typeof v.id === 'string' &&
  isRecord(v.jwk) &&
  (v.alg === -7 || v.alg === -257) &&
  num(v.counter) &&
  Array.isArray(v.transports) &&
  v.transports.every(x => typeof x === 'string') &&
  typeof v.label === 'string' &&
  num(v.addedAt) &&
  (v.usedAt === null || num(v.usedAt))

const isAttempt = (v: unknown): v is Attempt =>
  isRecord(v) &&
  num(v.at) &&
  typeof v.address === 'string' &&
  typeof v.label === 'string' &&
  (v.method === 'password' || v.method === 'passkey') &&
  (v.reason === 'wrong' || v.reason === 'locked' || v.reason === 'limited')

function readList<T>(path: string, is: (v: unknown) => v is T): T[] {
  return (readJson(path, isList) ?? []).filter(is)
}

function updateList<T>(path: string, is: (v: unknown) => v is T, change: (list: T[]) => T[]): T[] {
  mkdirSync(stateDir(), { recursive: true })
  let saved: T[] = []
  updateJson(
    path,
    list => {
      saved = change((list ?? []).filter(is))
      return saved
    },
    isList,
    { mode: 0o600 },
  )
  return saved
}

export const readLogins = (): Login[] => readList(loginsFile(), isLogin)
export const updateLogins = (change: (list: Login[]) => Login[]): Login[] => updateList(loginsFile(), isLogin, change)

export const readPasskeys = (): Passkey[] => readList(passkeysFile(), isPasskey)
export const updatePasskeys = (change: (list: Passkey[]) => Passkey[]): Passkey[] =>
  updateList(passkeysFile(), isPasskey, change)

export const readAttempts = (): Attempt[] => readList(attemptsFile(), isAttempt)

/** Records a failed sign-in; the 100 newest are kept. */
export function addAttempt(a: Attempt): void {
  updateList(attemptsFile(), isAttempt, list => [...list, a].slice(-ATTEMPTS_KEPT))
}

/** Password and TOTP are set up (what `board tunnel on` asks). */
export function accessReady(): boolean {
  const s = readSecrets()
  return s.passwordHash !== null && s.totp !== null
}
