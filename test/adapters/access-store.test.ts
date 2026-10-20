import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import {
  accessFile,
  accessReady,
  addAttempt,
  attemptsFile,
  loginsFile,
  passkeysFile,
  readAttempts,
  readLogins,
  readPasskeys,
  readSecrets,
  updateLogins,
  updatePasskeys,
  updateSecrets,
} from '../../src/adapters/access-store.ts'
import { stateDir } from '../../src/adapters/paths.ts'
import type { Attempt, Login, Passkey } from '../../src/core/access.ts'
import { isolatedHome } from '../support/env.ts'

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const DEFAULTS = { passwordHash: null, totp: null, userId: null, lockout: { failures: 0, until: null } }

const login = (id: string): Login => ({
  id,
  tokenHash: `hash-${id}`,
  method: 'password',
  label: 'Safari on iPad',
  address: '203.0.113.9',
  signedInAt: 1,
  expiresAt: 2,
  seenAt: null,
})
const passkey: Passkey = {
  id: 'cred',
  jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
  alg: -7,
  counter: 0,
  transports: ['internal'],
  label: 'Safari on iPad',
  addedAt: 1,
  usedAt: null,
}
const attempt = (at: number): Attempt => ({
  at,
  address: '203.0.113.9',
  label: 'A browser',
  method: 'password',
  reason: 'wrong',
})

test('nothing written reads as the defaults; every file written is 0o600', () => {
  isolatedHome()
  expect(readSecrets()).toEqual(DEFAULTS)
  expect([readLogins(), readPasskeys(), readAttempts()]).toEqual([[], [], []])
  updateSecrets(s => ({ ...s, passwordHash: '$argon2id$x' }))
  updateLogins(list => [...list, login('a')])
  updatePasskeys(list => [...list, passkey])
  addAttempt(attempt(1))
  expect(readSecrets().passwordHash).toBe('$argon2id$x')
  expect(readLogins()).toEqual([login('a')])
  expect(readPasskeys()).toEqual([passkey])
  expect(readAttempts()).toEqual([attempt(1)])
  if (process.platform !== 'win32')
    for (const file of [accessFile(), loginsFile(), passkeysFile(), attemptsFile()])
      expect([file, statSync(file).mode & 0o777]).toEqual([file, 0o600])
})

test('a hand-added field in access.json survives updateSecrets; a broken file reads as the defaults', () => {
  isolatedHome()
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(accessFile(), JSON.stringify({ note: 'mine', totp: { secret: SECRET, lastStep: 7 } }))
  expect(readSecrets().totp).toEqual({ secret: SECRET, lastStep: 7 })
  updateSecrets(s => ({ ...s, lockout: { failures: 3, until: null } }))
  const saved: unknown = JSON.parse(readFileSync(accessFile(), 'utf8'))
  expect(saved).toMatchObject({ note: 'mine', totp: { secret: SECRET, lastStep: 7 }, lockout: { failures: 3 } })

  writeFileSync(accessFile(), '{"passwordHash": "$argon2id$x", ')
  expect(readSecrets()).toEqual(DEFAULTS)
  writeFileSync(accessFile(), '[1, 2]')
  expect(readSecrets()).toEqual(DEFAULTS)
  writeFileSync(loginsFile(), 'not json')
  expect(readLogins()).toEqual([])
})

test('a TOTP secret that is not 20 bytes in base32 is no TOTP', () => {
  isolatedHome()
  mkdirSync(stateDir(), { recursive: true })
  for (const secret of ['', 'GEZDGNBV', `${SECRET}GE`, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJ1', 42]) {
    writeFileSync(accessFile(), JSON.stringify({ passwordHash: '$argon2id$x', totp: { secret, lastStep: 0 } }))
    expect([secret, readSecrets().totp]).toEqual([secret, null])
    expect(accessReady()).toBe(false)
  }
  writeFileSync(accessFile(), JSON.stringify({ totp: { secret: SECRET } }))
  expect(readSecrets().totp).toBeNull()
})

test('entries that are not what they say are left out', () => {
  isolatedHome()
  mkdirSync(stateDir(), { recursive: true })
  const extra = { ...login('b'), note: 'kept' }
  writeFileSync(loginsFile(), JSON.stringify([login('a'), { id: 'x' }, extra, 'nope']))
  expect(readLogins().map(l => l.id)).toEqual(['a', 'b'])
  // Unknown fields of an entry stay when it is changed.
  updateLogins(list => list.map(l => ({ ...l, seenAt: 5 })))
  expect(JSON.parse(readFileSync(loginsFile(), 'utf8'))[1]).toMatchObject({ id: 'b', note: 'kept', seenAt: 5 })
  writeFileSync(passkeysFile(), JSON.stringify([passkey, { ...passkey, alg: -8 }]))
  expect(readPasskeys()).toEqual([passkey])
})

test('addAttempt keeps the 100 newest', () => {
  isolatedHome()
  for (let at = 1; at <= 105; at++) addAttempt(attempt(at))
  const kept = readAttempts()
  expect(kept).toHaveLength(100)
  expect([kept[0]?.at, kept.at(-1)?.at]).toEqual([6, 105])
})

test('accessReady once both a password hash and a TOTP secret are there', () => {
  isolatedHome()
  expect(accessReady()).toBe(false)
  updateSecrets(s => ({ ...s, passwordHash: '$argon2id$x' }))
  expect(accessReady()).toBe(false)
  updateSecrets(s => ({ ...s, passwordHash: null, totp: { secret: SECRET, lastStep: 0 } }))
  expect(accessReady()).toBe(false)
  updateSecrets(s => ({ ...s, passwordHash: '$argon2id$x' }))
  expect(accessReady()).toBe(true)
})
