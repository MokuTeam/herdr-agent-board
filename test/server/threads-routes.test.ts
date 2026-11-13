// Threads over HTTP (#392, docs/design/threads 5.3): the page's reads, the owner's writes, the
// owner's answer typed into the session that asked (6.6), a proposed close confirmed or kept open
// (3.5), the revision's own stream, a thread opened on the pages (8), and who reaches the routes
// from outside. With threads off every route answers 409 and no database is made.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir, uploadsDir } from '../../src/adapters/paths.ts'
import type { Party, ThreadRow, ThreadView } from '../../src/core/work-threads.ts'
import { threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { dispatch, type Route } from '../../src/server/http.ts'
import { revealRoute, revealState } from '../../src/server/routes/reveal.ts'
import {
  revStream,
  type ThreadsApp,
  threadOpenState,
  threadReveal,
  threadsRoutes,
} from '../../src/server/routes/threads.ts'
import { remoteRefusal } from '../../src/server/streams.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-12T14:00:00Z')
const master: Party = { kind: 'session', key: '11111111-1111-4111-8111-111111111111', name: 'master' }
const mapper: Party = { kind: 'session', key: 'pane-wP:p2', name: 'atlas-mapper' }
const sessions: Record<string, Party> = { master, 'atlas-mapper': mapper }
const STATE = { port: 12422, token: '', stale: () => false }

function setUp(threads: unknown = true) {
  isolatedHome()
  const told: { session: string; text: string }[] = []
  const cleared: { key: string; question: string }[] = []
  let tells: { ok: true } | { ok: false; error: string } = { ok: true }
  let changed = 0
  const app: ThreadsApp = {
    cfg: { threads },
    changed: () => void changed++,
    async tell(session, text) {
      told.push({ session, text })
      return tells
    },
    clearAsk: (key, question) => void cleared.push({ key, question }),
    now: () => NOW,
  }
  const revs = revStream()
  const routes: Route[] = threadsRoutes(app, revs)
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const url = new URL(`http://127.0.0.1:12422${path}`)
    const req = new Request(url, {
      method,
      headers: { 'content-type': 'application/json', ...(method === 'POST' && { 'x-board': '1' }), ...headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    const res = await dispatch(routes, req, url, decodeURIComponent(url.pathname), STATE)
    return {
      status: res.status,
      body: (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : res,
    }
  }
  const cli = async (actor: Party, args: string[]) => {
    const out: string[] = []
    const code = await threadCmd(args, {
      cfg: { threads, port: 12422 },
      actor,
      lane: 'atlas',
      findSession: async w => sessions[w] ?? null,
      out: l => out.push(l),
      err: l => out.push(l),
      now: NOW,
    })
    assert.equal(code, 0, out.join('\n'))
    return out.join('\n')
  }
  const failTells = (error: string) => {
    tells = { ok: false, error }
  }
  return { app, revs, call, cli, told, cleared, failTells, changed: () => changed }
}

test('threads off: every route answers 409, reads nothing and makes no database', async () => {
  const { call, app } = setUp(false)
  for (const [method, path] of [
    ['GET', '/api/threads'],
    ['GET', '/api/threads/atlas-1'],
    ['GET', '/api/threads/events'],
    ['POST', '/api/threads'],
    ['POST', '/api/threads/atlas-1'],
  ] as const) {
    const r = await call(method, path, method === 'POST' ? { op: 'new', lane: 'atlas', title: 'x' } : undefined)
    assert.equal(r.status, 409, `${method} ${path}`)
    assert.equal((r.body as { error: string }).error, 'Threads are off (config.json: "threads")')
  }
  const reveal = threadReveal(
    app,
    { event: () => assert.fail('no event'), size: () => 0 },
    threadOpenState(),
    'atlas-1',
  )
  assert.equal(reveal.status, 409)
  assert.equal(existsSync(join(stateDir(), 'board.db')), false)
})

test("the list: heads only, with each parent's key and its sub-threads counted; lane, status, mine and since narrow it", async () => {
  const { call, cli } = setUp()
  await cli(master, ['new', 'Import mapping for the order feed'])
  await cli(master, ['new', '--parent', 'atlas-1', '--to', 'atlas-mapper', 'Map the 2019 price columns'])
  await cli(master, ['new', '--parent', 'atlas-1', 'Map the 2020 price columns'])
  await cli(mapper, ['done', 'atlas-2', '217 rows mapped'])
  await cli(master, ['new', '--lane', 'other', 'Something else'])

  const all = await call('GET', '/api/threads')
  assert.equal(all.status, 200)
  const list = all.body as { rev: number; threads: ThreadRow[] }
  // Open ones only unless closed=1 asks; the feed is not in a list.
  assert.deepEqual(list.threads.map(h => h.key).sort(), ['atlas-1', 'atlas-3', 'other-1'])
  assert.equal('entries' in (list.threads[0] as object), false)
  const parent = list.threads.find(h => h.key === 'atlas-1') as ThreadRow
  assert.deepEqual(parent.children, { done: 1, all: 2 })
  assert.equal(list.threads.find(h => h.key === 'atlas-3')?.parentKey, 'atlas-1')

  const closed = (await call('GET', '/api/threads?closed=1')).body as { threads: ThreadRow[] }
  assert.equal(closed.threads.find(h => h.key === 'atlas-2')?.status, 'done')
  const lane = (await call('GET', '/api/threads?lane=other')).body as { threads: ThreadRow[] }
  assert.deepEqual(
    lane.threads.map(h => h.key),
    ['other-1'],
  )
  const doing = (await call('GET', '/api/threads?status=done')).body as { threads: ThreadRow[] }
  assert.deepEqual(
    doing.threads.map(h => h.key),
    ['atlas-2'],
  )
  const mine = (await call('GET', `/api/threads?closed=1&mine=${encodeURIComponent(mapper.key)}`)).body as {
    threads: ThreadRow[]
  }
  assert.deepEqual(
    mine.threads.map(h => h.key),
    ['atlas-2'],
  )
  // Only what moved after a revision.
  await cli(master, ['post', 'atlas-3', 'started on it'])
  const since = (await call('GET', `/api/threads?since=${list.rev}`)).body as { threads: ThreadRow[] }
  assert.deepEqual(
    since.threads.map(h => h.key),
    ['atlas-3'],
  )
  assert.equal((await call('GET', '/api/threads?status=nope')).status, 400)
})

test('one thread: its head, sub-threads and entries, files with where they are; a key nobody has is 404', async () => {
  const { call, cli } = setUp()
  const report = join(stateDir(), '..', 'report.md')
  mkdirSync(join(report, '..'), { recursive: true })
  writeFileSync(report, '# report\n')
  await cli(master, ['new', 'Import mapping'])
  await cli(master, ['post', 'atlas-1', '--file', report, 'the first pass'])
  const r = await call('GET', '/api/threads/atlas-1')
  assert.equal(r.status, 200)
  const view = r.body as ThreadView
  assert.equal(view.head.key, 'atlas-1')
  assert.equal(view.entries.length, 2)
  const file = view.entries[1]?.files?.[0]
  assert.equal(file?.name, 'report.md')
  assert.equal(file?.path, join(stateDir(), ...(file?.ref ?? '').split('/')))
  assert.equal(existsSync(file?.path ?? ''), true)
  assert.equal(view.ask, null)
  // By the first 8 characters of its id too, as Team's refs are.
  assert.equal(((await call('GET', `/api/threads/${view.head.id.slice(0, 8)}`)).body as ThreadView).head.key, 'atlas-1')
  const last = (await call('GET', '/api/threads/atlas-1?last=1')).body as ThreadView
  assert.equal(last.entries.length, 1)
  assert.equal(last.earlier, 1)
  assert.equal((await call('GET', '/api/threads/atlas-9')).status, 404)
})

test("the owner's writes: X-Board needed, the party is the owner's whatever the body says, files only from uploads", async () => {
  const { call, changed } = setUp()
  const refused = await call('POST', '/api/threads', { op: 'new', lane: 'atlas', title: 'x' }, { 'x-board': '0' })
  assert.equal(refused.status, 403)
  const made = await call('POST', '/api/threads', {
    op: 'new',
    lane: 'atlas',
    title: 'Check the price list',
    createdBy: { kind: 'session', key: 'forged', name: 'forged' },
  })
  assert.equal(made.status, 200)
  const head = (made.body as { head: ThreadView['head'] }).head
  assert.deepEqual(head.createdBy, { kind: 'owner' })
  assert.equal(changed(), 1)

  const up = join(uploadsDir(), '2026-11-12')
  mkdirSync(up, { recursive: true })
  writeFileSync(join(up, 'notes.txt'), 'notes')
  const outside = join(stateDir(), 'board-secret.txt')
  writeFileSync(outside, 'secret')
  // A path outside the uploads is refused, also one that only starts like it or climbs out of it.
  for (const bad of [outside, join(`${uploadsDir()}-evil`, 'x.txt'), `${up}/../../board-secret.txt`]) {
    if (bad.includes('-evil')) {
      mkdirSync(join(bad, '..'), { recursive: true })
      writeFileSync(bad, 'x')
    }
    const r = await call('POST', '/api/threads/atlas-1', { op: 'post', text: 'x', files: [join(up, 'notes.txt'), bad] })
    assert.equal(r.status, 400, bad)
  }
  const posted = await call('POST', '/api/threads/atlas-1', {
    op: 'post',
    text: 'see the notes',
    status: 'doing',
    files: [join(up, 'notes.txt')],
    author: { kind: 'peer', peer: 'x', name: 'x' },
  })
  assert.equal(posted.status, 200)
  const entry = (posted.body as { entry: ThreadView['entries'][number] }).entry
  assert.deepEqual(entry.author, { kind: 'owner' })
  assert.deepEqual(
    entry.files?.map(f => f.name),
    ['notes.txt'],
  )
  assert.equal((await call('POST', '/api/threads/atlas-1', { op: 'post', status: 'sideways' })).status, 400)
  // A malformed assignee is refused, never read as nobody.
  assert.equal((await call('POST', '/api/threads/atlas-1', { op: 'set', assignee: { nonsense: true } })).status, 400)
  assert.equal((await call('POST', '/api/threads/atlas-1', { op: 'share' })).status, 400)
})

test("the owner answers a question (6.6): the status goes back, the asker's card question goes, the words are typed into it", async () => {
  const { call, cli, told, cleared } = setUp()
  await cli(master, ['new', '--to', 'atlas-mapper', 'Map the 2019 price columns'])
  await cli(mapper, ['ask', 'atlas-1', 'Which price list wins, 2019 or 2020?'])
  const asked = (await call('GET', '/api/threads/atlas-1')).body as ThreadView
  assert.equal(asked.head.status, 'owner')
  assert.equal(asked.ask, asked.entries.at(-1)?.id)

  const r = await call('POST', '/api/threads/atlas-1', { op: 'answer', text: 'The 2020 list wins' })
  assert.equal(r.status, 200)
  assert.equal((r.body as { told: boolean }).told, true)
  const after = (await call('GET', '/api/threads/atlas-1')).body as ThreadView
  assert.equal(after.head.status, 'doing')
  assert.equal(after.head.waitingOn, '')
  assert.equal(after.ask, null)
  const answer = after.entries.at(-1)
  assert.equal(answer?.type, 'answer')
  assert.equal(answer?.replyTo, asked.ask)
  assert.deepEqual(cleared, [{ key: mapper.key, question: 'Which price list wins, 2019 or 2020?' }])
  assert.deepEqual(told, [{ session: mapper.key, text: '[board thread atlas-1] The 2020 list wins' }])
  // Nothing asked any more: a second answer is refused.
  assert.equal((await call('POST', '/api/threads/atlas-1', { op: 'answer', text: 'again' })).status, 400)
})

test('a question answered elsewhere is no longer open; an answer puts back what the thread waited on before', async () => {
  const { call, cli, told, cleared, failTells } = setUp()
  await cli(master, ['new', '--to', 'atlas-mapper', 'Map the 2019 price columns'])
  // Answered in the terminal: the agent records it and goes on.
  await cli(mapper, ['ask', 'atlas-1', 'Which list?'])
  await cli(mapper, ['post', 'atlas-1', '--status', 'doing', 'the owner said 2020 in the terminal'])
  await cli(mapper, ['post', 'atlas-1', '--status', 'owner', '--waiting', 'review the PR'])
  const later = (await call('GET', '/api/threads/atlas-1')).body as ThreadView
  assert.equal(later.ask, null)
  assert.equal((await call('POST', '/api/threads/atlas-1', { op: 'answer', text: 'fine' })).status, 400)

  // Waiting on CI, then a question: the answer puts the wait back as it was.
  await cli(mapper, ['post', 'atlas-1', '--status', 'waiting', '--waiting', 'CI run'])
  await cli(mapper, ['ask', 'atlas-1', 'Ship without the flaky test?'])
  failTells('the session is busy')
  const r = await call('POST', '/api/threads/atlas-1', { op: 'answer', text: 'Yes' })
  assert.equal(r.status, 200)
  const body = r.body as { told: boolean; why: string; head: ThreadView['head'] }
  assert.equal(body.told, false)
  assert.equal(body.why, 'the session is busy')
  assert.equal(body.head.status, 'waiting')
  assert.equal(body.head.waitingOn, 'CI run')
  // Not told: its card keeps the question.
  assert.equal(told.length, 1)
  assert.deepEqual(cleared, [])

  // A close proposed after a question: Confirm or Keep open first, the answer is refused.
  await cli(mapper, ['ask', 'atlas-1', 'Is the list final?'])
  await cli(mapper, ['done', 'atlas-1', 'mapped'])
  const proposed = (await call('GET', '/api/threads/atlas-1')).body as ThreadView
  assert.notEqual(proposed.ask, null)
  assert.equal((await call('POST', '/api/threads/atlas-1', { op: 'answer', text: 'yes' })).status, 400)
  // Done: nothing is open any more.
  await call('POST', '/api/threads/atlas-1', { op: 'confirm' })
  assert.equal(((await call('GET', '/api/threads/atlas-1')).body as ThreadView).ask, null)
})

test("a proposed close (3.5): Confirm closes it with the agent's words, Keep open leaves it with the owner", async () => {
  const { call, cli } = setUp()
  await cli(master, ['new', '--to', 'atlas-mapper', 'Map the 2019 price columns'])
  await cli(mapper, ['ask', 'atlas-1', 'Is the 2019 list final?'])
  await cli(mapper, ['done', 'atlas-1', 'mapped with the 2019 list'])
  const proposed = (await call('GET', '/api/threads/atlas-1')).body as ThreadView
  assert.equal(proposed.head.status, 'owner')
  assert.equal(proposed.head.proposed?.why, 'mapped with the 2019 list')

  const kept = await call('POST', '/api/threads/atlas-1', { op: 'keep' })
  assert.equal(kept.status, 200)
  const head = (kept.body as { head: ThreadView['head'] }).head
  assert.equal(head.status, 'owner')
  assert.equal(head.proposed, null)
  assert.equal((await call('POST', '/api/threads/atlas-1', { op: 'confirm' })).status, 400)

  await cli(mapper, ['done', 'atlas-1', 'mapped with the 2019 list, checked twice'])
  const confirmed = await call('POST', '/api/threads/atlas-1', { op: 'confirm' })
  const done = (confirmed.body as { head: ThreadView['head'] }).head
  assert.equal(done.status, 'done')
  assert.equal(done.summary, 'mapped with the 2019 list, checked twice')
  assert.equal(done.proposed, null)
})

test('the revision stream: the revision as it stands, then a `rev` event each time it moves, and only then', async () => {
  const { call, revs } = setUp()
  const r = await call('GET', '/api/threads/events')
  const res = r.body as Response
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const text = new TextDecoder()
  let got = ''
  const read = async (until: string) => {
    while (!got.includes(until)) got += text.decode((await reader.read()).value)
  }
  await read('event: rev')
  assert.match(got, /data: \{"rev":0\}/)
  revs.moved(0)
  revs.moved(7)
  revs.moved(7)
  await read('"rev":7')
  assert.equal(got.split('"rev":7').length - 1, 1)
  // A second client connecting after a write the payload has not read yet: the first is told too.
  const second = revs.response(new Request('http://127.0.0.1/api/threads/events'), 9)
  await read('"rev":9')
  const other = (second.body as ReadableStream<Uint8Array>).getReader()
  assert.match(text.decode((await other.read()).value), /"rev":9/)
  await other.cancel()
  await reader.cancel()
  revs.close()
})

test('a thread opened on the pages (8): known keys only; pages open now and those that connect soon are told', async () => {
  const { cli, app } = setUp()
  await cli(master, ['new', 'Import mapping'])
  const sent: { name: string; data: unknown }[] = []
  const events = { event: (name: string, data: unknown) => void sent.push({ name, data }), size: () => 2 }
  const state = threadOpenState(() => NOW)
  assert.equal(threadReveal(app, events, state, 'atlas-9').status, 404)
  assert.equal(threadReveal(app, events, state, '../etc').status, 400)
  const r = threadReveal(app, events, state, 'Atlas-1')
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true, thread: 'atlas-1', pages: 2 })
  assert.deepEqual(sent, [{ name: 'thread-open', data: { key: 'atlas-1' } }])
  assert.equal(state.greet(), 'event: thread-open\ndata: {"key":"atlas-1"}\n\n')
  assert.equal(state.greet(), '')

  // Through /api/reveal: { thread } goes there, { key } and { pane } stay as they were.
  const route = revealRoute({ find: () => undefined, items: () => [] }, events, revealState(), word =>
    threadReveal(app, events, state, word),
  )
  const post = (body: unknown) => {
    const url = new URL('http://127.0.0.1:12422/api/reveal')
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    })
    return dispatch([route], req, url, '/api/reveal', STATE)
  }
  assert.equal((await post({ thread: 'atlas-1' })).status, 200)
  assert.equal((await post({ key: 'gone' })).status, 404)
  assert.equal((await post({ pane: 'p9' })).status, 404)
})

test("from outside: the owner's own login reaches the threads routes, every other caller is refused", () => {
  for (const path of ['/api/threads', '/api/threads/atlas-1', '/api/threads/events']) {
    assert.equal(remoteRefusal(path, path)?.status, 403, path)
    assert.equal(remoteRefusal(path, path, false, true)?.status, 403, `${path}: team owner alone`)
    assert.equal(remoteRefusal(path, path, true, false, false)?.status, 403, `${path}: a desk`)
    assert.equal(remoteRefusal(path, path, false, false, true), null, `${path}: the owner`)
  }
  // Encoded the other way, deeper paths: still refused.
  assert.equal(remoteRefusal('/api/%74hreads', '/api/threads')?.status, 403)
  assert.equal(remoteRefusal('/api/threads/a/b', '/api/threads/a/b', false, false, true)?.status, 403)
  // Every other path is as it was.
  assert.equal(remoteRefusal('/api/board', '/api/board', false, false, true), null)
  assert.equal(remoteRefusal('/api/team', '/api/team', false, false, true)?.status, 403)
  assert.equal(remoteRefusal('/api/team', '/api/team', false, true, false), null)
})
