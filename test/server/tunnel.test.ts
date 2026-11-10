// The board through the owner's domain (server/tunnel.ts): its tunnel listener on 127.0.0.1, with
// requests shaped as Caddy forwards them (test/support/tunnel-board.ts). A login for every board
// route, in any spelling; without one only the page, a reduced hello, the login routes and the
// probe; a login that ends or expires stops at once, its open streams too.
import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { Passkey } from '../../src/core/access.ts'
import { REMOTE_API } from '../../src/core/remote.ts'
import { base32Bytes, totpCode, totpStep } from '../../src/core/totp.ts'
import { verifyRegistration } from '../../src/core/webauthn.ts'
import { logged, sharedSandbox } from '../support/board-server.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { type SoftAuthenticator, softAuthenticator } from '../support/soft-authenticator.ts'
import {
  DOMAIN,
  ORIGIN,
  PASSWORD,
  routeTable,
  SAMPLES,
  SECRET_B32,
  seedAccess,
  seededLogin,
  startTunnelBoard,
  stateFolder,
  USER_ID,
  viaCaddy,
  writeState,
} from '../support/tunnel-board.ts'

const COOKIE = '__Host-board-login'
const LOGIN_SET = /^__Host-board-login=[\w-]{43}; Path=\/; Max-Age=259200\d; Secure; HttpOnly; SameSite=Strict$/
const CLEARED = /^__Host-board-login=; Path=\/; Max-Age=0; Secure; HttpOnly; SameSite=Strict$/
const SECRET = base32Bytes(SECRET_B32) ?? new Uint8Array()
// Logins seeded with known tokens: no test waits for a TOTP step.
const SEEDED = 'S'.repeat(43)
const OUT = 'O'.repeat(43)
const OLD = 'X'.repeat(43)
const ADDER = 'A'.repeat(43)
const EXPIRING = 'E'.repeat(43)

const cookieOf = (res: Response): string => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
const answer = async (res: Response | Promise<Response>): Promise<[number, unknown]> => {
  const r = await res
  return [r.status, await r.json()]
}

/** A route's raw path from the table: the page's for `^`, its sample for another RegExp. */
const rawOf = (path: string): string => (path.startsWith('^') ? (path === '^' ? '/' : (SAMPLES[path] as string)) : path)

/** The current code, as an authenticator app shows it. */
const codeNow = (): string => totpCode(SECRET, totpStep(Date.now()))

/** A code that is none of the ones accepted now (a step either way). */
function wrongCode(): string {
  const step = totpStep(Date.now())
  const right = new Set([-1, 0, 1, 2].map(d => totpCode(SECRET, step + d)))
  return ['000000', '111111', '222222', '333333', '444444'].find(c => !right.has(c)) ?? '555555'
}

/** `auth`'s passkey as access-passkeys.json keeps it, its registration checked as the board would. */
function seededPasskey(auth: SoftAuthenticator): Passkey {
  const challenge = 'c'.repeat(43)
  const registration = auth.register({ challenge, origin: ORIGIN, rpId: DOMAIN })
  const checked = verifyRegistration(registration.response, { challenge, origin: ORIGIN, rpId: DOMAIN })
  if (!checked.ok) throw new Error(`registration refused: ${checked.why}`)
  const { id, jwk, alg, counter } = checked.credential
  return { id, jwk, alg, counter, transports: ['internal'], label: 'Safari on iPad', addedAt: Date.now(), usedAt: null }
}

/** A passkey sign-in with `auth` through `tunnel`, from `address`. */
async function passkeySignIn(tunnel: string, auth: SoftAuthenticator, address?: string): Promise<Response> {
  const from = address ? { 'x-forwarded-for': address } : {}
  const caddy = viaCaddy(tunnel)
  const options = await caddy.post('/api/login/passkey/options', {}, from)
  expect(options.status).toBe(200)
  const { challenge } = (await options.json()) as { challenge: string }
  const assertion = auth.assert({ challenge, origin: ORIGIN, rpId: DOMAIN, userHandle: USER_ID })
  return caddy.post('/api/login/passkey', { ...assertion, type: 'public-key' }, from)
}

/** What a stream carries from here until it ends; it must end within `ms`. */
async function rest(reader: ReadableStreamDefaultReader<Uint8Array>, ms = 8000): Promise<string> {
  const decoder = new TextDecoder()
  let seen = ''
  const timeout = Bun.sleep(ms).then(() => null)
  for (;;) {
    const next = await Promise.race([reader.read(), timeout])
    if (next === null) throw new Error(`The stream did not end: ${seen}`)
    if (next.done) return seen
    seen += decoder.decode(next.value)
  }
}

/** The pane `s1` in the sandbox's fake herdr. */
function oneSession(box: Sandbox): void {
  const snapshot = {
    panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir }],
    tabs: [],
    workspaces: [],
  }
  box.state({ 'api snapshot': { result: { snapshot } } })
}

/**
 * A GET of `path` exactly as written, as Caddy could forward it: fetch would resolve `.` and `..`
 * first. Its status and body.
 */
function rawGet(port: number, path: string, cookie?: string): Promise<[number, unknown]> {
  const request = [
    `GET ${path} HTTP/1.1`,
    `Host: ${DOMAIN}`,
    'X-Forwarded-Proto: https',
    ...(cookie ? [`Cookie: ${cookie}`] : []),
    'Connection: close',
    '',
    '',
  ].join('\r\n')
  return new Promise((resolve, reject) => {
    let data = ''
    const socket = connect(port, '127.0.0.1', () => socket.write(request))
    socket.on('data', chunk => {
      data += chunk.toString()
    })
    socket.on('end', () => {
      const head = data.indexOf('\r\n\r\n')
      resolve([Number(data.split(' ')[1]), JSON.parse(data.slice(head + 4))])
    })
    socket.on('error', reject)
  })
}

/** Nothing takes a connection there. */
const refuses = (base: string): Promise<boolean> =>
  fetch(`${base}/api/hello`, { headers: { host: DOMAIN, 'x-forwarded-proto': 'https' } }).then(
    () => false,
    () => true,
  )

/**
 * A GET of the page's own files (not '/', /api/ or /uploads/), which the tunnel hands to the page
 * route with or without a login, as `tailscale serve`'s listener does: a table route there (the
 * Omarchy theme's stylesheet) is not reached, and its path is no file of the page's (404).
 */
const pageFile = (method: string, raw: string): boolean =>
  method === 'GET' && raw !== '/' && !raw.startsWith('/api/') && !raw.startsWith('/uploads/')

describe('the tunnel listener', () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let url = ''
  let tunnel = ''
  let tunnelPort = 0
  let auth: SoftAuthenticator
  let proc: Awaited<ReturnType<typeof startTunnelBoard>>['proc']
  let caddy: ReturnType<typeof viaCaddy>
  const as = (token: string) => viaCaddy(tunnel, `${COOKIE}=${token}`)

  beforeAll(async () => {
    box = await shared()
    oneSession(box)
    auth = await softAuthenticator(-7)
    await seedAccess(box, {
      logins: [{ token: SEEDED }, { token: OUT }, { token: OLD, expiresAt: Date.now() - 1000 }, { token: ADDER }],
      passkeys: [seededPasskey(auth)],
    })
    ;({ url, tunnel, tunnelPort, proc } = await startTunnelBoard(box, {}, { TEST_ROUTE_TABLE: '1' }))
    caddy = viaCaddy(tunnel)
  }, 30_000)

  test('it listens on 127.0.0.1 by the time the board is ready, and says so', async () => {
    expect(logged(proc, `tunnel: listening on 127.0.0.1:${tunnelPort} for https://board.example.com/`)).toBe(true)
    expect((await caddy.get('/api/hello')).status).toBe(200)
  })

  test('every route in the table answers 401 without a login: the page and hello aside', async () => {
    const table = routeTable(proc)
    // One raw path per RegExp route, by its source; a new route without one fails here first.
    const missing = table.filter(r => r.path.startsWith('^') && r.path !== '^' && !(r.path in SAMPLES))
    expect(missing).toEqual([])
    expect(table.length).toBeGreaterThan(30)
    for (const r of table) {
      const raw = rawOf(r.path)
      if (r.path.startsWith('^')) expect([raw, new RegExp(r.path).test(raw)]).toEqual([raw, true])
      for (const method of r.method === 'ANY' ? ['GET', 'POST'] : [r.method]) {
        const res = method === 'GET' ? await caddy.get(raw) : await caddy.post(raw, {})
        const open = method === 'GET' && (raw === '/' || raw === '/api/hello')
        expect([method, raw, res.status]).toEqual([method, raw, open ? 200 : pageFile(method, raw) ? 404 : 401])
        await res.body?.cancel()
      }
    }
  }, 30_000)

  test('a cookie whose login ended: every route but the page answers 401 and clears it, hello says signed out', async () => {
    const ended = as(OLD)
    for (const r of routeTable(proc)) {
      const raw = rawOf(r.path)
      for (const method of r.method === 'ANY' ? ['GET', 'POST'] : [r.method]) {
        const res = method === 'GET' ? await ended.get(raw) : await ended.post(raw, {})
        const page = method === 'GET' && raw === '/'
        const hello = method === 'GET' && raw === '/api/hello'
        const file = pageFile(method, raw)
        const cookie = CLEARED.test(res.headers.get('set-cookie') ?? '') ? 'cleared' : 'kept'
        expect([method, raw, res.status, cookie]).toEqual([
          method,
          raw,
          page || hello ? 200 : file ? 404 : 401,
          page || file ? 'kept' : 'cleared',
        ])
        if (hello) expect(await res.json()).toMatchObject({ signedIn: false })
        else await res.body?.cancel()
      }
    }
  }, 30_000)

  test('only what Caddy forwards for the domain, over HTTPS; writes from the board’s own page only', async () => {
    expect(await answer(caddy.get('/api/hello', { host: `127.0.0.1:${tunnelPort}` }))).toEqual([403, { error: 'host' }])
    expect(await answer(caddy.get('/api/hello', { host: `${DOMAIN}:8443` }))).toEqual([403, { error: 'host' }])
    expect(await answer(caddy.get('/api/hello', { host: '' }))).toEqual([403, { error: 'host' }])
    expect(await answer(caddy.get('/api/hello', { 'x-forwarded-proto': 'http' }))).toEqual([403, { error: 'https' }])
    expect(await answer(caddy.get('/api/hello', { 'x-forwarded-proto': '' }))).toEqual([403, { error: 'https' }])
    expect((await caddy.get('/api/hello', { host: `${DOMAIN}:443` })).status).toBe(200)
    expect((await caddy.get('/api/hello', { host: DOMAIN.toUpperCase() })).status).toBe(200)
    // A browser sends the cookie by itself: a write needs X-Board and the domain's Origin, present.
    for (const headers of [{ origin: '' }, { origin: 'https://evil.example' }, { origin: 'null' }, { 'x-board': '' }]) {
      expect(await answer(caddy.post('/api/login/password', { password: PASSWORD, code: '000000' }, headers))).toEqual([
        403,
        { error: 'origin' },
      ])
      expect(await answer(as(SEEDED).post('/api/session/s1/wake', {}, headers))).toEqual([403, { error: 'origin' }])
    }
    // Neither a header nor a cookie lets a request past the login.
    expect(
      (await caddy.get('/api/board', { 'x-board': '1', origin: ORIGIN, authorization: `Bearer ${SEEDED}` })).status,
    ).toBe(401)
  })

  test('hello before a login says no more than what the login screen needs', async () => {
    const res = await caddy.get('/api/hello')
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['board', 'api', 'auth', 'signedIn', 'language'])
    expect(body).toEqual({ board: 'agent-board', api: REMOTE_API, auth: 'login', signedIn: false, language: 'en' })
    expect(res.headers.get('set-cookie')).toBeNull()
    const mine = await as(SEEDED).get('/api/hello')
    expect(await mine.json()).toEqual({ ...body, signedIn: true })
    expect(mine.headers.get('set-cookie')).toBeNull()
  })

  test('the probe answers no nonce the board did not issue', async () => {
    expect((await caddy.get('/api/probe/0123456789abcdef0123456789abcdef')).status).toBe(404)
    expect((await caddy.get('/api/probe/x')).status).toBe(404)
  })

  test('the page and its files without a login, marked remote; never in a frame', async () => {
    for (const path of [
      '/',
      '/app.js',
      '/theme.js',
      '/styles/pwa.css',
      '/manifest.webmanifest',
      '/sw.js',
      '/icon.svg',
    ]) {
      const res = await caddy.get(path)
      expect([path, res.status]).toEqual([path, 200])
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      await res.body?.cancel()
    }
    const page = await caddy.get('/')
    expect(await page.text()).toContain('<html data-remote')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
    const hello = await caddy.get('/api/hello')
    expect(hello.headers.get('x-frame-options')).toBe('DENY')
    expect(hello.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
    // An API path spelled another way is no page and no route.
    const encoded = await caddy.get('/%61pi/board')
    expect(encoded.status).toBe(404)
    expect(await encoded.text()).not.toContain('items')
  })

  test('before a login, another method or spelling of a board route is 401; no spelling reaches a file outside the page', async () => {
    // HEAD is a read as GET is: no X-Board or Origin, and still a login.
    const head = await caddy.send('HEAD', '/api/board', undefined, { 'x-board': '', origin: '' })
    expect(head.status).toBe(401)
    for (const method of ['OPTIONS', 'PUT'])
      expect([method, ...(await answer(caddy.send(method, '/api/board')))]).toEqual([method, 401, { error: 'login' }])
    // fetch resolves `..` as a browser does; `//` and the trailing slash reach the board as written.
    for (const path of ['//api/board', '/api/board/', '/api/x/../board'])
      expect([path, ...(await answer(caddy.get(path)))]).toEqual([path, 401, { error: 'login' }])
    // The same, as written: the listener resolves them itself.
    for (const path of ['/api/x/../board', '/api/./board', '/%2e%2e/api/board'])
      expect([path, ...(await rawGet(tunnelPort, path))]).toEqual([path, 401, { error: 'login' }])
    for (const path of [
      '/%75ploads/2026-10-20/a.png',
      '/..%2fpackage.json',
      '/styles/..%2f..%2fpackage.json',
      '/%5c..%5cpackage.json',
    ])
      expect([path, ...(await answer(caddy.get(path)))]).toEqual([path, 404, { error: 'not found' }])
  })

  test('a sign-in with the password and the code: a login cookie of 30 days, then the board', async () => {
    const res = await caddy.post('/api/login/password', { password: PASSWORD, code: codeNow() })
    expect(await res.json()).toEqual({ ok: true, method: 'password' })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toMatch(LOGIN_SET)
    const mine = viaCaddy(tunnel, cookieOf(res))
    const board = await mine.get('/api/board')
    expect(board.status).toBe(200)
    expect(((await board.json()) as { items: { key: string }[] }).items.map(i => i.key)).toEqual(['s1'])
    expect(await (await mine.get('/api/hello')).json()).toMatchObject({ signedIn: true })
  })

  test("with a login: what acts on the computer's screen and what is local only are refused in every spelling", async () => {
    const me = as(SEEDED)
    for (const path of ['/api/open-url', '/api/open%2Durl', '/api/fs/open', '/api/fs/%6Fpen', '/api/session/s1/focus'])
      expect([path, ...(await answer(me.post(path, { url: 'https://example.com', path: '/' })))]).toEqual([
        path,
        403,
        { error: 'desktop' },
      ])
    for (const path of [
      '/api/access',
      '/api/%61ccess',
      '/api/access/',
      '/api/./access',
      '/api/%61ccess/',
      '/api/remote',
      '/api/remote%2Fx',
      '/api/%72emote/x',
      '/api/wake',
      '/api/wak%65',
      '/api/team',
      '/api/team/',
      '/api/team/thread/x',
      '/api/%74eam/send',
      '/api/backup',
      '/api/%62ackup',
      '/api/./backup',
      '/api/time-settings',
      '/api/time-%73ettings',
    ]) {
      expect([path, ...(await answer(me.get(path)))]).toEqual([path, 403, { error: 'local' }])
      expect([path, ...(await answer(me.post(path, { op: 'off' })))]).toEqual([path, 403, { error: 'local' }])
    }
    // fetch resolves `.` itself: as written too.
    for (const path of [
      '/api/./access',
      '/api/x/../access/',
      '/api/./backup',
      '/api/x/../backup/',
      '/api/./team',
      '/api/x/../team/',
    ])
      expect([path, ...(await rawGet(tunnelPort, path, `${COOKIE}=${SEEDED}`))]).toEqual([
        path,
        403,
        { error: 'local' },
      ])
    expect((await me.get('/api/peers')).status).toBe(404)
    expect((await me.post('/api/remote/pair', { name: 'x' })).status).toBe(404)
    expect((await me.get('/api/remote/pair/abc')).status).toBe(404)
    expect(await answer(me.get('/api/%zz'))).toEqual([400, { error: 'path' }])
    // The routes' own Origin guard takes the domain's.
    const permit = await me.post('/api/session/s1/permit', { allow: true })
    expect(await permit.json()).not.toEqual({ error: 'origin' })
    expect(permit.status).not.toBe(404)
  })

  test('signing out ends its open stream with a word for the page; its cookie then gets 401 and is cleared', async () => {
    const out = as(OUT)
    const events = await out.get('/api/events')
    expect(events.status).toBe(200)
    expect(events.headers.get('x-accel-buffering')).toBe('no')
    const reader = (events.body as ReadableStream<Uint8Array>).getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: ')
    const bye = await out.post('/api/logout', {})
    expect(await bye.json()).toEqual({ ok: true })
    expect(bye.headers.get('set-cookie')).toMatch(CLEARED)
    expect(await rest(reader)).toContain('event: unpaired')
    const after = await out.get('/api/board')
    expect(await after.json()).toEqual({ error: 'login' })
    expect(after.status).toBe(401)
    expect(after.headers.get('set-cookie')).toMatch(CLEARED)
    const hello = await out.get('/api/hello')
    expect(await hello.json()).toMatchObject({ signedIn: false })
    expect(hello.headers.get('set-cookie')).toMatch(CLEARED)
    // Signing out needs a login of its own.
    expect((await caddy.post('/api/logout', {})).status).toBe(401)
  })

  test('a login past its 30 days, or a cookie that is no login, gets 401 and the cookie cleared', async () => {
    for (const token of [OLD, 'N'.repeat(43), 'short']) {
      const res = await as(token).get('/api/board')
      expect([token, res.status]).toEqual([token, 401])
      expect(res.headers.get('set-cookie')).toMatch(CLEARED)
    }
    const hello = await as(OLD).get('/api/hello')
    expect(await hello.json()).toMatchObject({ signedIn: false })
    expect(hello.headers.get('set-cookie')).toMatch(CLEARED)
    // No cookie at all: nothing to clear.
    expect((await caddy.get('/api/board')).headers.get('set-cookie')).toBeNull()
  })

  test('a login that expires while its stream is open ends the stream with a word for the page', async () => {
    const file = join(stateFolder(box), 'access-logins.json')
    const logins = JSON.parse(readFileSync(file, 'utf8')) as unknown[]
    writeState(box, 'access-logins.json', [...logins, seededLogin({ token: EXPIRING, expiresAt: Date.now() + 1500 })])
    const events = await as(EXPIRING).get('/api/events')
    expect(events.status).toBe(200)
    const reader = (events.body as ReadableStream<Uint8Array>).getReader()
    expect(await rest(reader)).toContain('event: unpaired')
    const after = await as(EXPIRING).get('/api/board')
    expect(after.status).toBe(401)
    expect(after.headers.get('set-cookie')).toMatch(CLEARED)
  }, 15_000)

  test('a seeded passkey signs in: options, the assertion, a login cookie', async () => {
    const options = await caddy.post('/api/login/passkey/options', {})
    expect(await options.json()).toEqual({
      challenge: expect.stringMatching(/^[\w-]{43}$/),
      rpId: DOMAIN,
      timeout: 120_000,
      userVerification: 'required',
    })
    const res = await passkeySignIn(tunnel, auth)
    expect(await res.json()).toEqual({ ok: true, method: 'passkey' })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toMatch(LOGIN_SET)
    expect((await viaCaddy(tunnel, cookieOf(res)).get('/api/board')).status).toBe(200)
    // Another authenticator's passkey is none of the board's.
    const stranger = await passkeySignIn(tunnel, await softAuthenticator(-7))
    expect(await answer(stranger)).toEqual([401, { ok: false, error: 'wrong' }])
    expect(stranger.headers.get('set-cookie')).toBeNull()
  })

  test('adding a passkey asks a login for a fresh code', async () => {
    expect((await caddy.post('/api/login/passkey/add/options', { code: wrongCode() })).status).toBe(401)
    expect(await answer(as(ADDER).post('/api/login/passkey/add/options', { code: wrongCode() }))).toEqual([
      403,
      { ok: false, error: 'code' },
    ])
    expect(await answer(as(ADDER).post('/api/login/passkey/add', {}))).toEqual([400, { ok: false, error: 'shape' }])
  })

  test('a login route’s body that is no JSON, or over 192 KB, is 400 and no line in the log', async () => {
    const from = proc.messages.length
    const tooLarge = JSON.stringify({ password: 'x'.repeat(200 << 10), code: '000000' })
    for (const text of ['{bad', tooLarge]) {
      const size = text.length
      for (const path of ['/api/login/password', '/api/login/passkey'])
        expect([path, size, ...(await answer(caddy.send('POST', path, text)))]).toEqual([
          path,
          size,
          400,
          { ok: false, error: 'shape' },
        ])
      for (const path of ['/api/login/passkey/add/options', '/api/login/passkey/add'])
        expect([path, size, ...(await answer(as(ADDER).send('POST', path, text)))]).toEqual([
          path,
          size,
          400,
          { ok: false, error: 'shape' },
        ])
    }
    // A line the board logs after them: one of theirs would come before it.
    expect((await as(SEEDED).post('/api/log', { text: 'after the bad bodies' })).status).toBe(200)
    await until(() => logged(proc, 'page: after the bad bodies'))
    const lines = proc.messages.slice(from).map(m => (m as { log?: string }).log ?? '')
    expect(lines.filter(line => line.startsWith('tunnel'))).toEqual([])
  })

  test('the web board on 127.0.0.1 is as it was: its full hello, and no login', async () => {
    const hello = (await (await fetch(`${url}/api/hello`)).json()) as Record<string, unknown>
    expect(hello).toMatchObject({ board: 'agent-board', version: expect.any(String), platform: process.platform })
    expect(hello.host).toEqual(expect.any(String))
    expect(hello).not.toHaveProperty('auth')
    const board = await fetch(`${url}/api/board`)
    expect(board.status).toBe(200)
    expect(board.headers.get('x-frame-options')).toBeNull()
  })
})

describe('the lockout and the rate limits, through the tunnel', () => {
  const shared = sharedSandbox()
  let tunnel = ''
  let auth: SoftAuthenticator

  beforeAll(async () => {
    const box = await shared()
    auth = await softAuthenticator(-7)
    await seedAccess(box, { passkeys: [seededPasskey(auth)] })
    ;({ tunnel } = await startTunnelBoard(box))
  }, 30_000)

  test('locked after 5 wrong sign-ins, across addresses; limited per address; a passkey still signs in', async () => {
    const caddy = viaCaddy(tunnel)
    const wrong = { password: 'not the password', code: '000000' }
    const statuses: number[] = []
    let last: Response | null = null
    for (let i = 0; i < 11; i++) {
      last = await caddy.post('/api/login/password', wrong)
      statuses.push(last.status)
      if (i === 0) expect(await last.clone().json()).toEqual({ ok: false, error: 'wrong' })
      if (i === 5) {
        const locked = (await last.clone().json()) as { ok: boolean; error: string; until: number }
        expect(locked).toEqual({ ok: false, error: 'locked', until: expect.any(Number) })
        // ms since the epoch, a minute or so ahead
        expect(locked.until).toBeGreaterThan(Date.now() + 30_000)
        expect(locked.until).toBeLessThan(Date.now() + 120_000)
      }
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 423, 423, 423, 423, 423, 429])
    expect(await last?.json()).toEqual({ ok: false, error: 'limited' })
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0)
    // The lockout is the board's, not the address's.
    const other = await caddy.post('/api/login/password', wrong, { 'x-forwarded-for': '203.0.113.10' })
    expect(other.status).toBe(423)
    // The right password and code are locked out too.
    expect(
      (
        await caddy.post(
          '/api/login/password',
          { password: PASSWORD, code: codeNow() },
          { 'x-forwarded-for': '203.0.113.11' },
        )
      ).status,
    ).toBe(423)
    // A passkey is never locked out, and has counters of its own.
    const res = await passkeySignIn(tunnel, auth, '203.0.113.9')
    expect(await res.json()).toEqual({ ok: true, method: 'passkey' })
    expect(res.headers.get('set-cookie')).toMatch(LOGIN_SET)
  }, 30_000)
})

describe('the domain on another public port (tunnel.publicPort)', () => {
  const shared = sharedSandbox()
  let tunnel = ''
  let tunnelPort = 0
  let auth: SoftAuthenticator
  let proc: Awaited<ReturnType<typeof startTunnelBoard>>['proc']
  const HOST = `${DOMAIN}:8443`
  const AT = `${ORIGIN}:8443`
  /** As Caddy forwards a request to https://board.example.com:8443 from the board's own page there. */
  const at8443 = { host: HOST, origin: AT }

  beforeAll(async () => {
    const box = await shared()
    oneSession(box)
    auth = await softAuthenticator(-7)
    // The passkey was registered through the domain on 443, before the port moved.
    await seedAccess(box, { logins: [{ token: SEEDED }], passkeys: [seededPasskey(auth)] })
    ;({ tunnel, tunnelPort, proc } = await startTunnelBoard(box, { tunnel: { publicPort: 8443 } }))
  }, 30_000)

  test('the domain with that port as Host and Origin reaches hello, and a board route after login', async () => {
    expect(logged(proc, `tunnel: listening on 127.0.0.1:${tunnelPort} for https://board.example.com:8443/`)).toBe(true)
    const caddy = viaCaddy(tunnel)
    expect(await answer(caddy.get('/api/hello', at8443))).toEqual([
      200,
      { board: 'agent-board', api: REMOTE_API, auth: 'login', signedIn: false, language: 'en' },
    ])
    const me = viaCaddy(tunnel, `${COOKIE}=${SEEDED}`)
    const board = await me.get('/api/board', at8443)
    expect(board.status).toBe(200)
    // The board's own answer (its sessions may not be read yet this early).
    expect((await board.json()) as Record<string, unknown>).toHaveProperty('items', expect.any(Array))
    // A write from the board's own page there passes the listener's Origin check and the route's own.
    const permit = await me.post('/api/session/s1/permit', { allow: true }, at8443)
    expect(await permit.json()).not.toEqual({ error: 'origin' })
    expect(permit.status).not.toBe(403)
  })

  test('the domain without that port is another site: Host 403, Origin 403', async () => {
    const caddy = viaCaddy(tunnel)
    for (const host of [DOMAIN, `${DOMAIN}:443`, `${DOMAIN}:8444`, `127.0.0.1:${tunnelPort}`])
      expect([host, ...(await answer(caddy.get('/api/hello', { host })))]).toEqual([host, 403, { error: 'host' }])
    const me = viaCaddy(tunnel, `${COOKIE}=${SEEDED}`)
    for (const origin of [ORIGIN, `${ORIGIN}:443`, `http://${HOST}`]) {
      const headers = { host: HOST, origin }
      expect([origin, ...(await answer(me.post('/api/session/s1/permit', { allow: true }, headers)))]).toEqual([
        origin,
        403,
        { error: 'origin' },
      ])
      expect([
        origin,
        ...(await answer(caddy.post('/api/login/password', { password: PASSWORD, code: '000000' }, headers))),
      ]).toEqual([origin, 403, { error: 'origin' }])
    }
  })

  test('a passkey registered through the domain on 443 signs in through :8443; the origin it signs for is the one with the port', async () => {
    const caddy = viaCaddy(tunnel)
    const challengeOf = async (): Promise<string> => {
      const options = await caddy.post('/api/login/passkey/options', {}, at8443)
      const body = (await options.json()) as { challenge: string; rpId: string }
      // The relying party stays the domain, so passkeys survive the port.
      expect(body.rpId).toBe(DOMAIN)
      return body.challenge
    }
    const old = auth.assert({ challenge: await challengeOf(), origin: ORIGIN, rpId: DOMAIN, userHandle: USER_ID })
    const refused = await caddy.post('/api/login/passkey', { ...old, type: 'public-key' }, at8443)
    expect(refused.status).toBe(401)
    expect(refused.headers.get('set-cookie')).toBeNull()
    const assertion = auth.assert({ challenge: await challengeOf(), origin: AT, rpId: DOMAIN, userHandle: USER_ID })
    const res = await caddy.post('/api/login/passkey', { ...assertion, type: 'public-key' }, at8443)
    expect(await res.json()).toEqual({ ok: true, method: 'passkey' })
    expect(res.headers.get('set-cookie')).toMatch(LOGIN_SET)
    expect((await viaCaddy(tunnel, cookieOf(res)).get('/api/board', at8443)).status).toBe(200)
  })
})

// The listener listens before the board says it is ready (the first test above): nothing there by then is nothing at all.
describe('nothing listens unless the tunnel is on, its settings check out and the login is set up', () => {
  test('no login set up', async () => {
    const box = await sandbox()
    const { tunnel, proc } = await startTunnelBoard(box)
    expect(await refuses(tunnel)).toBe(true)
    expect(logged(proc, 'tunnel:')).toBe(false)
  }, 30_000)

  test('the tunnel off', async () => {
    const box = await sandbox()
    await seedAccess(box)
    const { tunnel, proc } = await startTunnelBoard(box, { tunnel: { on: false } })
    expect(await refuses(tunnel)).toBe(true)
    expect(logged(proc, 'tunnel:')).toBe(false)
  }, 30_000)

  test('a field that would reach ssh as an option', async () => {
    const box = await sandbox()
    await seedAccess(box)
    const { tunnel, proc } = await startTunnelBoard(box, { tunnel: { host: '-oX' } })
    expect(await refuses(tunnel)).toBe(true)
    expect(logged(proc, 'tunnel:')).toBe(false)
  }, 30_000)
})
