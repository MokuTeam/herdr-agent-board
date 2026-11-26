// The NetSuite session store (#860, core/ns-sessions.ts): keyed (ACCOUNT, user), fp, generations,
// stale publishes, live/dying/dead with the 12 h and 3 h predictions, the login lock, and the list
// that never holds a value. Fake cookie values only.
import { describe, expect, test } from 'bun:test'
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

const body = (value = SECRET, o: Record<string, unknown> = {}) => ({
  account: '1234567_sb1',
  user: 'Agent@Example.com',
  role: 3,
  host: '1234567-sb1.app.netsuite.com',
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
    { name: 'NS_ROUTING_VERSION', value: 'fake-routing', domain: '.1234567-sb1.app.netsuite.com', path: '/' },
  ],
  origin: { machine: 'laptop', profile: 'work' },
  ...o,
})

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
    expect(nsAccount(' 1234567_sb1 ')).toBe('1234567_SB1')
    expect(nsAccount('TSTDRV123')).toBe('TSTDRV123')
    expect(nsAccount('1234567-SB1')).toBeNull()
    expect(nsUser(' Agent@Example.COM ')).toBe('agent@example.com')
    expect(nsUser('no-at-sign')).toBeNull()
    expect(nsHostAccount('1234567-sb1.app.netsuite.com')).toBe('1234567_SB1')
    expect(nsHostAccount('system.netsuite.com')).toBeNull()
    expect(nsHostAccount('1234567.app.netsuite.com.evil.example')).toBeNull()
  })

  test('fp is the first 8 hex of sha256(JSESSIONID)', () => {
    const fp = nsFingerprint(SECRET)
    expect(fp).toMatch(/^[0-9a-f]{8}$/)
    expect(fp).toBe(new Bun.CryptoHasher('sha256').update(SECRET).digest('hex').slice(0, 8))
  })

  test('a publish is read field by field; a wrong one is named, never its value', () => {
    const p = nsPublishOf(body())
    expect(p.account).toBe('1234567_SB1')
    expect(p.user).toBe('agent@example.com')
    expect(p.role).toBe('3')
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
    // A cookie of another site, even with the account's name in it.
    const foreign = body()
    foreign.cookies[0] = { ...foreign.cookies[0], domain: '.netsuite.com' } as (typeof foreign.cookies)[0]
    expect(wrong(foreign)).toBe('cookies[0].domain')
    expect(wrong(body(SECRET, { host: '7654321.app.netsuite.com' }))).toBe('host')
    expect(wrong(body(SECRET, { cookies: [body().cookies[1]] }))).toBe('cookies.JSESSIONID')
    expect(wrong(body(`${SECRET}\r\nSet-Cookie: x`))).toBe('cookies[0].value')
    expect(wrong(body(SECRET, { origin: { machine: 'laptop' } }))).toBe('origin')
    expect(wrong(body(SECRET, { user: 'x' }))).toBe('user')
    expect(wrong(null)).toBe('body')
  })
})

describe('the store', () => {
  test('publish: fp, generation, the same session again keeps its generation, a newer one wins', () => {
    const c = clock()
    const s = createNsStore({ now: c.now })
    const a = s.publish(nsPublishOf(body()))
    expect(a).toEqual({ ok: true, fp: nsFingerprint(SECRET), generation: 1, state: 'live', changed: true })
    expect(s.publish(nsPublishOf(body()))).toMatchObject({ ok: true, generation: 1, changed: false })
    const b = s.publish(nsPublishOf(body(OTHER, { origin: { machine: 'server-2', profile: 'main' } })))
    expect(b).toMatchObject({ ok: true, fp: nsFingerprint(OTHER), generation: 2, changed: true })
    // The session it replaced is stale now: NetSuite's newest won.
    expect(s.publish(nsPublishOf(body()))).toEqual({ ok: false, error: 'stale', fp: nsFingerprint(SECRET) })
    expect(s.take('1234567_SB1', 'agent@example.com')).toMatchObject({
      ok: true,
      generation: 2,
      fp: nsFingerprint(OTHER),
    })
  })

  test('take: by user, the only live one without a user, ambiguous with two, none for dead or unknown', () => {
    const s = createNsStore({ now: clock().now })
    expect(s.take('1234567_SB1', null)).toEqual({ ok: false, error: 'none' })
    s.publish(nsPublishOf(body()))
    const got = s.take('1234567_SB1', null)
    expect(got.ok && got.cookies.find(x => x.name === 'JSESSIONID')?.value).toBe(SECRET)
    s.publish(nsPublishOf(body(OTHER, { user: 'second@example.com' })))
    expect(s.take('1234567_SB1', null)).toEqual({
      ok: false,
      error: 'ambiguous',
      users: ['agent@example.com', 'second@example.com'],
    })
    expect(s.take('1234567_SB1', 'second@example.com')).toMatchObject({ ok: true, user: 'second@example.com' })
    expect(s.take('7654321', null)).toEqual({ ok: false, error: 'none' })
  })

  test('dead: only the current fp counts; its values go and a dead session is stale when published again', () => {
    const s = createNsStore({ now: clock().now })
    s.publish(nsPublishOf(body()))
    const fp = nsFingerprint(SECRET)
    expect(s.dead('1234567_SB1', 'agent@example.com', '00000000', 'login-redirect')).toBe(false)
    expect(s.dead('1234567_SB1', 'agent@example.com', fp, 'login-redirect')).toBe(true)
    expect(s.take('1234567_SB1', 'agent@example.com')).toEqual({ ok: false, error: 'none' })
    expect(s.list()[0]).toMatchObject({ state: 'dead', dead_reason: 'login-redirect', dead_matched: 'none' })
    expect(s.publish(nsPublishOf(body()))).toMatchObject({ ok: false, error: 'stale' })
    // A new login is a new session.
    expect(s.publish(nsPublishOf(body(OTHER)))).toMatchObject({ ok: true, generation: 2, state: 'live' })
  })

  test('expiry: dying 20 min before the idle or absolute prediction, dead and empty past 12 h', () => {
    const c = clock()
    const s = createNsStore({ now: c.now })
    s.publish(nsPublishOf(body()))
    const fp = nsFingerprint(SECRET)
    const m = s.list()[0]
    expect(m?.abs_expiry).toBe(c.now() + NS_ABS_MS)
    expect(m?.idle_expiry).toBe(c.now() + NS_IDLE_MS)
    c.go(NS_IDLE_MS - NS_DYING_MS)
    expect(s.list()[0]?.state).toBe('dying')
    // Activity on the same session puts the idle prediction off again.
    expect(s.touch('1234567_SB1', 'agent@example.com', fp, 'laptop/work')).toBe(true)
    expect(s.touch('1234567_SB1', 'agent@example.com', '00000000', 'laptop/work')).toBe(false)
    expect(s.list()[0]?.state).toBe('live')
    c.go(NS_ABS_MS)
    expect(s.list()[0]).toMatchObject({ state: 'dead', dead_reason: 'expired', dead_matched: 'abs' })
    expect(s.take('1234567_SB1', null)).toEqual({ ok: false, error: 'none' })
  })

  test('login_at from the publisher, never in the future', () => {
    const c = clock()
    const s = createNsStore({ now: c.now })
    s.publish(nsPublishOf(body(SECRET, { login_at: c.now() - 3_600_000 })))
    expect(s.list()[0]?.abs_expiry).toBe(c.now() - 3_600_000 + NS_ABS_MS)
    s.publish(nsPublishOf(body(OTHER, { login_at: c.now() + 3_600_000 })))
    expect(s.list()[0]?.login_at).toBe(c.now())
  })

  test('lock: one holder at a time, renewed by its holder, at most 120 s, released by its holder only', () => {
    const c = clock()
    const s = createNsStore({ now: c.now })
    const a = s.lock('1234567_SB1', 'agent@example.com', 'server-2/main', 600)
    expect(a).toEqual({ ok: true, until: c.now() + 120_000 })
    expect(s.lock('1234567_SB1', 'agent@example.com', 'laptop/work', 60)).toEqual({
      ok: false,
      holder: 'server-2/main',
      until: c.now() + 120_000,
    })
    // Another user of the same account is another key.
    expect(s.lock('1234567_SB1', 'second@example.com', 'laptop/work', 60).ok).toBe(true)
    expect(s.unlock('1234567_SB1', 'agent@example.com', 'laptop/work')).toBe(false)
    expect(s.lock('1234567_SB1', 'agent@example.com', 'server-2/main', 30)).toEqual({
      ok: true,
      until: c.now() + 30_000,
    })
    c.go(30_000)
    expect(s.lock('1234567_SB1', 'agent@example.com', 'laptop/work', 60).ok).toBe(true)
    expect(s.unlock('1234567_SB1', 'agent@example.com', 'laptop/work')).toBe(true)
    expect(s.lock('1234567_SB1', 'agent@example.com', 'server-2/main', 60).ok).toBe(true)
  })

  test('the list and its CLI line hold metadata only', () => {
    const c = clock()
    const s = createNsStore({ now: c.now })
    s.publish(nsPublishOf(body()))
    s.touch('1234567_SB1', 'agent@example.com', nsFingerprint(SECRET), 'server-2/main')
    s.lock('1234567_SB1', 'agent@example.com', 'server-2/main', 60)
    const list = s.list()
    expect(JSON.stringify(list)).not.toContain(SECRET)
    expect(JSON.stringify(list)).not.toContain('fake-routing')
    expect(list[0]).toMatchObject({ holders: ['laptop', 'server-2'], lock: { holder: 'server-2/main' }, role: '3' })
    expect(Object.keys(list[0] ?? {})).not.toContain('cookies')
    const line = nsListLine(list[0] as (typeof list)[0], c.now())
    expect(line).toContain('1234567_SB1 · agent@example.com · live')
    expect(line).toContain(`fp ${nsFingerprint(SECRET)}`)
    expect(line).not.toContain(SECRET)
  })

  test('clear drops every value', () => {
    const s = createNsStore({ now: clock().now })
    s.publish(nsPublishOf(body()))
    s.clear()
    expect(s.list()).toEqual([])
    expect(s.take('1234567_SB1', null)).toEqual({ ok: false, error: 'none' })
  })
})
