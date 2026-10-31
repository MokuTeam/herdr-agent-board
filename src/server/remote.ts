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
// - it does not act on this computer's screen (desktopOnly), nor approve pairings, set up Remote
//   access or work wake (localOnly: /api/remote, /api/access, /api/wake, for the board on this
//   computer only), nor read or change the owner's secrets for the agents (/api/secrets).
// The routes' own guards apply as for the web board (X-Board on POSTs, fresh herdr data, the file
// token).
//
// With `remote.pwa` on as well, one more listener, on 127.0.0.1, takes what `tailscale serve`
// forwards from the computer's HTTPS name (core/pwa.ts): the same checks, with the caller's
// address from serve, the token in a cookie, and the board's page for a phone's browser.
// A device's open streams end when it is unpaired, on both.
import { hostname } from 'node:os'
import { type Caller, serveStatus, tailscaleStatus, whois } from '../adapters/tailscale.ts'
import {
  clearCookie,
  cookieToken,
  forwardedFor,
  pwaHosts,
  pwaPort,
  pwaTarget,
  pwaUrl,
  serveUse,
  tokenCookie,
} from '../core/pwa.ts'
import {
  allowedLogin,
  bearerOf,
  type PwaView,
  REMOTE_API,
  type RemoteConfig,
  type RemoteView,
  remoteConfig,
  type ServeUse,
  statusVerdict,
  WHOIS_GRACE_MS,
} from '../core/remote.ts'
import type { Config } from '../core/types.ts'
import type { Remote } from '../services/remote.ts'
import { dispatch, type GuardState, json, peerOf, type Route, readBody } from './http.ts'
import { decoded, endsWhenGone, remoteRefusal } from './streams.ts'

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
  /** Through `tailscale serve` only: whether this browser is paired, and the board's language (core/pwa.ts). */
  paired?: boolean
  language?: string | null
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
  /** The board's page for a phone's browser, through `tailscale serve` (core/pwa.ts). */
  page: Route
  remote: Remote
  log: (text: string) => void
  /** What the page shows changed. */
  onChange: () => void
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isV4 = (ip: string): boolean => /^\d+\.\d+\.\d+\.\d+$/.test(ip)
const urlHost = (ip: string): string => (ip.includes(':') ? `[${ip}]` : ip)
const WHOIS_MS = 60_000
type Server = ReturnType<typeof Bun.serve>
/** Which listener a request came to: the one on the Tailscale address, or the one for `tailscale serve`. */
type Via = 'tailnet' | 'serve'

/** Serve's own word for the user, when it gives one in plain text, must be Tailscale's. */
const sameUser = (header: string | null, who: Caller): boolean =>
  !header || header.startsWith('=?') || header.toLowerCase() === who.login.toLowerCase()

export function createRemoteListener(o: RemoteListenerOptions): RemoteListener {
  let server: Server | null = null
  let bound: { ip: string; port: number } | null = null
  // The listener for `tailscale serve`, while remote.pwa is on.
  let web: Server | null = null
  let webPort: number | null = null
  let pwaHostSet = new Set<string>()
  let pwaOrigin = ''
  let certs = false
  let serve: ServeUse | null = null
  let pwaError: string | null = null
  // Failed looks at Tailscale in a row, and the look that comes sooner after one (#108).
  let failures = 0
  let retry: ReturnType<typeof setTimeout> | undefined
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
    // Tailscale not answering for a moment (whois fails as an unknown address does) leaves a caller
    // it vouched for as it was, for a while: an address on the tailnet keeps its device (#108).
    if (!who && hit?.who && Date.now() - hit.at < WHOIS_GRACE_MS) return hit.who
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

  async function answer(req: Request, srv: Server, via: Via): Promise<Response> {
    const fromServe = via === 'serve'
    if (!(fromServe ? pwaHostSet : hosts).has((req.headers.get('host') ?? '').toLowerCase()))
      return json(403, { error: 'host' })
    if (fromServe && req.headers.get('x-forwarded-proto') !== 'https') return json(403, { error: 'https' })
    const address = fromServe
      ? forwardedFor(req.headers.get('x-forwarded-for'))
      : (srv.requestIP(req)?.address ?? '').replace(/^::ffff:/, '')
    const who = address ? await caller(address) : null
    if (!who) return json(403, { error: 'tailnet' })
    if (fromServe && !sameUser(req.headers.get('tailscale-user-login'), who)) return json(403, { error: 'user' })
    if (!allowedLogin(who.login, owner, rc().allow)) return json(403, { error: 'user' })
    // A browser sends the cookie by itself: what changes anything must come from the board's own page.
    if (fromServe && req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.get('origin')
      if (req.headers.get('x-board') !== '1' || (origin && origin !== pwaOrigin)) return json(403, { error: 'origin' })
    }
    const token = fromServe ? cookieToken(req.headers.get('cookie')) : bearerOf(req.headers.get('authorization'))
    let url: URL | undefined
    try {
      url = new URL(req.url)
      const raw = url.pathname
      if (req.method === 'GET' && raw === '/api/hello')
        return json(
          200,
          fromServe
            ? { ...hello(), paired: !!(token && o.remote.verify(token, who)), language: o.cfg.language ?? null }
            : hello(),
        )
      if (req.method === 'POST' && raw === '/api/remote/pair') {
        const body = await readBody(req)
        const r = o.remote.request((body as { name?: unknown })?.name, who, fromServe ? 'browser' : undefined)
        return r.ok ? json(202, { id: r.id }) : json(r.status, { error: r.error })
      }
      const poll = /^\/api\/remote\/pair\/([a-f0-9]{1,32})$/.exec(raw)
      if (req.method === 'GET' && poll) {
        const answer = o.remote.poll(poll[1] ?? '', who)
        if (!fromServe || answer.status !== 'approved') return json(200, answer)
        // A browser's token goes into its cookie, where the page's scripts never see it.
        const { token: given, ...rest } = answer
        const res = json(200, rest)
        res.headers.set('set-cookie', tokenCookie(given))
        return res
      }
      // The page, its scripts, styles, icons and service worker: the pairing screen needs them too.
      if (fromServe && req.method === 'GET' && !raw.startsWith('/api/') && !raw.startsWith('/uploads/')) {
        const page = decoded(raw)
        return page === null ? json(400, { error: 'path' }) : await dispatch([o.page], req, url, page, o.guards)
      }
      const device = token ? o.remote.verify(token, who) : null
      if (!device) {
        const res = json(401, { error: 'token' })
        if (fromServe && token) res.headers.set('set-cookie', clearCookie())
        return res
      }
      // The routes match a string path decoded and a RegExp one as it came: what stays with the
      // computer is refused in both spellings, or an encoded letter (/api/fs/%6Fpen) would get by.
      const path = decoded(raw)
      if (path === null) return json(400, { error: 'path' })
      const refused = remoteRefusal(raw, path)
      if (refused) return refused
      if (req.method === 'GET' && raw === '/api/peers') return json(200, { peers: await peers() })
      // The board's page is for the computer's own browser; a phone has its app.
      if (!raw.startsWith('/api/') && !raw.startsWith('/uploads/')) return json(404, { error: 'not found' })
      const guards = fromServe ? { ...o.guards, origins: [pwaOrigin] } : o.guards
      return endsWhenGone(await dispatch(o.routes, req, url, path, guards, () => peerOf(srv, req)), gone =>
        o.remote.watch(device.id, gone),
      )
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

  async function stopWeb(): Promise<void> {
    const s = web
    web = null
    webPort = null
    if (s) await s.stop(true)
  }

  function pwaView(): PwaView {
    const { pwa } = rc()
    return {
      on: pwa.on,
      https: pwa.https,
      url: pwa.on && web && serve === 'ours' && pwaOrigin ? pwaOrigin : null,
      certs,
      serve: pwa.on ? serve : null,
      error: pwa.on ? pwaError : null,
    }
  }

  /** The listener for `tailscale serve`, and what serve does with the HTTPS port, as remote.pwa says. */
  async function syncPwa(conf: RemoteConfig, dnsName: string): Promise<void> {
    if (!conf.pwa.on || !dnsName) {
      await stopWeb()
      serve = null
      pwaError = null
      return
    }
    const port = pwaPort(conf.pwa, o.webPort)
    pwaHostSet = pwaHosts(dnsName, conf.pwa.https)
    pwaOrigin = pwaUrl(dnsName, conf.pwa.https)
    pwaError = null
    try {
      serve = serveUse((await serveStatus()).get(conf.pwa.https), pwaTarget(port))
    } catch (err) {
      serve = null
      pwaError = `tailscale serve: ${messageOf(err)}`
    }
    if (web && webPort === port) return
    await stopWeb()
    try {
      web = Bun.serve({
        hostname: '127.0.0.1',
        port,
        idleTimeout: 0,
        development: false,
        reusePort: false,
        fetch: (req, srv) => answer(req, srv, 'serve'),
      })
      webPort = port
      o.log(`remote: ${pwaOrigin}/ through tailscale serve to 127.0.0.1:${port}`)
    } catch (err) {
      pwaError = `Cannot listen on 127.0.0.1:${port}: ${messageOf(err)}`
    }
  }

  function setError(next: string | null): void {
    if (next !== error) {
      error = next
      if (next) o.log(`remote: ${next}`)
      o.onChange()
    }
  }

  /**
   * A look at Tailscale that failed: while it is one of a few in a row and something listens, the
   * listeners stay and the next look comes sooner (true); after that, they go (false).
   */
  async function waitOut(why: string): Promise<boolean> {
    failures++
    const verdict = statusVerdict(failures)
    if (verdict.down || (!server && !web)) return false
    o.log(`remote: Tailscale did not answer (${why}); the listeners stay, again in ${verdict.retryMs / 1000} s`)
    clearTimeout(retry)
    retry = setTimeout(() => void sync(), verdict.retryMs)
    return true
  }

  async function syncNow(): Promise<void> {
    const conf = rc()
    if (!conf.on) {
      const was = !!server || !!web
      await stop()
      await stopWeb()
      error = null
      if (was) o.onChange()
      return
    }
    let status: Awaited<ReturnType<typeof tailscaleStatus>>
    try {
      status = await tailscaleStatus()
    } catch (err) {
      if (await waitOut(messageOf(err))) return
      await stop()
      await stopWeb()
      return setError(`Tailscale is not available: ${messageOf(err)}`)
    }
    // Starting again (a network change) is a moment too; logged out or stopped is not.
    if (status.backend === 'Starting' && (await waitOut('tailscaled is starting'))) return
    failures = 0
    const self = status.self
    const ip = self?.ips.find(isV4) ?? self?.ips[0]
    if (!status.running || !self || !ip) {
      await stop()
      await stopWeb()
      return setError('Tailscale is not connected on this computer')
    }
    owner = self.login
    names = { name: self.name, dnsName: self.dnsName }
    const before = JSON.stringify(pwaView())
    certs = status.certDomains.includes(self.dnsName)
    await syncPwa(conf, self.dnsName)
    if (JSON.stringify(pwaView()) !== before) o.onChange()
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
        fetch: (req, srv) => answer(req, srv, 'tailnet'),
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
        pwa: pwaView(),
      }
    },
    hello,
    async close() {
      clearInterval(timer)
      clearTimeout(retry)
      await stop()
      await stopWeb()
    },
  }
}
