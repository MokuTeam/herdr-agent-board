// The NetSuite session store's routes (#860, server/routes/ns-sessions.ts, contract
// ns-contract-final.md) and its bridge files (adapters/ns-store-tokens.ts), dispatched as the
// board does: the token on every call (the list also as the board's own X-Board call), the
// {ok, code, message} answers, publish and get, dead_fp, ambiguous_user, touch and dead by fp,
// the lock by lock_id, a remote listener refused, a node's relayed request taken without the
// token, a node's route that checks the token before the relay and turns the relay's own
// failures into store_unavailable. No cookie value in any log line or error body.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNsTokens,
  ensureNsStoreFile,
  NS_STORE_FILE,
  nsBridgeDirs,
  wrapperDataDir,
} from '../../src/adapters/ns-store-tokens.ts'
import { createNsStore, type NsStore, nsFingerprint } from '../../src/core/ns-sessions.ts'
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
  const base = nsSessionRoutes({ store: () => store, tokenOk: t => t === TOKEN, log: l => logs.push(l) })
  const routes = o.routes ? o.routes(base) : base
  return {
    logs,
    store: store as NsStore,
    async call(method: string, path: string, c: Call = {}) {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (c.board) headers['x-board'] = '1'
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

describe('routes', () => {
  test("the token on every call; the list also as the board's own call", async () => {
    const h = harness()
    const calls: [string, string, unknown][] = [
      ['PUT', 'entry', entry()],
      ['GET', `entry?account=${A}`, undefined],
      ['POST', 'touch', { account: A, fp: nsFingerprint(SECRET), where: SERVER, at: 1 }],
      ['POST', 'dead', { account: A, fp: '00000000', reason: 'logout', where: SERVER }],
      ['POST', 'lock', { account: A, user: U, holder: { ...SERVER, run_id: 'r' } }],
      ['DELETE', 'lock', { account: A, user: U, lock_id: 'x' }],
      ['GET', 'list', undefined],
    ]
    for (const [method, path, body] of calls) {
      for (const token of [null, 'b'.repeat(43)]) {
        const r = await h.call(method, path, { body, token, board: path !== 'list' })
        expect(r.status).toBe(401)
        expect(r.json).toEqual({ ok: false, code: 'unauthorized', message: 'missing or unknown X-NS-Store-Token' })
      }
    }
    expect((await h.call('GET', 'list', { token: null, board: true })).json).toEqual({ ok: true, entries: [] })
    expect((await h.call('GET', 'list')).status).toBe(200)
    // A wrong token is refused even where none is needed.
    expect((await h.call('GET', 'list', { token: 'b'.repeat(43), board: true })).status).toBe(401)
  })

  test('publish and get: stored, the values with the token, dead_fp, ambiguous_user, none', async () => {
    const h = harness()
    const put = await h.call('PUT', 'entry', { body: entry(), client: 'mokutab/2.2.0 laptop/work' })
    expect(put).toMatchObject({ status: 200, json: { ok: true, stored: true, generation: 1, state: 'live' } })
    expect(h.logs).toEqual([
      `ns-sessions: ${A} published fp ${nsFingerprint(SECRET)} gen 1 by laptop/work [mokutab/2.2.0 laptop/work]`,
    ])
    expect((await h.call('PUT', 'entry', { body: entry() })).json).toMatchObject({ stored: false, generation: 1 })
    const got = await h.call('GET', `entry?account=1234567_sb1&user=Agent%40Example.com`)
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
    const dead = await h.call('PUT', 'entry', { body: entry() })
    expect(dead.status).toBe(409)
    expect(dead.json).toMatchObject({ ok: false, code: 'dead_fp' })
    expect((await h.call('GET', `entry?account=${A}&user=${U}`)).json).toMatchObject({ ok: false, code: 'none' })
    expect((await h.call('GET', `entry?account=${A}`)).status).toBe(404)

    await h.call('PUT', 'entry', { body: entry(SECOND) })
    await h.call('PUT', 'entry', { body: entry(SECRET.replace('7f3a', '0000'), { user: 'second@example.com' }) })
    const amb = await h.call('GET', `entry?account=${A}`)
    expect(amb.status).toBe(409)
    expect(amb.json).toMatchObject({ ok: false, code: 'ambiguous_user' })
    expect((amb.json.users as { user: string }[]).map(u => u.user).sort()).toEqual([U, 'second@example.com'])
    expect(amb.text).not.toContain(SECRET)
    expect((await h.call('GET', 'entry?account=bad-account')).json).toMatchObject({
      code: 'bad_request',
      field: 'account',
    })
  })

  test('touch and dead by fp: matched or not', async () => {
    const h = harness()
    await h.call('PUT', 'entry', { body: entry() })
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
      field: 'where',
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

  test('lock: lock_id, locked for another holder, DELETE by lock_id', async () => {
    const h = harness()
    const holder = { ...SERVER, run_id: 'run-1' }
    const a = await h.call('POST', 'lock', { body: { account: A, user: U, holder, ttl_s: 90 } })
    expect(a.status).toBe(200)
    const { lock_id, until } = a.json as { lock_id: string; until: number }
    expect(lock_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(until).toBeGreaterThan(0)
    const b = await h.call('POST', 'lock', { body: { account: A, user: U, holder: { ...LAPTOP, run_id: 'run-2' } } })
    expect(b.status).toBe(409)
    expect(b.json).toMatchObject({ ok: false, code: 'locked', holder, until })
    expect((await h.call('POST', 'lock', { body: { account: A, user: U, holder, ttl_s: -1 } })).status).toBe(400)
    expect((await h.call('POST', 'lock', { body: { account: A, user: U, holder: SERVER } })).json).toMatchObject({
      field: 'holder',
    })
    expect((await h.call('DELETE', 'lock', { body: { account: A, user: U, lock_id: 'other' } })).json).toEqual({
      ok: true,
      released: false,
    })
    expect((await h.call('DELETE', 'lock', { body: { account: A, user: U, lock_id } })).json).toEqual({
      ok: true,
    })
    expect(
      (await h.call('POST', 'lock', { body: { account: A, user: U, holder: { ...LAPTOP, run_id: 'run-2' } } })).status,
    ).toBe(200)
  })

  test('POST /entry and POST /unlock answer as PUT /entry and DELETE /lock', async () => {
    const h = harness()
    expect((await h.call('POST', 'entry', { body: entry() })).json).toEqual({
      ok: true,
      stored: true,
      generation: 1,
      state: 'live',
    })
    expect((await h.call('POST', 'entry', { body: entry(), token: null })).status).toBe(401)
    const holder = { ...SERVER, run_id: 'run-1' }
    const a = await h.call('POST', 'lock', { body: { account: A, user: U, holder } })
    const lockId = (a.json as { lock_id: string }).lock_id
    expect((await h.call('POST', 'unlock', { body: { account: A, user: U, lock_id: 'other' } })).json).toEqual({
      ok: true,
      released: false,
    })
    expect(
      (await h.call('POST', 'unlock', { body: { account: A, user: U, lock_id: lockId }, token: null })).status,
    ).toBe(401)
    expect((await h.call('POST', 'unlock', { body: { account: A, user: U, lock_id: lockId } })).json).toEqual({
      ok: true,
    })
  })

  test('the list: entries, by account, no value', async () => {
    const h = harness()
    await h.call('PUT', 'entry', { body: entry() })
    const list = await h.call('GET', 'list')
    expect(list.json).toMatchObject({
      ok: true,
      entries: [{ account: A, user: U, state: 'live', fp: nsFingerprint(SECRET) }],
    })
    expect((await h.call('GET', 'list?account=7654321')).json).toEqual({ ok: true, entries: [] })
    expect(list.text).not.toContain(SECRET)
    expect(list.text).not.toContain(ROUTING)
  })

  test('bodies over 64 KB, or not JSON, are bad_request', async () => {
    const h = harness()
    const big = entry(SECRET, { pad: 'x'.repeat(70 * 1024) })
    expect((await h.call('PUT', 'entry', { body: big })).json).toMatchObject({ code: 'bad_request', field: 'body' })
    expect((await h.call('PUT', 'entry', { body: '{"cookies":' })).json).toMatchObject({ code: 'bad_request' })
    expect((await h.call('PUT', 'entry', { body: entry(SECRET, { fp: nsFingerprint(SECOND) }) })).json).toMatchObject({
      code: 'bad_request',
      field: 'fp',
    })
  })

  test("a remote listener gets nothing; a relayed request is its node's to check", async () => {
    const h = harness()
    expect((await h.call('GET', 'list', { remote: true, board: true })).status).toBe(401)
    expect((await h.call('PUT', 'entry', { body: entry(), remote: true })).status).toBe(401)
    const relayed = await h.call('PUT', 'entry', { body: entry(), remote: true, relayFrom: 'laptop', token: null })
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

  test("a node's route: the token here, then the relay; the relay's own failures are store_unavailable", async () => {
    const sent: { method: string; path: string }[] = []
    let answer: Response | undefined = new Response(null, { status: 299 })
    const relay: NsRelay = {
      relay: async (req, caller) => {
        sent.push({ method: req.method, path: caller.rawPath })
        return answer
      },
    }
    const g = harness({ store: null, routes: r => [nsNodeRoute(relay, t => t === TOKEN), ...r] })
    expect((await g.call('PUT', 'entry', { body: entry(), token: null })).status).toBe(401)
    expect((await g.call('GET', `entry?account=${A}`, { token: 'x' })).status).toBe(401)
    expect((await g.call('GET', 'list', { token: null })).status).toBe(401)
    expect(sent).toEqual([])
    expect((await g.call('PUT', 'entry', { body: entry() })).status).toBe(299)
    expect((await g.call('GET', 'list', { token: null, board: true })).status).toBe(299)
    expect((await g.call('DELETE', 'lock', { body: {} })).status).toBe(299)
    expect(sent).toEqual([
      { method: 'PUT', path: '/api/ns-sessions/entry' },
      { method: 'GET', path: '/api/ns-sessions/list' },
      { method: 'DELETE', path: '/api/ns-sessions/lock' },
    ])
    // The store's own answers pass as they came.
    answer = new Response(JSON.stringify({ ok: false, code: 'locked', message: 'm', holder: {} }), { status: 409 })
    expect((await g.call('POST', 'lock', { body: {} })).json).toMatchObject({ code: 'locked' })
    // The relay's own: the master away, a timeout, a master without the store, a handover.
    for (const [status, body] of [
      [503, { ok: false, error: 'node-master-offline', message: 'x' }],
      [504, { ok: false, error: 'master-relay-timeout', message: 'x' }],
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
      texts.push((await h.call('PUT', 'entry', { body: b })).text)
    expect(texts.map(t => JSON.parse(t).code)).toEqual(['bad_request', 'bad_request', 'bad_request', 'bad_request'])
    await h.call('PUT', 'entry', { body: entry() })
    await h.call('PUT', 'entry', { body: entry(SECOND) })
    await h.call('POST', 'dead', { body: { account: A, fp: nsFingerprint(SECOND), reason: 'logout', where: SERVER } })
    texts.push((await h.call('PUT', 'entry', { body: entry(SECOND) })).text)
    expect(h.logs.length).toBeGreaterThan(0)
    for (const text of [...h.logs, ...texts]) {
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(SECOND)
      expect(text).not.toContain(ROUTING)
      expect(text).not.toContain(TOKEN)
    }
  })
})

describe('bridge files', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const temp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'ns-store-'))
    dirs.push(d)
    return d
  }

  test("a wrapper's MOKUTAB_DATA_DIR, in its spellings; none when it sets none", () => {
    const home = '/h'
    expect(wrapperDataDir('#!/bin/sh\nexport XDG_STATE_HOME="/x"\nexec run', home)).toBeNull()
    expect(wrapperDataDir('export MOKUTAB_DATA_DIR="/data/one"\n', home)).toBe('/data/one')
    expect(wrapperDataDir("MOKUTAB_DATA_DIR='/data/two'\n", home)).toBe('/data/two')
    expect(wrapperDataDir('export XDG_STATE_HOME=/s MOKUTAB_DATA_DIR=~/three\n', home)).toBe('/h/three')
    expect(wrapperDataDir('export MOKUTAB_DATA_DIR="$HOME/four"\n', home)).toBe('/h/four')
    expect(wrapperDataDir('export MOKUTAB_DATA_DIR="$(pwd)"\n', home)).toBeNull()
  })

  test("the data dirs: ~/.mokutab or MOKUTAB_DATA_DIR, and each host wrapper's; only those that exist", () => {
    const home = temp()
    expect(nsBridgeDirs(home, {})).toEqual([])
    mkdirSync(join(home, '.mokutab'))
    expect(nsBridgeDirs(home, {})).toEqual([join(home, '.mokutab')])
    const own = temp()
    expect(nsBridgeDirs(home, { MOKUTAB_DATA_DIR: own })).toEqual([own])
    // A server node: wrappers that set none share ~/.mokutab; one that sets its own adds it.
    const bin = join(home, 'browser', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'mokutab-host-alpha'), '#!/bin/sh\nexport XDG_STATE_HOME="/s/alpha"\n')
    const beta = temp()
    writeFileSync(join(bin, 'mokutab-host-beta'), `#!/bin/sh\nexport MOKUTAB_DATA_DIR="${beta}"\n`)
    writeFileSync(join(bin, 'mokutab-host-gamma'), '#!/bin/sh\nexport MOKUTAB_DATA_DIR="/does/not/exist"\n')
    writeFileSync(join(bin, 'other-tool'), 'export MOKUTAB_DATA_DIR=/x\n')
    expect(nsBridgeDirs(home, {})).toEqual([join(home, '.mokutab'), beta])
    const given = temp()
    expect(
      nsBridgeDirs(home, {
        BOARD_NS_BRIDGE_DIRS: `${given}${process.platform === 'win32' ? ';' : ':'}${join(given, 'missing')}`,
      }),
    ).toEqual([given])
  })

  test('ns-store.json: { url, token, node }, 0600, its token kept, rewritten when the URL or node changes', () => {
    const d = temp()
    const file = join(d, NS_STORE_FILE)
    const t = ensureNsStoreFile(d, 'http://127.0.0.1:12422/api/ns-sessions', 'laptop')
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      url: 'http://127.0.0.1:12422/api/ns-sessions',
      token: t,
      node: 'laptop',
    })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    const before = statSync(file).mtimeMs
    expect(ensureNsStoreFile(d, 'http://127.0.0.1:12422/api/ns-sessions', 'laptop')).toBe(t)
    expect(statSync(file).mtimeMs).toBe(before)
    expect(ensureNsStoreFile(d, 'http://127.0.0.1:12500/api/ns-sessions', 'laptop')).toBe(t)
    expect(JSON.parse(readFileSync(file, 'utf8')).url).toBe('http://127.0.0.1:12500/api/ns-sessions')
    writeFileSync(file, 'not json')
    const fresh = ensureNsStoreFile(d, 'http://127.0.0.1:12500/api/ns-sessions', 'laptop')
    expect(fresh).not.toBe(t)
    expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe(fresh)
  })

  test('check: the tokens written; a bridge that came later is found on the next miss, at most once a minute', () => {
    const a = temp()
    const b = temp()
    let t = 1_000_000
    const list = [a]
    const tokens = createNsTokens({
      dirs: () => [...list],
      url: () => 'http://127.0.0.1:1/api/ns-sessions',
      node: () => 'n',
      now: () => t,
    })
    expect(tokens.refresh()).toBe(1)
    const tokenIn = (d: string): string => JSON.parse(readFileSync(join(d, NS_STORE_FILE), 'utf8')).token
    expect(tokens.check(tokenIn(a))).toBe(true)
    expect(tokens.check(null)).toBe(false)
    expect(tokens.check('short')).toBe(false)
    list.push(b)
    expect(tokens.check('c'.repeat(43))).toBe(false)
    expect(() => readFileSync(join(b, NS_STORE_FILE))).toThrow()
    t += 61_000
    expect(tokens.check('c'.repeat(43))).toBe(false)
    expect(tokens.check(tokenIn(b))).toBe(true)
    expect(tokens.check(tokenIn(a))).toBe(true)
  })
})
