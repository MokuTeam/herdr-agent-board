// findThread takes a thread by its key, a bare number in a lane, the 8-character id prefix or the
// whole 36-character id (#455): MokuPilot's threads view sends `head.id` on every owner write.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { type BoardDb, openDb } from '../../src/adapters/db.ts'
import { findThread } from '../../src/adapters/work-thread-store.ts'
import { ID_REF } from '../../src/core/work-threads.ts'
import { newThread, type ThreadsCtx } from '../../src/services/work-threads.ts'
import { isolatedHome } from '../support/env.ts'

let db: BoardDb
beforeEach(() => {
  isolatedHome()
  db = openDb({ path: join(mkdtempSync(join(os.tmpdir(), 'board-find-')), 'board.db') }) as BoardDb
})
afterEach(() => db.close())

const ctx = (): ThreadsCtx =>
  ({
    db,
    cfg: { agents: true, gapSec: 60, share: false },
    actor: { kind: 'owner' },
    now: Date.parse('2026-11-12T10:00:00Z'),
    me: `A${'a'.repeat(42)}`,
    nameOf: (p: string) => p.slice(0, 6),
    schedule: { list: () => [], add: () => ({}), takeBack: () => false },
    state: os.tmpdir(),
  }) as unknown as ThreadsCtx

test('a full thread uuid names the thread; one that is not on the board is not_found', () => {
  const { head } = newThread(ctx(), { lane: 'atlas', title: 'one' })
  expect(head.id).toHaveLength(36)
  expect(findThread(db, head.id, null).key).toBe('atlas-1')
  expect(findThread(db, head.id.toUpperCase(), null).key).toBe('atlas-1')
  const other = '6f284253-c0e4-4b10-b60d-4a808daf0bf2'
  expect(() => findThread(db, other, null)).toThrow(/no thread/)
  // same 8-character prefix as the real one, different rest: still not this thread
  expect(() => findThread(db, `${head.id.slice(0, 8)}-0000-4000-8000-000000000000`, null)).toThrow(/no thread/)
})

test('a thread whose id starts with 8 digits goes by that prefix, in a lane or with none (#572)', () => {
  const { head } = newThread(ctx(), { lane: 'atlas', title: 'one' })
  const digits = '93525772-0c4e-4b1a-9d2f-6a7b8c9d0e1f'
  db.db.run('PRAGMA foreign_keys = OFF')
  db.db.run('UPDATE threads SET id = ? WHERE id = ?', [digits, head.id])
  db.db.run('UPDATE thread_entries SET thread = ? WHERE thread = ?', [digits, head.id])
  db.db.run('PRAGMA foreign_keys = ON')
  expect(findThread(db, '93525772', null).key).toBe('atlas-1')
  expect(findThread(db, '93525772', 'atlas').key).toBe('atlas-1')
  expect(findThread(db, '1', 'atlas').id).toBe(digits)
  // A number with no lane that names no thread by its id is refused as before.
  expect(() => findThread(db, '93525773', null)).toThrow(/is a number: give the whole key/)
  expect(() => findThread(db, '2', 'atlas')).toThrow(/no thread "2"/)
})

test('the key, the number in a lane and the 8-character prefix go as before', () => {
  const { head } = newThread(ctx(), { lane: 'atlas', title: 'one' })
  expect(findThread(db, 'atlas-1', null).id).toBe(head.id)
  expect(findThread(db, '#atlas-1', null).id).toBe(head.id)
  expect(findThread(db, '1', 'atlas').id).toBe(head.id)
  expect(findThread(db, head.id.slice(0, 8), null).id).toBe(head.id)
  expect(() => findThread(db, 'pane-1', null)).toThrow(/no thread/)
  expect(ID_REF.test(head.id.slice(0, 9))).toBe(false)
  expect(ID_REF.test(`${head.id}0`)).toBe(false)
})
