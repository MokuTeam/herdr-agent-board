// The hub's retention (#231): what is older than keep-days goes, per table; what waits, and every
// peer, stays; the audit chain still verifies from its anchor; a v1 database opens and prunes.
import { Database } from 'bun:sqlite'
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type HubDb, MIGRATIONS, MIN_KEEP_DAYS, type NewMessage, openDb } from '../../hub/src/db.ts'
import { createHub, PRUNE_MS } from '../../hub/src/hub.ts'
import { fakeClock, startHarness } from './harness.ts'

const P1 = 'A'.repeat(43)
const P2 = 'B'.repeat(43)
const DAY = 86_400_000
const NOW = 1_700_000_000_000 + 200 * DAY
const KEEP = 90
const CUT = NOW - KEEP * DAY
const OLD = CUT - DAY
const NEW = CUT + DAY

let n = 0
const msg = (db: HubDb, created: number): string => {
  const m: NewMessage = {
    id: `m${++n}`,
    v: 1,
    from_peer: P1,
    to_peer: P2,
    kind: 'question',
    reply_to: null,
    created_at: created,
    expires_at: created + DAY,
    size: 10,
    body_hash: 'h',
    payload: '{}',
  }
  db.insertMessage(m)
  return m.id
}
const count = (db: HubDb, table: string): number =>
  db.raw.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? -1
const ids = (db: HubDb) =>
  db.raw
    .query<{ id: string }, []>('SELECT id FROM message ORDER BY rowid')
    .all()
    .map(r => r.id)

test('messages: acked and expired older than keep-days go, newer stay, queued and delivered never', () => {
  const db = openDb(':memory:')
  const ackedOld = msg(db, OLD - DAY)
  db.markAcked(ackedOld, OLD, '{}')
  const ackedNew = msg(db, NEW - DAY)
  db.markAcked(ackedNew, NEW, '{}')
  const expiredOld = msg(db, OLD - 2 * DAY)
  const expiredNew = msg(db, NEW - 2 * DAY)
  db.expireDue(OLD) // only expiredOld (expires OLD - DAY) is due here
  db.expireDue(NEW + 2 * DAY)
  assert.equal(db.message(expiredNew)?.state, 'expired')
  // An old message that is still waiting, however old.
  const queued = msg(db, 1000)
  const delivered = msg(db, 2000)
  db.markDelivered(delivered, 3000)
  db.raw.query('UPDATE message SET expires_at = ? WHERE id IN (?, ?)').run(NOW + DAY, queued, delivered)
  assert.deepEqual(db.prune(CUT), { messages: 2, presence: 0, invites: 0, audit: 0 })
  assert.deepEqual(ids(db), [ackedNew, expiredNew, queued, delivered])
  assert.equal(db.message(expiredOld), null)
  assert.equal(db.message(ackedOld), null)
  assert.equal(db.prune(CUT).messages, 0)
})

test('presence events older than keep-days go', () => {
  const db = openDb(':memory:')
  db.presenceEvent(P1, true, OLD)
  db.presenceEvent(P1, false, OLD)
  db.presenceEvent(P1, true, NEW)
  assert.equal(db.prune(CUT).presence, 2)
  assert.deepEqual(
    db.raw
      .query<{ at: number }, []>('SELECT at FROM presence_event')
      .all()
      .map(r => r.at),
    [NEW],
  )
})

test('invites: used, revoked and expired go when old; open and recent ones stay; peers always stay', () => {
  const db = openDb(':memory:')
  const used = db.createInvite(OLD - 2 * DAY, DAY, null)
  assert.equal(db.join(used.code, P1, 'anna', OLD - 2 * DAY + 1000).ok, true)
  const revoked = db.createInvite(OLD - 2 * DAY, 30 * DAY, null)
  assert.equal(db.revokeInvite(revoked.id, OLD), true)
  const expired = db.createInvite(OLD - 2 * DAY, DAY, null)
  const usedNew = db.createInvite(NEW - DAY, 3 * DAY, null)
  assert.equal(db.join(usedNew.code, P2, 'ben', NEW).ok, true)
  const open = db.createInvite(NOW - DAY, 30 * DAY, null)
  const expiredNew = db.createInvite(NEW - 2 * DAY, DAY, null)
  assert.equal(db.prune(CUT).invites, 3)
  assert.deepEqual(
    db
      .invites(NOW)
      .map(i => i.id)
      .sort(),
    [usedNew.id, open.id, expiredNew.id].sort(),
  )
  assert.equal(expired.id.length, 8)
  assert.deepEqual(
    db.peers().map(p => p.name),
    ['anna', 'ben'],
  )
})

test('audit: old rows go, the chain verifies from the anchor, tampering is still found', () => {
  const db = openDb(':memory:')
  db.audit(OLD - 1000, null, 'start')
  db.audit(OLD, P1, 'join', { name: 'anna' })
  db.audit(NEW, P1, 'send', { id: 'x' })
  db.audit(NEW + 1000, P1, 'ack', { id: 'x' })
  const before = db.auditRows()
  assert.equal(db.prune(CUT).audit, 2)
  assert.deepEqual(db.auditAnchor(), { seq: 2, hash: (before[1] as { hash: string }).hash })
  assert.deepEqual(
    db.auditRows().map(r => r.seq),
    [3, 4],
  )
  assert.equal(db.auditBroken(), null)
  db.audit(NEW + 2000, null, 'later')
  assert.equal(db.auditBroken(), null)
  db.raw.query("UPDATE audit SET action = 'x' WHERE seq = 4").run()
  assert.equal(db.auditBroken(), 4)
  db.raw.query("UPDATE audit SET action = 'ack' WHERE seq = 4").run()
  db.raw.query('UPDATE audit SET prev_hash = ? WHERE seq = 3').run('f'.repeat(64))
  assert.equal(db.auditBroken(), 3)
  // Pruned a second time, the anchor moves on.
  db.raw.query('UPDATE audit SET prev_hash = ? WHERE seq = 3').run((before[1] as { hash: string }).hash)
  assert.equal(db.auditBroken(), null)
  assert.equal(db.prune(NEW + 1500).audit, 2)
  assert.equal(db.auditAnchor()?.seq, 4)
  assert.equal(db.auditBroken(), null)
})

test('audit: pruning every row still lets the next one chain from the anchor', () => {
  const db = openDb(':memory:')
  db.audit(OLD, null, 'start')
  assert.equal(db.prune(CUT).audit, 1)
  assert.deepEqual(db.auditRows(), [])
  db.audit(NOW, null, 'again')
  assert.equal(db.auditBroken(), null)
  assert.equal(db.auditRows()[0]?.prev_hash, db.auditAnchor()?.hash)
})

test('hub: the pass runs once an hour on the clock, audits its counts, and --keep-days below 8 is refused', () => {
  const db = openDb(':memory:')
  const clock = fakeClock(NOW)
  const logs: string[] = []
  for (const bad of [0, 7, 7.5, Number.NaN])
    assert.throws(() => createHub({ db, clock, log: () => {}, keepDays: bad }), /keep-days/)
  assert.equal(MIN_KEEP_DAYS, 8)
  const hub = createHub({ db, clock, log: m => logs.push(m), keepDays: KEEP })
  db.presenceEvent(P1, true, OLD)
  clock.tick(PRUNE_MS - 1)
  assert.equal(count(db, 'presence_event'), 1)
  clock.tick(1)
  assert.equal(count(db, 'presence_event'), 0)
  const row = db.auditRows().at(-1)
  assert.equal(row?.action, 'prune')
  assert.deepEqual(JSON.parse(row?.detail ?? ''), { audit: 0, invites: 0, keep_days: KEEP, messages: 0, presence: 1 })
  // A pass with nothing to delete leaves no audit row.
  const rows = db.auditRows().length
  clock.tick(PRUNE_MS)
  assert.equal(db.auditRows().length, rows)
  assert.equal(db.auditBroken(), null)
  hub.stop()
  assert.equal(clock.timers(), 0)
})

test('hub: the default keeps 90 days; prune() on demand answers the counts', async () => {
  const h = await startHarness()
  try {
    h.db.presenceEvent(P1, true, h.clock.now() - 89 * DAY)
    h.db.presenceEvent(P1, true, h.clock.now() - 91 * DAY)
    assert.deepEqual(h.hub.prune(), { messages: 0, presence: 1, invites: 0, audit: 0 })
  } finally {
    h.stop()
  }
})

test('a v1 database opens, keeps its data, and prunes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-ret-'))
  try {
    const path = join(dir, 'hub.db')
    const raw = new Database(path, { create: true, strict: true })
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    raw.exec(MIGRATIONS[0] as string)
    raw.query("INSERT INTO meta VALUES ('schema_version', '1'), ('hub_id', 'hub-0123456789abcdef')").run()
    raw.query("INSERT INTO presence_event VALUES (?, 'online', ?), (?, 'online', ?)").run(P1, OLD, P1, NEW)
    raw.close()
    const db = openDb(path)
    assert.equal(db.schemaVersion(), MIGRATIONS.length)
    assert.equal(db.hubId(), 'hub-0123456789abcdef')
    assert.equal(db.prune(CUT).presence, 1)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
