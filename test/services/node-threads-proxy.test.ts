// Unit tests for the node-to-master threads read proxy (#759).
import { describe, expect, onTestFinished, test } from 'bun:test'
import {
  isAllowedThreadsQuery,
  isAllowedThreadsReadPath,
  isThreadsProxyId,
  MAX_THREADS_PROXY_RESPONSE_BYTES,
  parseThreadsProxyRequest,
  parseThreadsProxyResponse,
  parseThreadsProxyRev,
  type ThreadsProxyRequest,
} from '../../src/core/node-threads-proxy.ts'
import type { Config } from '../../src/core/types.ts'
import { createNodeThreadsProxy } from '../../src/services/node/threads-proxy.ts'
import type { Link } from '../../src/services/nodes/link.ts'
import { createThreadsProxyRunner } from '../../src/services/nodes/threads-proxy.ts'

function makeProxy(over: Partial<Parameters<typeof createNodeThreadsProxy>[0]> = {}) {
  const proxy = createNodeThreadsProxy({
    cfg: { node: { id: 'server-1', port: 12430, workRoot: '/tmp/work' } } as Config,
    log: () => {},
    ...over,
  })
  onTestFinished(() => proxy.close())
  return proxy
}

async function readProxyReqs(res: Response): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>
  nextReq: () => Promise<ThreadsProxyRequest>
}> {
  if (!res.body) throw new Error('missing stream body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const queued: ThreadsProxyRequest[] = []

  const nextReq = async (): Promise<ThreadsProxyRequest> => {
    while (queued.length === 0) {
      const { done, value } = await reader.read()
      if (done) throw new Error('stream ended before next req')
      buf += decoder.decode(value, { stream: true })
      for (;;) {
        const sep = buf.indexOf('\n\n')
        if (sep < 0) break
        const block = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        let name = 'message'
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trimStart()
        }
        if (name === 'req' && data) queued.push(JSON.parse(data) as ThreadsProxyRequest)
      }
    }
    return queued.shift() as ThreadsProxyRequest
  }
  return { reader, nextReq }
}

describe('core/node-threads-proxy validators (#759)', () => {
  test('allows only /api/threads and single-segment /api/threads/<key>', () => {
    for (const p of [
      '/api/threads',
      '/api/threads/atlas-1',
      '/api/threads/a1b2c3d4',
      `/api/threads/${encodeURIComponent('атлас 1%')}`,
    ]) {
      expect(isAllowedThreadsReadPath(p)).toBe(true)
    }
    for (const bad of [
      '',
      '/api/threads/',
      '/api/threads/events',
      '/api/threads/.',
      '/api/threads/..',
      '/api/threads/%2e%2e',
      '/api/threads/a/b',
      '/api/threads/a%2Fb',
      '/api/threads/a%5Cb',
      '/api/threads/%E0%A4%A',
      '/api/threads-settings',
      '/api/board',
      '/api/threads/atlas-1\n',
    ]) {
      expect([bad, isAllowedThreadsReadPath(bad)]).toEqual([bad, false])
    }
  })

  test('validates ids, queries, responses, and rev payloads', () => {
    expect(isThreadsProxyId('req-12345678')).toBe(true)
    expect(isThreadsProxyId('short')).toBe(false)
    expect(isAllowedThreadsQuery('')).toBe(true)
    expect(isAllowedThreadsQuery('?closed=1&lane=atlas')).toBe(true)
    expect(isAllowedThreadsQuery('closed=1')).toBe(false)
    expect(isAllowedThreadsQuery('?a=\u0007')).toBe(false)

    expect(parseThreadsProxyRequest({ id: 'req-12345678', path: '/api/threads', query: '?closed=1' })).toEqual({
      id: 'req-12345678',
      path: '/api/threads',
      query: '?closed=1',
    })
    expect(parseThreadsProxyRequest({ id: 'req-12345678', path: '/api/threads/events', query: '' })).toBeNull()

    expect(parseThreadsProxyResponse({ status: 200, contentType: 'application/json', body: '{}' })).toEqual({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    })
    expect(parseThreadsProxyResponse({ status: 99, body: '{}' })).toBeNull()
    expect(
      parseThreadsProxyResponse({ status: 200, body: 'x'.repeat(MAX_THREADS_PROXY_RESPONSE_BYTES + 1) }),
    ).toBeNull()

    expect(parseThreadsProxyRev({ on: true, rev: 7 })).toEqual({ on: true, rev: 7 })
    expect(parseThreadsProxyRev({ on: true, rev: -1 })).toBeNull()
    expect(parseThreadsProxyRev({ on: 'yes', rev: 0 })).toBeNull()
  })
})

describe('NodeThreadsProxy (#759)', () => {
  test('returns 503 when offline, 504 on timeout, and supersedes half-open streams cleanly', async () => {
    const proxy = makeProxy({ timeoutMs: 80 })
    const offline = await proxy.read('/api/threads', '')
    expect(offline.status).toBe(503)

    // Master connects stream #1, leaving its reader uncancelled (half-open).
    const ac1 = new AbortController()
    const stream1 = proxy.stream(new Request('http://127.0.0.1/api/node/threads-proxy', { signal: ac1.signal }))
    const s1 = await readProxyReqs(stream1)
    expect(proxy.pushRev({ on: true, rev: 3 }).status).toBe(200)

    const inflight = proxy.read('/api/threads', '')
    const req1 = await s1.nextReq()
    expect(req1.path).toBe('/api/threads')

    // Master reconnects on stream #2 without closing stream #1.
    const ac2 = new AbortController()
    const stream2 = proxy.stream(new Request('http://127.0.0.1/api/node/threads-proxy', { signal: ac2.signal }))
    const s2 = await readProxyReqs(stream2)

    expect((await inflight).status).toBe(503)
    const oldEnd = await s1.reader.read()
    expect(oldEnd.done).toBe(true)

    // Late abort on old stream #1 must not tear down stream #2.
    ac1.abort()

    // Timeout produces 504.
    const timedOutP = proxy.read('/api/threads/atlas-1', '?full=1')
    const req2 = await s2.nextReq()
    expect(req2.path).toBe('/api/threads/atlas-1')
    expect((await timedOutP).status).toBe(504)

    // Normal response over stream #2 works.
    const okP = proxy.read('/api/threads', '')
    const req3 = await s2.nextReq()
    expect(proxy.respond(req3.id, { status: 200, contentType: 'application/json', body: '{"ok":true}' }).status).toBe(
      200,
    )
    const okRes = await okP
    expect(okRes.status).toBe(200)
    expect(await okRes.json()).toEqual({ ok: true })
  })

  test('events stream greets with initial rev, relays changes, and closes when master turns threads off', async () => {
    const proxy = makeProxy({ timeoutMs: 500 })
    const ac = new AbortController()
    const doorStream = proxy.stream(new Request('http://127.0.0.1/api/node/threads-proxy', { signal: ac.signal }))
    await readProxyReqs(doorStream)

    // Start events() before pushRev arrives; it waits for initial pushRev.
    const evAbort = new AbortController()
    const evPromise = proxy.events(new Request('http://127.0.0.1/api/threads/events', { signal: evAbort.signal }))
    expect(proxy.pushRev({ on: true, rev: 5 }).status).toBe(200)
    const evRes = await evPromise
    expect(evRes.status).toBe(200)
    const reader = evRes.body?.getReader()
    if (!reader) throw new Error('missing sse body')

    const decoder = new TextDecoder()
    const first = decoder.decode((await reader.read()).value)
    expect(first).toContain('event: rev\ndata: {"rev":5}\n\n')

    expect(proxy.pushRev({ on: true, rev: 6 }).status).toBe(200)
    const second = decoder.decode((await reader.read()).value)
    expect(second).toContain('event: rev\ndata: {"rev":6}\n\n')

    // Turning threads off closes open event streams.
    expect(proxy.pushRev({ on: false, rev: 0 }).status).toBe(200)
    expect((await reader.read()).done).toBe(true)

    // Subsequent events() while master has threads off returns 409.
    const offRes = await proxy.events(new Request('http://127.0.0.1/api/threads/events'))
    expect(offRes.status).toBe(409)
    evAbort.abort()
  })
})

describe('createThreadsProxyRunner (#759)', () => {
  test('cancels oversize stream, limits inflight requests, and pushes coalesced rev updates', async () => {
    let canceled = false
    let emittedOversize = false
    const postedRevs: { on: boolean; rev: number }[] = []
    const postedRes: { path: string; body: { status: number; body: string } }[] = []
    const listeners = new Set<(id: string) => void>()

    const fakeLink: Pick<Link, 'fetch' | 'state'> = {
      state: () => ({ state: 'online', since: 0, heardAt: 0 }),
      async fetch(path: string, init?: RequestInit) {
        if (path === '/api/node/threads-proxy') {
          if (!emittedOversize) {
            emittedOversize = true
            const stream = new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode(`event: req\ndata: ${'x'.repeat((1 << 20) + 64)}`))
              },
              cancel() {
                canceled = true
              },
            })
            return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
          }
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const e1 = JSON.stringify({ id: 'req-11111111', path: '/api/threads', query: '' })
              const e2 = JSON.stringify({ id: 'req-22222222', path: '/api/threads', query: '' })
              controller.enqueue(new TextEncoder().encode(`event: req\ndata: ${e1}\n\nevent: req\ndata: ${e2}\n\n`))
            },
          })
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
        if (path === '/api/node/threads-proxy/rev') {
          postedRevs.push(JSON.parse(String(init?.body ?? '{}')) as { on: boolean; rev: number })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (path.startsWith('/api/node/threads-proxy/res/')) {
          postedRes.push({
            path,
            body: JSON.parse(String(init?.body ?? '{}')) as { status: number; body: string },
          })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('', { status: 404 })
      },
    }

    let releaseFirst!: () => void
    const firstGate = new Promise<void>(r => {
      releaseFirst = r
    })
    const runner = createThreadsProxyRunner({
      links: {
        link: id => (id === 'server-1' ? (fakeLink as Link) : null),
        onChange: fn => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
      },
      currentRev: () => ({ on: true, rev: 1 }),
      maxInflightPerDevice: 1,
      async handleRead() {
        await firstGate
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
      log: () => {},
    })

    for (const fn of listeners) fn('server-1')
    const deadline = Date.now() + 5000
    while ((!canceled || postedRes.length < 1) && Date.now() < deadline) {
      await Bun.sleep(10)
    }
    expect(canceled).toBe(true)
    // Second concurrent request was rejected with 429 due to maxInflightPerDevice: 1.
    expect(postedRes.some(r => r.path.endsWith('/req-22222222') && r.body.status === 429)).toBe(true)

    releaseFirst()
    while (postedRes.length < 2 && Date.now() < deadline) {
      await Bun.sleep(10)
    }
    expect(postedRes.some(r => r.path.endsWith('/req-11111111') && r.body.status === 200)).toBe(true)

    // Rapid notifyRev calls deliver latest rev.
    runner.notifyRev(true, 9)
    runner.notifyRev(true, 10)
    while (!postedRevs.some(r => r.rev === 10) && Date.now() < deadline) {
      await Bun.sleep(10)
    }
    await runner.close()
  })
})
