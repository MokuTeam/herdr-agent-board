import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { type BoardDb, dbFile, openDb } from '../../src/adapters/db.ts'
import {
  addEntry,
  editEntry,
  getEntry,
  importEntries,
  listEntries,
  moveEntry,
  REPEAT_MS,
  removeEntry,
  restoreEntry,
  TimeError,
} from '../../src/adapters/time-store.ts'
import { type Actor, secondsOf, timeConfig } from '../../src/core/time.ts'
import { isolatedHome } from '../support/env.ts'

const WRITER = fileURLToPath(new URL('../support/time-writer.ts', import.meta.url))
const NY = 'America/New_York'
const conf = timeConfig({ zone: NY, clients: { a: { projects: ['Support', 'Migration'] }, b: {} } })
if (!conf) throw new Error('config')
const me: Actor = { key: 's1', name: 'Session one' }
const other: Actor = { key: 's2', name: 'Session two' }

function fresh(): BoardDb {
  isolatedHome()
  const db = openDb()
  assert.ok(db)
  return db
}

const keyOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof TimeError, String(err))
    return err.key
  }
  assert.fail('no error')
}

const at = (iso: string) => Date.parse(iso)
const base = {
  client: 'a',
  project: 'Support',
  description: 'Case 10001 X: work',
  start: at('2026-10-28T13:00:00Z'),
  stop: at('2026-10-28T14:30:00Z'),
  startGiven: true,
}

test('an entry: its work date stamped in the client’s zone, its journal row written with it', () => {
  const db = fresh()
  const late = addEntry(db, conf, { ...base, start: at('2026-10-29T01:30:00Z'), stop: at('2026-10-29T02:00:00Z') }, me)
  assert.equal(late.existing, false)
  assert.equal(late.entry.date, '2026-10-28', '21:30 in New York')
  assert.equal(late.entry.start, '2026-10-29T01:30:00Z')
  assert.deepEqual(late.entry.by, me)
  const row = db.db.query("SELECT store, op, ref FROM journal WHERE store = 'time'").get()
  assert.deepEqual(row, { store: 'time', op: 'add', ref: late.entry.id })
  db.close()
})

test('a repeated add finds the first: alike in client, project, description, start and stop', () => {
  const db = fresh()
  const first = addEntry(db, conf, base, me)
  const again = addEntry(db, conf, { ...base, description: '  Case 10001 X:   work ' }, me)
  assert.equal(again.existing, true)
  assert.equal(again.entry.id, first.entry.id)
  assert.equal(listEntries(db, { from: '2026-10-28', to: '2026-10-28' }).length, 1)
  db.close()
})

test('without a given start, the same session’s entry alike but for its start, made within 15 minutes, is the one', () => {
  const db = fresh()
  const now = Date.now()
  const first = addEntry(db, conf, { ...base, startGiven: false }, me, now)
  const shifted = { ...base, start: base.start + 60_000, stop: base.stop + 60_000, startGiven: false }
  assert.equal(addEntry(db, conf, shifted, me, now + 60_000).entry.id, first.entry.id)
  // another session's, or later than the window: a new entry
  assert.equal(addEntry(db, conf, shifted, other, now + 60_000).existing, false)
  const later = { ...base, start: base.start + 120_000, stop: base.stop + 120_000, startGiven: false }
  assert.equal(addEntry(db, conf, later, me, now + REPEAT_MS + 1000).existing, false)
  db.close()
})

test('several processes adding the same entry at once leave one row', async () => {
  const db = fresh()
  db.close()
  const procs = Array.from({ length: 4 }, (_, i) =>
    Bun.spawn([process.execPath, WRITER, dbFile(), `p${i}`], { stdout: 'pipe', stderr: 'pipe' }),
  )
  const said = (await Promise.all(procs.map(p => new Response(p.stdout).text()))).map(s => s.trim())
  assert.equal(said.filter(s => s.startsWith('new ')).length, 1, said.join(' | '))
  assert.equal(said.filter(s => s.startsWith('existing ')).length, 3, said.join(' | '))
  const again = openDb()
  assert.ok(again)
  assert.equal(listEntries(again, { from: '2026-10-28', to: '2026-10-28' }).length, 1)
  again.close()
})

test('a client that takes no time, or a project it does not have, is refused with what there is', () => {
  const db = fresh()
  assert.equal(
    keyOf(() => addEntry(db, conf, { ...base, client: 'zz' }, me)),
    'time.err.client',
  )
  assert.equal(
    keyOf(() => addEntry(db, conf, { ...base, project: 'Suport' }, me)),
    'time.err.project',
  )
  assert.equal(addEntry(db, conf, { ...base, project: 'New one', newProject: true }, me).existing, false)
  assert.equal(
    addEntry(db, conf, { ...base, client: 'b', project: 'Anything' }, me).existing,
    false,
    'b lists no projects',
  )
  assert.equal(
    keyOf(() => addEntry(db, conf, { ...base, stop: base.start }, me)),
    'time.err.stopBeforeStart',
  )
  assert.equal(
    keyOf(() => addEntry(db, conf, { ...base, description: ' ' }, me)),
    'time.err.noDescription',
  )
  db.close()
})

test('a session changes its own entries; another’s only with force; the owner any', () => {
  const db = fresh()
  const { entry } = addEntry(db, conf, base, me)
  assert.equal(
    keyOf(() => editEntry(db, conf, entry.id, { description: 'Case 10001 X: renamed' }, other)),
    'time.err.notYours',
  )
  const forced = editEntry(db, conf, entry.id, { description: 'Case 10001 X: renamed' }, other, { force: true })
  assert.equal(forced.description, 'Case 10001 X: renamed')
  assert.deepEqual(forced.changedBy, other)
  assert.equal(forced.rev, 2)
  const byOwner = editEntry(db, conf, entry.id, { seconds: 3600 }, 'user')
  assert.equal(secondsOf(byOwner), 3600)
  assert.equal(byOwner.start, entry.start, 'a new duration keeps the start')
  db.close()
})

test('--expect refuses a change to an entry changed since; a repeat of a change changes nothing', () => {
  const db = fresh()
  const { entry } = addEntry(db, conf, base, me)
  const once = editEntry(db, conf, entry.id, { description: 'Case 10001 X: one' }, me, { expect: 1 })
  assert.equal(once.rev, 2)
  assert.equal(
    keyOf(() => editEntry(db, conf, entry.id, { description: 'Case 10001 X: two' }, me, { expect: 1 })),
    'time.err.changedSince',
  )
  const same = editEntry(db, conf, entry.id, { description: 'Case 10001 X: one' }, me)
  assert.equal(same.rev, 2, 'nothing to change, no new revision')
  db.close()
})

test('move: the same wall clock in the client’s zone on the new date, across a month and a DST change', () => {
  const db = fresh()
  const { entry } = addEntry(
    db,
    conf,
    { ...base, start: at('2026-10-31T13:00:00Z'), stop: at('2026-10-31T14:30:00Z') },
    me,
  )
  assert.equal(entry.date, '2026-10-31')
  const moved = moveEntry(db, conf, entry.id, '2026-11-02', me)
  assert.equal(moved.date, '2026-11-02')
  // 09:00 EDT on Oct 31 is 13:00 UTC; 09:00 EST on Nov 2 is 14:00 UTC
  assert.equal(moved.start, '2026-11-02T14:00:00Z')
  assert.equal(secondsOf(moved), 5400)
  assert.deepEqual(listEntries(db, { from: '2026-10-31', to: '2026-10-31' }), [])
  assert.equal(listEntries(db, { from: '2026-11-01', to: '2026-11-30' }).length, 1)
  db.close()
})

test('remove leaves a tombstone out of every list; restore brings it back; a removed one is removed once', () => {
  const db = fresh()
  const { entry } = addEntry(db, conf, base, me)
  const gone = removeEntry(db, entry.id, me)
  assert.ok(gone.deleted)
  assert.equal(removeEntry(db, entry.id, me).rev, gone.rev, 'removing again changes nothing')
  assert.deepEqual(listEntries(db, { from: '2026-10-28', to: '2026-10-28' }), [])
  assert.equal(listEntries(db, { from: '2026-10-28', to: '2026-10-28', deleted: true }).length, 1)
  assert.equal(
    keyOf(() => editEntry(db, conf, entry.id, { description: 'x' }, me)),
    'time.err.removed',
  )
  // the same entry may be logged again while the first is removed; the first then cannot come back
  const second = addEntry(db, conf, base, me)
  assert.equal(second.existing, false)
  assert.equal(
    keyOf(() => restoreEntry(db, entry.id, 'user')),
    'time.err.sameAs',
  )
  removeEntry(db, second.entry.id, me)
  const back = restoreEntry(db, entry.id, 'user')
  assert.equal(back.deleted, undefined)
  db.close()
})

test('the import skips what is there by Toggl id, removed entries included, and entries alike', () => {
  const db = fresh()
  const rows = [
    { ...base, toggl: '101', tags: ['Deferred'] },
    { ...base, start: base.start + 7_200_000, stop: base.stop + 7_200_000, toggl: '102' },
  ]
  assert.deepEqual(importEntries(db, conf, rows), { added: 2, already: 0 })
  const imported = listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
  assert.deepEqual(imported[0]?.tags, ['deferred'])
  assert.equal(imported[0]?.by, 'import')
  removeEntry(db, imported[0]?.id as string, 'user')
  assert.deepEqual(importEntries(db, conf, rows), { added: 0, already: 2 })
  assert.equal(
    getEntry(db, imported[0]?.id as string)?.deleted !== undefined,
    true,
    'a removed one is not brought back',
  )
  db.close()
})
