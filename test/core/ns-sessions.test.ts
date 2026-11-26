// The NetSuite session store (#860, core/ns-sessions.ts, contract ns-contract-final.md): keyed
// (ACCOUNT, user), fp recomputed, newest by arrival, dead_fp, an unknown user filled in later,
// touch and dead by fp, live/dying/dead with the 12 h and 3 h predictions, the login lock by
// lock_id, 500 entries without ever evicting a live one, and a list that never holds a value.
// Fake cookie values only.
import { describe, expect, test } from 'bun:test'
import { relayMatch, relayRequestOf } from '../../src/core/master-relay.ts'
import {
  createNsStore,
  NS_ABS_MS,
  NS_DYING_MS,
  NS_IDLE_MS,
  NsBodyError,
  nsAccount,
  nsFingerprint,
  nsHostAccount,
  nsListLine,
  nsPublishOf,
  nsUser,
} from '../../src/core/ns-sessions.ts'

const SECRET = 'fake-jsessionid-value-0001'
const OTHER = 'fake-jsessionid-value-0002'
const A = '1234567_SB1'
const U = 'agent@example.com'
const LAPTOP = { machine: 'laptop', profile: 'work' }
const SERVER = { machine: 'server-2', profile: 'main' }

const cookies = (value: string, host: string) => [
  { name: 'JSESSIONID', value, domain: host, path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
  { name: 'NS_ROUTING_VERSION', value: 'fake-routing', domain: `.${host}`, path: '/' },
]

const body = (value = SECRET, o: Record<string, unknown> = {}) => {
  const host = typeof o.host === 'string' ? o.host : '1234567-sb1.app.netsuite.com'
  return {
    account: '1234567_sb1',
    user: 'Agent@Example.com',
    host,
    role: 'Administrator',
    role_id: 3,
    fp: nsFingerprint(value),
    cookies: cookies(value, host),
    origin: LAPTOP,
    login_at: null,
    seen_at: 1_800_000_000_000,
    ...o,
  }
}

function clock(start = 1_800_000_000_000) {
  let t = start
  return {
    now: () => t,
    go: (ms: number) => {
      t += ms
    },
  }
}

describe('keys and fields', () => {
  test('account upper, user lower, host matches the account', () => {
    expect(nsAccount(' 1234567_sb1 ')).toBe(A)
    expect(nsAccount('TD3125712')).toBe('TD3125712')
    expect(nsAccount('1234567-SB1')).toBeNull()
    expect(nsAccount('1_2_3')).toBeNull()
    expect(nsUser(' Agent@Example.COM ')).toBe(U)
    expect(nsUser('no-at-sign')).toBeNull()
    expect(nsHostAccount('1234567-sb1.app.netsuite.com')).toBe(A)
    expect(nsHostAccount('system.netsuite.com')).toBeNull()
    expect(nsHostAccount('1234567.app.netsuite.com.evil.example')).toBeNull()
  })

  test('fp is the first 8 hex of sha256(JSESSIONID)', () => {
    expect(nsFingerprint(SECRET)).toBe(new Bun.CryptoHasher('sha256').update(SECRET).digest('hex').slice(0, 8))
  })

  test('a publish is read field by field; a wrong one is named, never its value', () => {
    const p = nsPublishOf(body())
    expect(p).toMatchObject({ account: A, user: U, role: 'Administrator', role_id: 3, fp: nsFingerprint(SECRET) })
    expect(nsPublishOf(body(SECRET, { user: null })).user).toBeNull()
    const wrong = (b: unknown): string => {
      try {
        nsPublishOf(b)
      } catch (err) {
        expect(err).toBeInstanceOf(NsBodyError)
        expect(String((err as Error).message)).not.toContain(SECRET)
        return (err as NsBodyError).field
      }
      throw new Error('accepted')
    }
    const foreign = body()
    foreign.cookies[0] = { ...foreign.cookies[0], domain: '.netsuite.com' } as (typeof foreign.cookies)[0]
    expect(wrong(foreign)).toBe('cookies[0].domain')
    expect(wrong({ ...body(), host: '7654321.app.netsuite.com' })).toBe('host')
    // The bridge's fp is recomputed: one that does not match is refused.
    expect(wrong(body(SECRET, { fp: nsFingerprint(OTHER) }))).toBe('fp')
    expect(wrong(body(SECRET, { cookies: [body().cookies[1]] }))).toBe('cookies.JSESSIONID')
    expect(wrong(body(`${SECRET}\r\nSet-Cookie: x`))).toBe('cookies[0].value')
    expect(wrong(body(SECRET, { cookies: Array.from({ length: 61 }, () => body().cookies[0]) }))).toBe('cookies')
    expect(wrong(body(SECRET, { origin: { machine: 'laptop' } }))).toBe('origin')
    expect(wrong(body(SECRET, { user: 'x' }))).toBe('user')
    expect(wrong(null)).toBe('body')
  })
})

describe('the store', () => {
  test('publish: stored, the same session again is not, a newer one wins by arrival', () => {
    const s = createNsStore({ now: clock().now })
    expect(s.publish(nsPublishOf(body()))).toEqual({ ok: true, stored: true, generation: 1, state: 'live' })
    expect(s.publish(nsPublishOf(body()))).toEqual({ ok: true, stored: false, generation: 1, state: 'live' })
    expect(s.publish(nsPublishOf(body(OTHER, { origin: SERVER })))).toMatchObject({ stored: true, generation: 2 })
    // Arrival decides, not age: the older session published again is the newest now.
    expect(s.publish(nsPublishOf(body()))).toMatchObject({ stored: true, generation: 3 })
    expect(s.take(A, U)).toMatchObject({ ok: true, generation: 3, fp: nsFingerprint(SECRET) })
  })

  test('a dead fp is never published again', () => {
    const s = createNsStore({ now: clock().now })
    s.publish(nsPublishOf(body()))
    expect(s.dead(A, nsFingerprint(SECRET), 'login_redirect')).toBe(true)
    expect(s.publish(nsPublishOf(body()))).toEqual({ ok: false, code: 'dead_fp' })
    expect(s.publish(nsPublishOf(body(OTHER)))).toMatchObject({ ok: true, stored: true, generation: 2 })
    expect(s.publish(nsPublishOf(body()))).toEqual({ ok: false, code: 'dead_fp' })
  })

  test('user unknown: filled from the entry with the same fp, kept as unknown otherwise, never handed out by user', () => {
    const s = createNsStore({ now: clock().now })
    s.publish(nsPublishOf(body()))
    expect(s.publish(nsPublishOf(body(SECRET, { user: null, role: null })))).toMatchObject({
      stored: false,
      generation: 1,
    })
    expect(s.list().map(m => m.user)).toEqual([U])
    // Another account's session with no user yet.
    const other = { account: '7654321', host: '7654321.app.netsuite.com' }
    expect(s.publish(nsPublishOf(body(OTHER, { ...other, user: null })))).toMatchObject({ stored: true })
    expect(s.take('7654321', U)).toEqual({ ok: false, code: 'none' })
    expect(s.take('7654321', null)).toMatchObject({ ok: true, user: null })
    // Its user arrives with the same session: one entry, now that user's.
    s.publish(nsPublishOf(body(OTHER, { ...other })))
    expect(s.list('7654321').map(m => m.user)).toEqual([U])
    expect(s.take('7654321', U)).toMatchObject({ ok: true, fp: nsFingerprint(OTHER) })
  })

  test('take: by user, the only live one without a user, ambiguous_user with two', () => {
    const c = clock()
    const s = createNsStore({ now: c.now })
    expect(s.take(A, null)).toEqual({ ok: false, code: 'none' })
    s.publish(nsPublishOf(body()))
    const got = s.take(A, null)
    expect(got.ok && got.cookies.find(x => x.name === 'JSESSIONID')?.value).toBe(SECRET)
    expect(got).toMatchObject({ account: A, user: U, host: '1234567-sb1.app.netsuite.com', role_id: 3, state: 'live' })
    c.go(1000)
    s.publish(nsPublishOf(body(OTHER, { user: 'second@example.com' })))
    expect(s.take(A, null)).toEqual({
      ok: false,
      code: 'ambiguous_user',
      users: [
        { user: 'second@example.com', last_activity: c.now() },
        { user: U, last_activity: c.now() - 1000 },
      ],
    })
    expect(s.take(A, 'second@example.com')).toMatchObject({ ok: true, user: 'second@example.com' })
  })

  test('touch and dead go by fp; an old fp does not match', () => {
    const s = createNsStore({ now: clock().now })
    s.publish(nsPublishOf(body()))
    const fp = nsFingerprint(SECRET)
    expect(s.touch(A, '00000000', SERVER)).toEqual({ matched: false, state: null })
    expect(s.touch(A, fp, SERVER)).toEqual({ matched: true, state: 'live' })
    expect(s.list()[0]).toMatchObject({ last_where: SERVER, holders: ['laptop', 'server-2'] })
    expect(s.dead(A, '00000000', 'logout')).toBe(false)
    expect(s.dead(A, fp, 'import_bounced')).toBe(true)
    expect(s.dead(A, fp, 'import_bounced')).toBe(false)
    expect(s.take(A, U)).toEqual({ ok: false, code: 'none' })
    expect(s.list()[0]).toMatchObject({ state: 'dead', dead_reason: 'import_bounced', dead_matched: 'none' })
  })

  test('expiry: dying 20 min before the idle or absolute prediction, dead and empty past 12 h, gone after 24 h more', () => {
    const c = clock()
    const s = createNsStore({ now: c.now })
    s.publish(nsPublishOf(body()))
    const fp = nsFingerprint(SECRET)
    expect(s.list()[0]).toMatchObject({ abs_expiry: c.now() + NS_ABS_MS, idle_expiry: c.now() + NS_IDLE_MS })
    c.go(NS_IDLE_MS - NS_DYING_MS)
    expect(s.list()[0]?.state).toBe('dying')
    expect(s.touch(A, fp, LAPTOP).state).toBe('live')
    c.go(NS_ABS_MS)
    expect(s.list()[0]).toMatchObject({ state: 'dead', dead_reason: 'expired', dead_matched: 'abs' })
    expect(s.take(A, null)).toEqual({ ok: false, code: 'none' })
    c.go(24 * 3600_000 + 1)
    expect(s.list()).toEqual([])
  })

  test('login_at is a hint, never in the future', () => {
    const c = clock()
    const s = createNsStore({ now: c.now })
    s.publish(nsPublishOf(body(SECRET, { login_at: c.now() - 3_600_000 })))
    expect(s.list()[0]?.abs_expiry).toBe(c.now() - 3_600_000 + NS_ABS_MS)
    s.publish(nsPublishOf(body(OTHER, { login_at: c.now() + 3_600_000 })))
    expect(s.list()[0]?.login_at).toBe(c.now())
  })

  test('lock: one holder, extended with the same lock_id, at most 300 s, released by lock_id or a publish from the holder', () => {
    const c = clock()
    let n = 0
    const s = createNsStore({ now: c.now, newId: () => `lock-${++n}` })
    const holder = { ...SERVER, run_id: 'run-1' }
    expect(s.lock(A, U, holder, 900)).toEqual({ ok: true, lock_id: 'lock-1', until: c.now() + 300_000 })
    expect(s.lock(A, U, { ...LAPTOP, run_id: 'run-9' }, 60)).toEqual({
      ok: false,
      code: 'locked',
      holder,
      until: c.now() + 300_000,
    })
    // The same machine and profile with another run is another holder.
    expect(s.lock(A, U, { ...holder, run_id: 'run-2' }, 60).ok).toBe(false)
    expect(s.lock(A, U, holder, 30)).toEqual({ ok: true, lock_id: 'lock-1', until: c.now() + 30_000 })
    expect(s.unlock(A, U, 'lock-x')).toBe(false)
    expect(s.unlock(A, U, 'lock-1')).toBe(true)
    expect(s.lock(A, U, { ...LAPTOP, run_id: 'run-9' }, 60)).toMatchObject({ ok: true, lock_id: 'lock-2' })
    // Expiry releases it.
    c.go(60_000)
    expect(s.unlock(A, U, 'lock-2')).toBe(false)
    expect(s.lock(A, U, holder, 60)).toMatchObject({ ok: true, lock_id: 'lock-3' })
    // A publish from the holder's origin releases it.
    s.publish(nsPublishOf(body(SECRET, { origin: SERVER })))
    expect(s.list()[0]?.lock).toBeNull()
    expect(s.lock(A, U, { ...LAPTOP, run_id: 'run-9' }, 60).ok).toBe(true)
  })

  test('500 entries: the oldest dead goes first, a live one never: store_full', () => {
    const s = createNsStore({ now: clock().now, max: 3 })
    const pub = (account: string, value: string) =>
      s.publish(nsPublishOf(body(value, { account, host: `${account.toLowerCase()}.app.netsuite.com` })))
    pub('1111111', 'fake-a')
    pub('2222222', 'fake-b')
    pub('3333333', 'fake-c')
    expect(pub('4444444', 'fake-d')).toEqual({ ok: false, code: 'store_full' })
    // A new session for a key it holds is no new entry.
    expect(pub('1111111', 'fake-a2')).toMatchObject({ ok: true, stored: true })
    s.dead('2222222', nsFingerprint('fake-b'), 'logout')
    expect(pub('4444444', 'fake-d')).toMatchObject({ ok: true, stored: true })
    expect(s.list().map(m => m.account)).toEqual(['1111111', '3333333', '4444444'])
  })

  test('the list and its CLI line hold metadata only', () => {
    const c = clock()
    const s = createNsStore({ now: c.now })
    s.publish(nsPublishOf(body()))
    s.touch(A, nsFingerprint(SECRET), SERVER)
    s.lock(A, U, { ...SERVER, run_id: 'run-1' }, 60)
    const list = s.list()
    expect(JSON.stringify(list)).not.toContain(SECRET)
    expect(JSON.stringify(list)).not.toContain('fake-routing')
    expect(Object.keys(list[0] ?? {})).not.toContain('cookies')
    expect(list[0]?.lock?.holder).toEqual({ ...SERVER, run_id: 'run-1' })
    expect(s.list('7654321')).toEqual([])
    const line = nsListLine(list[0] as (typeof list)[0], c.now())
    expect(line).toBe(
      `${A} · ${U} · live · fp ${nsFingerprint(SECRET)} · gen 1 · login 0m ago · ends in 3h00 · active 0m ago on server-2/main · locked by server-2/main`,
    )
  })

  test('clear drops every value', () => {
    const s = createNsStore({ now: clock().now })
    s.publish(nsPublishOf(body()))
    s.clear()
    expect(s.list()).toEqual([])
    expect(s.take(A, null)).toEqual({ ok: false, code: 'none' })
  })
})

describe('the relay carries PUT and DELETE for the store only', () => {
  const none = () => false
  test("relayMatch: the store's table paths; no other path, no session of another machine", () => {
    expect(relayMatch('PUT', '/api/ns-sessions/entry', none)).toMatchObject({
      kind: 'table',
      entry: { group: 'ns-sessions' },
    })
    expect(relayMatch('DELETE', '/api/ns-sessions/lock', none)).toMatchObject({ kind: 'table' })
    expect(relayMatch('GET', '/api/ns-sessions/list', none)).toMatchObject({ kind: 'table' })
    expect(relayMatch('PUT', '/api/ns-sessions/lock', none)).toBeNull()
    expect(relayMatch('DELETE', '/api/ns-sessions/entry', none)).toBeNull()
    expect(relayMatch('PUT', '/api/threads', none)).toBeNull()
    expect(relayMatch('DELETE', '/api/session/@ben:k', none)).toBeNull()
    expect(relayMatch('POST', '/api/session/@ben:k', none)).toMatchObject({ kind: 'keyed', device: 'ben' })
  })

  test('relayRequestOf: PUT and DELETE only on a table path that names them', () => {
    const req = (method: string, path: string) => ({
      id: 'abcdefgh12',
      method,
      path,
      headers: { 'content-type': 'application/json', 'x-ns-store-client': 'mokutab/test' },
      who: { kind: 'owner' },
      idem: 'k1',
    })
    expect(relayRequestOf(req('PUT', '/api/ns-sessions/entry'))).toMatchObject({ method: 'PUT' })
    expect(relayRequestOf(req('DELETE', '/api/ns-sessions/lock'))).toMatchObject({ method: 'DELETE' })
    expect(relayRequestOf(req('PUT', '/api/threads'))).toBeNull()
    expect(relayRequestOf(req('DELETE', '/api/session/@ben:k'))).toBeNull()
    expect(relayRequestOf(req('PATCH', '/api/ns-sessions/entry'))).toBeNull()
  })
})
