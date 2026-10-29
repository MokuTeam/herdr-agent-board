// The board in a phone's browser end to end (core/pwa.ts): a board with remote.pwa on, a fake
// `tailscale` that says who calls and what `serve` forwards, and requests shaped as serve sends
// them to the board's listener on 127.0.0.1 (its Host, X-Forwarded-For, X-Forwarded-Proto).
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard, sharedSandbox, unusedPort } from '../support/board-server.ts'
import type { Sandbox } from '../support/sandbox.ts'

const NAME = 'box.tail0.ts.net'
const ORIGIN = `https://${NAME}`
const PHONE_IP = '100.78.86.80'

function tailscaleState(box: Sandbox, { certs = true, serving = '' }: { certs?: boolean; serving?: string } = {}) {
  const status = {
    BackendState: 'Running',
    Self: { DNSName: `${NAME}.`, OS: 'windows', UserID: 1, TailscaleIPs: ['127.0.0.1'], Online: true },
    Peer: {},
    User: { '1': { LoginName: 'me@example.com' } },
    CertDomains: certs ? [NAME] : null,
  }
  const whois = {
    Node: { StableID: 'nPhone', ComputedName: 'iphone-17', Hostinfo: { OS: 'iOS' } },
    UserProfile: { LoginName: 'me@example.com' },
  }
  const ours = (target: string) =>
    JSON.stringify({
      TCP: { '443': { HTTPS: true } },
      Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: target } } } },
    })
  const snapshot = {
    panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir }],
    tabs: [],
    workspaces: [],
  }
  box.state({
    'api snapshot': { result: { snapshot } },
    'status --json': { text: JSON.stringify(status) },
    [`whois --json ${PHONE_IP}`]: { text: JSON.stringify(whois) },
    // What serve forwards: `serving`, or nothing.
    'serve status --json': { text: serving ? ours(serving) : '{}' },
    'serve --bg': { text: '' },
    'serve --https=443': { text: '' },
  })
}

/** The board with remote.pwa on, once serve's listener answers. */
async function startPwaBoard(box: Sandbox) {
  const remotePort = await unusedPort()
  const pwaPort = await unusedPort()
  tailscaleState(box, { serving: `http://127.0.0.1:${pwaPort}` })
  const { url } = await serveBoard(
    box,
    { language: 'en', remote: { on: true, port: remotePort, pwa: { on: true, port: pwaPort } } },
    { TAILSCALE_BIN_PATH: box.env.HERDR_BIN_PATH as string },
  )
  const deadline = Date.now() + 8000
  for (;;) {
    const view = (await (await fetch(`${url}/api/remote`)).json()) as { pwa?: { url?: string | null } }
    const board = (await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }
    if (view.pwa?.url && !board.stale) break
    if (Date.now() > deadline) throw new Error(`pwa did not start: ${JSON.stringify(view)}`)
    await Bun.sleep(25)
  }
  return { url, web: `http://127.0.0.1:${pwaPort}` }
}

describe("the board in a phone's browser, through tailscale serve", () => {
  const sandbox = sharedSandbox()
  let url = ''
  let web = ''
  let cookie = ''
  const local = (op: string, id = '') =>
    fetch(`${url}/api/remote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op, id }),
    })
  /** A request as serve forwards it from the phone. */
  const phone = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
    fetch(web + path, {
      ...init,
      headers: {
        host: NAME,
        'x-forwarded-for': PHONE_IP,
        'x-forwarded-proto': 'https',
        'tailscale-user-login': 'me@example.com',
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
    })
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    phone(
      path,
      { method: 'POST', body: JSON.stringify(body) },
      { 'content-type': 'application/json', 'x-board': '1', origin: ORIGIN, ...headers },
    )

  beforeAll(async () => {
    ;({ url, web } = await startPwaBoard(await sandbox()))
  }, 30_000)

  test('only what serve forwards: its Host, HTTPS, and an address Tailscale vouches for', async () => {
    expect((await phone('/api/hello')).status).toBe(200)
    expect((await phone('/api/hello', {}, { host: `${NAME}:443` })).status).toBe(200)
    expect(await (await phone('/api/hello', {}, { host: '127.0.0.1' })).json()).toEqual({ error: 'host' })
    expect(await (await phone('/api/hello', {}, { 'x-forwarded-proto': 'http' })).json()).toEqual({ error: 'https' })
    expect(await (await phone('/api/hello', {}, { 'x-forwarded-for': '' })).json()).toEqual({ error: 'tailnet' })
    expect(await (await phone('/api/hello', {}, { 'x-forwarded-for': '100.1.2.3' })).json()).toEqual({
      error: 'tailnet',
    })
    expect(await (await phone('/api/hello', {}, { 'tailscale-user-login': 'other@x.com' })).json()).toEqual({
      error: 'user',
    })
  })

  test('the page, marked for the phone, with its manifest, icons and service worker; no data before pairing', async () => {
    const page = await phone('/')
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('<html data-remote')
    expect(html).toContain('href="manifest.webmanifest"')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
    const manifest = await phone('/manifest.webmanifest')
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json')
    expect(await manifest.json()).toMatchObject({ display: 'standalone', start_url: '/' })
    // The script by the page's build (#116), the version the board goes by.
    const board = (await (await fetch(`${url}/api/board`)).json()) as { version: string }
    expect(html).toContain(`<script type="module" src="app.js?v=${board.version}"></script>`)
    const script = await phone(`/app.js?v=${board.version}`, { decompress: false } as RequestInit, {
      'accept-encoding': 'gzip, deflate, br',
    })
    expect(script.headers.get('content-type')).toContain('javascript')
    // Compressed for the phone's link (#122): serve passes the encoding on as it is.
    expect([script.headers.get('content-encoding'), script.headers.get('vary')]).toEqual(['br', 'accept-encoding'])
    const sw = await phone('/sw.js')
    expect(sw.headers.get('content-type')).toContain('javascript')
    expect(await sw.text()).toContain("startsWith('/api/')")
    for (const icon of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'])
      expect((await phone(`/${icon}`)).headers.get('content-type')).toBe('image/png')
    expect(await (await phone('/api/hello')).json()).toMatchObject({
      board: 'agent-board',
      paired: false,
      language: 'en',
    })
    expect((await phone('/api/board')).status).toBe(401)
    expect((await phone('/api/events')).status).toBe(401)
  })

  test("the computer's own page stays as it was", async () => {
    const html = await (await fetch(`${url}/`)).text()
    expect(html).not.toContain('data-remote')
    expect(html).not.toContain('manifest')
    expect(html).toContain('<script type="module" src="app.js"></script>')
  })

  test('it pairs as a browser: approved on the computer, the token goes into a cookie the page cannot read', async () => {
    // A browser sends cookies by itself: asking needs the board's header from the board's own page.
    expect((await post('/api/remote/pair', { name: 'Board in Safari' }, { 'x-board': '' })).status).toBe(403)
    expect(
      (await post('/api/remote/pair', { name: 'Board in Safari' }, { origin: 'https://evil.example' })).status,
    ).toBe(403)
    const asked = await post('/api/remote/pair', { name: 'Board in Safari' })
    expect(asked.status).toBe(202)
    const { id } = (await asked.json()) as { id: string }
    const view = (await (await fetch(`${url}/api/remote`)).json()) as { pending: Record<string, unknown>[] }
    expect(view.pending).toEqual([expect.objectContaining({ id, kind: 'browser', device: 'iphone-17' })])
    expect(await (await phone(`/api/remote/pair/${id}`)).json()).toEqual({ status: 'pending' })
    expect((await local('approve', id)).status).toBe(200)

    const answer = await phone(`/api/remote/pair/${id}`)
    const body = (await answer.json()) as Record<string, unknown>
    expect(body).toEqual({ status: 'approved', device: 'iphone-17' })
    const set = answer.headers.get('set-cookie') ?? ''
    for (const part of ['__Host-board=', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) expect(set).toContain(part)
    cookie = set.split(';')[0] ?? ''

    expect(await (await phone('/api/hello')).json()).toMatchObject({ paired: true })
    const board = await phone('/api/board')
    expect(board.status).toBe(200)
    const payload = (await board.json()) as { items: { key: string }[]; remote: { devices: Record<string, unknown>[] } }
    expect(payload.items.map(i => i.key)).toEqual(['s1'])
    expect(payload.remote.devices).toEqual([expect.objectContaining({ kind: 'browser', name: 'Board in Safari' })])
    expect(JSON.stringify(payload)).not.toContain(cookie.split('=')[1] ?? '?')
  })

  test("what acts on the computer's screen, and approving pairings, stay with the computer", async () => {
    expect(await (await post('/api/open-url', { url: 'https://example.com' })).json()).toEqual({ error: 'desktop' })
    expect((await post('/api/fs/open', { path: '/tmp' })).status).toBe(403)
    expect(await (await post('/api/fs/%6Fpen', { path: '/tmp' })).json()).toEqual({ error: 'desktop' })
    expect((await post('/api/session/s1/focus', {})).status).toBe(403)
    expect((await post('/api/reveal', { key: 's1' })).status).toBe(403)
    expect(await (await post('/api/remote', { op: 'off' })).json()).toEqual({ error: 'local' })
    // Remote access, the backup and Settings → Time are set up on the computer only, in either spelling.
    for (const path of [
      '/api/access',
      '/api/%61ccess',
      '/api/backup',
      '/api/%62ackup',
      '/api/time-settings',
      '/api/time-%73ettings',
    ]) {
      const got = await phone(path)
      expect([path, got.status, await got.json()]).toEqual([path, 403, { error: 'local' }])
      const posted = await post(path, { op: 'off' })
      expect([path, posted.status, await posted.json()]).toEqual([path, 403, { error: 'local' }])
    }
    // With the cookie, a change still needs the board's own page.
    expect((await post('/api/session/s1/wake', {}, { origin: 'https://other.tail0.ts.net' })).status).toBe(403)
  })

  test('unpairing ends its open stream with a word for the page, and the cookie stops working', async () => {
    const events = await phone('/api/events')
    expect(events.status).toBe(200)
    const reader = (events.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let seen = decoder.decode((await reader.read()).value)
    expect(seen).toContain('data: ')
    const view = (await (await fetch(`${url}/api/remote`)).json()) as { devices: { id: string }[] }
    expect((await local('revoke', view.devices[0]?.id)).status).toBe(200)
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      seen += decoder.decode(next.value)
    }
    expect(seen).toContain('event: unpaired')
    const refused = await phone('/api/board')
    expect(refused.status).toBe(401)
    expect(refused.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(await (await phone('/api/hello')).json()).toMatchObject({ paired: false })
  })
})

describe("remote on, the board in a phone's browser off", () => {
  const sandbox = sharedSandbox()
  let url = ''
  let box: Sandbox

  beforeAll(async () => {
    box = await sandbox()
    tailscaleState(box, { certs: false })
    const port = await unusedPort()
    ;({ url } = await serveBoard(
      box,
      { language: 'en', remote: { on: true, port } },
      { TAILSCALE_BIN_PATH: box.env.HERDR_BIN_PATH as string },
    ))
  }, 30_000)

  test('serve is never asked; the panel learns that the tailnet has no HTTPS certificates', async () => {
    const deadline = Date.now() + 8000
    let view: { url?: string | null; pwa?: unknown } = {}
    while (!view.url && Date.now() < deadline) {
      view = (await (await fetch(`${url}/api/remote`)).json()) as typeof view
      await Bun.sleep(25)
    }
    expect(view.pwa).toEqual({ on: false, https: 443, url: null, certs: false, serve: null, error: null })
    expect(box.calls().filter(c => c[0] === 'serve')).toEqual([])
  })
})

describe('turning it on and off, from the Phones panel and from the command', () => {
  const sandbox = sharedSandbox()

  test('refused without HTTPS certificates; then serve set up, config.json on, and taken back', async () => {
    const box = await sandbox()
    tailscaleState(box, { certs: false })
    const webPort = await unusedPort()
    const pwaPort = await unusedPort()
    const cfg = {
      language: 'en',
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      wakeUrl: null,
      refreshSec: 3600,
      port: webPort,
      remote: { on: true, port: await unusedPort(), pwa: { port: pwaPort } },
    }
    const file = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(cfg))
    const tailscale = { TAILSCALE_BIN_PATH: box.env.HERDR_BIN_PATH as string }
    await serveBoard(box, cfg, { ...tailscale, TEST_LIVE_CONFIG: '1' })
    const url = `http://127.0.0.1:${webPort}`
    const op = async (name: string) => {
      const res = await fetch(`${url}/api/remote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify({ op: name }),
      })
      return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; url?: string } }
    }
    const serveCalls = () => box.calls().filter(c => c[0] === 'serve' && c[1] !== 'status')

    const refused = await op('pwa-on')
    expect(refused.status).toBe(409)
    expect(refused.body.error).toContain('turn on HTTPS Certificates on the DNS page')
    expect(serveCalls()).toEqual([])

    tailscaleState(box)
    const on = await op('pwa-on')
    expect(on).toEqual({ status: 200, body: { ok: true, url: ORIGIN } })
    expect(serveCalls()).toEqual([['serve', '--bg', '--https=443', `http://127.0.0.1:${pwaPort}`]])
    // From now on serve forwards the name to this board (the fake does not keep what it was told).
    tailscaleState(box, { serving: `http://127.0.0.1:${pwaPort}` })
    const saved = () => JSON.parse(readFileSync(file, 'utf8')).remote
    expect(saved()).toMatchObject({ on: true, pwa: { on: true, port: pwaPort } })

    expect((await op('pwa-off')).status).toBe(200)
    expect(saved().pwa.on).toBe(false)
    expect(serveCalls().at(-1)).toEqual(['serve', '--https=443', 'off'])

    const board = async (...args: string[]) => {
      const out = await box.run('cli', { args: ['remote', ...args], env: {} }, tailscale).exited
      return `${out.stdout}${out.stderr}`.trim()
    }
    const printed = await board('pwa', 'on')
    expect(printed).toContain(`ok · on a phone with Tailscale, open ${ORIGIN}`)
    expect(printed).toContain('\x1b[30;107m')
    expect(saved().pwa.on).toBe(true)
    // The fake's serve still forwards here: nothing to set up again.
    expect(serveCalls().filter(c => c[1] === '--bg')).toHaveLength(1)
    expect(await board('off')).toBe('ok · remote off')
    expect(saved()).toMatchObject({ on: false, pwa: { on: false } })
  }, 40_000)
})
