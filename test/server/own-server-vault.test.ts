// The owner's password vault on the board's own server (core/vault.ts, server/vault-proxy.ts), the
// board in a process of its own and a Vaultwarden of the test's own on 127.0.0.1: through the
// domain only with the board's login (a page asked for without one goes to the board's, the rest
// 401, nothing reaching Vaultwarden), the web vault's calls from the domain's own Origin without
// X-Board, the board's login cookie never passed on, the caller's address in X-Real-IP, the admin
// page never, a new account only while the vault has none, and its notifications' WebSocket with
// the login; the local key's port refuses all of it and the owner's answers, and the agent's own
// calls take the key only. A PC's tunnel and a phone refuse it in every spelling, and a board
// with no `vault` in config.json goes on as before.
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOGIN_COOKIE } from '../../src/core/access.ts'
import { remoteRefusal } from '../../src/server/streams.ts'
import { vaultAnswer } from '../../src/server/vault-proxy.ts'
import { sharedSandbox } from '../support/board-server.ts'
import { startOwnServer, viaSocket } from '../support/own-server.ts'
import type { Sandbox } from '../support/sandbox.ts'
import { CALLER, DOMAIN, ORIGIN, seedAccess, startTunnelBoard, stateFolder, viaCaddy } from '../support/tunnel-board.ts'

const TOKEN = 'v'.repeat(43)
const COOKIE = `${LOGIN_COOKIE}=${TOKEN}`

const answer = async (res: Response | Promise<Response>): Promise<[number, unknown]> => {
  const r = await res
  const text = await r.text()
  try {
    return [r.status, JSON.parse(text)]
  } catch {
    return [r.status, text]
  }
}

/** A GET through the socket as Caddy forwards it, its redirect not followed. */
const getRaw = (socket: string, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`http://${DOMAIN}${path}`, {
    unix: socket,
    redirect: 'manual',
    headers: { host: DOMAIN, 'x-forwarded-proto': 'https', 'x-forwarded-for': CALLER, ...headers },
  })

/** What Vaultwarden (the test's) was asked: method, path with query, headers, body. */
interface Seen {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

/** The stand-in Vaultwarden's own certificate for 127.0.0.1 (test/fixtures/vault-tls), which the board pins. */
const TLS_DIR = join(import.meta.dir, '..', 'fixtures', 'vault-tls')
const CERT = join(TLS_DIR, 'cert.pem')

/** A Vaultwarden of the test's own, over TLS on 127.0.0.1: answers what it was asked, and echoes on its notifications' WebSocket. */
function fakeVaultwarden() {
  const seen: Seen[] = []
  const server = Bun.serve<{ query: string }>({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: readFileSync(CERT, 'utf8'), key: readFileSync(join(TLS_DIR, 'key.pem'), 'utf8') },
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/vault/notifications/hub' && srv.upgrade(req, { data: { query: url.search } }))
        return undefined as unknown as Response
      const body = await req.text()
      seen.push({ method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body })
      const res = Response.json({ vaultwarden: true, path: url.pathname })
      // Rocket's own once it has TLS: the domain's to say, not Vaultwarden's
      res.headers.set('strict-transport-security', 'max-age=31536000')
      res.headers.append('set-cookie', `${LOGIN_COOKIE}=forged; Path=/`)
      res.headers.append('set-cookie', 'VW=1; Path=/vault')
      return res
    },
    websocket: {
      message(ws, msg) {
        ws.send(`echo ${String(msg)} ${ws.data.query}`)
      },
    },
  })
  return { server, seen, port: server.port as number }
}

/** A WebSocket through the board's socket as Caddy forwards it: the status line, and what came back for `send`. */
async function socketThrough(
  socket: string,
  path: string,
  headers: Record<string, string>,
  send?: string,
): Promise<{ status: string; got: string }> {
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${DOMAIN}`,
    'X-Forwarded-Proto: https',
    `X-Forwarded-For: ${CALLER}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    '',
    '',
  ]
  let raw = Buffer.alloc(0)
  const { promise, resolve } = Promise.withResolvers<{ status: string; got: string }>()
  let sent = false
  const done = (): void => {
    const text = raw.toString('latin1')
    const status = text.split('\r\n')[0] ?? ''
    const at = text.indexOf('\r\n\r\n')
    const frame = at >= 0 ? raw.subarray(at + 4) : Buffer.alloc(0)
    // a server's text frame: unmasked, a short length
    const got = frame.length >= 2 ? frame.subarray(2, 2 + ((frame[1] ?? 0) & 0x7f)).toString('utf8') : ''
    resolve({ status, got })
  }
  const conn = await Bun.connect({
    unix: socket,
    socket: {
      data(s, chunk) {
        raw = Buffer.concat([raw, Buffer.from(chunk)])
        const text = raw.toString('latin1')
        if (!text.includes('\r\n\r\n')) return
        if (!text.startsWith('HTTP/1.1 101') || !send) {
          done()
          s.end()
          return
        }
        if (!sent) {
          sent = true
          // a client's text frame: masked
          const payload = Buffer.from(send)
          const mask = Buffer.from([1, 2, 3, 4])
          const masked = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] ?? 0)))
          s.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]))
          return
        }
        const after = raw.subarray(text.indexOf('\r\n\r\n') + 4)
        if (after.length >= 2 && after.length >= 2 + ((after[1] ?? 0) & 0x7f)) {
          done()
          s.end()
        }
      },
      close: () => done(),
    },
  })
  conn.write(lines.join('\r\n'))
  return Promise.race([promise, Bun.sleep(5000).then(() => ({ status: 'timeout', got: '' }))])
}

describe("the board's own server: the vault through the domain's login", () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let url = ''
  let socket = ''
  let key = ''
  let vw: ReturnType<typeof fakeVaultwarden>
  let data = ''
  let me: ReturnType<typeof viaSocket>
  let stranger: ReturnType<typeof viaSocket>

  beforeAll(async () => {
    box = await shared()
    vw = fakeVaultwarden()
    data = join(box.dir, 'vaultwarden')
    mkdirSync(data, { recursive: true })
    await seedAccess(box, { logins: [{ token: TOKEN }] })
    // no environment file: the board closes no signups here, and runs no systemctl
    const vault = { port: vw.port, data, env: join(box.dir, 'no.env'), bw: join(box.dir, 'no-bw'), cert: CERT }
    ;({ url, socket } = await startOwnServer(box, { vault }))
    me = viaSocket(socket, COOKIE)
    stranger = viaSocket(socket)
    key = readFileSync(join(stateFolder(box), 'local-key'), 'utf8').trim()
  }, 30_000)
  afterAll(() => vw.server.stop(true))

  test('without the login: a page goes to the board’s sign-in, the rest 401; Vaultwarden never asked', async () => {
    const page = await getRaw(socket, '/vault/', { accept: 'text/html,application/xhtml+xml' })
    expect([page.status, page.headers.get('location')]).toEqual([303, '/'])
    expect(await answer(stranger.get('/vault/api/sync'))).toEqual([401, { error: 'login' }])
    expect(await answer(stranger.get('/vault/'))).toEqual([401, { error: 'login' }])
    const token = viaSocket(socket, `${LOGIN_COOKIE}=${'x'.repeat(43)}`)
    const bad = await token.get('/vault/api/sync')
    expect(bad.status).toBe(401)
    expect(bad.headers.get('set-cookie')).toContain(`${LOGIN_COOKIE}=;`)
    const post = (headers: Record<string, string>) =>
      stranger.post('/vault/identity/connect/token', { grant_type: 'password' }, { 'x-board': '', ...headers })
    expect((await post({})).status).toBe(401)
    expect((await socketThrough(socket, '/vault/notifications/hub?access_token=t', { Origin: ORIGIN })).status).toBe(
      'HTTP/1.1 401 Unauthorized',
    )
    expect(vw.seen).toEqual([])
  })

  test('signed in: to Vaultwarden as it came, the board’s cookie never, the caller’s address; back as it comes', async () => {
    const res = await me.get('/vault/api/config?x=1', { cookie: `${COOKIE}; other=2`, authorization: 'Bearer vt' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ vaultwarden: true, path: '/vault/api/config' })
    // a cookie of the board's login's name never comes back from there; its own does
    expect(res.headers.getSetCookie()).toEqual(['VW=1; Path=/vault'])
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('strict-transport-security')).toBeNull()
    const s = vw.seen.at(-1) as Seen
    expect([s.method, s.path]).toEqual(['GET', '/vault/api/config?x=1'])
    expect(s.headers.cookie).toBe('other=2')
    expect(s.headers.authorization).toBe('Bearer vt')
    expect(s.headers.host).toBe(DOMAIN)
    expect(s.headers['x-real-ip']).toBe(CALLER)
    expect(s.headers['x-forwarded-proto']).toBe('https')
    expect(s.headers['accept-encoding']).toBe('identity')
    expect(JSON.stringify(s.headers)).not.toContain(TOKEN)
    const slash = await getRaw(socket, '/vault?y=2', { cookie: COOKIE })
    expect([slash.status, slash.headers.get('location')]).toEqual([308, '/vault/?y=2'])
  })

  test('the web vault’s calls: from the domain’s Origin without X-Board; another Origin or none refused', async () => {
    const before = vw.seen.length
    const call = (headers: Record<string, string>) =>
      me.post('/vault/identity/connect/token', { grant_type: 'password' }, { 'x-board': '', ...headers })
    expect(await answer(call({}))).toEqual([200, { vaultwarden: true, path: '/vault/identity/connect/token' }])
    expect(vw.seen.at(-1)).toMatchObject({ method: 'POST', body: '{"grant_type":"password"}' })
    expect(await answer(call({ origin: 'https://evil.example' }))).toEqual([403, { error: 'origin' }])
    expect(await answer(call({ origin: '' }))).toEqual([403, { error: 'origin' }])
    expect(vw.seen.length).toBe(before + 1)
    // the board's own routes still want X-Board
    expect(await answer(me.post('/api/vault/lock', {}, { 'x-board': '' }))).toEqual([403, { error: 'origin' }])
  })

  test('the admin page never, in any spelling; Vaultwarden not asked', async () => {
    const before = vw.seen.length
    for (const path of ['/vault/admin', '/vault/admin/users', '/vault/%61dmin', '/vault/ADMIN'])
      expect([path, ...(await answer(me.get(path)))]).toEqual([path, 404, { error: 'not found' }])
    expect(vw.seen.length).toBe(before)
  })

  test('a new account while the vault has none; once it has one, refused by the board itself', async () => {
    const register = (p: string) => me.post(p, { email: 'owner@acme.test' }, { 'x-board': '' })
    expect((await register('/vault/identity/accounts/register/send-verification-email')).status).toBe(200)
    const db = new Database(join(data, 'db.sqlite3'))
    db.run('CREATE TABLE users (uuid TEXT, email TEXT, created_at TEXT)')
    db.run("INSERT INTO users VALUES ('u1', 'owner@acme.test', '2026-11-01')")
    db.close()
    // the board looks again after a register went through (services/vault.ts registered)
    await Bun.sleep(1800)
    const before = vw.seen.length
    for (const p of [
      '/vault/identity/accounts/register/finish',
      '/vault/identity/accounts/register',
      '/vault/api/accounts/register',
      '/vault/identity/accounts/%72egister/finish',
    ])
      expect([p, ...(await answer(register(p)))]).toEqual([p, 403, { error: 'signups' }])
    expect(vw.seen.length).toBe(before)
    // signing in still goes through
    expect((await me.post('/vault/identity/connect/token', {}, { 'x-board': '' })).status).toBe(200)
  })

  test('its notifications’ WebSocket: with the login and the domain’s Origin, both ways', async () => {
    const hub = '/vault/notifications/hub?access_token=vt'
    const ok = await socketThrough(socket, hub, { Origin: ORIGIN, Cookie: COOKIE }, 'hello')
    expect(ok).toEqual({ status: 'HTTP/1.1 101 Switching Protocols', got: 'echo hello ?access_token=vt' })
    expect((await socketThrough(socket, hub, { Origin: 'https://evil.example', Cookie: COOKIE })).status).toBe(
      'HTTP/1.1 403 Forbidden',
    )
    expect((await socketThrough(socket, '/vault/api/sync', { Origin: ORIGIN, Cookie: COOKIE })).status).toBe(
      'HTTP/1.1 400 Bad Request',
    )
  })

  test('Vaultwarden’s own certificate only: with another one pinned, nothing goes there', async () => {
    const before = vw.seen.length
    const url = new URL('https://board.example.com/vault/api/config')
    const to = { port: vw.port, domain: DOMAIN, address: CALLER, cookie: LOGIN_COOKIE }
    const other = readFileSync(join(TLS_DIR, 'other-cert.pem'), 'utf8')
    expect(await answer(vaultAnswer(new Request(url), url, { ...to, ca: other }))).toEqual([502, { error: 'vault' }])
    expect(vw.seen.length).toBe(before)
    expect((await vaultAnswer(new Request(url), url, { ...to, ca: readFileSync(CERT, 'utf8') })).status).toBe(200)
  })

  test('the payload says so: Settings → Passwords', async () => {
    const payload = (await (await me.get('/api/board')).json()) as { vault?: boolean; server?: boolean }
    expect([payload.server, payload.vault]).toEqual([true, true])
  })

  test('the owner’s answers through the domain’s login; the agent’s calls never there', async () => {
    expect(await answer(me.post('/api/vault/fill/0123456789ab', { op: 'decline' }))).toEqual([
      404,
      { ok: false, error: expect.stringContaining('no such login fill') },
    ])
    expect(await answer(me.post('/api/browser/login', { pane: 'p1' }))).toEqual([403, { error: 'key' }])
    expect((await stranger.post('/api/vault/fill/0123456789ab', { op: 'decline' })).status).toBe(401)
  })

  test('the local key’s port: the vault and the owner’s answers refused in every spelling; the agent’s calls with the key', async () => {
    const local = (path: string, init: RequestInit = {}) =>
      fetch(`${url}${path}`, { ...init, headers: { 'x-board-key': key, 'x-board': '1', ...(init.headers ?? {}) } })
    const before = vw.seen.length
    for (const path of ['/vault/', '/vault/api/sync', '/%76ault/', '/api/vault/lock', '/api/%76ault/lock'])
      expect([path, ...(await answer(local(path)))]).toEqual([path, 403, { error: 'local' }])
    for (const path of ['/api/vault/lock', '/api/vault/fill/0123456789ab'])
      expect([path, ...(await answer(local(path, { method: 'POST', body: '{"op":"decline"}' })))]).toEqual([
        path,
        403,
        { error: 'local' },
      ])
    expect(vw.seen.length).toBe(before)
    // the agent's: a session's pane with no browser running, asked with the key
    const [status, body] = await answer(
      local('/api/browser/login', { method: 'POST', body: JSON.stringify({ pane: 'p1', fields: ['password'] }) }),
    )
    expect([status, (body as { ok: boolean }).ok]).toEqual([409, false])
    expect(
      await answer(
        local('/api/browser/login', { method: 'POST', body: JSON.stringify({ pane: 'p1', fields: ['pin'] }) }),
      ),
    ).toEqual([400, { ok: false, error: expect.stringContaining('fields') }])
    expect(await answer(fetch(`${url}/api/browser/login`, { method: 'POST', body: '{"pane":"p1"}' }))).toEqual([
      403,
      { error: 'key' },
    ])
  })
})

describe('everywhere else: refused as the secrets are', () => {
  const SPELLINGS: [string, string][] = [
    ['/vault', '/vault'],
    ['/vault/', '/vault/'],
    ['/vault/api/sync', '/vault/api/sync'],
    ['/%76ault/', '/vault/'],
    ['/vault/notifications/hub', '/vault/notifications/hub'],
    ['/api/vault/lock', '/api/vault/lock'],
    ['/api/%76ault/fill/0123456789ab', '/api/vault/fill/0123456789ab'],
  ]

  test('remoteRefusal: a phone, a desk, a PC’s tunnel refuse it; the board’s own server’s login lets it by', async () => {
    for (const options of [undefined, {}, { desk: true }, { ownServer: false }])
      for (const [raw, path] of SPELLINGS) {
        const res = remoteRefusal(raw, path, options)
        expect([raw, options, res?.status, await res?.json()]).toEqual([raw, options, 403, { error: 'local' }])
      }
    for (const [raw, path] of SPELLINGS)
      expect([raw, remoteRefusal(raw, path, { ownServer: true })]).toEqual([raw, null])
    // what was refused before still is, and what was not, is not
    expect(remoteRefusal('/vaultx', '/vaultx')).toBeNull()
    expect(remoteRefusal('/api/board', '/api/board')).toBeNull()
  })

  describe('a board on a PC with `vault` in its config.json', () => {
    const shared = sharedSandbox()
    let box: Sandbox
    let url = ''
    let tunnel = ''
    let vw: ReturnType<typeof fakeVaultwarden>

    beforeAll(async () => {
      box = await shared()
      vw = fakeVaultwarden()
      await seedAccess(box, { logins: [{ token: TOKEN }] })
      ;({ url, tunnel } = await startTunnelBoard(box, { vault: { port: vw.port, data: box.dir } }))
    }, 30_000)
    afterAll(() => vw.server.stop(true))

    test('its tunnel, signed in: /vault and /api/vault refused; the local page has no vault; Vaultwarden never asked', async () => {
      const mine = viaCaddy(tunnel, COOKIE)
      expect((await mine.get('/api/board')).status).toBe(200)
      const strangers = viaCaddy(tunnel)
      for (const [raw] of SPELLINGS) {
        expect([raw, ...(await answer(mine.get(raw)))]).toEqual([raw, 403, { error: 'local' }])
        expect([raw, ...(await answer(mine.post(raw, {})))]).toEqual([raw, 403, { error: 'local' }])
        expect([raw, (await strangers.get(raw)).status]).toEqual([raw, 401])
      }
      const payload = (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
      expect([payload.server, payload.vault]).toEqual([undefined, undefined])
      // no route of the vault's on a PC: as any path the board does not know
      expect((await fetch(`${url}/api/vault/lock`, { method: 'POST', headers: { 'x-board': '1' } })).status).toBe(405)
      expect(vw.seen).toEqual([])
    })
  })
})
