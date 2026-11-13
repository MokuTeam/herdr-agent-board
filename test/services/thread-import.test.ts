// A harness's task board as threads (#393, docs/design/threads 13.1): `board thread import <file>`
// as MokuPilot runs it, in this process (the board's database in a temp state folder), and the
// board's one-way copy of a pi day's task board (services/thread-import.ts piDayMirror), fed a fake
// MokuPilot, day and folder.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../../src/adapters/db.ts'
import { stateDir } from '../../src/adapters/paths.ts'
import type { Party } from '../../src/core/work-threads.ts'
import { type ThreadCmdContext, threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { piDayMirror } from '../../src/services/thread-import.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-12T14:00:00Z')
const DAY = '3dbb2396-0000-4000-8000-000000000393'
const PI = 'pi-day-0393'
const master: Party = { kind: 'session', key: DAY, name: 'work-a7' }
const mapper: Party = { kind: 'session', key: 'pane-wP:p2', name: 'atlas-mapper' }
const byKey: Record<string, Party> = { [mapper.key]: mapper }
const iso = (t: string): string => `2026-11-12T${t}:00.000Z`

/** A day's task board as MokuPilot writes it (agent_board.py snapshot_to_json). */
function taskFile(items: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  return {
    format: 'agent-board',
    version: 1,
    harness: 'claude',
    session_id: DAY,
    writer: 'mokupilot',
    revision: 7,
    next_id: 5,
    updated_at: iso('13:00'),
    items,
    ...over,
  }
}

const LONG =
  'Reconcile the order feed with the warehouse export, line by line, and list every order whose total differs by more than a cent'

const ITEMS = [
  {
    id: 'b1',
    text: 'Import mapping for the order feed',
    status: 'doing',
    owner: '',
    owner_id: '',
    created_at: iso('09:00'),
    started_at: iso('09:05'),
    done_at: null,
    updated_at: iso('09:05'),
  },
  {
    id: 'b2',
    parent_id: 'b1',
    note: '217 rows mapped, 3 flagged in the report',
    text: 'Map the 2019 price columns',
    status: 'done',
    owner: 'atlas-mapper',
    owner_id: mapper.key,
    created_at: iso('09:10'),
    started_at: iso('09:12'),
    done_at: iso('11:30'),
    updated_at: iso('11:30'),
  },
  {
    id: 'b3',
    text: LONG,
    status: 'next',
    owner: '',
    owner_id: '',
    created_at: iso('10:00'),
    started_at: null,
    done_at: null,
    updated_at: iso('10:00'),
  },
  {
    id: 'b4',
    parent_id: 'b1',
    text: 'Check the 2020 columns',
    status: 'doing',
    owner: 'cleo',
    owner_id: 'gone-session-1',
    created_at: iso('09:20'),
    started_at: iso('09:21'),
    done_at: null,
    updated_at: iso('09:21'),
  },
]

function setUp(o: { threads?: unknown } = { threads: true }) {
  const dir = isolatedHome()
  const run = async (actor: Party, args: string[], over: Partial<ThreadCmdContext> = {}) => {
    const out: string[] = []
    const err: string[] = []
    const code = await threadCmd(args, {
      cfg: { ...('threads' in o && { threads: o.threads }), port: 12422 },
      actor,
      lane: 'atlas',
      findSession: async w => (w === 'atlas-mapper' ? mapper : null),
      sessionByKey: async k => byKey[k] ?? null,
      out: l => out.push(l),
      err: l => err.push(l),
      now: NOW,
      ...over,
    })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  const json = async (actor: Party, args: string[], over: Partial<ThreadCmdContext> = {}) =>
    JSON.parse((await run(actor, [...args, '--json'], over)).out)
  const put = (name: string, value: unknown): string => {
    const file = join(dir, 'boards', name)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
    return file
  }
  return { dir, run, json, put }
}

/** The journal's rows of threads: every write is one. */
function journalRows(): number {
  const db = openDb({ create: false })
  assert.ok(db)
  try {
    return (db.db.query("SELECT count(*) AS n FROM journal WHERE store = 'threads'").get() as { n: number }).n
  } finally {
    db.close()
  }
}

test('import: one thread per item with its parent, status, assignee and times; a second run changes nothing', async () => {
  const { run, json, put } = setUp()
  const file = put(`claude/${DAY}.json`, taskFile(ITEMS))
  assert.deepEqual(await run(master, ['import', file]), { code: 0, out: 'ok · claude/3dbb2396 · 4 new', err: '' })
  const keys = (await json(master, ['import', file])).keys as Record<string, string>
  expect(keys).toEqual({ b1: 'atlas-1', b3: 'atlas-2', b2: 'atlas-3', b4: 'atlas-4' })

  const root = await json(master, ['show', 'atlas-1', '--full'])
  expect(root.thread).toMatchObject({
    title: 'Import mapping for the order feed',
    status: 'doing',
    assignee: null,
    parent: null,
    createdAt: Date.parse(iso('09:00')),
    updatedAt: Date.parse(iso('09:05')),
    createdBy: master,
    origin: { agentBoard: { harness: 'claude', session: DAY, id: 'b1' } },
  })
  expect(root.children).toEqual([
    { key: 'atlas-3', status: 'done', title: 'Map the 2019 price columns' },
    { key: 'atlas-4', status: 'doing', title: 'Check the 2020 columns' },
  ])

  // The step: its parent, its owner a session on the board, its note the summary; started_at and
  // done_at are status entries at those times.
  const step = await json(master, ['show', 'atlas-3', '--full'])
  expect(step.thread).toMatchObject({
    status: 'done',
    summary: '217 rows mapped, 3 flagged in the report',
    assignee: mapper,
    parent: root.thread.id,
    createdAt: Date.parse(iso('09:10')),
    doneAt: Date.parse(iso('11:30')),
  })
  expect(step.entries.map((e: { n: number; at: number; set: unknown }) => [e.n, e.at, e.set])).toEqual([
    [
      1,
      Date.parse(iso('09:10')),
      {
        title: 'Map the 2019 price columns',
        status: 'next',
        lane: 'atlas',
        assignee: mapper,
        parent: root.thread.id,
        summary: '217 rows mapped, 3 flagged in the report',
      },
    ],
    [2, Date.parse(iso('09:12')), { status: 'doing' }],
    [3, Date.parse(iso('11:30')), { status: 'done' }],
  ])

  // An owner that is no session on the board: the name alone.
  expect((await json(master, ['show', 'atlas-4'])).thread.assignee).toEqual({
    kind: 'session',
    key: 'gone-session-1',
    name: 'cleo',
  })

  // A text past 80 characters: the title cut, the whole text the first entry.
  const long = await json(master, ['show', 'atlas-2', '--full'])
  expect(long.thread.title.length).toBe(80)
  expect(long.thread.title.endsWith('…')).toBe(true)
  expect(long.entries[0].text).toBe(LONG)
  expect((await run(master, ['show', 'atlas-2', '--full'])).out).toContain(LONG)

  // Run again: nothing written.
  const rows = journalRows()
  assert.deepEqual(await run(master, ['import', file]), {
    code: 0,
    out: 'ok · claude/3dbb2396 · 4 unchanged',
    err: '',
  })
  expect(journalRows()).toBe(rows)
  expect((await json(master, ['list', '--all', '--done'])).threads).toHaveLength(4)
})

test('import again after the file changed: one entry per changed item; a thread that waits on the owner stays so while the file says doing', async () => {
  const { run, json, put } = setUp()
  const file = put(`claude/${DAY}.json`, taskFile(ITEMS))
  await run(master, ['import', file])
  // On the board the root waits on the owner now; the file still says doing.
  await run(master, ['ask', 'atlas-1', 'which price list wins?'])
  const items = ITEMS.map(i =>
    i.id === 'b1'
      ? { ...i, note: 'two price lists, the owner picks', updated_at: iso('12:00') }
      : i.id === 'b4'
        ? { ...i, status: 'done', done_at: iso('12:30'), updated_at: iso('12:30') }
        : i,
  )
  put(`claude/${DAY}.json`, taskFile(items))
  assert.deepEqual(await run(master, ['import', file]), {
    code: 0,
    out: 'ok · claude/3dbb2396 · 2 updated · 2 unchanged',
    err: '',
  })
  const root = await json(master, ['show', 'atlas-1'])
  expect(root.thread).toMatchObject({ status: 'owner', summary: 'two price lists, the owner picks' })
  expect(root.entries.at(-1)).toMatchObject({ type: 'system', set: { summary: 'two price lists, the owner picks' } })
  const step = await json(master, ['show', 'atlas-4'])
  expect(step.thread).toMatchObject({ status: 'done', doneAt: Date.parse(iso('12:30')) })
  expect(step.entries.at(-1)).toMatchObject({ at: Date.parse(iso('12:30')), set: { status: 'done' } })
})

test('import again of a file that did not change keeps what was changed on the board', async () => {
  const { run, json, put } = setUp()
  const file = put(`claude/${DAY}.json`, taskFile(ITEMS))
  await run(master, ['import', file])
  // A worker finished one, the owner renamed another and gave it to someone, a summary moved.
  await run(mapper, ['done', 'atlas-4', 'checked on the board'])
  await run({ kind: 'owner' }, ['set', 'atlas-1', '--title', 'Order feed mapping', '--assignee', 'atlas-mapper'])
  await run(master, ['post', 'atlas-2', '--summary', 'half of it reconciled'])
  const rows = journalRows()
  assert.deepEqual(await run(master, ['import', file]), {
    code: 0,
    out: 'ok · claude/3dbb2396 · 4 unchanged',
    err: '',
  })
  expect(journalRows()).toBe(rows)
  expect((await json(master, ['show', 'atlas-4'])).thread).toMatchObject({
    status: 'done',
    summary: 'checked on the board',
  })
  expect((await json(master, ['show', 'atlas-1'])).thread).toMatchObject({
    title: 'Order feed mapping',
    assignee: mapper,
  })
  expect((await json(master, ['show', 'atlas-2'])).thread.summary).toBe('half of it reconciled')
  // The file changes one field of b1: that field, and only it, follows.
  put(
    `claude/${DAY}.json`,
    taskFile(ITEMS.map(i => (i.id === 'b1' ? { ...i, note: 'two lists', updated_at: iso('12:00') } : i))),
  )
  assert.deepEqual(await run(master, ['import', file]), {
    code: 0,
    out: 'ok · claude/3dbb2396 · 1 updated · 3 unchanged',
    err: '',
  })
  expect((await json(master, ['show', 'atlas-1'])).thread).toMatchObject({
    title: 'Order feed mapping',
    assignee: mapper,
    summary: 'two lists',
  })
})

test('a thread that waits on the owner and a file that says done: a proposed close, once', async () => {
  const { run, json, put } = setUp()
  const file = put(`claude/${DAY}.json`, taskFile(ITEMS))
  await run(master, ['import', file])
  await run(master, ['ask', 'atlas-1', 'which price list wins?'])
  put(
    `claude/${DAY}.json`,
    taskFile(ITEMS.map(i => (i.id === 'b1' ? { ...i, status: 'done', done_at: iso('12:30') } : i))),
  )
  expect((await run(master, ['import', file])).out).toBe('ok · claude/3dbb2396 · 1 updated · 3 unchanged')
  const asked = await json(master, ['show', 'atlas-1'])
  expect(asked.thread).toMatchObject({ status: 'owner', proposed: { by: master } })
  const rows = journalRows()
  for (let i = 0; i < 2; i++)
    expect((await run(master, ['import', file])).out).toBe('ok · claude/3dbb2396 · 4 unchanged')
  expect(journalRows()).toBe(rows)
})

test('import refuses what is not a task board, a newer version, a missing file; an item it cannot read is skipped', async () => {
  const { run, json, put } = setUp()
  expect(await json(master, ['import', put('x.json', { format: 'other', items: [] })])).toMatchObject({
    ok: false,
    error: 'format',
  })
  expect(await json(master, ['import', put('v2.json', taskFile([], { version: 2 }))])).toMatchObject({
    ok: false,
    error: 'format',
    message: expect.stringContaining('version 2'),
  })
  expect(await json(master, ['import', put('bad.json', '{ half')])).toMatchObject({ ok: false, error: 'format' })
  expect(await json(master, ['import', join(put('x.json', {}), '..', 'none.json')])).toMatchObject({
    ok: false,
    error: 'file',
  })
  expect(await json(master, ['import', '--todos'])).toMatchObject({ ok: false, error: 'later' })
  // The harness and session from the path when the file does not say them; bad items skipped.
  const file = put(
    `pi/${PI}.json`,
    taskFile(
      [
        ITEMS[0] as Record<string, unknown>,
        { id: 'b8', text: '', status: 'doing' },
        { id: 'b9', text: 'paused', status: 'paused' },
        { ...ITEMS[0], text: 'the same id again' },
      ],
      { harness: undefined, session_id: undefined },
    ),
  )
  assert.deepEqual(await run(master, ['import', file]), {
    code: 0,
    out: `ok · pi/${PI.slice(0, 8)} · 1 new · 3 skipped`,
    err: '',
  })
  expect((await json(master, ['show', 'atlas-1'])).thread.origin).toMatchObject({
    agentBoard: { harness: 'pi', session: PI, id: 'b1' },
  })
  // With threads off nothing is read or written.
  const off = setUp({})
  const r = await off.run(master, ['import', off.put(`claude/${DAY}.json`, taskFile(ITEMS))])
  expect(r).toEqual({ code: 1, out: '', err: 'threads are off' })
  expect(existsSync(join(stateDir(), 'board.db'))).toBe(false)
})

// ------------------------------------------------------------------ the mirror of a pi day

function mirrorSetUp(cfg: Record<string, unknown> = { threads: true }, o: { here?: boolean } = {}) {
  const t = setUp({ threads: cfg.threads })
  const calls: string[] = []
  const logs: string[] = []
  let clock = NOW
  let today: { session: string; cwd: string; name: string } | null = {
    session: PI,
    cwd: join(t.dir, 'atlas', 'work'),
    name: 'day',
  }
  const mirror = piDayMirror({
    cfg: { categories: [{ id: 'atlas', title: 'Atlas', paths: [join(t.dir, 'atlas')] }], ...cfg } as never,
    log: line => logs.push(line),
    here: () => {
      calls.push('here')
      return o.here ?? true
    },
    day: () => {
      calls.push('day')
      return today
    },
    folder: () => {
      calls.push('folder')
      return join(t.dir, 'boards')
    },
    sessionOf: k => byKey[k] ?? null,
    now: () => clock,
  })
  const write = (items: Record<string, unknown>[], at: number): void => {
    const file = t.put(`pi/${PI}.json`, taskFile(items, { harness: 'pi', session_id: PI, writer: 'pi-task-board' }))
    utimesSync(file, at / 1000, at / 1000)
  }
  const tick = (at: number) => {
    clock = at
    return mirror.tick()
  }
  const dayOver = (): void => {
    today = null
  }
  return { ...t, mirror, calls, logs, write, tick, dayOver }
}

test("the pi day's task board is copied into threads marked mirrored; a change follows, an edit on the board is refused", async () => {
  const { dir, json, run, write, tick } = mirrorSetUp()
  write(ITEMS, NOW)
  const first = tick(NOW)
  expect(first).toMatchObject({ created: ['atlas-1', 'atlas-2', 'atlas-3', 'atlas-4'] })
  const head = (await json(master, ['show', 'atlas-1'])).thread
  expect(head).toMatchObject({
    lane: 'atlas',
    status: 'doing',
    createdBy: { kind: 'session', key: PI, name: 'day' },
    origin: { agentBoard: { harness: 'pi', session: PI, id: 'b1' }, mirrored: true },
  })
  // The file did not change: not read again.
  expect(tick(NOW + 2000)).toBeNull()

  // An edit on the board is refused with the reason, an agent's and the owner's; only the owner's
  // close goes through.
  for (const [actor, args] of [
    [master, ['post', 'atlas-1', '--status', 'done']],
    [master, ['post', 'atlas-1', 'a note']],
    [{ kind: 'owner' }, ['post', 'atlas-1', '--status', 'next']],
    [{ kind: 'owner' }, ['set', 'atlas-1', '--title', 'Mine now']],
  ] as [Party, string[]][]) {
    const r = await json(actor, args)
    expect(r).toMatchObject({ ok: false, error: 'mirrored', message: expect.stringContaining("pi's task board") })
  }
  expect(await json(master, ['new', '--parent', 'atlas-1', 'A step of my own'])).toMatchObject({
    ok: false,
    error: 'mirrored',
  })
  // A plain import of pi's file does not change pi's copy either.
  expect((await run(master, ['import', join(dir, 'boards', 'pi', `${PI}.json`)])).out).toContain('4 skipped')

  // pi changes the file: the copy follows on the next refresh; an item gone from the file is dropped.
  write(
    ITEMS.filter(i => i.id !== 'b3').map(i =>
      i.id === 'b1' ? { ...i, status: 'done', done_at: iso('13:40'), updated_at: iso('13:40') } : i,
    ),
    NOW + 5000,
  )
  const next = tick(NOW + 6000)
  expect(next).toMatchObject({ updated: ['atlas-1'], dropped: ['atlas-2'], unchanged: 2 })
  expect((await json(master, ['show', 'atlas-1'])).thread).toMatchObject({ status: 'done' })
  expect((await json(master, ['show', 'atlas-2'])).thread).toMatchObject({ status: 'dropped' })
  expect((await run(master, ['show', 'atlas-2'])).out).toContain('gone from the task board')
})

test("the owner closes a mirrored thread; once pi's day is over its threads are the board's own", async () => {
  const { json, write, tick, dayOver } = mirrorSetUp()
  write(ITEMS, NOW)
  tick(NOW)
  expect(
    await json({ kind: 'owner' }, ['post', 'atlas-2', '--status', 'dropped', '--summary', 'not needed']),
  ).toMatchObject({
    ok: true,
    thread: { status: 'dropped' },
  })
  // pi's next write does not bring it back while the item did not change there.
  write(
    ITEMS.map(i => (i.id === 'b1' ? { ...i, note: 'moving' } : i)),
    NOW + 3000,
  )
  expect(tick(NOW + 4000)).toMatchObject({ updated: ['atlas-1'], unchanged: 3 })
  expect((await json(master, ['show', 'atlas-2'])).thread.status).toBe('dropped')
  // The day is over: the mark goes, agents write to them as to any thread.
  dayOver()
  expect(tick(NOW + 6000)).toBeNull()
  expect((await json(master, ['show', 'atlas-1'])).thread.origin).toEqual({
    agentBoard: expect.objectContaining({ harness: 'pi', session: PI, id: 'b1' }),
  })
  expect(await json(master, ['done', 'atlas-1', 'finished after the day'])).toMatchObject({
    ok: true,
    thread: { status: 'done' },
  })
})

test('a file the mirror cannot read is said once and tried again when it changes; without MokuPilot nothing is read', async () => {
  const { logs, put, write, tick } = mirrorSetUp()
  put(`pi/${PI}.json`, '{ "format": "agent-board", "items": [')
  expect(tick(NOW)).toBeNull()
  expect(tick(NOW + 2000)).toBeNull()
  expect(logs).toHaveLength(1)
  expect(logs[0]).toContain("pi's task board")
  write(ITEMS, NOW + 5000)
  expect(tick(NOW + 6000)).toMatchObject({ created: ['atlas-1', 'atlas-2', 'atlas-3', 'atlas-4'] })

  const away = mirrorSetUp({ threads: true }, { here: false })
  away.write(ITEMS, NOW)
  expect(away.tick(NOW)).toBeNull()
  expect(away.calls).toEqual(['here'])
  // Asked again only after a minute.
  expect(away.tick(NOW + 30_000)).toBeNull()
  expect(away.calls).toEqual(['here'])
})

test('the mirror reads nothing while threads are off, with "mokupilot": false, or with agents off', async () => {
  for (const cfg of [{}, { threads: false }, { threads: true, mokupilot: false }, { threads: { agents: false } }]) {
    const { calls, write, tick } = mirrorSetUp(cfg)
    write(ITEMS, NOW)
    expect([cfg, tick(NOW)]).toEqual([cfg, null])
    // Not a look at MokuPilot's folder, the day or the task boards.
    expect([cfg, calls]).toEqual([cfg, []])
    expect([cfg, existsSync(join(stateDir(), 'board.db'))]).toEqual([cfg, false])
  }
})
