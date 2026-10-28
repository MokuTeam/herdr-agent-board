import { Database } from 'bun:sqlite'
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { closeSync, existsSync, openSync, readdirSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DbError,
  damagedMark,
  damageOf,
  dbFile,
  integrityOf,
  migrate,
  openDb,
  replaceContents,
  sqliteAtLeast,
} from '../../src/adapters/db.ts'
import { LATEST, MIGRATIONS } from '../../src/adapters/db-schema.ts'
import { isolatedHome } from '../support/env.ts'

const WRITER = fileURLToPath(new URL('../support/db-writer.ts', import.meta.url))

const problemOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof DbError, String(err))
    return err.problem
  }
  assert.fail('no error')
}

test('nothing makes the file until a store asks for it to be made', () => {
  isolatedHome()
  assert.equal(openDb({ create: false }), null)
  assert.equal(existsSync(dbFile()), false)
  const db = openDb()
  assert.ok(db)
  db.close()
  assert.ok(existsSync(dbFile()))
})

test('a new file is in WAL, at the code’s version, with the settings every connection needs', () => {
  isolatedHome()
  const db = openDb()
  assert.ok(db)
  const one = (sql: string) => Object.values(db.db.query(sql).get() as Record<string, unknown>)[0]
  assert.equal(one('PRAGMA journal_mode'), 'wal')
  assert.equal(one('PRAGMA user_version'), LATEST)
  assert.equal(one('PRAGMA busy_timeout'), 5000)
  assert.equal(one('PRAGMA synchronous'), 2) // FULL
  assert.equal(one('PRAGMA cache_size'), -2000)
  assert.equal(one('PRAGMA mmap_size'), 0)
  db.close()
})

test('a change and its journal row are one transaction: both, or neither', () => {
  isolatedHome()
  const db = openDb()
  assert.ok(db)
  db.db.exec('CREATE TABLE things (id TEXT PRIMARY KEY) STRICT')
  const seq = db.write('user', tx => {
    tx.db.query('INSERT INTO things VALUES (?)').run('a')
    return tx.journal({ store: 'things', op: 'add', ref: 'a', after: { id: 'a' } })
  })
  assert.equal(db.lastChange().seq, seq)
  assert.throws(() =>
    db.write('user', tx => {
      tx.db.query('INSERT INTO things VALUES (?)').run('b')
      tx.journal({ store: 'things', op: 'add', ref: 'b' })
      throw new Error('the store changed its mind')
    }),
  )
  assert.deepEqual(db.db.query('SELECT id FROM things').all(), [{ id: 'a' }])
  assert.equal(db.lastChange().seq, seq, 'the journal row went with the change')
  const row = db.db.query('SELECT by, store, op, ref, before, after FROM journal').get()
  assert.deepEqual(row, { by: 'user', store: 'things', op: 'add', ref: 'a', before: null, after: '{"id":"a"}' })
  assert.equal(db.firstChangeAfter(0), (db.db.query('SELECT at FROM journal').get() as { at: number }).at)
  assert.equal(db.firstChangeAfter(seq), null)
  db.close()
})

test('several processes write at once: every change lands, none waits past busy_timeout', async () => {
  isolatedHome()
  openDb()?.close()
  const writers = Array.from({ length: 4 }, (_, i) =>
    Bun.spawn([process.execPath, WRITER, dbFile(), '40', `w${i}`], { stdout: 'pipe', stderr: 'pipe' }),
  )
  const said = await Promise.all(writers.map(p => new Response(p.stdout).text()))
  await Promise.all(writers.map(p => p.exited))
  assert.deepEqual(
    said.map(s => s.trim()),
    ['ok 40', 'ok 40', 'ok 40', 'ok 40'],
  )
  const db = openDb()
  assert.ok(db)
  assert.equal((db.db.query('SELECT count(*) AS n FROM journal').get() as { n: number }).n, 160)
  db.close()
})

test('processes opening a new file at once take it through its steps once', async () => {
  isolatedHome()
  const openers = Array.from({ length: 4 }, (_, i) =>
    Bun.spawn([process.execPath, WRITER, dbFile(), '1', `o${i}`], { stdout: 'pipe', stderr: 'pipe' }),
  )
  const said = await Promise.all(openers.map(p => new Response(p.stdout).text()))
  assert.deepEqual(
    said.map(s => s.trim()),
    ['ok 1', 'ok 1', 'ok 1', 'ok 1'],
  )
  const db = openDb()
  assert.equal(Object.values(db?.db.query('PRAGMA user_version').get() as object)[0], LATEST)
  db?.close()
})

test('a file newer than the code is read, never changed', () => {
  isolatedHome()
  openDb()?.close()
  const raw = new Database(dbFile())
  raw.exec(`PRAGMA user_version = ${LATEST + 1}`)
  raw.close()
  const db = openDb()
  assert.ok(db?.newer)
  assert.equal(
    problemOf(() => db?.write('user', tx => tx.journal({ store: 's', op: 'o', ref: 'r' }))),
    'newer',
  )
  db?.close()
})

/** Overwrites part of the file: past the header, a damaged page; at the start, not a database. */
function damage(path: string, at: number, length: number): void {
  const fd = openSync(path, 'r+')
  writeSync(fd, Buffer.alloc(length, 0xab), 0, length, at)
  closeSync(fd)
}

test('a damaged file is marked, and from then on every change is refused until a restore', () => {
  isolatedHome()
  const db = openDb()
  assert.ok(db)
  db.db.exec('CREATE TABLE big (v TEXT) STRICT')
  db.write('user', tx => {
    for (let i = 0; i < 400; i++) tx.db.query('INSERT INTO big VALUES (?)').run('x'.repeat(200))
    tx.journal({ store: 'big', op: 'fill', ref: 'all' })
  })
  db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
  damage(dbFile(), 4096 * 3, 4096 * 2)
  const again = openDb()
  assert.ok(again)
  const checked = again.check()
  assert.equal(checked.ok, false)
  assert.ok(existsSync(damagedMark(dbFile())))
  assert.notEqual(damageOf(), null)
  assert.equal(
    problemOf(() => again.write('user', tx => tx.journal({ store: 's', op: 'o', ref: 'r' }))),
    'damaged',
  )
  again.close()
})

test('a file that is no database at all is marked damaged when opened', () => {
  isolatedHome()
  openDb()?.close()
  damage(dbFile(), 0, 100)
  assert.equal(
    problemOf(() => openDb()),
    'damaged',
  )
  assert.notEqual(damageOf(), null)
})

test('copyTo makes a whole copy while the file is open; integrityOf checks one', () => {
  const dir = isolatedHome()
  const db = openDb()
  assert.ok(db)
  db.write('user', tx => tx.journal({ store: 's', op: 'o', ref: 'r' }))
  const copy = join(dir, 'copy.db')
  db.copyTo(copy)
  assert.deepEqual(integrityOf(copy), { ok: true, version: LATEST })
  damage(copy, 0, 64)
  assert.equal(integrityOf(copy).ok, false)
  db.close()
})

test('replaceContents puts a copy’s rows into the live file; other connections stay and see them', () => {
  const dir = isolatedHome()
  const db = openDb()
  const other = openDb()
  assert.ok(db && other)
  db.write('user', tx => tx.journal({ store: 's', op: 'add', ref: 'kept' }))
  const copy = join(dir, 'copy.db')
  db.copyTo(copy)
  db.write('user', tx => tx.journal({ store: 's', op: 'add', ref: 'lost' }))
  const before = db.lastChange().seq
  replaceContents(db, copy, 'user', 'folder/x.abk')
  const refs = (other.db.query('SELECT ref, op FROM journal ORDER BY seq').all() as { ref: string; op: string }[]).map(
    r => `${r.op}:${r.ref}`,
  )
  assert.deepEqual(refs, ['add:kept', 'restore:db'])
  assert.ok(db.lastChange().seq > before, 'the journal goes on, so the backup sees the restore')
  db.close()
  other.close()
})

test('replaceContents refuses a copy newer than the code and clears a damage mark otherwise', () => {
  const dir = isolatedHome()
  const db = openDb()
  assert.ok(db)
  const copy = join(dir, 'copy.db')
  db.copyTo(copy)
  const raw = new Database(copy)
  raw.exec(`PRAGMA user_version = ${LATEST + 1}`)
  raw.close()
  assert.equal(
    problemOf(() => replaceContents(db, copy, 'user', 'x')),
    'newer',
  )
  const good = join(dir, 'good.db')
  db.copyTo(good)
  Bun.write(damagedMark(dbFile()), '{"detail":"x"}')
  replaceContents(db, good, 'user', 'x')
  assert.equal(damageOf(), null)
  db.close()
})

test('a migration copies a file that had steps before it runs the new ones, and keeps the last three copies', () => {
  isolatedHome()
  openDb()?.close()
  const steps = [...MIGRATIONS, { version: LATEST + 1, store: 'test', sql: 'CREATE TABLE extra (v TEXT) STRICT' }]
  const copies = () => readdirSync(join(dbFile(), '..')).filter(f => f.startsWith('board.db.before-v'))
  const raw = new Database(dbFile())
  assert.equal(migrate(raw, dbFile(), steps), false)
  assert.equal(Object.values(raw.query('PRAGMA user_version').get() as object)[0], LATEST + 1)
  assert.deepEqual(raw.query("SELECT name FROM sqlite_master WHERE name = 'extra'").all(), [{ name: 'extra' }])
  assert.equal(copies().length, 1)
  assert.match(copies()[0] as string, /^board\.db\.before-v\d+-\d{8}T\d{6}Z$/)
  // the copy is the file as it was: without the new table
  const copy = new Database(join(dbFile(), '..', copies()[0] as string), { readonly: true })
  assert.deepEqual(copy.query("SELECT name FROM sqlite_master WHERE name = 'extra'").all(), [])
  copy.close()
  raw.close()
})

test('sqliteAtLeast compares versions part by part', () => {
  assert.ok(sqliteAtLeast('3.53.4'))
  assert.ok(sqliteAtLeast('3.37.0'))
  assert.ok(!sqliteAtLeast('3.36.9'))
  assert.ok(!sqliteAtLeast('2.99.99'))
})
