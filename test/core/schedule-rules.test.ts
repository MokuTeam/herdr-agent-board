import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { translator } from '../../src/core/i18n/translator.ts'
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
import { oldCode, oldFunction } from '../web/support/old-app.ts'

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

test('target: a retry-safe call report stays with its own session, never the one now in its pane', () => {
  const items = [item({ key: 's1', session: 's1', pane: 'p1', cwd: 'C:\\Proj' })]
  const receipt = { key: 'k', session: 's0', reportId: 'call-1', hash: 'h' }
  const gone = entry({ key: 's0', pane: 'p1', cwd: 'C:\\Proj', receipt })
  // Not followed, in one profile or another: it waits for its own session (gone), saying no other.
  assert.deepEqual(
    targetOf(gone, items, () => 'default'),
    {},
  )
  assert.deepEqual(
    targetOf(gone, items, (key: string) => (key === 's0' ? 'work' : 'default')),
    {},
  )
  // Its own session, by key: as any entry.
  assert.deepEqual(
    targetOf(entry({ key: 's1', receipt }), items, () => 'default'),
    { item: items[0] },
  )
})

test('entries from before kinds existed are reminders as ever', () => {
  const at = Date.now()
  assert.equal(promptOf({ id: 'eeee01', key: 's1', text: 'old one', next: at }, at), '[board reminder] old one')
})

test('target: a restart is for the session that asked, never the one /clear left in its pane', () => {
  const items = [item({ key: 's1', session: 's1', pane: 'p1', cwd: 'C:Proj' })]
  const same = (): string => 'default'
  // A reminder follows /clear into s1; a restart does not.
  assert.deepEqual(targetOf(entry({ key: 's0', pane: 'p1', cwd: 'C:Proj' }), items, same), { item: items[0] })
  assert.deepEqual(targetOf(entry({ key: 's0', pane: 'p1', cwd: 'C:Proj', kind: 'restart' }), items, same), {})
  assert.deepEqual(targetOf(entry({ key: 's1', kind: 'restart' }), items, same), { item: items[0] })
})

test('prompt: a restart says how it went as upstream’s promptOf at #51 does, in English and Russian', () => {
  const theirs = (lang: string) => {
    const tr = translator(lang)
    const code = oldCode('src/scheduler.mjs', ['promptOf', 'restartPrompt'], { t: tr }, '513e441')
    return oldFunction(code, 'promptOf')
  }
  const base = entry({ key: 's1', kind: 'restart', text: '', next: now - 3 * HOUR })
  const cases: ScheduleEntry[] = [
    { ...base, by: 'agent' },
    { ...base, by: 'agent', text: 'finish the PR review' },
    { ...base, by: 'agent', from: { key: 's7', name: 'lead' } },
    { ...base, by: 'agent', from: { key: 's7abcdef99', name: '' }, text: 'go on' },
    { ...base, by: 'agent', from: { key: 's1', name: 'self' } },
    { ...base, by: 'user' },
    { ...base, by: 'user', text: 'the MCP server is back' },
    { ...base, by: 'agent', failed: 'herdr-wake is down', text: 'finish it' },
    { ...base, by: 'user', failed: 'herdr-wake is down' },
    { ...base, by: 'agent', failed: 'it stayed up', from: { key: 's7', name: 'lead' }, text: 'x' },
  ]
  for (const lang of ['en', 'ru']) {
    // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
    useLanguage(lang)
    try {
      const was = theirs(lang)
      for (const e of cases) assert.equal(promptOf(e, now), was(e, now), `${lang} ${JSON.stringify(e)}`)
    } finally {
      // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
      useLanguage('en')
    }
  }
})
