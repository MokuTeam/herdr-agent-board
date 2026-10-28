// The board's side of the peer network (#231, services/team-hub.ts), against a socket the test
// plays the hub with. First what "off" means (D10): without a valid `team` nothing is opened,
// timed, written or answered. Then the connection (backoff, revoked, on to off), and what comes in
// and goes out: signed acks, drops that are logged and not acked, a changed key held until trusted,
// a question sent again with its id after a reconnect.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { stateDir, teamAuditFile } from '../../src/adapters/paths.ts'
import { readInbox, readOutbox } from '../../src/adapters/team-store.ts'
import { ackBytes, type Envelope, generateKey, type KeyPair, verify } from '../../src/core/team.ts'
import { backoffMs } from '../../src/core/tunnel.ts'
import { DEAD_MS, PING_MS, UNKNOWN_RETRY_MS, UP_RESETS_MS } from '../../src/services/team-hub.ts'
import { ackOf, question } from '../hub/harness.ts'
import { type FakeWs, HUB, handshake, settle, setup, stopAll, until } from '../support/team-service.ts'

afterEach(stopAll)

const teamFiles = (): string[] =>
  existsSync(stateDir()) ? readdirSync(stateDir()).filter(f => f.startsWith('team-')) : []

// ---- Off (D10)

test.each([
  ['absent', undefined],
  ['false', false],
  ['a string', 'x'],
  ['an empty object', {}],
  ['a hub that is no ws url', { hub: 'http://127.0.0.1:7443' }],
])('team %s: nothing is opened, timed, written or answered', async (_n, team) => {
  const s = setup(team)
  const timers: string[] = []
  const real = { st: globalThis.setTimeout, si: globalThis.setInterval }
  globalThis.setTimeout = ((...a: Parameters<typeof setTimeout>) => {
    timers.push('timeout')
    return real.st(...a)
  }) as typeof setTimeout
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => {
    timers.push('interval')
    return real.si(...a)
  }) as typeof setInterval
  try {
    s.svc.start()
    s.svc.refresh()
    s.svc.refresh()
    expect(await s.svc.send('P'.repeat(43), 'hi')).toEqual({ ok: false, error: 'off' })
    expect(s.svc.trust('P'.repeat(43))).toBe(false)
    s.svc.stop()
    s.svc.stop()
  } finally {
    globalThis.setTimeout = real.st
    globalThis.setInterval = real.si
  }
  expect(s.sockets).toHaveLength(0)
  expect(s.clock.timers()).toBe(0)
  expect(timers).toEqual([])
  expect(teamFiles()).toEqual([])
  expect(s.svc.view()).toBeNull()
  expect(s.svc.rev()).toBeNull()
  expect(s.svc.thread('P'.repeat(43))).toEqual([])
  expect(s.changes()).toBe(0)
})

test('team set later is picked up by refresh; unset again lets go of the socket and every timer', async () => {
  const s = setup(undefined)
  s.svc.start()
  expect(s.sockets).toHaveLength(0)
  s.cfg.team = { hub: HUB, name: 'me' }
  s.svc.refresh()
  const { ws } = await handshake(s)
  expect(s.clock.timers()).toBeGreaterThan(0) // the ping
  const before = s.changes()
  s.cfg.team = undefined
  s.svc.refresh()
  expect(ws.closed).not.toBeNull()
  expect(s.clock.timers()).toBe(0)
  expect(s.svc.view()).toBeNull()
  expect(s.changes()).toBeGreaterThan(before)
  s.svc.refresh()
  expect(s.sockets).toHaveLength(1)
})

// ---- The connection

test('it connects to <hub>/v1 and answers a challenge with its signature', async () => {
  const s = setup()
  s.svc.start()
  const { ws, me } = await handshake(s)
  expect(ws.url).toBe(`${HUB}/v1`)
  expect(s.svc.view()).toMatchObject({ state: 'online', hub: HUB, me: { peer: me, name: 'me' } })
})

test.each([`${HUB}/v1`, `${HUB}/`, `${HUB}/v1/`])(
  'a hub saved as %s is still dialled at <hub>/v1, once',
  async spelled => {
    const s = setup({ hub: spelled, name: 'me' })
    s.svc.start()
    const { ws } = await handshake(s)
    expect(ws.url).toBe(`${HUB}/v1`)
  },
)

test('after a lost connection it waits 1 s, 2 s, 4 s; staying up for 60 s starts the count over', async () => {
  const s = setup()
  s.svc.start()
  await until(() => s.sockets.length === 1, 'first socket')
  for (const attempt of [1, 2, 3]) {
    const ws = s.sockets[attempt - 1] as FakeWs
    ws.hangUp(1006)
    const wait = backoffMs(attempt, () => 0.5)
    expect(s.svc.view()).toMatchObject({ state: 'reconnecting', nextAt: s.clock.now() + wait })
    s.clock.tick(wait - 1)
    await settle()
    expect(s.sockets).toHaveLength(attempt)
    s.clock.tick(1)
    await until(() => s.sockets.length === attempt + 1, 'the next socket')
  }
  await handshake(s, [], 4)
  s.clock.tick(UP_RESETS_MS)
  ;(s.sockets[3] as FakeWs).hangUp(1006)
  expect(s.svc.view()?.nextAt).toBe(s.clock.now() + backoffMs(1, () => 0.5))
})

test('a connection the hub closes with 4403 is revoked: no retry, until config.json changes', async () => {
  const s = setup()
  s.svc.start()
  const { ws } = await handshake(s)
  ws.hangUp(4403)
  expect(s.svc.view()?.state).toBe('revoked')
  expect(s.clock.timers()).toBe(0)
  s.clock.tick(3_600_000)
  s.svc.refresh()
  await settle()
  expect(s.sockets).toHaveLength(1)
  s.cfg.team = { hub: HUB, name: 'me2' }
  s.svc.refresh()
  await until(() => s.sockets.length === 2, 'a new try')
})

test('it pings every 30 s and drops a hub that has been silent for 75 s', async () => {
  const s = setup()
  s.svc.start()
  const { ws } = await handshake(s)
  s.clock.tick(PING_MS)
  expect(ws.of('ping')).toHaveLength(1)
  ws.recv({ t: 'pong' })
  s.clock.tick(PING_MS)
  expect(ws.of('ping')).toHaveLength(2)
  s.clock.tick(DEAD_MS)
  expect(ws.closed).toBe(4000)
})

// ---- What comes in

const names = async (n: number): Promise<KeyPair[]> => Promise.all(Array.from({ length: n }, generateKey))

test('a question from a peer: kept once, the page told, a signed ack sent; a redelivery is acked again, kept once', async () => {
  const s = setup()
  s.svc.start()
  const [anna] = await names(1)
  const a = anna as KeyPair
  const { ws, me } = await handshake(s, [{ peer: a.pub, name: 'anna' }])
  const rev = s.svc.rev() ?? 0
  const env = await question(a, me, 'can you look at #231?')
  ws.recv({ t: 'deliver', env })
  await until(() => ws.of('ack').length === 1, 'an ack')
  expect(s.svc.rev()).toBeGreaterThan(rev)
  expect(s.svc.thread(a.pub)).toEqual([
    { id: env.id, dir: 'in', text: 'can you look at #231?', ts: env.ts, held: false },
  ])
  const ack = ws.of('ack')[0]
  expect(ack?.id).toBe(env.id)
  expect(await verify(me, ackBytes({ by: me, id: env.id, to: a.pub, ts: ack?.ts ?? '' }), ack?.sig ?? '')).toBe(true)
  const rev2 = s.svc.rev()
  ws.recv({ t: 'deliver', env })
  await until(() => ws.of('ack').length === 2, 'a second ack')
  expect(readInbox(a.pub)).toHaveLength(1)
  expect(s.svc.rev()).toBe(rev2)
  const log = readFileSync(teamAuditFile(), 'utf8')
  expect(log).not.toContain('can you look')
})

test('a bad signature, an unknown kind, junk and a message for someone else are dropped and logged, not acked', async () => {
  const s = setup()
  s.svc.start()
  const [anna, mallory] = (await names(2)) as [KeyPair, KeyPair]
  const { ws, me } = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
  const good = await question(anna, me, 'real')
  const forged: Envelope = { ...good, id: '00000000-0000-4000-8000-0000000000a1', body: { text: 'forged' } }
  const wrongSigner = await question(mallory, me, 'claims anna', { from: anna.pub })
  const odd = await question(anna, me, 'an offer', { kind: 'offer' as never })
  const elsewhere = await question(anna, mallory.pub, 'not for me')
  for (const e of [forged, wrongSigner, odd, elsewhere]) ws.recv({ t: 'deliver', env: e })
  ws.recv('{not json')
  ws.recv({ t: 'deliver', env: { v: 1 } })
  await settle()
  await settle()
  expect(ws.of('ack')).toHaveLength(0)
  expect(readInbox(anna.pub)).toEqual([])
  const lines = readFileSync(teamAuditFile(), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  const dropped = lines.filter(l => l.action === 'drop').map(l => l.why)
  expect(dropped.sort()).toEqual(['bad_frame', 'bad_sig', 'bad_sig', 'bad_sig', 'junk', 'kind'])
  expect(lines.filter(l => l.action === 'drop')).toHaveLength(6)
  expect(JSON.stringify(lines)).not.toContain('forged')
})

test('a key that appears under a pinned name is `changed`: its messages are held (and acked) until Trust', async () => {
  const s = setup()
  s.svc.start()
  const [old, fresh] = (await names(2)) as [KeyPair, KeyPair]
  const first = await handshake(s, [{ peer: old.pub, name: 'bob' }])
  expect(s.svc.view()?.roster[0]?.pin).toBe('trusted')
  first.ws.hangUp(1006)
  s.clock.tick(1000)
  const second = await handshake(s, [{ peer: fresh.pub, name: 'bob' }], 2)
  expect(s.svc.view()?.roster[0]).toMatchObject({ peer: fresh.pub, pin: 'changed' })
  const env = await question(fresh, second.me, 'it is me, bob')
  second.ws.recv({ t: 'deliver', env })
  await until(() => second.ws.of('ack').length === 1, 'the ack')
  // Held: the text is not in the thread at all until Trust, and nothing goes to that key.
  expect(s.svc.thread(fresh.pub)[0]).toMatchObject({ held: true, text: null })
  expect(JSON.stringify(s.svc.thread(fresh.pub))).not.toContain('it is me, bob')
  expect(await s.svc.send(fresh.pub, 'hello?')).toEqual({ ok: false, error: 'changed' })
  expect(readOutbox(fresh.pub)).toEqual([])
  expect(s.svc.trust(fresh.pub)).toBe(true)
  expect(s.svc.thread(fresh.pub)[0]).toMatchObject({ held: false, text: 'it is me, bob' })
  expect((await s.svc.send(fresh.pub, 'hello?')).ok).toBe(true)
  expect(s.svc.view()?.roster[0]?.pin).toBe('trusted')
  expect(s.svc.trust('Z'.repeat(43))).toBe(false)
})

// ---- What goes out

test('a question goes out signed; after a reconnect it goes again with the same id; acked only with a good ack', async () => {
  const s = setup()
  s.svc.start()
  const [anna] = (await names(1)) as [KeyPair]
  const first = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
  expect(await s.svc.send('Q'.repeat(43), 'who?')).toEqual({ ok: false, error: 'peer' })
  expect(await s.svc.send(anna.pub, '   ')).toEqual({ ok: false, error: 'text' })
  const sent = await s.svc.send(anna.pub, ' how do I join? ')
  expect(sent.ok).toBe(true)
  const id = sent.ok ? sent.id : ''
  expect(first.ws.of('send')).toHaveLength(1)
  const env = first.ws.of('send')[0]?.env as Envelope
  expect(env).toMatchObject({ id, to: anna.pub, from: first.me, kind: 'question', body: { text: 'how do I join?' } })
  first.ws.hangUp(1006)
  s.clock.tick(1000)
  const second = await handshake(s, [{ peer: anna.pub, name: 'anna' }], 2)
  expect(second.ws.of('send').map(f => f.env.id)).toEqual([id])
  second.ws.recv({ t: 'state', id, state: 'delivered', at: 5 })
  await until(() => readOutbox(anna.pub)[0]?.state === 'delivered', 'delivered')
  // An ack signed by someone else does not count.
  const [mallory] = (await names(1)) as [KeyPair]
  const forged = await ackOf(mallory, { ...env, from: first.me })
  second.ws.recv({ t: 'state', id, state: 'acked', at: 6, ack: { by: anna.pub, ts: forged.ts, sig: forged.sig } })
  await settle()
  expect(readOutbox(anna.pub)[0]?.state).toBe('delivered')
  const good = await ackOf(anna, env)
  second.ws.recv({ t: 'state', id, state: 'acked', at: 7, ack: { by: anna.pub, ts: good.ts, sig: good.sig } })
  await until(() => readOutbox(anna.pub)[0]?.state === 'acked', 'acked')
  expect(s.svc.thread(anna.pub).map(m => [m.dir, m.state])).toEqual([['out', 'acked']])
})

test('a key that is no peer id (__proto__ ...) is no pin, no recipient and no roster entry; Object.prototype stays clean (#231)', async () => {
  const s = setup()
  s.svc.start()
  const [anna] = (await names(1)) as [KeyPair]
  const { ws } = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
  for (const bad of ['__proto__', 'constructor', 'hasOwnProperty']) {
    expect(s.svc.trust(bad)).toBe(false)
    expect(await s.svc.send(bad, 'hi')).toEqual({ ok: false, error: 'peer' })
    expect(s.svc.thread(bad)).toEqual([])
  }
  ws.recv({ t: 'roster', peers: [{ peer: '__proto__', name: 'evil', online: true, last_seen: null }] })
  await settle()
  expect(s.svc.view()?.roster.map(p => p.peer)).toEqual([anna.pub])
  expect(({} as Record<string, unknown>).status).toBeUndefined()
})

test('a second welcome is ignored: no timer leaks, and stop() leaves none (#231)', async () => {
  const s = setup()
  s.svc.start()
  const { ws, me } = await handshake(s)
  const timers = s.clock.timers()
  for (let i = 0; i < 3; i++) ws.recv({ t: 'welcome', peer: me, name: 'me', hub: 'hub-1' })
  await settle()
  expect(s.clock.timers()).toBe(timers)
  s.svc.stop()
  expect(s.clock.timers()).toBe(0)
})

test('a hub that goes silent and never closes the socket is dropped and retried at once (#231)', async () => {
  const s = setup()
  s.svc.start()
  const { ws } = await handshake(s)
  s.clock.tick(DEAD_MS + PING_MS) // FakeWs never fires onclose
  expect(ws.closed).toBe(4000)
  expect(s.svc.view()).toMatchObject({ state: 'reconnecting', nextAt: expect.any(Number) })
  ws.hangUp(1006) // a late close of the dropped socket changes nothing
  expect(s.sockets).toHaveLength(1)
  s.clock.tick(backoffMs(1, () => 0.5))
  await until(() => s.sockets.length === 2, 'the next socket')
  s.svc.stop()
  expect(s.clock.timers()).toBe(0)
})

test('what the hub would refuse is refused by send() and never queued: 16 KiB of encoded envelope (#231)', async () => {
  const s = setup()
  s.svc.start()
  const [anna] = (await names(1)) as [KeyPair]
  const { ws } = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
  // 4000 characters, but each control character is written as 6 bytes in the encoded envelope.
  expect(await s.svc.send(anna.pub, '\u0001'.repeat(4000))).toEqual({ ok: false, error: 'too_big' })
  expect(readOutbox(anna.pub)).toEqual([])
  expect(ws.of('send')).toHaveLength(0)
})

test('a hub error naming a queued message settles it as refused (with the code): shown, never sent again (#231)', async () => {
  const s = setup()
  s.svc.start()
  const [anna] = (await names(1)) as [KeyPair]
  const first = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
  const sent = await s.svc.send(anna.pub, 'hello?')
  const kept = await s.svc.send(anna.pub, 'and this one?')
  expect(sent.ok && kept.ok).toBe(true)
  const id = sent.ok ? sent.id : ''
  first.ws.recv({ t: 'error', code: 'not_member', id, message: 'the recipient is not a member' })
  await until(() => readOutbox(anna.pub)[0]?.state === 'refused', 'refused')
  expect(s.svc.thread(anna.pub)[0]).toMatchObject({ id, state: 'refused', code: 'not_member' })
  // A late state for it does not bring it back.
  first.ws.recv({ t: 'state', id, state: 'delivered', at: 9 })
  await settle()
  expect(readOutbox(anna.pub)[0]?.state).toBe('refused')
  first.ws.hangUp(1006)
  s.clock.tick(1000)
  const second = await handshake(s, [{ peer: anna.pub, name: 'anna' }], 2)
  expect(second.ws.of('send').map(f => f.env.id)).toEqual([kept.ok ? kept.id : ''])
})

test('a connection the hub closes with 4401 is an error `unknown_peer`, retried at the long interval, not `reconnecting` (#231)', async () => {
  const s = setup()
  s.svc.start()
  await until(() => s.sockets.length === 1, 'first socket')
  ;(s.sockets[0] as FakeWs).hangUp(4401)
  expect(s.svc.view()).toMatchObject({
    state: 'error',
    error: 'unknown_peer',
    nextAt: s.clock.now() + UNKNOWN_RETRY_MS,
  })
  s.clock.tick(UNKNOWN_RETRY_MS - 1)
  await settle()
  expect(s.sockets).toHaveLength(1)
  s.clock.tick(1)
  await until(() => s.sockets.length === 2, 'the next try')
  // Under way again, the line still says why; it goes on being retried that rarely.
  expect(s.svc.view()).toMatchObject({ state: 'error', error: 'unknown_peer' })
  ;(s.sockets[1] as FakeWs).hangUp(4401)
  expect(s.svc.view()?.nextAt).toBe(s.clock.now() + UNKNOWN_RETRY_MS)
})
