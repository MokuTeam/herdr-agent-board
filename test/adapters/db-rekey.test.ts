import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { addBoardEvent as addCalEvent, getBoardEvent as getCalEvent } from '../../src/adapters/calendar-store.ts'
import { integrityOf, openDb } from '../../src/adapters/db.ts'
import {
  applyDbRekey,
  lastDbRekey,
  missingSchemaColumns,
  planDbRekey,
  unlistedSchemaColumns,
} from '../../src/adapters/db-rekey.ts'
import { getDecision, insertDecision } from '../../src/adapters/decision-store.ts'
import { addEntry as addTimeEntry, getEntry as getTimeEntry, postEntries } from '../../src/adapters/time-store.ts'
import {
  appendEntry,
  createThread,
  cursorOf,
  entriesOf,
  getThread,
  moveCursor,
  putWatch,
  watchesOf,
} from '../../src/adapters/work-thread-store.ts'
import { workdeskStore } from '../../src/adapters/workdesk-store.ts'
import { changeWorkerRoster } from '../../src/adapters/workdesk-worker-store.ts'
import { DB_SCHEMA_COLUMNS } from '../../src/core/db-rekey.ts'
import type { TimeConfig } from '../../src/core/time.ts'
import { isolatedHome } from '../support/env.ts'

const S1 = '0f8fad5b-d9cb-469f-a165-70867728950e'
const S2 = '11111111-2222-3333-4444-555555555555'
const PANE = 'pane-w1:p2'
const WIN_PI = 'C:\\Users\\anna\\.pi\\sessions\\my session 50% тест.jsonl'

const TIME_CFG: TimeConfig = {
  zone: 'UTC',
  excludeTags: [],
  clients: {
    atlas: {
      on: true,
      projects: ['core'],
      retired: [],
      billable: true,
      nonBillable: [],
      systems: [{ id: 'erp', title: 'ERP' }],
      projectSystems: {},
      ref: '',
      zone: null,
      billing: [],
    },
  },
  problems: [],
}

test('schema scan: every column in board.db (including lazy tables) is listed in DB_SCHEMA_COLUMNS, and unlisted columns fail the scan', () => {
  const dir = isolatedHome()
  const db = openDb({ path: join(dir, 'board.db'), create: true })
  if (!db) throw new Error('no db')
  try {
    expect(unlistedSchemaColumns(db.db)).toEqual([])
    expect(missingSchemaColumns(db.db)).toEqual([])

    // Create optional lazy tables (workdesk_handoffs, workdesk_workers, workdesk_worker_coverage).
    workdeskStore(db)
    changeWorkerRoster(db, S1, { op: 'link', worker: S2 })
    expect(unlistedSchemaColumns(db.db)).toEqual([])

    // Adding an unlisted column or table must be caught by unlistedSchemaColumns.
    db.db.exec('ALTER TABLE decisions ADD COLUMN extra_session TEXT')
    db.db.exec('CREATE TABLE extra_tbl (session TEXT) STRICT')
    expect(unlistedSchemaColumns(db.db)).toEqual(['decisions.extra_session', 'extra_tbl.session'])
  } finally {
    db.close()
  }
})

test('applyDbRekey rewrites every session-key column atomically with backup, bidirectional round-trip and idempotency', () => {
  const dir = isolatedHome()
  const dbPath = join(dir, 'board.db')
  const db = openDb({ path: dbPath, create: true })
  if (!db) throw new Error('no db')
  try {
    // 1. time_entries (by, changed_by) and time_marks (by)
    const te1 = addTimeEntry(
      db,
      TIME_CFG,
      { client: 'atlas', project: 'core', description: 'local work', start: 1000, stop: 61_000, startGiven: true },
      { key: S1, name: 'Anna' },
      100,
    ).entry
    const te2 = addTimeEntry(
      db,
      TIME_CFG,
      { client: 'atlas', project: 'core', description: 'node work', start: 120_000, stop: 180_000, startGiven: true },
      { key: `@server-1:${PANE}`, name: 'Ben' },
      101,
    ).entry
    const teUser = addTimeEntry(
      db,
      TIME_CFG,
      { client: 'atlas', project: 'core', description: 'user work', start: 240_000, stop: 300_000, startGiven: true },
      'user',
      102,
    ).entry
    postEntries(db, TIME_CFG, [{ id: te1.id }], 'erp', { key: `@server-1:${S2}`, name: 'Ben' }, { now: 105 })

    // 2. cal_events (by, changed_by)
    const ev1 = addCalEvent(db, { key: WIN_PI, name: 'Anna' }, { title: 'Standup', start: 10_000, end: 20_000 }, 110)
    const evUser = addCalEvent(db, 'user', { title: 'Owner event', start: 30_000, end: 40_000 }, 111)

    // 3. threads + thread_entries + thread_watch + thread_cursor
    const t1 = db.write('test', tx => {
      const created = createThread(tx, {
        lane: 'atlas',
        title: 'Main thread',
        status: 'doing',
        author: { kind: 'session', key: S1, name: 'Anna' },
        assignee: { kind: 'session', key: `@server-1:${S2}`, name: 'Ben' },
        at: 200,
      })
      appendEntry(tx, created.head.id, {
        at: 201,
        author: { kind: 'session', key: `@server-1:${S2}`, name: 'Ben' },
        type: 'note',
        text: 'handoff',
        set: {
          assignee: { kind: 'session', key: WIN_PI, name: 'Cleo' },
          verifier: { key: `@server-1:${PANE}`, name: 'Verifier', at: 201, until: 999 },
        },
      })
      appendEntry(tx, created.head.id, {
        at: 202,
        author: { kind: 'session', key: S1, name: 'Anna' },
        type: 'note',
        text: 'propose',
        set: {
          status: 'done',
          hold: true,
          state: JSON.stringify({ text: 'ready', at: 202, by: { kind: 'session', key: S1, name: 'Anna' } }),
        },
      })
      // Directly populate proposed, scope.request.by, state, verify.run.key so every JSON column is exercised.
      tx.db.query('UPDATE threads SET proposed = ?, scope = ?, state = ?, verify = ? WHERE id = ?').run(
        JSON.stringify({ by: { kind: 'session', key: S1, name: 'Anna' }, at: 203, why: 'done', verify: true }),
        JSON.stringify({
          kind: 'local',
          request: {
            to: 'team',
            history: true,
            by: { kind: 'session', key: `@server-1:${S2}`, name: 'Ben' },
            at: 203,
          },
        }),
        JSON.stringify({ text: 'state text', at: 203, by: { kind: 'session', key: WIN_PI, name: 'Cleo' } }),
        JSON.stringify({
          on: true,
          accept: ['ok'],
          run: { key: `@server-1:${PANE}`, name: 'Verify', at: 203, until: 999 },
          fails: 0,
          last: null,
        }),
        created.head.id,
      )
      // Swap-cycle test in thread_watch and thread_cursor: both `S1` and `@server-1:S1` exist!
      putWatch(
        tx,
        { session: S1, name: 'Anna', target: created.head.id, what: 'status', idle: false, wake: false },
        210,
      )
      putWatch(
        tx,
        { session: `@server-1:${S1}`, name: 'Ben', target: created.head.id, what: 'all', idle: false, wake: true },
        211,
      )
      putWatch(
        tx,
        { session: `@box-2:${S1}`, name: 'Atlas', target: 'mine', what: 'asks', idle: true, wake: false },
        212,
      )
      moveCursor(tx, S1, { seq: 10, at: 220, asked: 9 })
      moveCursor(tx, `@server-1:${S1}`, { seq: 20, at: 221, asked: 19 })
      return created.head.id
    })

    // 4. decisions (session)
    insertDecision(db, { id: 'dec1', session: S1, name: 'Anna', question: 'Ship?', askedAt: 300 }, 'test')
    insertDecision(db, { id: 'dec2', session: `@server-1:${S2}`, name: 'Ben', question: 'Test?', askedAt: 301 }, 'test')

    // 5. workdesk_handoffs (session_key) + workdesk_dialog_bindings (sid must NOT change) + workdesk_workers (SIDs must NOT change)
    const wd = workdeskStore(db)
    wd.reserve(42, { key: S1, name: 'Anna', lane: 'atlas', sid: S1 })
    db.write('test', tx => {
      tx.db
        .query(
          'INSERT INTO workdesk_dialog_bindings (task_id, assignment_id, executor, thread_id, sid, revision) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(42, 'assign-42', 'Anna', t1, S1, 1)
    })
    changeWorkerRoster(db, S1, { op: 'link', worker: S2 })

    // Verify all non-'none' columns in DB_SCHEMA_COLUMNS are non-null in our test fixture.
    for (const [table, spec] of Object.entries(DB_SCHEMA_COLUMNS)) {
      for (const [col, kind] of Object.entries(spec.columns)) {
        if (kind === 'none') continue
        const n = (
          db.db.query(`SELECT count(*) AS n FROM "${table}" WHERE "${col}" IS NOT NULL`).get() as { n: number }
        ).n
        expect(n, `${table}.${col} should be populated in test fixture`).toBeGreaterThan(0)
      }
    }

    // Dry run: planDbRekey reads without modifying anything.
    const beforeJournalSeq = db.lastChange().seq
    const plan = planDbRekey(db.db, 'laptop', 'server-1')
    expect(plan.already).toBe(false)
    expect(plan.total).toBeGreaterThan(0)
    expect(db.lastChange().seq).toBe(beforeJournalSeq)

    // Real run with backup.
    const backupFile = join(dir, 'backup-before-rekey.db')
    const applied = applyDbRekey(db, 'laptop', 'server-1', { backupFile, by: 'user' })
    expect(applied.already).toBe(false)
    expect(applied.total).toBe(plan.total)
    expect(existsSync(backupFile)).toBe(true)
    expect(integrityOf(backupFile).ok).toBe(true)
    expect(lastDbRekey(db.db)).toEqual({ from: 'laptop', to: 'server-1' })

    // Verify backup holds pre-rekey values.
    const bakRaw = new Database(backupFile, { readonly: true })
    try {
      expect(
        (bakRaw.query('SELECT session FROM decisions WHERE id = ?').get('dec1') as { session: string }).session,
      ).toBe(S1)
    } finally {
      bakRaw.close(false)
    }

    // Verify transformed values in live DB.
    expect(getTimeEntry(db, te1.id)?.by).toEqual({ key: `@laptop:${S1}`, name: 'Anna' })
    expect(getTimeEntry(db, te2.id)?.by).toEqual({ key: PANE, name: 'Ben' })
    expect(getTimeEntry(db, teUser.id)?.by).toBe('user')
    const markBy = (db.db.query('SELECT by FROM time_marks WHERE entry = ?').get(te1.id) as { by: string }).by
    expect(JSON.parse(markBy)).toEqual({ key: S2, name: 'Ben' })

    expect((db.db.query('SELECT by FROM cal_events WHERE id = ?').get(ev1.id) as { by: string }).by).toBe(
      JSON.stringify({ key: `@laptop:${WIN_PI}`, name: 'Anna' }),
    )
    expect(getCalEvent(db, evUser.id)?.by).toBe('user')

    const head = getThread(db, t1)
    expect(head?.createdBy).toEqual({ kind: 'session', key: `@laptop:${S1}`, name: 'Anna' })
    expect(head?.assignee).toEqual({ kind: 'session', key: `@laptop:${WIN_PI}`, name: 'Cleo' })
    expect(head?.proposed?.by).toEqual({ kind: 'session', key: `@laptop:${S1}`, name: 'Anna' })
    expect(head?.scope).toMatchObject({
      kind: 'local',
      request: { by: { kind: 'session', key: S2, name: 'Ben' } },
    })
    expect(head?.state?.by).toEqual({ kind: 'session', key: `@laptop:${WIN_PI}`, name: 'Cleo' })
    expect(head?.verify?.run?.key).toBe(PANE)

    const entries = entriesOf(db, t1)
    expect(entries[0]?.author).toEqual({ kind: 'session', key: `@laptop:${S1}`, name: 'Anna' })
    expect(entries[1]?.author).toEqual({ kind: 'session', key: S2, name: 'Ben' })
    expect(entries[1]?.set?.assignee).toEqual({ kind: 'session', key: `@laptop:${WIN_PI}`, name: 'Cleo' })
    expect(entries[1]?.set?.verifier?.key).toBe(PANE)

    expect(watchesOf(db, `@laptop:${S1}`).map(w => w.what)).toEqual(['status'])
    expect(watchesOf(db, S1).map(w => w.what)).toEqual(['all'])
    expect(watchesOf(db, `@box-2:${S1}`).map(w => w.what)).toEqual(['asks'])
    expect(cursorOf(db, `@laptop:${S1}`)?.seq).toBe(10)
    expect(cursorOf(db, S1)?.seq).toBe(20)

    expect(getDecision(db, 'dec1')?.session).toBe(`@laptop:${S1}`)
    expect(getDecision(db, 'dec2')?.session).toBe(S2)
    expect(wd.find(42)?.session_key).toBe(`@laptop:${S1}`)

    // Native SIDs must remain untouched.
    const binding = db.db.query('SELECT sid FROM workdesk_dialog_bindings WHERE task_id = 42').get() as { sid: string }
    expect(binding.sid).toBe(S1)

    // Idempotent second run changes nothing and writes no backup/journal.
    const seqAfterFirst = db.lastChange().seq
    const secondPlan = planDbRekey(db.db, 'laptop', 'server-1')
    expect(secondPlan).toEqual({ already: true, total: 0, tables: [] })
    const secondApplied = applyDbRekey(db, 'laptop', 'server-1', { backupFile: join(dir, 'should-not-exist.db') })
    expect(secondApplied).toEqual({ already: true, total: 0, tables: [] })
    expect(existsSync(join(dir, 'should-not-exist.db'))).toBe(false)
    expect(db.lastChange().seq).toBe(seqAfterFirst)

    // Reverse run maps everything back cleanly.
    const reverseBackup = join(dir, 'backup-reverse.db')
    const rev = applyDbRekey(db, 'server-1', 'laptop', { backupFile: reverseBackup })
    expect(rev.already).toBe(false)
    expect(rev.total).toBe(applied.total)
    expect(getTimeEntry(db, te1.id)?.by).toEqual({ key: S1, name: 'Anna' })
    expect(getTimeEntry(db, te2.id)?.by).toEqual({ key: `@server-1:${PANE}`, name: 'Ben' })
    expect(getDecision(db, 'dec1')?.session).toBe(S1)
    expect(getDecision(db, 'dec2')?.session).toBe(`@server-1:${S2}`)
    expect(wd.find(42)?.session_key).toBe(S1)
    expect(cursorOf(db, S1)?.seq).toBe(10)
    expect(cursorOf(db, `@server-1:${S1}`)?.seq).toBe(20)
    expect(getThread(db, t1)?.verify?.run?.key).toBe(`@server-1:${PANE}`)
    expect(getThread(db, t1)?.assignee).toEqual({ kind: 'session', key: WIN_PI, name: 'Cleo' })
  } finally {
    db.close()
  }
})
