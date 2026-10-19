// The archive's rules (src/core/archive.ts): which sessions may go to it and why not, what a
// tidy-up takes, how the archive is searched; and what the page gets of a record.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  type ArchiveCandidate,
  type ArchiveRecord,
  archiveBlock,
  heldEntries,
  publicRecord,
  searchArchive,
  tidyList,
} from '../../src/core/archive.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const DAY = 86_400_000

test('what may go to the archive, and why not', () => {
  const it: ArchiveCandidate = { key: S, session: S, agent: 'claude', pane: 'wP:p1', status: 'idle' }
  assert.equal(archiveBlock(it), '')
  assert.equal(archiveBlock({ ...it, status: 'done' }), '')
  assert.equal(archiveBlock({ ...it, sleeping: true, status: 'sleeping' }), '')
  assert.equal(archiveBlock({ ...it, status: 'working' }), 'archive.why.working')
  assert.equal(archiveBlock({ ...it, status: 'blocked' }), 'archive.why.dialog')
  assert.equal(archiveBlock({ ...it, helpers: { running: 2 } }), 'archive.why.helpers')
  assert.equal(archiveBlock({ ...it, launch: { state: 'starting' } }), 'archive.why.starting')
  assert.equal(archiveBlock({ ...it, launchOnly: true }), 'archive.why.starting')
  // Return resumes a Claude session by its id: another agent, or none, cannot come back.
  assert.equal(archiveBlock({ ...it, agent: 'codex' }), 'archive.why.notClaude')
  assert.equal(archiveBlock({ ...it, session: null }), 'archive.why.notClaude')
  assert.equal(archiveBlock({ ...it, pane: null }), 'archive.why.noPane')
  // Claude out and coming back in a restart; a report with a receipt that must reach it.
  assert.equal(archiveBlock(it, [{ key: S, kind: 'restart', step: 'wake' }]), 'archive.why.restarting')
  assert.equal(archiveBlock(it, [{ key: S, kind: 'restart' }]), '') // one that only waits goes with it
  assert.equal(archiveBlock(it, [{ key: S, kind: 'call', receipt: { key: 'x' } }]), 'archive.why.report')
  assert.equal(archiveBlock(it, [{ key: OTHER, kind: 'call', receipt: { key: 'x' } }]), '')
  // What waits with it: its reminders and pings, not a restart.
  assert.deepEqual(
    heldEntries(
      [
        { key: S, id: 'a' },
        { key: S, id: 'b', kind: 'restart' },
        { key: OTHER, id: 'c' },
      ],
      S,
    ).map(e => e.id),
    ['a'],
  )
})

test('a tidy-up takes the sessions asleep in "Idle" long enough, and the archive is searched by every word', () => {
  const now = Date.now()
  const sleeper = (key: string, days: number, extra: { column?: string } = {}) => ({
    key,
    session: key,
    agent: 'claude',
    pane: `p-${key}`,
    status: 'sleeping',
    sleeping: true,
    column: 'idle',
    activity: now - days * DAY,
    ...extra,
  })
  const items = [
    sleeper('a', 0.5),
    sleeper('b', 2),
    sleeper('c', 4),
    sleeper('d', 9),
    sleeper('e', 9, { column: 'me' }),
    { ...sleeper('f', 9), sleeping: false, status: 'idle' },
  ]
  assert.deepEqual(
    tidyList(items, 0, [], now).map(i => i.key),
    ['a', 'b', 'c', 'd'],
  )
  assert.deepEqual(
    tidyList(items, 1, [], now).map(i => i.key),
    ['b', 'c', 'd'],
  )
  assert.deepEqual(
    tidyList(items, 3, [], now).map(i => i.key),
    ['c', 'd'],
  )
  assert.deepEqual(
    tidyList(items, 7, [], now).map(i => i.key),
    ['d'],
  )

  const records = [
    {
      key: 'a',
      name: 'Invoice fixes',
      category: 'acme',
      cwd: 'C:\\Clients\\Acme\\billing',
      note: 'PR merged',
      archivedAt: now,
    },
    {
      key: 'b',
      name: 'Probe',
      category: 'personal',
      cwd: 'C:\\Work\\Personal\\board',
      note: 'tests green',
      workspace: 'Personal',
      archivedAt: now - DAY,
    },
  ]
  const titles: Record<string, string> = { acme: 'Acme Corp', personal: 'Personal' }
  const opts = {
    laneTitle: (id: string) => titles[id] ?? id,
    dayText: (ms: number) => (ms === now ? 'today' : 'yesterday'),
  }
  assert.deepEqual(
    searchArchive(records, '', opts).map(r => r.key),
    ['a', 'b'],
  )
  assert.deepEqual(
    searchArchive(records, 'acme corp', opts).map(r => r.key),
    ['a'],
  ) // the lane's title
  assert.deepEqual(
    searchArchive(records, 'billing', opts).map(r => r.key),
    ['a'],
  ) // the folder
  assert.deepEqual(
    searchArchive(records, 'GREEN', opts).map(r => r.key),
    ['b'],
  ) // the note, any case
  assert.deepEqual(
    searchArchive(records, 'yesterday probe', opts).map(r => r.key),
    ['b'],
  ) // the day, every word
  assert.deepEqual(
    searchArchive(records, 'probe acme', opts).map(r => r.key),
    [],
  )
})

test('what the page gets of a record: no claims, its held entries as a count, whether a Return is on its way', () => {
  const now = Date.now()
  const record: ArchiveRecord = {
    key: S,
    session: S,
    name: 'Probe card',
    autoName: '',
    category: 'personal',
    cwd: 'C:\\Work\\probe',
    workspace: 'Personal',
    workspaceId: 'wP',
    pane: 'wP:p1',
    tab: 'wP:t1',
    note: 'tests green',
    title: '',
    sleeping: false,
    activity: now,
    archivedAt: now,
    by: 'user',
    state: 'archived',
    closeAt: now,
    closedAt: now,
    held: [{ id: 'r1', key: S, text: 'look again', next: now + DAY }],
    tries: 1,
    claim: { pid: 1, at: now },
    returning: { at: now, launch: 'abcd1234' },
    moved: true,
    profile: 'work',
  }
  const shown = publicRecord(record, { returning: true })
  for (const field of ['claim', 'tries', 'moved']) assert.equal(field in shown, false, field)
  assert.equal(shown.held, 1)
  assert.equal(shown.returning, true)
  assert.equal(shown.profile, 'work')
  assert.equal(publicRecord(record).returning, false)
})
