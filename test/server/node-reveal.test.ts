// A reveal on a node reaches the board's window when it shows the master (#841): after #839 the
// node's page goes to its master, so a notification clicked (POST /api/reveal { pane }) or
// `board thread open` (POST /api/reveal { thread }) on the node must tell the master's pages.
// - nodeRevealOf / nodeRevealAnswer: the node names only its own session, by its bare key; the
//   master shows it as @<node>:<key> (Claude ids, pane-<n>, Windows paths, spaces, Cyrillic, %).
// - revealRoute / threadUp with a stubbed master: the master's ok and "no such thread" are the
//   answer; no answer, a refusal, a throw or a slow master go to the node's own threads as before;
//   the session's local answer never waits for the master.
// - web-open on the node (a notification clicked, `board thread open`): the board's window open,
//   it is raised and the master's page in it opens the session or the thread, no second window;
//   none open, one window opens on the node's address with the session (#839 takes it on).
// - A master and a node, each a real board with a fake herdr: with the master's board URL (the
//   node's page goes there) the master's page hears the session and the thread; the node's own
//   answer is as before. Without that URL the node's page stays local and nothing goes up.
import { describe, expect, test } from 'bun:test'
import { nodeRevealOf, RELAY_TABLE, relayMatch } from '../../src/core/master-relay.ts'
import type { BoardWindow } from '../../src/integrations/edge-window.ts'
import { nodeRevealAnswer, revealRoute, threadUp } from '../../src/server/routes/reveal.ts'
import { openWeb } from '../../src/services/web-open.ts'
import { nodePair, type PairNode } from '../support/node-pair.ts'

const S = '0f3c2a1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b'
const HEADERS = { 'content-type': 'application/json', 'x-board': '1' }
const TUNNEL = { on: true, domain: 'board.atlas.test', host: 'atlas.test', user: 'boardtunnel' }

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })

async function until<T>(what: string, f: () => Promise<T | null | undefined>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await f()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`never came: ${what}`)
    await Bun.sleep(50)
  }
}

/** A page of a board, listening: what its stream said so far. */
async function listen(url: string): Promise<{ heard: () => string; close(): void }> {
  const controller = new AbortController()
  const res = await fetch(`${url}/api/events`, { signal: controller.signal })
  const reader = res.body?.getReader()
  if (!reader) throw new Error('no stream')
  let heard = ''
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read())
        heard += decoder.decode(r.value, { stream: true })
    } catch {}
  })()
  await until('the page is in', async () => heard.includes('data:'))
  return { heard: () => heard, close: () => controller.abort() }
}

const told = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

describe('what a node may ask its master to show (#841)', () => {
  test('the path is relay-only, in a group of its own', () => {
    const m = relayMatch('POST', '/api/node-reveal', () => false)
    expect(m?.kind === 'table' && m.entry.group).toBe('reveal')
    expect(m?.kind === 'table' && m.entry.relayOnly).toBe(true)
    expect(relayMatch('GET', '/api/node-reveal', () => false)).toBeNull()
    // The node's own /api/reveal stays its own (web-open.ts asks it for the pane's session).
    expect(relayMatch('POST', '/api/reveal', () => false)).toBeNull()
    expect(RELAY_TABLE.filter(e => e.group === 'reveal')).toHaveLength(1)
  })

  test('its own session by its bare key, or a thread; nothing else', () => {
    expect(nodeRevealOf({ key: S })).toEqual({ key: S })
    expect(nodeRevealOf({ thread: 'bb-19' })).toEqual({ thread: 'bb-19' })
    for (const raw of [
      null,
      'x',
      [],
      {},
      { key: '' },
      { key: '@server-2:abc' },
      { key: 'a\u0000b' },
      { key: 'k'.repeat(1025) },
      { key: S, thread: 'bb-19' },
      { key: 7 },
      { thread: '' },
      { thread: 't'.repeat(129) },
    ])
      expect(nodeRevealOf(raw)).toBeNull()
  })

  test("the master shows the node's session by the key it knows it by, and a thread as threads do", () => {
    const keys = [S, 'pane-17', 'C:\\Users\\Some One\\.pi\\sessions\\a b.jsonl', 'сессия 100%']
    const known = new Set(keys.map(k => `@server-1:${k}`))
    const sent: [string, unknown][] = []
    const asked: string[] = []
    const threads: unknown[] = []
    const deps = {
      findAny: (key: string) => (known.has(key) ? { key } : undefined),
      events: { event: (name: string, data: unknown) => void sent.push([name, data]), size: () => 2 },
      state: { asked: (key: string) => void asked.push(key) },
      thread: (word: unknown) => {
        threads.push(word)
        return Response.json({ ok: true, thread: word })
      },
    }
    for (const key of keys) {
      const res = nodeRevealAnswer({ key }, 'server-1', deps)
      expect(res.status).toBe(200)
    }
    expect(sent).toEqual(keys.map(k => ['reveal', { key: `@server-1:${k}` }]))
    expect(asked).toEqual(keys.map(k => `@server-1:${k}`))

    // Another node's session by the same bare key: not this node's, not shown.
    expect(nodeRevealAnswer({ key: S }, 'server-2', deps).status).toBe(404)
    expect(nodeRevealAnswer({ key: `@server-1:${S}` }, 'server-1', deps).status).toBe(400)
    expect(nodeRevealAnswer({ key: S }, 'local', deps).status).toBe(400)
    expect(nodeRevealAnswer(null, 'server-1', deps).status).toBe(400)
    expect(sent).toHaveLength(keys.length)

    expect(nodeRevealAnswer({ thread: 'bb-19' }, 'server-1', deps).status).toBe(200)
    expect(threads).toEqual(['bb-19'])
  })
})

describe('the node side with a stubbed master (#841)', () => {
  const local = () => {
    const calls: unknown[] = []
    return {
      calls,
      thread: (word: unknown) => {
        calls.push(word)
        return Response.json({ ok: false, error: 'local' }, { status: 409 })
      },
    }
  }
  const events = () => {
    const sent: [string, unknown][] = []
    return { sent, event: (name: string, data: unknown) => void sent.push([name, data]), size: () => 1 }
  }

  test("the master's ok: its answer, and the node's pages open the thread too", async () => {
    const l = local()
    const e = events()
    const asked: unknown[] = []
    const res = await threadUp(' BB-19 ', l.thread, e, async what => {
      asked.push(what)
      return Response.json({ ok: true, thread: 'bb-19', pages: 3 })
    })
    expect(asked).toEqual([{ thread: 'bb-19' }])
    expect(await res.json()).toEqual({ ok: true, thread: 'bb-19', pages: 3 })
    expect(e.sent).toEqual([['thread-open', { key: 'bb-19' }]])
    expect(l.calls).toEqual([])
  })

  test('the master has no such thread: its answer, nothing opened', async () => {
    for (const status of [400, 404]) {
      const l = local()
      const e = events()
      const res = await threadUp('nope-9', l.thread, e, async () => Response.json({ ok: false }, { status }))
      expect(res.status).toBe(status)
      expect(e.sent).toEqual([])
      expect(l.calls).toEqual([])
    }
  })

  test("no answer, a refusal, a master away or a throw: the node's own threads, as before", async () => {
    const ups = [
      async () => null,
      async () => Response.json({ ok: false, error: 'master-relay-owner' }, { status: 403 }),
      async () => Response.json({ ok: false, error: 'node-master-offline' }, { status: 503 }),
      async () => {
        throw new Error('link gone')
      },
    ]
    for (const up of ups) {
      const l = local()
      const e = events()
      const res = await threadUp('bb-19', l.thread, e, up)
      expect(res.status).toBe(409)
      expect(l.calls).toEqual(['bb-19'])
      expect(e.sent).toEqual([])
    }
    // An empty word is not asked of the master at all.
    const l = local()
    let asked = 0
    await threadUp('', l.thread, events(), async () => {
      asked++
      return null
    })
    expect(asked).toBe(0)
    expect(l.calls).toEqual([''])
  })

  test("a notification's session: the node's answer does not wait for the master, nor fail with it", async () => {
    const board = { find: () => undefined, items: () => [{ key: S, pane: 'p1' }] as never }
    for (const up of [() => new Promise<null>(() => {}), () => Promise.reject(new Error('link gone'))]) {
      const e = events()
      const route = revealRoute(board, e, { asked: () => {} }, undefined, up)
      const ctx = { body: async () => ({ pane: 'p1' }) } as unknown as Parameters<typeof route.handle>[1]
      const res = await route.handle(new Request('http://127.0.0.1/api/reveal', { method: 'POST' }), ctx)
      if (!res) throw new Error('no answer')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, key: S, pages: 1 })
      expect(e.sent).toEqual([['reveal', { key: S }]])
    }
  })
})

/** A master with threads on, a node with a session in pane p1; with `url`, the master's board URL. */
async function meshWith(url: boolean, nodeEnv: Record<string, string> = {}) {
  const pair = await nodePair({
    nodeEnv: () => nodeEnv,
    masterCfg: { threads: true, ...(url && { tunnel: TUNNEL }) },
    masterPanes: () => [],
    panes: (_id, box) => [
      { pane_id: 'p1', agent: 'claude', agent_session: { value: S }, agent_status: 'idle', cwd: box.dir },
    ],
  })
  const node = pair.nodes[0] as PairNode
  await pair.waitDevice(node.id, d => d.link?.state === 'online', 10_000)
  const remote = `@${node.id}:${S}`
  await until('the master has the node session', async () => {
    const b = (await (await fetch(`${pair.master.url}/api/board`)).json()) as { items: { key: string }[] }
    return b.items.some(i => i.key === remote)
  })
  await until('the node has its master', async () => {
    const b = (await (await fetch(`${node.url}/api/board`)).json()) as {
      items: { key: string }[]
      nodeMaster?: { online: boolean; url: string | null }
    }
    return b.items.some(i => i.key === S) && b.nodeMaster?.online && (b.nodeMaster.url !== null) === url
  })
  return { pair, node, remote }
}

test("the node's page is on the master: the master's page shows the notification's session and the thread", async () => {
  const { pair, node, remote } = await meshWith(true)
  const made = await post(`${pair.master.url}/api/threads`, { op: 'new', lane: 'atlas', title: 'Reveal check ☃' })
  expect(made.status).toBe(200)
  const thread = ((await made.json()) as { key: string }).key

  const onMaster = await listen(pair.master.url)
  const onNode = await listen(node.url)
  try {
    // A notification clicked on the node: its answer is as before, its own key.
    const shown = await post(`${node.url}/api/reveal`, { pane: 'p1' })
    expect(shown.status).toBe(200)
    expect(((await shown.json()) as { key: string }).key).toBe(S)
    await until('the node page hears it', async () => onNode.heard().includes(told('reveal', { key: S })))
    await until("the master's page hears it", async () => onMaster.heard().includes(told('reveal', { key: remote })))

    // `board thread open` on the node: the master's thread, on the master's page and the node's.
    const opened = await post(`${node.url}/api/reveal`, { thread })
    expect(opened.status).toBe(200)
    expect(((await opened.json()) as { ok: boolean }).ok).toBe(true)
    await until("the master's page opens the thread", async () =>
      onMaster.heard().includes(told('thread-open', { key: thread })),
    )
    await until('the node page opens it too', async () => onNode.heard().includes(told('thread-open', { key: thread })))

    // A thread the master does not have: the node answers as it did before, and nothing is opened.
    const gone = await post(`${node.url}/api/reveal`, { thread: 'nope-999' })
    expect(gone.ok).toBe(false)
    expect(onMaster.heard()).not.toContain('nope-999')
    expect(onNode.heard()).not.toContain('nope-999')
  } finally {
    onMaster.close()
    onNode.close()
  }
}, 60_000)

test("the node's page stays local (no board URL on the master): nothing goes up, the node answers as before", async () => {
  const { pair, node } = await meshWith(false)
  const onMaster = await listen(pair.master.url)
  const onNode = await listen(node.url)
  try {
    const shown = await post(`${node.url}/api/reveal`, { pane: 'p1' })
    expect(shown.status).toBe(200)
    expect(((await shown.json()) as { key: string }).key).toBe(S)
    await until('the node page hears it', async () => onNode.heard().includes(told('reveal', { key: S })))
    await Bun.sleep(1000)
    expect(onMaster.heard()).not.toContain('event: reveal')
  } finally {
    onMaster.close()
    onNode.close()
  }
}, 60_000)

test('a slow master: the node gives up on it in time and answers from its own threads', async () => {
  const { pair, node } = await meshWith(true, { BOARD_REVEAL_UP_MS: '300' })
  const made = await post(`${pair.master.url}/api/threads`, { op: 'new', lane: 'atlas', title: 'Slow check' })
  const thread = ((await made.json()) as { key: string }).key
  // The master's answers to the node's relayed requests come late.
  node.proxy.intercept = async (method, path, forward) => {
    if (method !== 'POST' || !path.startsWith('/api/node/master-relay/res/')) return null
    await Bun.sleep(1500)
    return forward()
  }
  try {
    const started = Date.now()
    const res = await post(`${node.url}/api/reveal`, { thread })
    const took = Date.now() - started
    expect(took).toBeLessThan(1400)
    // What the node's own threads say (a node keeps none of its own), as before #841.
    expect(res.ok).toBe(false)
  } finally {
    node.proxy.intercept = null
  }
}, 60_000)

/** The board's window as web-open sees it: open (`raised`) or not, and what it was asked. */
function fakeWindow(raised: boolean) {
  const did: string[] = []
  const win: BoardWindow = {
    async open(url) {
      did.push(`open ${url}`)
    },
    async raise() {
      did.push('raise')
      return raised
    },
    launch(url) {
      did.push(`launch ${url}`)
    },
  }
  return { win, did }
}

test("a click on the node with the board's window open on the master: that window, the session and the thread in it", async () => {
  const { pair, node, remote } = await meshWith(true)
  const made = await post(`${pair.master.url}/api/threads`, { op: 'new', lane: 'atlas', title: 'Window check' })
  const thread = ((await made.json()) as { key: string }).key
  const cfg = { port: Number(new URL(node.url).port) }
  const onMaster = await listen(pair.master.url)
  try {
    const clicked = fakeWindow(true)
    const r = await openWeb(cfg, { pane: 'p1', window: clicked.win })
    expect(r).toEqual({ ok: true, url: `${node.url}/`, key: S })
    expect(clicked.did).toEqual(['raise'])
    await until("the master's page in it opens the session", async () =>
      onMaster.heard().includes(told('reveal', { key: remote })),
    )

    const opened = fakeWindow(true)
    expect(await openWeb(cfg, { thread, window: opened.win })).toEqual({ ok: true, url: `${node.url}/`, key: thread })
    expect(opened.did).toEqual(['raise'])
    await until("the master's page in it opens the thread", async () =>
      onMaster.heard().includes(told('thread-open', { key: thread })),
    )

    // No board window anywhere: one opens, on the node's address with the session.
    const none = fakeWindow(false)
    expect(await openWeb(cfg, { pane: 'p1', window: none.win })).toEqual({ ok: true, url: `${node.url}/` })
    expect(none.did).toEqual(['raise', `launch ${node.url}/#session=${encodeURIComponent(S)}`])
  } finally {
    onMaster.close()
  }
}, 60_000)
