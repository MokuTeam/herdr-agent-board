import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readCard, writeCard } from '../../src/adapters/cards.ts'
import { DbError, integrityOf, markDamaged, openDb } from '../../src/adapters/db.ts'
import { LATEST } from '../../src/adapters/db-schema.ts'
import { scheduleDir, stateDir } from '../../src/adapters/paths.ts'
import { addEntry, addWatch, getEntry, getWatch } from '../../src/adapters/schedule-store.ts'
import { createThread, getThread } from '../../src/adapters/work-thread-store.ts'
import { rekeyBoard } from '../../src/services/db-rekey.ts'
import { ownerWatchFile } from '../../src/services/owner-watch.ts'
import { isolatedHome } from '../support/env.ts'

const S1 = '0f8fad5b-d9cb-469f-a165-70867728950e'
const S2 = '11111111-2222-3333-4444-555555555555'
const PANE = 'pane-w2:p3'

function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (name === 'board.db-wal' || name === 'board.db-shm') continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else out[relative(root, p)] = readFileSync(p).toString('base64')
    }
  }
  walk(root)
  return out
}

test('rekeyBoard rekeys board.db, schedule, watches, legacy move marks and owner-watch with dry-run, backup and idempotency', () => {
  isolatedHome()
  const state = stateDir()

  // Seed board.db
  const db = openDb({ create: true })
  if (!db) throw new Error('no db')
  const tid = db.write(
    'test',
    tx =>
      createThread(tx, {
        lane: 'atlas',
        title: 'Move role',
        status: 'doing',
        author: { kind: 'session', key: S1, name: 'Anna' },
        assignee: { kind: 'session', key: `@server-1:${S2}`, name: 'Ben' },
        at: 100,
      }).head.id,
  )
  db.close()

  // Seed schedule entries (normal + agent from + synthetic from + receipt 0600) and a watch
  const e1 = addEntry({
    key: S1,
    name: 'Anna',
    text: 'check build',
    at: 5000,
    next: 5000,
    from: { key: `@server-1:${S2}`, name: 'Ben' },
    movedFrom: { key: PANE, name: 'Old' },
  })
  const e2 = addEntry({
    key: `@server-1:${S2}`,
    name: 'Ben',
    text: 'thread digest',
    at: 6000,
    next: 6000,
    by: 'threads',
    from: { key: 'threads', name: 'threads' },
  })
  const eReceipt = addEntry({
    key: S1,
    name: 'Anna',
    kind: 'call',
    text: 'report',
    at: 7000,
    next: 7000,
    receipt: { key: 'h', session: S1, reportId: 'r1', hash: '0'.repeat(64) },
  })
  const { watch: w1 } = addWatch({
    key: `@server-1:${PANE}`,
    name: 'Cleo',
    text: 'wait ci',
    next: 8000,
    probe: { cmd: 'true', everyMs: 60_000, timeoutMs: 5000 },
  })

  // Seed legacy move marks (one legacy 'board', one legacy 'local', one real device 'server-1')
  writeCard(S1, { moved: { to: 'board', cwd: '/tmp/a', at: 100 } })
  writeCard(PANE, { moved: { to: 'local', cwd: '/tmp/b', at: 100 } })
  writeCard(S2, { moved: { to: 'server-1', cwd: '/tmp/c', at: 100 } })

  // Seed owner-watch.json
  mkdirSync(state, { recursive: true })
  writeFileSync(
    ownerWatchFile(),
    JSON.stringify({
      [S1]: { at: 50, told: { [`card:@server-1:${S2}`]: { who: 'Ben', text: 'ready?' } } },
    }),
    { mode: 0o600 },
  )

  // 1. Dry run: writes nothing anywhere.
  const snapBefore = snapshotTree(state)
  const dry = rekeyBoard({ from: 'laptop', to: 'server-1', dryRun: true })
  expect(dry.dryRun).toBe(true)
  expect(dry.already).toBe(false)
  expect(dry.backup).toBeNull()
  expect(dry.db.total).toBe(4)
  expect(dry.schedule.entries.map(e => e.id).sort()).toEqual([e1.id, e2.id, eReceipt.id].sort())
  expect(dry.schedule.watches.map(w => w.id)).toEqual([w1.id])
  expect(dry.moveMarks.length).toBe(2)
  expect(dry.ownerWatch).toEqual({ exists: true, sessions: 1, cards: 1 })
  expect(snapshotTree(state)).toEqual(snapBefore)

  // 2. Real run: creates verified backup and rewrites everything.
  const real = rekeyBoard({ from: 'laptop', to: 'server-1', now: () => 1_700_000_000_000 })
  expect(real.dryRun).toBe(false)
  expect(real.already).toBe(false)
  expect(real.backup).not.toBeNull()
  expect(existsSync(join(real.backup as string, 'board.db'))).toBe(true)
  expect(integrityOf(join(real.backup as string, 'board.db')).ok).toBe(true)
  expect(existsSync(join(real.backup as string, 'schedule', `${e1.id}.json`))).toBe(true)
  expect(existsSync(join(real.backup as string, 'schedule', 'watches', `${w1.id}.json`))).toBe(true)
  expect(existsSync(join(real.backup as string, 'owner-watch.json'))).toBe(true)

  const dbAfter = openDb({ create: false })
  if (!dbAfter) throw new Error('missing db')
  expect(getThread(dbAfter, tid)?.createdBy).toEqual({ kind: 'session', key: `@laptop:${S1}`, name: 'Anna' })
  expect(getThread(dbAfter, tid)?.assignee).toEqual({ kind: 'session', key: S2, name: 'Ben' })
  dbAfter.close()

  expect(getEntry(e1.id)?.key).toBe(`@laptop:${S1}`)
  expect(getEntry(e1.id)?.from).toEqual({ key: S2, name: 'Ben' })
  expect(getEntry(e1.id)?.movedFrom).toEqual({ key: `@laptop:${PANE}`, name: 'Old' })
  expect(getEntry(e2.id)?.key).toBe(S2)
  expect(getEntry(e2.id)?.from).toEqual({ key: 'threads', name: 'threads' })
  expect(getEntry(eReceipt.id)?.key).toBe(`@laptop:${S1}`)
  expect(statSync(join(scheduleDir(), `${eReceipt.id}.json`)).mode & 0o777).toBe(0o600)
  expect(getWatch(w1.id)?.key).toBe(PANE)

  expect((readCard(S1)?.moved as { to?: string } | undefined)?.to).toBe('laptop')
  expect((readCard(PANE)?.moved as { to?: string } | undefined)?.to).toBe('laptop')
  expect((readCard(S2)?.moved as { to?: string } | undefined)?.to).toBe('server-1')

  const owAfter = JSON.parse(readFileSync(ownerWatchFile(), 'utf8')) as Record<
    string,
    { told: Record<string, unknown> }
  >
  expect(Object.keys(owAfter)).toEqual([`@laptop:${S1}`])
  expect(owAfter[`@laptop:${S1}`]?.told[`card:${S2}`]).toEqual({ who: 'Ben', text: 'ready?' })

  // 3. Idempotent second run: no backup, zero changes, disk untouched.
  const snapAfterFirst = snapshotTree(state)
  const second = rekeyBoard({ from: 'laptop', to: 'server-1' })
  expect(second.already).toBe(true)
  expect(second.backup).toBeNull()
  expect(second.db.total).toBe(0)
  expect(second.schedule.entries).toEqual([])
  expect(second.schedule.watches).toEqual([])
  expect(second.moveMarks).toEqual([])
  expect(snapshotTree(state)).toEqual(snapAfterFirst)

  // 4. Reverse run maps everything back cleanly.
  const rev = rekeyBoard({ from: 'server-1', to: 'laptop' })
  expect(rev.already).toBe(false)
  expect(rev.backup).not.toBeNull()
  expect(getEntry(e1.id)?.key).toBe(S1)
  expect(getEntry(e1.id)?.from).toEqual({ key: `@server-1:${S2}`, name: 'Ben' })
  expect(getEntry(e2.id)?.key).toBe(`@server-1:${S2}`)
  expect(getWatch(w1.id)?.key).toBe(`@server-1:${PANE}`)
  const dbRev = openDb({ create: false })
  expect(dbRev && getThread(dbRev, tid)?.createdBy).toEqual({ kind: 'session', key: S1, name: 'Anna' })
  expect(dbRev && getThread(dbRev, tid)?.assignee).toEqual({ kind: 'session', key: `@server-1:${S2}`, name: 'Ben' })
  dbRev?.close()
})

test('non-nodes / DB-less board parity: rekeyBoard never creates board.db or state files when absent', () => {
  isolatedHome()
  const state = stateDir()
  writeCard(S1, { doing: 'normal local session', category: 'atlas' })
  const before = snapshotTree(state)

  const dry = rekeyBoard({ from: 'laptop', to: 'server-1', dryRun: true })
  expect(dry.db.exists).toBe(false)
  expect(dry.already).toBe(false)
  expect(snapshotTree(state)).toEqual(before)

  const real = rekeyBoard({ from: 'laptop', to: 'server-1' })
  expect(real.db.exists).toBe(false)
  expect(real.backup).toBeNull()
  expect(snapshotTree(state)).toEqual(before)
})

test('new schedule or owner-watch created after initial rekey stays untouched on idempotent retry, and mid-loop schedule crash resumes cleanly', () => {
  isolatedHome()
  const state = stateDir()

  // Initial state: board.db only (no schedule/, no owner-watch.json).
  const db = openDb({ create: true })
  if (!db) throw new Error('no db')
  db.write('test', tx =>
    createThread(tx, {
      lane: 'atlas',
      title: 'Empty schedule first',
      status: 'next',
      author: { kind: 'session', key: S1, name: 'Anna' },
      at: 100,
    }),
  )
  db.close()

  const first = rekeyBoard({ from: 'laptop', to: 'server-1' })
  expect(first.already).toBe(false)

  // New master creates a schedule entry and owner-watch.json afterwards.
  const newEntry = addEntry({ key: S2, name: 'Ben', text: 'later on server-1', at: 9000, next: 9000 })
  writeFileSync(ownerWatchFile(), JSON.stringify({ [S2]: { at: 50, told: {} } }), { mode: 0o600 })

  // Idempotent retry must NOT rekey the new server-1 entries into @laptop:.
  const retry = rekeyBoard({ from: 'laptop', to: 'server-1' })
  expect(retry.already).toBe(true)
  expect(getEntry(newEntry.id)?.key).toBe(S2)
  expect(Object.keys(JSON.parse(readFileSync(ownerWatchFile(), 'utf8')))).toEqual([S2])

  // Simulate mid-loop crash recovery on a reverse move (server-1 -> laptop).
  const secondEntry = addEntry({ key: `@laptop:${S1}`, name: 'Anna', text: 'back to laptop', at: 9500, next: 9500 })
  // Pretend `newEntry` already flipped on disk before a crash (`done: false`, `completed: [newEntry.id]`).
  writeFileSync(
    join(scheduleDir(), `${newEntry.id}.json`),
    JSON.stringify({ ...getEntry(newEntry.id), key: `@server-1:${S2}` }),
  )
  writeFileSync(
    join(scheduleDir(), '.rekey.json'),
    JSON.stringify({
      from: 'server-1',
      to: 'laptop',
      at: Date.now(),
      done: false,
      completed: [newEntry.id],
      watchesCompleted: [],
    }),
  )

  const resumed = rekeyBoard({ from: 'server-1', to: 'laptop' })
  expect(resumed.already).toBe(false)
  expect(getEntry(newEntry.id)?.key).toBe(`@server-1:${S2}`)
  expect(getEntry(secondEntry.id)?.key).toBe(S1)
  expect(readdirSync(state).filter(n => n.startsWith('before-rekey-server-1-to-laptop-')).length).toBe(1)
})

test('damaged or newer board.db fails cleanly in both dry-run and real run without leaving an empty backup folder', () => {
  isolatedHome()
  const state = stateDir()
  const dbPath = join(state, 'board.db')

  const db = openDb({ create: true })
  db?.close()

  // Newer DB version refuses both dry-run and real run.
  const raw = new Database(dbPath)
  raw.exec(`PRAGMA user_version = ${LATEST + 1}`)
  raw.close()

  expect(() => rekeyBoard({ from: 'laptop', to: 'server-1', dryRun: true })).toThrow(DbError)
  expect(() => rekeyBoard({ from: 'laptop', to: 'server-1' })).toThrow(DbError)
  expect(readdirSync(state).filter(n => n.startsWith('before-rekey-'))).toEqual([])

  // Reset version and mark damaged: refuses both dry-run and real run without leaving backup dir.
  const fix = new Database(dbPath)
  fix.exec(`PRAGMA user_version = ${LATEST}`)
  fix.close()
  markDamaged(dbPath, 'corrupt page')

  expect(() => rekeyBoard({ from: 'laptop', to: 'server-1', dryRun: true })).toThrow(DbError)
  expect(() => rekeyBoard({ from: 'laptop', to: 'server-1' })).toThrow(DbError)
  expect(readdirSync(state).filter(n => n.startsWith('before-rekey-'))).toEqual([])
})
