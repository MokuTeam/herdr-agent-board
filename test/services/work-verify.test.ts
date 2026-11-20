// Verified done (#492, services/work-verify.ts, core/work-verify.ts) in this process: `board thread`
// as the sessions run it, the board's verifier side over a host that records what it would start and
// archive, the schedule and the database in a temp state folder. The start against the fake herdr is
// test/server/verify.test.ts.
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BoardDb, openDb } from '../../src/adapters/db.ts'
import { listEntries, removeEntry, updateEntry } from '../../src/adapters/schedule-store.ts'
import { getThread, setScope, threadByKey } from '../../src/adapters/work-thread-store.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import type { Item } from '../../src/core/types.ts'
import type { Party, ThreadHead } from '../../src/core/work-threads.ts'
import { type ThreadCmdContext, threadCmd } from '../../src/entrypoints/thread-cli.ts'
import {
  commandLauncher,
  herdrLauncher,
  type LaunchContext,
  spawnAgentLauncher,
} from '../../src/services/launch/launcher.ts'
import type { LaunchState, StartOptions } from '../../src/services/launch/launches.ts'
import { outgoing } from '../../src/services/work-share.ts'
import { createVerifier, type VerifyHost } from '../../src/services/work-verify.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-12T14:00:00Z')
const master: Party = { kind: 'session', key: '11111111-1111-4111-8111-111111111111', name: 'master' }
const ben: Party = { kind: 'session', key: '22222222-2222-4222-8222-222222222222', name: 'ben' }
const cleo: Party = { kind: 'session', key: '33333333-3333-4333-8333-333333333333', name: 'cleo' }
const owner: Party = { kind: 'owner' }
const sessions: Record<string, Party> = { master, ben, cleo }
const VERIFY = { agents: true, verify: { model: 'opus', lanes: ['vlane'] } }

function setUp(threads: unknown = VERIFY) {
  const dir = isolatedHome()
  let now = NOW
  const run = async (actor: Party, args: string[], over: Partial<ThreadCmdContext> = {}) => {
    const out: string[] = []
    const err: string[] = []
    const code = await threadCmd(args, {
      cfg: { threads, port: 12422 },
      actor,
      lane: 'atlas',
      findSession: async w => sessions[w] ?? null,
      self: async () => (actor.kind === 'session' ? actor.key : null),
      out: l => out.push(l),
      err: l => err.push(l),
      now,
      ...over,
    })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  const json = async (actor: Party, args: string[], over: Partial<ThreadCmdContext> = {}) =>
    JSON.parse((await run(actor, [...args, '--json'], over)).out)
  const head = (key: string): ThreadHead => {
    const db = openDb() as BoardDb
    try {
      return threadByKey(db, key) as ThreadHead
    } finally {
      db.close()
    }
  }
  // The worker's folder and its card on the board.
  const folder = join(dir, 'work')
  mkdirSync(folder, { recursive: true })
  const items: Item[] = [
    {
      key: ben.kind === 'session' ? ben.key : '',
      name: 'ben',
      cwd: folder,
      category: 'atlas',
      agent: 'claude',
      session: (ben as { key: string }).key,
      pane: 'wP:p2',
    } as Item,
  ]
  const started: { body: Record<string, unknown>; options: StartOptions }[] = []
  const archived: string[] = []
  const launches = new Map<string, LaunchState>()
  let startResult: { ok: true; id: string } | { ok: false; field: string; error: string } | null = null
  let busy = false
  const host: VerifyHost = {
    cfg: { threads, categories: [{ id: 'atlas', title: 'Atlas', color: 'blue' }] } as unknown as VerifyHost['cfg'],
    log: () => {},
    start: async (body, _items, options) => {
      started.push({ body: body as Record<string, unknown>, options })
      const r = startResult ?? { ok: true as const, id: `l${started.length}` }
      if (r.ok) launches.set(r.id, { state: 'starting', error: '', sessionId: options.sessionId ?? null })
      return r
    },
    launchState: id => launches.get(id) ?? null,
    workspaces: async () => [{ id: 'wP', label: 'Atlas' }],
    archive: async item => {
      if (busy) return 'busy'
      archived.push(item.key)
      return 'ok'
    },
    withDb: fn => {
      const db = openDb()
      const out = fn(db)
      if (out instanceof Promise) return out.finally(() => db?.close()) as typeof out
      db?.close()
      return out
    },
    now: () => now,
  }
  const verifier = () => createVerifier(host)
  return {
    dir,
    folder,
    items,
    run,
    json,
    head,
    host,
    verifier,
    started,
    archived,
    launches,
    setStart: (r: typeof startResult) => {
      startResult = r
    },
    setBusy: (b: boolean) => {
      busy = b
    },
    at: (t: number) => {
      now = t
    },
  }
}

const events = (p: Party): ScheduleEntry[] =>
  listEntries().filter(e => e.key === (p as { key: string }).key && e.by === 'threads' && e.kind !== 'verify')
const deliver = (p: Party): void => {
  for (const e of events(p)) removeEntry(e.id)
}
const limits = (): ScheduleEntry[] => listEntries().filter(e => e.kind === 'verify')
const verifierOf = (h: ThreadHead): Party => ({
  kind: 'session',
  key: h.verify?.run?.key ?? '',
  name: h.verify?.run?.name ?? '',
})

/** atlas-1 with verify on and two acceptance lines, given to ben by the master. */
async function verifyThread(s: ReturnType<typeof setUp>) {
  const r = await s.run(master, [
    'new',
    '--to',
    'ben',
    '--verify',
    '--accept',
    'the report lists every row',
    '--accept',
    'nothing else changed',
    'Map the price columns',
  ])
  assert.equal(r.out, 'ok · atlas-1 · doing · ben')
  return r
}

test('a done is held on a verify thread and not on another; the owner’s is not; a thread waiting on the owner keeps its proposal', async () => {
  const s = setUp()
  await verifyThread(s)
  await s.run(master, ['new', '--to', 'ben', 'Plain one'])
  deliver(master)
  deliver(ben)
  assert.equal(
    (await s.run(ben, ['done', 'atlas-1', 'all rows mapped'])).out,
    'ok · atlas-1 · doing · done held: a verifier checks it',
  )
  const h = s.head('atlas-1')
  expect(h.proposed).toMatchObject({ by: ben, why: 'all rows mapped', verify: true })
  assert.equal(h.status, 'doing')
  assert.equal(h.summary, '')
  expect(h.verify).toMatchObject({
    on: true,
    accept: ['the report lists every row', 'nothing else changed'],
    run: null,
  })
  // The master, who watches its status, hears nothing yet: no "done" before the verdict.
  assert.deepEqual(events(master), [])
  // The plain thread is done at once, as on main.
  assert.equal((await s.run(ben, ['done', 'atlas-2', 'done plainly'])).out, 'ok · atlas-2 · done')
  assert.equal(s.head('atlas-2').verify, undefined)
  // The owner's own done is never held.
  await s.run(master, ['new', '--verify', 'Owner closes'])
  assert.equal((await s.run(owner, ['done', 'atlas-3', 'closed by the owner'])).out, 'ok · atlas-3 · done')
  // A verify thread that waits on the owner: today's proposal to the owner, no verifier.
  await s.run(master, ['new', '--to', 'ben', '--verify', 'Asks first'])
  await s.run(ben, ['ask', 'atlas-4', 'which file?'])
  assert.equal(
    (await s.run(ben, ['done', 'atlas-4', 'did it'])).out,
    'ok · atlas-4 · owner · proposed done, the owner confirms',
  )
  assert.equal(s.head('atlas-4').proposed?.verify, undefined)
})

test('show and list say a done is held and what verifies it', async () => {
  const s = setUp()
  await verifyThread(s)
  await s.run(ben, ['done', 'atlas-1', 'all rows mapped'])
  const shown = (await s.run(master, ['show', 'atlas-1'])).out.split('\n')
  assert.equal(shown[0], 'atlas-1 · doing, done proposed (verifying) · ben · Map the price columns')
  assert.match(shown[1] as string, /done proposed by ben, waiting for a verifier: all rows mapped/)
  assert.equal(shown[2], 'verify on · 2 acceptance lines')
  assert.equal(shown[3], 'accept: the report lists every row')
  assert.equal(shown[4], 'accept: nothing else changed')
  assert.match((await s.run(master, ['list'])).out, /^atlas-1 · doing, done proposed \(verifying\) · ben/)
})

test('threads.verify absent: --verify, --accept and verdict are refused, a done is a done, heads carry no verify field', async () => {
  const s = setUp(true)
  assert.deepEqual(await s.json(master, ['new', '--verify', 'X']), {
    ok: false,
    error: 'verify_off',
    message: 'verification is off on this board (threads.verify in config.json)',
  })
  await s.run(master, ['new', '--to', 'ben', 'Map it'])
  assert.equal((await s.json(ben, ['post', 'atlas-1', '--accept', 'y'])).error, 'verify_off')
  assert.equal((await s.json(ben, ['set', 'atlas-1', '--verify', 'on'])).error, 'verify_off')
  assert.equal((await s.json(ben, ['verdict', 'atlas-1', 'pass', 'ok'])).error, 'verify_off')
  assert.equal((await s.run(ben, ['done', 'atlas-1', 'mapped'])).out, 'ok · atlas-1 · done')
  const j = await s.json(master, ['show', 'atlas-1'])
  assert.equal('verify' in j.thread, false)
  assert.equal(
    (await s.json(master, ['list', '--done'])).threads.some((t: object) => 'verify' in t),
    false,
  )
  // The sweep reads nothing and starts nothing.
  await s.verifier().sweep(async () => s.items)
  assert.deepEqual(s.started, [])
})

test('the board starts one verifier for a held done, with the brief, model, folder and a session id it chose', async () => {
  const s = setUp()
  await verifyThread(s)
  await s.run(ben, ['done', 'atlas-1', 'all rows mapped'])
  const v = s.verifier()
  await v.sweep(async () => s.items)
  assert.equal(s.started.length, 1)
  const { body, options } = s.started[0] as (typeof s.started)[number]
  const h = s.head('atlas-1')
  const run = h.verify?.run
  assert.ok(run)
  assert.equal(options.sessionId, run.key)
  expect(options.parent).toMatchObject({ key: (ben as { key: string }).key })
  expect(body).toMatchObject({
    name: 'verify-atlas-1',
    cwd: s.folder,
    category: 'atlas',
    model: 'opus',
    workspace: { id: 'wP', label: 'Atlas' },
  })
  const brief = String(body.message)
  assert.match(brief, /^\[board verify\] You are the verifier of thread atlas-1/)
  assert.match(brief, /you change nothing/)
  assert.match(brief, /board thread verdict atlas-1 pass --file <report.md>/)
  assert.match(brief, /board thread verdict atlas-1 unsure/)
  assert.match(brief, /Thread atlas-1: Map the price columns/)
  assert.match(brief, /- the report lists every row\n- nothing else changed/)
  assert.match(brief, /The done it proposed \(#\d+, [^)]+\): all rows mapped/)
  // The default checklist, general: evidence looked at, never the worker's word.
  assert.match(brief, /Checklist:\n# Verifying a done/)
  assert.ok(brief.length <= 12_000)
  assert.equal(run.until, NOW + 30 * 60_000)
  assert.deepEqual(
    limits().map(e => ({ key: e.key, next: e.next, thread: e.thread })),
    [{ key: run.key, next: run.until, thread: h.id }],
  )
  // Once: the next tick starts none, nor does a second done held on the same thread.
  await v.sweep(async () => s.items)
  await s.run(ben, ['done', 'atlas-1', 'all rows mapped, again'])
  await v.sweep(async () => s.items)
  assert.equal(s.started.length, 1)
  assert.match(
    (await s.run(master, ['show', 'atlas-1'])).out,
    /verification running \(verify-atlas-1 until \d\d:\d\d\)/,
  )
})

test('two verifiers at once: a third held done waits, and starts when one is done', async () => {
  const s = setUp()
  for (const n of [1, 2, 3]) {
    await s.run(master, ['new', '--to', 'ben', '--verify', `Task ${n}`])
    await s.run(ben, ['done', `atlas-${n}`, `task ${n} done`])
  }
  const v = s.verifier()
  await v.sweep(async () => s.items)
  assert.deepEqual(
    s.started.map(x => x.body.name),
    ['verify-atlas-1', 'verify-atlas-2'],
  )
  assert.equal(s.head('atlas-3').verify?.run, null)
  assert.match((await s.run(master, ['show', 'atlas-3'])).out, /waiting for a verifier \(2 running\)/)
  const first = verifierOf(s.head('atlas-1'))
  await s.run(first, ['verdict', 'atlas-1', 'fail', 'rows missing'])
  await v.sweep(async () => s.items)
  assert.deepEqual(
    s.started.map(x => x.body.name),
    ['verify-atlas-1', 'verify-atlas-2', 'verify-atlas-3'],
  )
})

test('only the verifier gives the verdict, from its own session; a pass needs its report', async () => {
  const s = setUp()
  await verifyThread(s)
  await s.run(ben, ['done', 'atlas-1', 'all rows mapped'])
  await s.verifier().sweep(async () => s.items)
  const vf = verifierOf(s.head('atlas-1'))
  for (const who of [ben, master, owner]) {
    const r = await s.json(who, ['verdict', 'atlas-1', 'pass', '--file', join(s.dir, 'x'), 'ok'])
    assert.equal(r.error, 'not_verifier', JSON.stringify(r))
  }
  // As --session names it, from another session: refused.
  assert.equal(
    (await s.json(vf, ['verdict', 'atlas-1', 'fail', 'no'], { self: async () => (ben as { key: string }).key })).error,
    'not_verifier',
  )
  assert.equal((await s.json(vf, ['verdict', 'atlas-1', 'pass', 'looks fine'])).error, 'report')
  // The verifier changes nothing but its verdict.
  assert.equal((await s.json(vf, ['post', 'atlas-1', 'a note'])).error, 'verifier')
  assert.equal(s.head('atlas-1').proposed?.verify, true)
})

test('pass: done (verified), the master hears it, the verifier is archived once it is free', async () => {
  const s = setUp()
  await verifyThread(s)
  await s.run(ben, ['done', 'atlas-1', 'all rows mapped'])
  const v = s.verifier()
  await v.sweep(async () => s.items)
  const vf = verifierOf(s.head('atlas-1'))
  deliver(master)
  const report = join(s.dir, 'report.md')
  writeFileSync(report, '- the report lists every row: read report rows 1-217\n')
  const r = await s.run(vf, ['verdict', 'atlas-1', 'pass', '--file', report, 'both lines checked'])
  assert.equal(r.out, 'ok · atlas-1 · done · verdict pass')
  const h = s.head('atlas-1')
  assert.equal(h.status, 'done')
  assert.equal(h.summary, 'all rows mapped')
  expect(h.verify).toMatchObject({ run: null, last: 'pass', fails: 0 })
  assert.equal(events(master)[0]?.text, 'atlas-1 done (verified): all rows mapped. More: board thread changes')
  // Its limit is due now: the archive, once the verifier is free.
  const [limit] = limits()
  assert.ok(limit && limit.next <= NOW)
  const verifierItem = {
    key: vf.kind === 'session' ? vf.key : '',
    name: 'verify-atlas-1',
    session: (vf as { key: string }).key,
    agent: 'claude',
    pane: 'wP:p9',
  } as Item
  s.setBusy(true)
  await v.due(limit, [verifierItem])
  assert.deepEqual(s.archived, [])
  assert.ok((limits()[0]?.next ?? 0) > NOW)
  s.setBusy(false)
  s.at(NOW + 61_000)
  await v.due(limits()[0] as ScheduleEntry, [verifierItem])
  assert.deepEqual(s.archived, [(vf as { key: string }).key])
  assert.deepEqual(limits(), [])
})

test('fail: back to the worker, who hears it in one line; the second fail in a row goes to the owner', async () => {
  const s = setUp()
  await verifyThread(s)
  deliver(ben)
  await s.run(ben, ['done', 'atlas-1', 'all rows mapped'])
  const v = s.verifier()
  await v.sweep(async () => s.items)
  deliver(master)
  const vf = verifierOf(s.head('atlas-1'))
  assert.equal(
    (await s.run(vf, ['verdict', 'atlas-1', 'fail', 'rows 3-9 missing'])).out,
    'ok · atlas-1 · doing · verdict fail',
  )
  expect(s.head('atlas-1')).toMatchObject({
    status: 'doing',
    proposed: null,
    verify: { fails: 1, last: 'fail', run: null },
  })
  assert.equal(
    events(ben)[0]?.text,
    'atlas-1 verification failed: rows 3-9 missing. Reasons: board thread show atlas-1. More: board thread changes',
  )
  // The master hears nothing of it: it is the worker's.
  assert.deepEqual(events(master), [])
  deliver(ben)
  await s.run(ben, ['done', 'atlas-1', 'now all rows'])
  await v.sweep(async () => s.items)
  const vf2 = verifierOf(s.head('atlas-1'))
  assert.notEqual((vf2 as { key: string }).key, (vf as { key: string }).key)
  await s.run(vf2, ['verdict', 'atlas-1', 'fail', 'row 4 still missing'])
  const h = s.head('atlas-1')
  expect(h).toMatchObject({ status: 'owner', waitingOn: 'verification failed twice: row 4 still missing' })
  expect(h.verify).toMatchObject({ fails: 0, last: 'fail' })
  assert.equal(
    events(master)[0]?.text,
    'atlas-1 needs the owner: verification failed twice: row 4 still missing. More: board thread changes',
  )
})

test('unsure goes to the owner with its line and is no fail', async () => {
  const s = setUp()
  await verifyThread(s)
  await s.run(ben, ['done', 'atlas-1', 'all rows mapped'])
  await s.verifier().sweep(async () => s.items)
  const vf = verifierOf(s.head('atlas-1'))
  await s.run(vf, ['verdict', 'atlas-1', 'unsure', 'no access to the order system'])
  expect(s.head('atlas-1')).toMatchObject({
    status: 'owner',
    waitingOn: 'the verifier could not check: no access to the order system',
    verify: { fails: 0, last: 'unsure' },
  })
})

test('the time limit: no verdict in time sends the thread to the owner, and the verifier is archived', async () => {
  const s = setUp()
  await verifyThread(s)
  await s.run(ben, ['done', 'atlas-1', 'all rows mapped'])
  const v = s.verifier()
  await v.sweep(async () => s.items)
  const vf = verifierOf(s.head('atlas-1'))
  const [limit] = limits()
  assert.ok(limit)
  // Not yet: due early, it waits for its time.
  await v.due({ ...limit, next: NOW }, [])
  assert.equal(s.head('atlas-1').verify?.run?.key, (vf as { key: string }).key)
  s.at(NOW + 31 * 60_000)
  const verifierItem = {
    key: (vf as { key: string }).key,
    name: 'verify-atlas-1',
    session: (vf as { key: string }).key,
    agent: 'claude',
    pane: 'wP:p9',
  } as Item
  await v.due(limits()[0] as ScheduleEntry, [verifierItem])
  expect(s.head('atlas-1')).toMatchObject({
    status: 'owner',
    waitingOn: 'no verdict within 30 min',
    verify: { last: 'timeout', run: null },
  })
  assert.deepEqual(s.archived, [(vf as { key: string }).key])
  // Its word no longer counts.
  assert.equal((await s.json(vf, ['verdict', 'atlas-1', 'fail', 'late'])).error, 'no_verify')
})

test('a launch refused or failed sends the thread to the owner with the reason', async () => {
  const s = setUp()
  await verifyThread(s)
  await s.run(ben, ['done', 'atlas-1', 'all rows mapped'])
  s.setStart({ ok: false, field: 'launcher', error: 'cannot start a verifier' })
  const v = s.verifier()
  await v.sweep(async () => s.items)
  expect(s.head('atlas-1')).toMatchObject({
    status: 'owner',
    waitingOn: 'no verifier: cannot start a verifier',
    verify: { last: 'error', run: null },
  })
  assert.deepEqual(limits(), [])
  // Started, then failed: the next tick sees it.
  await s.run(master, ['new', '--to', 'ben', '--verify', 'Second'])
  await s.run(ben, ['done', 'atlas-2', 'done'])
  s.setStart(null)
  await v.sweep(async () => s.items)
  const id = [...s.launches.keys()].at(-1) as string
  s.launches.set(id, { state: 'failed', error: 'claude did not come up', sessionId: null })
  await v.sweep(async () => s.items)
  expect(s.head('atlas-2')).toMatchObject({ status: 'owner', waitingOn: 'no verifier: claude did not come up' })
})

test('a board that restarts keeps what it was doing: a running verifier keeps its limit, a held done gets its verifier', async () => {
  const s = setUp()
  await verifyThread(s)
  await s.run(master, ['new', '--to', 'ben', '--verify', 'Second'])
  await s.run(ben, ['done', 'atlas-1', 'all rows mapped'])
  // The first board starts it, and its limit file goes missing with it.
  await s.verifier().sweep(async () => s.items)
  for (const e of limits()) removeEntry(e.id)
  await s.run(ben, ['done', 'atlas-2', 'second done'])
  // A new board process: nothing in memory.
  const again = s.verifier()
  await again.sweep(async () => s.items)
  const run1 = s.head('atlas-1').verify?.run
  assert.ok(run1)
  assert.equal(s.started.length, 2)
  assert.deepEqual(
    limits()
      .map(e => e.key)
      .sort(),
    [run1.key, s.head('atlas-2').verify?.run?.key].sort(),
  )
  // The verdict reaches the thread after the restart all the same.
  const report = join(s.dir, 'r.md')
  writeFileSync(report, 'ok')
  assert.equal(
    (await s.run(verifierOf(s.head('atlas-1')), ['verdict', 'atlas-1', 'pass', '--file', report, 'fine'])).out,
    'ok · atlas-1 · done · verdict pass',
  )
})

test('the gate is not lifted by the session it gates; a lane’s verification only by the owner', async () => {
  const s = setUp()
  await verifyThread(s)
  assert.equal((await s.json(ben, ['set', 'atlas-1', '--verify', 'off'])).error, 'owner_only')
  await s.run(master, ['new', '--verify', 'Unassigned'])
  await s.run(cleo, ['done', 'atlas-2', 'did it'])
  assert.equal((await s.json(cleo, ['set', 'atlas-2', '--verify', 'off'])).error, 'owner_only')
  // Another session may turn it off; the owner too.
  assert.equal((await s.run(master, ['set', 'atlas-1', '--verify', 'off'])).out, 'ok · atlas-1 · doing · ben')
  // A lane in verify.lanes: on from the start, and only the owner turns it off.
  await s.run(master, ['new', '--lane', 'vlane', 'In a verified lane'])
  expect(s.head('vlane-1').verify).toMatchObject({ on: true, lane: true })
  assert.equal((await s.json(master, ['set', 'vlane-1', '--verify', 'off'])).error, 'owner_only')
  assert.equal((await s.run(owner, ['set', 'vlane-1', '--verify', 'off'])).code, 0)
  assert.equal(s.head('vlane-1').verify?.on, false)
})

test('the owner may confirm a held done or keep it open, which sends it back to its worker', async () => {
  const s = setUp()
  await verifyThread(s)
  await s.run(ben, ['done', 'atlas-1', 'all rows mapped'])
  await s.verifier().sweep(async () => s.items)
  const { keepOpen, confirmClose } = await import('../../src/services/work-threads.ts')
  const db = openDb() as BoardDb
  try {
    const ctx = { db, cfg: { agents: true, gapSec: 60, share: true, verify: null }, actor: owner, now: NOW }
    const kept = keepOpen(ctx, getThread(db, s.head('atlas-1').id) as ThreadHead)
    expect(kept.head).toMatchObject({ status: 'doing', proposed: null, verify: { run: null } })
    await s.run(ben, ['done', 'atlas-1', 'again'])
    const done = confirmClose(ctx, getThread(db, s.head('atlas-1').id) as ThreadHead)
    expect(done.head).toMatchObject({ status: 'done', summary: 'again' })
  } finally {
    db.close()
  }
})

test('a shared thread: a held done goes out without its status, a fail stays here, a pass goes as a plain done', async () => {
  const s = setUp()
  await verifyThread(s)
  const db = openDb() as BoardDb
  try {
    const id = s.head('atlas-1').id
    db.write('test', tx =>
      setScope(tx, id, { kind: 'peer', peer: 'peer-ben', topic: `peer-ben/${id}`, key: 'atlas-1', by: 'me', at: NOW }),
    )
  } finally {
    db.close()
  }
  const held = await s.json(ben, ['done', 'atlas-1', 'all rows mapped'])
  const look = (entry: string) => {
    const d = openDb() as BoardDb
    try {
      const h = getThread(d, s.head('atlas-1').id) as ThreadHead
      const e = d.db.query('SELECT id FROM thread_entries WHERE id = ?').get(entry) as { id: string } | null
      assert.ok(e)
      const { entriesOf } = require('../../src/adapters/work-thread-store.ts')
      const entryRow = (entriesOf(d, h.id) as { id: string }[]).find(x => x.id === entry)
      return outgoing(d, h, entryRow as never, 'me-peer', r => r)
    } finally {
      d.close()
    }
  }
  const out = look(held.entry.id)
  assert.ok(out)
  assert.equal(out.work.set?.status, undefined)
  assert.equal(out.work.set?.summary, undefined)
  await s.verifier().sweep(async () => s.items)
  const vf = verifierOf(s.head('atlas-1'))
  const failed = await s.json(vf, ['verdict', 'atlas-1', 'fail', 'rows missing'])
  assert.equal(failed.entry.private, true)
  assert.equal(look(failed.entry.id), null)
  await s.run(ben, ['done', 'atlas-1', 'all rows now'])
  await s.verifier().sweep(async () => s.items)
  const report = join(s.dir, 'r.md')
  writeFileSync(report, 'ok')
  const passed = await s.json(verifierOf(s.head('atlas-1')), ['verdict', 'atlas-1', 'pass', '--file', report, 'fine'])
  const p = look(passed.entry.id)
  expect(p?.work.set).toMatchObject({ status: 'done', summary: 'all rows now' })
})

test('a launcher that cannot start Claude under the board’s session id refuses a verifier before it opens anything', async () => {
  const l = {
    id: 'l1',
    name: 'verify-atlas-1',
    label: 'verify-atlas-1',
    cwd: '.',
    workspaceId: 'wP',
    workspaceLabel: 'Atlas',
    category: 'atlas',
    message: '',
    profile: 'default',
    profileDir: '',
    configDir: null,
    profileArgs: [],
    profileCommand: null,
    agent: 'claude',
    model: null,
    rootPane: null,
    rootTab: null,
    sessionId: null,
    resume: null,
    fork: null,
    pane: null,
    sessionGiven: '44444444-4444-4444-8444-444444444444',
    exactSession: true,
  } as LaunchContext
  const on = { step: () => {}, pane: () => {}, session: () => {} }
  const refused = /cannot start a verifier/
  await expect(commandLauncher({ command: ['pwsh', '-File', 'start.ps1', '{name}'] }).start(l, on)).rejects.toThrow(
    refused,
  )
  await expect(herdrLauncher({ agent: 'codex' }).start(l, on)).rejects.toThrow(refused)
  await expect(herdrLauncher({ agent: 'claude', args: ['--continue'] }).start(l, on)).rejects.toThrow(refused)
  await expect(spawnAgentLauncher({ claude: ['claude', '--continue'] }).start(l, on)).rejects.toThrow(refused)
})
