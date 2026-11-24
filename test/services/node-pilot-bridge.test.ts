// Unit tests for PR #729 review fixes:
// 1. Half-open SSE reconnect supersedes stale client & fails waiting RPCs/streams; oversize break cancels reader.
// 2. Byte-bounded back-pressure on streamChunk holds ack until the MokuPilot reader drains.
// 3. openForNode security: caller cwd ignored, bare-UUID local fallback blocked, grant isolation between nodes.
// 4. startForItem link mode only bypasses nodeLink error for registered node viewers.
// 5. Longer timeouts for start/files RPCs and cleanup close(kill:true) when start finishes after 504.
import { describe, expect, onTestFinished, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PilotBridgeRequest } from '../../src/core/pilot-call.ts'
import { profileSet } from '../../src/core/profiles.ts'
import type { Config, Item } from '../../src/core/types.ts'
import { createNodePilotBridge } from '../../src/services/node/pilot-bridge.ts'
import type { NodePilotCall } from '../../src/services/node/pilot-call.ts'
import type { Link } from '../../src/services/nodes/link.ts'
import { createPilotBridgeRunner } from '../../src/services/nodes/pilot-bridge.ts'
import { createNodePilotCalls } from '../../src/services/nodes/pilot-call.ts'

const SID_MASTER = '11111111-2222-3333-4444-555555555555'
const SID_SERVER2 = '22222222-3333-4444-5555-666666666666'
const SID_UNLISTED = '33333333-4444-5555-6666-777777777777'
const RUN_ID = 'run-12345678'

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-bridge-unit-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeItem(over: Partial<Item> & { key: string; session: string; cwd: string }): Item {
  return {
    pane: 'p1',
    workspace: 'Personal',
    status: 'idle',
    name: 'Atlas',
    autoName: 'Atlas',
    category: 'personal',
    categorySet: true,
    column: 'idle',
    attention: '',
    agent: 'claude',
    profile: 'default',
    ...over,
  }
}

function makeBridge(over: Partial<Parameters<typeof createNodePilotBridge>[0]> = {}) {
  const dir = scratchDir()
  const profiles = profileSet(
    [{ id: 'default', title: 'Default', dir: join(dir, '.claude'), color: 'indigo', hidden: false }],
    join(dir, '.claude'),
  )
  const localPilotCall: NodePilotCall = {
    check: async () => ({ status: 404, body: { ok: false, error: 'not found' } }),
    start: async () => ({ status: 404, body: { ok: false } }),
    events: () => new Response('', { status: 404 }),
    stdin: () => ({ status: 404, body: { ok: false } }),
    mcpReply: () => ({ status: 404, body: { ok: false } }),
    close: () => ({ status: 404, body: { ok: false } }),
    uploadFiles: () => ({ status: 404, body: { ok: false } }),
    deliverReport: async () => ({ status: 404, body: { ok: false } }),
    closeAll: () => {},
  }
  const bridge = createNodePilotBridge({
    cfg: { node: { id: 'server-1', port: 12430, workRoot: dir, pilotBridge: true } } as Config,
    port: () => 12422,
    localPilotCall,
    items: () => [],
    profiles: () => profiles,
    log: () => {},
    ...over,
  })
  onTestFinished(() => bridge.close())
  return bridge
}

async function readBridgeReqs(res: Response): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>
  nextReq: () => Promise<PilotBridgeRequest>
}> {
  if (!res.body) throw new Error('missing bridge stream body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const queued: PilotBridgeRequest[] = []

  const nextReq = async (): Promise<PilotBridgeRequest> => {
    while (queued.length === 0) {
      const { done, value } = await reader.read()
      if (done) throw new Error('bridge stream ended before next req')
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
        if (name === 'req' && data) queued.push(JSON.parse(data) as PilotBridgeRequest)
      }
    }
    return queued.shift() as PilotBridgeRequest
  }
  return { reader, nextReq }
}

describe('NodePilotBridge reconnect, back-pressure, and timeouts (#729)', () => {
  test('reconnect supersedes half-open SSE, fails waiting RPCs/streams, and ignores late abort on old stream', async () => {
    const bridge = makeBridge()

    // Master connects stream #1, leaving its reader uncancelled (simulating half-open TCP).
    const ac1 = new AbortController()
    const stream1 = bridge.stream(new Request('http://127.0.0.1/api/node/pilot-bridge', { signal: ac1.signal }))
    const s1 = await readBridgeReqs(stream1)

    // Open a grant directly via /open responded over stream #1.
    const openP = bridge.open({ session: SID_MASTER })
    const openReq = await s1.nextReq()
    expect(openReq.op).toBe('open')
    bridge.respond(openReq.id, {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        locality: 'remote',
        grantId: 'grant-12345678',
        device: 'laptop',
        parent: SID_MASTER,
        session: SID_MASTER,
        cwd: '/tmp/atlas',
      }),
    })
    const openRes = await openP
    const openBody = (await openRes.json()) as { ok: boolean; url: string; token: string }
    expect(openBody.ok).toBe(true)
    const grantId = openBody.url.split('/').pop() as string
    const grant = bridge.authorize(grantId, `Bearer ${openBody.token}`)
    expect(grant).not.toBeNull()
    if (!grant) throw new Error('expected grant')

    // Start an active events SSE stream AND an in-flight RPC while stream #1 is half-open.
    const eventsRes = await bridge.events(grant, RUN_ID, new Request('http://127.0.0.1/events'))
    const evReq = await s1.nextReq()
    expect(evReq.op).toBe('events')

    const inflightRpc = bridge.sessions()
    const sessReq1 = await s1.nextReq()
    expect(sessReq1.op).toBe('sessions')

    // Master reconnects on stream #2 WITHOUT closing stream #1 first.
    const ac2 = new AbortController()
    const stream2 = bridge.stream(new Request('http://127.0.0.1/api/node/pilot-bridge', { signal: ac2.signal }))
    const s2 = await readBridgeReqs(stream2)

    // In-flight RPC must fail promptly with 503 and open events stream must close cleanly.
    const rpcRes = await inflightRpc
    expect(rpcRes.status).toBe(503)
    const evText = await eventsRes.text()
    expect(evText).toContain(': connected')

    // Old stream #1 reader sees EOF cleanly.
    let s1Closed = false
    for (;;) {
      const next = await s1.reader.read()
      if (next.done) {
        s1Closed = true
        break
      }
    }
    expect(s1Closed).toBe(true)

    // Late abort on old stream #1 must NOT kill stream #2.
    ac1.abort()
    const rpc2P = bridge.sessions()
    const sessReq2 = await s2.nextReq()
    expect(sessReq2.op).toBe('sessions')
    bridge.respond(sessReq2.id, {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, sessions: [], masterOnline: true }),
    })
    const rpc2Res = await rpc2P
    expect(rpc2Res.status).toBe(200)
  })

  test('createPilotBridgeRunner cancels underlying stream when breaking on oversize event', async () => {
    let canceled = false
    let emitted = false
    const listeners = new Set<(id: string) => void>()

    const fakeLink: Pick<Link, 'fetch' | 'state'> = {
      state: () => ({ state: 'online', since: 0, heardAt: 0 }),
      async fetch(path: string) {
        if (path !== '/api/node/pilot-bridge') return new Response('', { status: 404 })
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (emitted) return
            emitted = true
            // Exceed MOST_EVENT_CHARS (1 MiB) without a block terminator.
            controller.enqueue(new TextEncoder().encode(`event: req\ndata: ${'x'.repeat((1 << 20) + 128)}`))
          },
          cancel() {
            canceled = true
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    }

    const runner = createPilotBridgeRunner({
      links: {
        link: id => (id === 'server-1' ? (fakeLink as Link) : null),
        onChange: fn => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
      },
      pilotCalls: createNodePilotCalls({
        cfg: {
          nodes: {
            id: 'laptop',
            devices: {
              'server-1': { pilotBridge: true, link: { kind: 'direct', url: 'http://127.0.0.1:12430' } },
            },
          },
        } as Config,
        links: { link: () => null, onChange: () => () => {} },
        port: () => 12422,
        log: () => {},
      }),
      log: () => {},
    })

    for (const fn of listeners) fn('server-1')
    const deadline = Date.now() + 2000
    while (!canceled && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10))
    }
    await runner.close()
    expect(canceled).toBe(true)
  })

  test('streamChunk enforces byte-bounded back-pressure until reader drains and unblocks on close', async () => {
    const bridge = makeBridge({ streamQueueBytes: 1024 })
    const stream = bridge.stream(new Request('http://127.0.0.1/api/node/pilot-bridge'))
    const s = await readBridgeReqs(stream)

    const openP = bridge.open({ session: SID_MASTER })
    const openReq = await s.nextReq()
    bridge.respond(openReq.id, {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        locality: 'remote',
        grantId: 'grant-bp-12345',
        device: 'laptop',
        parent: SID_MASTER,
        session: SID_MASTER,
        cwd: '/tmp/atlas',
      }),
    })
    const openBody = (await (await openP).json()) as { url: string; token: string }
    const grant = bridge.authorize(openBody.url.split('/').pop() as string, `Bearer ${openBody.token}`)
    if (!grant) throw new Error('expected grant')

    const eventsRes = await bridge.events(grant, RUN_ID, new Request('http://127.0.0.1/events'))
    const evReq = await s.nextReq()
    const streamId = evReq.streamId as string
    if (!eventsRes.body) throw new Error('missing events body')
    const reader = eventsRes.body.getReader()

    // Stall consumer (no reads): push chunks past highWaterMark + streamQueueBytes (1024).
    const payloadA = 'A'.repeat(1200)
    const ack1 = await bridge.streamChunk(streamId, {
      events: [{ name: 'line', data: JSON.stringify({ line: payloadA }) }],
    })
    expect(ack1.status).toBe(200)

    const payloadB = 'B'.repeat(1200)
    let ack2Settled = false
    const ack2Promise = bridge
      .streamChunk(streamId, {
        events: [{ name: 'line', data: JSON.stringify({ line: payloadB }) }],
      })
      .then(ans => {
        ack2Settled = true
        return ans
      })

    await new Promise(r => setTimeout(r, 40))
    expect(ack2Settled).toBe(false)

    // Drain enough from the SSE reader to free queue capacity -> pending ack2 must resolve.
    const decoder = new TextDecoder()
    let collected = ''
    while (!ack2Settled) {
      const { done, value } = await reader.read()
      if (done) break
      collected += decoder.decode(value, { stream: true })
      await new Promise(r => setTimeout(r, 10))
    }
    expect(await ack2Promise).toEqual({ status: 200, body: { ok: true } })

    // Send done while completing read and verify full payload arrives cleanly.
    const ackDone = await bridge.streamChunk(streamId, { done: true })
    expect(ackDone).toEqual({ status: 200, body: { ok: true } })
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      collected += decoder.decode(value, { stream: true })
    }
    expect(collected).toContain(payloadA)
    expect(collected).toContain(payloadB)

    // Blocking streamChunk must also unblock with 404 when consumer closes the stream mid-stall.
    const ac = new AbortController()
    const evRes2 = await bridge.events(grant, RUN_ID, new Request('http://127.0.0.1/events', { signal: ac.signal }))
    const evReq2 = await s.nextReq()
    const sid2 = evReq2.streamId as string
    await bridge.streamChunk(sid2, { events: [{ name: 'line', data: 'x'.repeat(1200) }] })
    let blockedSettled = false
    const blocked = bridge.streamChunk(sid2, { events: [{ name: 'line', data: 'y'.repeat(1200) }] }).then(ans => {
      blockedSettled = true
      return ans
    })
    await new Promise(r => setTimeout(r, 30))
    expect(blockedSettled).toBe(false)
    ac.abort()
    await evRes2.body?.cancel().catch(() => {})
    expect(await blocked).toEqual({ status: 404, body: { ok: false, error: 'stream closed' } })
  })

  test('start and files use longer timeouts than default RPCs, and late start response cleans up orphan run', async () => {
    const bridge = makeBridge({ rpcTimeoutMs: 50, startTimeoutMs: 250, filesTimeoutMs: 250 })
    const stream = bridge.stream(new Request('http://127.0.0.1/api/node/pilot-bridge'))
    const s = await readBridgeReqs(stream)

    // Default op ('sessions') times out at ~50 ms -> 504.
    const slowSess = bridge.sessions()
    await s.nextReq()
    expect((await slowSess).status).toBe(504)

    // Open a remote grant for testing start and files.
    const openP = bridge.open({ session: SID_MASTER })
    const openReq = await s.nextReq()
    bridge.respond(openReq.id, {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        locality: 'remote',
        grantId: 'grant-timeout-1',
        device: 'laptop',
        parent: SID_MASTER,
        session: SID_MASTER,
        cwd: '/tmp/atlas',
      }),
    })
    const openBody = (await (await openP).json()) as { url: string; token: string }
    const grant = bridge.authorize(openBody.url.split('/').pop() as string, `Bearer ${openBody.token}`)
    if (!grant) throw new Error('expected grant')

    // start and files survive 100 ms (> rpcTimeoutMs 50 ms) under their longer timeouts.
    const startOkP = bridge.startRun(grant, { fork: true })
    const startReq = await s.nextReq()
    await new Promise(r => setTimeout(r, 100))
    bridge.respond(startReq.id, {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, id: RUN_ID }),
    })
    expect((await startOkP).status).toBe(200)

    const filesOkP = bridge.uploadFiles(grant, JSON.stringify({ files: [] }))
    const filesReq = await s.nextReq()
    await new Promise(r => setTimeout(r, 100))
    bridge.respond(filesReq.id, {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, paths: {} }),
    })
    expect((await filesOkP).status).toBe(200)

    // When start actually times out (at 250 ms) and master answers late with { ok: true, id },
    // respond() returns 404 and emits a cleanup close(kill:true) request for the orphan run.
    const expiredStartP = bridge.startRun(grant, { fork: true })
    const expiredReq = await s.nextReq()
    expect((await expiredStartP).status).toBe(504)

    const lateAns = bridge.respond(expiredReq.id, {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, id: RUN_ID }),
    })
    expect(lateAns.status).toBe(404)
    const cleanupReq = await s.nextReq()
    expect(cleanupReq.op).toBe('close')
    expect(cleanupReq.grantId).toBe('grant-timeout-1')
    expect(cleanupReq.runId).toBe(RUN_ID)
    expect(JSON.parse(cleanupReq.body ?? '{}')).toEqual({ kill: true })
  })
})

describe('NodePilotCalls security isolation & viewer check (#729)', () => {
  test('openForNode ignores caller cwd, refuses unlisted bare-UUID fallback, and isolates grants per device', async () => {
    const dir = scratchDir()
    const checkCwds: { target: string; cwd: string }[] = []

    const fakeLink = (id: string): Link =>
      ({
        id,
        state: () => ({ state: 'online', since: 0, heardAt: 0 }),
        async fetch(path: string, init?: RequestInit) {
          if (path === '/api/node/pilot-call/check') {
            const parsed = JSON.parse(String(init?.body ?? '{}')) as { session: string; cwd: string }
            checkCwds.push({ target: id, cwd: parsed.cwd })
            return new Response(JSON.stringify({ ok: true, cwd: parsed.cwd || '/srv/real', profile: 'default' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          return new Response('', { status: 404 })
        },
      }) as unknown as Link

    const fakeLocalCall: NodePilotCall = {
      check: async body => {
        const b = body as { session: string; cwd: string }
        checkCwds.push({ target: 'master', cwd: b.cwd })
        return { status: 200, body: { ok: true, cwd: b.cwd || '/master/real', profile: 'default' } }
      },
      start: async () => ({ status: 200, body: { ok: true, id: RUN_ID } }),
      events: () => new Response('', { status: 404 }),
      stdin: () => ({ status: 200, body: { ok: true } }),
      mcpReply: () => ({ status: 200, body: { ok: true } }),
      close: () => ({ status: 200, body: { ok: true } }),
      uploadFiles: () => ({ status: 200, body: { ok: true, paths: {} } }),
      deliverReport: async () => ({ status: 200, body: { ok: true, id: 'r1' } }),
      closeAll: () => {},
    }

    const masterCardCwd = join(dir, 'anna-master-card')
    const server2CardCwd = join(dir, 'ben-server2-card')
    const masterItem = makeItem({ key: SID_MASTER, session: SID_MASTER, cwd: masterCardCwd })
    const server2Item = makeItem({
      key: `@server-2:${SID_SERVER2}`,
      device: 'server-2',
      session: SID_SERVER2,
      cwd: server2CardCwd,
    })

    const calls = createNodePilotCalls({
      cfg: {
        nodes: {
          id: 'laptop',
          devices: {
            local: { pilotBridge: true },
            'server-1': { pilotBridge: true, link: { kind: 'tailnet', address: '100.64.0.11', port: 12430 } },
            'server-2': { pilotBridge: true, link: { kind: 'tailnet', address: '100.64.0.12', port: 12430 } },
          },
        },
      } as Config,
      links: {
        link: id => (id === 'server-1' || id === 'server-2' ? fakeLink(id) : null),
        onChange: () => () => {},
      },
      port: () => 12422,
      log: () => {},
      localPilotCall: fakeLocalCall,
      ownItems: () => [masterItem],
      remoteItems: () => [server2Item],
      masterId: () => 'laptop',
    })
    onTestFinished(() => calls.close())

    // 1. Caller passes forged cwd for master card -> probe uses masterCardCwd, ignoring forged cwd.
    const rMaster = await calls.openForNode('server-1', { session: SID_MASTER, cwd: '/etc/shadow-forged' })
    expect(rMaster.status).toBe(200)
    expect(checkCwds.at(-1)).toEqual({ target: 'master', cwd: masterCardCwd })
    const masterGrantId = (rMaster.body as { grantId: string }).grantId

    // 2. Caller passes forged cwd for third node card -> probe uses server2CardCwd, ignoring forged cwd.
    const rThird = await calls.openForNode('server-1', {
      device: 'server-2',
      session: SID_SERVER2,
      cwd: '/etc/third-forged',
    })
    expect(rThird.status).toBe(200)
    expect(checkCwds.at(-1)).toEqual({ target: 'server-2', cwd: server2CardCwd })

    // 3. Unlisted bare-UUID fallback (transcript exists on disk/master, no board card) is refused for nodes,
    //    even with explicit device: 'laptop' / 'local' / 'server-2', while still allowed for master openLocal.
    const prevChecks = checkCwds.length
    expect((await calls.openForNode('server-1', { session: SID_UNLISTED, cwd: '/secret' })).status).toBe(404)
    expect(
      (await calls.openForNode('server-1', { device: 'laptop', session: SID_UNLISTED, cwd: '/secret' })).status,
    ).toBe(404)
    expect(
      (await calls.openForNode('server-1', { device: 'server-2', session: SID_UNLISTED, cwd: '/secret' })).status,
    ).toBe(404)
    expect(checkCwds.length).toBe(prevChecks)
    expect((await calls.openLocal({ session: SID_UNLISTED })).status).toBe(200)

    const localRemoteOpen = await calls.openLocal({ device: 'server-2', session: SID_SERVER2 })
    expect(localRemoteOpen.status).toBe(200)
    const localBody = (await localRemoteOpen.json()) as { url: string; token: string }
    const localGrantId = localBody.url.split('/').pop() as string

    // 4. Grant isolation across callers:
    // - server-1's grant is accepted for server-1, refused for server-2 and master loopback.
    expect(calls.authorizeForNode('server-1', masterGrantId)).not.toBeNull()
    expect(calls.authorizeForNode('server-2', masterGrantId)).toBeNull()
    expect(calls.authorize(masterGrantId, `Bearer ${localBody.token}`)).toBeNull()
    // - master's grant is accepted for master loopback and refused for any node.
    expect(calls.authorize(localGrantId, `Bearer ${localBody.token}`)).not.toBeNull()
    expect(calls.authorizeForNode('server-1', localGrantId)).toBeNull()
  })

  test('startForItem refuses non-node viewers in link mode with nodeLink, while allowing registered nodes', async () => {
    const dir = scratchDir()
    const fakeLink: Link = {
      id: 'server-1',
      state: () => ({ state: 'online', since: 0, heardAt: 0 }),
      async fetch(path: string) {
        if (path === '/api/node/pilot-call/check') {
          return new Response(JSON.stringify({ ok: true, cwd: dir, profile: 'default' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('', { status: 404 })
      },
    } as unknown as Link

    const calls = createNodePilotCalls({
      cfg: {
        mokupilot: { mode: 'link' },
        nodes: {
          id: 'laptop',
          devices: {
            'server-1': { pilotBridge: true, link: { kind: 'tailnet', address: '100.64.0.12', port: 12430 } },
          },
        },
      } as unknown as Config,
      links: { link: id => (id === 'server-1' ? fakeLink : null), onChange: () => () => {} },
      port: () => 12422,
      log: () => {},
    })
    onTestFinished(() => calls.close())

    const nodeItem = makeItem({ key: `@server-1:${SID_MASTER}`, device: 'server-1', session: SID_MASTER, cwd: dir })

    // Plain browser or phone (unregistered address): gets mokupilot.err.nodeLink error.
    for (const viewer of [
      undefined,
      { peer: '127.0.0.1', forwardedFor: null },
      { peer: '127.0.0.1', forwardedFor: '100.64.0.99' },
      { peer: '100.64.0.99', forwardedFor: '100.64.0.12' },
    ]) {
      const r = await calls.startForItem(nodeItem, viewer)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('master computer')
    }

    // Registered node viewer: gets mokupilot:// link.
    const okNode = await calls.startForItem(nodeItem, { peer: '127.0.0.1', forwardedFor: '100.64.0.12' })
    expect(okNode).toEqual({
      ok: true,
      state: 'link',
      url: `mokupilot://call?claude-session=${SID_MASTER}&cwd=${encodeURIComponent(dir)}`,
      resolved: 'link',
      why: 'mode-link',
    })
  })
})

describe('MokuPilot bridge caps, opt-in, stdin order, and stream safety (#730)', () => {
  test('NodePilotBridge refuses /open, /sessions, and /pilot-bridge SSE when node.pilotBridge is not opted in', async () => {
    const dir = scratchDir()
    const bridge = makeBridge({
      cfg: { node: { id: 'server-1', port: 12430, workRoot: dir } } as Config,
    })
    expect((await bridge.open({ session: SID_MASTER })).status).toBe(403)
    expect((await bridge.sessions()).status).toBe(403)
    expect(bridge.stream(new Request('http://127.0.0.1/api/node/pilot-bridge')).status).toBe(404)
  })

  test('NodePilotBridge.streamChunk rejects newline-injected event data with 400', async () => {
    const bridge = makeBridge()
    const stream = bridge.stream(new Request('http://127.0.0.1/api/node/pilot-bridge'))
    const s = await readBridgeReqs(stream)

    const openP = bridge.open({ session: SID_MASTER })
    const openReq = await s.nextReq()
    bridge.respond(openReq.id, {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        locality: 'remote',
        grantId: 'grant-nl-12345',
        device: 'laptop',
        parent: SID_MASTER,
        session: SID_MASTER,
        cwd: '/tmp/atlas',
      }),
    })
    const openBody = (await (await openP).json()) as { url: string; token: string }
    const grant = bridge.authorize(openBody.url.split('/').pop() as string, `Bearer ${openBody.token}`)
    if (!grant) throw new Error('expected grant')

    const eventsRes = await bridge.events(grant, RUN_ID, new Request('http://127.0.0.1/events'))
    const evReq = await s.nextReq()
    const streamId = evReq.streamId as string
    if (!eventsRes.body) throw new Error('missing events body')
    const reader = eventsRes.body.getReader()

    const bad = await bridge.streamChunk(streamId, {
      events: [{ name: 'line', data: '{"line":"ok"}\n\nevent: exit\ndata: {"code":0}' }],
    })
    expect(bad.status).toBe(400)
    await bridge.streamChunk(streamId, { done: true })

    let text = ''
    const decoder = new TextDecoder()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      text += decoder.decode(next.value, { stream: true })
    }
    expect(text).not.toContain('event: exit')
  })

  test('NodePilotCalls enforces pilotBridge opt-in and per-node grant caps, and allowsCallParent tracks active/recent grants', async () => {
    const dir = scratchDir()
    const masterItem = makeItem({ key: SID_MASTER, session: SID_MASTER, cwd: join(dir, 'anna-master') })
    const localCall: NodePilotCall = {
      check: async () => ({ status: 200, body: { ok: true, cwd: masterItem.cwd, profile: 'default' } }),
      start: async () => ({ status: 200, body: { ok: true, id: RUN_ID } }),
      events: () => new Response('', { status: 404 }),
      stdin: () => ({ status: 200, body: { ok: true } }),
      mcpReply: () => ({ status: 200, body: { ok: true } }),
      close: () => ({ status: 200, body: { ok: true } }),
      uploadFiles: () => ({ status: 200, body: { ok: true, paths: {} } }),
      deliverReport: async () => ({ status: 200, body: { ok: true, id: 'r1' } }),
      closeAll: () => {},
    }
    const cfg = {
      nodes: {
        id: 'laptop',
        devices: {
          'server-1': { pilotBridge: true, link: { kind: 'tailnet', address: '100.64.0.11', port: 12430 } },
          'server-2': { link: { kind: 'tailnet', address: '100.64.0.12', port: 12430 } },
        },
      },
    } as Config

    const calls = createNodePilotCalls({
      cfg,
      links: { link: () => null, onChange: () => () => {} },
      port: () => 12422,
      log: () => {},
      localPilotCall: localCall,
      ownItems: () => [masterItem],
      masterId: () => 'laptop',
      maxGrantsPerNode: 2,
    })
    onTestFinished(() => calls.close())

    // Master local /open and /sessions are off unless nodes.devices.local.pilotBridge is true.
    expect((await calls.openLocal({ session: SID_MASTER })).status).toBe(403)
    expect(calls.sessionsLocal().status).toBe(403)

    // Non-opted-in server-2 is rejected with 403.
    expect((await calls.openForNode('server-2', { session: SID_MASTER })).status).toBe(403)
    expect(calls.bridgeEnabled('server-2')).toBe(false)
    expect(calls.allowsCallParent('server-2', SID_MASTER)).toBe(false)

    // Opted-in server-1 can open up to maxGrantsPerNode (2); 3rd gets 429.
    const g1 = await calls.openForNode('server-1', { session: SID_MASTER })
    const g2 = await calls.openForNode('server-1', { session: SID_MASTER })
    expect(g1.status).toBe(200)
    expect(g2.status).toBe(200)
    expect((await calls.openForNode('server-1', { session: SID_MASTER })).status).toBe(429)
    expect(calls.allowsCallParent('server-1', SID_MASTER)).toBe(true)
    expect(calls.allowsCallParent('server-1', `@laptop:${SID_MASTER}`)).toBe(true)
    expect(calls.allowsCallParent('server-1', `@server-2:${SID_SERVER2}`)).toBe(false)

    // Ending one grant frees a slot while keeping recent call parent tracked; revoking clears it.
    const grant1 = calls.authorizeForNode('server-1', (g1.body as { grantId: string }).grantId)
    expect(grant1).not.toBeNull()
    if (!grant1) throw new Error('expected grant1')
    expect((await calls.end(grant1)).status).toBe(200)
    expect(calls.allowsCallParent('server-1', SID_MASTER)).toBe(true)
    const g3 = await calls.openForNode('server-1', { session: SID_MASTER })
    expect(g3.status).toBe(200)

    calls.revokeForNode('server-1')
    expect(calls.allowsCallParent('server-1', SID_MASTER)).toBe(false)
    expect(calls.authorizeForNode('server-1', (g3.body as { grantId: string }).grantId)).toBeNull()
  })

  test('PilotBridgeRunner enforces per-device dispatch, hasBody, and stream caps and orders stdin per run', async () => {
    const dir = scratchDir()
    const masterItem = makeItem({ key: SID_MASTER, session: SID_MASTER, cwd: join(dir, 'cleo-master') })
    const stdinDelivered: string[] = []
    let blockStartResolve: (() => void) | null = null
    let bodyGateResolve: (() => void) | null = null
    let bodyFetchCount = 0

    const fakeLocal: NodePilotCall = {
      check: async () => ({ status: 200, body: { ok: true, cwd: masterItem.cwd, profile: 'default' } }),
      start: async () => {
        await new Promise<void>(r => {
          blockStartResolve = r
        })
        return { status: 200, body: { ok: true, id: RUN_ID } }
      },
      events: () =>
        new Response(
          new ReadableStream({
            start() {
              // Keep open until cancelled.
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      stdin: (_runId, raw) => {
        stdinDelivered.push(String((raw as { line?: unknown }).line ?? ''))
        return { status: 200, body: { ok: true } }
      },
      mcpReply: () => ({ status: 200, body: { ok: true } }),
      close: () => ({ status: 200, body: { ok: true } }),
      uploadFiles: () => ({ status: 200, body: { ok: true, paths: {} } }),
      deliverReport: async () => ({ status: 200, body: { ok: true, id: 'r1' } }),
      closeAll: () => {},
    }

    const calls = createNodePilotCalls({
      cfg: {
        nodes: {
          id: 'laptop',
          devices: {
            'server-1': { pilotBridge: true, link: { kind: 'tailnet', address: '100.64.0.11', port: 12430 } },
            'server-2': { pilotBridge: true, link: { kind: 'tailnet', address: '100.64.0.12', port: 12430 } },
            'server-off': { link: { kind: 'tailnet', address: '100.64.0.13', port: 12430 } },
          },
        },
      } as Config,
      links: { link: () => null, onChange: () => () => {} },
      port: () => 12422,
      log: () => {},
      localPilotCall: fakeLocal,
      ownItems: () => [masterItem],
      masterId: () => 'laptop',
    })
    onTestFinished(() => calls.close())

    // Pre-open a grant and run synchronously on server-1 (bypassing blocked start).
    const openGrant = await calls.openForNode('server-1', { session: SID_MASTER })
    const grantId = (openGrant.body as { grantId: string }).grantId
    const grantObj = calls.authorizeForNode('server-1', grantId)
    if (!grantObj) throw new Error('expected grant')
    grantObj.runs.add(RUN_ID)

    const open2 = await calls.openForNode('server-2', { session: SID_MASTER })
    const grant2Id = (open2.body as { grantId: string }).grantId

    const responses = new Map<string, { status: number; body: Record<string, unknown> }>()
    const streamChunks: { streamId: string; chunk: Record<string, unknown> }[] = []
    let pushReq1: ((req: PilotBridgeRequest) => void) | null = null
    let pushReq2: ((req: PilotBridgeRequest) => void) | null = null
    let serverOffFetched = false

    const makeFakeLink = (id: string): Pick<Link, 'fetch' | 'state'> => ({
      state: () => ({ state: 'online', since: 0, heardAt: 0 }),
      async fetch(path: string, init?: RequestInit) {
        if (id === 'server-off') {
          serverOffFetched = true
          return new Response('', { status: 404 })
        }
        if (path === '/api/node/pilot-bridge') {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const send = (req: PilotBridgeRequest) => {
                controller.enqueue(new TextEncoder().encode(`event: req\ndata: ${JSON.stringify(req)}\n\n`))
              }
              if (id === 'server-1') pushReq1 = send
              else pushReq2 = send
            },
          })
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
        if (path.startsWith('/api/node/pilot-bridge/req/') && path.endsWith('/body')) {
          bodyFetchCount++
          await new Promise<void>(r => {
            bodyGateResolve = r
          })
          return new Response(JSON.stringify({ line: 'first-large' }), { status: 200 })
        }
        if (path.startsWith('/api/node/pilot-bridge/res/')) {
          const reqId = path.split('/').pop() as string
          const parsed = JSON.parse(String(init?.body ?? '{}')) as { status: number; body: string }
          responses.set(reqId, { status: parsed.status, body: JSON.parse(parsed.body) as Record<string, unknown> })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (path.startsWith('/api/node/pilot-bridge/stream/')) {
          const streamId = path.split('/').pop() as string
          const chunk = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
          streamChunks.push({ streamId, chunk })
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response('', { status: 404 })
      },
    })

    const listeners = new Set<(id: string) => void>()
    const linksMap: Record<string, Pick<Link, 'fetch' | 'state'>> = {
      'server-1': makeFakeLink('server-1'),
      'server-2': makeFakeLink('server-2'),
      'server-off': makeFakeLink('server-off'),
    }

    const runner = createPilotBridgeRunner({
      links: {
        link: id => (linksMap[id] as Link | undefined) ?? null,
        onChange: fn => {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
      },
      pilotCalls: calls,
      log: () => {},
      maxInflightPerDevice: 3,
      maxBodyFetchesPerDevice: 1,
      maxStreamsPerDevice: 1,
    })
    onTestFinished(() => runner.close())

    for (const fn of listeners) {
      fn('server-off')
      fn('server-1')
      fn('server-2')
    }

    await new Promise(r => setTimeout(r, 40))
    // Non-opted-in server-off is never subscribed to.
    expect(serverOffFetched).toBe(false)
    if (!pushReq1 || !pushReq2) throw new Error('expected bridge streams to connect')
    const send1: (r: PilotBridgeRequest) => void = pushReq1
    const send2: (r: PilotBridgeRequest) => void = pushReq2

    // 1. hasBody cap (1) + stdin ordering: slow hasBody stdin -> fast inline stdin -> extra hasBody (429).
    send1({ id: 'req-stdin-1', op: 'stdin', grantId, runId: RUN_ID, hasBody: true })
    send1({ id: 'req-stdin-2', op: 'stdin', grantId, runId: RUN_ID, body: JSON.stringify({ line: 'second-inline' }) })
    send1({ id: 'req-big-extra', op: 'files', grantId, hasBody: true })

    await new Promise(r => setTimeout(r, 40))
    // 2nd hasBody rejected with 429 before fetching its body; fast inline stdin waited behind req-stdin-1.
    expect(bodyFetchCount).toBe(1)
    expect(responses.get('req-big-extra')?.status).toBe(429)
    expect(stdinDelivered).toEqual([])

    // Inflight cap (3): req-stdin-1 and req-stdin-2 occupy 2 slots; add 1 more blocking start -> 4th gets 429.
    send1({ id: 'req-start-3', op: 'start', grantId, body: '{}' })
    send1({ id: 'req-sess-4', op: 'sessions', body: '{}' })
    // server-2 has its own cap and succeeds.
    send2({ id: 'req-s2-ok', op: 'sessions', body: '{}' })

    await new Promise(r => setTimeout(r, 40))
    expect(responses.get('req-sess-4')?.status).toBe(429)
    expect(responses.get('req-s2-ok')?.status).toBe(200)

    // Stream cap (1): 1st stream stays open, 2nd gets error chunk.
    send1({ id: 'req-ev-1', op: 'events', grantId, runId: RUN_ID, streamId: 'stream-1111' })
    send1({ id: 'req-ev-2', op: 'events', grantId, runId: RUN_ID, streamId: 'stream-2222' })
    await new Promise(r => setTimeout(r, 40))
    expect(streamChunks.some(c => c.streamId === 'stream-2222' && c.chunk.error === 'too many active streams')).toBe(
      true,
    )
    // events-close frees the stream slot even while inflight requests are full.
    send1({ id: 'req-ev-close', op: 'events-close', streamId: 'stream-1111' })
    await new Promise(r => setTimeout(r, 20))

    // Unblock body fetch and start -> stdin delivered strictly in [first-large, second-inline] order!
    ;(bodyGateResolve as (() => void) | null)?.()
    ;(blockStartResolve as (() => void) | null)?.()
    const deadline = Date.now() + 2000
    while (
      (!responses.has('req-stdin-1') || !responses.has('req-stdin-2') || !responses.has('req-start-3')) &&
      Date.now() < deadline
    ) {
      await new Promise(r => setTimeout(r, 15))
    }
    expect(responses.get('req-stdin-1')?.status).toBe(200)
    expect(responses.get('req-stdin-2')?.status).toBe(200)
    expect(stdinDelivered).toEqual(['first-large', 'second-inline'])

    // Slots freed after completion -> new sessions request succeeds on server-1 (and grant2 works on server-2).
    send1({ id: 'req-sess-after', op: 'sessions', body: '{}' })
    send2({ id: 'req-s2-end', op: 'end', grantId: grant2Id, body: '{}' })
    await new Promise(r => setTimeout(r, 40))
    expect(responses.get('req-sess-after')?.status).toBe(200)
    expect(responses.get('req-s2-end')?.status).toBe(200)
  })
})
