// The board on its own server (core/on-server.ts): its login listener on a Unix socket, started by
// itself, and the first login through the one-time link (services/first-login.ts, `board login`),
// with requests shaped as Caddy forwards them from the domain (test/support/own-server.ts). Before
// the login is set only the setup page answers; the code works once, lives as its hash only and
// is never logged; once the login is set the setup is closed. The web board's own port is as ever.
// What only a PC has is hidden; a board without `serverMode` is as before.
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { base32Bytes, totpCode, totpStep } from '../../src/core/totp.ts'
import { hashToken } from '../../src/services/remote.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'
import { board, startOwnServer, viaSocket, writeConfig } from '../support/own-server.ts'
import { type Child, type Sandbox, sandbox } from '../support/sandbox.ts'
import { DOMAIN, ORIGIN, PASSWORD, routeTable, SAMPLES, stateFolder, writeState } from '../support/tunnel-board.ts'

const LINK = /^https:\/\/board\.example\.com\/setup#code=([\w-]{32})\n$/

const answer = async (res: Response | Promise<Response>): Promise<[number, unknown]> => {
  const r = await res
  return [r.status, await r.json()]
}

/** A route's raw path from the table: the page's for `^`, its sample for another RegExp. */
const rawOf = (path: string): string => (path.startsWith('^') ? (path === '^' ? '/' : (SAMPLES[path] as string)) : path)

/** Every line the board logged. */
const logLines = (proc: Child): string[] =>
  proc.messages.flatMap(m => (m && typeof m === 'object' && 'log' in m ? [String((m as { log: unknown }).log)] : []))

/** The text of every file in the board's state folder, its subfolders too. */
function stateTexts(box: Sandbox): string {
  const read = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap(e =>
          e.isDirectory() ? read(join(dir, e.name)) : e.isFile() ? [readFileSync(join(dir, e.name), 'utf8')] : [],
        )
      : []
  return read(stateFolder(box)).join('\n')
}

/** The TOTP code of a base32 secret now, as the authenticator app shows it. */
const codeNow = (secret: string): string => totpCode(base32Bytes(secret) ?? new Uint8Array(), totpStep(Date.now()))

describe('the board on its own server, before its first login', () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let url = ''
  let socket = ''
  let proc: Child
  let caddy: ReturnType<typeof viaSocket>

  beforeAll(async () => {
    box = await shared()
    ;({ url, socket, proc } = await startOwnServer(box, { mokupilot: { mode: 'link' } }, { TEST_ROUTE_TABLE: '1' }))
    caddy = viaSocket(socket)
  }, 30_000)

  test('it listens on its socket by itself, 0660, with no ssh and on no port of the tunnel', async () => {
    expect(existsSync(socket)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(socket).mode & 0o777).toBe(0o660)
    const port = Number(new URL(url).port)
    // the tunnel listener's port by default (the web port + 2): nothing there
    const tunnelPort = await fetch(`http://127.0.0.1:${port + 2}/api/hello`).then(
      () => 'answers',
      () => 'refused',
    )
    expect(tunnelPort).toBe('refused')
    expect(logLines(proc).filter(l => l.startsWith('tunnel'))).toEqual([])
  })

  test('every route answers 401 without a login, the page and hello too; the setup page answers', async () => {
    const table = routeTable(proc)
    expect(table.length).toBeGreaterThan(30)
    const paths = [...table.map(r => [r.method, rawOf(r.path)] as const), ['GET', '/app.js'] as const]
    for (const [m, raw] of paths) {
      for (const method of m === 'ANY' ? ['GET', 'POST'] : [m]) {
        const res = method === 'GET' ? await caddy.get(raw) : await caddy.post(raw, {})
        expect([method, raw, res.status, await res.json()]).toEqual([method, raw, 401, { error: 'setup' }])
      }
    }
    for (const path of ['/api/hello', '/api/login/password', '/api/probe/x', '/api/setup/other']) {
      const res =
        path === '/api/hello' || path.startsWith('/api/probe') ? await caddy.get(path) : await caddy.post(path, {})
      expect([path, res.status]).toEqual([path, path === '/api/setup/other' ? 404 : 401])
      await res.body?.cancel()
    }
    const page = await caddy.get('/setup')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(page.headers.get('content-security-policy')).toContain("form-action 'none'")
    const html = await page.text()
    expect(html).toContain("<title>Set up the board's login</title>")
    expect(html).toContain('/api/setup/start')
  })

  test('only what Caddy forwards for the domain, over HTTPS; the setup’s calls from its own page only', async () => {
    expect(await answer(caddy.get('/setup', { host: 'other.example.com' }))).toEqual([403, { error: 'host' }])
    expect(await answer(caddy.get('/setup', { 'x-forwarded-proto': 'http' }))).toEqual([403, { error: 'https' }])
    for (const headers of [{ origin: '' }, { origin: 'https://evil.example' }, { 'x-board': '' }])
      expect(await answer(caddy.post('/api/setup/start', { code: 'x' }, headers))).toEqual([403, { error: 'origin' }])
  })

  test('the web board’s own port: loopback, and only with the board’s local key, which only its user reads', async () => {
    const file = join(stateFolder(box), 'local-key')
    const key = readFileSync(file, 'utf8').trim()
    expect(key).toMatch(/^[\w-]{43}$/)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    // another account on the server (www-data, a container on the host's network): the Host, the
    // Origin and X-Board it likes, no key or a wrong one; the page, reads and actions alike
    const port = new URL(url).port
    const forged = [
      {},
      { 'x-board': '1', origin: url },
      { host: `localhost:${port}`, 'x-board': '1' },
      { 'x-board-key': '' },
      { 'x-board-key': 'k'.repeat(43) },
      { 'x-board-key': `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}` },
    ]
    for (const headers of forged) {
      expect(await answer(fetch(`${url}/api/board`, { headers }))).toEqual([403, { error: 'key' }])
      expect(await answer(fetch(`${url}/`, { headers }))).toEqual([403, { error: 'key' }])
      const post = (path: string, body: unknown) =>
        fetch(`${url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
          body: JSON.stringify(body),
        })
      expect(await answer(post('/api/access', { op: 'logins-end-all' }))).toEqual([403, { error: 'key' }])
      expect(await answer(post('/api/launch', { cwd: box.dir }))).toEqual([403, { error: 'key' }])
      expect(await answer(post('/api/term/x/shell/open', {}))).toEqual([403, { error: 'key' }])
    }
    // the board's own programs: with the key
    const res = await fetch(`${url}/api/board`, { headers: { 'x-board-key': key } })
    expect(res.status).toBe(200)
    const payload = (await res.json()) as Record<string, unknown>
    // what only a PC has: no MokuPilot call, whatever config.json says, and the page told so
    expect(payload.server).toBe(true)
    expect(payload.mokupilot).toBe(false)
    const setup = await fetch(`${url}/api/setup/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1', 'x-board-key': key },
      body: '{}',
    })
    expect(setup.status).not.toBe(200)
    await setup.body?.cancel()
  })

  test('a code that expired, or is none: refused, one answer for all; tries limited as a sign-in', async () => {
    const code = 'e'.repeat(32)
    const from = { 'x-forwarded-for': '203.0.113.20' }
    writeState(box, 'access-setup.json', { codeHash: hashToken(code), expiresAt: Date.now() - 1000 })
    for (const body of [{ code }, { code: 'short' }, {}, { code: 7 }])
      expect(await answer(caddy.post('/api/setup/start', body, from))).toEqual([401, { ok: false, error: 'link' }])
    // the expired code went with its first try
    expect(existsSync(join(stateFolder(box), 'access-setup.json'))).toBe(false)
    // 10 a minute from one address, as password sign-in: both calls count
    for (let i = 4; i < 10; i++) await (await caddy.post('/api/setup/finish', {}, from)).body?.cancel()
    const limited = await caddy.post('/api/setup/start', { code }, from)
    expect(await answer(limited)).toEqual([429, { ok: false, error: 'limited' }])
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  test('the link: one use, its hash only, never in the log; the login set through it closes the setup', async () => {
    const made = await board(box, ['login', 'link'])
    expect(made.code).toBe(0)
    const code = LINK.exec(made.stdout)?.[1] ?? ''
    expect(code).toHaveLength(32)
    // a fresh code each time: the one before works no more
    const again = await board(box, ['login', 'link'])
    const code2 = LINK.exec(again.stdout)?.[1] ?? ''
    expect(code2).not.toBe(code)
    const kept = JSON.parse(readFileSync(join(stateFolder(box), 'access-setup.json'), 'utf8'))
    expect(kept).toEqual({ codeHash: hashToken(code2), expiresAt: expect.any(Number) })
    expect(kept.expiresAt - Date.now()).toBeGreaterThan(3_590_000)
    expect(kept.expiresAt - Date.now()).toBeLessThanOrEqual(3_600_000)
    expect(await answer(caddy.post('/api/setup/start', { code }))).toEqual([401, { ok: false, error: 'link' }])

    const started = await caddy.post('/api/setup/start', { code: code2 })
    expect(started.status).toBe(200)
    const s = (await started.json()) as { setup: string; secret: string; qr: { d: string; size: number } }
    expect(s.setup).toMatch(/^[\w-]{43}$/)
    expect(base32Bytes(s.secret)).toHaveLength(20)
    expect(s.qr.size).toBeGreaterThan(20)
    // used: once only
    expect(await answer(caddy.post('/api/setup/start', { code: code2 }))).toEqual([401, { ok: false, error: 'link' }])
    expect(existsSync(join(stateFolder(box), 'access-setup.json'))).toBe(false)

    // a setup that is not this one; a password too short; a wrong code: nothing set
    const finish = (body: Record<string, unknown>) => caddy.post('/api/setup/finish', body)
    expect(await answer(finish({ setup: 'x'.repeat(43), password: PASSWORD, code: codeNow(s.secret) }))).toEqual([
      401,
      { ok: false, error: 'setup' },
    ])
    expect(await answer(finish({ setup: s.setup, password: 'short', code: codeNow(s.secret) }))).toEqual([
      400,
      { ok: false, error: 'password', message: 'A password has at least 12 characters' },
    ])
    expect(await answer(finish({ setup: s.setup, password: PASSWORD, code: '000000' }))).toEqual([
      400,
      { ok: false, error: 'code', message: 'That code is not the one the app shows now' },
    ])
    expect((await caddy.get('/setup')).status).toBe(200)
    // the right code
    expect(await answer(finish({ setup: s.setup, password: PASSWORD, code: codeNow(s.secret) }))).toEqual([
      200,
      { ok: true },
    ])
    const secrets = JSON.parse(readFileSync(join(stateFolder(box), 'access.json'), 'utf8'))
    expect(secrets.passwordHash).toStartWith('$argon2id$')
    expect(secrets.totp.secret).toBe(s.secret)

    // closed for good: the setup is 404, the board's login as through the tunnel
    expect((await caddy.get('/setup')).status).toBe(404)
    for (const path of ['/api/setup/start', '/api/setup/finish'])
      expect((await caddy.post(path, { code: code2, setup: s.setup })).status).toBe(404)
    expect(await answer(caddy.get('/api/hello'))).toEqual([
      200,
      { board: 'agent-board', api: expect.any(Number), auth: 'login', signedIn: false, language: 'en' },
    ])
    expect(await answer(caddy.get('/api/board'))).toEqual([401, { error: 'login' }])
    expect((await caddy.get('/')).status).toBe(200)

    // a login is set: no new link but by reset
    const refused = await board(box, ['login', 'link'])
    expect(refused.code).toBe(3)
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toBe('board: a login is set: `board login reset` clears it and prints a new link\n')

    // the codes and the setup's token: in no line of the log, in no file of the state folder
    const logs = logLines(proc).join('\n')
    const files = stateTexts(box)
    for (const secret of [code, code2, s.setup]) {
      expect(logs).not.toContain(secret)
      expect(files).not.toContain(secret)
    }
  })

  test('board doctor: the server mode, the listener on its socket, the login; nothing only a PC has', async () => {
    const r = await board(box, ['doctor'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`ok Server mode · ${ORIGIN}`)
    const mode = process.platform === 'win32' ? '' : ' (660)'
    expect(r.stdout).toContain(`ok The login listener answers on its socket · ${socket}${mode}`)
    expect(r.stdout).toMatch(/^ok The login is set$/m)
    expect(r.stdout).not.toMatch(/MokuPilot|Desktop notifications/)
  }, 30_000)

  test('board login reset: no password, code or passkey, every login ended, a new link that works', async () => {
    const r = await board(box, ['login', 'reset'])
    expect(r.code).toBe(0)
    expect(r.stderr).toBe(
      'ok · the password, the code and the passkeys cleared, every login ended; the link below sets a new login\n',
    )
    const code = LINK.exec(r.stdout)?.[1] ?? ''
    expect(code).toHaveLength(32)
    const secrets = JSON.parse(readFileSync(join(stateFolder(box), 'access.json'), 'utf8'))
    expect([secrets.passwordHash, secrets.totp]).toEqual([null, null])
    expect(JSON.parse(readFileSync(join(stateFolder(box), 'access-logins.json'), 'utf8'))).toEqual([])
    expect(await answer(caddy.get('/api/hello'))).toEqual([401, { error: 'setup' }])
    expect((await caddy.get('/setup')).status).toBe(200)
    expect((await caddy.post('/api/setup/start', { code }, { 'x-forwarded-for': '203.0.113.30' })).status).toBe(200)
  })
})

describe('board login and doctor without a board running', () => {
  test('on a PC (no serverMode): both refuse, and doctor says nothing of a server', async () => {
    const box = await sandbox()
    writeConfig(box, {})
    for (const op of ['link', 'reset']) {
      const r = await board(box, ['login', op])
      expect([r.code, r.stdout, r.stderr]).toEqual([
        1,
        '',
        'board: board login is for the board on its own server: config.json has no serverMode\n',
      ])
    }
    expect(existsSync(join(stateFolder(box), 'access-setup.json'))).toBe(false)
    expect(existsSync(join(stateFolder(box), 'access.json'))).toBe(false)
    const doctor = await board(box, ['doctor'])
    expect(doctor.stdout).not.toMatch(/Server mode|login listener|No login yet/)
  }, 30_000)

  test('settings that do not check out are refused with the reason; doctor names them, and the listener down', async () => {
    const box = await sandbox()
    writeConfig(box, { serverMode: { domain: DOMAIN, socket: '/tmp/board.sock' } })
    const r = await board(box, ['login', 'link'])
    expect([r.code, r.stderr]).toEqual([
      1,
      'board: serverMode.socket: The socket needs a folder of its own, not /tmp, where anyone could take its name first\n',
    ])
    writeConfig(box, { serverMode: { socket: '/srv/board/board.sock' } })
    expect((await board(box, ['login', 'link'])).stderr).toBe('board: serverMode.domain: Domain: needed\n')
    writeConfig(box, { serverMode: { domain: DOMAIN, socket: '/srv/no-board-here/board.sock' } })
    const doctor = await board(box, ['doctor'])
    expect(doctor.stdout).toContain('!! Nothing answers on /srv/no-board-here/board.sock')
    expect(doctor.stdout).toContain('!  No login yet')
    expect(doctor.stdout).toContain('     board login link')
  }, 30_000)
})

describe('a board on a PC (no serverMode) is as before', () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let proc: Child
  let url = ''

  beforeAll(async () => {
    box = await shared()
    ;({ url, proc } = await serveBoard(box, { language: 'en', mokupilot: { mode: 'link' } }))
  }, 30_000)

  test('no socket, no line of a server mode, no `server` in the payload, MokuPilot offered', async () => {
    const payload = (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
    expect('server' in payload).toBe(false)
    expect(payload.mokupilot).toBe(true)
    expect(logLines(proc).filter(l => l.startsWith('server mode'))).toEqual([])
  })

  test('no local key: none made, none asked for; one sent is not looked at', async () => {
    for (const headers of [{}, { 'x-board-key': 'k'.repeat(43) }]) {
      const res = await fetch(`${url}/api/board`, { headers })
      expect(res.status).toBe(200)
      await res.body?.cancel()
      expect((await fetch(`${url}/`, { headers })).status).toBe(200)
    }
    expect(existsSync(join(stateFolder(box), 'local-key'))).toBe(false)
    expect(logLines(proc).filter(l => l.startsWith('local key'))).toEqual([])
  })
})
