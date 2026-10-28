import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  BackupFileError,
  isBackupKey,
  looksSealed,
  makeKey,
  passphraseMatches,
  seal,
  unseal,
} from '../../src/core/backup-file.ts'

// a cheap scrypt for the tests; the board's own cost is KDF
const CHEAP = { logN: 10, r: 8, p: 1 }
const plain = Buffer.concat([Buffer.from('SQLite format 3\0'), randomBytes(5000)])

const why = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof BackupFileError)
    return err.why
  }
  assert.fail('it opened')
}

test('a sealed snapshot opens with the board key, and with the passphrase alone on a new computer', () => {
  const k = makeKey('correct horse battery', 1, CHEAP)
  assert.ok(isBackupKey(k))
  const sealed = seal(plain, k)
  assert.ok(looksSealed(sealed))
  assert.ok(!sealed.includes(plain.subarray(0, 16)), 'the database is not readable in the file')
  assert.deepEqual(unseal(sealed, k), plain)
  assert.deepEqual(unseal(sealed, null, 'correct horse battery'), plain)
  // two seals of the same bytes differ (a fresh nonce each time)
  assert.notDeepEqual(seal(plain, k), sealed)
})

test('a wrong passphrase, a changed byte anywhere, or a cut file fail as wrong', () => {
  const k = makeKey('correct horse battery', 1, CHEAP)
  const sealed = seal(plain, k)
  assert.equal(
    why(() => unseal(sealed, null, 'wrong horse battery')),
    'wrong',
  )
  for (const at of [5, 10, 30, 40, sealed.length - 3]) {
    const changed = Buffer.from(sealed)
    changed[at] = (changed[at] ?? 0) ^ 1
    assert.equal(
      why(() => unseal(changed, k, 'correct horse battery')),
      at < 7 ? (at < 4 ? 'notOurs' : 'wrong') : 'wrong',
      `byte ${at}`,
    )
  }
  assert.equal(
    why(() => unseal(sealed.subarray(0, sealed.length - 10), k)),
    'wrong',
  )
})

test('a snapshot sealed with another key needs its passphrase; a file that is not one is not ours', () => {
  const old = makeKey('the old passphrase', 1, CHEAP)
  const now = makeKey('the new passphrase', 2, CHEAP)
  const sealed = seal(plain, old)
  assert.equal(
    why(() => unseal(sealed, now)),
    'needPassphrase',
  )
  assert.deepEqual(unseal(sealed, now, 'the old passphrase'), plain)
  assert.equal(
    why(() => unseal(Buffer.from('not a snapshot at all, just text'), now)),
    'notOurs',
  )
})

test('passphraseMatches tells the passphrase the key was made from', () => {
  const k = makeKey('correct horse battery', 1, CHEAP)
  assert.ok(passphraseMatches('correct horse battery', k))
  assert.ok(!passphraseMatches('correct horse batterY', k))
})
