// `board thread watch --owner` (#434, services/owner-watch.ts): what the web board tells a session
// that watches everything waiting on the owner, after a refresh. The database and the schedule in a
// temp state folder; the board's items and cards given as a refresh collected them.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { openDb } from '../../src/adapters/db.ts'
import { addEntry, listEntries, removeEntry, updateEntry } from '../../src/adapters/schedule-store.ts'
import { promptOf } from '../../src/core/schedule-rules.ts'
import type { Card, Item } from '../../src/core/types.ts'
import type { Party } from '../../src/core/work-threads.ts'
import { type ThreadCmdContext, threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { forgetOwnerWatch, ownerWatchFile, tellOwnerWatchers } from '../../src/services/owner-watch.ts'
import type { EventSchedule } from '../../src/services/work-threads.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-18T10:00:00Z')
const day: Party = { kind: 'session', key: 'dddddddd-0000-4000-8000-00000000000d', name: 'day' }
const anna: Party = { kind: 'session', key: 'aaaaaaaa-0000-4000-8000-00000000000a', name: 'anna' }
const ben: Party = { kind: 'session', key: 'pane-wP:p2', name: 'ben' }

const item = (p: Party, over: Partial<Item> = {}): Item =>
  ({
    key: p.kind === 'session' ? p.key : '',
    session: p.kind === 'session' ? p.key : null,
    name: p.kind === 'session' ? p.name : '',
    attention: '',
    ...over,
  }) as Item

function setUp() {
  isolatedHome()
  const cards = new Map<string, Card>()
  let items: Item[] = [item(day, { day: true }), item(anna), item(ben)]
  const run = async (actor: Party, args: string[], over: Partial<ThreadCmdContext> = {}) => {
    const out: string[] = []
    const code = await threadCmd(args, {
      cfg: { threads: true, port: 12422 },
      actor,
      lane: 'atlas',
      findSession: async () => null,
      setAsk: () => {},
      out: l => out.push(l),
      err: l => out.push(l),
      now: NOW,
      ...over,
    })
    return { code, out: out.join('\n') }
  }
  const tick = (
    now = NOW,
    over: { stale?: boolean; schedule?: EventSchedule; resolveKey?: (k: string) => string } = {},
  ) => {
    const db = openDb({ create: true })
    assert.ok(db)
    try {
      return tellOwnerWatchers({
        db,
        cfg: { gapSec: 60 },
        items: over.stale ? null : items,
        cards: () => cards,
        now,
        ...(over.schedule && { schedule: over.schedule }),
        ...(over.resolveKey && { resolveKey: over.resolveKey }),
      })
    } finally {
      db.close()
    }
  }
  const ask = (p: Party, q: string) => {
    const key = p.kind === 'session' ? p.key : ''
    if (q) cards.set(key, { key, ask: q } as Card)
    else cards.delete(key)
    items = items.map(i => (i.key === key ? { ...i, attention: q ? 'ask' : '', ...(q ? { question: q } : {}) } : i))
  }
  return { run, tick, ask, setItems: (f: (i: Item[]) => Item[]) => (items = f(items)) }
}

const lines = (key: string) => listEntries().filter(e => e.key === key && e.by === 'asks')
const deliver = (key: string): void => {
  for (const e of lines(key)) removeEntry(e.id)
}

test('no owner watch: an ask by any session schedules nothing and writes no file', async () => {
  const { run, tick, ask } = setUp()
  await run(day, ['watch', '--mine'])
  ask(anna, 'Ship the import to prod?')
  assert.deepEqual(tick(), [])
  assert.deepEqual(lines(day.kind === 'session' ? day.key : ''), [])
  assert.equal(existsSync(ownerWatchFile()), false)
})

test("a card's ask by another session: one line; the same ask again nothing; cleared, it is settled", async () => {
  const { run, tick, ask } = setUp()
  const dayKey = (day as { key: string }).key
  assert.equal((await run(day, ['watch', '--owner'])).out, 'ok · what waits on the owner · watched')
  ask(ben, 'Old question from before the watch')
  // The first look starts from what waits now: no line for what was there before.
  assert.deepEqual(tick(), [])
  ask(anna, 'Ship the import to prod?')
  assert.deepEqual(tick(NOW + 1000), [dayKey])
  const [first] = lines(dayKey)
  assert.ok(first)
  assert.equal(first.text, 'anna asks the owner: Ship the import to prod?')
  assert.equal(first.noWake, true)
  assert.equal(promptOf(first, NOW + 1000), '[board reminder from asks] anna asks the owner: Ship the import to prod?')
  deliver(dayKey)
  // The same ask set again, and refreshes with nothing new: nothing.
  ask(anna, 'Ship the import to prod?')
  assert.deepEqual(tick(NOW + 2000), [])
  assert.deepEqual(tick(NOW + 3000), [])
  assert.deepEqual(lines(dayKey), [])
  // The owner answered: the ask cleared. Told once more, no sooner than the gap after the last line.
  ask(anna, '')
  assert.deepEqual(tick(NOW + 4000), [dayKey])
  const [settled] = lines(dayKey)
  assert.equal(settled?.text, 'anna: settled')
  assert.equal(settled?.next, NOW + 1000 + 60_000)
})

test('a burst before the line goes out is one line; asked and settled meanwhile is none', async () => {
  const { run, tick, ask } = setUp()
  const dayKey = (day as { key: string }).key
  await run(day, ['watch', '--owner'])
  tick()
  ask(anna, 'Which mapping?')
  tick(NOW + 1000)
  ask(ben, 'Restart the worker?')
  tick(NOW + 2000)
  ask(anna, 'Which mapping, v2 or v3?')
  tick(NOW + 3000)
  const pending = lines(dayKey)
  assert.equal(pending.length, 1)
  assert.equal(
    pending[0]?.text,
    'anna asks the owner: Which mapping, v2 or v3? · ben asks the owner: Restart the worker?',
  )
  // Both settled before it went out: nothing is left to say.
  ask(anna, '')
  ask(ben, '')
  tick(NOW + 4000)
  assert.deepEqual(lines(dayKey), [])
})

test("its own card is never told; a thread set to the owner by a session it does not watch is, its lane's is not", async () => {
  const { run, tick, ask } = setUp()
  const dayKey = (day as { key: string }).key
  await run(day, ['watch', '--owner'])
  await run(day, ['watch', '--lane', 'beta'])
  tick()
  ask(day, 'Should I end the day?')
  assert.deepEqual(tick(NOW + 1000), [])
  assert.equal((await run(anna, ['new', '--lane', 'atlas', 'Import mapping'])).code, 0)
  assert.equal((await run(anna, ['ask', 'atlas-1', '--', 'Which mapping, v2 or v3?'])).code, 0)
  assert.equal((await run(ben, ['new', '--lane', 'beta', 'Worker restart'])).code, 0)
  assert.equal((await run(ben, ['ask', 'beta-1', '--', 'Restart it now?'])).code, 0)
  assert.deepEqual(tick(NOW + 2000), [dayKey])
  expect(lines(dayKey).map(e => e.text)).toEqual(['atlas-1 asks the owner: Which mapping, v2 or v3?'])
})

test('unwatch --owner: nothing more is told, and what it was told goes with the file', async () => {
  const { run, tick, ask } = setUp()
  const dayKey = (day as { key: string }).key
  await run(day, ['watch', '--owner'])
  tick()
  assert.equal(existsSync(ownerWatchFile()), true)
  assert.equal((await run(day, ['unwatch', '--owner'])).out, 'ok · what waits on the owner · not watched')
  ask(anna, 'Ship it?')
  assert.deepEqual(tick(NOW + 1000), [])
  assert.deepEqual(lines(dayKey), [])
  assert.equal(existsSync(ownerWatchFile()), false)
})

test('a refresh that failed compares nothing: no "settled" for every ask, nothing written', async () => {
  const { run, tick, ask } = setUp()
  const dayKey = (day as { key: string }).key
  await run(day, ['watch', '--owner'])
  tick()
  ask(anna, 'Ship it?')
  tick(NOW + 1000)
  deliver(dayKey)
  assert.deepEqual(tick(NOW + 2000, { stale: true }), [])
  assert.deepEqual(lines(dayKey), [])
  // Fresh again with the same ask: nothing new either.
  assert.deepEqual(tick(NOW + 3000), [])
})

test('a line the scheduler claimed goes as it is; the next one follows it after the gap', async () => {
  const { run, tick, ask } = setUp()
  const dayKey = (day as { key: string }).key
  await run(day, ['watch', '--owner'])
  tick()
  ask(anna, 'Ship it?')
  tick(NOW + 1000)
  const [first] = lines(dayKey)
  assert.ok(first)
  updateEntry(first.id, e => ({ ...e, claim: { by: 'test', at: NOW + 1500 } }))
  ask(ben, 'Restart the worker?')
  assert.deepEqual(tick(NOW + 2000), [dayKey])
  const all = lines(dayKey)
  assert.equal(all.length, 2)
  const second = all.find(e => e.id !== first.id)
  assert.equal(second?.text, 'ben asks the owner: Restart the worker?')
  assert.equal(second?.next, NOW + 1000 + 60_000)
})

test('after a restart of the web board a pending line is replaced from what the session heard before it', async () => {
  const { run, tick, ask } = setUp()
  const dayKey = (day as { key: string }).key
  await run(day, ['watch', '--owner'])
  tick()
  ask(anna, 'Ship it?')
  tick(NOW + 1000)
  forgetOwnerWatch()
  ask(anna, '')
  ask(ben, 'Restart the worker?')
  tick(NOW + 2000)
  expect(lines(dayKey).map(e => e.text)).toEqual(['ben asks the owner: Restart the worker?'])
})

test("one session's full schedule never keeps another from its line", async () => {
  const { run, tick, ask } = setUp()
  const dayKey = (day as { key: string }).key
  const benKey = (ben as { key: string }).key
  await run(ben, ['watch', '--owner'])
  await run(day, ['watch', '--owner'])
  tick()
  const schedule: EventSchedule = {
    list: () => listEntries(),
    takeBack: id => {
      removeEntry(id)
      return true
    },
    add: fields => {
      if (fields.key === benKey) throw new Error('this session has 30 entries already')
      return addEntry(fields)
    },
  }
  ask(anna, 'Ship it?')
  assert.deepEqual(tick(NOW + 1000, { schedule }), [dayKey])
  assert.equal(lines(dayKey).length, 1)
  // ben is told on a later refresh, once its schedule takes the line.
  assert.deepEqual(tick(NOW + 2000), [benKey])
  expect(lines(benKey).map(e => e.text)).toEqual(['anna asks the owner: Ship it?'])
})

test('--idle and --wake reach the line; unwatch takes back a line that has not gone out', async () => {
  const { run, tick, ask } = setUp()
  const dayKey = (day as { key: string }).key
  assert.equal(
    (await run(day, ['watch', '--owner', '--idle', '--wake'])).out,
    'ok · what waits on the owner · watched · when free · wakes you',
  )
  tick()
  ask(anna, 'Ship it?')
  tick(NOW + 1000)
  const [line] = lines(dayKey)
  assert.equal(line?.idle, true)
  assert.equal(line?.noWake, undefined)
  await run(day, ['unwatch', '--owner'])
  tick(NOW + 2000)
  assert.deepEqual(lines(dayKey), [])
})

test('asked and settled before the line went out does not hold back the next one by a gap', async () => {
  const { run, tick, ask } = setUp()
  const dayKey = (day as { key: string }).key
  await run(day, ['watch', '--owner'])
  tick()
  ask(anna, 'Ship it?')
  tick(NOW + 1000)
  ask(anna, '')
  tick(NOW + 2000)
  assert.deepEqual(lines(dayKey), [])
  ask(ben, 'Restart the worker?')
  tick(NOW + 3000)
  assert.equal(lines(dayKey)[0]?.next, NOW + 3000)
})

test('a card that asked and works on still waits: no settled line while it works', async () => {
  const { run, tick, ask, setItems } = setUp()
  const dayKey = (day as { key: string }).key
  const annaKey = (anna as { key: string }).key
  await run(day, ['watch', '--owner'])
  tick()
  ask(anna, 'Ship it?')
  tick(NOW + 1000)
  deliver(dayKey)
  // The board's column hides the ask while the session works (attention ''), the card still has it.
  setItems(items => items.map(i => (i.key === annaKey ? { ...i, attention: '', question: '' } : i)))
  assert.deepEqual(tick(NOW + 2000), [])
})

test('watch --owner takes no thread, lane, --mine or --what beside it', async () => {
  const { run } = setUp()
  for (const extra of [['--mine'], ['--lane', 'atlas'], ['atlas-1'], ['--what', 'all']]) {
    const r = await run(day, ['watch', '--owner', ...extra])
    assert.notEqual(r.code, 0, extra.join(' '))
    assert.match(r.out, /usage: board thread watch --owner/)
  }
})

test('resolveKey schedules owner-watch asks under @<node>:<key> and takes them back on unwatch (#869)', async () => {
  const { run, tick, ask } = setUp()
  const dayKey = (day as { key: string }).key
  const nodeDayKey = `@laptop:${dayKey}`
  const resolveKey = (k: string) => (k === dayKey ? nodeDayKey : k)
  await run(day, ['watch', '--owner'])
  tick(NOW, { resolveKey })
  ask(anna, 'Ship node fix?')
  assert.deepEqual(tick(NOW + 1000, { resolveKey }), [dayKey])
  expect(lines(dayKey)).toEqual([])
  const pending = lines(nodeDayKey)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.text, 'anna asks the owner: Ship node fix?')

  // Unwatch takes back the entry scheduled under the prefixed key.
  await run(day, ['unwatch', '--owner'])
  tick(NOW + 2000, { resolveKey })
  assert.deepEqual(lines(nodeDayKey), [])
})
