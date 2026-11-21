// Boards linked as master and nodes (#499, docs/design/nodes 14, T3), for the tests of the node
// link and of what later tasks build on it. Each board is a sandbox (sandbox.ts) with a fake herdr
// of its own, run as the web board (board-server.ts):
// - a node: config.json's `node` with a door on a free port, one session (`s-<id>`) in its fake
//   herdr, and a master's token made by its own store (adapters/node-store.ts add, as
//   `board node token` makes it);
// - the master: config.json's `nodes` with a `direct` link to each node, the token stored where
//   `board nodes token` stores it (createDeviceStore setToken).
// Between the master and each node's door sits a proxy in this test process, the network: it
// counts the event streams open through it, and cut() takes the node away, `silent` (connections
// stay, nothing more comes through, new requests hang: a laptop's lid, a dead route) or `drop`
// (every connection closed, nothing listens: the node's machine gone); restore() brings it back.
// The boards run paced (BOARD_TEST_PACE), with the node offline after DEAD_MS of silence, its
// status asked every STATUS_MS and its pings every PING_MS. Everything goes with the test.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createDeviceStore, createNodeStore } from '../../src/adapters/node-store.ts'
import type { DeviceView } from '../../src/core/nodes.ts'
import { type BoardMessage, logged, serveBoard, unusedPort } from './board-server.ts'
import { type Child, type Sandbox, sandbox, until } from './sandbox.ts'
import { stateFolder } from './tunnel-board.ts'

export const DEAD_MS = 1500
export const STATUS_MS = 300
export const PING_MS = 250
export const PAIR_ENV = {
  BOARD_TEST_PACE: '0.02',
  BOARD_NODE_DEAD_MS: String(DEAD_MS),
  BOARD_NODE_STATUS_MS: String(STATUS_MS),
  BOARD_EVENTS_PING_MS: String(PING_MS),
}

export interface DoorProxy {
  port: number
  /** Payload streams (`GET /api/events`) open through it now: a terminal's and the uplink's (#508) are others. */
  streams(): number
  /** The most payload streams that were open through it at once. */
  peak(): number
  /** Every request it took, `<method> <path>`, in order. */
  requests: string[]
  /** The same requests with the headers and the body (as text) the door was sent. */
  received: { request: string; headers: Record<string, string>; body: string }[]
  cut(how: 'silent' | 'drop'): Promise<void>
  restore(): void
  close(): Promise<void>
  /**
   * A request answered here instead of by the door, for a test of what the master does with an
   * answer (#504): given the method, the path and `forward` (the door's own answer), it returns the
   * answer to give, or null to pass the request on as usual.
   */
  intercept: ((method: string, path: string, forward: () => Promise<Response>) => Promise<Response | null>) | null
}

/**
 * A proxy on a free port to a door on 127.0.0.1:`doorPort`, with the Host the door takes. An event
 * stream is passed on chunk by chunk and counted while it is open.
 */
export async function doorProxy(doorPort: number): Promise<DoorProxy> {
  const port = await unusedPort()
  let mode: 'open' | 'silent' | 'drop' = 'open'
  const open = new Set<{ end(): void }>()
  const streaming = new Set<{ end(): void }>()
  const hung: (() => void)[] = []
  const requests: string[] = []
  const received: DoorProxy['received'] = []
  let peak = 0
  const proxy = { intercept: null as DoorProxy['intercept'] }

  async function pass(req: Request): Promise<Response> {
    const url = new URL(req.url)
    requests.push(`${req.method} ${url.pathname}`)
    if (mode !== 'open') {
      await new Promise<void>(resolve => hung.push(resolve))
      return new Response('', { status: 502 })
    }
    const headers = new Headers(req.headers)
    headers.set('host', `127.0.0.1:${doorPort}`)
    const sent = req.body ? await req.arrayBuffer() : null
    received.push({
      request: `${req.method} ${url.pathname}`,
      headers: Object.fromEntries(req.headers),
      body: sent ? new TextDecoder().decode(sent) : '',
    })
    const forward = (): Promise<Response> =>
      fetch(`http://127.0.0.1:${doorPort}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        ...(sent && { body: sent }),
        signal: req.signal,
      })
    const instead = proxy.intercept ? await proxy.intercept(req.method, url.pathname, forward) : null
    if (instead) return instead
    let res: Response
    try {
      res = await forward()
    } catch {
      return new Response('', { status: 502 })
    }
    if (!res.body || !(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) return res
    const reader = res.body.getReader()
    let ended = false
    const payload = url.pathname === '/api/events'
    const entry = {
      end() {
        if (ended) return
        ended = true
        open.delete(entry)
        streaming.delete(entry)
        void reader.cancel().catch(() => {})
      },
    }
    // Every stream is ended by cut('drop'); only the payload's are counted.
    streaming.add(entry)
    if (payload) open.add(entry)
    peak = Math.max(peak, open.size)
    req.signal.addEventListener('abort', () => entry.end(), { once: true })
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          const next = await reader.read().catch(() => ({ done: true, value: undefined }))
          if (next.done || ended) {
            entry.end()
            controller.close()
            return
          }
          // Silent: what the node says goes nowhere.
          if (mode === 'open' && next.value) {
            controller.enqueue(next.value)
            return
          }
        }
      },
      cancel: () => entry.end(),
    })
    return new Response(body, { status: res.status, headers: res.headers })
  }

  const serve = () => Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 0, reusePort: false, fetch: pass })
  let server: ReturnType<typeof Bun.serve> | null = serve()

  const rest: Omit<DoorProxy, 'intercept'> = {
    port,
    streams: () => open.size,
    peak: () => peak,
    requests,
    received,
    async cut(how) {
      mode = how
      if (how === 'drop') {
        for (const entry of [...streaming]) entry.end()
        await server?.stop(true)
        server = null
      }
    },
    restore() {
      mode = 'open'
      for (const resolve of hung.splice(0)) resolve()
      server ??= serve()
    },
    async close() {
      for (const entry of [...streaming]) entry.end()
      for (const resolve of hung.splice(0)) resolve()
      await server?.stop(true)
      server = null
    },
  }
  return Object.assign(proxy, rest)
}

export interface PairNode {
  id: string
  box: Sandbox
  url: string
  proc: Child
  doorPort: number
  /** The master's token on this node. */
  token: string
  proxy: DoorProxy
}

export interface Pair {
  master: { box: Sandbox; url: string; proc: Child }
  /** The master's config and env as it was started with: a test that restarts it starts it so again. */
  masterConfig: Record<string, unknown>
  env: Record<string, string>
  nodes: PairNode[]
  /** The master's GET /api/nodes devices. */
  devices(): Promise<DeviceView[]>
  /** One device of them, waited for until `ok` says yes (5 s unless given). */
  waitDevice(id: string, ok: (d: DeviceView) => boolean, ms?: number): Promise<DeviceView>
}

/** A herdr pane as `api snapshot` lists it. */
export type FakePane = Record<string, unknown>

/** These panes in a board's fake herdr. */
export function showPanes(box: Sandbox, panes: FakePane[]): void {
  box.state({ 'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } } })
}

/** The pane `s-<id>`: what a node's fake herdr has unless the test says. */
const oneSession = (box: Sandbox, id: string): FakePane[] => [
  { pane_id: 'p1', agent: 'claude', agent_session: { value: `s-${id}` }, agent_status: 'idle', cwd: box.dir },
]

/**
 * A node board with its door up, a master's token made there, and its proxy; `panes`: its fake
 * herdr's, else `s-<id>`; `cfg`: more of its config; `setup`: done to its sandbox before it starts.
 */
export async function nodeBoard(
  id: string,
  env: Record<string, string> = PAIR_ENV,
  panes?: (box: Sandbox) => FakePane[],
  cfg?: (box: Sandbox) => Record<string, unknown>,
  setup?: (box: Sandbox) => void | Promise<void>,
): Promise<PairNode> {
  const box = await sandbox()
  await setup?.(box)
  showPanes(box, panes?.(box) ?? oneSession(box, id))
  const dir = join(stateFolder(box), 'node')
  mkdirSync(dir, { recursive: true })
  const { token } = createNodeStore({ dir }).add('master', 'hand')
  const doorPort = await unusedPort()
  const { url, proc } = await serveBoard(
    box,
    { language: 'en', node: { id, port: doorPort, workRoot: box.dir }, ...cfg?.(box) },
    env,
  )
  await until(() => logged(proc, `node door: listening on 127.0.0.1:${doorPort} as ${id}`), 10_000)
  return { id, box, url, proc, doorPort, token, proxy: await doorProxy(doorPort) }
}

/**
 * A master and `count` nodes (`server-1`, `server-2`), linked by `direct` through each node's
 * proxy. `masterCfg`: more of the master's config; `tokens: false` stores none on the master;
 * `panes`: a node's fake herdr's panes by its id, `masterPanes` the master's (none unless given);
 * `nodeCfg`: more of a node's config by its id; `masterSetup`: done to the master's sandbox before
 * its board starts (a login written to its state folder, say), `nodeSetup` to a node's; `deviceCfg`: more of a device's entry in
 * the master's `nodes.devices` by its id.
 */
export async function nodePair(
  o: {
    count?: number
    masterCfg?: Record<string, unknown>
    env?: Record<string, string>
    tokens?: boolean
    panes?: (id: string, box: Sandbox) => FakePane[]
    masterPanes?: (box: Sandbox) => FakePane[]
    nodeCfg?: (id: string, box: Sandbox) => Record<string, unknown>
    masterSetup?: (box: Sandbox) => void | Promise<void>
    deviceCfg?: (id: string) => Record<string, unknown>
    /** More of the master's `nodes` section (order, lanes, whenFull, devices beside the nodes' own). */
    nodesCfg?: Record<string, unknown>
    /** More of the master's env than the nodes'. */
    masterEnv?: Record<string, string>
    nodeSetup?: (id: string, box: Sandbox) => void | Promise<void>
  } = {},
): Promise<Pair> {
  const env = { ...PAIR_ENV, ...o.env }
  const ids = Array.from({ length: o.count ?? 1 }, (_, i) => `server-${i + 1}`)
  const panes = o.panes
  const nodeCfg = o.nodeCfg
  const nodeSetup = o.nodeSetup
  const nodes = await Promise.all(
    ids.map(id =>
      nodeBoard(
        id,
        env,
        panes && (box => panes(id, box)),
        nodeCfg && (box => nodeCfg(id, box)),
        nodeSetup && (box => nodeSetup(id, box)),
      ),
    ),
  )
  const box = await sandbox()
  if (o.masterPanes) showPanes(box, o.masterPanes(box))
  await o.masterSetup?.(box)
  const store = createDeviceStore({ dir: join(stateFolder(box), 'nodes') })
  if (o.tokens !== false) for (const n of nodes) store.setToken(n.id, n.token)
  const devices = Object.fromEntries(
    nodes.map(n => [
      n.id,
      { link: { kind: 'direct', url: `http://127.0.0.1:${n.proxy.port}` }, ...o.deviceCfg?.(n.id) },
    ]),
  )
  const { devices: moreDevices, ...moreNodes } = o.nodesCfg ?? {}
  const masterConfig = {
    language: 'en',
    nodes: { id: 'laptop', ...moreNodes, devices: { ...devices, ...(moreDevices as Record<string, unknown>) } },
    ...o.masterCfg,
  }
  const masterEnv = { ...env, ...o.masterEnv }
  const { url, proc } = await serveBoard(box, masterConfig, masterEnv)
  const { onTestFinished } = await import('bun:test')
  onTestFinished(async () => {
    for (const n of nodes) await n.proxy.close()
  })
  const read = async (): Promise<DeviceView[]> => {
    const res = await fetch(`${url}/api/nodes`)
    if (!res.ok) throw new Error(`GET /api/nodes: ${res.status}`)
    return ((await res.json()) as { devices: DeviceView[] }).devices
  }
  return {
    master: { box, url, proc },
    masterConfig,
    env: masterEnv,
    nodes,
    devices: read,
    async waitDevice(id, ok, ms = 5000) {
      const deadline = Date.now() + ms
      let last: DeviceView | undefined
      for (;;) {
        last = (await read()).find(d => d.id === id)
        if (last && ok(last)) return last
        if (Date.now() > deadline) throw new Error(`device ${id} never came to that: ${JSON.stringify(last)}`)
        await Bun.sleep(25)
      }
    },
  }
}

export type { BoardMessage }
