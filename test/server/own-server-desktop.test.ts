// The agents' own browsers' routes on the board's own server (server/routes/desktop.ts), the
// board in a process of its own: through the domain the VNC WebSocket takes the login, the page's
// file token and its Origin, and answers 404 for a session with no desktop; the agent's own calls
// (/api/browser/…) answer only with the board's local key, never through the domain. A board on a
// PC has none of these routes and no `desktop` on any card: such a path answers as any unknown one.
import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOGIN_COOKIE } from '../../src/core/access.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'
import { startOwnServer, viaSocket } from '../support/own-server.ts'
import type { Child, Sandbox } from '../support/sandbox.ts'
import { DOMAIN, ORIGIN, routeTable, seedAccess, stateFolder } from '../support/tunnel-board.ts'

const TOKEN = 'd'.repeat(43)
const COOKIE = `${LOGIN_COOKIE}=${TOKEN}`

/** herdr (the sandbox's) with one Claude session, s1 in pane p1. */
function oneSession(box: Sandbox): void {
  const snapshot = {
    panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir }],
    tabs: [],
    workspaces: [],
  }
  box.state({ 'api snapshot': { result: { snapshot } } })
}

const answer = async (res: Response | Promise<Response>): Promise<[number, unknown]> => {
  const r = await res
  return [r.status, await r.json()]
}

/** A WebSocket handshake through the socket, as Caddy forwards it: the status line Bun answers. */
async function handshake(socket: string, path: string, headers: Record<string, string>): Promise<string> {
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${DOMAIN}`,
    'X-Forwarded-Proto: https',
    'X-Forwarded-For: 203.0.113.9',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    '',
    '',
  ]
  let got = ''
  const { promise, resolve } = Promise.withResolvers<string>()
  const conn = await Bun.connect({
    unix: socket,
    socket: {
      data(s, chunk) {
        got += new TextDecoder().decode(chunk)
        if (got.includes('\r\n\r\n')) {
          resolve(got.split('\r\n')[0] ?? '')
          s.end()
        }
      },
      close: () => resolve(got.split('\r\n')[0] ?? ''),
    },
  })
  conn.write(lines.join('\r\n'))
  return promise
}

describe('on the board’s own server', () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let url = ''
  let socket = ''
  let proc: Child
  let caddy: ReturnType<typeof viaSocket>
  let fsToken = ''
  let key = ''

  beforeAll(async () => {
    box = await shared()
    oneSession(box)
    await seedAccess(box, { logins: [{ token: TOKEN }] })
    ;({ url, socket, proc } = await startOwnServer(box, {}, { TEST_ROUTE_TABLE: '1' }))
    caddy = viaSocket(socket, COOKIE)
    key = readFileSync(join(stateFolder(box), 'local-key'), 'utf8').trim()
    fsToken = String(((await (await caddy.get('/api/board')).json()) as { fsToken: string }).fsToken)
  }, 30_000)

  test('its routes are in the table', () => {
    const paths = routeTable(proc).map(r => r.path)
    expect(paths).toContain('^\\/api\\/desktop\\/')
    expect(paths).toContain('^\\/api\\/browser\\/(start|call|profile|ask|close|open|display)$')
    expect(paths).toContain('/api/browser/cdp')
  })

  test('the agent’s DevTools: never through the domain; on 127.0.0.1 with the board’s key, a WebSocket only', async () => {
    const cdp = '/api/browser/cdp?pane=w0%3Ap1'
    expect(await answer(caddy.get(cdp))).toEqual([403, { error: 'key' }])
    expect(await handshake(socket, cdp, { Origin: ORIGIN, Cookie: COOKIE })).toBe('HTTP/1.1 403 Forbidden')
    const local = (path: string, k = key) => fetch(`${url}${path}`, { headers: { 'x-board-key': k } })
    expect(await answer(local(cdp, ''))).toEqual([403, { error: 'key' }])
    expect(await answer(local('/api/browser/cdp?pane=w0%20p1%3B'))).toEqual([400, { ok: false, error: 'pane' }])
    expect(await answer(local(cdp))).toEqual([400, { error: 'upgrade' }])
  })

  test('the VNC WebSocket through the domain: the login, the file token, the Origin; 404 with no desktop', async () => {
    const vnc = `/api/desktop/s1/vnc?t=${fsToken}`
    expect(await answer(viaSocket(socket).get(vnc, { origin: ORIGIN }))).toEqual([401, { error: 'login' }])
    expect(await answer(caddy.get('/api/desktop/s1/vnc', { origin: ORIGIN }))).toEqual([403, { error: 'token' }])
    expect(await answer(caddy.get(vnc, { origin: 'https://evil.example' }))).toEqual([403, { error: 'origin' }])
    expect(await answer(caddy.get(vnc, { origin: ORIGIN }))).toEqual([404, { error: 'no desktop' }])
    // a real handshake, as the page's: not upgraded, for a session with none
    const base = { Origin: ORIGIN, Cookie: COOKIE }
    expect(await handshake(socket, vnc, base)).toBe('HTTP/1.1 404 Not Found')
    expect(await handshake(socket, vnc, { Origin: ORIGIN })).toBe('HTTP/1.1 401 Unauthorized')
    expect(await handshake(socket, vnc, { ...base, Origin: 'https://evil.example' })).toBe('HTTP/1.1 403 Forbidden')
    // a key with a slash in it, encoded: one segment
    expect(await answer(caddy.get(`/api/desktop/${encodeURIComponent('/p/x.jsonl')}/vnc?t=${fsToken}`))).toEqual([
      404,
      { error: 'no desktop' },
    ])
  })

  test('the video WebSocket through the domain: as the VNC one, the login, the file token, the Origin; 404 with no desktop', async () => {
    const video = `/api/desktop/s1/video?t=${fsToken}`
    expect(await answer(viaSocket(socket).get(video, { origin: ORIGIN }))).toEqual([401, { error: 'login' }])
    expect(await answer(caddy.get('/api/desktop/s1/video', { origin: ORIGIN }))).toEqual([403, { error: 'token' }])
    expect(await answer(caddy.get(video, { origin: 'https://evil.example' }))).toEqual([403, { error: 'origin' }])
    expect(await answer(caddy.get(video, { origin: ORIGIN }))).toEqual([404, { error: 'no desktop' }])
    expect(await answer(caddy.post(video, {}))).toEqual([405, { error: 'method' }])
    const base = { Origin: ORIGIN, Cookie: COOKIE }
    expect(await handshake(socket, video, base)).toBe('HTTP/1.1 404 Not Found')
    expect(await handshake(socket, video, { Origin: ORIGIN })).toBe('HTTP/1.1 401 Unauthorized')
  })

  test('control: from the page (X-Board, its Origin), owner or agent; 404 with no desktop', async () => {
    expect(await answer(caddy.post('/api/desktop/s1/control', { to: 'owner' }))).toEqual([
      404,
      { ok: false, error: 'no desktop' },
    ])
    expect(await answer(caddy.post('/api/desktop/s1/control', { to: 'me' }))).toEqual([
      400,
      { ok: false, error: 'to: owner or agent' },
    ])
    expect(await answer(caddy.post('/api/desktop/s1/control', { to: 'owner' }, { 'x-board': '' }))).toEqual([
      403,
      { error: 'origin' },
    ])
    expect(await answer(caddy.get('/api/desktop/s1/control'))).toEqual([405, { error: 'method' }])
  })

  test('the agent’s own calls: never through the domain; on 127.0.0.1 with the board’s key', async () => {
    for (const op of ['start', 'call', 'profile', 'ask', 'close', 'open', 'display'])
      expect(await answer(caddy.post(`/api/browser/${op}`, { pane: 'w0:p1' }))).toEqual([403, { error: 'key' }])
    const local = (path: string, body: unknown, k = key) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board-key': k },
        body: JSON.stringify(body),
      })
    expect(await answer(local('/api/browser/call', { pane: 'w0:p1' }, ''))).toEqual([403, { error: 'key' }])
    expect(await answer(local('/api/browser/call', { pane: 'w0:p1' }))).toEqual([
      200,
      { ok: true, control: 'agent', asks: false },
    ])
    expect(await answer(local('/api/browser/call', { pane: 'w0 p1;' }))).toEqual([400, { ok: false, error: 'pane' }])
    expect(await answer(local('/api/browser/profile', { pane: 'w0:p1', name: '../x' }))).toEqual([
      400,
      { ok: false, error: expect.stringContaining('profile name') },
    ])
    expect(await answer(local('/api/browser/ask', { pane: 'w0:p9', text: 'Sign in' }))).toEqual([
      409,
      { ok: false, error: 'this session is not on the board' },
    ])
    // board browser open: an http or https address only, asked text within bounds; a session not on the board: none started
    for (const url of [undefined, '', 'file:///etc/passwd', 'javascript:alert(1)', '--headless', 'chrome://settings'])
      expect(await answer(local('/api/browser/open', { pane: 'w0:p1', url }))).toEqual([
        400,
        { ok: false, error: 'url: an http or https address' },
      ])
    expect(
      await answer(local('/api/browser/open', { pane: 'w0:p1', url: 'https://example.com/', text: 'x'.repeat(2001) })),
    ).toEqual([400, { ok: false, error: 'text' }])
    expect(await answer(local('/api/browser/open', { pane: 'w0:p1', url: 'https://example.com/', text: 7 }))).toEqual([
      400,
      { ok: false, error: 'text' },
    ])
    expect(await answer(local('/api/browser/open', { pane: 'w0 p1;', url: 'https://example.com/' }))).toEqual([
      400,
      { ok: false, error: 'pane' },
    ])
    expect(await answer(local('/api/browser/open', { pane: 'w0:p9', url: 'https://example.com/' }))).toEqual([
      409,
      { ok: false, error: 'this session is not on the board' },
    ])
    // board browser run: the display of a session on the board only
    expect(await answer(local('/api/browser/display', { pane: 'w0:p9' }))).toEqual([
      409,
      { ok: false, error: 'this session is not on the board' },
    ])
    expect(await answer(local('/api/browser/display', { pane: 'w0 p1;' }))).toEqual([400, { ok: false, error: 'pane' }])
    // browser_close with no browser running: nothing to close
    expect(await answer(local('/api/browser/close', { pane: 'w0:p1' }))).toEqual([200, { ok: true, closed: false }])
    expect(await answer(local('/api/browser/close', { pane: 'w0 p1;' }))).toEqual([400, { ok: false, error: 'pane' }])
  })
})

describe('a board on a PC (no serverMode)', () => {
  const shared = sharedSandbox()
  let url = ''
  let proc: Child

  beforeAll(async () => {
    const box = await shared()
    oneSession(box)
    ;({ url, proc } = await serveBoard(box, { language: 'en', refreshSec: 1 }, { TEST_ROUTE_TABLE: '1' }))
  }, 30_000)

  test('no desktop routes, no card with `desktop`: those paths answer as any unknown one', async () => {
    const paths = routeTable(proc).map(r => r.path)
    expect(paths.some(p => p.includes('desktop') || p.includes('browser'))).toBe(false)
    const unknown = async (path: string, method: string) => {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        ...(method === 'POST' && { body: '{}' }),
      })
      return [res.status, await res.text()]
    }
    for (const method of ['GET', 'POST'])
      for (const path of [
        '/api/desktop/s1/vnc',
        '/api/desktop/s1/video',
        '/api/desktop/s1/control',
        '/api/browser/call',
      ])
        expect(await unknown(path, method)).toEqual(await unknown('/api/no-such-route/s1', method))
    let items: Record<string, unknown>[] = []
    for (let i = 0; i < 50 && !items.length; i++) {
      items = ((await (await fetch(`${url}/api/board`)).json()) as { items: Record<string, unknown>[] }).items
      if (!items.length) await Bun.sleep(100)
    }
    expect(items.map(i => i.key)).toEqual(['s1'])
    expect('desktop' in (items[0] ?? {})).toBe(false)
  })
})
