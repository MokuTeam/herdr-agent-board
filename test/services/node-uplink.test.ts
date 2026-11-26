// Both ends of the uplink (#508) in this process: the node's outbox and waits (services/node/uplink.ts)
// and the master's runner (services/nodes/uplink.ts) against a stand-in link. The two boards
// together are in test/server/node-uplink.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOutbox } from '../../src/adapters/node-outbox.ts'
import { createDeviceStore } from '../../src/adapters/node-store.ts'
import { stateDir } from '../../src/adapters/paths.ts'
import { addEntry, listEntries } from '../../src/adapters/schedule-store.ts'
import { formatListLines } from '../../src/core/board-list.ts'
import { RESULT_LINE_MAX, type UplinkResult } from '../../src/core/node-uplink.ts'
import type { LinkStatus } from '../../src/core/nodes.ts'
import type { Item } from '../../src/core/types.ts'
import type { CalCmdContext } from '../../src/entrypoints/cal-cli.ts'
import { threadData } from '../../src/entrypoints/team-agents-cli.ts'
import type { ThreadCmdContext } from '../../src/entrypoints/thread-cli.ts'
import type { TimeCmdContext } from '../../src/entrypoints/time-cli.ts'
import { createNodeUplink } from '../../src/services/node/uplink.ts'
import type { Link } from '../../src/services/nodes/link.ts'
import { createUplinkRunner } from '../../src/services/nodes/uplink.ts'
import { boardOwnFile } from '../../src/services/team-router.ts'
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
    // board send (#619) and cal/presence (#698) are never kept; team draft IS kept (#698).
    expect(await up.call({ cmd: 'send', argv: ['post', 'x'], session: 's-1', lane: null })).toEqual({
      status: 200,
      body: { state: 'unreachable' },
    })
    expect(await up.call({ cmd: 'cal', argv: ['add'], session: 's-1', lane: null })).toEqual({
      status: 200,
      body: { state: 'unreachable' },
    })
    expect(outbox.list()).toEqual([])
    const keptDraft = await up.call({
      id: 'draft-1',
      cmd: 'team',
      argv: ['draft', 'anna', 'hello'],
      session: 's-1',
      lane: null,
    })
    expect(keptDraft).toEqual({ status: 200, body: { state: 'kept', id: 'draft-1' } })
    expect(outbox.list().map(c => c.id)).toEqual(['draft-1'])
    up.answer('draft-1', { code: 0, out: ['ok'], err: [] })
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
      { id: 'r-1', cmd: 'backup', argv: ['status'], session: 's-1', lane: null },
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
      { id: 'r-9', cmd: 'db', argv: ['restore'], session: 's-1', lane: null },
      { id: 'r-10', cmd: 'nodes', argv: ['status'], session: 's-1', lane: null },
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
        err: ["board backup is not taken from a node: run it on the board's computer"],
      },
      'r-2': {
        code: 126,
        out: [],
        err: ["only a session's command is taken from a node"],
      },
      'r-3': { code: 126, out: [], err: ['board thread share is for the owner to confirm: not from a node'] },
      'r-4': { code: 126, out: [], err: ['board thread open opens the board on its own computer: not from a node'] },
      'r-5': { code: 126, out: [], err: ['a call the board does not take'] },
      'r-6': { code: 1, out: [], err: ['a.md: not the file the node named'] },
      'r-7': { code: 1, out: [], err: ['b.md: 6 MB; 5 MB at most on a local thread'] },
      'r-8': { code: 1, out: [], err: ['/x/c.md: the node did not send it'] },
      'r-9': { code: 126, out: [], err: ["board db is not taken from a node: run it on the board's computer"] },
      'r-10': { code: 126, out: [], err: ["board nodes is not taken from a node: run it on the board's computer"] },
    })
    // The file too large is never asked for.
    expect(fetched).toEqual(['/api/node/uplink/r-6/file/0'])
    expect(existsSync(join(dir, 'nodes', 'server-1', 'uplink'))).toBe(false)
  })

  test("#619 #772 a node session's board send is queued here once for the card it names, signed with its prefixed key; another node's session too", async () => {
    const dir = isolatedHome()
    const store = createDeviceStore({ dir: join(dir, 'nodes') })
    const OTHER = '8c9d0e1f-2a3b-4c4d-9e5f-6a7b8c9d0e1f'
    const sent = [
      { id: 's-1', cmd: 'send', argv: ['Monitor', 'done: case 42'], session: 'n-1', lane: null },
      { id: 's-2', cmd: 'send', argv: ['nobody', 'x'], session: 'n-1', lane: null },
      { id: 's-3', cmd: 'send', argv: ['@server-1:n-1', 'to myself'], session: 'n-1', lane: null },
      { id: 's-4', cmd: 'send', argv: ['Monitor', 'from the twin'], session: N1, lane: null },
      // Sent again on a new stream while its command waited: queued once, the result as it was.
      { id: 's-1', cmd: 'send', argv: ['Monitor', 'done: case 42'], session: 'n-1', lane: null },
      // A card named like a thread write: not kept, and no thread command runs.
      { id: 's-5', cmd: 'send', argv: ['post', 'to post'], session: 'n-1', lane: null },
      // Another node's session (#772): reached as from the master, through its own node.
      { id: 's-6', cmd: 'send', argv: ['Elsewhere', 'x'], session: 'n-1', lane: null },
      // A node that names another node's session as its own is still signed as its own node.
      { id: 's-7', cmd: 'send', argv: ['Monitor', 'posing'], session: `@server-2:${OTHER}`, lane: null },
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
      key: `@server-2:${OTHER}`,
      session: OTHER,
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
    expect(answers('s-6')).toEqual([
      {
        code: 0,
        out: [
          'ok · queued for Elsewhere [8c9d0e1f] on node server-2: the board types it in once it is free, waking it first if it sleeps; the answer comes back as a board reminder',
        ],
        err: [],
      },
    ])
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
      { key: monitor.key, text: 'posing', from: { key: `@server-1:@server-2:${OTHER}` }, fromDevice: 'server-1' },
      { key: post.key, text: 'to post' },
      // No pane or folder: the target's node finds its session by its key.
      { key: elsewhere.key, name: 'Elsewhere', text: 'x', from: { key: '@server-1:n-1' }, fromDevice: 'server-1' },
    ])
    expect(listEntries().find(e => e.key === elsewhere.key)).not.toHaveProperty('pane')
    expect(store.seenCall('server-1', 's-1')).toEqual(queued)
  })

  test('#628 #772 board agents from a node lists every machine, a node not online marked, and is not remembered', async () => {
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
        'Other Node Secret [8c9d0e1f]  ·  claude  ·  node server-2  ·  idle  ·  node offline now: goes out once it is back',
      ],
      err: [],
    })
    expect(JSON.parse(posted.get('ag-2')?.out.join('\n') ?? '[]')).toMatchObject([
      { key: ME_M, agent: 'claude', self: false, offline: false },
      { key: `@server-1:${N1}`, agent: 'agy', device: 'server-1', self: true, offline: false },
      { key: `@server-2:${OTHER}`, agent: 'claude', device: 'server-2', self: false, offline: true },
    ])
    expect(store.seenCall('server-1', 'ag-1')).toBeNull()
  })

  test('#639 board agents --json from a node: one view a line, so 400 cards come whole', async () => {
    const dir = isolatedHome()
    const store = createDeviceStore({ dir: join(dir, 'nodes') })
    const N1 = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e'
    const many = Array.from({ length: 400 }, (_, i) => {
      const sid = `${String(i).padStart(8, '0')}-1111-4000-8000-000000000000`
      return {
        key: sid,
        session: sid,
        agent: 'claude',
        name: `Session ${i} ${'x'.repeat(150)}`,
        pane: `w1:p${i}`,
        status: 'idle',
      }
    }) as Item[]
    const posted = new Map<string, UplinkResult>()
    const link = standIn((path, init) => {
      if (path === '/api/node/uplink')
        return streamOf(
          [{ id: 'many', cmd: 'agents', argv: ['--json'], session: N1, lane: null, files: [] }],
          init.signal,
        )
      posted.set(path.split('/').pop() as string, JSON.parse(String(init.body)) as UplinkResult)
      return new Response('{}')
    })
    const runner = createUplinkRunner({
      links: link.links,
      find: () => undefined,
      items: () => many,
      cfg: { nodes: { id: 'laptop' } } as never,
      log: () => {},
      store,
    })
    link.changed('online')
    await until(() => posted.size >= 1, 5000)
    await runner.close()
    const r = posted.get('many')
    expect(r?.err).toEqual([])
    expect(r?.out.every(l => l.length < RESULT_LINE_MAX)).toBe(true)
    expect(JSON.stringify(r?.out).length).toBeGreaterThan(RESULT_LINE_MAX)
    expect(JSON.parse(r?.out.join('\n') ?? '')).toHaveLength(400)
  })

  test('#644 board time from a node runs as its prefixed key in its card lane, deduplicates writes, strips node cfg, and pulls import files safely', async () => {
    const dir = isolatedHome()
    const store = createDeviceStore({ dir: join(dir, 'nodes') })
    const csv = Buffer.from('User,Client,Project,Description,Start date,Start time,End date,End time,Duration,Tags\n')
    const sent = [
      {
        id: 'tm-1',
        cmd: 'time',
        argv: ['add', '--project', 'Support', '--minutes', '45', 'work'],
        session: 's-1',
        lane: 'spoofed',
        files: [],
      },
      // Sent again on a reconnect: write is deduplicated via ledger and not run twice.
      {
        id: 'tm-1',
        cmd: 'time',
        argv: ['add', '--project', 'Support', '--minutes', '45', 'work'],
        session: 's-1',
        lane: 'spoofed',
        files: [],
      },
      // Read: not remembered in ledger.
      { id: 'tm-2', cmd: 'time', argv: ['list', '--json'], session: 's-1', lane: null, files: [] },
      // No card on master: falls back to the node's lane.
      { id: 'tm-3', cmd: 'time', argv: ['list'], session: 's-new', lane: 'fallback-lane', files: [] },
      // Import with a file carried over uplink: rewritten to pulled copy.
      {
        id: 'tm-4',
        cmd: 'time',
        argv: ['import', '/home/node/toggl.csv', '--tz', 'UTC', '--dry-run'],
        session: 's-1',
        lane: null,
        files: [{ n: 0, name: 'toggl.csv', size: csv.length, sha256: sha(csv) }],
      },
      // Import claiming a path without sending the file: refused, never reads master's disk.
      {
        id: 'tm-5',
        cmd: 'time',
        argv: ['import', '/etc/passwd', '--tz', 'UTC'],
        session: 's-1',
        lane: null,
        files: [],
      },
      // Multi-line output exceeding 64 KB total (e.g. export / --json): split per line so fit() keeps all lines.
      { id: 'tm-6', cmd: 'time', argv: ['export'], session: 's-1', lane: null, files: [] },
    ]
    const posted: [string, UplinkResult][] = []
    const link = standIn((path, init) => {
      if (path === '/api/node/uplink') return streamOf(sent, init.signal)
      if (path === '/api/node/uplink/tm-4/file/0') return new Response(csv)
      posted.push([path.split('/').pop() as string, JSON.parse(String(init.body)) as UplinkResult])
      return new Response('{}')
    })
    const card = { key: '@server-1:s-1', category: 'atlas', name: 'worker' } as Item
    const ran: { argv: string[]; ctx: TimeCmdContext; csvText?: string }[] = []
    const runner = createUplinkRunner({
      links: link.links,
      find: key => (key === card.key ? card : undefined),
      items: () => [card],
      // Dual master+node config: `node` must be stripped before running timeCmd on the master.
      cfg: { time: { zone: 'UTC' }, node: { id: 'laptop', port: 12430 } } as never,
      log: () => {},
      store,
      runTime: async (argv, ctx) => {
        const csvText = argv[0] === 'import' ? readFileSync(argv[1] as string, 'utf8') : undefined
        ran.push({ argv: [...argv], ctx, ...(csvText !== undefined && { csvText }) })
        if (argv[0] === 'export')
          ctx.out?.(Array.from({ length: 800 }, (_, i) => `row-${i},${'x'.repeat(100)}`).join('\n'))
        else ctx.out?.(`ran ${argv[0]}`)
        return 0
      },
    })
    link.changed('online')
    await until(() => posted.length === sent.length, 5000)
    await runner.close()

    // tm-1 ran once (deduplicated), tm-2, tm-3, tm-4 ran; tm-5 was refused before runTime.
    // s-1's calls ran in order (add, list, import); s-new's call ran concurrently.
    const s1Calls = ran.filter(r => typeof r.ctx.actor !== 'string' && r.ctx.actor.key === '@server-1:s-1')
    const sNewCalls = ran.filter(r => typeof r.ctx.actor !== 'string' && r.ctx.actor.key === '@server-1:s-new')
    expect(s1Calls.map(r => r.argv[0])).toEqual(['add', 'list', 'import', 'export'])
    expect(sNewCalls.map(r => r.argv[0])).toEqual(['list'])
    expect(s1Calls[0]?.ctx.actor).toEqual({ key: '@server-1:s-1', name: 'worker' })
    expect(s1Calls[0]?.ctx.lane).toBe('atlas')
    expect(s1Calls[0]?.ctx.cfg.node).toBeUndefined()
    expect(sNewCalls[0]?.ctx.lane).toBe('fallback-lane')
    expect(s1Calls[2]?.csvText).toBe(csv.toString('utf8'))
    expect(s1Calls[2]?.argv[1]?.startsWith(join(dir, 'nodes', 'server-1', 'uplink', 'tm-4'))).toBe(true)
    expect(readdirSync(join(dir, 'nodes', 'server-1', 'uplink'))).toEqual([])

    const answers = (id: string) => posted.filter(([p]) => p === id).map(([, r]) => r)
    expect(answers('tm-1')).toEqual([
      { code: 0, out: ['ran add'], err: [] },
      { code: 0, out: ['ran add'], err: [] },
    ])
    expect(answers('tm-5')).toEqual([{ code: 1, out: [], err: ['/etc/passwd: the node did not send it'] }])
    expect(answers('tm-6')[0]?.out).toHaveLength(800)
    expect(answers('tm-6')[0]?.out.join('\n').length).toBeGreaterThan(80_000)
    expect(store.seenCall('server-1', 'tm-1')).toEqual({ code: 0, out: ['ran add'], err: [] })
    expect(store.seenCall('server-1', 'tm-2')).toBeNull()
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

  test('#698 board cal from a node deduplicates writes, pulls push --file, and refuses push without --file', async () => {
    const dir = isolatedHome()
    const store = createDeviceStore({ dir: join(dir, 'nodes') })
    const eventsJson = Buffer.from('[{"title":"Standup"}]')
    const sent = [
      {
        id: 'c-1',
        cmd: 'cal',
        argv: ['add', '--title', 'Sync', '--start', '10:00', '--minutes', '30'],
        session: 's-1',
        lane: null,
      },
      {
        id: 'c-1',
        cmd: 'cal',
        argv: ['add', '--title', 'Sync', '--start', '10:00', '--minutes', '30'],
        session: 's-1',
        lane: null,
      },
      { id: 'c-2', cmd: 'cal', argv: ['list'], session: 's-1', lane: null },
      {
        id: 'c-3',
        cmd: 'cal',
        argv: ['push', '--source', 'work', '--file', '/n/events.json'],
        session: 's-1',
        lane: null,
        files: [{ n: 0, name: 'events.json', size: eventsJson.length, sha256: sha(eventsJson) }],
      },
      { id: 'c-4', cmd: 'cal', argv: ['push', '--source', 'work'], session: 's-1', lane: null },
      {
        id: 'c-big',
        cmd: 'cal',
        argv: ['push', '--source', 'work', '--file', '/n/big.json'],
        session: 's-1',
        lane: null,
        files: [{ n: 0, name: 'big.json', size: 6 * 1024 * 1024, sha256: sha('big') }],
      },
    ]
    const posted: [string, UplinkResult][] = []
    const link = standIn((path, init) => {
      if (path === '/api/node/uplink') return streamOf(sent, init.signal)
      if (path === '/api/node/uplink/c-3/file/0') return new Response(eventsJson)
      posted.push([path.split('/').pop() as string, JSON.parse(String(init.body)) as UplinkResult])
      return new Response('{}')
    })
    const card = { key: '@server-1:s-1', category: 'atlas', name: 'worker' } as Item
    const ran: { argv: string[]; ctx: CalCmdContext; fileText?: string }[] = []
    const runner = createUplinkRunner({
      links: link.links,
      find: key => (key === card.key ? card : undefined),
      items: () => [card],
      cfg: { calendar: true, node: { id: 'server-1', port: 12430 } } as never,
      log: () => {},
      store,
      runCal: async (argv, ctx) => {
        const fileText = argv[0] === 'push' ? readFileSync(argv[4] as string, 'utf8') : undefined
        ran.push({ argv: [...argv], ctx, ...(fileText !== undefined && { fileText }) })
        ctx.out?.(`cal ${argv[0]}`)
        return 0
      },
    })
    link.changed('online')
    await until(() => posted.length === sent.length, 5000)
    await runner.close()

    expect(ran.map(r => r.argv[0])).toEqual(['add', 'list', 'push'])
    expect(ran[0]?.ctx.actor).toEqual({ key: '@server-1:s-1', name: 'worker' })
    expect(ran[0]?.ctx.cfg.node).toBeUndefined()
    expect(ran[2]?.fileText).toBe('[{"title":"Standup"}]')
    expect(ran[2]?.argv[4]?.startsWith(join(dir, 'nodes', 'server-1', 'uplink', 'c-3'))).toBe(true)
    expect(readdirSync(join(dir, 'nodes', 'server-1', 'uplink'))).toEqual([])
    const answers = (id: string) => posted.filter(([p]) => p === id).map(([, r]) => r)
    expect(answers('c-1')).toEqual([
      { code: 0, out: ['cal add'], err: [] },
      { code: 0, out: ['cal add'], err: [] },
    ])
    expect(answers('c-4')).toEqual([
      { code: 126, out: [], err: ['board cal push from a node needs --file <events.json>'] },
    ])
    expect(answers('c-big')).toEqual([{ code: 1, out: [], err: ['big.json: 6 MB; 5 MB at most from a node'] }])
    expect(store.seenCall('server-1', 'c-1')).toEqual({ code: 0, out: ['cal add'], err: [] })
    expect(store.seenCall('server-1', 'c-2')).toBeNull()
  })

  test('#698 provider-backed cal add/sync use BOARD_NODE_SLOW_MS while fast reads timeout at BOARD_NODE_READ_MS', async () => {
    const prevRead = process.env.BOARD_NODE_READ_MS
    const prevSlow = process.env.BOARD_NODE_SLOW_MS
    process.env.BOARD_NODE_READ_MS = '40'
    process.env.BOARD_NODE_SLOW_MS = '600'
    const dir = isolatedHome()
    const up = createNodeUplink({ outbox: createOutbox({ dir: join(dir, 'outbox') }), log: () => {} })
    const ac = new AbortController()
    try {
      // Connect master stream and answer each call after 120ms (longer than READ_MS=40, well within SLOW_MS=600).
      const streamRes = up.stream(new Request('http://n/api/node/uplink', { signal: ac.signal }))
      const streamed: Record<string, unknown>[] = []
      void (async () => {
        const reader = (streamRes.body as ReadableStream<Uint8Array>).getReader()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += new TextDecoder().decode(value)
          const parts = buf.split('\n\n')
          buf = parts.pop() ?? ''
          for (const p of parts) {
            if (!p.startsWith('event: call\n')) continue
            const c = JSON.parse(p.split('\n')[1]?.slice('data: '.length) ?? 'null') as {
              id: string
              argv: string[]
              claimed?: boolean
            }
            streamed.push(c)
            setTimeout(() => {
              up.answer(c.id, { code: 0, out: [`ok ${c.argv[0]}`], err: [] })
            }, 120)
          }
        }
      })()
      const slowAdd = await up.call({ cmd: 'cal', argv: ['add', '--title', 'X'], session: 's-1' })
      const slowSync = await up.call({ cmd: 'cal', argv: ['sync'], session: 's-1' })
      const fastRead = await up.call({ cmd: 'cal', argv: ['list'], session: 's-1' })
      expect(slowAdd.body).toMatchObject({ state: 'answered', code: 0, out: ['ok add'] })
      expect(slowSync.body).toMatchObject({ state: 'answered', code: 0, out: ['ok sync'] })
      expect(fastRead.body).toEqual({ state: 'unreachable' })

      // claimed flag propagates through outbox and stream for `board team post --session`.
      const outbox = createOutbox({ dir: join(dir, 'outbox') })
      const claimedCall = await up.call({
        cmd: 'team',
        argv: ['post', 'anna', 'hi'],
        session: 's-1',
        claimed: true,
        id: 'claimed-1',
      })
      expect(claimedCall.body).toMatchObject({ state: 'answered', code: 0 })
      expect(streamed.find(c => c.id === 'claimed-1')?.claimed).toBe(true)
      expect(outbox.read('claimed-1')).toBeNull()
    } finally {
      ac.abort()
      up.close()
      if (prevRead === undefined) delete process.env.BOARD_NODE_READ_MS
      else process.env.BOARD_NODE_READ_MS = prevRead
      if (prevSlow === undefined) delete process.env.BOARD_NODE_SLOW_MS
      else process.env.BOARD_NODE_SLOW_MS = prevSlow
    }
  })

  test('#760 spawn-agent’s start waits BOARD_NODE_SPAWN_MS, and one with no answer is never "unreachable"', async () => {
    const prev = { read: process.env.BOARD_NODE_READ_MS, spawn: process.env.BOARD_NODE_SPAWN_MS }
    process.env.BOARD_NODE_READ_MS = '40'
    process.env.BOARD_NODE_SPAWN_MS = '400'
    const dir = isolatedHome()
    const up = createNodeUplink({ outbox: createOutbox({ dir: join(dir, 'outbox') }), log: () => {} })
    const ac = new AbortController()
    try {
      // No master's stream: nothing was sent, so the node may start it itself.
      expect((await up.call({ cmd: 'spawn', argv: ['{}'], session: 's-1' })).body).toEqual({ state: 'unreachable' })
      const streamRes = up.stream(new Request('http://n/api/node/uplink', { signal: ac.signal }))
      let answer = true
      void (async () => {
        const reader = (streamRes.body as ReadableStream<Uint8Array>).getReader()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += new TextDecoder().decode(value)
          const parts = buf.split('\n\n')
          buf = parts.pop() ?? ''
          for (const p of parts) {
            if (!p.startsWith('event: call\n')) continue
            const c = JSON.parse(p.split('\n')[1]?.slice('data: '.length) ?? 'null') as { id: string }
            if (answer) setTimeout(() => up.answer(c.id, { code: 0, out: ['pane=@server-2:w1:p1'], err: [] }), 120)
          }
        }
      })()
      // Answered after READ_MS: a start waits its own, longer time.
      expect((await up.call({ cmd: 'spawn', argv: ['{}'], session: 's-1' })).body).toMatchObject({
        state: 'answered',
        code: 0,
      })
      // Taken and never answered: it may run by now, so it fails rather than reading as not sent.
      answer = false
      expect((await up.call({ cmd: 'spawn', argv: ['{}'], session: 's-1' })).body).toEqual({
        state: 'answered',
        code: 1,
        out: [],
        err: ["the board's computer did not say what became of the start: see the board before starting it again"],
      })
    } finally {
      ac.abort()
      up.close()
      if (prev.read === undefined) delete process.env.BOARD_NODE_READ_MS
      else process.env.BOARD_NODE_READ_MS = prev.read
      if (prev.spawn === undefined) delete process.env.BOARD_NODE_SPAWN_MS
      else process.env.BOARD_NODE_SPAWN_MS = prev.spawn
    }
  })

  test('#698 board team refuses join/watch/listen/loop-set, pulls post --file, deduplicates writes, and allows uplink files in boardOwnFile', async () => {
    const dir = isolatedHome()
    // Verify boardOwnFile allows nodes/<id>/uplink/<callId>/file.txt and blocks nodes/<id>/token.
    const uplinkCopy = join(stateDir(), 'nodes', 'server-1', 'uplink', 'tm-1', 'note.txt')
    const tokenFile = join(stateDir(), 'nodes', 'server-1', 'token')
    mkdirSync(join(uplinkCopy, '..'), { recursive: true })
    writeFileSync(uplinkCopy, 'safe text')
    writeFileSync(tokenFile, 'secret')
    expect(boardOwnFile(uplinkCopy)).toBe(false)
    expect(boardOwnFile(tokenFile)).toBe(true)

    const store = createDeviceStore({ dir: join(dir, 'nodes') })
    const note = Buffer.from('hello team')
    const sent = [
      {
        id: 't-join',
        cmd: 'team',
        argv: ['join', 'inv', '--hub', 'ws://h:7443', '--name', 'n'],
        session: 's-1',
        lane: null,
      },
      { id: 't-watch', cmd: 'team', argv: ['watch'], session: 's-1', lane: null },
      { id: 't-listen', cmd: 'team', argv: ['listen'], session: 's-1', lane: null },
      { id: 't-loop-set', cmd: 'team', argv: ['loop', 'anna', '5'], session: 's-1', lane: null },
      { id: 't-loop-read', cmd: 'team', argv: ['loop', 'anna'], session: 's-1', lane: null },
      { id: 't-listen-off', cmd: 'team', argv: ['listen', 'off'], session: 's-1', lane: null },
      { id: 't-draft', cmd: 'team', argv: ['draft', 'anna', 'hi'], session: 's-1', lane: null },
      { id: 't-draft', cmd: 'team', argv: ['draft', 'anna', 'hi'], session: 's-1', lane: null },
      {
        id: 't-post',
        cmd: 'team',
        argv: ['post', 'anna', '--file', '/n/note.txt', 'see file'],
        session: 's-1',
        lane: null,
        claimed: true,
        files: [{ n: 0, name: 'note.txt', size: note.length, sha256: sha(note) }],
      },
      { id: 't-read', cmd: 'team', argv: ['thread', 'anna', '--read'], session: 's-1', lane: null },
      { id: 't-thread', cmd: 'team', argv: ['thread', 'anna'], session: 's-1', lane: null },
    ]
    const posted: [string, UplinkResult][] = []
    const link = standIn((path, init) => {
      if (path === '/api/node/uplink') return streamOf(sent, init.signal)
      if (path === '/api/node/uplink/t-post/file/0') return new Response(note)
      posted.push([path.split('/').pop() as string, JSON.parse(String(init.body)) as UplinkResult])
      return new Response('{}')
    })
    const card = { key: '@server-1:s-1', category: 'atlas', name: 'worker' } as Item
    const ran: { argv: string[]; fileText?: string }[] = []
    const runner = createUplinkRunner({
      links: link.links,
      find: key => (key === card.key ? card : undefined),
      items: () => [card],
      cfg: { team: { hub: 'ws://127.0.0.1:1', name: 'master' } } as never,
      log: () => {},
      store,
      runTeam: async argv => {
        const fileText = argv[0] === 'post' ? readFileSync(argv[3] as string, 'utf8') : undefined
        ran.push({ argv: [...argv], ...(fileText !== undefined && { fileText }) })
        return { code: 0, out: [`team ${argv[0]}`], err: [] }
      },
    })
    link.changed('online')
    await until(() => posted.length === sent.length, 5000)
    await runner.close()

    const byId = (id: string) => posted.filter(([p]) => p === id).map(([, r]) => r)
    expect(byId('t-join')[0]?.code).toBe(126)
    expect(byId('t-watch')[0]?.code).toBe(126)
    expect(byId('t-listen')[0]?.code).toBe(126)
    expect(byId('t-loop-set')[0]?.code).toBe(126)
    expect(ran.map(r => r.argv[0])).toEqual(['loop', 'listen', 'draft', 'post', 'thread', 'thread'])
    expect(ran.find(r => r.argv[0] === 'post')?.fileText).toBe('hello team')
    expect(store.seenCall('server-1', 't-draft')).toEqual({ code: 0, out: ['team draft'], err: [] })
    expect(store.seenCall('server-1', 't-read')).toEqual({ code: 0, out: ['team thread'], err: [] })
    expect(store.seenCall('server-1', 't-thread')).toBeNull()

    // Plain-board threadData keeps file.path, while node hideFilePaths omits master filesystem paths.
    const linesWithFile = [
      {
        dir: 'in',
        id: 'm1',
        ts: '2026-11-24T10:00:00Z',
        text: 'hi',
        file: { state: 'ready', name: 'a.txt', size: 12, path: '/srv/master/uploads/a.txt' },
      },
    ]
    expect(
      (
        threadData('anna:t1', { title: 'T' }, linesWithFile, 'Anna', false, false) as {
          lines: { file: Record<string, unknown> }[]
        }
      ).lines[0]?.file.path,
    ).toBe('/srv/master/uploads/a.txt')
    expect(
      (
        threadData('anna:t1', { title: 'T' }, linesWithFile, 'Anna', false, true) as {
          lines: { file: Record<string, unknown> }[]
        }
      ).lines[0]?.file.path,
    ).toBeUndefined()
  })

  test('#698 decisions, journal, presence/away, cats, list, remind/every, and unschedule enforce trust boundary and dedup writes (spend refused)', async () => {
    const dir = isolatedHome()
    const store = createDeviceStore({ dir: join(dir, 'nodes') })
    const mine = {
      key: '@server-1:s-1',
      session: 's-1',
      name: 'NodeOne',
      category: 'atlas',
      column: 'work',
      status: 'working',
      doing: 'node work',
    } as Item
    const masterItem = {
      key: '11111111-1111-4111-8111-111111111111',
      session: '11111111-1111-4111-8111-111111111111',
      name: 'MasterSession',
      pane: 'w1:p1',
      cwd: '/srv/master',
      category: 'personal',
      column: 'idle',
      status: 'idle',
      doing: 'private secret master note',
    } as Item
    const otherNode = {
      key: '@server-2:22222222-2222-4222-8222-222222222222',
      session: '22222222-2222-4222-8222-222222222222',
      name: 'HiddenPeer',
      device: 'server-2',
      pane: 'w9:p9',
      category: 'other',
      column: 'work',
      status: 'working',
    } as Item
    const otherEntry = addEntry({
      key: masterItem.key,
      name: 'MasterSession',
      text: 'owners reminder',
      at: Date.now() + 600_000,
      next: Date.now() + 600_000,
      by: 'agent',
    })
    const items = [mine, masterItem, otherNode]

    const sent = [
      { id: 'd-1', cmd: 'decisions', argv: ['--done', '--json'], session: 's-1', lane: null },
      { id: 'j-1', cmd: 'journal', argv: ['--since', '1h', '--json'], session: 's-1', lane: null },
      { id: 'p-read', cmd: 'presence', argv: [], session: 's-1', lane: null },
      { id: 'p-set', cmd: 'presence', argv: ['away'], session: 's-1', lane: null },
      { id: 'p-set', cmd: 'presence', argv: ['away'], session: 's-1', lane: null },
      { id: 'p-bad', cmd: 'away', argv: ['bogus'], session: 's-1', lane: null },
      { id: 'sp-1', cmd: 'spend', argv: ['--day', 'today', '--json'], session: 's-1', lane: null },
      { id: 'ct-1', cmd: 'cats', argv: [], session: 's-1', lane: null },
      { id: 'ls-1', cmd: 'list', argv: [], session: 's-1', lane: null },
      { id: 'rm-no-target', cmd: 'remind', argv: ['in', '10m', 'ping'], session: 's-1', lane: null },
      {
        id: 'rm-other-node',
        cmd: 'remind',
        argv: ['--session', 'HiddenPeer', 'in', '10m', 'ping'],
        session: 's-1',
        lane: null,
      },
      {
        id: 'rm-ok',
        cmd: 'remind',
        argv: ['--session', 'MasterSession', '--idle', 'in', '10m', 'ping master'],
        session: 's-1',
        lane: null,
      },
      {
        id: 'rm-ok',
        cmd: 'remind',
        argv: ['--session', 'MasterSession', '--idle', 'in', '10m', 'ping master'],
        session: 's-1',
        lane: null,
      },
      {
        id: 'ev-ok',
        cmd: 'every',
        argv: ['--session', 'MasterSession', '0 9 * * 1-5', 'daily check'],
        session: 's-1',
        lane: null,
      },
      { id: 'un-other', cmd: 'unschedule', argv: [otherEntry.id], session: 's-1', lane: null },
      { id: 'un-all', cmd: 'unschedule', argv: ['all'], session: 's-1', lane: null },
    ]
    const posted: [string, UplinkResult][] = []
    const link = standIn((path, init) => {
      if (path === '/api/node/uplink') return streamOf(sent, init.signal)
      posted.push([path.split('/').pop() as string, JSON.parse(String(init.body)) as UplinkResult])
      return new Response('{}')
    })

    let presenceSetCalls = 0
    const runner = createUplinkRunner({
      links: link.links,
      find: key => items.find(i => i.key === key),
      items: () => items,
      cfg: {
        decisions: true,
        journal: true,
        presence: true,
        categories: [
          { id: 'atlas', title: 'Atlas', color: 'cyan', paths: [] },
          { id: 'personal', title: 'Personal', color: 'green', paths: [] },
        ],
        node: { id: 'server-1', port: 12430 },
      } as never,
      log: () => {},
      store,
      setPresence: state => {
        presenceSetCalls++
        return { presence: { state, since: 1, by: 'user', via: 'agent' }, changed: true }
      },
      runDecisions: (words, _now, out) => {
        out(`dec ${words.join(' ')}`)
      },
      runJournal: (args, ctx) => {
        ctx.out(`journal ${args.join(' ')}`)
        return 0
      },
    })
    link.changed('online')
    await until(() => posted.length === sent.length, 5000)
    await runner.close()

    const byId = (id: string) => posted.filter(([p]) => p === id).map(([, r]) => r)
    expect(byId('d-1')[0]).toEqual({ code: 0, out: ['dec --done --json'], err: [] })
    expect(byId('j-1')[0]).toEqual({ code: 0, out: ['journal --since 1h --json'], err: [] })
    expect(byId('p-read')[0]?.code).toBe(0)
    expect(byId('p-set')).toEqual([
      { code: 0, out: ['ok · away'], err: [] },
      { code: 0, out: ['ok · away'], err: [] },
    ])
    expect(presenceSetCalls).toBe(1)
    expect(byId('p-bad')[0]).toEqual({ code: 1, out: [], err: ['usage: board away [on|off]'] })
    // spend stays local on nodes and is refused on the master uplink (126).
    expect(byId('sp-1')[0]?.code).toBe(126)
    expect(byId('ct-1')[0]).toEqual({
      code: 0,
      out: ['atlas (Atlas), personal (Personal). A new id makes a new lane.'],
      err: [],
    })
    const listText = byId('ls-1')[0]?.out.join('\n') ?? ''
    expect(listText).toContain('NodeOne [atlas]')
    expect(listText).toContain('MasterSession [personal]')
    // Another node's card too (#772), without its notes as any card.
    expect(listText).toContain('HiddenPeer [other]')
    expect(listText).not.toContain('private secret master note')
    expect(listText).not.toContain('node work')
    // Shared formatter includes notes only when includeNote is explicitly true (local board list).
    expect(
      formatListLines(
        [masterItem],
        { categories: [{ id: 'personal', title: 'Personal', color: 'green', paths: [] }] } as never,
        { includeNote: true },
      ).join('\n'),
    ).toContain('private secret master note')

    expect(byId('rm-no-target')[0]?.code).toBe(126)
    expect(byId('rm-other-node')[0]?.code).toBe(0)
    expect(byId('rm-ok')).toHaveLength(2)
    expect(byId('rm-ok')[0]).toEqual(byId('rm-ok')[1])
    expect(byId('rm-ok')[0]?.out[0]).toContain('when the session is free')
    expect(byId('ev-ok')[0]?.out[0]).toContain('every ')

    // Master schedule has otherEntry + 2 reminds + 1 every (rm-ok ran once).
    const created = listEntries().filter(e => e.from?.key === '@server-1:s-1')
    expect(created).toHaveLength(3)
    // Another node's session (#772): its key alone, its node finds the pane.
    const toPeer = created.find(e => e.key === otherNode.key)
    expect(toPeer).toMatchObject({ name: 'HiddenPeer', text: 'ping', from: { key: '@server-1:s-1', name: 'NodeOne' } })
    expect(toPeer).not.toHaveProperty('pane')
    expect(toPeer).not.toHaveProperty('cwd')
    expect(created.find(e => e.text === 'ping master')).toMatchObject({
      key: masterItem.key,
      pane: 'w1:p1',
      cwd: '/srv/master',
      idle: true,
      from: { key: '@server-1:s-1', name: 'NodeOne' },
    })
    expect(byId('un-other')[0]?.code).toBe(126)
    // All of the calling session's (#806): none held here for it, and nothing of anyone else's goes.
    expect(byId('un-all')[0]).toEqual({
      code: 0,
      out: ["ok · removed 0 entries held by the board's computer"],
      err: [],
    })
    expect(listEntries().some(e => e.id === otherEntry.id)).toBe(true)

    // Caller can unschedule its own created entry over the uplink.
    const createdId = created[0]?.id as string
    const posted2: UplinkResult[] = []
    const link2 = standIn((path, init) => {
      if (path === '/api/node/uplink')
        return streamOf(
          [{ id: 'un-mine', cmd: 'unschedule', argv: [createdId], session: 's-1', lane: null }],
          init.signal,
        )
      posted2.push(JSON.parse(String(init.body)) as UplinkResult)
      return new Response('{}')
    })
    const runner2 = createUplinkRunner({
      links: link2.links,
      find: key => items.find(i => i.key === key),
      items: () => items,
      cfg: {} as never,
      log: () => {},
      store,
    })
    link2.changed('online')
    await until(() => posted2.length === 1, 5000)
    await runner2.close()
    expect(posted2[0]?.code).toBe(0)
    expect(posted2[0]?.out[0]).toContain(`ok · removed ${createdId}`)
    expect(listEntries().some(e => e.id === createdId)).toBe(false)
  })

  test("#806 a node's board schedule lists what this board holds for that session, and unschedule reaches it", async () => {
    const dir = isolatedHome()
    const store = createDeviceStore({ dir: join(dir, 'nodes') })
    const mine = { key: '@server-1:s-1', session: 's-1', name: 'NodeOne', column: 'work', status: 'idle' } as Item
    const peer = { key: '@server-1:s-2', session: 's-2', name: 'NodeTwo', column: 'work', status: 'idle' } as Item
    const masters = { key: N1, session: N1, name: 'Atlas', pane: 'w1:p1', column: 'idle', status: 'idle' } as Item
    const items = [mine, peer, masters]
    // As a handover leaves them: keyed by the node's prefix, no `from`.
    const next = Date.UTC(2030, 0, 2, 3, 57)
    const daily = addEntry({
      key: mine.key,
      name: 'NodeOne',
      text: 'monitor cycle',
      cron: '57 7 * * *',
      next,
      by: 'agent',
    })
    const once = addEntry({
      key: mine.key,
      name: 'NodeOne',
      text: 'call back',
      at: next,
      next,
      idle: true,
      by: 'agent',
    })
    const theirs = addEntry({ key: peer.key, name: 'NodeTwo', text: 'not yours', at: next, next, by: 'agent' })
    const own = addEntry({ key: N1, name: 'Atlas', text: 'the master s own', at: next, next, by: 'agent' })

    const run = async (sent: Record<string, unknown>[]): Promise<Map<string, UplinkResult>> => {
      const got = new Map<string, UplinkResult>()
      const link = standIn((path, init) => {
        if (path === '/api/node/uplink') return streamOf(sent, init.signal)
        got.set(path.split('/').pop() as string, JSON.parse(String(init.body)) as UplinkResult)
        return new Response('{}')
      })
      const runner = createUplinkRunner({
        links: link.links,
        find: key => items.find(i => i.key === key),
        items: () => items,
        cfg: { time: { zone: 'Asia/Yerevan' }, node: { id: 'server-1', port: 12430 } } as never,
        log: () => {},
        store,
      })
      link.changed('online')
      await until(() => got.size === sent.length, 5000)
      await runner.close()
      return got
    }

    const listed = await run([
      { id: 'sc-1', cmd: 'schedule', argv: [], session: 's-1', lane: null },
      { id: 'sc-x', cmd: 'schedule', argv: [], session: 's-3', lane: null },
    ])
    expect(listed.get('sc-1')?.code).toBe(0)
    // On the owner's clock: 03:57 UTC is 07:57 in Yerevan.
    expect(
      listed
        .get('sc-1')
        ?.out.map(l => l.replace(/\(in [^)]+\)/, '(in …)'))
        .sort(),
    ).toEqual(
      [
        `${daily.id} · Wed 2030-01-02 07:57 (in …) · every "57 7 * * *" · on time · monitor cycle`,
        `${once.id} · Wed 2030-01-02 07:57 (in …) · once · when free · call back`,
      ].sort(),
    )
    // A session it holds nothing for: no line, nothing of the others'.
    expect(listed.get('sc-x')).toEqual({ code: 0, out: [], err: [] })

    const removed = await run([
      { id: 'un-1', cmd: 'unschedule', argv: [once.id], session: 's-1', lane: null },
      { id: 'un-x', cmd: 'unschedule', argv: [theirs.id], session: 's-1', lane: null },
    ])
    expect(removed.get('un-1')?.out[0]).toContain(`ok · removed ${once.id}`)
    expect(removed.get('un-x')?.code).toBe(126)
    const all = await run([{ id: 'un-all-1', cmd: 'unschedule', argv: ['all'], session: 's-1', lane: null }])
    expect(all.get('un-all-1')).toEqual({
      code: 0,
      out: ["ok · removed 1 entry held by the board's computer"],
      err: [],
    })
    expect(
      listEntries()
        .map(e => e.id)
        .sort(),
    ).toEqual([theirs.id, own.id].sort())
  })
})
