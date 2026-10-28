import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  activeTargets,
  backupConfig,
  backupProblems,
  freshTarget,
  KEEP_ALL_MS,
  lastDailyMark,
  MOST_WAIT_MS,
  passphraseProblem,
  problemSentence,
  QUIET_MS,
  RETRY_MS,
  rotationKeeps,
  snapshotName,
  snapshotTime,
  targetDue,
} from '../../src/core/backup.ts'

const HOUR = 3_600_000

test('backupConfig reads the folder and the server, and anything else as no target', () => {
  assert.deepEqual(backupConfig(undefined), { folder: null, server: null })
  assert.deepEqual(backupConfig({ folder: '  ', server: { host: '' } }), { folder: null, server: null })
  const c = backupConfig({
    folder: ' D:\\Sync ',
    server: { host: 'example.org', port: '2222', admin: { user: 'me', key: '' }, set: '2026-10-29T00:00:00Z' },
  })
  assert.equal(c.folder, 'D:\\Sync')
  assert.deepEqual(c.server, {
    host: 'example.org',
    port: 2222,
    admin: { user: 'me', key: '' },
    set: '2026-10-29T00:00:00Z',
  })
  assert.equal(backupConfig({ server: { host: 'h', port: 70000 } }).server?.port, 22)
  // a server not set up yet takes no snapshots
  assert.deepEqual(activeTargets(backupConfig({ server: { host: 'h' } })), [])
  assert.deepEqual(activeTargets(c), ['folder', 'server'])
})

test('a snapshot name says when it was made, to the second, and the start of its hash', () => {
  const at = Date.UTC(2026, 9, 29, 3, 4, 5)
  const name = snapshotName(at, 'ABCDEF0123456789')
  assert.equal(name, '20261029T030405Z-abcdef01.abk')
  assert.equal(snapshotTime(name), at)
  assert.equal(snapshotTime('20261332T000000Z-abcdef01.abk'), null)
  assert.equal(snapshotTime('notes.txt'), null)
})

test('the rotation keeps the last 48 hours, the first of each day for 60 days, the first of each month for two years', () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0)
  const at = (ms: number, hash = '00000000') => snapshotName(now - ms, hash)
  const recent = [at(HOUR), at(5 * HOUR), at(47 * HOUR)]
  const dayA1 = snapshotName(Date.UTC(2026, 9, 20, 1), '11111111')
  const dayA2 = snapshotName(Date.UTC(2026, 9, 20, 9), '22222222')
  const old1 = snapshotName(Date.UTC(2026, 3, 2, 1), '33333333')
  const old2 = snapshotName(Date.UTC(2026, 3, 9, 1), '44444444')
  const ancient = snapshotName(Date.UTC(2023, 0, 5), '55555555')
  const future = snapshotName(now + HOUR, '66666666')
  const keep = rotationKeeps([...recent, dayA2, dayA1, old2, old1, ancient, future, 'readme.txt'], now)
  for (const n of [...recent, dayA1, old1, future, 'readme.txt']) assert.ok(keep.has(n), n)
  for (const n of [dayA2, old2, ancient]) assert.ok(!keep.has(n), n)
  // exactly at 48 hours it is no longer "recent"
  const edge = at(KEEP_ALL_MS)
  const sameDayEarlier = snapshotName(now - KEEP_ALL_MS - HOUR, 'aaaaaaaa')
  assert.equal(rotationKeeps([sameDayEarlier, edge], now).has(edge), false)
})

test('targetDue waits for quiet after changes, but not past MOST_WAIT_MS, and takes the daily one', () => {
  const now = new Date(2026, 9, 29, 14, 0, 0).getTime()
  const fresh = { ...freshTarget(), lastOk: now - HOUR, seq: 5, name: 'x' }
  assert.equal(targetDue(fresh, { seq: 5, lastAt: now - 2 * HOUR, firstUnsavedAt: null }, now), null)
  // a change a minute ago: wait
  assert.equal(targetDue(fresh, { seq: 6, lastAt: now - 60_000, firstUnsavedAt: now - 60_000 }, now), null)
  // quiet long enough
  assert.equal(targetDue(fresh, { seq: 6, lastAt: now - QUIET_MS, firstUnsavedAt: now - QUIET_MS }, now), 'changes')
  // never quiet, but the first change waits too long
  assert.equal(targetDue(fresh, { seq: 9, lastAt: now - 1000, firstUnsavedAt: now - MOST_WAIT_MS }, now), 'changes')
  // nothing since today's daily mark
  const yesterday = { ...fresh, lastOk: lastDailyMark(now) - 1 }
  assert.equal(targetDue(yesterday, { seq: 5, lastAt: 0, firstUnsavedAt: null }, now), 'daily')
  // a failure waits RETRY_MS before the next try
  const failed = { ...fresh, error: 'down', lastTry: now - 1000, failures: 1 }
  assert.equal(targetDue(failed, { seq: 6, lastAt: now - QUIET_MS, firstUnsavedAt: now - QUIET_MS }, now), null)
  const later = { ...failed, lastTry: now - RETRY_MS[0] }
  assert.equal(targetDue(later, { seq: 6, lastAt: now - QUIET_MS, firstUnsavedAt: now - QUIET_MS }, now), 'retry')
})

test('lastDailyMark is 03:00 local today once past it, else yesterday', () => {
  const before = new Date(2026, 9, 29, 2, 59).getTime()
  const after = new Date(2026, 9, 29, 3, 1).getTime()
  assert.equal(lastDailyMark(after), new Date(2026, 9, 29, 3, 0).getTime())
  assert.equal(lastDailyMark(before), new Date(2026, 9, 28, 3, 0).getTime())
})

test('backupProblems: nothing while there is no database; else no target, no key, stale, never, failing', () => {
  const now = Date.UTC(2026, 9, 29)
  const none = backupConfig({})
  assert.deepEqual(backupProblems({ needed: false, cfg: none, keySet: false, damaged: null, states: {}, now }), [])
  assert.deepEqual(
    backupProblems({ needed: true, cfg: none, keySet: false, damaged: null, states: {}, now }).map(p => p.kind),
    ['noTarget', 'noKey'],
  )
  const both = backupConfig({ folder: 'D:\\S', server: { host: 'h', set: 'x' } })
  const states = {
    folder: { ...freshTarget(), lastOk: now - 30 * HOUR, seq: 1 },
    server: { ...freshTarget(), error: 'refused', lastTry: now, failures: 2 },
  }
  const problems = backupProblems({ needed: true, cfg: both, keySet: true, damaged: 'bad page', states, now })
  assert.deepEqual(
    problems.map(p => p.kind),
    ['damaged', 'stale', 'never', 'failing'],
  )
  const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ''}`
  assert.equal(
    problemSentence(problems[1] as never, t),
    'backup.problem.stale{"target":"backup.target.folder","hours":30}',
  )
})

test('a passphrase needs 10 characters and no space at either end', () => {
  assert.equal(passphraseProblem('short'), 'backup.err.passphraseShort')
  assert.equal(passphraseProblem(' long enough pass'), 'backup.err.passphraseSpaces')
  assert.equal(passphraseProblem('correct horse battery'), null)
})
