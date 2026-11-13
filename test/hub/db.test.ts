// The hub's store (#231): schema and its migrations, the unique active name, invites used once
// in a transaction, and the audit chain.
import { Database } from 'bun:sqlite'
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUDIT_GENESIS, inviteHash, MIGRATIONS, migrate, newInviteCode, openDb } from '../../hub/src/db.ts'

const P1 = 'A'.repeat(43)
const P2 = 'B'.repeat(43)
const P3 = 'C'.repeat(43)
const HOUR = 3_600_000

test('schema: a fresh database has every table, the version and a hub id', () => {
  const db = openDb(':memory:')
  const tables = db.raw
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map(r => r.name)
  for (const t of ['meta', 'peer', 'invite', 'message', 'presence_event', 'audit']) assert.ok(tables.includes(t), t)
  assert.equal(db.schemaVersion(), MIGRATIONS.length)
  assert.match(db.hubId(), /^hub-[0-9a-f]{16}$/)
})

test('a file database keeps its hub id and data across opens, in WAL mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-db-'))
  try {
    const a = openDb(join(dir, 'hub.db'))
    const id = a.hubId()
    const { code } = a.createInvite(1000, HOUR, null)
    assert.equal(a.join(code, P1, 'anna', 2000).ok, true)
    assert.equal(a.raw.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode, 'wal')
    a.close()
    const b = openDb(join(dir, 'hub.db'))
    assert.equal(b.hubId(), id)
    assert.equal(b.peer(P1)?.name, 'anna')
    b.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('migrate: steps run in order from the stored version; a newer database is refused', () => {
  const raw = new Database(':memory:')
  const steps = ['CREATE TABLE a (x)', 'CREATE TABLE b (y)', 'ALTER TABLE a ADD COLUMN z']
  assert.equal(migrate(raw, steps.slice(0, 1)), 1)
  assert.equal(migrate(raw, steps), 3)
  assert.equal(
    raw.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value,
    '3',
  )
  assert.equal(migrate(raw, steps), 3)
  assert.throws(() => migrate(raw, steps.slice(0, 2)), /newer/)
  // A failing step leaves the version where it was.
  const raw2 = new Database(':memory:')
  migrate(raw2, steps.slice(0, 1))
  assert.throws(() => migrate(raw2, [...steps.slice(0, 1), 'NOT SQL']))
  assert.equal(
    raw2.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value,
    '1',
  )
})

test('peers: one active name at a time; a revoked peer frees its name', () => {
  const db = openDb(':memory:')
  const a = db.createInvite(0, HOUR, null)
  const b = db.createInvite(0, HOUR, null)
  const c = db.createInvite(0, HOUR, null)
  assert.deepEqual(db.join(a.code, P1, 'anna', 10), { ok: true })
  assert.deepEqual(db.join(b.code, P2, 'anna', 11), { ok: false, why: 'name_taken' })
  // The refused join left the invite open and made no peer.
  assert.equal(db.peer(P2), null)
  assert.equal(db.invites(12).find(i => i.id === b.id)?.state, 'open')
  assert.equal(db.revokePeer(P1, 20), true)
  assert.equal(db.revokePeer(P1, 21), false)
  assert.equal(db.peer(P1)?.status, 'revoked')
  assert.deepEqual(db.join(b.code, P2, 'anna', 22), { ok: true })
  assert.equal(db.activePeerByName('anna')?.id, P2)
  assert.deepEqual(db.join(c.code, P1, 'again', 23), { ok: false, why: 'known_peer' })
  assert.throws(() =>
    db.raw.query("INSERT INTO peer (id, name, status, created_at) VALUES ('x', 'anna', 'active', 1)").run(),
  )
  db.raw.query("INSERT INTO peer (id, name, status, created_at) VALUES ('y', 'anna', 'revoked', 1)").run()
  assert.throws(() =>
    db.raw.query("INSERT INTO peer (id, name, status, created_at) VALUES ('z', 'q', 'gone', 1)").run(),
  )
})

test('invites: a code works once, only its hash is stored, and it can expire or be revoked', () => {
  const db = openDb(':memory:')
  const inv = db.createInvite(1000, HOUR, 'for ben')
  assert.match(inv.code, /^hab-[a-z2-7]{4}(-[a-z2-7]{4}){5}$/)
  assert.equal(inv.id, inviteHash(inv.code).slice(0, 8))
  assert.equal(inv.expiresAt, 1000 + HOUR)
  const row = db.invites(1001)[0]
  assert.equal(row?.note, 'for ben')
  assert.equal(row?.state, 'open')
  assert.ok(!JSON.stringify(db.raw.query('SELECT * FROM invite').all()).includes(inv.code))
  assert.deepEqual(db.join(inv.code.toUpperCase(), P1, 'anna', 2000), { ok: true })
  assert.equal(db.invites(2001)[0]?.state, 'used')
  assert.equal(db.peer(P1)?.invite_id, inv.id)
  assert.deepEqual(db.join(inv.code, P2, 'ben', 2001), { ok: false, why: 'invite_invalid' })

  const old = db.createInvite(0, 1000, null)
  assert.deepEqual(db.join(old.code, P2, 'ben', 1000), { ok: false, why: 'invite_invalid' })
  assert.equal(db.invites(1000).find(i => i.id === old.id)?.state, 'expired')

  const gone = db.createInvite(0, HOUR, null)
  assert.equal(db.revokeInvite(gone.id, 5), true)
  assert.equal(db.revokeInvite(gone.id, 6), false)
  assert.equal(db.revokeInvite(inv.id, 6), false)
  assert.deepEqual(db.join(gone.code, P3, 'cy', 7), { ok: false, why: 'invite_invalid' })
  assert.deepEqual(db.join('hab-nope', P3, 'cy', 7), { ok: false, why: 'invite_invalid' })
})

test('newInviteCode: 24 base32 characters in groups of four, never the same twice', () => {
  const seen = new Set(Array.from({ length: 200 }, newInviteCode))
  assert.equal(seen.size, 200)
})

test('audit: rows chain by hash; a changed row is found; details are metadata only', () => {
  const db = openDb(':memory:')
  assert.equal(db.auditBroken(), null)
  db.audit(1, null, 'start')
  db.audit(2, P1, 'join', { name: 'anna', invite: 'abcd1234' })
  db.audit(3, P1, 'revoke')
  const rows = db.auditRows()
  assert.equal(rows.length, 3)
  assert.equal(rows[0]?.prev_hash, AUDIT_GENESIS)
  assert.equal(rows[1]?.prev_hash, rows[0]?.hash)
  assert.equal(rows[1]?.detail, '{"invite":"abcd1234","name":"anna"}')
  assert.equal(db.auditBroken(), null)
  db.raw.query("UPDATE audit SET action = 'x' WHERE seq = 2").run()
  assert.equal(db.auditBroken(), 2)
})

test('presence events are recorded', () => {
  const db = openDb(':memory:')
  db.presenceEvent(P1, true, 5)
  db.presenceEvent(P1, false, 9)
  assert.deepEqual(db.raw.query('SELECT state, at FROM presence_event ORDER BY at').all(), [
    { state: 'online', at: 5 },
    { state: 'offline', at: 9 },
  ])
})
