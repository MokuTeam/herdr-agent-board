// The master door (#498, docs/design/nodes 6.1): while config.json's `node` checks out
// (core/nodes.ts nodeConfig), a server on 127.0.0.1:<node.port> for this node's masters. A master
// reaches it through an ssh forward it dials itself; nothing else is meant to. Without `node`
// nothing listens, no timer runs and no file is read.
//
// A request gets to a board route only when:
// - its Host names this computer's loopback (127.0.0.1, localhost, [::1]) with any port, since a
//   forward lands on whatever local port is free; any other name is 403 host;
// - it carries no Origin: a page in a browser always sends one, and this door is for a program
//   (403 origin, as wake's API refuses a page);
// - anything but GET carries X-Board: 1 (403 header), as everywhere;
// - it carries `Authorization: Bearer <token>` of a master in masters.json (adapters/node-store.ts),
//   else 401 token; wrong or missing tokens past 5 a minute are 429;
// - it is on the door's allowlist (core/node-door.ts) in both spellings of its path, else 404.
// `GET /api/hello` answers before the token: the board's own hello and `node`. `/api/node/...`
// (server/routes/node.ts) are this door's own; everything else goes to the board's route table
// with the web board's guards. A master's open event streams end, with the event a phone's do, the moment
// it is forgotten.

import { type DoorCert, ensureDoorCert } from '../adapters/door-cert.ts'
import { isRecord } from '../adapters/json-store.ts'
import type { NodeJoinStore } from '../adapters/node-join-store.ts'
import { type MasterRecord, masterName, type NodeStore } from '../adapters/node-store.ts'
import { RateLimiter } from '../core/access.ts'
import { doorRoute, loopbackHost, NODE_API } from '../core/node-door.ts'
import { type NodeConfig, nodeConfig } from '../core/nodes.ts'
import { bearerOf } from '../core/remote.ts'
import type { Config } from '../core/types.ts'
import { dispatch, type GuardState, json, peerOf, type Route } from './http.ts'
import type { Hello } from './remote.ts'
import { decoded, endsWhenGone } from './streams.ts'

export interface NodeListenerOptions {
  /** The live config: `node` is read at each sync. */
  cfg: Config
  /** The board's route table, the very one the web board serves. */
  routes: Route[]
  guards: GuardState
  /** The board's own hello (server/remote.ts), which the door's adds `node` to. */
  hello: () => Hello
  store: NodeStore
  /** One-time join code store for claiming a computer behind NAT (#513); optional. */
  join?: NodeJoinStore
  /** The door's own routes (server/routes/node.ts): its status and a start from the master. */
  doorRoutes: Route[]
  log: (text: string) => void
  /** Provides/persists the door's TLS cert and key when `node.tls` is true (default: ensureDoorCert). */
  doorCert?: (nodeId: string) => DoorCert
  /** Called whenever the door starts listening, moves, or closes. */
  onChange?: () => void
}

export interface NodeListener {
  /** Listens on 127.0.0.1:<node.port> while `node` checks out; else nothing listens. */
  sync(): Promise<void>
  /** The config changed: sync when `node` did. */
  configChanged(): void
  /** The port it listens on, or null. */
  listening(): number | null
  close(): Promise<void>
}

type Server = ReturnType<typeof Bun.serve>

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
/** A door that could not start is tried again this often while `node` asks for it. */
const RETRY_MS = 30_000
/** Wrong or missing tokens: 5 a minute (6.1), then 429. */
const WRONG_TOKENS = { perAddress: 5, overall: 5, windowMs: 60_000 }

/**
 * The master a request to one of the door's own routes came with, as the door verified its token
 * (#510): `POST /api/node/leave` forgets that one and no other.
 */
const callers = new WeakMap<Request, MasterRecord>()
export const doorMaster = (req: Request): MasterRecord | null => callers.get(req) ?? null

export function createNodeListener(o: NodeListenerOptions): NodeListener {
  let server: Server | null = null
  let bound: number | null = null
  let boundTls: boolean | null = null
  let boundCertFp: string | null = null
  let node: NodeConfig | null = null
  let error: string | null = null
  let closed = false
  let syncing: Promise<void> | null = null
  let retry: ReturnType<typeof setTimeout> | undefined
  const configKey = (): string => JSON.stringify(o.cfg.node ?? null)
  let lastConfig = configKey()
  const wrong = new RateLimiter(WRONG_TOKENS)
  let claiming = false

  async function handleClaim(req: Request, here: NodeConfig): Promise<Response> {
    if (req.headers.get('x-board') !== '1') return json(403, { error: 'header' })
    if (o.store.list().length > 0) {
      o.join?.clear()
      return json(409, { error: 'claimed' })
    }
    if (!o.join) return json(410, { error: 'expired' })
    let rawText = ''
    try {
      rawText = await req.text()
    } catch {
      return json(400, { error: 'claim' })
    }
    if (rawText.length > 4096) return json(400, { error: 'claim' })
    let body: unknown = null
    try {
      body = rawText ? JSON.parse(rawText) : null
    } catch {
      return json(400, { error: 'claim' })
    }
    if (!isRecord(body)) return json(400, { error: 'claim' })
    const name = masterName(isRecord(body.master) ? body.master.name : undefined)
    if (!name) return json(400, { error: 'claim' })
    if (claiming || o.store.list().length > 0) return json(409, { error: 'claimed' })
    claiming = true
    try {
      const checked = o.join.attempt(typeof body.code === 'string' ? body.code : '')
      if (!checked.ok) {
        return checked.status === 410
          ? json(410, { error: 'expired' })
          : json(403, { error: 'code', remaining: checked.remaining, ...(checked.ended && { ended: true }) })
      }
      const { token } = o.store.add(name, 'claim')
      return json(200, { token, id: here.id })
    } finally {
      claiming = false
    }
  }

  async function answer(req: Request, srv?: Server): Promise<Response> {
    // The door as this request found it, should a sync change it meanwhile.
    const here = node
    const port = bound
    if (!here || port === null) return json(503, { error: 'node' })
    if (!loopbackHost((req.headers.get('host') ?? '').toLowerCase())) return json(403, { error: 'host' })
    if (req.headers.has('origin')) return json(403, { error: 'origin' })
    let url: URL | undefined
    let master: MasterRecord | null = null
    try {
      url = new URL(req.url)
      const raw = url.pathname
      if (req.method === 'GET' && raw === '/api/hello') {
        const claimed = o.store.list().length > 0
        const join = !claimed && boundTls && boundCertFp && o.join ? o.join.hello(here.id, boundCertFp) : null
        return json(200, {
          ...o.hello(),
          node: {
            api: NODE_API,
            id: here.id,
            claimed,
            ...(boundTls && boundCertFp ? { cert: boundCertFp } : {}),
            ...(join && { join }),
          },
        })
      }
      if (req.method === 'POST' && raw === '/api/node/claim') return await handleClaim(req, here)
      const token = bearerOf(req.headers.get('authorization'))
      master = token ? o.store.verify(token) : null
      if (!master) {
        const room = wrong.take(peerOf(srv, req), Date.now())
        if (!room.ok) {
          const res = json(429, { error: 'limited' })
          res.headers.set('retry-after', String(room.retryAfterS))
          return res
        }
        return json(401, { error: 'token' })
      }
      if (req.method !== 'GET' && req.headers.get('x-board') !== '1') return json(403, { error: 'header' })
      const path = decoded(raw)
      if (path === null) return json(400, { error: 'path' })
      const route = doorRoute(req.method, raw, path)
      if (!route) return json(404, { error: 'not found' })
      if (route.door) callers.set(req, master)
      const res = await dispatch(route.door ? o.doorRoutes : o.routes, req, url, path, o.guards, () => peerOf(srv, req))
      const id = master.id
      return endsWhenGone(res, gone => o.store.watch(id, gone), { 'x-accel-buffering': 'no' })
    } catch (err) {
      // The path only: a query can carry the page's file token.
      o.log(`node door ${req.method} ${url ? url.pathname : ''}: ${messageOf(err)}`)
      // Before a master's token, nothing of this computer goes out.
      return json(500, { error: master ? messageOf(err) : 'server' })
    }
  }

  async function stop(): Promise<void> {
    const s = server
    server = null
    bound = null
    boundTls = null
    boundCertFp = null
    if (s) {
      await s.stop(true)
      o.onChange?.()
    }
  }

  function listen(port: number, tlsOn: boolean, id: string): void {
    try {
      // Only load or generate a door certificate when `node.tls` is true.
      const pair = tlsOn ? (o.doorCert ?? (n => ensureDoorCert(n)))(id) : null
      // Not development, no idle timeout, no port reuse: as the web board's own server (app.ts).
      server = Bun.serve({
        hostname: '127.0.0.1',
        port,
        idleTimeout: 0,
        development: false,
        reusePort: false,
        ...(pair ? { tls: { cert: pair.cert, key: pair.key } } : {}),
        fetch: answer,
      })
      bound = port
      boundTls = tlsOn
      boundCertFp = pair?.fingerprint ?? null
      error = null
      o.log(`node door: listening on 127.0.0.1:${port} as ${id}${tlsOn ? ' (tls)' : ''}`)
      o.onChange?.()
    } catch (err) {
      const next = `Cannot listen on 127.0.0.1:${port}: ${messageOf(err)}`
      if (next !== error) o.log(`node door: ${next}`)
      error = next
    }
  }

  async function syncNow(): Promise<void> {
    if (closed) return
    clearTimeout(retry)
    retry = undefined
    try {
      node = nodeConfig(o.cfg.node)
      if (!node) {
        if (server) {
          await stop()
          o.log('node door: closed')
        }
        error = null
        return
      }
      if (!server || bound !== node.port || boundTls !== node.tls) {
        // Nothing awaited on the way to the first listen: it listens once sync() has had its turn.
        if (server) await stop()
        listen(node.port, node.tls, node.id)
      }
      // A port another program holds is tried again, while `node` asks for the door.
      if (!server && !closed) retry = setTimeout(() => void sync(), RETRY_MS)
    } catch (err) {
      o.log(`node door: ${messageOf(err)}`)
    }
  }

  function sync(): Promise<void> {
    // One at a time: a second call while one runs waits for it, then runs again.
    const next = (syncing ?? Promise.resolve()).then(syncNow)
    const tail: Promise<void> = next.then(() => {
      if (syncing === tail) syncing = null
    })
    syncing = tail
    return next
  }

  return {
    sync,
    configChanged() {
      const now = configKey()
      if (now === lastConfig) return
      lastConfig = now
      void sync()
    },
    listening: () => bound,
    async close() {
      closed = true
      clearTimeout(retry)
      await syncing
      await stop()
    },
  }
}
