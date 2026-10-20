// The remote mode's listener (core/remote.ts): while config.json has it on, a second server on
// this computer's Tailscale address (never 0.0.0.0) takes the web board's routes for a paired
// phone. Off, nothing listens there and this does nothing but read the config.
//
// A request gets to a route only when:
// - its Host is this computer's Tailscale address or name, with the port;
// - Tailscale says who calls (`tailscale whois`), and that user is this computer's own or one
//   config.json allows;
// - it carries the token of a device paired from that very Tailscale device, for anything but
//   /api/hello and the pairing itself;
// - it does not act on this computer's screen (desktopOnly), nor approve pairings (/api/remote,
//   for the board on this computer only).
// The routes' own guards apply as for the web board (X-Board on POSTs, fresh herdr data, the file
// token).
import { hostname } from 'node:os'
import { type Caller, tailscaleStatus, whois } from '../adapters/tailscale.ts'
import {
  allowedLogin,
  bearerOf,
  desktopOnly,
  REMOTE_API,
  type RemoteConfig,
  type RemoteView,
  remoteConfig,
} from '../core/remote.ts'
import type { Config } from '../core/types.ts'
import type { Remote } from '../services/remote.ts'
import { dispatch, type GuardState, json, type Route, readBody } from './http.ts'

export interface Hello {
  board: 'agent-board'
  /** The remote API's version (REMOTE_API). */
  api: number
  version: string
  /** The computer's own name, and its Tailscale names once known. */
  host: string
  name: string | null
  dnsName: string | null
  platform: string
  remote: boolean
}

export interface Peer {
  name: string
  dnsName: string
  os: string
  url: string
  hello: Hello
}

export interface RemoteListener {
  /** Starts, moves or stops the listener as the config and Tailscale say. */
  sync(): Promise<void>
  /** The config changed: sync when the remote mode's part of it did. */
  configChanged(): void
  /** What the page shows; null while the remote mode is off. */
  view(): RemoteView | null
  hello(): Hello
  close(): Promise<void>
}

export interface RemoteListenerOptions {
  cfg: Config
  /** The web board's port: the remote one unless config.json gives one. */
  webPort: number
  version: string
  routes: Route[]
  guards: GuardState
  remote: Remote
  log: (text: string) => void
  /** What the page shows changed. */
  onChange: () => void
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isV4 = (ip: string): boolean => /^\d+\.\d+\.\d+\.\d+$/.test(ip)
const urlHost = (ip: string): string => (ip.includes(':') ? `[${ip}]` : ip)
const WHOIS_MS = 60_000

export function createRemoteListener(o: RemoteListenerOptions): RemoteListener {
  let server: ReturnType<typeof Bun.serve> | null = null
  let bound: { ip: string; port: number } | null = null
  let hosts = new Set<string>()
  let names: { name: string; dnsName: string } | null = null
  let owner: string | null = null
  let error: string | null = null
  let lastConfig = JSON.stringify(o.cfg.remote ?? null)
  let syncing: Promise<void> | null = null
  const callers = new Map<string, { who: Caller | null; at: number }>()

  const rc = (): RemoteConfig => remoteConfig(o.cfg.remote)

  async function caller(address: string): Promise<Caller | null> {
    const hit = callers.get(address)
    // An address Tailscale did not know is asked again sooner.
    if (hit && Date.now() - hit.at < (hit.who ? WHOIS_MS : 10_000)) return hit.who
    const who = await whois(address)
    callers.set(address, { who, at: Date.now() })
    return who
  }

  function hello(): Hello {
    return {
      board: 'agent-board',
      api: REMOTE_API,
      version: o.version,
      host: hostname(),
      name: names?.name ?? null,
      dnsName: names?.dnsName ?? null,
      platform: process.platform,
      remote: rc().on,
    }
  }

  /** The other computers on the tailnet whose board answers on the same port. */
  async function peers(): Promise<Peer[]> {
    const status = await tailscaleStatus()
    const port = bound?.port ?? rc().port ?? o.webPort
    const found = await Promise.all(
      status.peers
        .filter(p => p.online && p.ips.length)
        .map(async (p): Promise<Peer | null> => {
          const ip = p.ips.find(isV4) ?? p.ips[0] ?? ''
          try {
            const res = await fetch(`http://${urlHost(ip)}:${port}/api/hello`, { signal: AbortSignal.timeout(1500) })
            const body = (await res.json()) as Hello
            if (!res.ok || body?.board !== 'agent-board') return null
            return { name: p.name, dnsName: p.dnsName, os: p.os, url: `http://${p.dnsName || ip}:${port}`, hello: body }
          } catch {
            return null
          }
        }),
    )
    return found.filter((p): p is Peer => !!p)
  }

  async function answer(req: Request, srv: ReturnType<typeof Bun.serve>): Promise<Response> {
    if (!hosts.has((req.headers.get('host') ?? '').toLowerCase())) return json(403, { error: 'host' })
    const address = (srv.requestIP(req)?.address ?? '').replace(/^::ffff:/, '')
    const who = address ? await caller(address) : null
    if (!who) return json(403, { error: 'tailnet' })
    if (!allowedLogin(who.login, owner, rc().allow)) return json(403, { error: 'user' })
    let url: URL | undefined
    try {
      url = new URL(req.url)
      const raw = url.pathname
      if (req.method === 'GET' && raw === '/api/hello') return json(200, hello())
      if (req.method === 'POST' && raw === '/api/remote/pair') {
        const body = await readBody(req)
        const r = o.remote.request((body as { name?: unknown })?.name, who)
        return r.ok ? json(202, { id: r.id }) : json(r.status, { error: r.error })
      }
      const poll = /^\/api\/remote\/pair\/([a-f0-9]{1,32})$/.exec(raw)
      if (req.method === 'GET' && poll) return json(200, o.remote.poll(poll[1] ?? '', who))
      const token = bearerOf(req.headers.get('authorization'))
      if (!token || !o.remote.verify(token, who)) return json(401, { error: 'token' })
      if (desktopOnly(raw)) return json(403, { error: 'desktop' })
      if (raw === '/api/remote' || raw.startsWith('/api/remote/')) return json(403, { error: 'local' })
      if (req.method === 'GET' && raw === '/api/peers') return json(200, { peers: await peers() })
      // The board's page is for the computer's own browser; a phone has its app.
      if (!raw.startsWith('/api/') && !raw.startsWith('/uploads/')) return json(404, { error: 'not found' })
      return await dispatch(o.routes, req, url, decodeURIComponent(raw), o.guards)
    } catch (err) {
      o.log(`remote ${req.method} ${url ? url.pathname : ''}: ${messageOf(err)}`)
      return json(500, { error: messageOf(err) })
    }
  }

  async function stop(): Promise<void> {
    const s = server
    server = null
    bound = null
    if (s) await s.stop(true)
  }

  function setError(next: string | null): void {
    if (next !== error) {
      error = next
      if (next) o.log(`remote: ${next}`)
      o.onChange()
    }
  }

  async function syncNow(): Promise<void> {
    const conf = rc()
    if (!conf.on) {
      const was = !!server
      await stop()
      error = null
      if (was) o.onChange()
      return
    }
    let status: Awaited<ReturnType<typeof tailscaleStatus>>
    try {
      status = await tailscaleStatus()
    } catch (err) {
      await stop()
      return setError(`Tailscale is not available: ${messageOf(err)}`)
    }
    const self = status.self
    const ip = self?.ips.find(isV4) ?? self?.ips[0]
    if (!status.running || !self || !ip) {
      await stop()
      return setError('Tailscale is not connected on this computer')
    }
    owner = self.login
    names = { name: self.name, dnsName: self.dnsName }
    const port = conf.port ?? o.webPort
    hosts = new Set([ip, urlHost(ip), self.name, self.dnsName].filter(Boolean).map(h => `${h.toLowerCase()}:${port}`))
    if (server && bound?.ip === ip && bound.port === port) return setError(null)
    await stop()
    try {
      // Not development, no idle timeout, no port reuse: as the web board's own server (app.ts).
      server = Bun.serve({
        hostname: ip,
        port,
        idleTimeout: 0,
        development: false,
        reusePort: false,
        fetch: (req, srv) => answer(req, srv),
      })
      bound = { ip, port }
      o.log(`remote: listening on http://${self.dnsName || urlHost(ip)}:${port}/`)
      error = null
      o.onChange()
    } catch (err) {
      setError(`Cannot listen on ${urlHost(ip)}:${port}: ${messageOf(err)}`)
    }
  }

  function sync(): Promise<void> {
    // One at a time: a second call while one runs waits for it, then runs again.
    const next = (syncing ?? Promise.resolve()).then(syncNow, syncNow)
    syncing = next.finally(() => {
      if (syncing === next) syncing = null
    })
    return next
  }

  // Tailscale coming up or the address changing is seen within half a minute; off, nothing is asked.
  const timer = setInterval(() => {
    if (rc().on || server) void sync()
  }, 30_000)

  return {
    sync,
    configChanged() {
      const now = JSON.stringify(o.cfg.remote ?? null)
      if (now === lastConfig) return
      lastConfig = now
      callers.clear()
      void sync()
    },
    view() {
      if (!rc().on) return null
      const { pending, devices } = o.remote
      return {
        on: true,
        url: bound && names ? `http://${names.dnsName || urlHost(bound.ip)}:${bound.port}` : null,
        error,
        pending: pending().map(({ status, ...r }) => r),
        devices: devices().map(({ tokenHash, ...d }) => d),
      }
    },
    hello,
    async close() {
      clearInterval(timer)
      await stop()
    },
  }
}
