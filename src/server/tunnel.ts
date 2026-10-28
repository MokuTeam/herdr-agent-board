// The tunnel listener (core/tunnel.ts): the board through the owner's own domain. While
// config.json's `tunnel` is on, its settings check out and the login is set up (services/
// access.ts), a server on 127.0.0.1 takes what the tunnel's ssh forwards from Caddy on the owner's
// server. Otherwise nothing listens there.
//
// Every request here came from the internet: whether a login is needed depends on this listener
// alone, never on a header, and no setting turns it off. A request gets to a board route only when:
// - its Host is the domain (or <domain>:443; with `tunnel.publicPort` set to another port, exactly
//   <domain>:<publicPort>) and Caddy says it came over HTTPS;
// - anything but GET or HEAD carries X-Board: 1 and the domain's own Origin (publicOrigin), which
//   must be there;
// - it carries the cookie of a live login;
// - it does not act on this computer's screen (desktopOnly), nor manage the remote mode, Remote
//   access, wake or the team (localOnly), in either spelling of its path; pairing and peers are not here at
//   all.
// The routes' own guards apply as for the web board, with the domain's origin as the board's own,
// and the routes that read by a path refuse the board's own files (ownFiles). WebAuthn expects
// that origin too; its relying party is the domain alone, so passkeys outlive a port change.
// Without a login only what signing in needs: the page and its files (marked remote, as for a
// phone's browser), a reduced hello, the login routes and the board's probe; anything else is 401,
// and a cookie that is no login is cleared. A body that is no JSON or too large on the listener's
// own routes is 400 and no line in the log, which anyone could otherwise grow. The caller's
// address is the rightmost X-Forwarded-For (Caddy's), for showing and rate limits only. A login's
// open event streams end, with the event a phone's do, the moment it ends or expires. No answer
// from here may be shown in a frame.
import { isRecord } from '../adapters/json-store.ts'
import {
  clearLoginCookie,
  forwardedAddress,
  LOGIN_COOKIE,
  loginCookie,
  loginToken,
  RATES,
  RateLimiter,
} from '../core/access.ts'
import { REMOTE_API } from '../core/remote.ts'
import { boardPorts, publicHosts, publicOrigin, tunnelConfig, tunnelPort, tunnelProblems } from '../core/tunnel.ts'
import type { Config } from '../core/types.ts'
import type { Access, SignIn, Who } from '../services/access.ts'
import type { Probes } from '../services/tunnel.ts'
import { type Body, dispatch, type GuardState, json, peerOf, type Route, readBody } from './http.ts'
import { decoded, endsWhenGone, remoteRefusal } from './streams.ts'
import { probeAnswer } from './tunnel-probe.ts'

export interface TunnelListenerOptions {
  cfg: Config
  /** The web board's port: the tunnel listener's is that plus two unless config.json gives one. */
  webPort: number
  routes: Route[]
  guards: GuardState
  /** The board's page marked remote, as a phone's browser gets it (staticRoute with pwaPage). */
  page: Route
  access: Access
  /** The nonces the board's own probe answers (services/tunnel.ts). */
  probes: Probes
  /** Whether a path is one of the board's own files (adapters/own-files.ts), which no route here reads. */
  ownFiles: (target: string) => boolean
  log: (text: string) => void
  /** listening() changed: it started, stopped or moved. */
  onChange: () => void
}

export interface TunnelListener {
  /** Listens on 127.0.0.1:<tunnelPort> while tunnel.on, no tunnelProblems and access.ready(); else nothing listens. */
  sync(): Promise<void>
  /** The config changed: sync when the tunnel's part of it, or the ports it must keep off, did. */
  configChanged(): void
  /** The port it listens on, or null. */
  listening(): number | null
  close(): Promise<void>
}

type Server = ReturnType<typeof Bun.serve>

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
/** A listener that could not start is tried again this often while it should listen. */
const RETRY_MS = 30_000
/** Pairing and the other boards on the tailnet are the Tailscale listener's: not here at all. */
const NOT_HERE = /^\/api\/(peers|remote\/pair)(\/|$)/
const PROBE = /^\/api\/probe\/([^/]+)$/

/** Whether the request sent a login cookie, whatever its value. */
const sentLogin = (cookie: string | null): boolean =>
  (cookie ?? '').split(';').some(part => part.split('=')[0]?.trim() === LOGIN_COOKIE)

/** `res`, with the login cookie cleared when the request sent one. */
function clearedFor(res: Response, cookie: string | null): Response {
  if (sentLogin(cookie)) res.headers.set('set-cookie', clearLoginCookie())
  return res
}

/** 429 with Retry-After. */
function limited(retryAfterS: number): Response {
  const res = json(429, { ok: false, error: 'limited' })
  res.headers.set('retry-after', String(retryAfterS))
  return res
}

/** A sign-in's answer: the login's cookie, or why not (when the lockout ends, in ms since the epoch; when to try again). */
function signInAnswer(r: SignIn): Response {
  if (r.ok) {
    const res = json(200, { ok: true, method: r.login.method })
    res.headers.set('set-cookie', loginCookie(r.token, r.maxAgeS))
    return res
  }
  if (r.status === 429) return limited(r.retryAfterS ?? 60)
  return json(r.status, {
    ok: false,
    error: r.error,
    ...(r.status === 423 && r.until !== undefined && { until: r.until }),
  })
}

/** Never in a frame: a login screen in front of a shell is no page to put inside someone else's. */
function unframed(res: Response): Response {
  const set = (headers: Headers): void => {
    headers.set('x-frame-options', 'DENY')
    if (!headers.has('content-security-policy')) headers.set('content-security-policy', "frame-ancestors 'none'")
  }
  try {
    set(res.headers)
    return res
  } catch {
    // headers that cannot change: the same answer with headers of its own
    const headers = new Headers(res.headers)
    set(headers)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
}

/**
 * The request's JSON body, or undefined when it is no JSON or over 192 KB (readBody): the caller's
 * mistake, which anyone may make as often as they like, so a 400 and never a line in the log.
 */
const bodyOf = (req: Request): Promise<unknown> => readBody(req).catch(() => undefined)
const badBody = (): Response => json(400, { ok: false, error: 'shape' })
const fieldsOf = (body: unknown): Body => (isRecord(body) ? body : {})

/** Where the board is reached: the domain (WebAuthn's relying party), the Hosts it answers to, its origin. */
interface Site {
  domain: string
  hosts: string[]
  origin: string
}

export function createTunnelListener(o: TunnelListenerOptions): TunnelListener {
  let server: Server | null = null
  let bound: number | null = null
  /** The site it answers for, as of the last sync. */
  let site: Site = { domain: '', hosts: [], origin: '' }
  let error: string | null = null
  let closed = false
  let syncing: Promise<void> | null = null
  const configKey = (): string => JSON.stringify([o.cfg.tunnel ?? null, o.cfg.remote ?? null])
  let lastConfig = configKey()
  /** Codes tried to add a passkey: a login holder may not guess them without limit. */
  const addCodes = new RateLimiter(RATES.password)

  const conf = () => tunnelConfig(o.cfg.tunnel)
  /** On, the settings check out (the ports the board's other listeners take too), the login set up. */
  function wanted(): boolean {
    const c = conf()
    return c.on && !tunnelProblems(c, boardPorts(o.cfg.remote, o.webPort)).length && o.access.ready()
  }

  /** What anyone may ask without a login, of the board at `here`; undefined for the rest. */
  async function open(
    req: Request,
    url: URL,
    here: Site,
    who: Who,
    cookie: string | null,
  ): Promise<Response | undefined> {
    const raw = url.pathname
    const { domain, origin } = here
    if (req.method === 'GET' && raw === '/api/hello') {
      const room = o.access.rate('open', who.address)
      if (!room.ok) return limited(room.retryAfterS)
      const token = loginToken(cookie)
      const signedIn = !!(token && o.access.verify(token))
      // Nothing more before a login: no version, host name or platform.
      const res = json(200, {
        board: 'agent-board',
        api: REMOTE_API,
        auth: 'login',
        signedIn,
        language: o.cfg.language ?? null,
      })
      return signedIn ? res : clearedFor(res, cookie)
    }
    const probe = PROBE.exec(raw)
    if (req.method === 'GET' && probe) {
      const room = o.access.rate('open', who.address)
      if (!room.ok) return limited(room.retryAfterS)
      const nonce = probe[1] ?? ''
      return o.probes.answers(nonce) ? probeAnswer(nonce) : json(404, { error: 'not found' })
    }
    if (req.method === 'POST' && raw === '/api/login/password') {
      const body = await bodyOf(req)
      return body === undefined ? badBody() : signInAnswer(await o.access.signInPassword(fieldsOf(body), who))
    }
    if (req.method === 'POST' && raw === '/api/login/passkey/options') {
      const room = o.access.rate('passkey', who.address)
      if (!room.ok) return limited(room.retryAfterS)
      return json(200, o.access.passkeyLoginOptions(domain))
    }
    // Its rate is taken by the sign-in itself.
    if (req.method === 'POST' && raw === '/api/login/passkey') {
      const body = await bodyOf(req)
      return body === undefined
        ? badBody()
        : signInAnswer(await o.access.signInPasskey(body, { origin, rpId: domain }, who))
    }
    // The page, its scripts, styles, icons, manifest and service worker: the login screen needs them.
    if (req.method === 'GET' && !raw.startsWith('/api/') && !raw.startsWith('/uploads/')) {
      const page = decoded(raw)
      return page === null ? json(400, { error: 'path' }) : await dispatch([o.page], req, url, page, o.guards)
    }
    return undefined
  }

  async function answer(req: Request, srv?: Server): Promise<Response> {
    // The site as this request found it, should a sync change it meanwhile.
    const here = site
    const host = (req.headers.get('host') ?? '').toLowerCase()
    if (!here.domain || !here.hosts.includes(host)) return json(403, { error: 'host' })
    if (req.headers.get('x-forwarded-proto') !== 'https') return json(403, { error: 'https' })
    const { domain, origin } = here
    // A browser sends the cookie by itself: what changes anything must come from the board's own page.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers.get('x-board') !== '1' || req.headers.get('origin') !== origin)
        return json(403, { error: 'origin' })
    }
    const who: Who = {
      address: forwardedAddress(req.headers.get('x-forwarded-for')),
      userAgent: req.headers.get('user-agent'),
    }
    const cookie = req.headers.get('cookie')
    let url: URL | undefined
    let signedIn = false
    try {
      url = new URL(req.url)
      const raw = url.pathname
      const pub = await open(req, url, here, who, cookie)
      if (pub) return pub
      const token = loginToken(cookie)
      const login = token ? o.access.verify(token) : null
      if (!token || !login) return clearedFor(json(401, { error: 'login' }), cookie)
      signedIn = true
      const path = decoded(raw)
      if (path === null) return json(400, { error: 'path' })
      if (NOT_HERE.test(raw) || NOT_HERE.test(path)) return json(404, { error: 'not found' })
      const refused = remoteRefusal(raw, path)
      if (refused) return refused
      if (req.method === 'POST' && raw === '/api/logout') {
        o.access.endToken(token)
        const res = json(200, { ok: true })
        res.headers.set('set-cookie', clearLoginCookie())
        return res
      }
      // A passkey for this device, made by this live login with a fresh code (services/access.ts).
      if (req.method === 'POST' && raw === '/api/login/passkey/add/options') {
        const room = addCodes.take(who.address, Date.now())
        if (!room.ok) return limited(room.retryAfterS)
        const body = await bodyOf(req)
        if (body === undefined) return badBody()
        const r = o.access.passkeyAddOptions(login.id, fieldsOf(body).code, { id: domain })
        return r.ok ? json(200, r.options) : json(r.status, { ok: false, error: r.error })
      }
      if (req.method === 'POST' && raw === '/api/login/passkey/add') {
        const body = await bodyOf(req)
        if (body === undefined) return badBody()
        const r = o.access.addPasskey(login.id, body, { origin, rpId: domain }, who.userAgent)
        return r.ok ? json(200, { ok: true, id: r.id }) : json(400, { ok: false, error: r.error })
      }
      const res = await dispatch(
        o.routes,
        req,
        url,
        path,
        { ...o.guards, origins: [origin], ownFiles: o.ownFiles },
        () => peerOf(srv, req),
      )
      return endsWhenGone(res, gone => o.access.watch(login.id, gone), { 'x-accel-buffering': 'no' })
    } catch (err) {
      // The path only: a query can carry the page's file token.
      o.log(`tunnel ${req.method} ${url ? url.pathname : ''}: ${messageOf(err)}`)
      // Before a login, nothing of this computer goes out, a path in an error neither.
      return json(500, { error: signedIn ? messageOf(err) : 'server' })
    }
  }

  async function stop(): Promise<void> {
    const s = server
    server = null
    bound = null
    if (s) await s.stop(true)
  }

  function listen(port: number): void {
    try {
      // Not development, no idle timeout, no port reuse: as the web board's own server (app.ts).
      server = Bun.serve({
        hostname: '127.0.0.1',
        port,
        idleTimeout: 0,
        development: false,
        reusePort: false,
        fetch: async (req, srv) => unframed(await answer(req, srv)),
      })
      bound = port
      error = null
      o.log(`tunnel: listening on 127.0.0.1:${port} for ${site.origin}/`)
    } catch (err) {
      const next = `Cannot listen on 127.0.0.1:${port}: ${messageOf(err)}`
      if (next !== error) o.log(`tunnel: ${next}`)
      error = next
    }
  }

  async function syncNow(): Promise<void> {
    if (closed) return
    const before = bound
    try {
      if (!wanted()) {
        if (server) await stop()
        error = null
      } else {
        const c = conf()
        site = { domain: c.domain, hosts: publicHosts(c), origin: publicOrigin(c) }
        const port = tunnelPort(c, o.webPort)
        if (!server || bound !== port) {
          // Nothing awaited on the way to the first listen: it listens once sync() has had its turn.
          if (server) await stop()
          listen(port)
        }
      }
    } catch (err) {
      o.log(`tunnel: ${messageOf(err)}`)
    }
    if (bound !== before) o.onChange()
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

  // A port another program held is tried again; while off, this reads the config and nothing else.
  const timer = setInterval(() => {
    if (!server) void sync()
  }, RETRY_MS)

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
      clearInterval(timer)
      await syncing
      await stop()
    },
  }
}
