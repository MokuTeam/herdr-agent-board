// The NetSuite session store's routes (#860, server/routes/ns-sessions.ts, contract
// ns-store-contract-v1.md) and its bridge token files (adapters/ns-store-tokens.ts), dispatched as
// the board does: X-Board and the token on every call (the list may go without the token), the
// {ok, code, message} answers, publish and get, dead_fp, ambiguous_user, touch and dead by fp, the
// lock and its release by holder, a remote listener refused, a node's relayed request taken
// without the token, a node's route that checks the token before the relay and turns the relay's
// own failures into store_unavailable. No cookie value in any log line or error body.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNsTokens,
  ensureNsToken,
  NS_DEFAULT_URL,
  NS_TOKEN_FILE,
  nsBridgeDirs,
} from '../../src/adapters/ns-store-tokens.ts'
import { createNsStore, type NsStore, nsFingerprint } from '../../src/core/ns-sessions.ts'
import { NO_NS_NOTIFY_PREFS, type NsNotifyPrefs, setAccountNotify } from '../../src/core/ns-sessions-notify.ts'
import { dispatch, type GuardState, type Route } from '../../src/server/http.ts'
import { type NsRelay, nsNodeRoute, nsSessionRoutes } from '../../src/server/routes/ns-sessions.ts'

const SECRET = 'fake-route-jsessionid-7f3a'
const SECOND = 'fake-route-jsessionid-9b21'
const ROUTING = 'fake-route-routing'
const TOKEN = 'a'.repeat(43)
const A = '1234567_SB1'
const U = 'agent@example.com'
const SERVER = { machine: 'server-2', profile: 'main' }
const LAPTOP = { machine: 'laptop', profile: 'work' }

const entry = (value = SECRET, o: Record<string, unknown> = {}) => ({
  account: A,
  user: U,
  host: '1234567-sb1.app.netsuite.com',
  role: null,
  role_id: null,
  fp: nsFingerprint(value),
  cookies: [
    {
      name: 'JSESSIONID',
      value,
      domain: '1234567-sb1.app.netsuite.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    },
    { name: 'NS_ROUTING_VERSION', value: ROUTING, domain: '.1234567-sb1.app.netsuite.com', path: '/' },
  ],
  origin: LAPTOP,
  login_at: null,
  seen_at: 1_800_000_000_000,
  ...o,
})

interface Call {
  body?: unknown
  token?: string | null
  board?: boolean
  remote?: boolean
  relayFrom?: string
  client?: string
}

function harness(o: { store?: NsStore | null; routes?: (r: Route[]) => Route[] } = {}) {
  const store = o.store === undefined ? createNsStore() : o.store
  const logs: string[] = []
  let prefs: NsNotifyPrefs = NO_NS_NOTIFY_PREFS
  const base = nsSessionRoutes({
    store: () => store,
    tokenOk: t => t === TOKEN,
    prefs: {
      get: () => prefs,
      set: (account, val) => {
        prefs = setAccountNotify(prefs, account, val)
        return prefs
      },
    },
    log: l => logs.push(l),
  })
  const routes = o.routes ? o.routes(base) : base
  return {
    logs,
    routes,
    store: store as NsStore,
    async call(method: string, path: string, c: Call = {}) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (c.board !== false) headers['x-board'] = '1'
      const token = c.token === undefined ? TOKEN : c.token
      if (token !== null) headers['x-ns-store-token'] = token
      if (c.client) headers['x-ns-store-client'] = c.client
      const req = new Request(`http://127.0.0.1:12999/api/ns-sessions/${path}`, {
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
      let json: Record<string, unknown> = {}
      try {
        json = text ? JSON.parse(text) : {}
      } catch {}
      return { status: res.status, text, json }
    },
  }
}

const holder = { ...SERVER, run_id: 'run-1' }

describe('routes', () => {
  test('X-Board and the token on every call; the list may go without the token', async () => {
    const h = harness()
    const calls: [string, string, unknown][] = [
      ['POST', 'entry', entry()],
      ['GET', `entry?account=${A}`, undefined],
      ['POST', 'touch', { account: A, fp: nsFingerprint(SECRET), where: SERVER, at: 1 }],
      ['POST', 'dead', { account: A, fp: '00000000', reason: 'logout', where: SERVER }],
      ['POST', 'lock', { account: A, user: U, holder }],
      ['POST', 'unlock', { account: A, user: U, holder }],
      ['GET', 'list', undefined],
    ]
    for (const [method, path, body] of calls) {
      const tokens = path === 'list' ? ['b'.repeat(43)] : [null, 'b'.repeat(43)]
      for (const token of tokens) {
        const r = await h.call(method, path, { body, token })
        expect(r.status).toBe(401)
        expect(r.json).toEqual({ ok: false, code: 'unauthorized', message: 'missing or unknown X-NS-Store-Token' })
      }
      const noBoard = await h.call(method, path, { body, board: false })
      expect(noBoard.status).toBe(401)
      expect(noBoard.json).toMatchObject({ ok: false, code: 'unauthorized', message: 'X-Board: 1 is missing' })
    }
    expect((await h.call('GET', 'list', { token: null })).json).toEqual({ ok: true, entries: [], notify: {} })
    expect((await h.call('GET', 'list')).status).toBe(200)
    // The store has POST and GET only: the relay carries no other method.
    expect((await h.call('PUT', 'entry', { body: entry() })).status).toBe(405)
    expect((await h.call('DELETE', 'lock', { body: {} })).status).toBe(405)
  })

  test('publish and get: stored, the values with the token, dead_fp, ambiguous_user, none', async () => {
    const h = harness()
    const put = await h.call('POST', 'entry', { body: entry(), client: 'mokutab/2.2.0 laptop/work' })
    expect(put).toMatchObject({ status: 200, json: { ok: true, stored: true, generation: 1, state: 'live' } })
    expect(h.logs).toEqual([
      `ns-sessions: ${A} published fp ${nsFingerprint(SECRET)} gen 1 by laptop/work [mokutab/2.2.0 laptop/work]`,
    ])
    expect((await h.call('POST', 'entry', { body: entry() })).json).toMatchObject({ stored: false, generation: 1 })
    const got = await h.call('GET', 'entry?account=1234567_sb1&user=Agent%40Example.com')
    expect(got.status).toBe(200)
    expect(got.json).toMatchObject({
      ok: true,
      account: A,
      user: U,
      fp: nsFingerprint(SECRET),
      generation: 1,
      state: 'live',
    })
    expect((got.json.cookies as { value: string }[]).map(c => c.value)).toContain(SECRET)

    await h.call('POST', 'dead', {
      body: { account: A, fp: nsFingerprint(SECRET), reason: 'login_redirect', where: SERVER },
    })
    const dead = await h.call('POST', 'entry', { body: entry() })
    expect(dead.status).toBe(409)
    expect(dead.json).toMatchObject({ ok: false, code: 'dead_fp' })
    expect((await h.call('GET', `entry?account=${A}&user=${U}`)).json).toMatchObject({ ok: false, code: 'none' })
    expect((await h.call('GET', `entry?account=${A}`)).status).toBe(404)

    await h.call('POST', 'entry', { body: entry(SECOND) })
    await h.call('POST', 'entry', { body: entry(SECRET.replace('7f3a', '0000'), { user: 'second@example.com' }) })
    const amb = await h.call('GET', `entry?account=${A}`)
    expect(amb.status).toBe(409)
    expect(amb.json).toMatchObject({ ok: false, code: 'ambiguous_user' })
    expect((amb.json.users as { user: string }[]).map(u => u.user).sort()).toEqual([U, 'second@example.com'])
    expect(amb.text).not.toContain(SECRET)
    expect((await h.call('GET', 'entry?account=bad-account')).json).toEqual({
      ok: false,
      code: 'bad_request',
      message: 'bad account',
    })
  })

  test('touch and dead by fp: matched or not', async () => {
    const h = harness()
    await h.call('POST', 'entry', { body: entry() })
    const fp = nsFingerprint(SECRET)
    expect((await h.call('POST', 'touch', { body: { account: A, fp, where: SERVER, at: 1 } })).json).toEqual({
      ok: true,
      matched: true,
      state: 'live',
    })
    expect((await h.call('POST', 'touch', { body: { account: A, fp: '00000000', where: SERVER } })).json).toEqual({
      ok: true,
      matched: false,
      state: null,
    })
    expect((await h.call('POST', 'touch', { body: { account: A, fp: 'nothex!!', where: SERVER } })).status).toBe(400)
    expect((await h.call('POST', 'dead', { body: { account: A, fp, reason: 'nope', where: SERVER } })).status).toBe(400)
    expect((await h.call('POST', 'dead', { body: { account: A, fp, reason: 'switch' } })).json).toMatchObject({
      message: 'bad where',
    })
    expect((await h.call('POST', 'dead', { body: { account: A, fp, reason: 'switch', where: SERVER } })).json).toEqual({
      ok: true,
      matched: true,
    })
    expect((await h.call('POST', 'dead', { body: { account: A, fp, reason: 'switch', where: SERVER } })).json).toEqual({
      ok: true,
      matched: false,
    })
    expect(h.store.list()[0]).toMatchObject({ state: 'dead', dead_reason: 'switch' })
  })

  test('lock: locked for another holder, at most 120 s; unlock by holder answers 204', async () => {
    const h = harness()
    const a = await h.call('POST', 'lock', { body: { account: A, user: U, holder, ttl_s: 900 } })
    expect(a.status).toBe(200)
    const { lock_id, until } = a.json as { lock_id: string; until: number }
    expect(lock_id).toMatch(/^[0-9a-f-]{36}$/)
    const other = { ...LAPTOP, run_id: 'run-2' }
    const b = await h.call('POST', 'lock', { body: { account: A, user: U, holder: other } })
    expect(b.status).toBe(409)
    expect(b.json).toMatchObject({ ok: false, code: 'locked', holder, until })
    expect((b.json.until as number) - Date.now()).toBeLessThanOrEqual(120_000)
    expect((await h.call('POST', 'lock', { body: { account: A, user: U, holder, ttl_s: -1 } })).status).toBe(400)
    expect((await h.call('POST', 'lock', { body: { account: A, user: U, holder: SERVER } })).json).toMatchObject({
      message: 'bad holder',
    })
    // Another holder's unlock: 204, and the lock stays.
    const wrong = await h.call('POST', 'unlock', { body: { account: A, user: U, holder: other } })
    expect(wrong.status).toBe(204)
    expect(wrong.text).toBe('')
    expect((await h.call('POST', 'lock', { body: { account: A, user: U, holder: other } })).status).toBe(409)
    expect((await h.call('POST', 'unlock', { body: { account: A, user: U, holder } })).status).toBe(204)
    expect((await h.call('POST', 'lock', { body: { account: A, user: U, holder: other } })).status).toBe(200)
    // Nothing held: 204 too.
    expect((await h.call('POST', 'unlock', { body: { account: A, user: 'nobody@example.com', holder } })).status).toBe(
      204,
    )
  })

  test('the list: entries, by account, no value', async () => {
    const h = harness()
    await h.call('POST', 'entry', { body: entry() })
    const list = await h.call('GET', 'list')
    expect(list.json).toMatchObject({
      ok: true,
      entries: [{ account: A, user: U, state: 'live', fp: nsFingerprint(SECRET) }],
    })
    expect(Object.keys((list.json.entries as Record<string, unknown>[])[0] ?? {}).sort()).toEqual(
      [
        'abs_expiry',
        'abs_expiry_estimated',
        'account',
        'auto_renew',
        'dead_at',
        'dead_reason',
        'first_seen',
        'fp',
        'generation',
        'holders',
        'host',
        'idle_expiry',
        'last_activity',
        'last_event',
        'last_where',
        'lock',
        'login_at',
        'origin',
        'role',
        'state',
        'user',
      ].sort(),
    )
    expect((await h.call('GET', 'list?account=7654321')).json).toEqual({ ok: true, entries: [], notify: {} })
    expect(list.text).not.toContain(SECRET)
    expect(list.text).not.toContain(ROUTING)
  })

  test('bodies over 64 KB, or not JSON, or with a wrong fp, are bad_request', async () => {
    const h = harness()
    const big = entry(SECRET, { pad: 'x'.repeat(70 * 1024) })
    expect((await h.call('POST', 'entry', { body: big })).json).toMatchObject({
      code: 'bad_request',
      message: 'bad body',
    })
    expect((await h.call('POST', 'entry', { body: '{"cookies":' })).json).toMatchObject({ code: 'bad_request' })
    expect((await h.call('POST', 'entry', { body: entry(SECRET, { fp: nsFingerprint(SECOND) }) })).json).toMatchObject({
      code: 'bad_request',
      message: 'bad fp',
    })
  })

  test("a remote listener gets nothing; a relayed request is its node's to check", async () => {
    const h = harness()
    expect((await h.call('GET', 'list', { remote: true })).status).toBe(401)
    expect((await h.call('POST', 'entry', { body: entry(), remote: true })).status).toBe(401)
    const relayed = await h.call('POST', 'entry', { body: entry(), remote: true, relayFrom: 'laptop', token: null })
    expect(relayed.status).toBe(200)
    expect(h.logs.at(-1)).toContain(' via laptop')
    expect((await h.call('GET', `entry?account=${A}`, { remote: true, relayFrom: 'laptop', token: null })).status).toBe(
      200,
    )
  })

  test('a pure node holds no store: 503 store_unavailable', async () => {
    const h = harness({ store: null })
    const r = await h.call('GET', 'list')
    expect(r.status).toBe(503)
    expect(r.json).toMatchObject({ ok: false, code: 'store_unavailable' })
  })

  test("a node's route: X-Board and the token here, then the relay; the relay's own failures are store_unavailable", async () => {
    const sent: { method: string; path: string }[] = []
    let answer: Response | undefined = new Response(null, { status: 299 })
    const relay: NsRelay = {
      relay: async (req, caller) => {
        sent.push({ method: req.method, path: caller.rawPath })
        return answer
      },
    }
    const g = harness({ store: null, routes: r => [nsNodeRoute(relay, t => t === TOKEN), ...r] })
    expect((await g.call('POST', 'entry', { body: entry(), token: null })).status).toBe(401)
    expect((await g.call('GET', `entry?account=${A}`, { token: 'x' })).status).toBe(401)
    expect((await g.call('GET', 'list', { board: false })).status).toBe(401)
    expect(sent).toEqual([])
    expect((await g.call('POST', 'entry', { body: entry() })).status).toBe(299)
    expect((await g.call('GET', 'list', { token: null })).status).toBe(299)
    expect((await g.call('POST', 'unlock', { body: {} })).status).toBe(299)
    expect(sent).toEqual([
      { method: 'POST', path: '/api/ns-sessions/entry' },
      { method: 'GET', path: '/api/ns-sessions/list' },
      { method: 'POST', path: '/api/ns-sessions/unlock' },
    ])
    // The store's own answers pass as they came.
    answer = new Response(JSON.stringify({ ok: false, code: 'locked', message: 'm', holder: {} }), { status: 409 })
    expect((await g.call('POST', 'lock', { body: {} })).json).toMatchObject({ code: 'locked' })
    // The relay's own: the master away, a timeout, a master without the store, a handover.
    for (const [status, body] of [
      [503, { ok: false, error: 'node-master-offline', message: 'x' }],
      [504, { ok: false, error: 'master-relay-timeout', message: 'x' }],
      [404, { ok: false, error: 'master-relay-path', message: 'x' }],
      [405, { error: 'method' }],
      [503, { error: 'handover-frozen' }],
    ] as const) {
      answer = new Response(JSON.stringify(body), { status })
      const r = await g.call('GET', 'list')
      expect(r.status).toBe(503)
      expect(r.json).toMatchObject({ ok: false, code: 'store_unavailable' })
    }
    // A node that does not relay: the routes below, which hold no store here.
    answer = undefined
    expect((await g.call('GET', 'list')).json).toMatchObject({ code: 'store_unavailable' })
  })

  test('no value in a log line or an error body, whatever goes wrong', async () => {
    const h = harness()
    const texts: string[] = []
    const bad = entry()
    bad.cookies[0] = { ...bad.cookies[0], domain: '.netsuite.com' } as (typeof bad.cookies)[0]
    for (const b of [bad, entry(`${SECRET}\n`), { ...entry(), host: 'x.app.netsuite.com' }, `{"cookies":"${SECRET}"`])
      texts.push((await h.call('POST', 'entry', { body: b })).text)
    expect(texts.map(t => JSON.parse(t).code)).toEqual(['bad_request', 'bad_request', 'bad_request', 'bad_request'])
    await h.call('POST', 'entry', { body: entry() })
    await h.call('POST', 'entry', { body: entry(SECOND) })
    await h.call('POST', 'dead', { body: { account: A, fp: nsFingerprint(SECOND), reason: 'logout', where: SERVER } })
    texts.push((await h.call('POST', 'entry', { body: entry(SECOND) })).text)
    expect(h.logs.length).toBeGreaterThan(0)
    for (const text of [...h.logs, ...texts]) {
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(SECOND)
      expect(text).not.toContain(ROUTING)
      expect(text).not.toContain(TOKEN)
    }
  })

  test('forget, notify, imported where via client header, and SSE events without cookie values', async () => {
    const h = harness()
    await h.call('POST', 'entry', { body: entry(SECRET, { auto_renew: false }), client: 'mokutab/2.2.0 laptop/work' })
    const got = await h.call('GET', `entry?account=${A}&user=${U}`, { client: 'mokutab/2.2.0 server-2/main' })
    expect(got.status).toBe(200)
    expect(h.store.list()[0]).toMatchObject({
      holders: ['laptop', 'server-2'],
      last_event: { kind: 'imported', where: SERVER },
    })

    // Owner UI notify toggle & forget work without bridge token, refused remotely.
    expect((await h.call('POST', 'notify', { body: { account: A, notify: true }, remote: true })).status).toBe(401)
    expect((await h.call('POST', 'forget', { body: { account: A, user: U }, remote: true })).status).toBe(401)

    const notifyRes = await h.call('POST', 'notify', { body: { account: A, notify: false }, token: null })
    expect(notifyRes.status).toBe(200)
    expect(notifyRes.json).toEqual({ ok: true, account: A, notify: false, prefs: { [A]: false } })
    expect((await h.call('GET', 'list', { token: null })).json.notify).toEqual({ [A]: false })

    // SSE stream sends initial snapshot + live updates without X-Board header (EventSource), refuses cross-site.
    const crossSiteReq = new Request('http://127.0.0.1:12999/api/ns-sessions/events', {
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    const crossRes = await dispatch(h.routes, crossSiteReq, new URL(crossSiteReq.url), '/api/ns-sessions/events', {
      port: 12999,
      token: 'fs',
      stale: () => false,
    })
    expect(crossRes.status).toBe(401)

    const ac = new AbortController()
    const sseReq = new Request('http://127.0.0.1:12999/api/ns-sessions/events', { signal: ac.signal })
    const sseRes = await dispatch(h.routes, sseReq, new URL(sseReq.url), '/api/ns-sessions/events', {
      port: 12999,
      token: 'fs',
      stale: () => false,
    })
    expect(sseRes.status).toBe(200)
    const reader = sseRes.body?.getReader()
    if (!reader) throw new Error('missing SSE body')
    const decoder = new TextDecoder()
    const first = decoder.decode((await reader.read()).value)
    expect(first).toContain('event: sessions')
    expect(first).toContain(A)
    expect(first).not.toContain(SECRET)
    expect(first).not.toContain(ROUTING)

    // Forget removes entry and pushes an updated SSE event.
    const forgetRes = await h.call('POST', 'forget', { body: { account: A, user: U }, token: null })
    expect(forgetRes.status).toBe(200)
    expect(forgetRes.json).toEqual({ ok: true, removed: true })
    const second = decoder.decode((await reader.read()).value)
    expect(second).toContain('"entries":[]')
    expect(second).not.toContain(SECRET)
    ac.abort()
    await reader.cancel().catch(() => {})
  })
})

describe('bridge token files', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const temp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'ns-store-'))
    dirs.push(d)
    return d
  }
  /** A bridge state dir: a folder with default-profile.json. */
  const bridge = (dir: string): string => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'default-profile.json'), '{"profile":"main"}\n')
    return dir
  }

  test('the bridge state dirs, found by default-profile.json, as the bridge picks them on each platform', () => {
    const home = temp()
    expect(nsBridgeDirs(home, {}, 'linux')).toEqual([])
    // A folder of that name without default-profile.json is no bridge's.
    mkdirSync(join(home, '.local', 'state', 'mcp-chrome-bridge'), { recursive: true })
    expect(nsBridgeDirs(home, {}, 'linux')).toEqual([])
    const linux = bridge(join(home, '.local', 'state', 'mcp-chrome-bridge'))
    expect(nsBridgeDirs(home, {}, 'linux')).toEqual([linux])
    const xdg = temp()
    expect(nsBridgeDirs(home, { XDG_STATE_HOME: xdg }, 'linux')).toEqual([])
    const xdgBridge = bridge(join(xdg, 'mcp-chrome-bridge'))
    expect(nsBridgeDirs(home, { XDG_STATE_HOME: xdg }, 'linux')).toEqual([xdgBridge])
    const local = temp()
    const win = bridge(join(local, 'mcp-chrome-bridge'))
    expect(nsBridgeDirs(home, { LOCALAPPDATA: local }, 'win32')).toEqual([win])
    const mac = bridge(join(home, 'Library', 'Logs', 'mcp-chrome-bridge'))
    expect(nsBridgeDirs(home, {}, 'darwin')).toEqual([mac])
    const override = bridge(temp())
    expect(nsBridgeDirs(home, { MOKUTAB_UPDATE_STATE_DIR: override }, 'linux')).toEqual([override])
    // A server node: each profile's bridge.
    const alpha = bridge(join(home, 'browser', 'state', 'alpha', 'state', 'mcp-chrome-bridge'))
    const beta = bridge(join(home, 'browser', 'state', 'beta', 'state', 'mcp-chrome-bridge'))
    mkdirSync(join(home, 'browser', 'state', 'gamma', 'state', 'mcp-chrome-bridge'), { recursive: true })
    expect(nsBridgeDirs(home, {}, 'linux')).toEqual([linux, alpha, beta])
    const given = bridge(temp())
    expect(
      nsBridgeDirs(home, { BOARD_NS_BRIDGE_DIRS: `${given}${process.platform === 'win32' ? ';' : ':'}${temp()}` }),
    ).toEqual([given])
  })

  test('ns-store-token: the token on line 1, 0600, kept; line 2 only for another URL', () => {
    const d = temp()
    const file = join(d, NS_TOKEN_FILE)
    const t = ensureNsToken(d, NS_DEFAULT_URL)
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(readFileSync(file, 'utf8')).toBe(`${t}\n`)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    const before = statSync(file).mtimeMs
    expect(ensureNsToken(d, NS_DEFAULT_URL)).toBe(t)
    expect(statSync(file).mtimeMs).toBe(before)
    expect(ensureNsToken(d, 'http://127.0.0.1:12500/api/ns-sessions')).toBe(t)
    expect(readFileSync(file, 'utf8')).toBe(`${t}\nhttp://127.0.0.1:12500/api/ns-sessions\n`)
    expect(ensureNsToken(d, NS_DEFAULT_URL)).toBe(t)
    expect(readFileSync(file, 'utf8')).toBe(`${t}\n`)
    writeFileSync(file, 'not a token\n')
    const fresh = ensureNsToken(d)
    expect(fresh).not.toBe(t)
    expect(readFileSync(file, 'utf8')).toBe(`${fresh}\n`)
  })

  test('check: the tokens written; a bridge that came later is found on the next miss, at most once a minute', () => {
    const a = temp()
    const b = temp()
    let t = 1_000_000
    const list = [a]
    const tokens = createNsTokens({ dirs: () => [...list], url: () => NS_DEFAULT_URL, now: () => t })
    expect(tokens.refresh()).toBe(1)
    const tokenIn = (d: string): string => readFileSync(join(d, NS_TOKEN_FILE), 'utf8').split('\n')[0] as string
    expect(tokens.check(tokenIn(a))).toBe(true)
    expect(tokens.check(null)).toBe(false)
    expect(tokens.check('short')).toBe(false)
    list.push(b)
    expect(tokens.check('c'.repeat(43))).toBe(false)
    expect(() => readFileSync(join(b, NS_TOKEN_FILE))).toThrow()
    t += 61_000
    expect(tokens.check('c'.repeat(43))).toBe(false)
    expect(tokens.check(tokenIn(b))).toBe(true)
    expect(tokens.check(tokenIn(a))).toBe(true)
  })
})
