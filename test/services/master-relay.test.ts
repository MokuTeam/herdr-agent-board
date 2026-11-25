// The master relay end to end in one process (#764): the node's half (services/node/master-relay.ts)
// behind its route, the master's runner (services/nodes/master-relay.ts) on a link that calls the
// node's door side, and a master whose routes are run as app.ts runs them (remote owner's refusals,
// guards as a remote caller).
// - GET, POST and the SSE stream of the threads group cross; the caller's Origin and cookie do not.
// - A write keyed twice runs once; the node keys each write of its own.
// - No master on the stream: 503 node-master-offline; a slow master: 504.
// - Who: the owner from any device unless the master's owner turned it off; a session of the node reads but
//   does not write; one the node does not have, and a caller through a remote listener, are refused.
// - Another machine's session goes on to the master's node proxy; the master's own key loses its prefix.
// - What is not the relay's, and a board without `node`, go down the same routes as before.
import { describe, expect, onTestFinished, test } from 'bun:test'
import type { RelayWho } from '../../src/core/master-relay.ts'
import type { Config, Item } from '../../src/core/types.ts'
import { dispatch, json, type Route } from '../../src/server/http.ts'
import { masterRelayRoute } from '../../src/server/routes/node.ts'
import { decoded, remoteRefusal } from '../../src/server/streams.ts'
import { createMasterRelay, type MasterRelay } from '../../src/services/node/master-relay.ts'
import type { Link } from '../../src/services/nodes/link.ts'
import { createMasterRelayRunner } from '../../src/services/nodes/master-relay.ts'

const NODE_PORT = 12430
const NODE_GUARDS = { port: NODE_PORT, token: 'node-token', stale: () => false }

interface Seen {
  method: string
  path: string
  headers: Record<string, string>
  body: string
  who: RelayWho
}

function nodeItem(key: string): Item {
  return {
    key,
    session: `sid-${key}`,
    pane: 'p1',
    workspace: 'w',
    status: 'idle',
    name: 'Atlas',
    autoName: 'Atlas',
    category: 'atlas',
    categorySet: true,
    column: 'idle',
    attention: '',
    agent: 'claude',
  } as Item
}

/** The master's own routes, as a remote owner reaches them through replayRelayed (server/app.ts). */
function masterBoard() {
  const seen: Seen[] = []
  let writes = 0
  let streamEnded = false
  let hang: Promise<void> | null = null
  let failNext = 0
  const routes: Route[] = [
    { method: 'GET', path: '/api/threads', handle: () => json(200, { ok: true, threads: [{ key: 'atlas-1' }] }) },
    { method: 'POST', path: '/api/decisions', handle: () => json(200, { ok: true }) },
    {
      method: 'GET',
      path: '/api/threads/events',
      handle(req) {
        const enc = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode('event: rev\ndata: {"rev":1}\n\n'))
            req.signal.addEventListener('abort', () => {
              streamEnded = true
              try {
                c.close()
              } catch {}
            })
          },
          pull(c) {
            setTimeout(() => {
              try {
                c.enqueue(enc.encode('event: rev\ndata: {"rev":2}\n\n'))
              } catch {}
            }, 20)
          },
          cancel() {
            streamEnded = true
          },
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
      },
    },
    {
      method: 'GET',
      path: /^\/api\/threads\/([^/]+)$/,
      async handle(_req, ctx) {
        if (hang) await hang
        return json(200, { ok: true, key: ctx.params[0] })
      },
    },
    {
      method: 'POST',
      path: /^\/api\/threads(\/[^/]+)?$/,
      guard: ['board-header'],
      async handle(_req, ctx) {
        if (failNext > 0) {
          failNext--
          return json(503, { error: 'handover-frozen' })
        }
        if (hang) await hang
        writes++
        return json(200, { ok: true, n: writes, got: await ctx.rawBody() })
      },
    },
    // The node proxy's place: another device's session.
    {
      method: 'ANY',
      path: /^\/api\/session\//,
      handle: (req, ctx) => json(200, { proxied: ctx.rawPath, method: req.method }),
    },
  ]
  return {
    seen,
    writes: () => writes,
    streamEnded: () => streamEnded,
    setHang(p: Promise<void> | null) {
      hang = p
    },
    failWrites(n: number) {
      failNext = n
    },
    async replay(req: Request, o: { device: string; who: RelayWho }): Promise<Response> {
      const url = new URL(req.url)
      const clone = req.clone()
      seen.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(req.headers),
        body: req.method === 'GET' ? '' : await clone.text(),
        who: o.who,
      })
      const raw = url.pathname
      const path = decoded(raw) ?? raw
      const refused = remoteRefusal(raw, path, false, false, true, false)
      if (refused) return refused
      return dispatch(routes, req, url, path, { port: 12422, token: 'master-token', stale: () => false, remote: true })
    },
  }
}

/** A link to the node whose door is the relay's door side, in this process. */
function linkTo(relay: MasterRelay): Link {
  return {
    id: 'server-1',
    state: () => ({ state: 'online', since: 0, heardAt: 0 }),
    async fetch(path: string, init?: RequestInit) {
      const req = new Request(`http://door${path}`, init)
      if (path === '/api/node/master-relay') return relay.stream(req)
      let m = /^\/api\/node\/master-relay\/req\/([^/]+)\/body$/.exec(path)
      if (m) return relay.reqBody(m[1] ?? '')
      m = /^\/api\/node\/master-relay\/res\/([^/]+)$/.exec(path)
      if (m) {
        const a = relay.respond(m[1] ?? '', await req.json())
        return Response.json(a.body, { status: a.status })
      }
      m = /^\/api\/node\/master-relay\/stream\/([^/]+)$/.exec(path)
      if (m) {
        const a = await relay.chunk(m[1] ?? '', await req.json(), req.signal)
        return Response.json(a.body, { status: a.status })
      }
      return new Response('', { status: 404 })
    },
  } as unknown as Link
}

const LOCAL_ROUTE: Route = {
  method: 'ANY',
  path: /^\//,
  handle: req => json(409, { local: true, path: new URL(req.url).pathname }),
}

interface Rig {
  relay: MasterRelay
  master: ReturnType<typeof masterBoard>
  ask(path: string, init?: RequestInit & { remote?: boolean }): Promise<Response>
}

async function rig(
  o: {
    owner?: boolean
    master?: boolean
    node?: boolean
    headMs?: number
    sessions?: string[]
    relayed?: (method: string, rawPath: string, status: number) => void
  } = {},
): Promise<Rig> {
  const cfg = (o.node === false ? {} : { node: { id: 'server-1', port: NODE_PORT, workRoot: '/tmp' } }) as Config
  const items = (o.sessions ?? ['pane-p1']).map(nodeItem)
  const relay = createMasterRelay({ cfg, items: () => items, log: () => {}, ...(o.headMs && { headMs: o.headMs }) })
  onTestFinished(() => relay.close())
  const master = masterBoard()
  const route = masterRelayRoute(relay, o.relayed)
  const ask = async (path: string, init: RequestInit & { remote?: boolean } = {}): Promise<Response> => {
    const { remote, ...rest } = init
    const req = new Request(`http://127.0.0.1:${NODE_PORT}${path}`, rest)
    const url = new URL(req.url)
    return dispatch([route, LOCAL_ROUTE], req, url, decodeURIComponent(url.pathname), {
      ...NODE_GUARDS,
      ...(remote && { remote: true }),
    })
  }
  if (o.master !== false) {
    const link = linkTo(relay)
    const listeners = new Set<(id: string) => void>()
    const runner = createMasterRelayRunner({
      links: {
        link: id => (id === 'server-1' ? link : null),
        onChange: fn => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
      },
      log: () => {},
      deviceIds: () => ['server-1'],
      selfId: () => 'laptop',
      ownerAllowed: id => id === 'server-1' && o.owner !== false,
      sessionKnown: (id, key) => id === 'server-1' && items.some(i => i.key === key),
      replay: (req, x) => master.replay(req, x),
    })
    onTestFinished(() => runner.close())
    runner.sync()
    // The master's stream is up once a request no longer finds the master away.
    const deadline = Date.now() + 3000
    for (;;) {
      const res = await ask('/api/threads')
      if (res.status !== 503) break
      if (Date.now() > deadline) throw new Error('the master never took the stream')
      await Bun.sleep(10)
    }
    master.seen.length = 0
  }
  return { relay, master, ask }
}

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
  body: JSON.stringify(body),
})

describe('the threads group crosses to the master', () => {
  test("GET answers with the master's status, type and body; the caller's Origin and cookie stay on the node", async () => {
    const r = await rig()
    const res = await r.ask('/api/threads?lane=atlas', {
      headers: { cookie: 'login=x', origin: 'http://127.0.0.1:12430' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ ok: true, threads: [{ key: 'atlas-1' }] })
    expect(r.master.seen).toHaveLength(1)
    const seen = r.master.seen[0] as Seen
    expect(seen.path).toBe('/api/threads?lane=atlas')
    expect(seen.who).toEqual({ kind: 'owner' })
    expect(seen.headers.cookie).toBeUndefined()
    expect(seen.headers.origin).toBeUndefined()
  })

  test("what went up is told with the master's answer (#784: a decision's change refreshes the page); a local path is not", async () => {
    const told: [string, string, number][] = []
    const r = await rig({ relayed: (m, p, s) => told.push([m, p, s]) })
    told.length = 0
    expect((await r.ask('/api/decisions', post({ op: 'hold', key: 'pane-p1', id: 'd1' }))).status).toBe(200)
    expect((await r.ask('/api/threads')).status).toBe(200)
    expect((await r.ask('/api/session/pane-p1/send', post({ text: 'x' }))).status).toBe(409)
    expect(told).toEqual([
      ['POST', '/api/decisions', 200],
      ['GET', '/api/threads', 200],
    ])
  })

  test('a thread by key, its encoded spelling kept', async () => {
    const r = await rig()
    const res = await r.ask('/api/threads/%D0%B0%D1%82-1')
    expect(await res.json()).toEqual({ ok: true, key: 'ат-1' })
  })

  test('POST carries the body and the header; one without X-Board is refused on the node, never sent', async () => {
    const r = await rig()
    const ok = await r.ask('/api/threads/atlas-1', post({ op: 'post', text: 'hi ☃ %' }))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, n: 1, got: { op: 'post', text: 'hi ☃ %' } })
    const bare = await r.ask('/api/threads/atlas-1', { method: 'POST', body: '{}' })
    expect(bare.status).toBe(403)
    const foreign = await r.ask('/api/threads/atlas-1', post({}, { origin: 'https://evil.example' }))
    expect(foreign.status).toBe(403)
    expect(r.master.writes()).toBe(1)
  })

  test('a body larger than the inline size is fetched from the node', async () => {
    const r = await rig()
    const text = 'x'.repeat(100 * 1024)
    const res = await r.ask('/api/threads', post({ op: 'new', text }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { got: { text: string } }).got.text).toHaveLength(text.length)
  })

  test('the events stream comes as it is written, and ends on the master when the caller goes', async () => {
    const r = await rig()
    const ac = new AbortController()
    const res = await r.ask('/api/threads/events', { signal: ac.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    let text = ''
    while (!text.includes('"rev":2')) {
      const next = await reader.read()
      if (next.done) break
      text += new TextDecoder().decode(next.value)
    }
    expect(text).toContain('event: rev\ndata: {"rev":1}')
    expect(text).toContain('"rev":2')
    ac.abort()
    await reader.cancel().catch(() => {})
    const deadline = Date.now() + 2000
    while (!r.master.streamEnded() && Date.now() < deadline) await Bun.sleep(10)
    expect(r.master.streamEnded()).toBe(true)
  })
})

describe('a write keyed twice runs once', () => {
  test("the caller's Idempotency-Key: the same answer again, the write done once", async () => {
    const r = await rig()
    const a = await r.ask('/api/threads/atlas-1', post({ op: 'post', text: 'once' }, { 'idempotency-key': 'call-1' }))
    const b = await r.ask('/api/threads/atlas-1', post({ op: 'post', text: 'once' }, { 'idempotency-key': 'call-1' }))
    expect(await a.json()).toEqual({ ok: true, n: 1, got: { op: 'post', text: 'once' } })
    expect(await b.json()).toEqual({ ok: true, n: 1, got: { op: 'post', text: 'once' } })
    expect(r.master.writes()).toBe(1)
    const c = await r.ask('/api/threads/atlas-1', post({ op: 'post', text: 'other' }, { 'idempotency-key': 'call-2' }))
    expect(((await c.json()) as { n: number }).n).toBe(2)
  })

  test('without one, the node keys each write itself: two writes run twice', async () => {
    const r = await rig()
    await r.ask('/api/threads/atlas-1', post({ op: 'post', text: 'a' }))
    await r.ask('/api/threads/atlas-1', post({ op: 'post', text: 'a' }))
    expect(r.master.writes()).toBe(2)
  })
})

describe('the master away, or slow', () => {
  test("no master on the stream: 503 node-master-offline, not the node's own 409", async () => {
    const r = await rig({ master: false })
    for (const [path, init] of [
      ['/api/threads', {}],
      ['/api/threads/events', {}],
      ['/api/threads/atlas-1', post({ op: 'post', text: 'x' })],
    ] as const) {
      const res = await r.ask(path, init)
      expect(res.status).toBe(503)
      const body = (await res.json()) as { error: string; message: string }
      expect(body.error).toBe('node-master-offline')
      expect(body.message).toContain('master')
    }
  })

  test('a head that does not come in time: 504', async () => {
    const r = await rig({ headMs: 150 })
    let release = (): void => {}
    r.master.setHang(new Promise<void>(resolve => (release = resolve)))
    const res = await r.ask('/api/threads/atlas-1')
    expect(res.status).toBe(504)
    expect(((await res.json()) as { error: string }).error).toBe('master-relay-timeout')
    release()
  })
})

describe('who a relayed request is', () => {
  test("a device the master's owner turned off (owner: false): 403 with what it means, nothing run", async () => {
    const r = await rig({ owner: false })
    const res = await r.ask('/api/threads/atlas-1', post({ op: 'post', text: 'x' }))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('master-relay-owner')
    expect(body.message).toContain('nodes.devices.<id>.owner: false')
    expect(r.master.writes()).toBe(0)
    expect(r.master.seen).toHaveLength(0)
  })

  test("a session of the node reads as itself, threads and another machine's session alike", async () => {
    const r = await rig()
    const res = await r.ask('/api/threads', { headers: { 'x-board-session': 'sid-pane-p1' } })
    expect(res.status).toBe(200)
    expect(r.master.seen[0]?.who).toEqual({ kind: 'session', key: 'pane-p1' })
    const other = await r.ask('/api/session/@ben:pane-p2', { headers: { 'x-board-session': 'pane-p1' } })
    expect(await other.json()).toEqual({ proxied: '/api/session/@ben:pane-p2', method: 'GET' })
  })

  test('a device turned off refuses its sessions too: the switch is on the device, not on who asks', async () => {
    const r = await rig({ owner: false })
    const res = await r.ask('/api/threads', { headers: { 'x-board-session': 'sid-pane-p1' } })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('master-relay-owner')
    expect(r.master.seen).toHaveLength(0)
  })

  test('a session does not write; one the node does not have is refused on the node', async () => {
    const r = await rig()
    const w = await r.ask('/api/threads/atlas-1', post({ op: 'post' }, { 'x-board-session': 'pane-p1' }))
    expect(w.status).toBe(403)
    expect(((await w.json()) as { error: string }).error).toBe('master-relay-session-write')
    const unknown = await r.ask('/api/threads', { headers: { 'x-board-session': 'pane-zz' } })
    expect(unknown.status).toBe(403)
    expect(((await unknown.json()) as { error: string }).error).toBe('master-relay-session')
    expect(r.master.seen).toHaveLength(0)
  })

  test("through the node's remote listener: refused, the master never asked", async () => {
    const r = await rig()
    const res = await r.ask('/api/threads', { remote: true })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('master-relay-remote')
    expect(r.master.seen).toHaveLength(0)
  })
})

describe("other machines' sessions", () => {
  test("another device goes on to the node proxy as it came; the master's own key loses its prefix", async () => {
    const r = await rig()
    const other = await r.ask('/api/session/@ben:pane-p2/message', post({ text: 'hi' }))
    expect(await other.json()).toEqual({ proxied: '/api/session/@ben:pane-p2/message', method: 'POST' })
    const own = await r.ask('/api/session/%40laptop%3Apane%2F1/message', post({ text: 'hi' }))
    expect(await own.json()).toEqual({ proxied: '/api/session/pane%2F1/message', method: 'POST' })
  })

  test("this node's own key and a desktop action are not relayed or are refused as for a remote owner", async () => {
    const r = await rig()
    const mine = await r.ask('/api/session/@server-1:pane-p1/message', post({ text: 'hi' }))
    expect(await mine.json()).toEqual({ local: true, path: '/api/session/@server-1:pane-p1/message' })
    const focus = await r.ask('/api/session/@ben:pane-p2/focus', post({}))
    expect(focus.status).toBe(403)
    expect(await focus.json()).toEqual({ error: 'desktop' })
  })
})

describe('the ledger keeps what a retry may reuse, and only that', () => {
  test('a failure that may pass (503) is not remembered: the retry with the same key runs', async () => {
    const r = await rig()
    r.master.failWrites(1)
    const first = await r.ask('/api/threads/atlas-1', post({ op: 'post', text: 'x' }, { 'idempotency-key': 'k-503' }))
    expect(first.status).toBe(503)
    const retry = await r.ask('/api/threads/atlas-1', post({ op: 'post', text: 'x' }, { 'idempotency-key': 'k-503' }))
    expect(retry.status).toBe(200)
    expect(r.master.writes()).toBe(1)
  })

  test('the same key on another request: 422, the second never runs', async () => {
    const r = await rig()
    await r.ask('/api/threads/atlas-1', post({ op: 'post', text: 'a' }, { 'idempotency-key': 'k-same' }))
    const other = await r.ask('/api/threads/atlas-2', post({ op: 'post', text: 'b' }, { 'idempotency-key': 'k-same' }))
    expect(other.status).toBe(422)
    expect(((await other.json()) as { error: string }).error).toBe('master-relay-idempotency-mismatch')
    expect(r.master.writes()).toBe(1)
  })

  test('a duplicate that comes while the first still runs gets its answer; the write is done once', async () => {
    const r = await rig()
    let release = (): void => {}
    r.master.setHang(new Promise<void>(resolve => (release = resolve)))
    const a = r.ask('/api/threads/atlas-1', post({ op: 'post', text: 'x' }, { 'idempotency-key': 'k-dup' }))
    const b = r.ask('/api/threads/atlas-1', post({ op: 'post', text: 'x' }, { 'idempotency-key': 'k-dup' }))
    await Bun.sleep(50)
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(await ra.json()).toEqual(await rb.json())
    expect(r.master.writes()).toBe(1)
  })
})

describe('one spelling of a path, one form of a key', () => {
  test('the events stream spelled another way is refused on the node, so it never slips past the stream cap', async () => {
    const r = await rig()
    const res = await r.ask('/api/threads/%65vents')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('master-relay-path')
    expect(r.master.seen).toHaveLength(0)
  })

  test('an Idempotency-Key that is no key is refused, not replaced', async () => {
    const r = await rig()
    const res = await r.ask('/api/threads/atlas-1', post({ op: 'post' }, { 'idempotency-key': 'has space' }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('master-relay-bad-idempotency-key')
    expect(r.master.writes()).toBe(0)
  })
})

describe('a write that was sent and got no answer', () => {
  test("the link goes while it runs: 502 master-relay-unknown, not a plain 'try again'", async () => {
    const r = await rig()
    let release = (): void => {}
    r.master.setHang(new Promise<void>(resolve => (release = resolve)))
    const pending = r.ask('/api/threads/atlas-1', post({ op: 'post', text: 'x' }))
    await Bun.sleep(50)
    r.relay.drop()
    const res = await pending
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toBe('master-relay-unknown')
    release()
  })
})

describe('the master holds what a node sends to the table itself', () => {
  /** A runner fed events by hand, as a modified node could send them. */
  async function hostile() {
    const enc = new TextEncoder()
    let push: (text: string) => void = () => {}
    const heads = new Map<string, { status: number; body?: string }>()
    let replayed = 0
    const link = {
      id: 'server-1',
      state: () => ({ state: 'online', since: 0, heardAt: 0 }),
      async fetch(path: string, init?: RequestInit) {
        if (path === '/api/node/master-relay') {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                push = text => c.enqueue(enc.encode(text))
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        const m = /\/res\/([^/]+)$/.exec(path)
        if (m) heads.set(m[1] ?? '', JSON.parse(String(init?.body)))
        return Response.json({ ok: true })
      },
    } as unknown as Link
    const runner = createMasterRelayRunner({
      links: { link: () => link, onChange: () => () => {} },
      log: () => {},
      deviceIds: () => ['server-1'],
      selfId: () => 'laptop',
      ownerAllowed: () => true,
      sessionKnown: () => true,
      replay: async () => {
        replayed++
        return json(200, { ok: true })
      },
    })
    onTestFinished(() => runner.close())
    runner.sync()
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      push(': hi\n\n')
      await Bun.sleep(10)
      break
    }
    const ask = async (id: string, path: string, who: unknown = { kind: 'session', key: 'pane-p1' }) => {
      push(`event: req\ndata: ${JSON.stringify({ id, method: 'GET', path, headers: {}, who })}\n\n`)
      const until = Date.now() + 2000
      while (!heads.has(id) && Date.now() < until) await Bun.sleep(5)
      return heads.get(id)
    }
    return { ask, replayed: () => replayed }
  }

  test('a path that a URL parser would fold into another one is refused, never run', async () => {
    const h = await hostile()
    for (const [i, path] of [
      '/api/threads/..\\board',
      '/api/threads/%2e%2e',
      '/api/threads/%2E%2E/board',
      '/api/session/%40ben%3Ak/%2e%2e/%2e%2e/board',
      '/api/session/@ben:k/../../board',
      '/api/threads/a%5Cb',
      '/api/threads/%65vents',
    ].entries()) {
      const head = await h.ask(`hostile-${i}xx`, path)
      expect([path, head?.status]).toEqual([path, 400])
    }
    expect(h.replayed()).toBe(0)
    const fine = await h.ask('fine-1234', '/api/threads/atlas-1')
    expect(fine?.status).toBe(200)
    expect(h.replayed()).toBe(1)
  })
})

describe("what is not the relay's is as before", () => {
  test('local paths fall through to the next route on a node', async () => {
    const r = await rig()
    for (const path of ['/api/todos', '/api/board', '/api/session/pane-p1']) {
      const res = await r.ask(path)
      expect(await res.json()).toEqual({ local: true, path })
    }
    expect(r.master.seen).toHaveLength(0)
  })

  test('a board without `node`: the route takes nothing, threads answer locally', async () => {
    const r = await rig({ node: false, master: false })
    const res = await r.ask('/api/threads')
    expect(await res.json()).toEqual({ local: true, path: '/api/threads' })
    expect(r.relay.stream(new Request('http://door/api/node/master-relay')).status).toBe(404)
  })
})
