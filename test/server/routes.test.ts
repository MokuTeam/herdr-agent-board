// What main's server (94fdde6) answers outside the happy paths: the Host check, the page's own
// files and their headers, the JSON body limits, the 405 fallback, and the order in which its `if`
// chain matched (prefix routes, a missing session before any guard).
import { beforeAll, describe, expect, test } from 'bun:test'
import { connect } from 'node:net'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'

const PAGE_CSP =
  "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"

/** A request written by hand (fetch always sends its own Host); the whole answer as text. */
function rawRequest(port: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1', () => socket.write(request))
    let text = ''
    socket.on('data', chunk => {
      text += chunk.toString('utf8')
    })
    socket.on('end', () => resolve(text))
    socket.on('error', reject)
  })
}
const rawGet = (port: string, path: string, host: string) =>
  rawRequest(port, `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
/** The status line's code and the body of a raw answer (chunked or not). */
const statusAndBody = (text: string) => {
  const [head = '', body = ''] = text.split('\r\n\r\n')
  return [head.split(' ')[1], body.includes('{') ? body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1) : body]
}

// A pi session's key is its session file: `/` in it, sent encoded as one segment.
const PI_KEY = '/home/me/.pi/agent/sessions/--home-me--/2026-10-20T05-10-02-695Z_01a1.jsonl'
const PI = encodeURIComponent(PI_KEY)

describe('routes', () => {
  const sandbox = sharedSandbox()
  let url = ''
  const post = (path: string, body: unknown, headers: Record<string, string> = { 'x-board': '1' }) =>
    fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  const answer = async (res: Response | Promise<Response>) => {
    const r = await res
    return [r.status, await r.json()]
  }

  beforeAll(async () => {
    const box = await sandbox()
    const snapshot = {
      panes: [
        { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir },
        { pane_id: 'p2', agent: 'pi', agent_session: { value: PI_KEY }, agent_status: 'idle', cwd: box.dir },
      ],
      tabs: [],
      workspaces: [],
    }
    box.state({ 'api snapshot': { result: { snapshot } } })
    ;({ url } = await serveBoard(box, { language: 'en' }))
    const deadline = Date.now() + 5000
    while (((await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }).stale) {
      if (Date.now() > deadline) throw new Error('not fresh')
      await Bun.sleep(10)
    }
  }, 20_000)

  test('only its own Host: 127.0.0.1 or localhost with its port', async () => {
    const port = new URL(url).port
    expect(await rawGet(port, '/api/board', `evil.example:${port}`)).toMatch(/^HTTP\/1\.1 403[\s\S]*\{"error":"host"\}/)
    expect(await rawGet(port, '/api/board', '127.0.0.1:1')).toMatch(/^HTTP\/1\.1 403/)
    expect(await rawGet(port, '/api/board', `localhost:${port}`)).toMatch(/^HTTP\/1\.1 200/)
  })

  test('an empty or invalid Host, or none at all, is refused like any other', async () => {
    const port = new URL(url).port
    const host = ['403', '{"error":"host"}']
    expect(statusAndBody(await rawGet(port, '/api/board', ''))).toEqual(host)
    expect(statusAndBody(await rawGet(port, '/api/board', 'a b'))).toEqual(host)
    expect(statusAndBody(await rawRequest(port, 'GET /api/board HTTP/1.0\r\n\r\n'))).toEqual(host)
    expect(statusAndBody(await rawRequest(port, 'GET / HTTP/1.0\r\n\r\n'))).toEqual(host)
    // The board goes on answering its own page.
    expect(await rawGet(port, '/', `127.0.0.1:${port}`)).toMatch(/^HTTP\/1\.1 200/)
  })

  test('JSON answers: their content type and no caching', async () => {
    const res = await fetch(`${url}/api/board`)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const refused = await post('/api/settings', {}, {})
    expect(refused.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(refused.headers.get('cache-control')).toBe('no-store')
    expect(await answer(refused)).toEqual([403, { error: 'header' }])
  })

  test('the page: index.html with its policy, the bundle, styles and the icon', async () => {
    const page = await fetch(`${url}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('content-security-policy')).toBe(PAGE_CSP)
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    expect(page.headers.get('cache-control')).toBe('no-cache')
    const html = await page.text()
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('<div id="root"></div>')
    // The React page: every file it links to is served.
    const links = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1])
    expect(links).toEqual([
      'icon.svg',
      'theme.js',
      'styles/app.css',
      'styles/setup.css',
      'styles/menu.css',
      'styles/launch.css',
      'styles/questions.css',
      'styles/terminal.css',
      'styles/helpers.css',
      'styles/profiles.css',
      'styles/workspaces.css',
      'styles/fold.css',
      'styles/session-head.css',
      'styles/fork.css',
      'styles/aside.css',
      'styles/favorites.css',
      'styles/cards.css',
      'styles/categories.css',
      'app.js',
    ])
    for (const link of links) expect([link, (await fetch(`${url}/${link}`)).status]).toEqual([link, 200])
    const script = await fetch(`${url}/app.js`)
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(script.headers.get('content-security-policy')).toBe(null)
    expect((await script.text()).length).toBeGreaterThan(1000)
    // Before the page paints, the viewer's light or dark: a classic script (no import or export of its own).
    const theme = await fetch(`${url}/theme.js`)
    expect(theme.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    const early = await theme.text()
    expect(early).toContain('board.theme')
    expect(early).not.toMatch(/^\s*(import|export)\b/m)
    for (const sheet of [
      'app',
      'menu',
      'launch',
      'questions',
      'terminal',
      'helpers',
      'profiles',
      'workspaces',
      'fold',
      'favorites',
      'cards',
    ])
      expect((await fetch(`${url}/styles/${sheet}.css`)).headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect((await fetch(`${url}/icon.svg`)).headers.get('content-type')).toBe('image/svg+xml')
    // Only top-level files and styles/ of the types it knows: nothing else under web/ (the page's source).
    for (const path of [
      '/notes.txt',
      '/missing.css',
      '/app.css',
      '/src/main.tsx',
      '/src/App.tsx',
      '/styles/missing.css',
      '/styles%2F..%2Fsrc%2Fmain.tsx',
      '/styles/..%2F..%2Fpackage.json',
      '/api/nothing',
    ])
      expect([path, ...(await answer(fetch(url + path)))]).toEqual([path, 404, { error: 'not found' }])
  })

  test('anything else that matches no route: 405', async () => {
    expect(await answer(fetch(`${url}/api/board`, { method: 'PUT' }))).toEqual([405, { error: 'method' }])
    expect(await answer(fetch(`${url}/`, { method: 'DELETE' }))).toEqual([405, { error: 'method' }])
    expect(await answer(post('/api/nothing', {}))).toEqual([405, { error: 'method' }])
  })

  test('a JSON body that does not parse, or is over 192 KB, is a 500', async () => {
    expect(await answer(post('/api/settings', '{nope'))).toEqual([500, { error: 'bad json' }])
    expect(await answer(post('/api/settings', { pad: 'x'.repeat(200_000) }))).toEqual([
      500,
      { error: 'body too large' },
    ])
    // The bytes count: 70 000 characters of three bytes each are over it too.
    expect(await answer(post('/api/settings', { pad: '漢'.repeat(70_000) }))).toEqual([
      500,
      { error: 'body too large' },
    ])
  })

  test('a body of null fails only where main read a field off it', async () => {
    // Read and left alone, or read with ?. (settings, categories, a launch's request).
    expect((await answer(post('/api/launch/nope/dismiss', 'null')))[0]).toBe(404)
    expect(await answer(post('/api/launcher', 'null'))).toEqual([404, { error: 'not found' }])
    expect(await answer(post('/api/session/s1/wake', 'null'))).toEqual([200, { ok: true }])
    expect(await answer(post('/api/session/s1/bogus', 'null'))).toEqual([
      409,
      { ok: false, error: 'unknown action bogus' },
    ])
    expect(await answer(post('/api/settings', 'null'))).toEqual([200, { ok: true }])
    expect(await answer(post('/api/categories', 'null'))).toEqual(await answer(post('/api/categories', {})))
    expect(await answer(post('/api/launch', 'null'))).toEqual(await answer(post('/api/launch', {})))
    // Read field by field: main's TypeError, a 500.
    for (const path of ['/api/fs/stat', '/api/fs/preview', '/api/open-url', '/api/schedule', '/api/session/s1/card']) {
      const [status, body] = await answer(post(path, 'null'))
      expect([path, status, (body as { error: string }).error]).toEqual([path, 500, expect.stringMatching(/null/)])
    }
  })

  test('prefix routes: everything under /api/fs/ and /api/launch takes their guards', async () => {
    // POST /api/fs/raw is the folder routes' (no path: 400), not the raw bytes' GET.
    expect(await answer(post('/api/fs/raw', {}))).toEqual([400, { error: 'Not found: ' }])
    expect(await answer(post('/api/fs/other', { path: '/' }))).toEqual([404, { error: 'not found' }])
    expect(await answer(post('/api/fs/other', {}, {}))).toEqual([403, { error: 'header' }])
    expect(await answer(fetch(`${url}/api/fs/raw?path=x`))).toEqual([403, { error: 'token' }])
    expect(await answer(post('/api/launcher', {}))).toEqual([404, { error: 'not found' }])
    expect(await answer(post('/api/launcher', {}, {}))).toEqual([403, { error: 'header' }])
    expect(await answer(post('/api/launcher', {}, { 'x-board': '1', origin: 'http://evil.example' }))).toEqual([
      403,
      { error: 'origin' },
    ])
    expect((await answer(post('/api/launch/nope/dismiss', {})))[0]).toBe(404)
    expect(await answer(post('/api/launch/nope/dismiss', '{bad'))).toEqual([500, { error: 'bad json' }])
    const options = await fetch(`${url}/api/launch/options`)
    expect(options.status).toBe(200)
    expect(Object.keys((await options.json()) as object).sort()).toEqual([
      'board',
      'error',
      'focused',
      'launcher',
      'recent',
      'workspaces',
    ])
  })

  test('a missing session is a 404 whatever is asked, before any guard', async () => {
    const gone = { error: 'The session is no longer on the board' }
    expect(await answer(fetch(`${url}/api/session/nope`))).toEqual([404, gone])
    expect(await answer(fetch(`${url}/api/session/nope/changes`))).toEqual([404, gone])
    expect(await answer(post('/api/session/nope/focus', {}, {}))).toEqual([404, gone])
    expect(await answer(fetch(`${url}/api/session/nope/x`, { method: 'PUT' }))).toEqual([404, gone])
  })

  test('a session: its detail, its guards, and what falls through to the page and 405', async () => {
    const detail = await fetch(`${url}/api/session/s1`)
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as { item: { key: string; transcript?: unknown } }
    expect(Object.keys(body)).toEqual([
      'item',
      'conversation',
      'queued',
      'helpers',
      'workflows',
      'screen',
      'dialog',
      'checkout',
    ])
    expect(body.item.key).toBe('s1')
    expect('transcript' in body.item).toBe(false)
    expect(await answer(fetch(`${url}/api/session/s1/other`))).toEqual([404, { error: 'not found' }])
    expect(await answer(fetch(`${url}/api/session/s1`, { method: 'PUT' }))).toEqual([405, { error: 'method' }])
    expect(await answer(post('/api/session/s1', {}))).toEqual([405, { error: 'method' }])
    expect(await answer(post('/api/session/s1/card', {}, {}))).toEqual([403, { error: 'header' }])
    expect(await answer(post('/api/session/s1/permit', {}, { 'x-board': '1', origin: 'http://evil.example' }))).toEqual(
      [403, { error: 'origin' }],
    )
    // The origin rule is for answers only; other actions take any page that sends the header.
    expect(await answer(post('/api/session/s1/bogus', {}, { 'x-board': '1', origin: 'http://evil.example' }))).toEqual([
      409,
      { ok: false, error: 'unknown action bogus' },
    ])
  })

  test('a session whose key has a slash (pi): every route finds it', async () => {
    const detail = await fetch(`${url}/api/session/${PI}`)
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as { item: { key: string } }).item.key).toBe(PI_KEY)
    expect((await fetch(`${url}/api/session/${PI}/changes`)).status).toBe(200)
    expect(await answer(post(`/api/session/${PI}/card`, { ask: '' }))).toEqual([
      200,
      expect.objectContaining({ ok: true }),
    ])
    // The terminal's stream finds the session too, and asks for the page's token like any other.
    expect(await answer(fetch(`${url}/api/term/${PI}/agent/stream`))).toEqual([403, { error: 'token' }])
    // Decoded too early, the key was cut at its first slash and the page got "not found".
    expect(await answer(fetch(`${url}/api/session/%2Fnope%2Fx.jsonl`))).toEqual([
      404,
      { error: 'The session is no longer on the board' },
    ])
  })

  test('how sessions asleep in "Waiting" fold: the board says (push unless config.json says otherwise); Settings take a known way', async () => {
    const board = (await (await fetch(`${url}/api/board`)).json()) as { foldWaiting?: string }
    expect(board.foldWaiting).toBe('push')
    expect(await answer(post('/api/settings', { foldWaiting: 'sideways' }))).toEqual([
      409,
      { ok: false, error: 'Unknown way to fold sideways' },
    ])
    expect(await answer(post('/api/settings', { foldWaiting: 'push' }))).toEqual([200, { ok: true }])
  })

  test('settings and categories: refusals answer 409', async () => {
    expect(await answer(post('/api/settings', { language: 'xx' }))).toEqual([
      409,
      { ok: false, error: 'Unknown language xx' },
    ])
    const [status] = await answer(post('/api/categories', { op: 'delete', id: 'other' }))
    expect(status).toBe(409)
    expect(await answer(post('/api/categories', { op: 'order', ids: ['other'] }))).toEqual([200, { ok: true }])
  })
})
