// Settings → Time's edits as the service makes them (#237, services/time-settings.ts): a config.json
// that does not read as JSON is never replaced; a rename to the same name touches nothing; a rename
// whose database write fails after config.json was written puts the file back; no `time` at all is
// no lane yet, and a change other than On sets it up off; every spelling of a name is counted as one.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { updateTarget, writeKey } from '../../src/adapters/backup-store.ts'
import { configFile } from '../../src/adapters/config-file.ts'
import { type BoardDb, openDb } from '../../src/adapters/db.ts'
import { addEntry, getEntry } from '../../src/adapters/time-store.ts'
import { makeKey } from '../../src/core/backup-file.ts'
import { timeConfig } from '../../src/core/time.ts'
import { editTimeSettings, timeSettingsView, type WithDb } from '../../src/services/time-settings.ts'
import { isolatedHome } from '../support/env.ts'

const TIME = { zone: 'America/New_York', clients: { 'client-a': { projects: ['Help Desk', 'Café'] } } }

async function setUp(config: unknown = { language: 'en', time: TIME }) {
  const dir = isolatedHome()
  const folder = join(dir, 'Sync')
  mkdirSync(folder)
  await writeKey(makeKey('correct horse battery', 1, { logN: 10, r: 8, p: 1 }))
  updateTarget('folder', st => ({ ...st, tested: Date.now(), where: folder }))
  mkdirSync(join(configFile(), '..'), { recursive: true })
  const raw = { ...(config as Record<string, unknown>), backup: { folder } }
  writeFileSync(configFile(), typeof config === 'string' ? config : JSON.stringify(raw, null, 2))
  const db = openDb()
  assert.ok(db)
  const withDb: WithDb = (_create, fn) => fn(db)
  return { db, withDb }
}

const saved = () => JSON.parse(readFileSync(configFile(), 'utf8')) as { time: typeof TIME & { on?: boolean } }

function entry(db: BoardDb, project: string, hour: number) {
  const conf = timeConfig({ zone: 'America/New_York' })
  assert.ok(conf)
  const start = Date.parse(`2026-10-28T${hour}:00:00Z`)
  return addEntry(
    db,
    conf,
    {
      client: 'client-a',
      project,
      description: 'Case 10001 X: work',
      start,
      stop: start + 1_800_000,
      startGiven: true,
    },
    'user',
  ).entry
}

test('a config.json that does not read as JSON is never replaced: every change refused in words, the view says so', async () => {
  const { db, withDb } = await setUp()
  const broken = `${JSON.stringify({ language: 'en', time: TIME }, null, 2).slice(0, -2)},\n}`
  writeFileSync(configFile(), broken)
  const r = editTimeSettings({ op: 'zone', zone: 'Europe/Berlin' }, withDb)
  assert.deepEqual([r.ok, !r.ok && r.code], [false, 'configUnreadable'])
  assert.equal(readFileSync(configFile(), 'utf8'), broken)
  const view = timeSettingsView(withDb)
  assert.equal(view.unreadable, true)
  assert.match(view.problems[0] ?? '', /does not read as JSON/)
  db.close()
})

test('a rename to the same name once cleaned touches no entry; one whose database write fails puts config.json back', async () => {
  const { db, withDb } = await setUp()
  const e = entry(db, 'Help Desk', 10)
  assert.deepEqual(
    editTimeSettings({ op: 'rename', client: 'client-a', from: 'Help Desk', to: ' Help Desk ' }, withDb),
    {
      ok: true,
      moved: 0,
    },
  )
  assert.equal(getEntry(db, e.id)?.rev, 1)
  // the database refuses after the config was written in its transaction: both as they were
  const before = saved()
  const failing: WithDb = (_create, fn) =>
    fn({
      ...db,
      db: db.db,
      write: (by, f) =>
        db.write(by, tx => {
          f(tx)
          throw new Error('disk full')
        }),
    } as BoardDb)
  const r = editTimeSettings({ op: 'rename', client: 'client-a', from: 'Help Desk', to: 'Support' }, failing)
  assert.equal(r.ok, false)
  assert.deepEqual(saved(), before)
  assert.equal(getEntry(db, e.id)?.project, 'Help Desk')
  db.close()
})

test('no time at all: no lane yet (not every lane); a lane taken sets time up off, the lanes chosen are the first clients', async () => {
  const first = await setUp({ language: 'en' })
  const view = timeSettingsView(first.withDb)
  assert.deepEqual([view.set, view.on, view.every], [false, false, false])
  assert.equal(editTimeSettings({ op: 'client', client: 'client-a', on: true }, first.withDb).ok, true)
  assert.equal(saved().time.on, false, 'nothing but On turns it on')
  assert.deepEqual(saved().time.clients, { 'client-a': { projects: [] } })
  first.db.close()
  const second = await setUp({ language: 'en' })
  assert.equal(editTimeSettings({ op: 'lanes', lanes: ['client-a', 'client-b'] }, second.withDb).ok, true)
  assert.deepEqual(Object.keys(saved().time.clients), ['client-a', 'client-b'])
  second.db.close()
})

test('a project’s entries counted under its listed name, whatever their spelling; a rename moves them all', async () => {
  const { db, withDb } = await setUp()
  entry(db, 'Help Desk', 10)
  entry(db, 'help desk', 11)
  entry(db, `Cafe${String.fromCharCode(0x301)}`, 12)
  entry(db, 'Elsewhere', 13)
  assert.deepEqual(timeSettingsView(withDb).clients['client-a']?.use, { 'Help Desk': 2, Café: 1, Elsewhere: 1 })
  assert.deepEqual(editTimeSettings({ op: 'rename', client: 'client-a', from: 'Help Desk', to: 'Support' }, withDb), {
    ok: true,
    moved: 2,
  })
  assert.deepEqual(timeSettingsView(withDb).clients['client-a']?.use, { Support: 2, Café: 1, Elsewhere: 1 })
  db.close()
})
