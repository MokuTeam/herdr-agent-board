// The Time panel through the board's server (#233, server/routes/time.ts): the day by client as
// billed, today's totals by lane in the payload; nothing of it while time is off.

import { Database } from 'bun:sqlite'
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dbFile, openDb } from '../../src/adapters/db.ts'
import { addEntry } from '../../src/adapters/time-store.ts'
import { freshTarget } from '../../src/core/backup.ts'
import { makeKey } from '../../src/core/backup-file.ts'
import { dateIn, timeConfig } from '../../src/core/time.ts'
import { timeToday } from '../../src/server/routes/time.ts'
import { serveBoard } from '../support/board-server.ts'
import { isolatedHome } from '../support/env.ts'
import { sandbox } from '../support/sandbox.ts'

const json = async (res: Response) => (await res.json()) as Record<string, unknown>
const TIME = {
  zone: 'America/New_York',
  clients: { 'client-a': { projects: ['Support'], billing: [{ group: 'ref', step: 30, round: 'up' }] } },
}

test('time off: no time in the payload, and /api/time says it is off', async () => {
  const box = await sandbox()
  const { url } = await serveBoard(box, { language: 'en' })
  assert.equal('time' in (await json(await fetch(`${url}/api/board`))), false)
  assert.equal((await fetch(`${url}/api/time`)).status, 409)
})

test('time on: the day by client as billed, and today’s billed time by lane in the payload', async () => {
  const box = await sandbox()
  const conf = timeConfig(TIME)
  assert.ok(conf)
  const today = dateIn(Date.now(), conf.zone)
  // the entries written into the sandbox's database before the board starts
  const db = openDb({ path: join(box.dir, 'state', 'herdr', 'plugins', 'agent-board', 'board.db') })
  assert.ok(db)
  const start = Date.parse(`${today}T15:00:00Z`)
  addEntry(
    db,
    conf,
    {
      client: 'client-a',
      project: 'Support',
      description: 'Case 10001 X: work',
      start,
      stop: start + 42 * 60_000,
      startGiven: true,
    },
    { key: 's1', name: 'One' },
  )
  db.close()
  const { url } = await serveBoard(box, { language: 'en', time: TIME })
  const board = await json(await fetch(`${url}/api/board`))
  assert.deepEqual((board.time as { today: unknown }).today, { 'client-a': 3600 })
  const day = await json(await fetch(`${url}/api/time?date=${today}`))
  const days = day.days as { client: string; seconds: number; billedSeconds: number }[]
  assert.deepEqual(
    days.map(d => [d.client, d.seconds, d.billedSeconds]),
    [['client-a', 2520, 3600]],
  )
  assert.equal((day.entries as unknown[]).length, 1)
  assert.equal((await fetch(`${url}/api/time?date=nope`)).status, 400)
})

test('a time read that fails does not stop the board: the line is empty, said once; each client’s today in its own zone; problems flagged', () => {
  isolatedHome()
  const conf = { ...TIME, clients: { ...TIME.clients, east: { zone: 'Asia/Tokyo' } } }
  // 23:30 in New York is already the next day in Tokyo
  const now = Date.parse('2026-10-29T03:30:00Z')
  const db = openDb()
  assert.ok(db)
  const c = timeConfig(conf)
  assert.ok(c)
  const entry = (client: string, start: string) =>
    addEntry(
      db,
      c,
      {
        client,
        project: 'Support',
        description: 'Case 10001 X: work',
        start: Date.parse(start),
        stop: Date.parse(start) + 30 * 60_000,
        startGiven: true,
      },
      'user',
    )
  entry('client-a', '2026-10-29T02:00:00Z') // 22:00 on the 28th in New York
  entry('east', '2026-10-29T01:00:00Z') // 10:00 on the 29th in Tokyo
  db.close()
  const line = timeToday({ time: conf }, now)
  assert.deepEqual([line?.date, line?.today], ['2026-10-28', { 'client-a': 1800, east: 1800 }])
  assert.equal(line?.problems, undefined)
  // a read that throws after the file opened (here: the table gone)
  const raw = new Database(dbFile())
  raw.exec('DROP TABLE time_entries')
  raw.close()
  const errors: string[] = []
  const was = console.error
  console.error = (...a: unknown[]) => errors.push(a.join(' '))
  try {
    assert.deepEqual(timeToday({ time: conf }, now), { seq: -1, date: '2026-10-28', today: {} })
    assert.deepEqual(timeToday({ time: conf }, now), { seq: -1, date: '2026-10-28', today: {} })
  } finally {
    console.error = was
  }
  assert.equal(errors.length, 1, 'said once, not on every publish')
  assert.equal(timeToday({ time: { ...conf, zone: 'Nowhere/Here' } }, now)?.problems, true)
})

/** A board with time on, a backup target and key, and a Test of it that went through once. */
async function writableBoard(tested = true) {
  const box = await sandbox()
  const folder = join(box.dir, 'Sync')
  mkdirSync(folder)
  const state = join(box.dir, 'state', 'herdr', 'plugins', 'agent-board')
  mkdirSync(join(state, 'backup'), { recursive: true })
  writeFileSync(
    join(state, 'backup', 'backup-key.json'),
    JSON.stringify(makeKey('correct horse battery', 1, { logN: 10, r: 8, p: 1 })),
  )
  if (tested)
    writeFileSync(
      join(state, 'backup', 'status.json'),
      JSON.stringify({ targets: { folder: { ...freshTarget(), tested: Date.now() } } }),
    )
  const { url } = await serveBoard(box, { language: 'en', time: TIME, backup: { folder } })
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = { 'x-board': '1' }) => {
    const res = await fetch(`${url}/api/time`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return [res.status, await json(res)] as const
  }
  return { url, post, state }
}

const NEAR = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)
const add = {
  op: 'add',
  client: 'client-a',
  project: 'Support',
  description: 'Case 10001 X: work',
  start: `${NEAR}T13:00:00Z`,
  stop: `${NEAR}T14:30:00Z`,
}
type Made = { id: string; rev: number; by: unknown; seconds: number; date: string; stop: string }

test('changes as the owner: add, a trim with the revision read, a stale one refused, a move, remove and restore', async () => {
  const { url, post } = await writableBoard()
  assert.notEqual((await post(add, {}))[0], 200, 'the board’s header is required')
  const [status, made] = await post(add)
  assert.equal(status, 200)
  const entry = made.entry as Made
  assert.equal(entry.by, 'user')
  const [, trimmed] = await post({ op: 'edit', id: entry.id, rev: entry.rev, stop: `${NEAR}T14:00:00Z` })
  const t1 = trimmed.entry as Made
  assert.equal(t1.seconds, 3600)
  const [stale, why] = await post({ op: 'edit', id: entry.id, rev: entry.rev, description: 'Case 10001 X: other' })
  assert.equal(stale, 409)
  assert.equal(why.code, 'changedSince', 'a code beside the words, for the page’s own')
  const to = new Date(Date.parse(`${NEAR}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  const [, moved] = await post({ op: 'move', id: entry.id, rev: t1.rev, date: to })
  const m = moved.entry as Made
  assert.equal(m.date, to)
  const [, removed] = await post({ op: 'remove', id: entry.id, rev: m.rev })
  const day = await json(await fetch(`${url}/api/time?date=${to}`))
  assert.deepEqual(day.entries, [])
  assert.deepEqual(day.projects, { 'client-a': ['Support'] })
  assert.equal((await post({ op: 'restore', id: entry.id, rev: (removed.entry as Made).rev }))[0], 200)
  assert.equal(((await json(await fetch(`${url}/api/time?date=${to}`))).entries as unknown[]).length, 1)
  assert.equal((await post({ op: 'edit', id: 'nope0000', rev: 1, description: 'x' }))[0], 404)
  assert.equal((await post({ ...add, project: 'Suport' }))[0], 400)
})

test('every change says the revision it read, an integer; a stale one is refused on each op', async () => {
  const { post } = await writableBoard()
  const e = (await post(add))[1].entry as Made
  await post({ op: 'edit', id: e.id, rev: e.rev, description: 'Case 10001 X: corrected' })
  // rev 1 is stale now; a rev that is not an integer, or none, is no change at all
  for (const rev of ['1', 1.5, null, undefined])
    assert.deepEqual(
      [JSON.stringify(rev), (await post({ op: 'edit', id: e.id, rev, description: 'x' }))[1].code],
      [JSON.stringify(rev), 'rev'],
    )
  for (const op of [{ op: 'edit', description: 'x' }, { op: 'move', date: NEAR }, { op: 'remove' }, { op: 'raise' }]) {
    assert.equal((await post({ ...op, id: e.id }))[0], 400, `${op.op} without a rev`)
    assert.equal((await post({ ...op, id: e.id, rev: 1 }))[0], op.op === 'raise' ? 400 : 409, `${op.op} stale`)
  }
})

test('times are ISO with an offset, within a day ahead and a year back; tags are counted', async () => {
  const { post } = await writableBoard()
  for (const [start, code] of [
    ['9999-01-01T10:00:00Z', 'whenRange'],
    ['0000-01-01T10:00:00Z', 'whenRange'],
    [`${NEAR}T10:00:00`, 'when'],
    ['1', 'when'],
  ] as const)
    assert.deepEqual([start, (await post({ ...add, start }))[1].code], [start, code])
  const e = (await post(add))[1].entry as Made
  assert.equal((await post({ op: 'move', id: e.id, rev: e.rev, date: '0000-01-01' }))[1].code, 'whenRange')
  const tags = Array.from({ length: 21 }, (_, i) => `t${i}`)
  assert.equal((await post({ op: 'edit', id: e.id, rev: e.rev, tags }))[1].code, 'tags')
})

test('Raise lengthens a line’s last entry by the gap the board works out now', async () => {
  const { post } = await writableBoard()
  // 40 minutes in a 30-minute step rounded up: 60 billed, 20 to raise
  const e = (await post({ ...add, stop: `${NEAR}T13:40:00Z` }))[1].entry as Made
  const [status, raised] = await post({ op: 'raise', id: e.id, rev: e.rev })
  assert.equal(status, 200)
  assert.equal((raised.entry as Made).stop, `${NEAR}T14:00:00Z`)
  // nothing left to raise
  assert.equal((await post({ op: 'raise', id: e.id, rev: (raised.entry as Made).rev }))[1].code, 'noRaise')
})

test('a target that never took a backup is no backup: the board refuses as the command does', async () => {
  const { post } = await writableBoard(false)
  const [status, why] = await post(add)
  assert.equal(status, 409)
  assert.equal(why.code, 'notBackedUp')
})

test('no change before the database has a backup target and a passphrase', async () => {
  const box = await sandbox()
  const { url } = await serveBoard(box, { language: 'en', time: TIME })
  const res = await fetch(`${url}/api/time`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'remove', id: 'x' }),
  })
  assert.equal(res.status, 409)
  assert.match(String((await json(res)).error), /backed up/)
})
