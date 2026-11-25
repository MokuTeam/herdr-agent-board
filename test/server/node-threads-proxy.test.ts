// Node web board threads read proxy (#759):
// - On a node whose master has threads on: GET /api/threads, GET /api/threads/<key>,
//   GET /api/threads/events, and POST /api/reveal {thread} proxy to the master over the
//   existing link, matching the master's data and SSE rev stream.
// - Master offline: 503 with a plain reason (never 409). Master with threads off: 409.
// - Guards: loopback-only, Origin rejected on GET, X-Board: 1 required on POST /api/reveal,
//   door returns 404 for /api/threads* and /api/reveal; HTTP writes remain on master (409 on node).
// - `board thread link --base` on a node without --session returns the node's local board URL.
// - Standalone and master boards without `node` go down the exact same code path as before across
//   Claude UUID, pane-<id>, Windows paths, spaces, Cyrillic, and % session keys.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardPayload } from '../../src/core/payload.ts'
import { serveBoard } from '../support/board-server.ts'
import { type FakePane, nodePair, PAIR_ENV, type PairNode } from '../support/node-pair.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { SCREEN } from '../support/sleeper-fixtures.ts'

const S = '11111111-1111-4111-8111-111111111111'
const ENV = {
  ...PAIR_ENV,
  BOARD_NODE_THREADS_MS: '3000',
  BOARD_NODE_KEPT_MS: '1500',
  BOARD_NODE_READ_MS: '3000',
}

function writeConfig(box: Sandbox, cfg: Record<string, unknown>): void {
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2))
}

const portOf = (url: string): number => Number(new URL(url).port)

const pane = (box: Sandbox): FakePane[] => [
  { pane_id: 'p1', agent: 'claude', agent_session: { value: S }, agent_status: 'idle', cwd: box.dir },
]

function herdrOf(box: Sandbox, panes: FakePane[]): void {
  box.state({
    'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } },
    'agent get': {
      result: { agent: { pane_id: 'p1', agent: 'claude', agent_session: { value: S }, agent_status: 'idle' } },
    },
    'agent prompt': { result: {} },
    'agent read': { text: SCREEN },
  })
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await fn()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`)
    await Bun.sleep(40)
  }
}

async function openSse(url: string, signal: AbortSignal) {
  const res = await fetch(url, { signal })
  if (!res.body) throw new Error(`no SSE body from ${url}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const nextEvent = async (timeoutMs = 10_000): Promise<{ name: string; data: string } | null> => {
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), timeoutMs)
    try {
      for (;;) {
        const sep = buf.indexOf('\n\n')
        if (sep >= 0) {
          const block = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          let name = 'message'
          const dataLines: string[] = []
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          }
          if (dataLines.length > 0) return { name, data: dataLines.join('\n') }
          continue
        }
        const next = await reader.read()
        if (next.done) return null
        buf += decoder.decode(next.value, { stream: true })
      }
    } finally {
      clearTimeout(timer)
    }
  }
  return { res, reader, nextEvent }
}

async function setupThreadPair(threads: unknown = true) {
  const pair = await nodePair({
    env: ENV,
    masterCfg: { threads, scheduleTickSec: 0.2 },
    panes: (_id, box) => pane(box),
    masterPanes: () => [],
  })
  const node = pair.nodes[0] as PairNode
  herdrOf(node.box, pane(node.box))
  writeConfig(node.box, {
    language: 'en',
    port: portOf(node.url),
    node: { id: node.id, port: node.doorPort, workRoot: node.box.dir },
  })
  writeConfig(pair.master.box, {
    language: 'en',
    port: portOf(pair.master.url),
    threads,
  })
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  return { pair, node }
}

describe('node web board threads proxy (#759)', () => {
  test('proxies threads reads, SSE rev stream, and POST /api/reveal {thread}; 503 when master offline; guards enforced', async () => {
    const { pair, node } = await setupThreadPair(true)

    // Create threads on master via HTTP as owner (with anna/ben/cleo/atlas test names).
    const c1 = await fetch(`${pair.master.url}/api/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'new', lane: 'other', title: 'Atlas task for anna', doing: true }),
    })
    expect(c1.status).toBe(200)
    const { key: key1 } = (await c1.json()) as { key: string }
    expect(key1).toBe('other-1')

    const c2 = await fetch(`${pair.master.url}/api/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'new', lane: 'other', title: 'Ben review', parent: key1 }),
    })
    expect(c2.status).toBe(200)
    const { key: key2 } = (await c2.json()) as { key: string }

    // Wait until the master has pushed rev to the node and proxy reads are live.
    await waitFor('node /api/threads returns master data', async () => {
      const r = await fetch(`${node.url}/api/threads`)
      if (r.status !== 200) return null
      const body = (await r.json()) as { threads: { key: string }[] }
      return body.threads.length >= 2 ? body : null
    })

    // GET /api/threads and query filters match master's data.
    for (const suffix of ['', '?closed=1', '?lane=other', '?status=doing', '?status=nope']) {
      const [mRes, nRes] = await Promise.all([
        fetch(`${pair.master.url}/api/threads${suffix}`),
        fetch(`${node.url}/api/threads${suffix}`),
      ])
      expect(nRes.status).toBe(mRes.status)
      expect(await nRes.json()).toEqual(await mRes.json())
    }

    // GET /api/threads/<key> (full, last, 8-char id, missing) matches master's data.
    const masterOne = (await (await fetch(`${pair.master.url}/api/threads/${key1}?full=1`)).json()) as {
      head: { id: string; key: string }
    }
    const shortId = masterOne.head.id.slice(0, 8)
    for (const suffix of [`/${key1}`, `/${key1}?full=1`, `/${key1}?last=1`, `/${shortId}`, '/other-999']) {
      const [mRes, nRes] = await Promise.all([
        fetch(`${pair.master.url}/api/threads${suffix}`),
        fetch(`${node.url}/api/threads${suffix}`),
      ])
      expect(nRes.status).toBe(mRes.status)
      expect(await nRes.json()).toEqual(await mRes.json())
    }

    // GET /api/threads/events relays initial rev and live updates from master.
    const threadsSseAc = new AbortController()
    const threadsSse = await openSse(`${node.url}/api/threads/events`, threadsSseAc.signal)
    expect(threadsSse.res.status).toBe(200)
    const initialEv = await threadsSse.nextEvent()
    expect(initialEv?.name).toBe('rev')
    const initialRev = (JSON.parse(initialEv?.data ?? '{}') as { rev: number }).rev
    expect(initialRev).toBeGreaterThan(0)

    // Post an update on master and verify the node's SSE stream receives the bumped rev.
    const postMaster = await fetch(`${pair.master.url}/api/threads/${key2}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'post', text: 'cleo checked this' }),
    })
    expect(postMaster.status).toBe(200)
    const nextEv = await threadsSse.nextEvent()
    expect(nextEv?.name).toBe('rev')
    const bumpedRev = (JSON.parse(nextEv?.data ?? '{}') as { rev: number }).rev
    expect(bumpedRev).toBeGreaterThan(initialRev)

    // POST /api/reveal {thread} on node: validates X-Board, key syntax, existence on master, and emits thread-open.
    expect(
      (
        await fetch(`${node.url}/api/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ thread: key1 }),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(`${node.url}/api/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-board': '1' },
          body: JSON.stringify({ thread: 'not a thread' }),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await fetch(`${node.url}/api/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-board': '1' },
          body: JSON.stringify({ thread: 'other-999' }),
        })
      ).status,
    ).toBe(404)

    const boardSseAc = new AbortController()
    const boardSse = await openSse(`${node.url}/api/events`, boardSseAc.signal)
    await boardSse.nextEvent() // initial board payload
    const revealOk = await fetch(`${node.url}/api/reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ thread: key1 }),
    })
    expect(revealOk.status).toBe(200)
    const revealBody = (await revealOk.json()) as { ok: boolean; thread: string; pages: number }
    expect(revealBody.ok).toBe(true)
    expect(revealBody.thread).toBe(key1)
    expect(revealBody.pages).toBeGreaterThanOrEqual(1)
    const openEv = await boardSse.nextEvent()
    expect(openEv?.name).toBe('thread-open')
    expect(JSON.parse(openEv?.data ?? '{}')).toEqual({ key: key1 })
    boardSseAc.abort()

    // POST /api/reveal {key} for a local node session still works normally.
    await waitFor('node sees local session S', async () => {
      const p = (await (await fetch(`${node.url}/api/board`)).json()) as BoardPayload
      return p.items.some(i => i.key === S) ? true : null
    })
    const revealSession = await fetch(`${node.url}/api/reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ key: S }),
    })
    expect(revealSession.status).toBe(200)

    // Loopback / guard checks:
    // - Cross-origin browser GET rejected with 403
    expect((await fetch(`${node.url}/api/threads`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    // - Same-origin GET allowed
    expect((await fetch(`${node.url}/api/threads`, { headers: { origin: node.url } })).status).toBe(200)
    // - Node door refuses /api/threads*, /api/reveal with 404
    for (const [method, path] of [
      ['GET', '/api/threads'],
      ['GET', `/api/threads/${key1}`],
      ['GET', '/api/threads/events'],
      ['POST', '/api/reveal'],
    ] as const) {
      const doorRes = await fetch(`http://127.0.0.1:${node.doorPort}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${node.token}`,
          ...(method === 'POST' && { 'x-board': '1', 'content-type': 'application/json' }),
        },
        ...(method === 'POST' && { body: JSON.stringify({ thread: key1 }) }),
      })
      expect([method, path, doorRes.status]).toEqual([method, path, 404])
    }

    // HTTP writes on the node web board stay unforwarded (remain 409 on the node).
    const writeOnNode = await fetch(`${node.url}/api/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'new', lane: 'other', title: 'Should not write from node HTTP' }),
    })
    expect(writeOnNode.status).toBe(409)

    // `board thread link --base` via real CLI on the node without --session returns the node's local board URL.
    const linkOut = await node.box.run('cli', { args: ['thread', 'link', '--base', '--json'], env: {} }).exited
    expect(linkOut.code).toBe(0)
    expect(JSON.parse(linkOut.stdout)).toEqual({
      ok: true,
      url: `${node.url}/`,
      threads: true,
      agents: true,
      day_watches: true,
    })

    // Master offline -> 503 with plain reason (not 409), and open /api/threads/events stream closes.
    await node.proxy.cut('drop')
    await pair.waitDevice(node.id, d => d.link?.state === 'offline', 10_000)
    expect(await threadsSse.nextEvent()).toBeNull()
    threadsSseAc.abort()

    for (const [method, path, body] of [
      ['GET', '/api/threads', undefined],
      ['GET', `/api/threads/${key1}`, undefined],
      ['GET', '/api/threads/events', undefined],
      ['POST', '/api/reveal', { thread: key1 }],
    ] as const) {
      const offRes = await fetch(`${node.url}${path}`, {
        method,
        headers: { ...(method === 'POST' && { 'content-type': 'application/json', 'x-board': '1' }) },
        ...(body && { body: JSON.stringify(body) }),
      })
      expect([method, path, offRes.status]).toEqual([method, path, 503])
      const errBody = (await offRes.json()) as { ok: boolean; error: string }
      expect(errBody.ok).toBe(false)
      expect(errBody.error.length).toBeGreaterThan(0)
    }

    // Restoring link resumes 200.
    node.proxy.restore()
    await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
    await waitFor('node threads proxy recovers after reconnect', async () => {
      const r = await fetch(`${node.url}/api/threads`)
      return r.status === 200 ? true : null
    })
  }, 60_000)

  test('master with threads off answers 409 through the node proxy', async () => {
    const { node } = await setupThreadPair(false)
    await waitFor('node sees master threads-off state', async () => {
      const r = await fetch(`${node.url}/api/threads`)
      return r.status === 409 ? true : null
    })
    for (const [method, path, body] of [
      ['GET', '/api/threads', undefined],
      ['GET', '/api/threads/other-1', undefined],
      ['GET', '/api/threads/events', undefined],
      ['POST', '/api/reveal', { thread: 'other-1' }],
    ] as const) {
      const r = await fetch(`${node.url}${path}`, {
        method,
        headers: { ...(method === 'POST' && { 'content-type': 'application/json', 'x-board': '1' }) },
        ...(body && { body: JSON.stringify(body) }),
      })
      expect([method, path, r.status]).toEqual([method, path, 409])
    }
  }, 40_000)

  test('standalone board without node is unchanged across varied session keys and thread states', async () => {
    const box = await sandbox()
    const keys = [
      'c0ffee00-1234-4abc-8def-0123456789ab',
      'pane-12',
      'C:\\Users\\anna\\.pi\\sessions\\2026 11\\a.jsonl',
      '/home/ben/.pi/sessions/a b.jsonl',
      'Атлас 12',
      '100% done',
    ]
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: keys.map((k, idx) => ({
              pane_id: `p${idx + 1}`,
              agent: idx === 0 ? 'claude' : 'pi',
              agent_session: { value: k },
              agent_status: 'idle',
              cwd: box.dir,
            })),
            tabs: [],
            workspaces: [],
          },
        },
      },
    })

    const offBoard = await serveBoard(box, { threads: false }, PAIR_ENV)
    expect((await fetch(`${offBoard.url}/api/threads`)).status).toBe(409)
    expect(
      (
        await fetch(`${offBoard.url}/api/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-board': '1' },
          body: JSON.stringify({ thread: 'other-1' }),
        })
      ).status,
    ).toBe(409)
    offBoard.proc.kill()
    await offBoard.proc.exited

    const onBoard = await serveBoard(box, { threads: true }, PAIR_ENV)
    const created = await fetch(`${onBoard.url}/api/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'new', lane: 'other', title: 'Standalone cleo' }),
    })
    expect(created.status).toBe(200)
    const listRes = await fetch(`${onBoard.url}/api/threads`)
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as { threads: { key: string }[] }
    expect(list.threads.map(t => t.key)).toEqual(['other-1'])
    for (const k of keys) {
      const mine = await fetch(`${onBoard.url}/api/threads?mine=${encodeURIComponent(k)}`)
      expect(mine.status).toBe(200)
      expect(((await mine.json()) as { threads: unknown[] }).threads).toEqual([])
    }
    const rev = await fetch(`${onBoard.url}/api/reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ thread: 'other-1' }),
    })
    expect(rev.status).toBe(200)
    await until(() => true)
    onBoard.proc.kill()
    await onBoard.proc.exited
  }, 40_000)
})
