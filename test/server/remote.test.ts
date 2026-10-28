// The remote mode end to end: a board with it on, a fake `tailscale` that says this computer's
// Tailscale address is 127.0.0.1 and who calls from it, and a phone that pairs and drives the board.
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { logged, serveBoard, sharedSandbox, unusedPort } from '../support/board-server.ts'
import type { Sandbox } from '../support/sandbox.ts'

const PI_KEY = '/home/me/.pi/agent/sessions/--home-me--/2026-10-20T05-10-02-695Z_01a1.jsonl'

function tailscaleState(box: Sandbox, login: string) {
  const status = {
    BackendState: 'Running',
    Self: { DNSName: 'box.tail0.ts.net.', OS: 'linux', UserID: 1, TailscaleIPs: ['127.0.0.1'], Online: true },
    Peer: {},
    User: { '1': { LoginName: 'me@example.com' } },
  }
  const whois = {
    Node: { StableID: 'nPhone', ComputedName: 'xiaomi-17', Hostinfo: { OS: 'android' } },
    UserProfile: { LoginName: login },
  }
  const snapshot = {
    panes: [
      { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir },
      { pane_id: 'p2', agent: 'pi', agent_session: { value: PI_KEY }, agent_status: 'idle', cwd: box.dir },
    ],
    tabs: [],
    workspaces: [],
  }
  box.state({
    'api snapshot': { result: { snapshot } },
    'status --json': { text: JSON.stringify(status) },
    'whois --json 127.0.0.1': { text: JSON.stringify(whois) },
  })
}

/** A request with a Host of our choosing (fetch always sends its own); the status code. */
function rawStatus(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write(`GET /api/hello HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
    )
    let text = ''
    socket.on('data', chunk => {
      text += chunk.toString('utf8')
    })
    socket.on('end', () => resolve(text.split(' ')[1] ?? ''))
    socket.on('error', reject)
  })
}

async function startRemoteBoard(box: Sandbox, remote: Record<string, unknown>) {
  const port = await unusedPort()
  const { url } = await serveBoard(
    box,
    { language: 'en', remote: { on: true, port, ...remote } },
    { TAILSCALE_BIN_PATH: box.env.HERDR_BIN_PATH as string },
  )
  const deadline = Date.now() + 8000
  for (;;) {
    const view = (await (await fetch(`${url}/api/remote`)).json()) as { url?: string | null }
    const board = (await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }
    if (view.url && !board.stale) break
    if (Date.now() > deadline) throw new Error(`remote did not start: ${JSON.stringify(view)}`)
    await Bun.sleep(25)
  }
  return { url, remoteUrl: `http://127.0.0.1:${port}`, port }
}

describe('remote mode on', () => {
  const sandbox = sharedSandbox()
  let url = ''
  let remoteUrl = ''
  let port = 0
  let token = ''
  const local = (op: string, id = '') =>
    fetch(`${url}/api/remote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op, id }),
    })
  const phone = (path: string, init: RequestInit = {}, withToken = true) =>
    fetch(remoteUrl + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-board': '1',
        ...(withToken ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers as Record<string, string>),
      },
    })

  beforeAll(async () => {
    const box = await sandbox()
    tailscaleState(box, 'me@example.com')
    ;({ url, remoteUrl, port } = await startRemoteBoard(box, {}))
  }, 30_000)

  test('it says what it is, to anyone the tailnet vouches for', async () => {
    const hello = (await (await phone('/api/hello', {}, false)).json()) as Record<string, unknown>
    expect(hello).toMatchObject({
      board: 'agent-board',
      api: 1,
      name: 'box',
      dnsName: 'box.tail0.ts.net',
      remote: true,
    })
    expect((await fetch(`${url}/api/hello`)).status).toBe(200)
  })

  test('only its own Tailscale address and names as Host', async () => {
    expect(await rawStatus(port, `127.0.0.1:${port}`)).toBe('200')
    expect(await rawStatus(port, `box:${port}`)).toBe('200')
    expect(await rawStatus(port, `BOX.tail0.ts.net:${port}`)).toBe('200')
    expect(await rawStatus(port, `evil.example:${port}`)).toBe('403')
    expect(await rawStatus(port, 'box:1')).toBe('403')
  })

  test('nothing but hello and pairing without a token; never the page', async () => {
    expect((await phone('/api/board', {}, false)).status).toBe(401)
    expect((await phone('/', {}, false)).status).toBe(401)
    token = 'x'.repeat(43)
    expect((await phone('/api/board')).status).toBe(401)
  })

  test('a phone pairs once the user approves it on the board, and drives the board with its token', async () => {
    const asked = await phone(
      '/api/remote/pair',
      { method: 'POST', body: JSON.stringify({ name: 'Agent board app' }) },
      false,
    )
    expect(asked.status).toBe(202)
    const { id } = (await asked.json()) as { id: string }
    const view = (await (await fetch(`${url}/api/remote`)).json()) as { pending: Record<string, unknown>[] }
    expect(view.pending).toEqual([
      expect.objectContaining({
        id,
        name: 'Agent board app',
        device: 'xiaomi-17',
        login: 'me@example.com',
        os: 'android',
      }),
    ])
    expect(await (await phone(`/api/remote/pair/${id}`, {}, false)).json()).toEqual({ status: 'pending' })
    // The page approves; a request without the board's header does not.
    expect(
      (await fetch(`${url}/api/remote`, { method: 'POST', body: JSON.stringify({ op: 'approve', id }) })).status,
    ).toBe(403)
    expect((await local('approve', id)).status).toBe(200)
    const answer = (await (await phone(`/api/remote/pair/${id}`, {}, false)).json()) as {
      status: string
      token: string
    }
    expect(answer.status).toBe('approved')
    token = answer.token
    expect(await (await phone(`/api/remote/pair/${id}`, {}, false)).json()).toEqual({ status: 'gone' })

    const board = await phone('/api/board')
    expect(board.status).toBe(200)
    const payload = (await board.json()) as { items: { key: string }[]; remote: { devices: Record<string, unknown>[] } }
    expect(payload.items.map(i => i.key).sort()).toEqual([PI_KEY, 's1'].sort())
    // The page sees the device, never its token or the token's hash.
    expect(payload.remote.devices).toEqual([expect.objectContaining({ device: 'xiaomi-17', name: 'Agent board app' })])
    expect(JSON.stringify(payload)).not.toContain(token)
    expect('tokenHash' in (payload.remote.devices[0] ?? {})).toBe(false)
    // A session with a slash in its key, as on the computer.
    expect((await phone(`/api/session/${encodeURIComponent(PI_KEY)}`)).status).toBe(200)
    expect(await (await phone('/api/peers')).json()).toEqual({ peers: [] })
  })

  test("what acts on the computer's screen, and approving pairings, stay with the computer", async () => {
    const post = (path: string, body: unknown) => phone(path, { method: 'POST', body: JSON.stringify(body) })
    expect(await (await post('/api/open-url', { url: 'https://example.com' })).json()).toEqual({ error: 'desktop' })
    expect((await post('/api/fs/open', { path: '/tmp' })).status).toBe(403)
    expect((await post('/api/session/s1/focus', {})).status).toBe(403)
    expect((await post('/api/reveal', { key: 's1' })).status).toBe(403)
    expect(await (await post('/api/remote', { op: 'off' })).json()).toEqual({ error: 'local' })
    expect((await phone('/api/remote')).status).toBe(403)
    // Remote access is set up on the computer only, in either spelling.
    for (const path of ['/api/access', '/api/%61ccess']) {
      const got = await phone(path)
      expect([path, got.status, await got.json()]).toEqual([path, 403, { error: 'local' }])
      const posted = await post(path, { op: 'off' })
      expect([path, posted.status, await posted.json()]).toEqual([path, 403, { error: 'local' }])
      // the profile sync's picker and rules too: the server's folders listed or made, the rules kept
      for (const body of [
        { op: 'sync-dirs', path: '/home/agent' },
        { op: 'sync-mkdir', path: '/home/agent', name: 'x' },
        { op: 'sync-rules', rules: [{ pc: 'C:\\migo', server: '/home/agent/migo' }] },
      ]) {
        const sync = await post(path, body)
        expect([body.op, sync.status, await sync.json()]).toEqual([body.op, 403, { error: 'local' }])
      }
    }
    expect((await phone('/')).status).toBe(404)
    // The routes' own guards as for the page: a POST needs the board's header.
    expect((await phone('/api/session/s1/wake', { method: 'POST', headers: { 'x-board': '' } })).status).toBe(403)
  })

  test('spelled with an encoded letter, they still stay with the computer: routes match the decoded path', async () => {
    // Bodies that do nothing where a route is reached: refused here, or the route's own 4xx.
    const post = (path: string, body: unknown) => phone(path, { method: 'POST', body: JSON.stringify(body) })
    expect(await (await post('/api/open%2Durl', { url: 'ftp://example.com' })).json()).toEqual({ error: 'desktop' })
    expect(await (await post('/api/fs/%6Fpen', { path: '/nowhere/at/all' })).json()).toEqual({ error: 'desktop' })
    expect(await (await post('/api/%72eveal', { key: 'nope' })).json()).toEqual({ error: 'desktop' })
    expect(await (await post('/api/%72emote', { op: 'nothing' })).json()).toEqual({ error: 'local' })
    expect(await (await phone('/api/%72emote')).json()).toEqual({ error: 'local' })
    expect(await (await post('/api/remote%2Fx', { op: 'nothing' })).json()).toEqual({ error: 'local' })
    expect((await post('/api/session/s1/%66ocus', {})).ok).toBe(false)
  })

  test('revoking a device ends its token at once, and the stream it has open', async () => {
    const events = await phone('/api/events')
    expect(events.status).toBe(200)
    const reader = (events.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let seen = decoder.decode((await reader.read()).value)
    const view = (await (await fetch(`${url}/api/remote`)).json()) as { devices: { id: string }[] }
    expect((await local('revoke', view.devices[0]?.id)).status).toBe(200)
    expect((await phone('/api/board')).status).toBe(401)
    // The live board stops coming: the stream says why and ends.
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      seen += decoder.decode(next.value)
    }
    expect(seen).toContain('event: unpaired')
  })
})

describe('remote mode, another Tailscale user', () => {
  const sandbox = sharedSandbox()
  let remoteUrl = ''

  beforeAll(async () => {
    const box = await sandbox()
    tailscaleState(box, 'someone@else.com')
    ;({ remoteUrl } = await startRemoteBoard(box, {}))
  }, 30_000)

  test('cannot even ask to pair', async () => {
    expect(await (await fetch(`${remoteUrl}/api/hello`)).json()).toEqual({ error: 'user' })
    const asked = await fetch(`${remoteUrl}/api/remote/pair`, { method: 'POST', body: JSON.stringify({ name: 'x' }) })
    expect(asked.status).toBe(403)
  })
})

describe('remote mode off (the default)', () => {
  const sandbox = sharedSandbox()
  let url = ''
  let box: Sandbox

  beforeAll(async () => {
    box = await sandbox()
    tailscaleState(box, 'me@example.com')
    ;({ url } = await serveBoard(box, { language: 'en' }, { TAILSCALE_BIN_PATH: box.env.HERDR_BIN_PATH as string }))
  }, 30_000)

  test('nothing listens, nothing asks Tailscale, the payload has no remote', async () => {
    await Bun.sleep(300)
    expect(await (await fetch(`${url}/api/remote`)).json()).toEqual({ on: false })
    const payload = (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
    expect('remote' in payload).toBe(false)
    expect(box.calls().filter(c => c[0] === 'status' || c[0] === 'whois')).toEqual([])
  })
})

describe('board remote, from the command', () => {
  const sandbox = sharedSandbox()

  test('on, where it listens, a phone that asks, approve, off', async () => {
    const box = await sandbox()
    tailscaleState(box, 'me@example.com')
    const webPort = await unusedPort()
    const remotePort = await unusedPort()
    // The board reads config.json as it changes, as the real one does (TEST_LIVE_CONFIG).
    const cfg = {
      language: 'en',
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      wakeUrl: null,
      refreshSec: 3600,
      port: webPort,
      remote: { on: false, port: remotePort },
    }
    const file = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(cfg))
    const env = { TAILSCALE_BIN_PATH: box.env.HERDR_BIN_PATH as string }
    await serveBoard(box, cfg, { ...env, TEST_LIVE_CONFIG: '1' })
    const board = async (...args: string[]) => {
      const out = await box.run('cli', { args: ['remote', ...args], env: {} }).exited
      return `${out.stdout}${out.stderr}`.trim()
    }
    const phone = `http://127.0.0.1:${remotePort}`
    const listening = async (want: boolean) => {
      const deadline = Date.now() + 8000
      for (;;) {
        const up = await fetch(`${phone}/api/hello`).then(
          r => r.ok,
          () => false,
        )
        if (up === want) return
        if (Date.now() > deadline) throw new Error(`listening is not ${want}`)
        await Bun.sleep(50)
      }
    }

    expect(await board()).toMatch(/^remote off/)
    expect(await board('on')).toMatch(/^ok · remote on/)
    await listening(true)
    expect(await board()).toBe(`remote on · http://box.tail0.ts.net:${remotePort}`)

    const asked = await fetch(`${phone}/api/remote/pair`, { method: 'POST', body: JSON.stringify({ name: 'App' }) })
    const { id } = (await asked.json()) as { id: string }
    expect(await board()).toContain(`asks to pair: ${id} "App" from xiaomi-17 (me@example.com, android)`)
    expect(await board('approve', id)).toBe(`ok · approved ${id}`)
    expect(await board('approve', id)).toContain(`no request or device ${id}`)
    expect(await board()).toMatch(/paired: [a-f0-9]+ "App" on xiaomi-17 \(me@example.com\)/)

    expect(await board('off')).toBe('ok · remote off')
    await listening(false)
    expect(await board('sideways')).toContain('usage: board remote')
  }, 40_000)
})

describe('Tailscale that does not answer for a moment (#108)', () => {
  const sandbox = sharedSandbox()

  test('one failed `tailscale status` keeps the listener and its callers; the next look comes sooner', async () => {
    const box = await sandbox()
    tailscaleState(box, 'me@example.com')
    const webPort = await unusedPort()
    const remotePort = await unusedPort()
    const cfg = {
      language: 'en',
      categories: [{ id: 'other', title: 'Other', color: 'gray' }],
      wakeUrl: null,
      refreshSec: 3600,
      port: webPort,
      remote: { on: true, port: remotePort },
    }
    const file = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(cfg))
    const { proc } = await serveBoard(box, cfg, {
      TAILSCALE_BIN_PATH: box.env.HERDR_BIN_PATH as string,
      TEST_LIVE_CONFIG: '1',
    })
    const phone = `http://127.0.0.1:${remotePort}`
    const up = () =>
      fetch(`${phone}/api/hello`).then(
        r => r.status,
        () => 0,
      )
    const deadline = Date.now() + 8000
    while ((await up()) !== 200 && Date.now() < deadline) await Bun.sleep(50)
    expect(await up()).toBe(200)

    // Tailscale stops answering `status` (whois still answers from the cache), and the board looks
    // again: a change to the remote mode's config makes it look at once.
    const state = JSON.parse(readFileSync(box.env.FAKE_HERDR_STATE as string, 'utf8'))
    box.state({ ...state, 'status --json': { error: 'failed to connect to local tailscaled' } })
    writeFileSync(file, JSON.stringify({ ...cfg, remote: { ...cfg.remote, allow: ['someone@example.com'] } }))
    const said = Date.now() + 8000
    while (!logged(proc, 'Tailscale did not answer') && Date.now() < said) await Bun.sleep(50)
    expect(logged(proc, 'Tailscale did not answer')).toBe(true)
    expect(await up()).toBe(200)
    const view = (await (await fetch(`http://127.0.0.1:${webPort}/api/remote`)).json()) as { error: string | null }
    expect(view.error).toBeNull()
  }, 40_000)
})
