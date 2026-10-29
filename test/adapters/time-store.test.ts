import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { type BoardDb, dbFile, openDb } from '../../src/adapters/db.ts'
import {
  addEntry,
  editEntry,
  getEntry,
  ImportIndex,
  type ImportRow,
  importEntries,
  importVerdict,
  listEntries,
  moveEntry,
  REPEAT_MS,
  raiseEntry,
  removeEntry,
  restoreEntry,
  TimeError,
} from '../../src/adapters/time-store.ts'
import { type Actor, secondsOf, timeConfig } from '../../src/core/time.ts'
import { isolatedHome } from '../support/env.ts'

const WRITER = fileURLToPath(new URL('../support/time-writer.ts', import.meta.url))
const HOLDER = fileURLToPath(new URL('../support/time-holder.ts', import.meta.url))
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
  const repeat = addEntry(db, conf, shifted, me, now + 60_000)
  assert.equal(repeat.entry.id, first.entry.id)
  assert.equal(repeat.reason, 'repeat-window', 'said, so a real second block can be told')
  // the same session after its name changed (or read as its key's first characters): the same one
  const renamed = { key: me.key, name: 's1abcdef' }
  assert.equal(addEntry(db, conf, shifted, renamed, now + 90_000).entry.id, first.entry.id)
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
  assert.deepEqual(importEntries(db, conf, rows), { added: 2, already: 0, changed: [], updated: [] })
  const imported = listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
  assert.deepEqual(imported[0]?.tags, ['deferred'])
  assert.equal(imported[0]?.by, 'import')
  removeEntry(db, imported[0]?.id as string, 'user')
  assert.deepEqual(importEntries(db, conf, rows), { added: 0, already: 2, changed: [], updated: [] })
  assert.equal(
    getEntry(db, imported[0]?.id as string)?.deleted !== undefined,
    true,
    'a removed one is not brought back',
  )
  db.close()
})

const csvRow = (o: Partial<ImportRow> = {}): ImportRow => ({
  client: 'a',
  project: 'Support',
  description: 'Case 10001 X: work',
  tags: [],
  start: at('2026-10-28T13:00:00Z'),
  stop: at('2026-10-28T14:00:00Z'),
  ...o,
})

test('a CSV row edited in Toggl since its import is found by its lane and start: changed, listed, never a second entry', () => {
  const db = fresh()
  assert.equal(importEntries(db, conf, [csvRow()]).added, 1)
  const [stored] = listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
  for (const [o, fields] of [
    [{ description: 'Case 10001 X: work, worded better' }, ['description']],
    [{ stop: at('2026-10-28T13:45:00Z') }, ['stop']],
    [{ project: 'Migration' }, ['project']],
    [{ tags: ['deferred'] }, ['tags']],
  ] as const) {
    const r = importEntries(db, conf, [csvRow(o as Partial<ImportRow>)])
    assert.deepEqual(
      [r.added, r.already, r.changed.map(c => [c.id, c.fields])],
      [0, 0, [[stored?.id, fields]]],
      JSON.stringify(o),
    )
  }
  assert.equal(listEntries(db, { from: '2026-10-28', to: '2026-10-28' }).length, 1)
  // the same row again: already there
  assert.deepEqual(importEntries(db, conf, [csvRow()]), { added: 0, already: 1, changed: [], updated: [] })
  // a dry run sees the same, writing nothing
  assert.deepEqual(
    importVerdict(new ImportIndex(db), conf, csvRow({ stop: at('2026-10-28T13:45:00Z') })).kind,
    'changed',
  )
  assert.deepEqual(importVerdict(new ImportIndex(null), conf, csvRow()).kind, 'new')
  db.close()
})

test('--update takes Toggl’s values only for an entry the board never changed, journaled as its own', () => {
  const db = fresh()
  importEntries(db, conf, [csvRow(), csvRow({ start: at('2026-10-28T16:00:00Z'), stop: at('2026-10-28T17:00:00Z') })])
  const [mine, touched] = listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
  editEntry(db, conf, touched?.id as string, { description: 'Case 10002 Y: as the owner put it' }, 'user')
  const r = importEntries(
    db,
    conf,
    [
      csvRow({ stop: at('2026-10-28T14:15:00Z'), tags: ['Deferred'] }),
      csvRow({ start: at('2026-10-28T16:00:00Z'), stop: at('2026-10-28T17:30:00Z') }),
    ],
    { update: true },
  )
  assert.deepEqual(
    r.updated.map(c => [c.id, c.fields]),
    [[mine?.id, ['stop', 'tags']]],
  )
  assert.deepEqual(
    r.changed.map(c => c.id),
    [touched?.id],
    'changed on the board: listed, not overwritten',
  )
  const after = getEntry(db, mine?.id as string)
  assert.equal(after?.stop, '2026-10-28T14:15:00Z')
  assert.deepEqual(after?.tags, ['deferred'])
  assert.equal(after?.rev, 2)
  assert.equal(getEntry(db, touched?.id as string)?.description, 'Case 10002 Y: as the owner put it')
  const ops = db.db.query("SELECT op FROM journal WHERE store = 'time' ORDER BY seq").all() as { op: string }[]
  assert.deepEqual(
    ops.map(o => o.op),
    ['import', 'import', 'edit', 'import-update'],
  )
  db.close()
})

test('nothing is written while the config does not check out; list --tag ignores case', () => {
  const db = fresh()
  addEntry(db, conf, { ...base, tags: ['Deferred'] }, me)
  const bad = timeConfig({ zone: 'America/New York', clients: { a: {} } })
  assert.ok(bad)
  assert.equal(
    keyOf(() => addEntry(db, bad, { ...base, start: base.start + 1 }, me)),
    'time.err.config',
  )
  assert.equal(
    keyOf(() => importEntries(db, bad, [csvRow()])),
    'time.err.config',
  )
  assert.equal(listEntries(db, { from: '2026-10-28', to: '2026-10-28', tag: 'DEFERRED' }).length, 1)
  db.close()
})

test('a CSV row keeps its key: moved, its start changed, or removed after that on the board, a re-import adds nothing', () => {
  const db = fresh()
  const rows = [
    csvRow(),
    csvRow({ start: at('2026-10-28T16:00:00Z'), stop: at('2026-10-28T17:00:00Z') }),
    csvRow({ start: at('2026-10-28T18:00:00Z'), stop: at('2026-10-28T18:30:00Z') }),
  ]
  assert.equal(importEntries(db, conf, rows).added, 3)
  const [a, b, c] = listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
  assert.equal(a?.toggl, `csv:a:2026-10-28T13:00:00Z`)
  moveEntry(db, conf, a?.id as string, '2026-10-27', 'user')
  editEntry(db, conf, b?.id as string, { start: at('2026-10-28T16:20:00Z') }, 'user')
  editEntry(db, conf, c?.id as string, { start: at('2026-10-28T18:10:00Z') }, 'user')
  removeEntry(db, c?.id as string, 'user')
  const again = importEntries(db, conf, rows)
  assert.equal(again.added, 0)
  assert.deepEqual(
    again.changed.map(x => [x.id, x.fields]),
    [
      [a?.id, ['start', 'stop']],
      [b?.id, ['start', 'stop']],
    ],
  )
  assert.equal(again.already, 1, 'the removed one stays removed')
  assert.equal(listEntries(db, { from: '2026-10-27', to: '2026-10-28' }).length, 2)
  db.close()
})

test('two rows of one file with the same lane and start: the first goes in, the second meets it; a session’s entry there is named', () => {
  const db = fresh()
  const r = importEntries(db, conf, [csvRow(), csvRow({ description: 'Case 10001 X: the same start' })])
  assert.deepEqual([r.added, r.changed.length], [1, 1])
  assert.equal(r.changed[0]?.by, 'import')
  // a session's entry at a start a later Toggl row has
  const mine = addEntry(
    db,
    conf,
    { ...base, start: at('2026-10-28T20:00:00Z'), stop: at('2026-10-28T20:30:00Z') },
    me,
  ).entry
  const clash = importEntries(db, conf, [
    csvRow({ start: at('2026-10-28T20:00:00Z'), stop: at('2026-10-28T20:45:00Z') }),
  ])
  assert.deepEqual(
    clash.changed.map(x => [x.id, x.by]),
    [[mine.id, me]],
  )
  db.close()
})

test('a row another process writes while the import runs is already there, not a failed batch', () => {
  const db = fresh()
  const row = csvRow({ start: at('2026-10-28T21:00:00Z'), stop: at('2026-10-28T21:30:00Z') })
  // the index is read at the start; the same row lands from elsewhere before the insert
  const other = openDb()
  assert.ok(other)
  const real = db.write
  let once = false
  db.write = ((by: string, fn: Parameters<BoardDb['write']>[1]) => {
    if (!once) {
      once = true
      importEntries(other, conf, [row])
    }
    return real.call(db, by, fn)
  }) as BoardDb['write']
  assert.deepEqual(importEntries(db, conf, [row]), { added: 0, already: 1, changed: [], updated: [] })
  assert.equal(listEntries(db, { from: '2026-10-28', to: '2026-10-28' }).length, 1)
  other.close()
  db.close()
})

test('a trim of the stop keeps the work date stamped, whatever the zone says now; a new start stamps it again', () => {
  const db = fresh()
  // 22:00 on the 28th in New York
  const e = addEntry(
    db,
    conf,
    { ...base, start: at('2026-10-29T02:00:00Z'), stop: at('2026-10-29T03:00:00Z') },
    me,
  ).entry
  assert.equal(e.date, '2026-10-28')
  const istanbul = timeConfig({
    zone: 'Europe/Istanbul',
    clients: { a: { projects: ['Support', 'Migration'] }, b: {} },
  })
  assert.ok(istanbul)
  const trimmed = editEntry(db, istanbul, e.id, { stop: at('2026-10-29T02:45:00Z') }, me)
  assert.equal(trimmed.date, '2026-10-28', 'the stop alone moves no day')
  const same = editEntry(db, istanbul, e.id, { start: at('2026-10-29T02:00:00Z') }, me)
  assert.equal(same.date, '2026-10-28', 'the same start sent again moves none either')
  const moved = editEntry(db, istanbul, e.id, { start: at('2026-10-29T02:05:00Z') }, me)
  assert.equal(moved.date, '2026-10-29', 'a new start: stamped in the zone as it is now')
  db.close()
})

test('Raise reads the line under the write lock: an entry another process adds to it first counts', async () => {
  const db = fresh()
  const nyConf = timeConfig({
    zone: NY,
    clients: { a: { projects: ['Support'], billing: [{ group: 'ref', step: 30, round: 'up' }] } },
  })
  assert.ok(nyConf)
  // 40 minutes of case 10001: billed an hour, 20 minutes to raise
  const last = addEntry(
    db,
    nyConf,
    { ...base, start: at('2026-10-28T13:00:00Z'), stop: at('2026-10-28T13:40:00Z') },
    me,
  ).entry
  // another process takes the lock and adds 10 minutes of the same case, earlier in the day
  const holder = Bun.spawn(
    [
      process.execPath,
      HOLDER,
      dbFile(),
      JSON.stringify({
        id: 'other001',
        client: 'a',
        project: 'Support',
        description: 'Case 10001 X: a call',
        start: '2026-10-28T12:00:00Z',
        stop: '2026-10-28T12:10:00Z',
        date: '2026-10-28',
      }),
      '600',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const reader = holder.stdout.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  assert.match(first, /held/)
  // the raise waits for the lock, then reads the line with both: 50 minutes, 10 to raise
  const raised = raiseEntry(db, nyConf, last.id, me, { expect: last.rev })
  await holder.exited
  assert.equal(raised.stop, '2026-10-28T13:50:00Z')
  assert.equal(
    (db.db.query("SELECT op FROM journal WHERE store = 'time' ORDER BY seq DESC LIMIT 1").get() as { op: string }).op,
    'raise',
  )
  db.close()
})
