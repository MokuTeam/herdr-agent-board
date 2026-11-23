// Both ends of the uplink (#508) in this process: the node's outbox and waits (services/node/uplink.ts)
// and the master's runner (services/nodes/uplink.ts) against a stand-in link. The two boards
// together are in test/server/node-uplink.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOutbox } from '../../src/adapters/node-outbox.ts'
import { createDeviceStore } from '../../src/adapters/node-store.ts'
import { listEntries } from '../../src/adapters/schedule-store.ts'
import type { UplinkResult } from '../../src/core/node-uplink.ts'
import type { LinkStatus } from '../../src/core/nodes.ts'
import type { Item } from '../../src/core/types.ts'
import type { ThreadCmdContext } from '../../src/entrypoints/thread-cli.ts'
import { createNodeUplink } from '../../src/services/node/uplink.ts'
import type { Link } from '../../src/services/nodes/link.ts'
import { createUplinkRunner } from '../../src/services/nodes/uplink.ts'
import { isolatedHome } from '../support/env.ts'
import { until } from '../support/sandbox.ts'

const KNOBS = { BOARD_NODE_KEPT_MS: '150', BOARD_NODE_READ_MS: '150', BOARD_TEST_PACE: '0.02' } as const
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const [k, v] of Object.entries(KNOBS)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterEach(() => {
  for (const k of Object.keys(KNOBS)) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const N1 = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e'
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

/** The events a node's stream sends, read until `n` calls came. */
async function calls(res: Response, n: number): Promise<Record<string, unknown>[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  let text = ''
  const got = (): Record<string, unknown>[] =>
    text
      .split('\n\n')
      .filter(b => b.startsWith('event: call\n'))
      .map(b => JSON.parse(b.split('\n')[1]?.slice('data: '.length) ?? 'null'))
  while (got().length < n) text += new TextDecoder().decode((await reader.read()).value)
  void reader.cancel()
  return got()
}

describe("the node's side", () => {
  test('a read with no master there fails at once and leaves nothing; a write waits, is kept, and goes to the next stream', async () => {
    const dir = isolatedHome()
    const outbox = createOutbox({ dir: join(dir, 'outbox') })
    const up = createNodeUplink({ outbox, log: () => {} })
    const started = Date.now()
    expect(await up.call({ cmd: 'thread', argv: ['list'], session: 's-1', lane: 'atlas' })).toEqual({
      status: 200,
      body: { state: 'unreachable' },
    })
    expect(Date.now() - started).toBeLessThan(100)
    expect(outbox.list()).toEqual([])
    // board send (#619) is never kept, whatever it is sent to: a card named like a thread write too.
    expect(await up.call({ cmd: 'send', argv: ['post', 'x'], session: 's-1', lane: null })).toEqual({
      status: 200,
      body: { state: 'unreachable' },
    })
    expect(outbox.list()).toEqual([])

    const file = join(dir, 'r.md')
    writeFileSync(file, 'abc')
    const kept = await up.call({
      id: 'call-1',
      cmd: 'thread',
      argv: ['post', 'atlas-1', '--file', file, 'x'],
      session: 's-1',
      lane: 'atlas',
      files: [file],
      // What the caller says is not what keeps it: the command does.
      keep: false,
    })
    expect(kept).toEqual({ status: 200, body: { state: 'kept', id: 'call-1' } })
    expect(outbox.list().map(c => c.id)).toEqual(['call-1'])

    // The stream: what waits first, as the link carries it, without the path.
    const ac = new AbortController()
    const [sent] = await calls(up.stream(new Request('http://x/', { signal: ac.signal })), 1)
    expect(sent).toEqual({
      id: 'call-1',
      cmd: 'thread',
      argv: ['post', 'atlas-1', '--file', file, 'x'],
      session: 's-1',
      lane: 'atlas',
      files: [{ n: 0, name: 'r.md', size: 3, sha256: sha('abc') }],
    })
    expect(await up.file('call-1', 0).text()).toBe('abc')
    expect(up.file('call-1', 1).status).toBe(404)
    expect(up.file('call-2', 0).status).toBe(404)
    // The master's result, late: the outbox lets the call go; a second one finds none.
    expect(up.answer('call-1', { code: 0, out: ['ok'], err: [] })).toEqual({ status: 200, body: { ok: true } })
    expect(outbox.list()).toEqual([])
    expect(up.answer('call-1', { code: 0, out: ['ok'], err: [] }).status).toBe(404)
    expect(up.answer('call-1', { code: 'x' }).status).toBe(400)
    ac.abort()
    up.close()
  })

  test('a call the master answers in time gets its result; a read with a master there waits for it', async () => {
    const dir = isolatedHome()
    const outbox = createOutbox({ dir: join(dir, 'outbox') })
    const up = createNodeUplink({ outbox, log: () => {} })
    const ac = new AbortController()
    const stream = up.stream(new Request('http://x/', { signal: ac.signal }))
    const asked = up.call({ cmd: 'thread', argv: ['show', 'atlas-1'], session: 's-1', lane: null })
    const [sent] = await calls(stream, 1)
    up.answer(String(sent?.id), { code: 0, out: ['atlas-1 · doing'], err: [] })
    expect(await asked).toEqual({
      status: 200,
      body: { state: 'answered', code: 0, out: ['atlas-1 · doing'], err: [] },
    })
    expect(outbox.list()).toEqual([])
    ac.abort()
    up.close()
  })

  test("files a post could not take are refused here, in a local post's words, before anything is kept", async () => {
    const dir = isolatedHome()
    const outbox = createOutbox({ dir: join(dir, 'outbox') })
    const up = createNodeUplink({ outbox, log: () => {} })
    const big = join(dir, 'big.bin')
    writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1))
    const small = join(dir, 's.md')
    writeFileSync(small, 's')
    const post = (files: string[]) => up.call({ cmd: 'thread', argv: ['post', 'k'], session: 's-1', lane: null, files })
    expect((await post([big])).body).toEqual({
      state: 'answered',
      code: 1,
      out: [],
      err: [`${big}: 6 MB; 5 MB at most on a local thread`],
    })
    expect((await post([join(dir, 'gone.md')])).body).toMatchObject({
      code: 1,
      err: [`${join(dir, 'gone.md')}: no such file`],
    })
    expect((await post(Array(6).fill(small))).body).toMatchObject({ code: 1, err: ['6 files; 5 at most'] })
    expect(outbox.list()).toEqual([])
    up.close()
  })
})

test('a kept call keeps its files as they were posted; a read a stopped board left is dropped; a failed kept call is logged', async () => {
  const dir = isolatedHome()
  const outbox = createOutbox({ dir: join(dir, 'outbox') })
  const logs: string[] = []
  const up = createNodeUplink({ outbox, log: l => logs.push(l) })
  const file = join(dir, 'r.md')
  writeFileSync(file, 'as posted')
  const kept = await up.call({
    id: 'k-1',
    cmd: 'thread',
    argv: ['post', 'k', '--file', file],
    session: 's-1',
    lane: null,
    files: [file],
  })
  expect(kept.body).toEqual({ state: 'kept', id: 'k-1' })
  writeFileSync(file, 'changed afterwards')
  expect(await up.file('k-1', 0).text()).toBe('as posted')
  // A read, as a board that stopped while its command waited leaves it.
  outbox.write({ id: 'r-1', cmd: 'thread', argv: ['list'], session: 's-1', lane: null, files: [], keep: false, at: 0 })
  const ac = new AbortController()
  const sent = await calls(up.stream(new Request('http://x/', { signal: ac.signal })), 1)
  expect(sent.map(c => c.id)).toEqual(['k-1'])
  expect(outbox.read('r-1')).toBeNull()
  // Its result, with nobody waiting: it goes to the log, and the call with its copy goes.
  up.answer('k-1', { code: 1, out: [], err: ['no thread "k"'] })
  expect(logs).toEqual(['node uplink: call k-1 came back with exit 1: no thread "k"'])
  expect(existsSync(join(dir, 'outbox', 'k-1'))).toBe(false)
  // What the master would refuse is refused here, not kept.
  const long = await up.call({ cmd: 'thread', argv: ['post', 'k', 'x'.repeat(70_000)], session: 's-1', lane: null })
  expect(long.body).toEqual({
    state: 'answered',
    code: 1,
    out: [],
    err: ["the board's computer does not take this call: its words are too many or too long"],
  })
  expect(outbox.list()).toEqual([])
  ac.abort()
  up.close()
})

/** A link that is online and serves what the test gives it. */
function standIn(serve: (path: string, init: RequestInit) => Promise<Response> | Response) {
  let state: LinkStatus = { state: 'online', since: 0, heardAt: null }
  const fns = new Set<(id: string) => void>()
  const link = {
    id: 'server-1',
    fetch: async (path: string, init?: RequestInit) => serve(path, init ?? {}),
    state: () => state,
  } as unknown as Link
  return {
    links: {
      link: (id: string) => (id === 'server-1' ? link : null),
      onChange(fn: (id: string) => void) {
        fns.add(fn)
        return () => fns.delete(fn)
      },
    },
    changed(next: LinkStatus['state']) {
      state = { ...state, state: next }
      for (const fn of fns) fn('server-1')
    },
  }
}

/** A stream of these calls, held open until the link aborts it, or ended after them when `end`. */
function streamOf(calls: unknown[], signal?: AbortSignal | null, end = false): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const call of calls) c.enqueue(enc.encode(`event: call\ndata: ${JSON.stringify(call)}\n\n`))
      if (end) return c.close()
      signal?.addEventListener('abort', () => c.error(new Error('aborted')), { once: true })
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

describe("the master's side", () => {
  test("a node session's post runs as its prefixed key, in its card's lane, its file pulled and checked; a call seen again is not run again", async () => {
    const dir = isolatedHome()
    const store = createDeviceStore({ dir: join(dir, 'nodes') })
    const report = Buffer.from('# report\n')
    const call = {
      id: 'c-1',
      cmd: 'thread',
      argv: ['post', 'atlas-1', '--file', '/home/n/report.md', '--summary', 'ok', 'text'],
      session: 's-1',
      lane: 'elsewhere',
      files: [{ n: 0, name: 'report.md', size: report.length, sha256: sha(report) }],
    }
    const posted: { path: string; body: UplinkResult }[] = []
    let streams = 0
    const link = standIn((path, init) => {
      if (path === '/api/node/uplink') return streamOf(streams++ ? [] : [call, call], init.signal)
      if (path === '/api/node/uplink/c-1/file/0') return new Response(report)
      posted.push({ path, body: JSON.parse(String(init.body)) })
      return new Response('{}')
    })
    const ran: { argv: string[]; ctx: ThreadCmdContext; file: string }[] = []
    const card = { key: '@server-1:s-1', category: 'atlas', name: 'worker' } as Item
    const runner = createUplinkRunner({
      links: link.links,
      find: key => (key === card.key ? card : undefined),
      items: () => [card],
      cfg: { threads: true, port: 1 } as never,
      log: () => {},
      store,
      run: async (argv, ctx) => {
        ran.push({ argv: [...argv], ctx, file: readFileSync(argv[3] as string, 'utf8') })
        ctx.out?.('ok · atlas-1 · 1 file')
        return 0
      },
    })
    link.changed('online')
    await until(() => posted.length >= 2, 5000)
    await runner.close()
    expect(ran).toHaveLength(1)
    const [r] = ran
    expect(r?.ctx.actor).toEqual({ kind: 'session', key: '@server-1:s-1', name: 'worker' })
    expect(r?.ctx.lane).toBe('atlas')
    expect(r?.ctx.cfg).toEqual({ threads: true, port: 1 })
    expect(r?.file).toBe('# report\n')
    expect(r?.argv[3]?.startsWith(join(dir, 'nodes', 'server-1', 'uplink', 'c-1'))).toBe(true)
    expect(r?.argv.filter((_, i) => i !== 3)).toEqual(['post', 'atlas-1', '--file', '--summary', 'ok', 'text'])
    // Its copy goes once the call ran; the result, twice, is the one run's.
    expect(readdirSync(join(dir, 'nodes', 'server-1', 'uplink'))).toEqual([])
    expect(posted.map(p => p.path)).toEqual(['/api/node/uplink/c-1', '/api/node/uplink/c-1'])
    expect(posted[1]?.body).toEqual({ code: 0, out: ['ok · atlas-1 · 1 file'], err: [] })
    expect(store.seenCall('server-1', 'c-1')).toEqual({ code: 0, out: ['ok · atlas-1 · 1 file'], err: [] })
  })
  test("case files (#488): with the master's cases on, a node session's command gets its sessions from the master's cards; off, nothing", async () => {
    const dir = isolatedHome()
    const report = Buffer.from('# r\n')
    const sent = [
      {
        id: 'k-1',
        cmd: 'thread',
        argv: ['post', 'atlas-1', '--state', '--file', '--file', '/home/n/r.md'],
        session: 's-1',
        lane: null,
        files: [{ n: 0, name: 'r.md', size: report.length, sha256: sha(report) }],
      },
    ]
    const ran: { argv: string[]; ctx: ThreadCmdContext }[] = []
    const card = { key: '@server-1:s-1', category: 'atlas', name: 'worker', cwd: '/srv/work/atlas' } as Item
    const runner = (threads: unknown, store: string) =>
      createUplinkRunner({
        links: link.links,
        find: key => (key === card.key ? card : undefined),
        items: () => [card],
        cfg: { threads, port: 1 } as never,
        log: () => {},
        store: createDeviceStore({ dir: join(dir, store) }),
        run: async (argv, ctx) => {
          ran.push({ argv: [...argv], ctx })
          return 0
        },
      })
    let posted = 0
    const link = standIn((path, init) => {
      if (path === '/api/node/uplink') return streamOf(sent, init.signal)
      if (path.includes('/file/')) return new Response(report)
      posted++
      return new Response('{}')
    })
    const on = runner({ cases: true }, 'on')
    link.changed('online')
    await until(() => posted >= 1, 5000)
    await on.close()
    const [r] = ran
    // The file is the one after --state's value.
    expect(r?.argv.slice(0, 5)).toEqual(['post', 'atlas-1', '--state', '--file', '--file'])
    expect(r?.argv[5]?.startsWith(join(dir, 'on', 'server-1', 'uplink', 'k-1'))).toBe(true)
    expect(await r?.ctx.cases?.live?.([card.key])).toEqual(
      new Map([[card.key, { state: 'up', name: 'worker', cwd: '/srv/work/atlas', device: 'server-1' }]]),
    )
    expect(await r?.ctx.cases?.names?.()).toEqual(new Set(['worker']))
    ran.length = 0
    posted = 0
    const off = runner(true, 'off')
    link.changed('online')
    await until(() => posted >= 1, 5000)
    await off.close()
    expect(ran[0]?.ctx.cases).toBeUndefined()
  })

  test('the lane the node says counts only when the master has no card of the session', async () => {
    const dir = isolatedHome()
    const lanes: (string | null)[] = []
    const link = standIn((path, init) =>
      path === '/api/node/uplink'
        ? streamOf([{ id: 'c-2', cmd: 'thread', argv: ['new', 'T'], session: 's-9', lane: 'atlas' }], init.signal)
        : new Response('{}'),
    )
    const runner = createUplinkRunner({
      links: link.links,
      find: () => undefined,
      items: () => [],
      cfg: { threads: true } as never,
      log: () => {},
      store: createDeviceStore({ dir: join(dir, 'nodes') }),
      run: async (_argv, ctx) => {
        lanes.push(ctx.lane)
        return 0
      },
    })
    link.changed('online')
    await until(() => lanes.length === 1, 5000)
    await runner.close()
    expect(lanes).toEqual(['atlas'])
  })

  test("refused whatever the node sends: another command, no session, the owner's commands, a call that is not one, a file not as named", async () => {
    const dir = isolatedHome()
    const bytes = Buffer.from('real')
    const sent = [
      { id: 'r-1', cmd: 'time', argv: ['add'], session: 's-1', lane: null },
      { id: 'r-2', cmd: 'thread', argv: ['post', 'k', 'x'], session: '', lane: null },
      { id: 'r-3', cmd: 'thread', argv: ['share', 'k', 'team'], session: 's-1', lane: null },
      { id: 'r-4', cmd: 'thread', argv: ['open', 'k'], session: 's-1', lane: null },
      { id: 'r-5', cmd: 'thread', argv: 'post', session: 's-1' },
      {
        id: 'r-6',
        cmd: 'thread',
        argv: ['post', 'k', '--file', '/x/a.md'],
        session: 's-1',
        lane: null,
        files: [{ n: 0, name: 'a.md', size: bytes.length, sha256: sha('other') }],
      },
      {
        id: 'r-7',
        cmd: 'thread',
        argv: ['post', 'k', '--file', '/x/b.md'],
        session: 's-1',
        lane: null,
        files: [{ n: 0, name: 'b.md', size: 6 * 1024 * 1024, sha256: sha('x') }],
      },
      { id: 'r-8', cmd: 'thread', argv: ['post', 'k', '--file', '/x/c.md'], session: 's-1', lane: null },
    ]
    const posted = new Map<string, UplinkResult>()
    const fetched: string[] = []
    const link = standIn((path, init) => {
      if (path === '/api/node/uplink') return streamOf(sent, init.signal)
      if (path.includes('/file/')) {
        fetched.push(path)
        return new Response(bytes)
      }
      posted.set(path.split('/').pop() as string, JSON.parse(String(init.body)))
      return new Response('{}')
    })
    let ran = 0
    const runner = createUplinkRunner({
      links: link.links,
      find: () => undefined,
      items: () => [],
      cfg: { threads: true } as never,
      log: () => {},
      store: createDeviceStore({ dir: join(dir, 'nodes') }),
      run: async () => {
        ran++
        return 0
      },
    })
    link.changed('online')
    await until(() => posted.size === sent.length, 5000)
    await runner.close()
    expect(ran).toBe(0)
    expect(Object.fromEntries(posted)).toEqual({
      'r-1': {
        code: 126,
        out: [],
        err: ['board time is not taken from a node: only board thread, board send and board agents'],
      },
      'r-2': {
        code: 126,
        out: [],
        err: ["only a session's board thread, board send or board agents is taken from a node"],
      },
      'r-3': { code: 126, out: [], err: ['board thread share is for the owner to confirm: not from a node'] },
      'r-4': { code: 126, out: [], err: ['board thread open opens the board on its own computer: not from a node'] },
      'r-5': { code: 126, out: [], err: ['a call the board does not take'] },
      'r-6': { code: 1, out: [], err: ['a.md: not the file the node named'] },
      'r-7': { code: 1, out: [], err: ['b.md: 6 MB; 5 MB at most on a local thread'] },
      'r-8': { code: 1, out: [], err: ['/x/c.md: the node did not send it'] },
    })
    // The file too large is never asked for.
    expect(fetched).toEqual(['/api/node/uplink/r-6/file/0'])
    expect(existsSync(join(dir, 'nodes', 'server-1', 'uplink'))).toBe(false)
  })

  test("#619 a node session's board send is queued here once for the card it names, signed with its prefixed key; another node is out of its reach", async () => {
    const dir = isolatedHome()
    const store = createDeviceStore({ dir: join(dir, 'nodes') })
    const sent = [
      { id: 's-1', cmd: 'send', argv: ['Monitor', 'done: case 42'], session: 'n-1', lane: null },
      { id: 's-2', cmd: 'send', argv: ['nobody', 'x'], session: 'n-1', lane: null },
      { id: 's-3', cmd: 'send', argv: ['@server-1:n-1', 'to myself'], session: 'n-1', lane: null },
      { id: 's-4', cmd: 'send', argv: ['Monitor', 'from the twin'], session: N1, lane: null },
      // Sent again on a new stream while its command waited: queued once, the result as it was.
      { id: 's-1', cmd: 'send', argv: ['Monitor', 'done: case 42'], session: 'n-1', lane: null },
      // A card named like a thread write: not kept, and no thread command runs.
      { id: 's-5', cmd: 'send', argv: ['post', 'to post'], session: 'n-1', lane: null },
      // Another node's session: not reached, not even named.
      { id: 's-6', cmd: 'send', argv: ['Elsewhere', 'x'], session: 'n-1', lane: null },
    ]
    const posted: [string, UplinkResult][] = []
    const link = standIn((path, init) => {
      if (path === '/api/node/uplink') return streamOf(sent, init.signal)
      posted.push([path.split('/').pop() as string, JSON.parse(String(init.body))])
      return new Response('{}')
    })
    const mine = { key: '@server-1:n-1', session: 'n-1', name: 'worker', device: 'server-1', pane: 'w1:p1' } as Item
    const twin = { ...mine, key: `@server-1:${N1}`, session: N1, pane: 'w1:p2' } as Item
    const monitor = {
      key: '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b',
      session: '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b',
      name: 'Monitor',
      pane: 'w2:p3',
      cwd: 'C:\\Work',
    } as Item
    const post = {
      key: 'a1b2c3d4-0000-4000-8000-000000000001',
      session: 'a1b2c3d4-0000-4000-8000-000000000001',
      name: 'post',
      pane: 'w2:p4',
    } as Item
    const elsewhere = {
      key: `@server-2:${N1}`,
      session: N1,
      name: 'Elsewhere',
      device: 'server-2',
      pane: 'w5:p1',
    } as Item
    const cards = [mine, twin, monitor, post, elsewhere]
    const runner = createUplinkRunner({
      links: link.links,
      find: key => cards.find(i => i.key === key),
      items: () => cards,
      cfg: { threads: true, nodes: { id: 'laptop' } } as never,
      log: () => {},
      store,
      run: async () => {
        throw new Error('not a thread command')
      },
    })
    link.changed('online')
    await until(() => posted.length === sent.length, 5000)
    await runner.close()
    const queued = {
      code: 0,
      out: [
        'ok · queued for Monitor [3e4f5a6b] on laptop: the board types it in once it is free, waking it first if it sleeps; the answer comes back as a board reminder',
      ],
      err: [],
    }
    const answers = (id: string) => posted.filter(([p]) => p === id).map(([, r]) => r)
    expect(answers('s-1')).toEqual([queued, queued])
    expect(answers('s-2')).toEqual([{ code: 1, out: [], err: ['no session "nobody" on the board'] }])
    expect(answers('s-3')).toEqual([{ code: 1, out: [], err: ['that is this session: nothing was sent'] }])
    expect(answers('s-4')).toMatchObject([{ code: 0 }])
    expect(answers('s-5')).toMatchObject([
      { code: 0, out: [expect.stringMatching(/^ok · queued for post \[a1b2c3d4\]/)] },
    ])
    expect(answers('s-6')).toEqual([{ code: 1, out: [], err: ['no session "Elsewhere" on the board'] }])
    // Two sessions' calls run side by side: the entries in the order of their texts.
    expect(listEntries().sort((a, b) => a.text.localeCompare(b.text))).toMatchObject([
      {
        key: monitor.key,
        name: 'Monitor',
        pane: 'w2:p3',
        cwd: 'C:\\Work',
        text: 'done: case 42',
        idle: true,
        from: { key: '@server-1:n-1', name: 'worker' },
        // A session id that is no hex has no ref to give: the whole key finds it again.
        replyTo: '@server-1:n-1',
        replyBy: 'board',
        fromDevice: 'server-1',
      },
      { key: monitor.key, text: 'from the twin', from: { key: `@server-1:${N1}` }, replyTo: 'worker [7b8c9d0e]' },
      { key: post.key, text: 'to post' },
    ])
    expect(store.seenCall('server-1', 's-1')).toEqual(queued)
  })

  test('#628 board agents from a node lists only the master and this node (never another node) and is not remembered', async () => {
    const dir = isolatedHome()
    const store = createDeviceStore({ dir: join(dir, 'nodes') })
    const N1 = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e'
    const ME_M = '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b'
    const OTHER = '8c9d0e1f-2a3b-4c4d-9e5f-6a7b8c9d0e1f'
    const items = [
      { key: ME_M, session: ME_M, agent: 'claude', name: 'Laptop Master', pane: 'w1:p1', status: 'idle' },
      {
        key: `@server-1:${N1}`,
        session: N1,
        agent: 'agy',
        name: 'Gemini-dev',
        device: 'server-1',
        pane: 'w5:p7',
        status: 'working',
      },
      {
        key: `@server-2:${OTHER}`,
        session: OTHER,
        agent: 'claude',
        name: 'Other Node Secret',
        device: 'server-2',
        pane: 'w1:p1',
        status: 'idle',
      },
    ] as Item[]
    const posted = new Map<string, UplinkResult>()
    const link = standIn((path, init) => {
      if (path === '/api/node/uplink')
        return streamOf(
          [
            { id: 'ag-1', cmd: 'agents', argv: [], session: N1, lane: null, files: [] },
            { id: 'ag-2', cmd: 'agents', argv: ['--json'], session: N1, lane: null, files: [] },
          ],
          init.signal,
        )
      posted.set(path.split('/').pop() as string, JSON.parse(String(init.body)) as UplinkResult)
      return new Response('{}')
    })
    const runner = createUplinkRunner({
      links: link.links,
      find: key => items.find(i => i.key === key),
      items: () => items,
      cfg: { nodes: { id: 'laptop' } } as never,
      log: () => {},
      store,
    })
    link.changed('online')
    await until(() => posted.size >= 2, 5000)
    await runner.close()
    expect(posted.get('ag-1')).toEqual({
      code: 0,
      out: [
        'Laptop Master [3e4f5a6b]  ·  claude  ·  laptop  ·  idle',
        'Gemini-dev [7b8c9d0e]  ·  agy  ·  node server-1  ·  working  ·  (this session)',
      ],
      err: [],
    })
    expect(posted.get('ag-1')?.out.join('\n')).not.toContain('Other Node Secret')
    expect(JSON.parse(posted.get('ag-2')?.out[0] ?? '[]')).toMatchObject([
      { key: ME_M, agent: 'claude', self: false },
      { key: `@server-1:${N1}`, agent: 'agy', device: 'server-1', self: true },
    ])
    expect(store.seenCall('server-1', 'ag-1')).toBeNull()
  })

  test('the stream is held only while the link is online', async () => {
    const dir = isolatedHome()
    let open = 0
    let asked = 0
    const link = standIn((path, init) => {
      if (path !== '/api/node/uplink') return new Response('{}')
      asked++
      open++
      init.signal?.addEventListener('abort', () => open--, { once: true })
      return streamOf([], init.signal)
    })
    const runner = createUplinkRunner({
      links: link.links,
      find: () => undefined,
      items: () => [],
      cfg: {} as never,
      log: () => {},
      store: createDeviceStore({ dir: join(dir, 'nodes') }),
    })
    link.changed('online')
    await until(() => open === 1, 5000)
    link.changed('offline')
    await until(() => open === 0, 5000)
    link.changed('online')
    await until(() => open === 1, 5000)
    expect(asked).toBe(2)
    await runner.close()
    expect(open).toBe(0)
  })
  test('a file the link could not bring leaves the call for the next stream, run once then', async () => {
    const dir = isolatedHome()
    const store = createDeviceStore({ dir: join(dir, 'nodes') })
    const bytes = Buffer.from('report')
    const call = {
      id: 't-1',
      cmd: 'thread',
      argv: ['post', 'k', '--file', '/n/r.md'],
      session: 's-1',
      lane: null,
      files: [{ n: 0, name: 'r.md', size: bytes.length, sha256: sha(bytes) }],
    }
    let streams = 0
    let pulls = 0
    const posted: UplinkResult[] = []
    const link = standIn((path, init) => {
      if (path === '/api/node/uplink')
        return streams++ ? streamOf([call], init.signal) : streamOf([call], init.signal, true)
      if (path.includes('/file/')) {
        if (!pulls++) throw new Error('the link went')
        return new Response(bytes)
      }
      posted.push(JSON.parse(String(init.body)))
      return new Response('{}')
    })
    let ran = 0
    const runner = createUplinkRunner({
      links: link.links,
      find: () => undefined,
      items: () => [],
      cfg: { threads: true } as never,
      log: () => {},
      store,
      run: async () => {
        ran++
        return 0
      },
    })
    link.changed('online')
    await until(() => posted.length === 1, 5000)
    await runner.close()
    expect([ran, pulls, streams >= 2]).toEqual([1, 2, true])
    expect(posted).toEqual([{ code: 0, out: [], err: [] }])
    expect(store.seenCall('server-1', 't-1')).toEqual({ code: 0, out: [], err: [] })
  })

  test("one session's slow call does not hold another's; a read's result is not remembered", async () => {
    const dir = isolatedHome()
    const store = createDeviceStore({ dir: join(dir, 'nodes') })
    const posted: string[] = []
    const link = standIn((path, init) => {
      if (path === '/api/node/uplink')
        return streamOf(
          [
            { id: 'a-1', cmd: 'thread', argv: ['new', 'slow'], session: 's-a', lane: 'atlas' },
            { id: 'b-1', cmd: 'thread', argv: ['list'], session: 's-b', lane: 'atlas' },
          ],
          init.signal,
        )
      posted.push(path.split('/').pop() as string)
      return new Response('{}')
    })
    let release = (): void => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const runner = createUplinkRunner({
      links: link.links,
      find: () => undefined,
      items: () => [],
      cfg: { threads: true } as never,
      log: () => {},
      store,
      run: async argv => {
        if (argv[0] === 'new') await gate
        return 0
      },
    })
    link.changed('online')
    await until(() => posted.includes('b-1'), 5000)
    expect(posted).toEqual(['b-1'])
    release()
    await until(() => posted.includes('a-1'), 5000)
    await runner.close()
    expect(store.seenCall('server-1', 'b-1')).toBeNull()
    expect(store.seenCall('server-1', 'a-1')).toEqual({ code: 0, out: [], err: [] })
  })
})
