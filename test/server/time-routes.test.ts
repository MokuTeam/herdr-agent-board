// The Time panel through the board's server (#233, server/routes/time.ts): the day by client as
// billed, today's totals by lane in the payload; nothing of it while time is off.

import { Database } from 'bun:sqlite'
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dbFile, openDb } from '../../src/adapters/db.ts'
import { addEntry } from '../../src/adapters/time-store.ts'
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

test('changes as the owner: add, a trim with the revision read, a stale one refused, a move, remove and restore', async () => {
  const box = await sandbox()
  const folder = join(box.dir, 'Sync')
  mkdirSync(folder)
  const state = join(box.dir, 'state', 'herdr', 'plugins', 'agent-board')
  mkdirSync(join(state, 'backup'), { recursive: true })
  writeFileSync(
    join(state, 'backup', 'backup-key.json'),
    JSON.stringify(makeKey('correct horse battery', 1, { logN: 10, r: 8, p: 1 })),
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
  const add = {
    op: 'add',
    client: 'client-a',
    project: 'Support',
    description: 'Case 10001 X: work',
    start: '2026-10-28T13:00:00Z',
    stop: '2026-10-28T14:30:00Z',
  }
  assert.notEqual((await post(add, {}))[0], 200, 'the board’s header is required')
  const [status, made] = await post(add)
  assert.equal(status, 200)
  const entry = made.entry as { id: string; rev: number; by: unknown; seconds: number }
  assert.equal(entry.by, 'user')
  const [, trimmed] = await post({ op: 'edit', id: entry.id, rev: entry.rev, stop: '2026-10-28T14:00:00Z' })
  assert.equal((trimmed.entry as { seconds: number }).seconds, 3600)
  const [stale, why] = await post({ op: 'edit', id: entry.id, rev: entry.rev, description: 'Case 10001 X: other' })
  assert.equal(stale, 409)
  assert.match(String(why.error), /changed since/)
  const [, moved] = await post({ op: 'move', id: entry.id, date: '2026-10-30' })
  assert.equal((moved.entry as { date: string }).date, '2026-10-30')
  assert.equal((await post({ op: 'remove', id: entry.id }))[0], 200)
  const day = await json(await fetch(`${url}/api/time?date=2026-10-30`))
  assert.deepEqual(day.entries, [])
  assert.deepEqual(day.projects, { 'client-a': ['Support'] })
  assert.equal((await post({ op: 'restore', id: entry.id }))[0], 200)
  assert.equal(((await json(await fetch(`${url}/api/time?date=2026-10-30`))).entries as unknown[]).length, 1)
  assert.equal((await post({ op: 'edit', id: 'nope0000', description: 'x' }))[0], 404)
  assert.equal((await post({ ...add, project: 'Suport' }))[0], 400)
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
