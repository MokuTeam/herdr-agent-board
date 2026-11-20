// A MokuPilot day's watches follow it to its next conversation (#403, services/day-watches.ts,
// services/work-threads.ts carryWatches): the web board's tick after a refresh, against the
// database and the schedule in a temp state folder, the board's items as a refresh collected them.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/adapters/db.ts'
import { listEntries, removeEntry } from '../../src/adapters/schedule-store.ts'
import { watchesOf } from '../../src/adapters/work-thread-store.ts'
import type { Item } from '../../src/core/types.ts'
import type { Party } from '../../src/core/work-threads.ts'
import { type ThreadCmdContext, threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { dayWatchTick, TRIES } from '../../src/services/day-watches.ts'
import { type EventSchedule, fileSchedule } from '../../src/services/work-threads.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-20T10:00:00Z')
type S = Extract<Party, { kind: 'session' }>
const before: S = { kind: 'session', key: 'dddddddd-0000-4000-8000-00000000000d', name: 'day' }
const after: S = { kind: 'session', key: 'eeeeeeee-0000-4000-8000-00000000000e', name: 'day' }
const anna: S = { kind: 'session', key: 'aaaaaaaa-0000-4000-8000-00000000000a', name: 'anna' }
const ben: S = { kind: 'session', key: 'pane-wP:p2', name: 'ben' }
const cleo: S = { kind: 'session', key: 'cccccccc-0000-4000-8000-00000000000c', name: 'cleo 100% Клео' }

const item = (p: S, over: Partial<Item> = {}): Item =>
  ({ key: p.key, session: p.key.startsWith('pane-') ? null : p.key, name: p.name, attention: '', ...over }) as Item

async function run(actor: Party, args: string[], over: Partial<ThreadCmdContext> = {}) {
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

function setUp() {
  isolatedHome()
  const tick = dayWatchTick()
  const asked: string[] = []
  const go = (
    items: Item[] | null,
    chain: Record<string, string[] | null>,
    now = NOW,
    over: { schedule?: EventSchedule; log?: (l: string) => void } = {},
  ) => {
    const db = openDb({ create: true })
    assert.ok(db)
    try {
      return tick({
        db,
        cfg: { gapSec: 60, agents: true, share: true } as never,
        items,
        now,
        predecessors: s => {
          asked.push(s)
          return chain[s] === undefined ? [] : chain[s]
        },
        ...over,
      })
    } finally {
      db.close()
    }
  }
  const watches = (p: S) => {
    const db = openDb({ create: true })
    assert.ok(db)
    try {
      return watchesOf(db, p.key).map(
        w =>
          `${w.target.startsWith('lane:') || w.target === 'mine' || w.target === 'owner' ? w.target : 'thread'}:${w.what}`,
      )
    } finally {
      db.close()
    }
  }
  return { go, asked, watches }
}

const lines = (p: S) => listEntries().filter(e => e.key === p.key && (e.by === 'threads' || e.by === 'threads-carried'))
const deliver = (p: S): void => {
  for (const e of lines(p)) removeEntry(e.id)
}

test('a rotated day hears of a thread its previous conversation watched, with no watch of its own', async () => {
  const { go, watches } = setUp()
  assert.equal((await run(anna, ['new', '--lane', 'atlas', 'Import mapping'])).code, 0)
  assert.equal((await run(before, ['watch', 'atlas-1', '--what', 'all'])).code, 0)
  // The old conversation is told while it runs.
  await run(anna, ['post', 'atlas-1', 'first note'])
  expect(lines(before).length).toBe(1)
  deliver(before)

  // MokuPilot rotates the day: the card is the new conversation's, rotated_from names the old one.
  expect(go([item(after, { day: true }), item(anna)], { [after.key]: [before.key] })).toBe(1)
  expect(watches(before)).toEqual([])
  expect(watches(after)).toEqual(['thread:all'])

  await run(anna, ['post', 'atlas-1', 'second note'])
  expect(lines(before)).toEqual([])
  const [line] = lines(after)
  assert.ok(line)
  expect(line.text).toContain('atlas-1')
  expect(line.noWake).toBe(true)
  // Once per conversation: the next refresh reads nothing.
  expect(go([item(after, { day: true }), item(anna)], { [after.key]: [before.key] })).toBe(0)
})

test('a line pending for the old conversation goes to the new one, once; its own changes are still not told', async () => {
  const { go } = setUp()
  await run(anna, ['new', '--lane', 'atlas', 'Import mapping'])
  await run(before, ['watch', 'atlas-1', '--what', 'all'])
  await run(anna, ['post', 'atlas-1', 'written before the rotation'])
  expect(lines(before).length).toBe(1)

  go([item(after, { day: true }), item(anna)], { [after.key]: [before.key] })
  expect(lines(before)).toEqual([])
  const moved = lines(after)
  expect(moved.length).toBe(1)
  expect(moved[0]?.text).toContain('atlas-1')
  deliver(after)

  // The new conversation's own post tells it nothing; anna's does.
  await run(after, ['post', 'atlas-1', 'my note'])
  expect(lines(after)).toEqual([])
  await run(anna, ['post', 'atlas-1', 'reply'])
  expect(lines(after).length).toBe(1)
})

test('lane and mine watches move; mine covers the threads the old conversation created; the owner watch stays', async () => {
  const { go, watches } = setUp()
  await run(before, ['new', '--lane', 'atlas', 'Its own thread'])
  await run(before, ['watch', '--lane', 'beta'])
  await run(before, ['watch', '--mine'])
  await run(before, ['watch', '--owner'])
  go([item(after, { day: true })], { [after.key]: [before.key] })
  expect(watches(before)).toEqual(['owner:status'])
  expect(watches(after).sort()).toEqual(['lane:beta:status', 'mine:status', 'thread:status'])

  await run(anna, ['post', 'atlas-1', '--status', 'waiting', '--waiting', 'ben'])
  expect(lines(after).length).toBe(1)
  deliver(after)
  await run(anna, ['new', '--lane', 'beta', 'Worker restart'])
  expect(lines(after).length).toBe(1)
})

test('a new day follows on from the day before; an unrelated session inherits nothing', async () => {
  const { go, watches } = setUp()
  await run(anna, ['new', '--lane', 'atlas', 'Import mapping'])
  await run(before, ['watch', 'atlas-1'])
  await run(ben, ['watch', 'atlas-1', '--what', 'all'])
  await run(cleo, ['watch', '--lane', 'atlas'])

  go([item(after, { day: true }), item(anna), item(ben), item(cleo)], { [after.key]: [before.key] })
  expect(watches(after)).toEqual(['thread:status'])
  expect(watches(ben)).toEqual(['thread:all'])
  expect(watches(cleo)).toEqual(['lane:atlas:status'])

  await run(anna, ['post', 'atlas-1', '--status', 'done', '--summary', 'shipped'])
  expect(lines(after).length).toBe(1)
  expect(lines(ben).length).toBe(1)
  expect(lines(cleo).length).toBe(1)
})

test('a predecessor that is still a card of its own keeps its watches (a terminal day)', async () => {
  const { go, watches } = setUp()
  await run(anna, ['new', '--lane', 'atlas', 'Import mapping'])
  await run(before, ['watch', 'atlas-1'])
  expect(go([item(after, { day: true }), item(before)], { [after.key]: [before.key] })).toBe(0)
  expect(watches(before)).toEqual(['thread:status'])
  expect(watches(after)).toEqual([])
})

test('no day card, or a refresh that failed: the day folder is not read and nothing moves', async () => {
  const { go, asked, watches } = setUp()
  await run(anna, ['new', '--lane', 'atlas', 'Import mapping'])
  await run(before, ['watch', 'atlas-1'])
  // ben by pane key, cleo with a name in other alphabets and %: ordinary cards.
  expect(go([item(anna), item(ben), item(cleo), item(before)], { [after.key]: [before.key] })).toBe(0)
  expect(go(null, { [after.key]: [before.key] })).toBe(0)
  expect(asked).toEqual([])
  expect(watches(before)).toEqual(['thread:status'])
  // The day's card appears: read once.
  go([item(after, { day: true })], { [after.key]: [before.key] })
  go([item(after, { day: true })], { [after.key]: [before.key] })
  expect(asked).toEqual([after.key])
})

test("the old conversation's own entries are never told to the new one", async () => {
  const { go } = setUp()
  await run(anna, ['new', '--lane', 'atlas', 'Import mapping'])
  await run(before, ['watch', 'atlas-1', '--what', 'all'])
  await run(before, ['post', 'atlas-1', 'my first note'])
  await run(before, ['post', 'atlas-1', '--status', 'waiting', '--waiting', 'anna'])
  go([item(after, { day: true })], { [after.key]: [before.key] })
  expect(lines(after)).toEqual([])
  await run(anna, ['post', 'atlas-1', 'reply'])
  const [line] = lines(after)
  expect(line?.text).toBe('atlas-1 +1. More: board thread changes')
})

test('the line pending for the old conversation keeps its words; a later change is a line of its own', async () => {
  const { go } = setUp()
  await run(anna, ['new', '--lane', 'atlas', 'Import mapping'])
  await run(before, ['watch', 'atlas-1', '--what', 'all'])
  await run(anna, ['post', 'atlas-1', '--status', 'waiting', '--waiting', 'ben'])
  const [was] = lines(before)
  go([item(after, { day: true })], { [after.key]: [before.key] }, NOW + 1000)
  const [carried] = lines(after)
  expect(carried?.text).toBe(was?.text)
  expect(carried?.next).toBe(was?.next)
  await run(anna, ['post', 'atlas-1', 'later'], { now: NOW + 2000 })
  const now = lines(after)
  expect(now.length).toBe(2)
  expect(now.find(e => e.id === carried?.id)?.text).toBe(was?.text)
  // The next line waits out the gap after the carried one.
  expect(now.find(e => e.id !== carried?.id)?.next).toBe((was?.next ?? 0) + 60_000)
})

test('a carry the schedule refuses loses nothing and is tried again on the next refresh', async () => {
  const { go, watches } = setUp()
  const logged: string[] = []
  await run(anna, ['new', '--lane', 'atlas', 'Import mapping'])
  await run(before, ['watch', 'atlas-1', '--what', 'all'])
  await run(anna, ['post', 'atlas-1', 'written before the rotation'])
  const refusing: EventSchedule = {
    ...fileSchedule,
    add: () => {
      throw new Error('this session has 50 entries already')
    },
  }
  const items = [item(after, { day: true })]
  expect(go(items, { [after.key]: [before.key] }, NOW, { schedule: refusing, log: l => logged.push(l) })).toBe(0)
  expect(logged).toEqual(['day watches: this session has 50 entries already'])
  expect(watches(before)).toEqual(['thread:all'])
  expect(lines(before).length).toBe(1)
  expect(go(items, { [after.key]: [before.key] })).toBe(1)
  expect(lines(before)).toEqual([])
  expect(lines(after).length).toBe(1)
})

test('a day folder that does not name the new conversation yet is read again, a bounded number of times', async () => {
  const { go, asked } = setUp()
  await run(anna, ['new', '--lane', 'atlas', 'Import mapping'])
  await run(before, ['watch', 'atlas-1'])
  const items = [item(after, { day: true })]
  go(items, { [after.key]: null })
  go(items, { [after.key]: null })
  expect(go(items, { [after.key]: [before.key] })).toBe(1)
  expect(asked.length).toBe(3)
  // Never named: given up after TRIES refreshes.
  const other: S = { kind: 'session', key: 'ffffffff-0000-4000-8000-00000000000f', name: 'day' }
  for (let i = 0; i < TRIES + 5; i++) go([item(other, { day: true })], { [other.key]: null })
  expect(asked.length).toBe(3 + TRIES)
})

test('a new conversation that already watches and was told is not told it again; the newest earlier watch wins', async () => {
  const { go, watches } = setUp()
  const older: S = { kind: 'session', key: 'bbbbbbbb-0000-4000-8000-00000000000b', name: 'day' }
  await run(anna, ['new', '--lane', 'atlas', 'Import mapping'])
  await run(anna, ['new', '--lane', 'atlas', 'Worker restart'])
  await run(older, ['watch', 'atlas-1', '--what', 'all'])
  await run(before, ['watch', 'atlas-1', '--what', 'asks', '--wake'])
  await run(after, ['watch', 'atlas-2', '--what', 'all'])
  await run(anna, ['post', 'atlas-2', 'told to the new one'])
  expect(lines(after).length).toBe(1)
  deliver(after)
  deliver(before)
  deliver(older)
  go([item(after, { day: true })], { [after.key]: [older.key, before.key] })
  expect(lines(after)).toEqual([])
  expect(watches(older)).toEqual([])
  expect(watches(after).sort()).toEqual(['thread:all', 'thread:asks'])
  // --wake came with the watch: the line may wake the day.
  await run(anna, ['ask', 'atlas-1', '--', 'Which mapping?'])
  const [line] = lines(after)
  expect(line?.noWake).toBeUndefined()
})

test('mine also covers the open threads the old conversation was given, not its closed ones', async () => {
  const { go, watches } = setUp()
  await run(anna, ['new', '--lane', 'atlas', '--to', before.key, 'Given to the day'], {
    findSession: async () => before,
  })
  await run(before, ['new', '--lane', 'atlas', 'Closed already'])
  await run(before, ['done', 'atlas-2', '--summary', 'done'])
  await run(before, ['unwatch', 'atlas-1'])
  await run(before, ['unwatch', 'atlas-2'])
  await run(before, ['watch', '--mine'])
  go([item(after, { day: true })], { [after.key]: [before.key] })
  expect(watches(after).sort()).toEqual(['mine:status', 'thread:status'])
  await run(anna, ['post', 'atlas-1', '--status', 'waiting', '--waiting', 'ben'])
  expect(lines(after)[0]?.text).toContain('atlas-1')
})
