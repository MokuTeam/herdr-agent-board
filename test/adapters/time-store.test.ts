import { Database } from 'bun:sqlite'
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BoardDb, dbFile, openDb } from '../../src/adapters/db.ts'
import { MIGRATIONS } from '../../src/adapters/db-schema.ts'
import {
  addEntry,
  editEntry,
  getEntry,
  ImportIndex,
  type ImportRow,
  importEntries,
  importVerdicts,
  listEntries,
  marksOf,
  moveEntry,
  postEntries,
  projectCount,
  projectUse,
  REPEAT_MS,
  raiseEntry,
  removeEntry,
  renameProject,
  restoreEntry,
  TimeError,
  trimLine,
  unpostEntries,
  usedTags,
} from '../../src/adapters/time-store.ts'
import { type Actor, isoOf, secondsOf, timeConfig } from '../../src/core/time.ts'
import { isolatedHome } from '../support/env.ts'

const WRITER = fileURLToPath(new URL('../support/time-writer.ts', import.meta.url))
const HOLDER = fileURLToPath(new URL('../support/time-holder.ts', import.meta.url))
const MIGRATOR = fileURLToPath(new URL('../support/db-migrator.ts', import.meta.url))
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
    importVerdicts(new ImportIndex(db), conf, [csvRow({ stop: at('2026-10-28T13:45:00Z') })])[0]?.kind,
    'changed',
  )
  assert.deepEqual(importVerdicts(new ImportIndex(null), conf, [csvRow()])[0]?.kind, 'new')
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

test('rows of one lane and start that differ are each an entry: by words alone, three at one start, two projects; again, nothing', () => {
  const db = fresh()
  const rows = [
    // the same project, start and stop, other words
    csvRow({ description: 'Case 10001 X: work' }),
    csvRow({ description: 'Case 10002 Y: work' }),
    // three at one start
    csvRow({ start: at('2026-10-28T15:00:00Z'), stop: at('2026-10-28T15:20:00Z'), description: 'Call one' }),
    csvRow({ start: at('2026-10-28T15:00:00Z'), stop: at('2026-10-28T15:30:00Z'), description: 'Call two' }),
    csvRow({ start: at('2026-10-28T15:00:00Z'), stop: at('2026-10-28T15:45:00Z'), description: 'Call three' }),
    // two projects at one start
    csvRow({ start: at('2026-10-28T17:00:00Z'), stop: at('2026-10-28T17:30:00Z'), description: 'Plan' }),
    csvRow({
      start: at('2026-10-28T17:00:00Z'),
      stop: at('2026-10-28T18:00:00Z'),
      project: 'Migration',
      description: 'Move',
    }),
  ]
  assert.deepEqual(importEntries(db, conf, rows), { added: 7, already: 0, changed: [], updated: [] })
  // entries of one start come by their ids: the keys sorted
  const keys = listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
    .map(e => e.toggl)
    .sort()
  assert.deepEqual(keys, [
    'csv:a:2026-10-28T13:00:00Z',
    'csv:a:2026-10-28T13:00:00Z#2',
    'csv:a:2026-10-28T15:00:00Z',
    'csv:a:2026-10-28T15:00:00Z#2',
    'csv:a:2026-10-28T15:00:00Z#3',
    'csv:a:2026-10-28T17:00:00Z',
    'csv:a:2026-10-28T17:00:00Z#2',
  ])
  // the same file again, its rows in another order: each one already there
  assert.deepEqual(importEntries(db, conf, [...rows].reverse()), { added: 0, already: 7, changed: [], updated: [] })
  db.close()
})

test('a later export with one row of a same-start group edited in Toggl: that one differs, named; nothing added twice', () => {
  const db = fresh()
  const first = [
    csvRow({ description: 'Case 10001 X: work' }),
    csvRow({ description: 'Case 10002 Y: work' }),
    csvRow({ start: at('2026-10-28T15:00:00Z'), stop: at('2026-10-28T15:20:00Z'), description: 'Call one' }),
    csvRow({ start: at('2026-10-28T15:00:00Z'), stop: at('2026-10-28T15:30:00Z'), description: 'Call two' }),
    csvRow({ start: at('2026-10-28T17:00:00Z'), stop: at('2026-10-28T17:30:00Z'), description: 'Plan' }),
    csvRow({
      start: at('2026-10-28T17:00:00Z'),
      stop: at('2026-10-28T18:00:00Z'),
      project: 'Migration',
      description: 'Move',
    }),
  ]
  importEntries(db, conf, first)
  const stored = listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
  const idOf = (description: string) => stored.find(e => e.description === description)?.id
  const later = [
    // its words edited: paired by project and stop
    csvRow({ description: 'Case 10001 X: work, worded better' }),
    csvRow({ description: 'Case 10002 Y: work' }),
    // its stop edited: paired by project and words
    csvRow({ start: at('2026-10-28T15:00:00Z'), stop: at('2026-10-28T15:25:00Z'), description: 'Call one' }),
    csvRow({ start: at('2026-10-28T15:00:00Z'), stop: at('2026-10-28T15:30:00Z'), description: 'Call two' }),
    // the words of the one in the other project edited: paired by project
    csvRow({ start: at('2026-10-28T17:00:00Z'), stop: at('2026-10-28T17:30:00Z'), description: 'Plan' }),
    csvRow({
      start: at('2026-10-28T17:00:00Z'),
      stop: at('2026-10-28T18:00:00Z'),
      project: 'Migration',
      description: 'Moved',
    }),
  ]
  const r = importEntries(db, conf, later)
  assert.deepEqual([r.added, r.already], [0, 3])
  assert.deepEqual(
    r.changed.map(c => [c.id, c.fields, c.row.description]),
    [
      [idOf('Case 10001 X: work'), ['description'], 'Case 10001 X: work, worded better'],
      [idOf('Call one'), ['stop'], 'Call one'],
      [idOf('Move'), ['description'], 'Moved'],
    ],
  )
  // a row added in Toggl at a start that has rows already: a new entry beside them
  const more = importEntries(db, conf, [
    ...first,
    csvRow({ start: at('2026-10-28T15:00:00Z'), stop: at('2026-10-28T15:50:00Z'), description: 'Call three' }),
  ])
  assert.deepEqual([more.added, more.already, more.changed.length], [1, 6, 0])
  db.close()
})

test('a session’s entry at the start of Toggl rows: one row is named as its, a second row there goes in', () => {
  const db = fresh()
  // a session's entry at a start a later Toggl row has
  const mine = addEntry(
    db,
    conf,
    { ...base, start: at('2026-10-28T20:00:00Z'), stop: at('2026-10-28T20:30:00Z') },
    me,
  ).entry
  const clash = importEntries(db, conf, [
    csvRow({ start: at('2026-10-28T20:00:00Z'), stop: at('2026-10-28T20:45:00Z') }),
    csvRow({ start: at('2026-10-28T20:00:00Z'), stop: at('2026-10-28T20:10:00Z'), description: 'Quick call' }),
  ])
  assert.deepEqual(
    clash.changed.map(x => [x.id, x.by]),
    [[mine.id, me]],
  )
  assert.equal(clash.added, 1, 'the second row is not swallowed by the session’s entry')
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

test('Trim reads the line under the write lock as Raise does: an entry another process adds to it first counts', async () => {
  const db = fresh()
  const downConf = timeConfig({
    zone: NY,
    clients: { a: { projects: ['Support'], billing: [{ group: 'ref', step: 30, round: 'down' }] } },
  })
  assert.ok(downConf)
  // 40 minutes of case 10001 down to 30: 10 minutes to trim
  const last = addEntry(
    db,
    downConf,
    { ...base, start: at('2026-10-28T13:00:00Z'), stop: at('2026-10-28T13:40:00Z') },
    me,
  ).entry
  // another process takes the lock and adds 5 minutes of the same case, earlier in the day
  const holder = Bun.spawn(
    [
      process.execPath,
      HOLDER,
      dbFile(),
      JSON.stringify({
        id: 'other002',
        client: 'a',
        project: 'Support',
        description: 'Case 10001 X: a call',
        start: '2026-10-28T12:00:00Z',
        stop: '2026-10-28T12:05:00Z',
        date: '2026-10-28',
      }),
      '600',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const reader = holder.stdout.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /held/)
  // the trim waits for the lock, then reads the line with both: 45 minutes, 15 to trim
  const trimmed = trimLine(db, downConf, last.id, me, { expect: last.rev })
  await holder.exited
  assert.deepEqual([trimmed.stop, trimmed.rev], ['2026-10-28T13:25:00Z', last.rev + 1])
  assert.equal(getEntry(db, 'other002')?.stop, '2026-10-28T12:05:00Z', 'the last entry gave it all')
  assert.equal(
    (db.db.query("SELECT op FROM journal WHERE store = 'time' ORDER BY seq DESC LIMIT 1").get() as { op: string }).op,
    'trim',
  )
  // a revision read before is refused, and changes nothing
  assert.throws(() => trimLine(db, downConf, last.id, me, { expect: last.rev }), /changed since/)
  db.close()
})

/** A config whose client-a is entered into an ERP and a tracker, and does not bill its Internal project. */
const posting = timeConfig({
  zone: NY,
  clients: {
    a: { projects: ['Support', 'Internal'], nonBillable: ['Internal'], systems: ['erp', 'tracker'] },
    b: {},
  },
})
if (!posting) throw new Error('config')

const journalOf = (db: BoardDb) =>
  db.db.query("SELECT op, ref, before, after FROM journal WHERE store = 'time' ORDER BY seq").all() as {
    op: string
    ref: string
    before: string | null
    after: string | null
  }[]

test('billable set on an entry, and back to the config; a repeat changes nothing; the revision moves with it', () => {
  const db = fresh()
  const e = addEntry(db, posting, { ...base, project: 'Internal' }, me).entry
  assert.equal(e.billable, undefined, 'as the config says: nothing set')
  const set = editEntry(db, posting, e.id, { billable: true }, me)
  assert.deepEqual([set.billable, set.rev], [true, 2])
  assert.equal(editEntry(db, posting, e.id, { billable: true }, me).rev, 2, 'the same again changes nothing')
  assert.equal(editEntry(db, posting, e.id, { description: set.description }, me).rev, 2)
  const back = editEntry(db, posting, e.id, { billable: null }, me)
  assert.deepEqual([back.billable, back.rev, getEntry(db, e.id)?.billable], [undefined, 3, undefined])
  const made = addEntry(db, posting, { ...base, billable: false }, me).entry
  assert.equal(getEntry(db, made.id)?.billable, false)
  db.close()
})

test('a mark is no change of the entry: its revision stays; each mark and unmark has its journal row', () => {
  const db = fresh()
  const e = addEntry(db, posting, base, me).entry
  const before = journalOf(db).length
  const [m] = postEntries(db, posting, [{ id: e.id, rev: e.rev }], 'erp', other, { record: 'TR-1', now: 5 })
  assert.deepEqual(m, { entry: e.id, system: 'erp', at: 5, by: other, record: 'TR-1', rev: 1 })
  assert.equal(getEntry(db, e.id)?.rev, 1, 'the entry did not change')
  // marked again as it is: nothing written; with another record: written
  postEntries(db, posting, [{ id: e.id }], 'erp', other)
  postEntries(db, posting, [{ id: e.id }], 'erp', other, { record: 'TR-2' })
  // changed after: the entry's revision moves past the mark's
  const changed = editEntry(db, posting, e.id, { description: 'Case 10001 X: more' }, me)
  assert.equal(marksOf(db, [e.id]).get(e.id)?.[0]?.rev, 1)
  assert.equal(changed.rev, 2)
  // marked again: at the revision now, the record kept
  const [again] = postEntries(db, posting, [{ id: e.id }], 'erp', me)
  assert.deepEqual([again?.rev, again?.record], [2, 'TR-2'])
  postEntries(db, posting, [{ id: e.id }], 'tracker', me)
  assert.deepEqual(
    marksOf(db, [e.id])
      .get(e.id)
      ?.map(x => x.system),
    ['erp', 'tracker'],
  )
  assert.deepEqual(
    unpostEntries(db, posting, [{ id: e.id }], 'erp', me).map(x => x.system),
    ['erp'],
  )
  assert.deepEqual(unpostEntries(db, posting, [{ id: e.id }], 'erp', me), [], 'none left: nothing to do')
  assert.deepEqual(
    journalOf(db)
      .slice(before)
      .map(r => [r.op, r.ref, r.before === null, r.after === null]),
    [
      ['post', e.id, true, false],
      ['post', e.id, false, false],
      ['edit', e.id, false, false],
      ['post', e.id, false, false],
      ['post', e.id, true, false],
      ['unpost', e.id, false, true],
    ],
  )
  db.close()
})

test('marks are all or none: a stale revision, a removed entry or a system the client has not refuse the whole call', () => {
  const db = fresh()
  const one = addEntry(db, posting, base, me).entry
  const two = addEntry(
    db,
    posting,
    { ...base, start: at('2026-10-28T15:00:00Z'), stop: at('2026-10-28T15:30:00Z') },
    me,
  ).entry
  const elsewhere = addEntry(db, posting, { ...base, client: 'b' }, me).entry
  assert.equal(
    keyOf(() =>
      postEntries(
        db,
        posting,
        [
          { id: one.id, rev: 1 },
          { id: two.id, rev: 9 },
        ],
        'erp',
        me,
      ),
    ),
    'time.err.changedSince',
  )
  assert.equal(
    keyOf(() => postEntries(db, posting, [{ id: one.id }, { id: elsewhere.id }], 'erp', me)),
    'time.err.system',
  )
  assert.equal(
    keyOf(() => postEntries(db, posting, [{ id: one.id }], 'nope', me)),
    'time.err.system',
  )
  removeEntry(db, two.id, me)
  assert.equal(
    keyOf(() => postEntries(db, posting, [{ id: one.id }, { id: two.id }], 'erp', me)),
    'time.err.removed',
  )
  assert.equal(
    keyOf(() => postEntries(db, posting, [{ id: 'nope0000' }], 'erp', me)),
    'time.err.gone',
  )
  assert.equal(marksOf(db, [one.id, two.id]).size, 0, 'nothing marked')
  // the revision a mark records: no later than the entry's (an Undo putting an earlier mark back)
  editEntry(db, posting, one.id, { description: 'Case 10001 X: again' }, me)
  assert.equal(postEntries(db, posting, [{ id: one.id, asOf: 1, record: 'R' }], 'erp', me)[0]?.rev, 1)
  assert.equal(
    keyOf(() => postEntries(db, posting, [{ id: one.id, asOf: 3 }], 'erp', me)),
    'time.err.rev',
  )
  db.close()
})

test('a v2 file with entries goes to v3 under the lock, copied first: billable as the config says, no marks', async () => {
  isolatedHome()
  const v2 = openDb({ steps: MIGRATIONS.filter(m => m.version <= 2) })
  assert.ok(v2)
  // an entry as the code of v2 wrote it: its columns, none of v3's
  const made = { id: 'a1b2c3d4' }
  v2.write('user', tx =>
    tx.db
      .query(
        'INSERT INTO time_entries (id, client, project, description, tags, start, stop, date, by, at, changed, changed_by, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
      )
      .run(
        made.id,
        'a',
        'Support',
        'Case 10001 X: work',
        '[]',
        '2026-10-28T13:00:00Z',
        '2026-10-28T14:30:00Z',
        '2026-10-28',
        'user',
        1,
        1,
        'user',
      ),
  )
  v2.close()
  const openers = Array.from({ length: 4 }, () =>
    Bun.spawn([process.execPath, MIGRATOR, dbFile(), 'shipped'], { stdout: 'pipe', stderr: 'pipe' }),
  )
  const said = (await Promise.all(openers.map(o => new Response(o.stdout).text()))).map(x => x.trim())
  assert.deepEqual(said, ['ok', 'ok', 'ok', 'ok'])
  assert.equal(readdirSync(dirname(dbFile())).filter(f => f.startsWith('board.db.before-v2-')).length, 1)
  const raw = new Database(dbFile(), { readonly: true })
  assert.equal(Object.values(raw.query('PRAGMA user_version').get() as object)[0], 3)
  assert.deepEqual(raw.query('SELECT id, billable FROM time_entries').all(), [{ id: made.id, billable: null }])
  assert.deepEqual(raw.query('SELECT count(*) AS n FROM time_marks').get(), { n: 0 })
  raw.close()
  const db = openDb()
  assert.ok(db)
  assert.deepEqual([getEntry(db, made.id)?.rev, getEntry(db, made.id)?.billable], [1, undefined])
  db.close()
})

test('an imported row’s billable is set on its entry; again as it comes out is the same, the other way a change', () => {
  const db = fresh()
  assert.equal(importEntries(db, posting, [csvRow({ billable: false })]).added, 1)
  const [stored] = listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
  assert.equal(stored?.billable, false)
  assert.deepEqual(importEntries(db, posting, [csvRow({ billable: false })]).already, 1)
  const r = importEntries(db, posting, [csvRow({ billable: true })])
  assert.deepEqual(
    r.changed.map(c => c.fields),
    [['billable']],
  )
  // an entry imported before the board kept billable (as the config says), Toggl calling it billable
  // as the config does: the same, not a change of every row of a second run
  const old = fresh()
  importEntries(old, posting, [csvRow()])
  assert.deepEqual(importEntries(old, posting, [csvRow({ billable: true })]).already, 1)
  assert.deepEqual(
    importEntries(old, posting, [csvRow({ billable: false })], { update: true }).updated.map(c => c.fields),
    [['billable']],
  )
  assert.equal(listEntries(old, { from: '2026-10-28', to: '2026-10-28' })[0]?.billable, false)
  db.close()
  old.close()
})

test('the tags entries have, most used first; a row whose tags are not JSON has none and fails nothing', () => {
  const db = fresh()
  addEntry(db, conf, { ...base, tags: ['call', 'review'] }, me)
  addEntry(
    db,
    conf,
    { ...base, start: at('2026-10-28T16:00:00Z'), stop: at('2026-10-28T16:30:00Z'), tags: ['call'] },
    me,
  )
  db.write('user', tx =>
    tx.db
      .query(
        'INSERT INTO time_entries (id, client, project, description, tags, start, stop, date, by, at, changed, changed_by, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
      )
      .run(
        'bad00001',
        'a',
        'Support',
        'x',
        'not json',
        '2026-10-28T18:00:00Z',
        '2026-10-28T18:30:00Z',
        '2026-10-28',
        'user',
        1,
        1,
        'user',
      ),
  )
  // JSON, but not a list: none either
  for (const [id, tags, start] of [
    ['bad00002', '"solo"', '2026-10-28T19:00:00Z'],
    ['bad00003', '{"a":"b"}', '2026-10-28T20:00:00Z'],
  ] as const)
    db.write('user', tx =>
      tx.db
        .query(
          'INSERT INTO time_entries (id, client, project, description, tags, start, stop, date, by, at, changed, changed_by, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        )
        .run(
          id,
          'a',
          'Support',
          'x',
          tags,
          start,
          start.replace(':00:00Z', ':30:00Z'),
          '2026-10-28',
          'user',
          1,
          1,
          'user',
        ),
    )
  assert.deepEqual(usedTags(db), ['call', 'review'])
  assert.deepEqual(getEntry(db, 'bad00001')?.tags, [])
  db.close()
})

test('billable set the way the config has it, on an entry that follows the config: no change; a row that does not say it is not held against one set', () => {
  const db = fresh()
  const e = addEntry(db, posting, base, me).entry
  const same = editEntry(db, posting, e.id, { billable: true }, me)
  assert.deepEqual([same.rev, same.billable], [1, undefined])
  // the other way: set
  assert.equal(editEntry(db, posting, e.id, { billable: false }, me).rev, 2)
  // an import's row with no billable against an entry set non-billable: the same, not a change
  const old = fresh()
  importEntries(old, posting, [csvRow({ billable: false })])
  assert.deepEqual(importEntries(old, posting, [csvRow()]).already, 1)
  assert.equal(
    importEntries(old, posting, [csvRow()], { update: true }).updated.length,
    0,
    '--update leaves it as it is',
  )
  db.close()
  old.close()
})

test('with Toggl’s Billable, rows of one start still find their own entries: alike but for billable before by project and words', () => {
  const db = fresh()
  const at15 = at('2026-10-28T15:00:00Z')
  const row = (minutes: number, o: Partial<ImportRow> = {}) =>
    csvRow({ start: at15, stop: at15 + minutes * 60_000, description: 'Call', ...o })
  // two entries at one start, made in the other order than the later file has them
  importEntries(db, posting, [row(25), row(10)])
  const stored = listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
  const idBy = (minutes: number) => stored.find(e => e.stop === isoOf(at15 + minutes * 60_000))?.id
  const r = importEntries(db, posting, [row(10, { billable: false }), row(25, { billable: false })], { update: true })
  assert.deepEqual(
    r.updated.map(c => [c.id, c.fields]),
    [
      [idBy(10), ['billable']],
      [idBy(25), ['billable']],
    ],
  )
  assert.deepEqual(
    // entries of one start come by their ids: by stop here
    listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
      .map(e => [e.stop, e.billable])
      .sort(),
    [
      [isoOf(at15 + 10 * 60_000), false],
      [isoOf(at15 + 25 * 60_000), false],
    ],
  )
  db.close()
})

const shelved = timeConfig({
  zone: NY,
  clients: {
    a: { projects: ['Support', 'Cases work'], retired: ['Old'], systems: ['erp'] },
    off: { on: false, projects: ['Support'] },
  },
})
if (!shelved) throw new Error('config')

test('a client off takes no new entry nor one moved to it; its own stay editable; a retired project is kept, never taken anew', () => {
  const db = fresh()
  assert.equal(
    keyOf(() => addEntry(db, shelved, { ...base, client: 'off' }, me)),
    'time.err.clientOff',
  )
  // an entry it had before it went off (written while it was on)
  const own = addEntry(db, conf, { ...base, client: 'b', project: 'Support' }, me).entry
  db.db.query("UPDATE time_entries SET client = 'off' WHERE id = ?").run(own.id)
  assert.equal(editEntry(db, shelved, own.id, { description: 'Case 10001 X: fixed' }, me).rev, 2)
  assert.equal(editEntry(db, shelved, own.id, { client: 'off', project: 'Support' }, me).client, 'off')
  const mine = addEntry(db, shelved, base, me).entry
  assert.equal(
    keyOf(() => editEntry(db, shelved, mine.id, { client: 'off' }, me)),
    'time.err.clientOff',
  )
  // a retired project: refused new, as new too (whatever its case), kept by an entry that has it
  for (const project of ['Old', ' old '])
    for (const newProject of [false, true])
      assert.equal(
        keyOf(() => addEntry(db, shelved, { ...base, project, newProject }, me)),
        'time.err.retired',
        `${project} ${newProject}`,
      )
  const old = addEntry(
    db,
    conf,
    { ...base, project: 'Migration', start: at('2026-10-28T16:00:00Z'), stop: at('2026-10-28T16:30:00Z') },
    me,
  ).entry
  db.db.query("UPDATE time_entries SET project = 'Old' WHERE id = ?").run(old.id)
  assert.equal(editEntry(db, shelved, old.id, { project: 'Old', description: 'Case 10001 X: kept' }, me).project, 'Old')
  assert.equal(
    keyOf(() => editEntry(db, shelved, mine.id, { project: 'Old' }, me)),
    'time.err.retired',
  )
  db.close()
})

test('a project typed as new that the client has, case and spaces aside, is the one it has', () => {
  const db = fresh()
  const e = addEntry(db, shelved, { ...base, project: 'cases  WORK ', newProject: true }, me).entry
  assert.equal(e.project, 'Cases work')
  assert.equal(editEntry(db, shelved, e.id, { project: 'support', newProject: true }, me).project, 'Support')
  // a name it has not got stays as typed
  assert.equal(addEntry(db, shelved, { ...base, project: 'Audit', newProject: true }, me).entry.project, 'Audit')
  // without --new-project, a near name is a typo, refused as before
  assert.equal(
    keyOf(() => addEntry(db, shelved, { ...base, project: 'support' }, me)),
    'time.err.project',
  )
  db.close()
})

test('a rename moves the client’s entries of the project, removed ones too, a journal row each; a current mark stays current', () => {
  const db = fresh()
  const one = addEntry(db, shelved, base, me).entry
  const two = addEntry(
    db,
    shelved,
    { ...base, start: at('2026-10-28T15:00:00Z'), stop: at('2026-10-28T15:30:00Z') },
    me,
  ).entry
  const gone = addEntry(
    db,
    shelved,
    { ...base, start: at('2026-10-28T16:00:00Z'), stop: at('2026-10-28T16:30:00Z') },
    me,
  ).entry
  removeEntry(db, gone.id, me)
  const elsewhere = addEntry(db, shelved, { ...base, project: 'Cases work' }, me).entry
  const otherLane = addEntry(db, conf, { ...base, client: 'b' }, me).entry
  postEntries(db, shelved, [{ id: one.id }, { id: two.id }], 'erp', me, { record: 'TR-1' })
  // two changed after it was entered: its mark stays behind
  editEntry(db, shelved, two.id, { description: 'Case 10001 X: more' }, me)
  const before = journalOf(db).length
  let then = 0
  const moved = renameProject(db, shelved, 'a', 'Support', 'Support desk', 'user', () => {
    then++
  })
  assert.deepEqual(
    moved.map(e => [e.id, e.project, e.rev]),
    [
      [one.id, 'Support desk', 2],
      [two.id, 'Support desk', 3],
      // removed: restored, it comes back under the new name
      [gone.id, 'Support desk', 3],
    ],
  )
  assert.equal(then, 1, 'the config written in the same transaction')
  assert.equal(restoreEntry(db, gone.id, me).project, 'Support desk')
  assert.deepEqual(
    [elsewhere.id, otherLane.id].map(id => getEntry(db, id)?.project),
    ['Cases work', 'Support'],
    'another project and another lane are left as they are',
  )
  const marks = marksOf(db, [one.id, two.id])
  assert.deepEqual(
    [marks.get(one.id)?.[0]?.rev, marks.get(one.id)?.[0]?.record, marks.get(two.id)?.[0]?.rev],
    [2, 'TR-1', 1],
    'one entered still (rev 2 of 2), two still changed after it was entered (rev 1 of 3)',
  )
  assert.deepEqual(
    journalOf(db)
      .slice(before)
      .map(r => [r.op, r.ref]),
    [
      ['rename', one.id],
      ['rename-mark', one.id],
      ['rename', two.id],
      ['rename', gone.id],
      ['restore', gone.id],
    ],
  )
  db.close()
})

test('a rename moves every spelling of the name (case, spaces, unseen characters, composed or not), counted as one; the same name is no change', () => {
  const db = fresh()
  const lane = timeConfig({ zone: NY, clients: { a: { projects: ['Café', 'Help Desk'] } } })
  assert.ok(lane)
  const at2 = (h: number) => ({ start: at(`2026-10-28T${h}:00:00Z`), stop: at(`2026-10-28T${h}:30:00Z`) })
  const made = (project: string, h: number) =>
    addEntry(db, conf, { ...base, client: 'b', project, ...at2(h) }, me).entry
  // as an import or a hand-edited file leaves them: other spellings of the listed names
  const ids = [made('Help Desk', 10), made('help desk', 11), made('Help\u200bDesk', 12), made('Cafe\u0301', 13)].map(
    e => e.id,
  )
  db.db.query("UPDATE time_entries SET client = 'a'").run()
  assert.equal(projectCount(db, 'a', 'Help Desk'), 3)
  assert.equal(projectCount(db, 'a', 'Café'), 1, 'the decomposed é is the same letter')
  const moved = renameProject(db, lane, 'a', 'Help Desk', 'Support', 'user')
  assert.deepEqual(
    moved.map(e => e.id),
    ids.slice(0, 3),
  )
  assert.deepEqual(
    ids.map(id => getEntry(db, id)?.project),
    ['Support', 'Support', 'Support', 'Cafe\u0301'],
  )
  // named so already: no revision moves
  assert.deepEqual(renameProject(db, lane, 'a', 'support', 'Support', 'user'), [])
  db.close()
})

test('a rename whose last step throws changes nothing; one onto a name an entry has refuses the whole of it', () => {
  const db = fresh()
  const one = addEntry(db, shelved, base, me).entry
  assert.throws(
    () =>
      renameProject(db, shelved, 'a', 'Support', 'Support desk', 'user', () => {
        throw new Error('config.json not written')
      }),
    /config.json not written/,
  )
  assert.deepEqual([getEntry(db, one.id)?.project, getEntry(db, one.id)?.rev], ['Support', 1])
  // the same entry under the new name already: it would be two alike
  const twin = addEntry(db, shelved, { ...base, project: 'Cases work' }, me).entry
  addEntry(db, shelved, { ...base, start: at('2026-10-28T17:00:00Z'), stop: at('2026-10-28T17:30:00Z') }, me)
  assert.equal(
    keyOf(() => renameProject(db, shelved, 'a', 'Support', 'Cases work', 'user')),
    'time.err.sameAs',
  )
  assert.deepEqual(projectUse(db, 'a'), { 'Cases work': 1, Support: 2 })
  assert.equal(getEntry(db, twin.id)?.rev, 1)
  db.close()
})

test('rows alike in the five fields the store holds one of: one entry, the dry run as the run; tags alone differing are said', () => {
  const db = fresh()
  const twice = [csvRow(), csvRow()]
  assert.deepEqual(importEntries(db, conf, twice), { added: 1, already: 1, changed: [], updated: [] })
  // the same file again, as a dry run would see it: nothing new
  assert.deepEqual(
    importVerdicts(new ImportIndex(db), conf, twice).map(v => v.kind),
    ['already', 'already'],
  )
  // in one file, alike but for tags: one in, the other differs in its tags; --update never takes
  // turns between the two (the entry stays the first row's, at its revision)
  const other = fresh()
  const pair = [csvRow(), csvRow({ tags: ['call'] })]
  const r = importEntries(other, conf, pair, { update: true })
  assert.deepEqual([r.added, r.changed.map(c => c.fields), r.updated.length], [1, [['tags']], 0])
  for (let n = 0; n < 2; n++) assert.equal(importEntries(other, conf, pair, { update: true }).updated.length, 0)
  const [kept] = listEntries(other, { from: '2026-10-28', to: '2026-10-28' })
  assert.deepEqual([kept?.tags, kept?.rev], [[], 1])
  db.close()
  other.close()
})

test('a removed entry is paired only by what it shares with a row: a new row at its start goes in', () => {
  const db = fresh()
  importEntries(db, conf, [csvRow()])
  const [gone] = listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
  removeEntry(db, gone?.id as string, 'user')
  const r = importEntries(db, conf, [
    csvRow({ project: 'Migration', description: 'Other work', stop: at('2026-10-28T13:20:00Z') }),
  ])
  assert.deepEqual([r.added, r.already, r.changed.length], [1, 0, 0])
  db.close()
})

test('a removed entry is not taken by a new row of its project that shares nothing else with it', () => {
  const db = fresh()
  importEntries(db, conf, [csvRow()])
  const [gone] = listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
  removeEntry(db, gone?.id as string, 'user')
  const r = importEntries(db, conf, [csvRow({ description: 'Another call', stop: at('2026-10-28T13:20:00Z') })])
  assert.deepEqual([r.added, r.already, r.changed.length], [1, 0, 0])
  db.close()
})

// passes on main too (its order there was the same in practice): it pins the order now said
test('two entries no field tells apart: the first made is the one a row is paired with', () => {
  const db = fresh()
  const rows = [csvRow({ description: 'One' }), csvRow({ description: 'Two' })]
  importEntries(db, conf, rows)
  const [first] = listEntries(db, { from: '2026-10-28', to: '2026-10-28' }).sort((a, b) =>
    (a.toggl ?? '') < (b.toggl ?? '') ? -1 : 1,
  )
  // in Toggl one is removed and the other's words edited: the row is the first made
  const r = importEntries(db, conf, [csvRow({ description: 'Edited' })])
  assert.deepEqual(
    r.changed.map(c => [c.id, c.fields]),
    [[first?.id, ['description']]],
  )
  db.close()
})

test('an entry imported before rows of one start were told apart (its key the bare lane and start) beside a new row there', () => {
  const db = fresh()
  importEntries(db, conf, [csvRow()])
  const [legacy] = listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
  assert.equal(legacy?.toggl, 'csv:a:2026-10-28T13:00:00Z')
  const r = importEntries(db, conf, [csvRow(), csvRow({ description: 'A second call' })])
  assert.deepEqual([r.added, r.already, r.changed.length], [1, 1, 0])
  assert.deepEqual(
    listEntries(db, { from: '2026-10-28', to: '2026-10-28' })
      .map(e => e.toggl)
      .sort(),
    ['csv:a:2026-10-28T13:00:00Z', 'csv:a:2026-10-28T13:00:00Z#2'],
  )
  db.close()
})
