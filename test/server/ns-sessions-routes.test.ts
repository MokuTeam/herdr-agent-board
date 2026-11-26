// The NetSuite session store's routes (#860, server/routes/ns-sessions.ts) and its bridge tokens
// (adapters/ns-store-tokens.ts), dispatched as the board does: publish and get with and without
// the token, stale, ambiguous, touch, dead, lock and its contention, the list without values, a
// remote listener refused, a node's relayed request taken without the token, a node without its
// master 503. No cookie value in any log line, error body or list. Fake values only.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNsTokens, ensureNsToken, NS_TOKEN_FILE, nsBridgeDirs } from '../../src/adapters/ns-store-tokens.ts'
import { createNsStore, type NsStore, nsFingerprint } from '../../src/core/ns-sessions.ts'
import { dispatch, type GuardState, type Route } from '../../src/server/http.ts'
import { nsNodeGateRoute, nsSessionRoutes } from '../../src/server/routes/ns-sessions.ts'

const SECRET = 'fake-route-jsessionid-7f3a'
const SECOND = 'fake-route-jsessionid-9b21'
const TOKEN = 'a'.repeat(43)
const ACCOUNT = '1234567_SB1'
const USER = 'agent@example.com'

const cookie = (value: string) => [
  {
    name: 'JSESSIONID',
    value,
    domain: '1234567-sb1.app.netsuite.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
  },
  { name: 'NS_ROUTING_VERSION', value: 'fake-route-routing', domain: '.1234567-sb1.app.netsuite.com', path: '/' },
]
const entry = (value = SECRET, o: Record<string, unknown> = {}) => ({
  account: ACCOUNT,
  user: USER,
  host: '1234567-sb1.app.netsuite.com',
  cookies: cookie(value),
  origin: { machine: 'laptop', profile: 'work' },
  ...o,
})

interface Harness {
  call(
    method: string,
    path: string,
    o?: { body?: unknown; token?: string | null; header?: boolean; remote?: boolean; relayFrom?: string },
  ): Promise<{ status: number; text: string; json: unknown }>
  logs: string[]
  store: NsStore
}

function harness(o: { store?: NsStore | null; routes?: (r: Route[]) => Route[] } = {}): Harness {
  const store = o.store === undefined ? createNsStore() : o.store
  const logs: string[] = []
  const base = nsSessionRoutes({ store: () => store, tokenOk: t => t === TOKEN, log: l => logs.push(l) })
  const routes = o.routes ? o.routes(base) : base
  return {
    logs,
    store: store as NsStore,
    async call(method, path, c = {}) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (c.header !== false) headers['x-board'] = '1'
      const token = c.token === undefined ? TOKEN : c.token
      if (token !== null) headers['x-ns-store-token'] = token
      const req = new Request(`http://127.0.0.1:12999${path}`, {
        method,
        headers,
        ...(c.body !== undefined && { body: typeof c.body === 'string' ? c.body : JSON.stringify(c.body) }),
      })
      const url = new URL(req.url)
      const state: GuardState = {
        port: 12999,
        token: 'fs',
        stale: () => false,
        ...(c.remote && { remote: true }),
        ...(c.relayFrom && { relayFrom: c.relayFrom }),
      }
      const res = await dispatch(routes, req, url, decodeURIComponent(url.pathname), state)
      const text = await res.text()
      let json: unknown = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {}
      return { status: res.status, text, json }
    },
  }
}

describe('routes', () => {
  test('publish needs the token; get answers the values with it and nothing without', async () => {
    const h = harness()
    expect((await h.call('POST', '/api/ns-sessions/entry', { body: entry(), token: null })).status).toBe(401)
    expect((await h.call('POST', '/api/ns-sessions/entry', { body: entry(), token: 'b'.repeat(43) })).status).toBe(401)
    expect((await h.call('POST', '/api/ns-sessions/entry', { body: entry(), header: false })).status).toBe(403)
    const put = await h.call('POST', '/api/ns-sessions/entry', { body: entry() })
    expect(put.status).toBe(200)
    expect(put.json).toEqual({ ok: true, fp: nsFingerprint(SECRET), generation: 1, state: 'live' })

    const without = await h.call('GET', `/api/ns-sessions/entry?account=${ACCOUNT}&user=${USER}`, { token: null })
    expect(without.status).toBe(401)
    expect(without.text).not.toContain(SECRET)
    const got = await h.call('GET', `/api/ns-sessions/entry?account=1234567_sb1&user=Agent%40Example.com`)
    expect(got.status).toBe(200)
    expect(got.json).toMatchObject({ ok: true, fp: nsFingerprint(SECRET), generation: 1, user: USER })
    expect((got.json as { cookies: { value: string }[] }).cookies.map(c => c.value)).toContain(SECRET)
    // The encoded spelling of the value path is the value path.
    expect((await h.call('GET', `/api/ns-sessions/%65ntry?account=${ACCOUNT}`, { token: null })).status).toBe(401)
  })

  test('stale, ambiguous and none', async () => {
    const h = harness()
    await h.call('POST', '/api/ns-sessions/entry', { body: entry() })
    expect((await h.call('POST', '/api/ns-sessions/entry', { body: entry(SECOND) })).json).toMatchObject({
      generation: 2,
    })
    const stale = await h.call('POST', '/api/ns-sessions/entry', { body: entry() })
    expect(stale.status).toBe(409)
    expect(stale.json).toEqual({ ok: false, error: 'stale', fp: nsFingerprint(SECRET) })
    await h.call('POST', '/api/ns-sessions/entry', { body: entry(SECRET, { user: 'second@example.com' }) })
    const amb = await h.call('GET', `/api/ns-sessions/entry?account=${ACCOUNT}`)
    expect(amb.status).toBe(409)
    expect(amb.json).toEqual({ ok: false, error: 'ambiguous', users: [USER, 'second@example.com'] })
    expect(amb.text).not.toContain(SECRET)
    expect((await h.call('GET', '/api/ns-sessions/entry?account=7654321')).status).toBe(404)
    expect((await h.call('GET', '/api/ns-sessions/entry?account=bad-account')).json).toMatchObject({
      error: 'body',
      field: 'account',
    })
  })

  test('touch and dead: metadata only, no token; dead drops the values', async () => {
    const h = harness()
    await h.call('POST', '/api/ns-sessions/entry', { body: entry() })
    const fp = nsFingerprint(SECRET)
    const touch = await h.call('POST', '/api/ns-sessions/touch', {
      body: { account: ACCOUNT, user: USER, fp, where: 'server-2/main' },
      token: null,
    })
    expect(touch.status).toBe(204)
    expect(h.store.list()[0]?.last_activity.where).toBe('server-2/main')
    expect(
      (
        await h.call('POST', '/api/ns-sessions/touch', {
          body: { account: ACCOUNT, user: USER, fp: 'nothex!!', where: 'x' },
        })
      ).status,
    ).toBe(400)
    // An old fp is ignored.
    expect(
      (
        await h.call('POST', '/api/ns-sessions/dead', {
          body: { account: ACCOUNT, user: USER, fp: '00000000', reason: 'logout' },
        })
      ).status,
    ).toBe(204)
    expect(h.store.list()[0]?.state).toBe('live')
    expect(
      (await h.call('POST', '/api/ns-sessions/dead', { body: { account: ACCOUNT, user: USER, fp, reason: 'nope' } }))
        .status,
    ).toBe(400)
    const dead = await h.call('POST', '/api/ns-sessions/dead', {
      body: { account: ACCOUNT, user: USER, fp, reason: 'login-redirect' },
      token: null,
    })
    expect(dead.status).toBe(204)
    expect((await h.call('GET', `/api/ns-sessions/entry?account=${ACCOUNT}&user=${USER}`)).status).toBe(404)
    expect(h.store.list()[0]).toMatchObject({ state: 'dead', dead_reason: 'login-redirect' })
  })

  test('lock and its contention; unlock by its holder', async () => {
    const h = harness()
    const lock = (holder: string, ttl_s?: number) =>
      h.call('POST', '/api/ns-sessions/lock', {
        body: { account: ACCOUNT, user: USER, holder, ...(ttl_s !== undefined && { ttl_s }) },
        token: null,
      })
    const a = await lock('server-2/main', 90)
    expect(a.status).toBe(200)
    expect(a.json).toMatchObject({ ok: true })
    const b = await lock('laptop/work')
    expect(b.status).toBe(423)
    expect(b.json).toMatchObject({
      ok: false,
      error: 'locked',
      holder: 'server-2/main',
      until: (a.json as { until: number }).until,
    })
    expect((await lock('laptop/work', -1)).status).toBe(400)
    expect(
      (
        await h.call('POST', '/api/ns-sessions/unlock', {
          body: { account: ACCOUNT, user: USER, holder: 'laptop/work' },
        })
      ).status,
    ).toBe(204)
    expect((await lock('laptop/work')).status).toBe(423)
    expect(
      (
        await h.call('POST', '/api/ns-sessions/unlock', {
          body: { account: ACCOUNT, user: USER, holder: 'server-2/main' },
        })
      ).status,
    ).toBe(204)
    expect((await lock('laptop/work')).status).toBe(200)
  })

  test('the list: metadata, no token, no value', async () => {
    const h = harness()
    await h.call('POST', '/api/ns-sessions/entry', { body: entry() })
    const list = await h.call('GET', '/api/ns-sessions/list', { token: null })
    expect(list.status).toBe(200)
    expect(Array.isArray(list.json)).toBe(true)
    expect(list.json).toMatchObject([
      { account: ACCOUNT, user: USER, state: 'live', fp: nsFingerprint(SECRET), generation: 1 },
    ])
    expect(list.text).not.toContain(SECRET)
    expect(list.text).not.toContain('fake-route-routing')
    expect((await h.call('GET', '/api/ns-sessions/list', { header: false })).status).toBe(403)
  })

  test("a remote listener gets nothing; a relayed request is its node's to check", async () => {
    const h = harness()
    expect((await h.call('GET', '/api/ns-sessions/list', { remote: true })).status).toBe(403)
    expect((await h.call('POST', '/api/ns-sessions/entry', { body: entry(), remote: true })).status).toBe(403)
    const relayed = await h.call('POST', '/api/ns-sessions/entry', {
      body: entry(),
      remote: true,
      relayFrom: 'laptop',
      token: null,
    })
    expect(relayed.status).toBe(200)
    expect(h.logs.some(l => l.includes('via laptop'))).toBe(true)
    const back = await h.call('GET', `/api/ns-sessions/entry?account=${ACCOUNT}`, {
      remote: true,
      relayFrom: 'laptop',
      token: null,
    })
    expect(back.status).toBe(200)
  })

  test('a node without its master: 503 master-offline; its gate checks the token before the relay', async () => {
    const h = harness({ store: null })
    expect((await h.call('GET', '/api/ns-sessions/list')).json).toEqual({ ok: false, error: 'master-offline' })
    expect((await h.call('GET', '/api/ns-sessions/list')).status).toBe(503)
    const relayed: string[] = []
    const relay: Route = {
      method: 'ANY',
      path: /^\/api\//,
      handle: req => {
        relayed.push(req.method)
        return new Response(null, { status: 299 })
      },
    }
    const g = harness({ store: null, routes: r => [nsNodeGateRoute(t => t === TOKEN), relay, ...r] })
    expect((await g.call('POST', '/api/ns-sessions/entry', { body: entry(), token: null })).status).toBe(401)
    expect((await g.call('GET', `/api/ns-sessions/entry?account=${ACCOUNT}`, { token: 'x' })).status).toBe(401)
    expect(relayed).toEqual([])
    expect((await g.call('POST', '/api/ns-sessions/entry', { body: entry() })).status).toBe(299)
    expect((await g.call('GET', '/api/ns-sessions/list', { token: null })).status).toBe(299)
    expect((await g.call('POST', '/api/ns-sessions/touch', { body: {}, token: null })).status).toBe(299)
    expect(relayed).toEqual(['POST', 'GET', 'POST'])
  })

  test('no value in a log line or an error body, whatever goes wrong', async () => {
    const h = harness()
    const bodies: string[] = []
    const bad = entry()
    bad.cookies[0] = { ...bad.cookies[0], domain: '.netsuite.com' } as (typeof bad.cookies)[0]
    for (const b of [bad, entry(`${SECRET}\n`), { ...entry(), host: 'x.app.netsuite.com' }, `{"cookies":"${SECRET}"`])
      bodies.push((await h.call('POST', '/api/ns-sessions/entry', { body: b })).text)
    expect(bodies.map(b => JSON.parse(b).error)).toEqual(['body', 'body', 'body', 'body'])
    await h.call('POST', '/api/ns-sessions/entry', { body: entry() })
    await h.call('POST', '/api/ns-sessions/entry', { body: entry(SECOND) })
    await h.call('POST', '/api/ns-sessions/dead', {
      body: { account: ACCOUNT, user: USER, fp: nsFingerprint(SECOND), reason: 'logout' },
    })
    bodies.push((await h.call('POST', '/api/ns-sessions/entry', { body: entry() })).text)
    expect(h.logs.length).toBeGreaterThan(0)
    for (const text of [...h.logs, ...bodies]) {
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(SECOND)
      expect(text).not.toContain('fake-route-routing')
    }
  })
})

describe('bridge tokens', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const temp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'ns-tokens-'))
    dirs.push(d)
    return d
  }

  test("a server node's bridge dirs are found; a home without them gets nothing", () => {
    const home = temp()
    expect(nsBridgeDirs(home, {})).toEqual([])
    for (const p of ['main', 'alpha'])
      mkdirSync(join(home, 'browser', 'state', p, 'state', 'mcp-chrome-bridge'), { recursive: true })
    mkdirSync(join(home, 'browser', 'state', 'empty', 'state'), { recursive: true })
    expect(nsBridgeDirs(home, {})).toEqual([
      join(home, 'browser', 'state', 'alpha', 'state', 'mcp-chrome-bridge'),
      join(home, 'browser', 'state', 'main', 'state', 'mcp-chrome-bridge'),
    ])
    // The bridge's own state dir, as the bridge picks it on each platform.
    const linux = join(home, '.local', 'state', 'mcp-chrome-bridge')
    mkdirSync(linux, { recursive: true })
    expect(nsBridgeDirs(home, {}, 'linux')[0]).toBe(linux)
    const xdg = temp()
    mkdirSync(join(xdg, 'mcp-chrome-bridge'))
    expect(nsBridgeDirs(home, { XDG_STATE_HOME: xdg }, 'linux')[0]).toBe(join(xdg, 'mcp-chrome-bridge'))
    const local = temp()
    mkdirSync(join(local, 'mcp-chrome-bridge'))
    expect(nsBridgeDirs(home, { LOCALAPPDATA: local }, 'win32')).toEqual([
      join(local, 'mcp-chrome-bridge'),
      join(home, 'browser', 'state', 'alpha', 'state', 'mcp-chrome-bridge'),
      join(home, 'browser', 'state', 'main', 'state', 'mcp-chrome-bridge'),
    ])
    mkdirSync(join(home, 'Library', 'Logs', 'mcp-chrome-bridge'), { recursive: true })
    expect(nsBridgeDirs(home, {}, 'darwin')[0]).toBe(join(home, 'Library', 'Logs', 'mcp-chrome-bridge'))
    expect(nsBridgeDirs(home, { MOKUTAB_UPDATE_STATE_DIR: xdg }, 'linux')[0]).toBe(xdg)
    const given = temp()
    expect(
      nsBridgeDirs(home, {
        BOARD_NS_BRIDGE_DIRS: `${given}${process.platform === 'win32' ? ';' : ':'}${join(given, 'missing')}`,
      }),
    ).toEqual([given])
  })

  test('one token a dir, 0600, kept across starts; a broken file gets a new one', () => {
    const d = temp()
    const t = ensureNsToken(d)
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(readFileSync(join(d, NS_TOKEN_FILE), 'utf8').trim()).toBe(t as string)
    if (process.platform !== 'win32') expect(statSync(join(d, NS_TOKEN_FILE)).mode & 0o777).toBe(0o600)
    expect(ensureNsToken(d)).toBe(t)
    writeFileSync(join(d, NS_TOKEN_FILE), 'not a token')
    const fresh = ensureNsToken(d)
    expect(fresh).not.toBe(t)
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('check: the tokens written; a bridge that came later is found on the next miss, at most once a minute', () => {
    const a = temp()
    const b = temp()
    let t = 1_000_000
    const list = [a]
    const tokens = createNsTokens({ dirs: () => [...list], now: () => t })
    expect(tokens.refresh()).toBe(1)
    const ta = readFileSync(join(a, NS_TOKEN_FILE), 'utf8').trim()
    expect(tokens.check(ta)).toBe(true)
    expect(tokens.check(null)).toBe(false)
    expect(tokens.check('short')).toBe(false)
    list.push(b)
    // Within the minute nothing is rescanned, so b has no file yet.
    expect(tokens.check('c'.repeat(43))).toBe(false)
    expect(() => readFileSync(join(b, NS_TOKEN_FILE))).toThrow()
    t += 61_000
    expect(tokens.check('c'.repeat(43))).toBe(false)
    const tb = readFileSync(join(b, NS_TOKEN_FILE), 'utf8').trim()
    expect(tokens.check(tb)).toBe(true)
    expect(tokens.check(ta)).toBe(true)
  })
})
