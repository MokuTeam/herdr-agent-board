// The Time panel through the board's server (#233, server/routes/time.ts): the day by client as
// billed, today's totals by lane in the payload; nothing of it while time is off.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openDb } from '../../src/adapters/db.ts'
import { addEntry } from '../../src/adapters/time-store.ts'
import { dateIn, timeConfig } from '../../src/core/time.ts'
import { serveBoard } from '../support/board-server.ts'
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
