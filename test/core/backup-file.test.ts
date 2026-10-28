import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  BackupFileError,
  isBackupKey,
  looksSealed,
  makeKey,
  passphraseFrom,
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

test('a changed byte anywhere or a cut file never opens: damaged with the board’s key, wrong with a passphrase', () => {
  const k = makeKey('correct horse battery', 1, CHEAP)
  const sealed = seal(plain, k)
  assert.equal(
    why(() => unseal(sealed, null, 'wrong horse battery')),
    'wrong',
  )
  const cases: [number, string][] = [
    [2, 'notOurs'], // the magic
    [4, 'wrong'], // logN 10 -> 11: no longer the board's key, the passphrase tried
    [5, 'notOurs'], // r 8 -> 9: not a cost this format writes
    [10, 'wrong'], // the salt
    [30, 'damaged'], // the nonce, under the board's own key
    [40, 'damaged'], // the ciphertext
    [sealed.length - 3, 'damaged'], // the tag
  ]
  for (const [at, expected] of cases) {
    const changed = Buffer.from(sealed)
    changed[at] = (changed[at] ?? 0) ^ 1
    assert.equal(
      why(() => unseal(changed, k, 'correct horse battery')),
      expected,
      `byte ${at}`,
    )
  }
  assert.equal(
    why(() => unseal(sealed.subarray(0, sealed.length - 10), k)),
    'damaged',
  )
})

test('a header asking for a scrypt cost the format never writes is refused at once, never run', () => {
  const k = makeKey('correct horse battery', 1, CHEAP)
  for (const [logN, r, p] of [
    [22, 8, 1],
    [22, 32, 16],
    [17, 32, 1],
    [9, 8, 1],
  ] as const) {
    const forged = Buffer.from(seal(plain, k))
    forged[4] = logN
    forged[5] = r
    forged[6] = p
    const started = performance.now()
    assert.equal(
      why(() => unseal(forged, null, 'correct horse battery')),
      'notOurs',
    )
    assert.ok(performance.now() - started < 200, `${logN} ${r} ${p} ran scrypt`)
  }
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

test('a passphrase file reads the same whatever wrote it: UTF-8 with or without a BOM, UTF-16 as PowerShell 5.1 writes it', () => {
  const pass = 'correct horse · батарея'
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${pass}\r\n`, 'utf16le')])
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`${pass}\n`, 'utf16le').swap16()])
  for (const bytes of [
    Buffer.from(`${pass}\n`),
    Buffer.from(`﻿${pass}\r\n`),
    Buffer.from(`${pass}  \nsecond line`),
    utf16le,
    utf16be,
    Buffer.from(`${pass}\r\n`, 'utf16le'),
  ])
    assert.equal(passphraseFrom(bytes), pass)
})
