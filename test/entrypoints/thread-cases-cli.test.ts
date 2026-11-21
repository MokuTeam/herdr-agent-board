// Case files (#488) as an agent runs them, in this process (as test/entrypoints/thread-cli.test.ts
// does): a reference and the duplicate warning, list --ref, a state and its caps, show's head, the
// brief with sessions up, asleep and archived since and their reminders, what stays off the hub; and,
// with case files absent, every command as it was.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/adapters/db.ts'
import { entriesOf, findThread, setScope } from '../../src/adapters/work-thread-store.ts'
import { liveWords, type SessionLive } from '../../src/core/work-cases.ts'
import type { Party } from '../../src/core/work-threads.ts'
import { THREAD_USAGE, type ThreadCmdContext, threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { caseItems, liveOf } from '../../src/services/case-sessions.ts'
import { holderFolder, nudgesFor, readCase } from '../../src/services/work-cases.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-20T14:00:00Z')
const anna: Party = { kind: 'session', key: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'anna' }
const ben: Party = { kind: 'session', key: 'pane-wA:p3', name: 'ben cooper' }
const cleo: Party = { kind: 'session', key: '7c9e6679-7425-40de-944b-e07fc1f90ae7', name: 'клео 100%' }
const owner: Party = { kind: 'owner' }
const sessions: Record<string, Party> = { anna, 'ben cooper': ben, cleo }
const keyOf = (p: Party): string => (p.kind === 'session' ? p.key : '')
const CASES = { cases: true }

function setUp(threads: unknown = CASES, over: Partial<ThreadCmdContext> = {}) {
  isolatedHome()
  const run = async (actor: Party, args: string[], more: Partial<ThreadCmdContext> = {}) => {
    const out: string[] = []
    const err: string[] = []
    const code = await threadCmd(args, {
      cfg: { threads, port: 12422 },
      actor,
      lane: 'atlas',
      findSession: async w => sessions[w] ?? null,
      out: l => out.push(l),
      err: l => err.push(l),
      now: NOW,
      ...over,
      ...more,
    })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  const json = async (actor: Party, args: string[], more: Partial<ThreadCmdContext> = {}) =>
    JSON.parse((await run(actor, [...args, '--json'], more)).out)
  return { run, json }
}

/** Where the board sees each session: anna asleep, ben archived since he wrote, cleo up. */
const live: ThreadCmdContext['cases'] = {
  live: async keys =>
    new Map<string, SessionLive>(
      keys.map(k => [
        k,
        k === keyOf(anna)
          ? { state: 'asleep', name: 'anna', cwd: '/work/atlas' }
          : k === keyOf(ben)
            ? { state: 'archived', cwd: '/work/old' }
            : k === keyOf(cleo)
              ? { state: 'up', cwd: '/work/cleo' }
              : { state: 'gone' },
      ]),
    ),
  reminders: keys =>
    keys.includes(keyOf(anna))
      ? [{ session: keyOf(anna), id: 'abc123', next: NOW + 3_600_000, text: 'check the client reply' }]
      : [],
}

test('case files absent: no --ref, no --state, no brief, the usage, show and list as they were', async () => {
  for (const threads of [true, { agents: true }, { cases: false }]) {
    const { run, json } = setUp(threads)
    assert.equal((await run(anna, ['new', 'Import mapping for the order feed'])).out, 'ok · atlas-1 · next')
    await run(ben, ['post', 'atlas-1', '--status', 'doing', 'started'])
    await run(cleo, ['post', 'atlas-1', '--summary', '100% of rows read'])
    const ref = await run(anna, ['new', '--ref', 'ABC-12', 'Another'])
    assert.equal(ref.code, 1)
    assert.match(ref.err, /^board thread new does not take --ref \(put -- before text that starts with --\)/)
    const state = await run(anna, ['post', 'atlas-1', '--state', 'Mapped'])
    assert.match(state.err, /^board thread post does not take --state/)
    assert.match((await run(anna, ['list', '--ref', 'ABC-12'])).err, /^board thread list does not take --ref/)
    assert.match((await run(anna, ['set', 'atlas-1', '--ref', 'x'])).err, /^board thread set does not take --ref/)
    const brief = await run(anna, ['brief', 'atlas-1'])
    assert.equal(brief.code, 1)
    assert.equal(brief.err, `no command "board thread brief"\n${THREAD_USAGE}`)
    assert.equal((await run(anna, ['--help'])).out, THREAD_USAGE)
    // show: the head and the feed, no case lines; its JSON and list's carry no new keys.
    const shown: string = (await run(anna, ['show', 'atlas-1'])).out
    assert.doesNotMatch(shown, /^(ref|state|sessions:)/m)
    assert.equal(shown.split('\n')[0], 'atlas-1 · doing · Import mapping for the order feed · 100% of rows read')
    const j = await json(anna, ['show', 'atlas-1'])
    assert.equal('case' in j, false)
    const keys = [
      'assignee',
      'createdAt',
      'createdBy',
      'doneAt',
      'id',
      'key',
      'lane',
      'parent',
      'proposed',
      'rev',
      'scope',
      'status',
      'summary',
      'title',
      'updatedAt',
      'waitingOn',
    ]
    assert.deepEqual(Object.keys(j.thread).sort(), keys)
    assert.deepEqual(Object.keys((await json(anna, ['list'])).threads[0]).sort(), keys)
    const set = await run(anna, ['set', 'atlas-1'])
    assert.match(set.err, /^nothing to set: --title, --assignee, --lane or --parent/)
  }
})

test('a reference: new and set take it, a second open thread with the same one is warned about, never refused', async () => {
  const { run, json } = setUp()
  assert.equal(
    (await run(anna, ['new', '--ref', 'https://tracker.example/browse/ABC-12', 'Import mapping'])).out,
    'ok · atlas-1 · next',
  )
  assert.equal(
    (await json(anna, ['new', '--lane', 'beta', '--ref', 'abc-12', 'Same case, other lane'])).thread.key,
    'beta-1',
  )
  const dup = await run(anna, ['new', '--ref', 'ABC-12', 'Third'])
  assert.equal(
    dup.out,
    'ok · atlas-2 · next · [same ref: atlas-1 "Import mapping"] · [same ref: beta-1 "Same case, other lane"]',
  )
  const dj = await json(anna, ['new', '--ref', 'ABC-12/', 'Fourth'])
  assert.deepEqual(
    dj.sameRef.map((s: { key: string }) => s.key),
    ['atlas-1', 'atlas-2', 'beta-1'],
  )
  assert.equal(dj.thread.ref, 'ABC-12/')
  // A closed thread with that reference, or another reference: nothing said.
  await run(anna, ['done', 'atlas-1', 'finished'])
  await run(anna, ['done', 'atlas-2', 'finished'])
  await run(anna, ['done', 'atlas-3', 'finished'])
  await run(anna, ['post', 'beta-1', '--status', 'dropped'])
  assert.equal((await run(anna, ['new', '--ref', 'ABC-12', 'Fifth'])).out, 'ok · atlas-4 · next')
  assert.equal('sameRef' in (await json(anna, ['new', '--ref', 'XYZ-1', 'Other'])), false)
  // set: the same warning, never about itself; none clears it.
  assert.equal(
    (await run(anna, ['set', 'atlas-5', '--ref', 'abc-12'])).out,
    'ok · atlas-5 · next · [same ref: atlas-4 "Fifth"]',
  )
  assert.equal(
    (await run(anna, ['set', 'atlas-4', '--ref', 'ABC-12'])).out,
    'ok · atlas-4 · next · [same ref: atlas-5 "Other"]',
  )
  const cleared = await json(anna, ['set', 'atlas-5', '--ref', 'none'])
  assert.equal('ref' in cleared.thread, false)
  // Refusals: empty, too long.
  assert.equal((await json(anna, ['set', 'atlas-5', '--ref', '  '])).error, 'ref')
  assert.equal((await json(anna, ['new', '--ref', 'x'.repeat(201), 'Too long'])).error, 'ref_long')
})

test('list --ref: every thread with that reference, closed ones too, from every lane', async () => {
  const { run } = setUp()
  await run(anna, ['new', '--ref', 'https://tracker.example/browse/ABC-12', 'Import mapping'])
  await run(anna, ['new', '--lane', 'beta', '--ref', 'ABC-12', 'Beta side'])
  await run(anna, ['new', '--ref', 'ABC-13', 'Not this one'])
  await run(anna, ['new', 'No reference'])
  await run(anna, ['done', 'atlas-1', 'mapped'])
  const all = (await run(anna, ['list', '--ref', 'abc-12'])).out.split('\n')
  assert.deepEqual(all, ['beta-1 · next · Beta side', 'atlas-1 · done · Import mapping · mapped'])
  assert.deepEqual(
    (await run(anna, ['list', '--ref', 'ABC-12', '--lane', 'atlas'])).out,
    'atlas-1 · done · Import mapping · mapped',
  )
  assert.equal((await run(anna, ['list', '--ref', 'NOPE-1'])).out, 'no threads')
})

test('a state: several lines kept, capped; the head shows the newest with its date, the feed keeps the earlier ones', async () => {
  const { run, json } = setUp({ cases: true }, { cases: live })
  await run(anna, ['new', '--ref', 'ABC-12', '--to', 'anna', 'Import mapping'])
  const posted = await run(anna, ['post', 'atlas-1', '--state', 'Mapped 217 rows.\nNext: the 2019 prices.'])
  assert.equal(posted.out, 'ok · atlas-1 · doing')
  const j = await json(anna, ['show', 'atlas-1'])
  assert.deepEqual(j.thread.state, { text: 'Mapped 217 rows.\nNext: the 2019 prices.', at: NOW, by: anna })
  await run(ben, ['post', 'atlas-1', 'started on the prices'])
  await run(anna, ['done', 'atlas-1', '--state', 'All mapped.', 'everything mapped'])
  const shown = (await run(owner, ['show', 'atlas-1'])).out.split('\n')
  assert.deepEqual(shown.slice(0, 5), [
    'atlas-1 · done · anna · Import mapping · everything mapped',
    'lane atlas · by anna 14:00 · http://127.0.0.1:12422/#thread=atlas-1',
    'ref ABC-12',
    'state 14:00 by anna: All mapped.',
    'sessions: anna (0f8fad5b) asleep holds it · ben cooper (pane-wA:p3) archived',
  ])
  assert.ok(
    shown.some(l => l.includes('anna: state: Mapped 217 rows. Next: the 2019 prices.')),
    shown.join('\n'),
  )
  assert.deepEqual(
    (await json(owner, ['show', 'atlas-1'])).case.sessions.map((s: { name: string; state: string; cwd?: string }) => [
      s.name,
      s.state,
      s.cwd,
    ]),
    [
      ['anna', 'asleep', '/work/atlas'],
      ['ben cooper', 'archived', '/work/old'],
    ],
  )
  // The caps, with the cap in the words.
  assert.deepEqual(await json(anna, ['post', 'atlas-1', '--state', 'x'.repeat(2001)]), {
    ok: false,
    error: 'state_long',
    message: 'the state has 2001 characters; 2000 at most: put the rest in a --file',
  })
  const lines = Array.from({ length: 31 }, (_, i) => `l${i}`).join('\n')
  assert.equal((await json(anna, ['post', 'atlas-1', '--state', lines])).error, 'state_lines')
  assert.equal((await json(anna, ['post', 'atlas-1', '--state', ' \n '])).error, 'state')
})

test('the brief: the case for a fresh session, sessions up, asleep and archived since, their reminders, inside 6,000', async () => {
  const { run, json } = setUp({ cases: true }, { cases: live })
  await run(owner, ['new', '--ref', 'ABC-12', '--to', 'ben cooper', 'Import mapping'])
  await run(ben, ['post', 'atlas-1', 'half of the columns', '--link', 'https://tracker.example/browse/ABC-12'])
  await run(owner, ['set', 'atlas-1', '--assignee', 'anna'])
  await run(anna, ['post', 'atlas-1', '--state', 'Mapped 217 rows.\nWaits on: the price list.'])
  await run(cleo, ['post', 'atlas-1', 'a question for anna'])
  const text = (await run(owner, ['brief', 'atlas-1'])).out
  for (const part of [
    'Case atlas-1 · doing · Import mapping',
    'ref ABC-12 · lane atlas · http://127.0.0.1:12422/#thread=atlas-1',
    'State, 14:00 by anna:\nMapped 217 rows.\nWaits on: the price list.',
    '- клео 100% (7c9e6679-7425-40de-944b-e07fc1f90ae7) up wrote 1 last 14:00 in /work/cleo',
    '- anna (0f8fad5b-d9cb-469f-a165-70867728950e) asleep holds it wrote 1 last 14:00 in /work/atlas',
    '- ben cooper (pane-wA:p3) archived held it wrote 1 last 14:00 in /work/old',
    '- anna: 15:00: check the client reply',
    '- https://tracker.example/browse/ABC-12 · #2',
    'More: board thread show atlas-1 --full',
  ])
    assert.ok(text.includes(part), `${part}\n---\n${text}`)
  assert.doesNotMatch(text, /board resume \S/)
  assert.ok(text.length <= 6000)
  const j = await json(owner, ['brief', 'atlas-1'])
  assert.equal(j.text, text)
  // Newest first; anna and cleo wrote in the same minute, so by key.
  assert.deepEqual(
    j.sessions.map((s: { state: string }) => s.state),
    ['asleep', 'up', 'archived'],
  )
  assert.equal(j.reminders[0].id, 'abc123')
  // Without the board's answer the sessions are still named, their state not known.
  const bare = (await run(owner, ['brief', 'atlas-1'], { cases: {} })).out
  assert.match(bare, /- anna \(0f8fad5b-d9cb-469f-a165-70867728950e\) unknown holds it/)
  assert.match((await run(owner, ['brief'])).err, /^which thread\? give its key/)
})

test('case files on, a thread that is no case: show as before, nobody asked where its sessions are', async () => {
  let asked = 0
  const { run } = setUp(CASES, {
    cases: {
      live: async () => {
        asked++
        return new Map()
      },
    },
  })
  await run(anna, ['new', 'A plain task'])
  await run(ben, ['post', 'atlas-1', 'a note'])
  const shown = (await run(anna, ['show', 'atlas-1'])).out
  assert.doesNotMatch(shown, /^(ref|state|sessions:)/m)
  assert.equal(asked, 0)
})

test('what stays on this board: an entry with only a state or a reference is private; on a shared thread it is not queued', async () => {
  const { run, json } = setUp()
  await run(owner, ['new', '--ref', 'ABC-12', 'Shared case'])
  const db = openDb()
  assert.ok(db)
  try {
    const head = findThread(db, 'atlas-1', null)
    db.write('test', tx =>
      setScope(tx, head.id, { kind: 'peer', peer: 'peer-ben', topic: 'topic-1', key: 'atlas-1', by: 'me', at: NOW }),
    )
  } finally {
    db.close()
  }
  const only = await json(anna, ['post', 'atlas-1', '--state', 'Mapped.'])
  assert.equal(only.entry.private, true)
  assert.equal('out' in only, false, 'nothing goes out')
  const ref = await json(anna, ['set', 'atlas-1', '--ref', 'ABC-13'])
  assert.equal(ref.entry.private, true)
  // Text with a state: the text goes (queued for the hub), the state with it stays out of the wire.
  const both = await json(anna, ['post', 'atlas-1', '--state', 'Half done.', 'a note for ben'])
  assert.equal(both.entry.private, undefined)
  assert.equal(both.entry.out, 'queued')
  const db2 = openDb()
  assert.ok(db2)
  try {
    const entries = entriesOf(db2, findThread(db2, 'atlas-1', null).id)
    // A private entry takes the number of the entry before it (#541): the shared one after two
    // state and reference writes is the thread's second, so a teammate's board sees no gap.
    const own = entries.filter(e => e.type !== 'system')
    assert.deepEqual(
      own.map(e => [e.private ?? false, e.out ?? null, e.n]),
      [
        [true, null, 1],
        [true, null, 1],
        [false, 'queued', 2],
      ],
    )
  } finally {
    db2.close()
  }
})

test('the nudge (services/work-cases.ts): only with case files on, for the open cases the session holds', async () => {
  const { run } = setUp()
  await run(owner, ['new', '--ref', 'ABC-12', '--to', 'anna', 'Import mapping'])
  await run(owner, ['new', '--to', 'anna', 'A plain task'])
  await run(owner, ['new', '--ref', 'ABC-13', '--to', 'ben cooper', 'Not anna'])
  assert.deepEqual(nudgesFor({ threads: CASES }, keyOf(anna), undefined, NOW), [
    'atlas-1: no state yet: board thread post atlas-1 --state "<where it stands, what next, what it waits on>"',
  ])
  assert.deepEqual(nudgesFor({ threads: true }, keyOf(anna), undefined, NOW), [])
  assert.deepEqual(nudgesFor({}, keyOf(anna), undefined, NOW), [])
  await run(anna, ['post', 'atlas-1', '--state', 'Mapped.'])
  assert.deepEqual(nudgesFor({ threads: CASES }, keyOf(anna), NOW - 60_000, NOW), [])
  assert.match(
    nudgesFor({ threads: CASES }, keyOf(anna), NOW + 60_000, NOW + 120_000)[0] ?? '',
    /^atlas-1: state from 14:00, older than your work/,
  )
})

// Nodes (#508): a session that runs on a node writes under its device-prefixed key. The master reads
// it from the nodes' items when it has them; where it does not, it is on that device, its state not
// known here, never gone; and its folder, that computer's, is never a fresh start's.
test("a node's session: from the nodes' items where the board has them, else on its device and not known here, never gone", async () => {
  const worker: Party = { kind: 'session', key: '@server-1:s-1', name: 'worker' }
  const nodeCard = { key: '@server-1:s-1', name: 'worker', cwd: '/srv/work/atlas' }
  assert.deepEqual(
    liveOf([worker.kind === 'session' ? worker.key : ''], [nodeCard]),
    new Map([['@server-1:s-1', { state: 'up', name: 'worker', cwd: '/srv/work/atlas', device: 'server-1' }]]),
  )
  assert.deepEqual(
    liveOf(['@server-1:s-1'], []),
    new Map([['@server-1:s-1', { state: 'unknown', device: 'server-1' }]]),
  )
  assert.deepEqual(
    liveOf(['@server-1:s-1'], null),
    new Map([['@server-1:s-1', { state: 'unknown', device: 'server-1' }]]),
  )

  // The board command on the master, with no card of the node's session (this computer's items only).
  const { run } = setUp(CASES, { cases: { live: async keys => liveOf(keys, []) } })
  await run(owner, ['new', '--ref', 'ABC-12', '--to', 'anna', 'Import'])
  await run(owner, ['set', 'atlas-1', '--assignee', '@server-1:s-1'], {
    findSession: async w => (w === '@server-1:s-1' ? worker : (sessions[w] ?? null)),
  })
  await run(worker, ['post', 'atlas-1', '--state', 'Mapped on the server.'])
  const brief = (await run(anna, ['brief', 'atlas-1'])).out
  assert.match(brief, /- worker \(@server-1:s-1\) on server-1, state not known here holds it/)
  assert.doesNotMatch(brief, /@server-1:s-1\) gone/)
  const shown = (await run(anna, ['show', 'atlas-1'])).out
  assert.match(shown, /worker \(@server-1:s-1\) on server-1, state not known here holds it/)

  // Its folder is the node's: a fresh start takes the earlier holder's here, never that one.
  const db = openDb()
  assert.ok(db)
  try {
    const c = await readCase(db, findThread(db, 'atlas-1', null), {
      live: async keys => liveOf(keys, [nodeCard, { key: keyOf(anna), name: 'anna', cwd: '/work/atlas' }]),
    })
    assert.deepEqual(holderFolder(c, () => true)?.session.key, keyOf(anna))
  } finally {
    db.close()
  }
})

test("a master's cards for a case: a device it does not hear gives its copy with the copy's time, never up now", () => {
  const own = [{ key: keyOf(anna), name: 'anna', cwd: '/work/atlas' }]
  const items = [
    { key: '@server-1:s-1', name: 'worker', cwd: '/srv/a', device: 'server-1' },
    { key: '@laptop-2:s-2', name: 'other', cwd: '/home/b', device: 'laptop-2', sleeping: true },
    { key: '@gone-3:s-3', name: 'lost', cwd: '/x', device: 'gone-3' },
  ]
  const devices = [
    {
      id: 'server-1',
      kind: 'direct' as const,
      link: { state: 'online' as const, heardAt: NOW, since: NOW },
      payloadAt: NOW,
    },
    {
      id: 'laptop-2',
      kind: 'direct' as const,
      link: { state: 'offline' as const, heardAt: NOW - 600_000, since: NOW },
      payloadAt: NOW - 900_000,
    },
  ]
  const all = caseItems(own, { items, devices } as never)
  const live = liveOf(['@server-1:s-1', '@laptop-2:s-2', '@gone-3:s-3', keyOf(anna)], all)
  assert.deepEqual(live.get('@server-1:s-1'), { state: 'up', name: 'worker', cwd: '/srv/a', device: 'server-1' })
  assert.deepEqual(live.get('@laptop-2:s-2'), {
    state: 'asleep',
    seenAt: NOW - 900_000,
    name: 'other',
    cwd: '/home/b',
    device: 'laptop-2',
  })
  // A device the payload does not list: no time for its copy, so not known.
  assert.deepEqual(live.get('@gone-3:s-3'), { state: 'unknown', device: 'gone-3' })
  assert.equal(live.get(keyOf(anna))?.state, 'up')
  assert.equal(caseItems(own, null).length, 1)
  assert.equal(liveWords(live.get('@laptop-2:s-2') as SessionLive, NOW), 'last seen asleep on laptop-2, 13:45')
  assert.equal(liveWords(live.get('@server-1:s-1') as SessionLive, NOW), 'up on server-1')
})
