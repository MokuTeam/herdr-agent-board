// One device's link from the master (services/nodes/link.ts, #499, docs/design/nodes 6.5): the
// link in this process against a real node board (test/support/node-pair.ts) through its proxy,
// or through the fake ssh's local forward; and against a fake clock and a fake node where the
// backoff is counted. The master receives the node's payload and status; silence past the limit
// is offline with the last payload kept; it comes back on one stream; the backoff grows and starts
// over; refusals (a token, a host key, a missing key, a link not built) do not hammer the node.
import { describe, expect, onTestFinished, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { localForward, localPortFor, nodeSshArgs } from '../../src/adapters/node-ssh.ts'
import { createDeviceStore } from '../../src/adapters/node-store.ts'
import { knownHostsFile, readPidRecord } from '../../src/adapters/ssh.ts'
import type { DeviceConfig, LinkConfig, LinkStatus } from '../../src/core/nodes.ts'
import { createLink, type Link, type LinkDeps } from '../../src/services/nodes/link.ts'
import { sshPipeDeps } from '../../src/services/nodes/links.ts'
import { type Clock, realClock } from '../../src/services/tunnel.ts'
import { useFakeSsh } from '../support/fake-ssh-bin.ts'
import { DEAD_MS, nodeBoard, type PairNode } from '../support/node-pair.ts'

const TIMES = { deadMs: DEAD_MS, statusMs: 300, pace: 0.02 }

const device = (id: string, link: LinkConfig): DeviceConfig => ({
  id,
  title: id,
  link,
  maxSessions: null,
  minFreeMemMb: null,
  maxLoad: null,
  tags: [],
  profiles: {},
  paused: false,
  drain: false,
  sinks: {},
  mcp: {},
  accept: [],
})

const direct = (n: PairNode): LinkConfig => ({ kind: 'direct', url: `http://127.0.0.1:${n.proxy.port}` })

/** A link in this process, closed with the test. */
function linkTo(d: DeviceConfig, deps: Partial<LinkDeps> & Pick<LinkDeps, 'token'>, times = TIMES): Link {
  const link = createLink({ device: d, cfg: times, deps: { clock: realClock, log: () => {}, ...deps } })
  onTestFinished(() => link.close())
  return link
}

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = read()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`never came to that: ${JSON.stringify(v)}`)
    await Bun.sleep(10)
  }
}

const keys = (l: Link): string[] => (l.payload()?.items ?? []).map(i => i.key)

describe('a direct link to a node board', () => {
  test("the master receives the node's payload and its status", async () => {
    const node = await nodeBoard('server-1')
    const link = linkTo(device('server-1', direct(node)), { token: () => node.token })
    await until(
      () => keys(link),
      k => k.includes('s-server-1'),
      10_000,
    )
    expect(link.state().state).toBe('online')
    const status = await link.status()
    expect(status?.id).toBe('server-1')
    expect(status?.api).toBe(1)
    // carried as the node said it: a number, or null where it could not be read; never made 0 here
    expect(status?.memAvailableMb === null || typeof status?.memAvailableMb === 'number').toBe(true)
    // asked again by itself while the stream is open
    const asked = (): number => node.proxy.requests.filter(r => r === 'GET /api/node/status').length
    const before = asked()
    await until(asked, n => n >= before + 2, 3000)
    // fetch: the token, X-Board on a write, no Origin
    const res = await link.fetch('/api/board', { headers: { origin: 'http://evil.example' } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { items: { key: string }[] }).items.map(i => i.key)).toContain('s-server-1')
  }, 30_000)

  test('silence past the limit marks it offline and the last payload stays; it comes back on one stream', async () => {
    const node = await nodeBoard('server-1')
    const link = linkTo(device('server-1', direct(node)), { token: () => node.token })
    await until(
      () => keys(link),
      k => k.includes('s-server-1'),
      10_000,
    )
    const seen = link.payload()
    await node.proxy.cut('silent')
    // Half the limit in, a node that only went quiet is still online.
    await Bun.sleep(DEAD_MS / 2)
    expect(link.state().state).toBe('online')
    await until(
      () => link.state().state,
      s => s === 'offline',
      DEAD_MS * 4,
    )
    expect(link.payload()).toBe(seen)
    expect(keys(link)).toContain('s-server-1')
    node.proxy.restore()
    await until(
      () => link.state().state,
      s => s === 'online',
      10_000,
    )
    await Bun.sleep(500)
    expect(node.proxy.streams()).toBe(1)
    expect(node.proxy.peak()).toBe(1)
  }, 30_000)

  test('a node gone and back: offline, then online again on one stream', async () => {
    const node = await nodeBoard('server-1')
    const link = linkTo(device('server-1', direct(node)), { token: () => node.token })
    await until(
      () => link.state().state,
      s => s === 'online',
      10_000,
    )
    await node.proxy.cut('drop')
    const tries = await until(
      () => link.state(),
      s => (s.attempt ?? 0) >= 3,
      5000,
    )
    expect(tries.state).toBe('online')
    await until(
      () => link.state().state,
      s => s === 'offline',
      DEAD_MS * 4,
    )
    node.proxy.restore()
    await until(
      () => link.state().state,
      s => s === 'online',
      10_000,
    )
    await Bun.sleep(300)
    expect(node.proxy.streams()).toBe(1)
    expect(node.proxy.peak()).toBe(1)
  }, 30_000)

  test('a token the node does not take: refused, and tried once a minute, never faster', async () => {
    const node = await nodeBoard('server-1')
    const link = linkTo(device('server-1', direct(node)), { token: () => 'W'.repeat(43) }, { ...TIMES, pace: 1 })
    const s = await until(
      () => link.state(),
      x => x.state === 'refused',
      10_000,
    )
    expect(s.reason).toBe('token')
    expect((s.nextAt ?? 0) - s.since).toBeGreaterThanOrEqual(60_000)
    await Bun.sleep(1000)
    expect(node.proxy.requests.filter(r => r === 'GET /api/events')).toHaveLength(1)
  }, 30_000)

  test('no token stored: refused, and nothing is asked of the node', async () => {
    const node = await nodeBoard('server-1')
    const link = linkTo(device('server-1', direct(node)), { token: () => null })
    const s = await until(
      () => link.state(),
      x => x.state === 'refused',
      2000,
    )
    expect(s.reason).toBe('token')
    await Bun.sleep(200)
    expect(node.proxy.requests).toEqual([])
  }, 30_000)

  test("a door that is another device's: refused", async () => {
    const node = await nodeBoard('server-1')
    const link = linkTo(device('server-2', direct(node)), { token: () => node.token })
    const s = await until(
      () => link.state(),
      x => x.state === 'refused',
      10_000,
    )
    expect([s.reason, s.detail]).toEqual(['device', "the door is server-1's"])
    expect(node.proxy.requests).toEqual(['GET /api/hello'])
  }, 30_000)
})

test('relay and tailnet are not built yet: refused, with no request and no timer to try again', async () => {
  let asked = 0
  for (const link of [
    { kind: 'relay', socket: 'server-1' },
    { kind: 'tailnet', address: '100.64.0.9', port: 12430 },
  ] as LinkConfig[]) {
    const l = linkTo(device('server-1', link), {
      token: () => 'T'.repeat(43),
      fetch: async () => {
        asked++
        return new Response('')
      },
    })
    const s = await until(
      () => l.state(),
      x => x.state === 'refused',
      2000,
    )
    expect([s.reason, s.detail, s.nextAt]).toEqual(['not-built', `a ${link.kind} link is not built yet`, undefined])
  }
  expect(asked).toBe(0)
})

describe('an ssh link, against the fake ssh', () => {
  async function sshSetup(node: PairNode) {
    // biome-ignore lint/correctness/useHookAtTopLevel: a test fixture, not a React hook
    const ssh = await useFakeSsh()
    const store = createDeviceStore({ dir: join(ssh.dir, 'nodes') })
    const link = {
      kind: 'ssh',
      host: 'ssh.example.com',
      sshPort: 2222,
      user: 'agent-board-link',
      port: node.doorPort,
    } as const
    return { ssh, store, link, deps: sshPipeDeps('server-1', link, store) }
  }
  const withKey = (store: ReturnType<typeof createDeviceStore>): void => {
    mkdirSync(store.dir('server-1'), { recursive: true })
    writeFileSync(store.keyPath('server-1'), 'fake key\n')
  }

  test('the ssh line, its pid record, the payload through the forward, and a stray from a board before ended first', async () => {
    const node = await nodeBoard('server-1')
    const { ssh, store, link, deps } = await sshSetup(node)
    withKey(store)
    const a = linkTo(device('server-1', link), { token: () => node.token, ssh: deps })
    await until(
      () => keys(a),
      k => k.includes('s-server-1'),
      10_000,
    )
    const port = await localPortFor('server-1')
    const line = ssh.calls().filter(c => c.includes('-L'))
    expect(line).toEqual([
      nodeSshArgs({ link, key: store.keyPath('server-1'), knownHosts: knownHostsFile(), localPort: port }),
    ])
    expect(line[0]?.slice(0, 7)).toEqual([
      '-F',
      'none',
      '-N',
      '-T',
      '-v',
      '-i',
      store.keyPath('server-1').replaceAll('\\', '/').replaceAll('%', '%%'),
    ])
    expect(line[0]?.slice(-3)).toEqual([
      '-L',
      `127.0.0.1:${port}:127.0.0.1:${node.doorPort}`,
      'agent-board-link@ssh.example.com',
    ])
    const record = readPidRecord(store.pidFile('server-1'))
    expect(record?.forward).toBe(localForward(port, node.doorPort))
    const first = record?.pid ?? 0
    expect(first).toBeGreaterThan(0)
    // The host key pinned on first use, in the board's own known_hosts.
    expect(existsSync(knownHostsFile())).toBe(true)
    // A board that died without ending its ssh: the next one ends that ssh before its own.
    const b = linkTo(device('server-1', link), { token: () => node.token, ssh: deps })
    await until(
      () => b.state().state,
      s => s === 'online',
      10_000,
    )
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive(first)).toBe(false)
    const second = readPidRecord(store.pidFile('server-1'))?.pid ?? 0
    expect(second).not.toBe(first)
    await b.close()
    expect(readPidRecord(store.pidFile('server-1'))).toBeNull()
    expect(alive(second)).toBe(false)
  }, 30_000)

  test('a wrong host key refuses: no stream, tried again only after a minute', async () => {
    const node = await nodeBoard('server-1')
    const { ssh, store, link, deps } = await sshSetup(node)
    withKey(store)
    mkdirSync(join(knownHostsFile(), '..'), { recursive: true })
    writeFileSync(knownHostsFile(), 'ssh.example.com ssh-ed25519 AAAAANOTHERKEY\n')
    const l = linkTo(device('server-1', link), { token: () => node.token, ssh: deps }, { ...TIMES, pace: 1 })
    const s: LinkStatus = await until(
      () => l.state(),
      x => x.state === 'refused',
      10_000,
    )
    expect(s.reason).toBe('host-key')
    expect(s.detail).toContain('Host key verification failed')
    expect((s.nextAt ?? 0) - s.since).toBeGreaterThanOrEqual(60_000)
    await Bun.sleep(500)
    expect(ssh.calls().filter(c => c.includes('-L'))).toHaveLength(1)
    expect(node.proxy.requests).toEqual([])
  }, 30_000)

  test('no link key yet: refused with reason key, and no ssh starts', async () => {
    const node = await nodeBoard('server-1')
    const { ssh, link, deps } = await sshSetup(node)
    const l = linkTo(device('server-1', link), { token: () => node.token, ssh: deps })
    const s = await until(
      () => l.state(),
      x => x.state === 'refused',
      5000,
    )
    expect(s.reason).toBe('key')
    expect(ssh.calls()).toEqual([])
  }, 30_000)
})

/** A clock the test moves; its timers run in order as it does. */
function fakeClock(start = 1_000_000) {
  let now = start
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void; every: number }>()
  const add = (fn: () => void, ms: number, every: number): number => {
    timers.set(++seq, { at: now + ms, fn, every })
    return seq
  }
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    clearTimeout: h => void timers.delete(h as number),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: h => void timers.delete(h as number),
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Bun.sleep(1)
  }
  return {
    clock,
    live: () => timers.size,
    async advance(ms: number): Promise<void> {
      const end = now + ms
      for (;;) {
        let next: [number, { at: number; fn: () => void; every: number }] | undefined
        for (const t of timers) if (t[1].at <= end && (!next || t[1].at < next[1].at)) next = t
        if (!next) break
        const [id, t] = next
        now = t.at
        if (t.every) t.at += t.every
        else timers.delete(id)
        t.fn()
        await settle()
      }
      now = end
      await settle()
    },
  }
}

const PAYLOAD = {
  items: [],
  launches: [],
  categories: [],
  swatches: [],
  columns: [],
  schedules: [],
  scheduleLog: [],
  version: '1',
  stale: false,
}

test('the backoff grows while the node cannot be reached, and starts over once a stream lasted a minute', async () => {
  const t = fakeClock()
  let up = false
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null
  const enc = new TextEncoder()
  const fetch = async (url: string): Promise<Response> => {
    if (!up) throw new Error('connection refused')
    if (url.endsWith('/api/hello')) return Response.json({ node: { api: 1, id: 'server-1' } })
    if (url.endsWith('/api/events'))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            stream = c
            c.enqueue(enc.encode(`retry: 2000\ndata: ${JSON.stringify(PAYLOAD)}\n\n`))
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    return new Response('', { status: 404 })
  }
  const l = linkTo(
    device('server-1', { kind: 'direct', url: 'http://127.0.0.1:9' }),
    { token: () => 'T'.repeat(43), clock: t.clock, fetch, random: () => 0.5 },
    { deadMs: 90_000, statusMs: 30_000, pace: 1 },
  )
  await t.advance(0)
  const waits: number[] = []
  for (let i = 0; i < 4; i++) {
    const s = l.state()
    waits.push((s.nextAt ?? 0) - t.clock.now())
    await t.advance((s.nextAt ?? 0) - t.clock.now())
  }
  expect(waits).toEqual([1000, 2000, 4000, 8000])
  // Up: online on the first payload. A stream that ends within the minute does not start the backoff over.
  up = true
  await t.advance((l.state().nextAt ?? 0) - t.clock.now())
  expect(l.state().state).toBe('online')
  await t.advance(5000)
  ;(stream as ReadableStreamDefaultController<Uint8Array> | null)?.close()
  await t.advance(0)
  expect([l.state().attempt, (l.state().nextAt ?? 0) - t.clock.now()]).toEqual([6, 32_000])
  // One that lasted a minute (pings in it, so the node never went silent) does.
  await t.advance(32_000)
  expect(l.state().state).toBe('online')
  for (let i = 0; i < 4; i++) {
    ;(stream as ReadableStreamDefaultController<Uint8Array> | null)?.enqueue(enc.encode(': ping\n\n'))
    await t.advance(20_000)
  }
  ;(stream as ReadableStreamDefaultController<Uint8Array> | null)?.close()
  await t.advance(0)
  expect([l.state().state, l.state().attempt, (l.state().nextAt ?? 0) - t.clock.now()]).toEqual(['online', 1, 1000])
  await l.close()
  expect(t.live()).toBe(0)
})

test('the node forgetting this master ends the stream as refused (token)', async () => {
  const t = fakeClock()
  const enc = new TextEncoder()
  const fetch = async (url: string): Promise<Response> => {
    if (url.endsWith('/api/hello')) return Response.json({ node: { api: 1, id: 'server-1' } })
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(PAYLOAD)}\n\nevent: unpaired\ndata: {}\n\n`))
        },
      }),
    )
  }
  const l = linkTo(device('server-1', { kind: 'direct', url: 'http://127.0.0.1:9' }), {
    token: () => 'T'.repeat(43),
    clock: t.clock,
    fetch,
  })
  await t.advance(0)
  expect([l.state().state, l.state().reason, l.state().detail]).toEqual([
    'refused',
    'token',
    'the node forgot this master',
  ])
  expect(l.payload()).toEqual(PAYLOAD as never)
})

test("a door whose node.api is not this board's: refused (api)", async () => {
  const t = fakeClock()
  const l = linkTo(device('server-1', { kind: 'direct', url: 'http://127.0.0.1:9' }), {
    token: () => 'T'.repeat(43),
    clock: t.clock,
    fetch: async () => Response.json({ node: { api: 2, id: 'server-1' } }),
  })
  await t.advance(0)
  expect([l.state().state, l.state().reason, l.state().detail]).toEqual([
    'refused',
    'api',
    "the door's node.api is 2, this board's 1",
  ])
})

test('a status tells the listeners only when its shown figures moved, not on every poll (#500)', async () => {
  const t = fakeClock()
  const enc = new TextEncoder()
  const s = (more: Record<string, unknown>) => ({
    ...{
      api: 1,
      id: 'server-1',
      version: '0.1.0',
      commit: 'abc',
      platform: 'linux',
      arch: 'x64',
      cpus: 8,
      memTotalMb: 32013,
      memAvailableMb: 21480,
      load: [0.42, 0.61, 0.58],
      sessions: { awake: 2, working: 1, asleep: 5 },
      launches: 0,
      workRootFreeMb: 148000,
      profiles: [{ id: 'default', loggedIn: true, bundle: null }],
      agents: ['claude'],
      at: 1,
    },
    ...more,
  })
  // What the node says at each poll: the first, the same rounded twice, memory past its rounding,
  // memory gone, the same again, a session that woke.
  const said = [
    s({ at: 1 }),
    s({ at: 2, memAvailableMb: 21_470, load: [1, 0.64, 1] }),
    s({ at: 3, memAvailableMb: 21_520 }),
    s({ at: 4, memAvailableMb: 21_300 }),
    s({ at: 5, memAvailableMb: null }),
    s({ at: 6, memAvailableMb: null }),
    s({ at: 7, memAvailableMb: null, sessions: { awake: 3, working: 1, asleep: 4 } }),
  ]
  let polls = 0
  const fetch = async (url: string): Promise<Response> => {
    if (url.endsWith('/api/hello')) return Response.json({ node: { api: 1, id: 'server-1' } })
    if (url.endsWith('/api/node/status')) return Response.json(said[Math.min(polls++, said.length - 1)])
    if (url.endsWith('/api/events'))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify(PAYLOAD)}\n\n`))
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    return new Response('', { status: 404 })
  }
  const l = linkTo(
    device('server-1', { kind: 'direct', url: 'http://127.0.0.1:9' }),
    { token: () => 'T'.repeat(43), clock: t.clock, fetch },
    { deadMs: 900_000, statusMs: 30_000, pace: 1 },
  )
  const told: unknown[] = []
  l.onStatus(st => told.push(st.at))
  await t.advance(0)
  for (let i = 1; i < said.length; i++) await t.advance(30_000)
  expect(polls).toBe(said.length)
  expect(told).toEqual([1, 4, 5, 7])
  // The link itself keeps the latest, told or not: GET /api/nodes and the placer read it.
  expect(l.view().status?.at).toBe(7)
})

describe('the link on a node board, more', () => {
  test('refused: fetch answers node-offline and asks nothing; status is null; a path must start at the root', async () => {
    const node = await nodeBoard('server-1')
    const link = linkTo(device('server-2', direct(node)), { token: () => node.token })
    await until(
      () => link.state().state,
      s => s === 'refused',
      10_000,
    )
    const res = await link.fetch('/api/board')
    expect([res.status, await res.json()]).toEqual([503, { error: 'node-offline' }])
    expect(await link.status()).toBeNull()
    expect(node.proxy.requests).toEqual(['GET /api/hello'])
    await expect(link.fetch('@evil.example/api/board')).rejects.toThrow("a path from the door's root")
  }, 30_000)

  test('reconnect: a new stream after the old one ended, never two; the token in no log line or detail', async () => {
    const node = await nodeBoard('server-1')
    const logs: string[] = []
    const link = linkTo(device('server-1', direct(node)), { token: () => node.token, log: t => void logs.push(t) })
    await until(
      () => keys(link),
      k => k.includes('s-server-1'),
      10_000,
    )
    link.reconnect('the computer slept')
    const streams = (): number => node.proxy.requests.filter(r => r === 'GET /api/events').length
    await until(streams, n => n === 2, 5000)
    await until(
      () => link.state(),
      s => s.state === 'online' && s.detail === undefined,
      5000,
    )
    await Bun.sleep(300)
    expect([node.proxy.streams(), node.proxy.peak()]).toEqual([1, 1])
    expect(logs.some(l => l.includes('the computer slept: trying again now'))).toBe(true)
    expect(logs.filter(l => l.includes(node.token))).toEqual([])
    expect(JSON.stringify(link.view())).not.toContain(node.token)
  }, 30_000)

  test('a token refused: a wake does not try it again before its minute; a stored token does', async () => {
    const node = await nodeBoard('server-1')
    let token = 'W'.repeat(43)
    const link = linkTo(device('server-1', direct(node)), { token: () => token }, { ...TIMES, pace: 1 })
    await until(
      () => link.state().state,
      s => s === 'refused',
      10_000,
    )
    const events = (): number => node.proxy.requests.filter(r => r === 'GET /api/events').length
    for (let i = 0; i < 6; i++) link.reconnect('the computer slept')
    await Bun.sleep(500)
    expect(events()).toBe(1)
    token = node.token
    link.reconnect('a token stored', true)
    await until(
      () => link.state().state,
      s => s === 'online',
      5000,
    )
    expect(events()).toBe(2)
  }, 30_000)

  test('ssh that drops after it was up: a new ssh, and the node online again through it', async () => {
    const node = await nodeBoard('server-1')
    const ssh = await useFakeSsh()
    ssh.state({ ssh: { exitAfterMs: 1500 } })
    const store = createDeviceStore({ dir: join(ssh.dir, 'nodes') })
    mkdirSync(store.dir('server-1'), { recursive: true })
    writeFileSync(store.keyPath('server-1'), 'fake key\n')
    const link = {
      kind: 'ssh',
      host: 'ssh.example.com',
      sshPort: 22,
      user: 'agent-board-link',
      port: node.doorPort,
    } as const
    const l = linkTo(device('server-1', link), { token: () => node.token, ssh: sshPipeDeps('server-1', link, store) })
    await until(
      () => keys(l),
      k => k.includes('s-server-1'),
      10_000,
    )
    const first = l.view().payloadAt ?? 0
    await until(
      () => ssh.calls().filter(c => c.includes('-L')).length,
      n => n >= 2,
      10_000,
    )
    await until(
      () => l.view(),
      v => v.link?.state === 'online' && (v.payloadAt ?? 0) > first,
      10_000,
    )
    await l.close()
    expect(readPidRecord(store.pidFile('server-1'))).toBeNull()
  }, 30_000)
})

test('writes carry X-Board, every request the bearer and the Host of the door over ssh, never an Origin', async () => {
  const t = fakeClock()
  const seen: { url: string; headers: Headers }[] = []
  const enc = new TextEncoder()
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    seen.push({ url, headers: new Headers(init.headers) })
    if (url.endsWith('/api/hello')) return Response.json({ node: { api: 1, id: 'server-1' } })
    if (url.endsWith('/api/events'))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify(PAYLOAD)}\n\n`))
          },
        }),
      )
    return Response.json({ ok: true })
  }
  const l = linkTo(device('server-1', { kind: 'direct', url: 'http://127.0.0.1:9/' }), {
    token: () => 'T'.repeat(43),
    clock: t.clock,
    fetch,
  })
  await t.advance(0)
  expect(l.state().state).toBe('online')
  await l.fetch('/api/session/s1/stop', {
    method: 'POST',
    headers: { origin: 'http://evil.example', authorization: 'Bearer other', 'content-type': 'application/json' },
    body: '{}',
  })
  const write = seen.at(-1)
  expect(write?.url).toBe('http://127.0.0.1:9/api/session/s1/stop')
  expect([write?.headers.get('x-board'), write?.headers.get('origin'), write?.headers.get('authorization')]).toEqual([
    '1',
    null,
    `Bearer ${'T'.repeat(43)}`,
  ])
  // hello goes before the token, without it
  expect(seen[0]?.headers.get('authorization')).toBeNull()
  expect(seen[1]?.headers.get('x-board')).toBeNull()
})

test('close while the ssh pipe waits for its port: no ssh starts after it', async () => {
  let release: (port: number) => void = () => {}
  let spawned = 0
  const ssh = {
    bin: () => 'ssh',
    args: () => [],
    forward: (p: number) => `127.0.0.1:${p}:127.0.0.1:12430`,
    localPort: () =>
      new Promise<number>(resolve => {
        release = resolve
      }),
    keyExists: () => true,
    spawn: () => {
      spawned++
      throw new Error('no ssh may start')
    },
    stray: { read: () => null, write: () => {}, end: async () => true },
    up: () => false,
    portTaken: () => false,
  }
  const l = createLink({
    device: device('server-1', { kind: 'ssh', host: 'h', sshPort: 22, user: 'u', port: 12430 }),
    cfg: TIMES,
    deps: { token: () => 'T'.repeat(43), clock: realClock, log: () => {}, ssh },
  })
  await Bun.sleep(20)
  await l.close()
  release(50123)
  await Bun.sleep(50)
  expect(spawned).toBe(0)
})
