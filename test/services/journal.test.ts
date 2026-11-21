import { Database } from 'bun:sqlite'
import { expect, onTestFinished, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { journalFile, journalStore, openJournalDb } from '../../src/adapters/journal-store.ts'
import { KEEP_MS } from '../../src/core/journal.ts'
import type { Presence } from '../../src/core/presence.ts'
import type { Item } from '../../src/core/types.ts'
import { createJournal } from '../../src/services/journal.ts'
import { isolatedHome } from '../support/env.ts'

const MIN = 60_000
// Open journals are closed before isolatedHome removes their folder (Windows keeps an open file).
const live: { stop(): void }[] = []
function fresh(): void {
  onTestFinished(() => {
    for (const j of live.splice(0)) j.stop()
  })
  isolatedHome()
}
const item = (key: string, o: Partial<Item> = {}): Item => ({
  key,
  session: key,
  pane: null,
  workspace: null,
  cwd: 'C:\\work\\project with spaces %',
  status: 'idle',
  name: key,
  autoName: '',
  category: 'personal',
  categorySet: true,
  column: 'idle',
  attention: '',
  ...o,
})

function journalOf(o: { cfg?: unknown; presence?: Presence | null; viewers?: number; at?: number } = {}) {
  const clock = { at: o.at ?? 1_800_000_000_000 }
  const env = { presence: o.presence ?? null, viewers: o.viewers ?? 1 }
  const logs: string[] = []
  let changes = 0
  const j = createJournal({
    cfg: { journal: 'cfg' in o ? o.cfg : true },
    log: line => logs.push(line),
    presence: () => env.presence,
    viewers: () => env.viewers,
    onChange: () => changes++,
    now: () => clock.at,
  })
  live.push(j)
  return { j, clock, env, logs, changes: () => changes }
}
const movesIn = (): { key: string; kind: string }[] => {
  const db = new Database(journalFile(), { readonly: true })
  try {
    return db.query('SELECT key, kind FROM moves ORDER BY id').all() as { key: string; kind: string }[]
  } finally {
    db.close()
  }
}

test('with the key absent nothing is opened, written or shown', () => {
  fresh()
  const { j } = journalOf({ cfg: undefined })
  for (let i = 0; i < 5; i++) j.observe([item('anna', { column: i % 2 ? 'work' : 'done' })])
  expect(existsSync(journalFile())).toBe(false)
  expect(j.view()).toBeNull()
  expect(j.list(0)).toBeNull()
  expect(j.awaySince()).toBeNull()
  expect(j.dismiss()).toBe(false)
  expect(existsSync(journalFile())).toBe(false)
})

test('each change of state is recorded once; a refresh where nothing moved writes nothing', () => {
  fresh()
  const { j, clock } = journalOf()
  j.observe([item('anna', { column: 'work' }), item('ben', { column: 'idle' })])
  expect(movesIn()).toEqual([])
  const seq = () => {
    const d = new Database(journalFile(), { readonly: true })
    try {
      return (d.query('SELECT COALESCE(MAX(id),0) AS n FROM moves').get() as { n: number }).n
    } finally {
      d.close()
    }
  }
  for (let i = 0; i < 3; i++) {
    clock.at += 2000
    j.observe([item('anna', { column: 'work' }), item('ben', { column: 'idle' })])
  }
  expect(seq()).toBe(0)
  clock.at += 2000
  j.observe([item('anna', { column: 'me', question: 'May I push?' }), item('ben', { column: 'idle' })])
  clock.at += 2000
  j.observe([item('anna', { column: 'me', question: 'May I push?' }), item('ben', { column: 'idle' })])
  clock.at += 2000
  j.observe([item('anna', { column: 'work' }), item('ben', { column: 'done', result: 'PR opened' })])
  expect(movesIn()).toEqual([
    { key: 'anna', kind: 'owner' },
    { key: 'anna', kind: 'work' },
    { key: 'ben', kind: 'done' },
  ])
})

test('a restart loses nothing and invents nothing', () => {
  fresh()
  const first = journalOf()
  first.j.observe([item('anna', { column: 'work' }), item('cleo', { column: 'ext', wait: 'CI' })])
  first.clock.at += 5000
  first.j.observe([item('anna', { column: 'done', result: 'shipped' }), item('cleo', { column: 'ext', wait: 'CI' })])
  first.j.stop()
  expect(movesIn()).toEqual([{ key: 'anna', kind: 'done' }])

  // the same board after the restart: nothing new; cleo missing for one refresh and back: nothing
  const second = journalOf({ at: first.clock.at + 60_000 })
  second.j.observe([item('anna', { column: 'done', result: 'shipped' })])
  second.clock.at += 2000
  second.j.observe([item('anna', { column: 'done', result: 'shipped' }), item('cleo', { column: 'ext', wait: 'CI' })])
  expect(movesIn()).toEqual([{ key: 'anna', kind: 'done' }])
  second.j.stop()

  // what changed while the board was down is recorded once, at the first refresh after it
  const third = journalOf({ at: second.clock.at + 60_000 })
  third.j.observe([item('anna', { column: 'me', question: 'next?' }), item('cleo', { column: 'ext', wait: 'CI' })])
  third.clock.at += 2000
  third.j.observe([item('anna', { column: 'me', question: 'next?' }), item('cleo', { column: 'ext', wait: 'CI' })])
  expect(movesIn()).toEqual([
    { key: 'anna', kind: 'done' },
    { key: 'anna', kind: 'owner' },
  ])
  const list = third.j.list(first.clock.at - 5000)
  expect(list?.rows.map(r => [r.key, r.kind, r.line])).toEqual([['anna', 'owner', 'next?']])
  // asked from before recording began: the list says when it did
  expect(third.j.list(first.clock.at - 3600_000)?.recordedFrom).toBe(first.clock.at - 5000)
  expect(list?.recordedFrom).toBeUndefined()
})

test('moves and the states of cards gone for 30 days are pruned', () => {
  fresh()
  const now = 1_800_000_000_000
  const db = openJournalDb(true)
  if (!db) throw new Error('no journal.db')
  const s = journalStore(db)
  const old = now - KEEP_MS - MIN
  s.record(
    [{ key: 'gone', kind: 'done', line: 'old', name: 'gone', lane: 'personal', at: old }],
    new Map([
      ['gone', { kind: 'done', line: 'old', name: 'gone', lane: 'personal', at: old, gone: old }],
      ['kept', { kind: 'owner', line: 'still waits', name: 'kept', lane: 'personal', at: old, gone: null }],
    ]),
  )
  db.close()
  const { j } = journalOf({ at: now })
  j.observe([item('kept', { column: 'me', question: 'still waits' })])
  expect(movesIn()).toEqual([])
  const again = openJournalDb(false)
  if (!again) throw new Error('no journal.db')
  const states = journalStore(again).states()
  again.close()
  expect([...states.keys()]).toEqual(['kept'])
})

test('presence: a return after 15 minutes away shows the strip once, until dismissed', () => {
  fresh()
  const t0 = 1_800_000_000_000
  const { j, clock, env, changes } = journalOf({
    at: t0,
    presence: { state: 'here', since: t0 - 3600_000, by: 'auto' },
  })
  j.observe([item('anna', { column: 'work' }), item('ben', { column: 'me', question: 'old ask' })])
  expect(j.view()).toEqual({ strip: null, last: null })

  env.presence = { state: 'away', since: t0 + MIN, by: 'auto' }
  clock.at = t0 + 2 * MIN
  j.observe([item('anna', { column: 'work' }), item('ben', { column: 'me', question: 'old ask' })])
  expect(j.awaySince()).toBe(t0 + MIN)
  clock.at = t0 + 30 * MIN
  j.observe([
    item('anna', { column: 'me', question: 'May I push?' }),
    item('ben', { column: 'me', question: 'old ask' }),
  ])
  expect(j.view()?.strip).toBeNull()

  env.presence = { state: 'here', since: t0 + 40 * MIN, by: 'auto' }
  clock.at = t0 + 40 * MIN + 1000
  j.observe([
    item('anna', { column: 'me', question: 'May I push?' }),
    item('ben', { column: 'me', question: 'old ask' }),
  ])
  const shown = j.view()
  expect(shown?.last).toEqual({ from: t0 + MIN, to: t0 + 40 * MIN })
  expect(shown?.strip?.rows.map(r => [r.key, r.kind, r.line])).toEqual([['anna', 'owner', 'May I push?']])
  expect(shown?.strip?.before).toBe(1)
  // after the absence anna works on: --away still lists since she left
  expect(j.awaySince()).toBe(t0 + MIN)

  expect(j.dismiss()).toBe(true)
  expect(changes()).toBe(1)
  expect(j.dismiss()).toBe(false)
  clock.at += 2000
  j.observe([item('anna', { column: 'work' }), item('ben', { column: 'me', question: 'old ask' })])
  expect(j.view()).toEqual({ strip: null, last: { from: t0 + MIN, to: t0 + 40 * MIN } })

  // dismissed stays dismissed across a restart
  j.stop()
  const after = journalOf({ at: clock.at + 1000, presence: env.presence })
  after.j.observe([item('anna', { column: 'work' }), item('ben', { column: 'me', question: 'old ask' })])
  expect(after.j.view()?.strip).toBeNull()
  expect(after.j.view()?.last).toEqual({ from: t0 + MIN, to: t0 + 40 * MIN })
})

test('presence: a short absence shows no strip; the page going off show means nothing then', () => {
  fresh()
  const t0 = 1_800_000_000_000
  const { j, clock, env } = journalOf({ at: t0, presence: { state: 'here', since: 1, by: 'auto' }, viewers: 0 })
  j.observe([item('anna')])
  env.presence = { state: 'away', since: t0 + MIN, by: 'user' }
  clock.at = t0 + 2 * MIN
  j.observe([item('anna')])
  env.presence = { state: 'here', since: t0 + 6 * MIN, by: 'user' }
  env.viewers = 1
  clock.at = t0 + 6 * MIN
  j.observe([item('anna', { column: 'done', result: 'ok' })])
  expect(j.view()).toEqual({ strip: null, last: null })
  // hidden page for an hour, presence here all along: no return
  env.viewers = 0
  clock.at = t0 + 60 * MIN
  j.observe([item('anna', { column: 'done', result: 'ok' })])
  env.viewers = 1
  clock.at = t0 + 120 * MIN
  j.observe([item('anna', { column: 'done', result: 'ok' })])
  expect(j.view()).toEqual({ strip: null, last: null })
})

test('without presence: the page shown again after 15 minutes off show is a return', () => {
  fresh()
  const t0 = 1_800_000_000_000
  const { j, clock, env } = journalOf({ at: t0, viewers: 1 })
  j.observe([item('anna', { column: 'work' })])
  env.viewers = 0
  clock.at = t0 + MIN
  j.observe([item('anna', { column: 'work' })])
  expect(j.awaySince()).toBe(t0 + MIN)
  clock.at = t0 + 10 * MIN
  j.observe([item('anna', { column: 'done', result: 'PR opened' })])
  clock.at = t0 + 20 * MIN
  j.observe([item('anna', { column: 'done', result: 'PR opened' })])
  expect(j.view()?.strip).toBeNull()
  env.viewers = 1
  clock.at = t0 + 25 * MIN
  j.observe([item('anna', { column: 'done', result: 'PR opened' })])
  expect(j.view()?.strip?.rows.map(r => [r.key, r.kind, r.line])).toEqual([['anna', 'done', 'PR opened']])
  // a second, short absence keeps the last strip as it was
  env.viewers = 0
  clock.at = t0 + 26 * MIN
  j.observe([item('anna', { column: 'done', result: 'PR opened' })])
  env.viewers = 1
  clock.at = t0 + 28 * MIN
  j.observe([item('anna', { column: 'done', result: 'PR opened' })])
  expect(j.view()?.last).toEqual({ from: t0 + MIN, to: t0 + 25 * MIN })
})

test('turned off at runtime: the file is closed, the strip leaves the payload', () => {
  fresh()
  const cfg: { journal?: unknown } = { journal: true }
  const j = createJournal({ cfg, log() {}, presence: () => null, viewers: () => 1 })
  live.push(j)
  j.observe([item('anna')])
  expect(j.view()).toEqual({ strip: null, last: null })
  delete cfg.journal
  j.observe([item('anna', { column: 'work' })])
  expect(j.view()).toBeNull()
  cfg.journal = true
  j.observe([item('anna', { column: 'work' })])
  // the change seen while off is no invented move: it is one real move, at the first refresh back
  expect(movesIn()).toEqual([{ key: 'anna', kind: 'work' }])
})

test('presence: a call while away is still away; the absence ends at the switch to here', () => {
  fresh()
  const t0 = 1_800_000_000_000
  const { j, clock, env } = journalOf({ at: t0, presence: { state: 'here', since: 1, by: 'auto' } })
  j.observe([item('anna', { column: 'work' })])
  env.presence = { state: 'away', since: t0 + MIN, by: 'auto' }
  clock.at = t0 + 2 * MIN
  j.observe([item('anna', { column: 'work' })])
  env.presence = { state: 'call', since: t0 + 30 * MIN, by: 'auto', before: 'away' }
  clock.at = t0 + 31 * MIN
  j.observe([item('anna', { column: 'done', result: 'shipped' })])
  expect(j.view()?.strip).toBeNull()
  env.presence = { state: 'away', since: t0 + 60 * MIN, by: 'auto' }
  clock.at = t0 + 61 * MIN
  j.observe([item('anna', { column: 'done', result: 'shipped' })])
  expect(j.awaySince()).toBe(t0 + MIN)
  env.presence = { state: 'here', since: t0 + 90 * MIN, by: 'user' }
  clock.at = t0 + 90 * MIN + 500
  j.observe([item('anna', { column: 'done', result: 'shipped' })])
  expect(j.view()?.last).toEqual({ from: t0 + MIN, to: t0 + 90 * MIN })
  expect(j.view()?.strip?.rows.map(r => [r.key, r.kind])).toEqual([['anna', 'done']])
})

test('presence: a call from here is no absence', () => {
  fresh()
  const t0 = 1_800_000_000_000
  const { j, clock, env } = journalOf({ at: t0, presence: { state: 'here', since: 1, by: 'auto' } })
  j.observe([item('anna', { column: 'work' })])
  env.presence = { state: 'call', since: t0 + MIN, by: 'auto', before: 'here' }
  clock.at = t0 + 60 * MIN
  j.observe([item('anna', { column: 'done', result: 'ok' })])
  env.presence = { state: 'here', since: t0 + 61 * MIN, by: 'auto' }
  clock.at = t0 + 62 * MIN
  j.observe([item('anna', { column: 'done', result: 'ok' })])
  expect(j.view()).toEqual({ strip: null, last: null })
  expect(j.awaySince()).toBeNull()
})

test('a board started while the owner is away: the absence counts from presence, the return shows it', () => {
  fresh()
  const t0 = 1_800_000_000_000
  const { j, clock, env } = journalOf({ at: t0, presence: { state: 'away', since: t0 - 3600_000, by: 'auto' } })
  j.observe([item('anna', { column: 'work' })])
  expect(j.awaySince()).toBe(t0 - 3600_000)
  clock.at = t0 + 10 * MIN
  j.observe([item('anna', { column: 'me', question: 'push?' })])
  env.presence = { state: 'here', since: t0 + 20 * MIN, by: 'auto' }
  clock.at = t0 + 20 * MIN
  j.observe([item('anna', { column: 'me', question: 'push?' })])
  const strip = j.view()?.strip
  expect(strip?.rows.map(r => [r.key, r.kind])).toEqual([['anna', 'owner']])
  // the board was not recording for the first hour of it: the strip says so
  expect(strip?.recordedFrom).toBe(t0)
})

test('away again after a short return: the new absence counts from its own start', () => {
  fresh()
  const t0 = 1_800_000_000_000
  const { j, clock, env } = journalOf({ at: t0, presence: { state: 'here', since: 1, by: 'auto' } })
  j.observe([item('anna')])
  env.presence = { state: 'away', since: t0 + MIN, by: 'auto' }
  clock.at = t0 + MIN
  j.observe([item('anna')])
  env.presence = { state: 'here', since: t0 + 3 * MIN, by: 'auto' }
  clock.at = t0 + 3 * MIN
  j.observe([item('anna')])
  env.presence = { state: 'away', since: t0 + 5 * MIN, by: 'auto' }
  clock.at = t0 + 5 * MIN
  j.observe([item('anna')])
  expect(j.awaySince()).toBe(t0 + 5 * MIN)
})

test('a return with nothing changed shows no strip', () => {
  fresh()
  const t0 = 1_800_000_000_000
  const { j, clock, env } = journalOf({ at: t0, viewers: 1 })
  j.observe([item('anna', { column: 'work' })])
  env.viewers = 0
  clock.at = t0 + MIN
  j.observe([item('anna', { column: 'work' })])
  env.viewers = 1
  clock.at = t0 + 60 * MIN
  j.observe([item('anna', { column: 'work' })])
  expect(j.view()).toEqual({ strip: null, last: null })
  expect(j.awaySince()).toBe(t0 + MIN)
})

test('a clock set back does not keep the owner away or write on every refresh', () => {
  fresh()
  const t0 = 1_800_000_000_000
  const { j, clock, env } = journalOf({ at: t0, viewers: 1 })
  j.observe([item('anna')])
  env.viewers = 0
  clock.at = t0 + 10 * MIN
  j.observe([item('anna')])
  // the clock goes back an hour, and the page comes back
  env.viewers = 1
  clock.at = t0 - 50 * MIN
  j.observe([item('anna')])
  const marks = () => {
    const db = openJournalDb(false)
    if (!db) throw new Error('no journal.db')
    try {
      return journalStore(db).away()
    } finally {
      db.close()
    }
  }
  const first = marks()
  expect((first.back ?? 0) > (first.left ?? 0)).toBe(true)
  clock.at += 2000
  j.observe([item('anna')])
  expect(marks()).toEqual(first)
})

test('a return where no card moved shows no strip, even with a card that waited before', () => {
  fresh()
  const t0 = 1_800_000_000_000
  const { j, clock, env } = journalOf({ at: t0, viewers: 1 })
  j.observe([item('anna', { column: 'work' }), item('ben', { column: 'me', question: 'May I push?' })])
  env.viewers = 0
  clock.at = t0 + MIN
  j.observe([item('anna', { column: 'work' }), item('ben', { column: 'me', question: 'May I push?' })])
  env.viewers = 1
  clock.at = t0 + 60 * MIN
  j.observe([item('anna', { column: 'work' }), item('ben', { column: 'me', question: 'May I push?' })])
  expect(j.view()).toEqual({ strip: null, last: null })
  expect(j.list(t0 + MIN)?.before).toBe(1)
})

test('seeded once, on its own mark: a board with no cards records the first session started later', () => {
  fresh()
  const t0 = 1_800_000_000_000
  const { j, clock } = journalOf({ at: t0 })
  j.observe([])
  clock.at = t0 + MIN
  j.observe([item('anna', { column: 'work' })])
  clock.at = t0 + 2 * MIN
  j.observe([item('anna', { column: 'me', question: 'ok?' })])
  expect(movesIn()).toEqual([
    { key: 'anna', kind: 'work' },
    { key: 'anna', kind: 'owner' },
  ])
})

test('a read that fails once does not seed again or rewrite the times on record', () => {
  fresh()
  const t0 = 1_800_000_000_000
  const first = journalOf({ at: t0 })
  first.j.observe([item('anna', { column: 'done', result: 'shipped' }), item('ben', { column: 'work' })])
  first.j.stop()
  const raw = new Database(journalFile())
  raw.run('ALTER TABLE last_state RENAME TO last_state_away')
  const second = journalOf({ at: t0 + 10 * MIN })
  second.j.observe([item('anna', { column: 'done', result: 'shipped' }), item('ben', { column: 'idle' })])
  expect(second.logs.length).toBe(1)
  raw.run('ALTER TABLE last_state_away RENAME TO last_state')
  raw.close()
  second.clock.at = t0 + 11 * MIN
  second.j.observe([item('anna', { column: 'done', result: 'shipped' }), item('ben', { column: 'idle' })])
  expect(movesIn()).toEqual([{ key: 'ben', kind: 'idle' }])
  const db = openJournalDb(false)
  if (!db) throw new Error('no journal.db')
  try {
    expect(journalStore(db).states().get('anna')?.at).toBe(t0)
    expect(journalStore(db).start()).toBe(t0)
  } finally {
    db.close()
  }
})

test('a session seen under its pane key first, then its session id: one row, a live link', () => {
  fresh()
  const t0 = 1_800_000_000_000
  const { j, clock } = journalOf({ at: t0 })
  j.observe([item('ben', { column: 'work' })])
  clock.at = t0 + MIN
  j.observe([item('ben', { column: 'work' }), item('pane-w1:p7', { session: null, pane: 'w1:p7', column: 'work' })])
  clock.at = t0 + 2 * MIN
  const sid = '5a6b7c8d-1e2f-4a3b-9c4d-5e6f7a8b9c0d'
  j.observe([item('ben', { column: 'work' }), item(sid, { pane: 'w1:p7', column: 'work' })])
  clock.at = t0 + 3 * MIN
  j.observe([item('ben', { column: 'work' }), item(sid, { pane: 'w1:p7', column: 'me', question: 'May I push?' })])
  expect(movesIn()).toEqual([
    { key: sid, kind: 'work' },
    { key: sid, kind: 'owner' },
  ])
  const list = j.list(t0)
  expect(list?.rows.map(r => [r.key, r.kind])).toEqual([[sid, 'owner']])
  expect(list?.rest).toEqual({ work: 0, idle: 0 })
})
