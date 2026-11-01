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
//   access or wake (localOnly), in either spelling of its path, nor the owner's secrets for the
//   agents, Settings → Backup… and Settings → Time tracking… but in server mode (core/remote.ts
//   secretsPath, ownServerSettings); pairing and peers are not here at all.
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
//
// In server mode (config.json's `serverMode`, core/on-server.ts) the same listener is the board's
// way in on its own server: it listens by itself, with no ssh and whether the login is set or not,
// on the Unix socket `serverMode.socket` (mode 0660, in the installer's folder; a stale socket left
// by a board before is removed, and the socket goes when this one stops or the process exits), for
// `serverMode.domain`, checked as the tunnel's domain is; the tunnel's settings play no part. Until
// the login is set, only the setup page and its two calls answer (the first login's one-time
// link, services/first-login.ts), rate-limited as a sign-in, and everything else is 401; once it
// is set, they are 404 and the rest is as above.
// With config.json's `vault` there (core/vault.ts), /vault is the owner's password vault: with a
// live login only, to Vaultwarden on 127.0.0.1 as it came (server/vault-proxy.ts), the web vault's
// calls from the domain's own Origin without X-Board (Vaultwarden takes its own bearer tokens), its
// admin page never, a new account only while it has none, its notifications' WebSocket ending with
// the login. Everywhere else /vault is refused (server/streams.ts), never the public page.
import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import type { WebSocketHandler } from 'bun'
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
import {
  SETUP_PATH,
  type ServerMode,
  serverHosts,
  serverModeOf,
  serverModeProblems,
  serverOrigin,
} from '../core/on-server.ts'
import { qrMatrix, qrPath } from '../core/qr.ts'
import { REMOTE_API } from '../core/remote.ts'
import { boardPorts, publicHosts, publicOrigin, tunnelConfig, tunnelPort, tunnelProblems } from '../core/tunnel.ts'
import type { Config } from '../core/types.ts'
import { vaultAdminPath, vaultPath, vaultRegisterPath, vaultSocketPath } from '../core/vault.ts'
import type { Access, SignIn, Who } from '../services/access.ts'
import type { FirstLogin } from '../services/first-login.ts'
import type { Probes } from '../services/tunnel.ts'
import { type Body, dispatch, type GuardState, json, peerOf, type Route, readBody } from './http.ts'
import { setupPage } from './setup-page.ts'
import { decoded, endsWhenGone, remoteRefusal } from './streams.ts'
import { probeAnswer } from './tunnel-probe.ts'
import { socketHeaders, type VaultGate, vaultAnswer } from './vault-proxy.ts'

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
  /** The first login's setup (services/first-login.ts), in server mode: without it the setup's calls are 404. */
  firstLogin?: FirstLogin
  /**
   * In server mode, the WebSockets the routes make (a desktop's VNC, services/desktop.ts): each
   * closes when its login ends. Without it, or on the tunnel's port, none is made.
   */
  websocket?: WebSocketHandler<object>
  /**
   * In server mode, the owner's password vault (core/vault.ts): /vault through this login to
   * Vaultwarden on 127.0.0.1, its WebSockets too (`websocket` takes them: server/vault-proxy.ts
   * bothSockets). Without it, or on the tunnel's port, /vault is no route here.
   */
  vault?: VaultGate
}

export interface TunnelListener {
  /**
   * Listens on 127.0.0.1:<tunnelPort> while tunnel.on, no tunnelProblems and access.ready(); in
   * server mode on its socket while its settings check out; else nothing listens.
   */
  sync(): Promise<void>
  /** The config changed: sync when the tunnel's part of it, the ports it must keep off, or the server mode did. */
  configChanged(): void
  /** The port it listens on, or null (in server mode always: no ssh forwards to it). */
  listening(): number | null
  /** The socket it listens on in server mode, or null. */
  socket(): string | null
  close(): Promise<void>
}

type Server = ReturnType<typeof Bun.serve>

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
/** A listener that could not start is tried again this often while it should listen. */
const RETRY_MS = 30_000
/** Pairing and the other boards on the tailnet are the Tailscale listener's: not here at all. */
const NOT_HERE = /^\/api\/(peers|remote\/pair)(\/|$)/
const PROBE = /^\/api\/probe\/([^/]+)$/

/** A request URL's path as it came, '' when it is none. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

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

/**
 * Where the board is reached: the domain (WebAuthn's relying party), the Hosts it answers to, its
 * origin; `setup`: in server mode, where the first login is set through the setup page.
 */
interface Site {
  domain: string
  hosts: string[]
  origin: string
  setup: boolean
}

/** The socket's mode: the board's user and the web server's group (the folder's) read and write it. */
const SOCKET_MODE = 0o660
const NOT_FOUND = (): Response => json(404, { error: 'not found' })
/** Bun.serve's idleTimeout of 0, typed so that its options for a socket take it. */
const NO_IDLE_TIMEOUT: object = { idleTimeout: 0 }

const codeOf = (err: unknown): unknown =>
  err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : undefined

/**
 * A socket a board before left at `path` (it ended without stopping its listener) goes, so that
 * this one can listen there; anything else there stays, and is the reason it cannot. Windows
 * cannot look at a socket file (EACCES): there it is taken as one.
 */
function clearStale(path: string): void {
  let socket: boolean
  try {
    socket = lstatSync(path).isSocket()
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return
    if (process.platform !== 'win32' || codeOf(err) !== 'EACCES') throw err
    socket = true
  }
  if (!socket) throw new Error(`${path} is there and is no socket: it is left as it is`)
  unlinkSync(path)
}

/** The socket gone, if it is still there. */
function removeSocket(path: string): void {
  try {
    unlinkSync(path)
  } catch {}
}

export function createTunnelListener(o: TunnelListenerOptions): TunnelListener {
  let server: Server | null = null
  let bound: number | null = null
  /** The socket it listens on in server mode, and its removal when the process exits. */
  let boundSocket: string | null = null
  let atExit: (() => void) | null = null
  /** The site it answers for, as of the last sync. */
  let site: Site = { domain: '', hosts: [], origin: '', setup: false }
  let error: string | null = null
  let closed = false
  let syncing: Promise<void> | null = null
  const configKey = (): string => JSON.stringify([o.cfg.tunnel ?? null, o.cfg.remote ?? null, o.cfg.serverMode ?? null])
  let lastConfig = configKey()
  /** Codes tried to add a passkey: a login holder may not guess them without limit. */
  const addCodes = new RateLimiter(RATES.password)

  const conf = () => tunnelConfig(o.cfg.tunnel)
  /** The server mode's settings; null on a PC, where the tunnel's are the listener's. */
  const mode = (): ServerMode | null => serverModeOf(o.cfg.serverMode)
  /** On, the settings check out (the ports the board's other listeners take too), the login set up. */
  function wanted(): boolean {
    const c = conf()
    return c.on && !tunnelProblems(c, boardPorts(o.cfg.remote, o.webPort)).length && o.access.ready()
  }

  /**
   * The first login, in server mode: the setup page and its calls while no login is set (anything
   * else 401), and 404 for them once it is; undefined to go on as the tunnel's listener does.
   * `raw` is the path as it came: an encoded spelling of the setup's is none of them.
   */
  async function setupGate(req: Request, raw: string, who: Who, cookie: string | null): Promise<Response | undefined> {
    const setupPath = raw === SETUP_PATH || raw.startsWith('/api/setup/')
    if (o.access.ready()) return setupPath ? NOT_FOUND() : undefined
    if (!setupPath) return clearedFor(json(401, { error: 'setup' }), cookie)
    if (req.method === 'GET' && raw === SETUP_PATH) {
      const room = o.access.rate('open', who.address)
      return room.ok ? setupPage() : limited(room.retryAfterS)
    }
    const first = o.firstLogin
    const call = raw.slice('/api/setup/'.length)
    if (!first || req.method !== 'POST' || (call !== 'start' && call !== 'finish')) return NOT_FOUND()
    // As a sign-in: the password sign-in's limits.
    const room = o.access.rate('password', who.address)
    if (!room.ok) return limited(room.retryAfterS)
    const body = await bodyOf(req)
    if (body === undefined) return badBody()
    if (call === 'start') {
      const r = first.start(fieldsOf(body).code)
      if (!r.ok) return json(r.status, { ok: false, error: r.error })
      return json(200, { ok: true, setup: r.setup, secret: r.secret, qr: qrPath(qrMatrix(r.uri)) })
    }
    const r = await first.finish(fieldsOf(body))
    if (r.ok) return json(200, { ok: true })
    const { status, ...refused } = r
    return json(status, refused)
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
    // Not the vault's path: refused as the board's own server's secrets are, the login first.
    if (
      req.method === 'GET' &&
      !raw.startsWith('/api/') &&
      !raw.startsWith('/uploads/') &&
      !vaultPath(raw) &&
      !vaultPath(decoded(raw) ?? '')
    ) {
      const page = decoded(raw)
      return page === null ? json(400, { error: 'path' }) : await dispatch([o.page], req, url, page, o.guards)
    }
    return undefined
  }

  /**
   * The web vault on the board's own server (core/vault.ts, server/vault-proxy.ts): with a live
   * login only (a page asked for without one goes to the board's, which signs in), never its admin
   * page, a new account only while the vault has none, and its notifications' WebSocket from the
   * domain's own page; the rest to Vaultwarden as it came.
   */
  async function vault(
    req: Request,
    url: URL,
    here: Site,
    who: Who,
    cookie: string | null,
    srv?: Server,
  ): Promise<Response> {
    const gate = o.vault as VaultGate
    const raw = url.pathname
    const token = loginToken(cookie)
    const login = token ? o.access.verify(token) : null
    if (!token || !login) {
      if (req.method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html'))
        return clearedFor(new Response(null, { status: 303, headers: { location: '/' } }), cookie)
      return clearedFor(json(401, { error: 'login' }), cookie)
    }
    const path = decoded(raw)
    if (path === null) return json(400, { error: 'path' })
    const port = gate.port()
    if (port === null || vaultAdminPath(raw) || vaultAdminPath(path)) return NOT_FOUND()
    const ca = gate.ca()
    if (!ca) return json(502, { error: 'vault' })
    if ((vaultRegisterPath(raw) || vaultRegisterPath(path)) && !gate.signupsOpen())
      return json(403, { error: 'signups' })
    if (raw === '/vault') return new Response(null, { status: 308, headers: { location: `/vault/${url.search}` } })
    const to = { port, ca, domain: here.domain, address: who.address, cookie: LOGIN_COOKIE }
    if ((req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') {
      if (req.method !== 'GET' || !vaultSocketPath(raw) || !srv || !o.websocket) return json(400, { error: 'upgrade' })
      if (req.headers.get('origin') !== here.origin) return json(403, { error: 'origin' })
      const data = {
        vault: { url: `wss://127.0.0.1:${port}${raw}${url.search}`, headers: socketHeaders(req, to), ca },
        watch: (gone: () => void) => o.access.watch(login.id, gone),
      }
      return srv.upgrade(req, { data }) ? new Response(null, { status: 200 }) : json(400, { error: 'upgrade' })
    }
    const res = await vaultAnswer(req, url, to)
    if (req.method === 'POST' && res.ok && (vaultRegisterPath(raw) || vaultRegisterPath(path))) gate.registered()
    return res
  }

  async function answer(req: Request, srv?: Server): Promise<Response> {
    // The site as this request found it, should a sync change it meanwhile.
    const here = site
    const host = (req.headers.get('host') ?? '').toLowerCase()
    if (!here.domain || !here.hosts.includes(host)) return json(403, { error: 'host' })
    if (req.headers.get('x-forwarded-proto') !== 'https') return json(403, { error: 'https' })
    const { domain, origin } = here
    // A browser sends the cookie by itself: what changes anything must come from the board's own page;
    // the web vault's calls (server mode) from the domain's own Origin, which sends no X-Board.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const vaultCall = here.setup && o.vault?.port() != null && vaultPath(pathOf(req.url))
      if ((!vaultCall && req.headers.get('x-board') !== '1') || req.headers.get('origin') !== origin)
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
      if (here.setup) {
        const gate = await setupGate(req, raw, who, cookie)
        if (gate) return gate
      }
      if (here.setup && o.vault?.port() != null && vaultPath(raw)) return await vault(req, url, here, who, cookie, srv)
      const pub = await open(req, url, here, who, cookie)
      if (pub) return pub
      const token = loginToken(cookie)
      const login = token ? o.access.verify(token) : null
      if (!token || !login) return clearedFor(json(401, { error: 'login' }), cookie)
      signedIn = true
      const path = decoded(raw)
      if (path === null) return json(400, { error: 'path' })
      if (NOT_HERE.test(raw) || NOT_HERE.test(path)) return json(404, { error: 'not found' })
      // On the board's own server this login is the way in, its page the owner's own: the secrets,
      // Backup… and Time tracking… there; through a PC's tunnel not.
      const refused = remoteRefusal(raw, path, { ownServer: mode() !== null })
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
        // in server mode: a WebSocket that ends with this login
        here.setup && o.websocket && srv
          ? (data, headers) =>
              srv.upgrade(req, {
                data: { ...data, watch: (gone: () => void) => o.access.watch(login.id, gone) },
                ...(headers && { headers }),
              })
          : undefined,
      )
      return endsWhenGone(res, gone => o.access.watch(login.id, gone), { 'x-accel-buffering': 'no' })
    } catch (err) {
      // The path only: a query can carry the page's file token.
      o.log(`${here.setup ? 'server mode' : 'tunnel'} ${req.method} ${url ? url.pathname : ''}: ${messageOf(err)}`)
      // Before a login, nothing of this computer goes out, a path in an error neither.
      return json(500, { error: signedIn ? messageOf(err) : 'server' })
    }
  }

  async function stop(): Promise<void> {
    const s = server
    const path = boundSocket
    server = null
    bound = null
    boundSocket = null
    if (s) await s.stop(true)
    if (path) removeSocket(path)
    if (atExit) process.off('exit', atExit)
    atExit = null
  }

  /** Listens on the server mode's socket, mode 0660, a stale one removed first. */
  function listenSocket(path: string): void {
    try {
      clearStale(path)
      server = Bun.serve({
        unix: path,
        // No idle timeout, as on the port: Bun takes it on a socket too, though its types give it to a port only.
        ...NO_IDLE_TIMEOUT,
        development: false,
        fetch: async (req, srv) => unframed(await answer(req, srv)),
        ...(o.websocket && { websocket: o.websocket }),
      } as Parameters<typeof Bun.serve>[0]) as Server
      boundSocket = path
      // Also when the process exits without close(): run.ts restarts the board by process.exit(75).
      atExit = () => removeSocket(path)
      process.on('exit', atExit)
      chmodSync(path, SOCKET_MODE)
      error = null
      o.log(`server mode: listening on ${path} for ${site.origin}/`)
    } catch (err) {
      // A socket it could not give its mode is no socket to keep.
      if (server) void stop()
      const next = `Cannot listen on ${path}: ${messageOf(err)}`
      if (next !== error) o.log(`server mode: ${next}`)
      error = next
    }
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

  /** In server mode: on its socket while its settings check out; else nothing listens, and the first problem is logged once. */
  async function syncServer(s: ServerMode): Promise<void> {
    const problem = serverModeProblems(s)[0]
    if (problem) {
      if (server) await stop()
      const next = `serverMode.${problem.field}: ${problem.message}`
      if (next !== error) o.log(`server mode: ${next}`)
      error = next
      return
    }
    site = { domain: s.domain, hosts: serverHosts(s), origin: serverOrigin(s), setup: true }
    if (server && boundSocket === s.socket) return
    if (server) await stop()
    listenSocket(s.socket)
  }

  async function syncNow(): Promise<void> {
    if (closed) return
    const where = (): string => `${bound}|${boundSocket}`
    const before = where()
    try {
      const s = mode()
      if (s) {
        // From the tunnel's port to the socket, should the config change so.
        if (bound !== null) await stop()
        await syncServer(s)
      } else if (!wanted()) {
        if (server) await stop()
        error = null
      } else {
        const c = conf()
        site = { domain: c.domain, hosts: publicHosts(c), origin: publicOrigin(c), setup: false }
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
    if (where() !== before) o.onChange()
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
    socket: () => boundSocket,
    async close() {
      closed = true
      clearInterval(timer)
      await syncing
      await stop()
    },
  }
}
