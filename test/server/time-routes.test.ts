// The Time panel through the board's server (#233, server/routes/time.ts): the day by client as
// billed, today's totals by lane in the payload; nothing of it while time is off.

import { Database } from 'bun:sqlite'
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dbFile, openDb } from '../../src/adapters/db.ts'
import { addEntry } from '../../src/adapters/time-store.ts'
import { freshTarget } from '../../src/core/backup.ts'
import { makeKey } from '../../src/core/backup-file.ts'
import { dateIn, timeConfig } from '../../src/core/time.ts'
import { timeToday } from '../../src/server/routes/time.ts'
import { serveBoard } from '../support/board-server.ts'
import { isolatedHome } from '../support/env.ts'
import { sandbox, until } from '../support/sandbox.ts'

const json = async (res: Response) => (await res.json()) as Record<string, unknown>
const TIME = {
  zone: 'America/New_York',
  clients: {
    'client-a': {
      projects: ['Support'],
      billing: [{ group: 'ref', step: 30, round: 'up' }],
      systems: ['erp', { id: 'tracker', title: 'Tracker' }],
    },
    // billed under the time worked: to the nearest 30 minutes, and down to them
    'client-n': { projects: ['Support'], billing: [{ group: 'ref', step: 30, round: 'nearest' }] },
    'client-d': { projects: ['Support'], billing: [{ group: 'ref', step: 30, round: 'down' }] },
  },
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
      JSON.stringify({ targets: { folder: { ...freshTarget(), tested: Date.now(), where: folder } } }),
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
type Made = {
  id: string
  rev: number
  by: unknown
  seconds: number
  date: string
  stop: string
  billable: boolean
  billableDefault: boolean
  posts: { system: string; rev: number; record: string | null; changedAfter: boolean }[]
}

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
  assert.deepEqual(day.projects, { 'client-a': ['Support'], 'client-n': ['Support'], 'client-d': ['Support'] })
  assert.equal((await post({ op: 'restore', id: entry.id, rev: (removed.entry as Made).rev }))[0], 200)
  assert.equal(((await json(await fetch(`${url}/api/time?date=${to}`))).entries as unknown[]).length, 1)
  assert.equal((await post({ op: 'edit', id: 'nope0000', rev: 1, description: 'x' }))[0], 404)
  assert.equal((await post({ ...add, project: 'Suport' }))[0], 400)
})

test('the day offers tags: the ones held out of the totals first, then the ones entries have, most used first', async () => {
  const { url, post } = await writableBoard()
  const day = async () => (await json(await fetch(`${url}/api/time?date=${NEAR}`))).tags
  assert.deepEqual(await day(), ['deferred'])
  await post({ ...add, tags: ['call', 'review'] })
  await post({ ...add, start: `${NEAR}T15:00:00Z`, stop: `${NEAR}T15:30:00Z`, tags: ['call'] })
  const gone = (await post({ ...add, start: `${NEAR}T16:00:00Z`, stop: `${NEAR}T16:30:00Z`, tags: ['old'] }))[1]
    .entry as Made
  await post({ op: 'remove', id: gone.id, rev: gone.rev })
  assert.deepEqual(await day(), ['deferred', 'call', 'review'])
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
  for (const op of [
    { op: 'edit', description: 'x' },
    { op: 'move', date: NEAR },
    { op: 'remove' },
    { op: 'raise' },
    { op: 'trim' },
  ]) {
    assert.equal((await post({ ...op, id: e.id }))[0], 400, `${op.op} without a rev`)
    assert.equal((await post({ ...op, id: e.id, rev: 1 }))[0], 409, `${op.op} stale`)
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

test('Raise lengthens a line’s last entry by the gap the board works out now, wherever it is billed over its time', async () => {
  const { post } = await writableBoard()
  // 40 minutes in a 30-minute step rounded up: 60 billed, 20 to raise
  const e = (await post({ ...add, stop: `${NEAR}T13:40:00Z` }))[1].entry as Made
  const [status, raised] = await post({ op: 'raise', id: e.id, rev: e.rev })
  assert.equal(status, 200)
  assert.equal((raised.entry as Made).stop, `${NEAR}T14:00:00Z`)
  // nothing left to raise
  assert.equal((await post({ op: 'raise', id: e.id, rev: (raised.entry as Made).rev }))[1].code, 'noRaise')
  // to the nearest 30, 20 minutes are billed as 30: raised as well; billed under its time, not
  const near = (await post({ ...add, client: 'client-n', stop: `${NEAR}T13:20:00Z` }))[1].entry as Made
  assert.equal(((await post({ op: 'raise', id: near.id, rev: near.rev }))[1].entry as Made).stop, `${NEAR}T13:30:00Z`)
  const under = (await post({ ...add, client: 'client-d', stop: `${NEAR}T13:40:00Z` }))[1].entry as Made
  assert.equal((await post({ op: 'raise', id: under.id, rev: under.rev }))[1].code, 'noRaise')
})

/** The entries' stops and revisions as the day reads them now. */
async function stopsOf(url: string, ids: string[]): Promise<[string, number][]> {
  const day = await json(await fetch(`${url}/api/time?date=${NEAR}`))
  const entries = day.entries as Made[]
  return ids.map(id => {
    const e = entries.find(x => x.id === id)
    return [e?.stop ?? '', e?.rev ?? -1]
  })
}

test('Trim shortens a line billed under its time: from its last entry, then the one before, each kept a minute', async () => {
  const { url, post } = await writableBoard()
  const at = (hm: string) => `${NEAR}T${hm}:00Z`
  // 30 + 14 = 44 minutes to the nearest 30: 30 billed, 14 to trim; the last entry gives 13, the first 1
  const first = (await post({ ...add, client: 'client-n', start: at('13:00'), stop: at('13:30') }))[1].entry as Made
  const last = (await post({ ...add, client: 'client-n', start: at('14:00'), stop: at('14:14') }))[1].entry as Made
  // only the line's last entry names it
  assert.equal((await post({ op: 'trim', id: first.id, rev: first.rev }))[1].code, 'noTrim')
  const [status, trimmed] = await post({ op: 'trim', id: last.id, rev: last.rev })
  assert.equal(status, 200)
  const t = trimmed.entry as Made
  assert.deepEqual([t.stop, t.rev], [at('14:01'), last.rev + 1])
  assert.deepEqual(await stopsOf(url, [first.id, last.id]), [
    [at('13:29'), first.rev + 1],
    [at('14:01'), last.rev + 1],
  ])
  const day = await json(await fetch(`${url}/api/time?date=${NEAR}`))
  assert.deepEqual(
    (day.days as { lines: { seconds: number; billedSeconds: number }[] }[])[0]?.lines.map(l => [
      l.seconds,
      l.billedSeconds,
    ]),
    [[1800, 1800]],
  )
  // nothing left to trim; a stale revision is refused before anything is worked out
  assert.equal((await post({ op: 'trim', id: last.id, rev: t.rev }))[1].code, 'noTrim')
  assert.equal((await post({ op: 'trim', id: last.id, rev: last.rev }))[1].code, 'changedSince')
})

test('Trim is refused, nothing changed, where the line cannot get to its figure or is not billed under its time', async () => {
  const { url, post } = await writableBoard()
  // 20 minutes down to 30: 0 billed, and an entry keeps a minute
  const down = (await post({ ...add, client: 'client-d', stop: `${NEAR}T13:20:00Z` }))[1].entry as Made
  const [status, why] = await post({ op: 'trim', id: down.id, rev: down.rev })
  assert.deepEqual([status, why.code], [400, 'cannotTrim'])
  assert.deepEqual(await stopsOf(url, [down.id]), [[`${NEAR}T13:20:00Z`, down.rev]])
  // rounded up: Raise's, not Trim's
  const up = (await post({ ...add, stop: `${NEAR}T13:40:00Z` }))[1].entry as Made
  assert.equal((await post({ op: 'trim', id: up.id, rev: up.rev }))[1].code, 'noTrim')
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

test('billable set on an entry from the page, and back to the config’s; the day says each client’s settings', async () => {
  const { url, post } = await writableBoard()
  const e = (await post({ ...add, billable: false }))[1].entry as Made
  assert.deepEqual([e.billable, e.billableDefault], [false, false])
  const back = (await post({ op: 'edit', id: e.id, rev: e.rev, billable: null }))[1].entry as Made
  assert.deepEqual([back.billable, back.billableDefault, back.rev], [true, true, 2])
  assert.equal((await post({ op: 'edit', id: e.id, rev: back.rev, billable: 'no' }))[1].code, 'usage')
  assert.equal(
    (await post({ ...add, start: `${NEAR}T16:00:00Z`, stop: `${NEAR}T16:30:00Z`, billable: null }))[1].code,
    'usage',
  )
  const day = await json(await fetch(`${url}/api/time?date=${NEAR}`))
  assert.deepEqual((day.settings as Record<string, unknown>)['client-a'], {
    billable: true,
    nonBillable: [],
    systems: [
      { id: 'erp', title: 'erp' },
      { id: 'tracker', title: 'Tracker' },
    ],
    retired: [],
  })
})

test('post and unpost from the page: each entry with the revision read, a line at once, all or none', async () => {
  const { url, post } = await writableBoard()
  const one = (await post(add))[1].entry as Made
  const two = (await post({ ...add, start: `${NEAR}T15:00:00Z`, stop: `${NEAR}T15:30:00Z` }))[1].entry as Made
  const line = [
    { id: one.id, rev: one.rev },
    { id: two.id, rev: two.rev },
  ]
  // every entry says its revision; one stale refuses the whole line
  assert.equal((await post({ op: 'post', system: 'erp', entries: [{ id: one.id }] }))[1].code, 'rev')
  const [stale, why] = await post({ op: 'post', system: 'erp', entries: [line[0], { id: two.id, rev: 9 }] })
  assert.deepEqual([stale, why.code], [409, 'changedSince'])
  assert.equal((await post({ op: 'post', system: 'nope', entries: line }))[1].code, 'system')
  assert.equal((await post({ op: 'post', entries: line }))[1].code, 'noSystem')
  const day = async () => (await json(await fetch(`${url}/api/time?date=${NEAR}`))).entries as Made[]
  assert.deepEqual(
    (await day()).map(e => e.posts),
    [[], []],
    'nothing marked',
  )
  const [status, marked] = await post({ op: 'post', system: 'erp', entries: line })
  assert.equal(status, 200)
  assert.deepEqual(
    (marked.entries as Made[]).map(e => [e.id, e.rev, e.posts.map(p => [p.system, p.rev, p.changedAfter])]),
    [
      [one.id, 1, [['erp', 1, false]]],
      [two.id, 1, [['erp', 1, false]]],
    ],
  )
  // changed after: the day shows it on the entry
  await post({ op: 'edit', id: one.id, rev: 1, description: 'Case 10001 X: more' })
  assert.deepEqual(
    (await day()).map(e => e.posts[0]?.changedAfter),
    [true, false],
  )
  // an Undo putting the marks back as they were: the record and the revision they recorded
  const undone = await post({ op: 'unpost', system: 'erp', entries: [{ id: one.id, rev: 2 }] })
  assert.deepEqual((undone[1].entries as Made[])[0]?.posts, [])
  const [, back] = await post({
    op: 'post',
    system: 'erp',
    entries: [{ id: one.id, rev: 2, record: 'TR-1', asOf: 1 }],
  })
  assert.deepEqual(
    (back.entries as Made[])[0]?.posts.map(p => [p.record, p.rev, p.changedAfter]),
    [['TR-1', 1, true]],
  )
})

test('Raise and Trim say the figure the page showed: a line that bills otherwise now is refused, nothing changed', async () => {
  const { url, post } = await writableBoard()
  const at = (hm: string) => `${NEAR}T${hm}:00Z`
  // 30 + 14 to the nearest 30: 30 billed; another hand lengthens the first to 55: 69 worked, 60 billed
  const first = (await post({ ...add, client: 'client-n', start: at('13:00'), stop: at('13:30') }))[1].entry as Made
  const last = (await post({ ...add, client: 'client-n', start: at('14:00'), stop: at('14:14') }))[1].entry as Made
  await post({ op: 'edit', id: first.id, rev: first.rev, stop: at('13:55') })
  const [status, why] = await post({ op: 'trim', id: last.id, rev: last.rev, billed: 1800 })
  assert.deepEqual([status, why.code], [409, 'changedSince'])
  const day = await json(await fetch(`${url}/api/time?date=${NEAR}`))
  assert.deepEqual(
    (day.entries as Made[]).map(e => e.stop),
    [at('13:55'), at('14:14')],
  )
  // the figure as it is now: trimmed to it
  assert.equal((await post({ op: 'trim', id: last.id, rev: last.rev, billed: 3600 }))[0], 200)
  // Raise the same way
  const up = (await post({ ...add, stop: at('13:40') }))[1].entry as Made
  assert.equal((await post({ op: 'raise', id: up.id, rev: up.rev, billed: 5400 }))[1].code, 'changedSince')
  assert.equal((await post({ op: 'raise', id: up.id, rev: up.rev, billed: 'x' }))[1].code, 'billed')
  assert.equal(((await post({ op: 'raise', id: up.id, rev: up.rev, billed: 3600 }))[1].entry as Made).stop, at('14:00'))
})

/**
 * A board as writableBoard's, reading config.json as it changes (TEST_LIVE_CONFIG), as the real
 * one does: Settings → Time and a new project write the file, and the board follows it.
 */
async function liveBoard() {
  const box = await sandbox()
  const folder = join(box.dir, 'Sync')
  mkdirSync(folder)
  const state = join(box.dir, 'state', 'herdr', 'plugins', 'agent-board')
  mkdirSync(join(state, 'backup'), { recursive: true })
  writeFileSync(
    join(state, 'backup', 'backup-key.json'),
    JSON.stringify(makeKey('correct horse battery', 1, { logN: 10, r: 8, p: 1 })),
  )
  writeFileSync(
    join(state, 'backup', 'status.json'),
    JSON.stringify({ targets: { folder: { ...freshTarget(), tested: Date.now(), where: folder } } }),
  )
  const cfg = {
    language: 'en',
    categories: [
      { id: 'client-a', title: 'Client A', color: 'blue' },
      { id: 'other', title: 'Other', color: 'gray' },
    ],
    wakeUrl: null,
    refreshSec: 3600,
    time: TIME,
    backup: { folder },
  }
  const file = join(box.dir, 'config', 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(cfg, null, 2))
  const { url, proc } = await serveBoard(box, cfg, { TEST_LIVE_CONFIG: '1' })
  /** Resolves once the board has read config.json again after `fn` changed it. */
  const reloaded = async (fn: () => Promise<unknown>) => {
    const count = () => proc.messages.filter(m => (m as { reloaded?: boolean }).reloaded).length
    const was = count()
    const out = await fn()
    await until(() => count() > was)
    return out
  }
  const send = (path: string) => async (body: Record<string, unknown>) => {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
    return [res.status, await json(res)] as const
  }
  const config = () =>
    (JSON.parse(readFileSync(file, 'utf8')) as { time: { clients: Record<string, Record<string, unknown>> } }).time
  return { url, post: send('/api/time'), settings: send('/api/time-settings'), config, file, reloaded }
}

test('a new project from the editor: the entry and the client’s list in one request, a near name taking the one it has', async () => {
  const { post, config } = await liveBoard()
  const [, same] = await post({ ...add, project: ' support', newProject: true })
  assert.equal((same.entry as Made & { project: string }).project, 'Support')
  assert.deepEqual(config().clients['client-a']?.projects, ['Support'], 'no near duplicate')
  const [status, made] = await post({
    ...add,
    start: `${NEAR}T15:00:00Z`,
    stop: `${NEAR}T15:30:00Z`,
    project: 'Audit',
    newProject: true,
  })
  assert.equal(status, 200)
  const e = made.entry as Made & { project: string }
  assert.equal(e.project, 'Audit')
  assert.deepEqual(config().clients['client-a']?.projects, ['Support', 'Audit'])
  // an edit to another new one, too
  const [, edited] = await post({ op: 'edit', id: e.id, rev: e.rev, project: 'Calls', newProject: true })
  assert.equal((edited.entry as { project: string }).project, 'Calls')
  assert.deepEqual(config().clients['client-a']?.projects, ['Support', 'Audit', 'Calls'])
  // refused (no description): the list stays as it was
  assert.equal((await post({ ...add, description: '', project: 'Never', newProject: true }))[0], 400)
  assert.deepEqual(config().clients['client-a']?.projects, ['Support', 'Audit', 'Calls'])
  // without newProject a name not listed is refused, as before
  assert.equal((await post({ ...add, project: 'Elsewhere' }))[1].code, 'project')
})

test('Settings → Time: the view, a client off (refused new entries), a lane made with time, a refused edit leaving the file', async () => {
  const { url, post, settings, config, reloaded } = await liveBoard()
  const view = (await json(await fetch(`${url}/api/time-settings`))) as {
    on: boolean
    zone: string
    every: boolean
    clients: Record<string, { on: boolean; projects: string[]; systems: { id: string }[]; rules: number }>
  }
  assert.deepEqual([view.on, view.zone, view.every], [true, 'America/New_York', false])
  assert.deepEqual(
    [
      view.clients['client-a']?.projects,
      view.clients['client-a']?.systems.map(s => s.id),
      view.clients['client-a']?.rules,
    ],
    [['Support'], ['erp', 'tracker'], 1],
  )
  const [off, offView] = (await reloaded(() => settings({ op: 'client', client: 'client-n', on: false }))) as Awaited<
    ReturnType<typeof settings>
  >
  assert.equal(off, 200)
  assert.equal((offView.view as typeof view).clients['client-n']?.on, false)
  assert.equal(config().clients['client-n']?.on, false)
  // the board follows the file: a new entry for it is refused
  assert.equal((await post({ ...add, client: 'client-n' }))[1].code, 'clientOff')
  const [made, lane] = await settings({ op: 'newLane', id: 'client-z', title: 'Client Z', color: 'teal' })
  assert.equal(made, 200)
  assert.deepEqual((lane.view as typeof view).clients['client-z']?.projects, [])
  // what the edit would bring is refused, config.json left as it was
  const before = JSON.stringify(config())
  const [bad, why] = await settings({ op: 'systems', client: 'client-a', systems: [{ id: 'Bad Id', title: 'X' }] })
  assert.deepEqual([bad, why.code], [400, 'system'])
  assert.equal((await settings({ op: 'nope' }))[1].code, 'usage')
  assert.equal(JSON.stringify(config()), before)
})

test('Settings → Time renames a project: the client’s entries move with it, a mark entered stays entered', async () => {
  const { url, post, settings, config } = await liveBoard()
  const one = (await post(add))[1].entry as Made
  await post({ op: 'post', system: 'erp', entries: [{ id: one.id, rev: one.rev }] })
  const [status, done] = await settings({ op: 'rename', client: 'client-a', from: 'Support', to: 'Support desk' })
  assert.deepEqual([status, done.moved], [200, 1])
  assert.deepEqual(config().clients['client-a']?.projects, ['Support desk'])
  const day = await json(await fetch(`${url}/api/time?date=${NEAR}`))
  const e = (day.entries as (Made & { project: string })[]).find(x => x.id === one.id)
  assert.deepEqual([e?.project, e?.rev, e?.posts[0]?.changedAfter], ['Support desk', 2, false])
  // retired: offered no more, its entry keeps it
  await settings({ op: 'retire', client: 'client-a', project: 'Support desk' })
  assert.deepEqual(
    [config().clients['client-a']?.projects, config().clients['client-a']?.retired],
    [[], ['Support desk']],
  )
})
