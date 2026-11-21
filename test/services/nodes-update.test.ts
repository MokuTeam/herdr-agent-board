// The master ships its commit to a node (#590, services/nodes/update.ts), with fake links and a test
// clock: a node online on another commit with no session in a turn gets it once; a session in a
// turn holds it until the turn ends; asked, it goes at once; a failure is said and not tried again
// by itself for the same commits; a board with no git checkout says it cannot send; a node that
// does not come back on the commit is a failure.
import { describe, expect, test } from 'bun:test'
import type { DeviceUpdate } from '../../src/core/nodes.ts'
import { createNodeUpdater, type NodeUpdaterOptions } from '../../src/services/nodes/update.ts'
import { fakeClock } from '../support/fake-tunnel.ts'

const OURS = 'b'.repeat(40)
const THEIRS = 'a'.repeat(40)
const ARCHIVE = new TextEncoder().encode('the plugin as a tar')
const SHA = new Bun.CryptoHasher('sha256').update(ARCHIVE).digest('hex')

type Reply = { status: number; body: Record<string, unknown> }

function fakeNode(id: string) {
  const node = {
    id,
    state: 'online' as 'online' | 'offline',
    commit: THEIRS,
    items: [] as { key: string; status: string }[],
    launches: 0,
    requests: [] as string[],
    /** What the node answers `POST /api/node/update`; the blob is answered with its sha256. */
    update: { status: 200, body: { ok: true, commit: OURS, restarting: true } } as Reply,
    /** Held until released, for a test of what comes meanwhile. */
    hold: null as Promise<void> | null,
    link: null as unknown,
  }
  node.link = {
    id,
    state: () => ({ state: node.state, since: 0, heardAt: null }),
    view: () => ({ id, status: { commit: node.commit, launches: node.launches } }),
    payload: () => ({ items: node.items }),
    async fetch(path: string, init: RequestInit = {}) {
      node.requests.push(`${init.method ?? 'GET'} ${path}`)
      if (node.hold) await node.hold
      if (path === '/api/node/update/blob') {
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer())
        const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
        return Response.json({ ok: true, sha256, size: bytes.length })
      }
      return Response.json(node.update.body, { status: node.update.status })
    },
  }
  return node
}

function harness(over: Partial<NodeUpdaterOptions> = {}, ids = ['server-1']) {
  const nodes = new Map(ids.map(id => [id, fakeNode(id)]))
  const fns = new Set<(id: string) => void>()
  const time = fakeClock()
  const logs: string[] = []
  let archives = 0
  let published = 0
  const updater = createNodeUpdater({
    links: {
      on: () => true,
      link: id => (nodes.get(id)?.link as never) ?? null,
      onChange(fn) {
        fns.add(fn)
        return () => fns.delete(fn)
      },
    },
    commit: async () => OURS,
    canShip: async () => true,
    archive: async () => {
      archives++
      return ARCHIVE
    },
    onChange: () => {
      published++
    },
    log: t => logs.push(t),
    clock: time.clock,
    backMs: 180_000,
    ...over,
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Bun.sleep(1)
  }
  return {
    updater,
    time,
    logs,
    node: (id = 'server-1') => nodes.get(id) as ReturnType<typeof fakeNode>,
    archives: () => archives,
    published: () => published,
    /** The link brings a payload, a state or a status. */
    async change(id = 'server-1'): Promise<void> {
      for (const fn of fns) fn(id)
      await settle()
    },
    settle,
  }
}

const state = (u: DeviceUpdate | null): string | null => u?.state ?? null

describe('the master ships its commit to a node by itself', () => {
  test('online on another commit with no session in a turn: shipped once, restarting until its status names the commit', async () => {
    const h = harness()
    await h.change()
    await h.change()
    expect(h.node().requests).toEqual(['PUT /api/node/update/blob', 'POST /api/node/update'])
    expect(h.updater.view('server-1')).toEqual({ state: 'restarting', commit: OURS, at: h.time.now() })
    expect(h.updater.updating('server-1')).toBe(true)
    // the node comes back on the new commit
    h.node().commit = OURS
    await h.change()
    expect(h.updater.view('server-1')).toBeNull()
    expect(h.updater.updating('server-1')).toBe(false)
    expect(h.logs.join('\n')).toContain(`server-1 runs ${OURS.slice(0, 12)} now`)
    expect(h.node().requests).toHaveLength(2)
    expect(h.published()).toBeGreaterThan(0)
  })

  test("the update names the commit and the archive's sha256", async () => {
    const h = harness()
    const bodies: string[] = []
    const link = h.node().link as { fetch(p: string, i?: RequestInit): Promise<Response> }
    const fetch = link.fetch.bind(link)
    link.fetch = async (p, i) => {
      if (p === '/api/node/update') bodies.push(String(i?.body))
      return fetch(p, i)
    }
    await h.change()
    expect(bodies.map(b => JSON.parse(b))).toEqual([{ commit: OURS, sha256: SHA }])
  })

  test('a session in a turn holds it; it goes when the turn ends', async () => {
    const h = harness()
    h.node().items = [
      { key: 's-1', status: 'working' },
      { key: 's-2', status: 'idle' },
    ]
    await h.change()
    await h.change()
    expect(h.node().requests).toEqual([])
    expect(h.updater.view('server-1')).toBeNull()
    h.node().items = [
      { key: 's-1', status: 'idle' },
      { key: 's-2', status: 'blocked' },
    ]
    await h.change()
    expect(h.node().requests).toEqual(['PUT /api/node/update/blob', 'POST /api/node/update'])
  })

  test('asked, it goes at once though a session is in a turn', async () => {
    const h = harness()
    h.node().items = [{ key: 's-1', status: 'working' }]
    expect(await h.updater.ship('server-1')).toEqual({ ok: true, commit: OURS })
    expect(h.node().requests).toEqual(['PUT /api/node/update/blob', 'POST /api/node/update'])
    expect(state(h.updater.view('server-1'))).toBe('restarting')
  })

  test('a failure is said and kept, not tried again by itself for the same commits; asked, or on another commit, it is', async () => {
    const h = harness()
    h.node().update = {
      status: 500,
      body: { ok: false, error: 'install', detail: 'error: could not reach the registry' },
    }
    await h.change()
    expect(h.updater.view('server-1')).toEqual({
      state: 'failed',
      commit: OURS,
      error: 'install',
      detail: 'error: could not reach the registry',
      at: h.time.now(),
    })
    expect(h.logs.join('\n')).toContain('the update of server-1')
    for (let i = 0; i < 5; i++) await h.change()
    await h.time.advance(600_000)
    expect(h.node().requests).toHaveLength(2)
    // asked: once more
    expect((await h.updater.ship('server-1')).error).toBe('install')
    expect(h.node().requests).toHaveLength(4)
    // the node reports another commit than before: a new pair, tried once by itself
    h.node().commit = 'c'.repeat(40)
    await h.change()
    await h.change()
    expect(h.node().requests).toHaveLength(6)
  })

  test('a node that does not come back on the commit within the wait is a failure, said once', async () => {
    const h = harness()
    await h.change()
    expect(state(h.updater.view('server-1'))).toBe('restarting')
    await h.time.advance(179_000)
    expect(state(h.updater.view('server-1'))).toBe('restarting')
    await h.time.advance(2000)
    expect(h.updater.view('server-1')).toMatchObject({ state: 'failed', error: 'not-back' })
    await h.change()
    expect(h.node().requests).toHaveLength(2)
    expect(h.time.pending()).toBe(0)
  })

  test('a board with no git checkout says it cannot send, and sends nothing', async () => {
    const h = harness({ canShip: async () => false })
    await h.change()
    expect(h.updater.view('server-1')).toMatchObject({ state: 'failed', error: 'no-checkout' })
    await h.change()
    expect(await h.updater.ship('server-1')).toMatchObject({ ok: false, error: 'no-checkout' })
    expect(h.node().requests).toEqual([])
    expect(h.archives()).toBe(0)
  })

  test('a board whose commit is not known ships nothing by itself and, asked, says it cannot send', async () => {
    const h = harness({ commit: async () => '' })
    await h.change()
    expect(h.updater.view('server-1')).toBeNull()
    expect((await h.updater.ship('server-1')).error).toBe('no-checkout')
    expect(h.node().requests).toEqual([])
  })

  test('a node on this commit, or offline, gets nothing by itself; offline and asked, it is said', async () => {
    const h = harness()
    h.node().commit = OURS
    await h.change()
    expect(await h.updater.ship('server-1')).toEqual({ ok: true, current: true, commit: OURS })
    h.node().commit = THEIRS
    h.node().state = 'offline'
    await h.change()
    expect(h.node().requests).toEqual([])
    expect(await h.updater.ship('server-1')).toMatchObject({ ok: false, error: 'offline' })
    expect(h.node().requests).toEqual([])
  })

  test('asked while one runs: busy; the node answering current clears the row', async () => {
    const h = harness()
    let release = (): void => {}
    h.node().hold = new Promise<void>(resolve => {
      release = resolve
    })
    const first = h.updater.ship('server-1')
    await h.settle()
    expect(state(h.updater.view('server-1'))).toBe('updating')
    expect(await h.updater.ship('server-1')).toEqual({ ok: false, commit: OURS, error: 'busy' })
    h.node().update = { status: 200, body: { ok: true, current: true, commit: OURS } }
    h.node().hold = null
    release()
    expect(await first).toEqual({ ok: true, current: true, commit: OURS })
    expect(h.updater.view('server-1')).toBeNull()
  })

  test('the archive is made once for two nodes on another commit; a node too old for the route is said', async () => {
    const h = harness({}, ['server-1', 'server-2'])
    const old = h.node('server-2').link as { fetch(p: string, i?: RequestInit): Promise<Response> }
    old.fetch = async () => Response.json({ error: 'not found' }, { status: 404 })
    await h.change('server-1')
    await h.change('server-2')
    expect(h.archives()).toBe(1)
    expect(state(h.updater.view('server-1'))).toBe('restarting')
    expect(h.updater.view('server-2')).toMatchObject({ state: 'failed', error: 'not-built' })
  })

  test('two asks at once, or an ask while it ships by itself: one update, the other told busy', async () => {
    const h = harness()
    const [a, b] = await Promise.all([h.updater.ship('server-1'), h.updater.ship('server-1')])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect([a.error, b.error]).toContain('busy')
    expect(h.node().requests).toEqual(['PUT /api/node/update/blob', 'POST /api/node/update'])
    const g = harness()
    const auto = g.change()
    const asked = await g.updater.ship('server-1')
    await auto
    expect(asked).toMatchObject({ ok: false, error: 'busy' })
    expect(g.node().requests).toEqual(['PUT /api/node/update/blob', 'POST /api/node/update'])
  })

  test('changes that come while it looks are looked at once it is done, not lost', async () => {
    let release = (): void => {}
    const slow = new Promise<void>(resolve => {
      release = resolve
    })
    const h = harness({
      commit: async () => {
        await slow
        return OURS
      },
    })
    h.node().items = [{ key: 's-1', status: 'working' }]
    const first = h.change()
    // the turn ends while the first look still waits for the commit
    h.node().items = [{ key: 's-1', status: 'idle' }]
    await h.change()
    release()
    await first
    await h.settle()
    expect(h.node().requests).toEqual(['PUT /api/node/update/blob', 'POST /api/node/update'])
  })

  test('a start on its way to the node holds it as a turn does', async () => {
    const h = harness()
    h.node().launches = 1
    await h.change()
    expect(h.node().requests).toEqual([])
    h.node().launches = 0
    await h.change()
    expect(h.node().requests).toHaveLength(2)
  })

  test('a revoked device gets nothing, by itself or asked', async () => {
    const h = harness({ revoked: id => id === 'server-1' })
    await h.change()
    expect(await h.updater.ship('server-1')).toEqual({ ok: false, error: 'revoked' })
    expect(h.node().requests).toEqual([])
    expect(h.updater.view('server-1')).toBeNull()
  })

  test('a node that knows no commit of its own is given this one', async () => {
    const h = harness()
    h.node().commit = ''
    await h.change()
    expect(h.node().requests).toHaveLength(2)
  })

  test('an archive larger than a node takes is said, not sent', async () => {
    const h = harness({ archive: async () => new Uint8Array(101 * 1024 * 1024) })
    await h.change()
    expect(h.updater.view('server-1')).toMatchObject({ state: 'failed', error: 'too-big' })
    expect(h.node().requests).toEqual([])
  })

  test('closed: no more looks, no timer left', async () => {
    const h = harness()
    await h.change()
    h.updater.close()
    expect(h.time.pending()).toBe(0)
    h.node().commit = 'c'.repeat(40)
    await h.change()
    expect(h.node().requests).toHaveLength(2)
  })
})
