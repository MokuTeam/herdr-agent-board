import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { useLanguage } from '../../src/core/lang.ts'
import {
  cleanName,
  cleanText,
  MAX_PER_SESSION,
  MAX_TEXT,
  promptOf,
  type ScheduleEntry,
  targetOf,
} from '../../src/core/schedule-rules.ts'
import type { Item } from '../../src/core/types.ts'

// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

const HOUR = 3600e3
const now = new Date(2026, 9, 15, 14, 0).getTime()
const entry = (fields: Partial<ScheduleEntry>): ScheduleEntry => ({
  id: 'aaaaa1',
  key: 's0',
  text: 'check the CI run',
  next: now,
  ...fields,
})
const item = (fields: Partial<Item>): Item =>
  ({ key: 's0', session: 's0', pane: 'p1', cwd: 'C:\\Proj', ...fields }) as Item

test('limits per session and text', () => {
  assert.equal(MAX_PER_SESSION, 30)
  assert.equal(MAX_TEXT, 2000)
})

test('text loses control characters (an escape could drive the pane) and is cut', () => {
  assert.equal(cleanText('look\x07 at\x1b[31m this\x7f'), 'look at[31m this')
  assert.equal(cleanText('line\nbreak\ttab'), 'line\nbreak\ttab')
  assert.equal(cleanText(undefined), '')
  assert.equal(cleanText(42), '42')
  assert.equal(cleanText('x'.repeat(MAX_TEXT + 5)).length, MAX_TEXT)
})

test('names lose control characters and brackets, are trimmed and cut to 60', () => {
  assert.equal(cleanName('  [lead]\x1b session '), 'lead session')
  assert.equal(cleanName(null), '')
  assert.equal(cleanName('n'.repeat(70)).length, 60)
})

test('prompt: a plain reminder, one that is late, a cron entry with missed runs', () => {
  assert.equal(promptOf(entry({}), now), '[board reminder] check the CI run')
  assert.equal(
    promptOf(entry({ next: now - 3 * HOUR, text: 'late one' }), now),
    '[board reminder; 3 h late, due 11:00 AM] late one',
  )
  assert.equal(promptOf(entry({ next: now - 90e3 }), now), '[board reminder] check the CI run')
  assert.equal(
    promptOf(entry({ cron: '0 * * * *', next: now - 3 * HOUR, text: 'hourly' }), now),
    '[board schedule aaaaa1: 0 * * * *; 4 runs since 11:00 AM, sent once] hourly',
  )
  assert.equal(promptOf(entry({ cron: '0 * * * *', text: 'cron' }), now), '[board schedule aaaaa1: 0 * * * *] cron')
})

test('prompt: says who set it and what /clear changed', () => {
  assert.equal(
    promptOf(entry({ from: { key: 'lead-session', name: '' } }), now),
    '[board reminder from lead-ses] check the CI run',
  )
  assert.equal(
    promptOf(entry({ from: { key: 's9', name: 'Lead' } }), now),
    '[board reminder from Lead] check the CI run',
  )
  assert.equal(
    promptOf(entry({ movedFrom: { key: 'old', name: 'Test' } }), now),
    '[board reminder; set by Test before /clear] check the CI run',
  )
  assert.equal(
    promptOf(entry({ from: { key: 's7', name: 'Lead' }, movedFrom: { key: 'old12345678', name: '' } }), now),
    '[board reminder from Lead; set for old12345 before /clear] check the CI run',
  )
  // Its own reminder has no "from", also after /clear.
  assert.equal(
    promptOf(entry({ from: { key: 'old', name: 'Test' }, movedFrom: { key: 'old', name: 'Test' } }), now),
    '[board reminder; set by Test before /clear] check the CI run',
  )
})

test('target: the session by key, else the session now in its pane and folder', () => {
  const items = [
    item({ key: 's1', session: 's1', pane: 'p1', cwd: 'c:/proj/' }),
    item({ key: 's2', session: 's2', pane: 'p2', cwd: 'C:\\Proj' }),
  ]
  // One profile: every session is in it.
  const one = () => 'default'
  assert.deepEqual(targetOf(entry({ key: 's2' }), items, one), { item: items[1] })
  // /clear: s0 is gone, pane p1 and the folder (case, slashes, trailing slash ignored) lead to s1.
  assert.deepEqual(targetOf(entry({ key: 's0', pane: 'p1', cwd: 'C:\\Proj' }), items, one), { item: items[0] })
  assert.deepEqual(targetOf(entry({ key: 's0', pane: 'p1', cwd: 'C:\\Other' }), items, one), {})
  assert.deepEqual(targetOf(entry({ key: 's0' }), items, one), {}) // no pane or folder recorded
  assert.deepEqual(
    targetOf(
      entry({ key: 's0', pane: 'p1', cwd: 'C:\\Proj' }),
      [item({ key: 's1', session: 's1', pane: 'p1', cwd: 'C:\\Proj', sleeping: true })],
      one,
    ),
    {},
  )
  assert.deepEqual(
    targetOf(
      entry({ key: 's0', pane: 'p1', cwd: 'C:\\Proj' }),
      [item({ key: 's1', session: null, pane: 'p1', cwd: 'C:\\Proj' })],
      one,
    ),
    {},
  )
})

test('target: a reminder set in a work session never goes to a default session in its pane', () => {
  const items = [item({ key: 's1', session: 's1', pane: 'p1', cwd: 'C:\\Proj' })]
  const gone = entry({ key: 's0', pane: 'p1', cwd: 'C:\\Proj' })
  const profiles = (map: Record<string, string>) => (key: string) => map[key]
  // s0 ran in work, s1 runs in default: not followed, s1 comes back as the one it did not go to.
  assert.deepEqual(targetOf(gone, items, profiles({ s0: 'work', s1: 'default' })), { other: items[0] })
  // Either one not known: not followed either.
  assert.deepEqual(targetOf(gone, items, profiles({ s1: 'default' })), { other: items[0] })
  assert.deepEqual(targetOf(gone, items, profiles({ s0: 'work' })), { other: items[0] })
  assert.deepEqual(targetOf(gone, items, profiles({})), { other: items[0] })
  // Both in work (/clear keeps the Claude and its profile): followed.
  assert.deepEqual(targetOf(gone, items, profiles({ s0: 'work', s1: 'work' })), { item: items[0] })
  // Its own session, by key: whatever profiles say.
  assert.deepEqual(targetOf(entry({ key: 's1' }), items, profiles({})), { item: items[0] })
})

test('entries from before kinds existed are reminders as ever', () => {
  const at = Date.now()
  assert.equal(promptOf({ id: 'eeee01', key: 's1', text: 'old one', next: at }, at), '[board reminder] old one')
})
