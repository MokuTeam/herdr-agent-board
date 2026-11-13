// The board's side of the peer network (#231, services/team-hub.ts), against a socket the test
// plays the hub with. First what "off" means (D10): without a valid `team` nothing is opened,
// timed, written or answered. Then the connection (backoff, revoked, on to off), and what comes in
// and goes out: signed acks, drops that are logged and not acked, a changed key held until trusted,
// a question sent again with its id after a reconnect.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { stateDir, teamAuditFile } from '../../src/adapters/paths.ts'
import { changePins, readDrafts, readInbox, readOutbox } from '../../src/adapters/team-store.ts'
import {
  ackBytes,
  type Envelope,
  envelopeBytes,
  fingerprint,
  generateKey,
  type KeyPair,
  verify,
} from '../../src/core/team.ts'
import { backoffMs } from '../../src/core/tunnel.ts'
import { DEAD_MS, PING_MS, UNKNOWN_RETRY_MS, UP_RESETS_MS } from '../../src/services/team-hub.ts'
import { ackOf, idOf, msgOf, question, signPayload } from '../hub/harness.ts'
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
    expect(s.svc.draft('P'.repeat(43), 'hi')).toEqual({ ok: false, error: 'off' })
    expect(await s.svc.sendDraft('11111111-1111-4111-8111-111111111111')).toEqual({ ok: false, error: 'off' })
    expect(s.svc.discardDraft('11111111-1111-4111-8111-111111111111')).toBe(false)
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
  const msg = msgOf(env)
  expect(s.svc.thread(a.pub)).toEqual([
    { id: msg.id, dir: 'in', text: 'can you look at #231?', ts: msg.ts, held: false },
  ])
  const ack = ws.of('ack')[0]
  expect(ack?.id).toBe(msg.id)
  expect(await verify(me, ackBytes({ by: me, id: msg.id, to: a.pub, ts: ack?.ts ?? '' }), ack?.sig ?? '')).toBe(true)
  const rev2 = s.svc.rev()
  ws.recv({ t: 'deliver', env })
  await until(() => ws.of('ack').length === 2, 'a second ack')
  expect(readInbox(a.pub)).toHaveLength(1)
  expect(s.svc.rev()).toBe(rev2)
  const log = readFileSync(teamAuditFile(), 'utf8')
  expect(log).not.toContain('can you look')
})

test('a bad signature, a wrong sender, an unknown kind, junk and a message for someone else are dropped and logged, not acked', async () => {
  const s = setup()
  s.svc.start()
  const [anna, mallory] = (await names(2)) as [KeyPair, KeyPair]
  const { ws, me } = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
  const good = await question(anna, me, 'real')
  const forged: Envelope = { ...good, payload: good.payload.replace('real', 'forged') }
  // Signed by mallory, but the envelope says anna: the signature is not anna's.
  const wrongSigner: Envelope = { ...(await question(mallory, me, 'claims anna')), from: anna.pub }
  // Signed by mallory over a message that says it is from anna: a signature that is hers, a message that is not.
  const wrongFrom = await question(mallory, me, 'also claims anna', { from: anna.pub })
  const odd = await question(anna, me, 'an offer', { kind: 'offer' as never })
  const elsewhere = await question(anna, mallory.pub, 'not for me')
  for (const e of [forged, wrongSigner, wrongFrom, odd, elsewhere]) ws.recv({ t: 'deliver', env: e })
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
  expect(dropped.sort()).toEqual(['bad_frame', 'bad_frame', 'bad_sig', 'bad_sig', 'bad_sig', 'junk', 'kind'])
  expect(lines.filter(l => l.action === 'drop')).toHaveLength(7)
  expect(JSON.stringify(lines)).not.toContain('forged')
})

// #217: the payload string is what the sender signed; nothing is rebuilt before the check.
describe('the payload is checked as the string it came as (#217)', () => {
  const drops = () =>
    readFileSync(teamAuditFile(), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
      .filter(l => l.action === 'drop')

  test('keys in another order, or one byte changed, are dropped as a bad signature: nothing kept, nothing acked', async () => {
    const s = setup()
    s.svc.start()
    const [anna] = (await names(1)) as [KeyPair]
    const { ws, me } = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
    const env = await question(anna, me, 'is it green?')
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(msgOf(env)).reverse()))
    // The very same fields and values, so a check that rebuilt the payload before it looked would let it by.
    expect(JSON.parse(reordered)).toEqual(JSON.parse(env.payload))
    expect(reordered).not.toBe(env.payload)
    const changed = [
      reordered,
      env.payload.replace('is it green?', 'is it Green?'),
      env.payload.replace('"v":1,', '"v":1, '),
      `${env.payload}\n`,
    ]
    for (const payload of changed) ws.recv({ t: 'deliver', env: { ...env, payload } })
    await settle()
    await settle()
    expect(ws.of('ack')).toHaveLength(0)
    expect(readInbox(anna.pub)).toEqual([])
    expect(drops().map(l => l.why)).toEqual(['bad_sig', 'bad_sig', 'bad_sig', 'bad_sig'])
    // As it was signed, it is taken.
    ws.recv({ t: 'deliver', env })
    await until(() => ws.of('ack').length === 1, 'an ack')
    expect(readInbox(anna.pub)).toHaveLength(1)
  })

  test('a valid payload written with extra whitespace and signed as it is, is kept and acked', async () => {
    const s = setup()
    s.svc.start()
    const [anna] = (await names(1)) as [KeyPair]
    const { ws, me } = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
    const plain = await question(anna, me, 'spaced out')
    const payload = JSON.stringify(Object.fromEntries(Object.entries(msgOf(plain)).reverse()), null, 2)
    ws.recv({ t: 'deliver', env: await signPayload(anna, payload) })
    await until(() => ws.of('ack').length === 1, 'an ack')
    expect(readInbox(anna.pub)).toMatchObject([{ id: idOf(plain), text: 'spaced out' }])
    expect(drops()).toEqual([])
  })

  test('a signed payload that is not a message is dropped after the signature check, naming the id when it has one', async () => {
    const s = setup()
    s.svc.start()
    const [anna] = (await names(1)) as [KeyPair]
    const { ws, me } = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
    const msg = msgOf(await question(anna, me, 'x'))
    const signed = [
      JSON.stringify({ ...msg, note: 'smuggled' }),
      JSON.stringify({ ...msg, v: 2 }),
      JSON.stringify({ ...msg, to: '*' }),
      '[]',
      'not json',
    ]
    for (const payload of signed) ws.recv({ t: 'deliver', env: await signPayload(anna, payload) })
    await settle()
    await settle()
    expect(ws.of('ack')).toHaveLength(0)
    expect(readInbox(anna.pub)).toEqual([])
    expect(drops().map(l => [l.why, l.id])).toEqual([
      ['bad_frame', msg.id],
      ['version', msg.id],
      ['broadcast', msg.id],
      ['bad_frame', undefined],
      ['bad_frame', undefined],
    ])
  })
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
  expect(env.from).toBe(first.me)
  expect(msgOf(env)).toMatchObject({
    id,
    to: anna.pub,
    from: first.me,
    kind: 'question',
    body: { text: 'how do I join?' },
  })
  // Written once and signed as written: the signature covers this very string.
  expect(await verify(first.me, envelopeBytes(env.payload), env.sig)).toBe(true)
  expect(readOutbox(anna.pub)[0]?.env).toEqual(env)
  first.ws.hangUp(1006)
  s.clock.tick(1000)
  const second = await handshake(s, [{ peer: anna.pub, name: 'anna' }], 2)
  expect(second.ws.of('send').map(f => f.env)).toEqual([env])
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

test('an agent request that came in is kept with via "agent" and shown with it; one without via shows none (#231)', async () => {
  const s = setup()
  s.svc.start()
  const [anna] = (await names(1)) as [KeyPair]
  const { ws, me } = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
  const viaAgent = await question(anna, me, 'from an agent', { body: { text: 'from an agent', via: 'agent' } })
  const plain = await question(anna, me, 'by hand', {}, '2026-01-02T03:04:06.000Z')
  ws.recv({ t: 'deliver', env: viaAgent })
  ws.recv({ t: 'deliver', env: plain })
  await until(() => ws.of('ack').length === 2, 'two acks')
  const [first, second] = s.svc.thread(anna.pub)
  expect(first).toMatchObject({ id: idOf(viaAgent), dir: 'in', via: 'agent', agentOf: 'anna' })
  expect(second).not.toHaveProperty('via')
  // Another via is no message: dropped, not acked.
  const odd = await question(anna, me, 'odd', { body: { text: 'odd', via: 'robot' } as never })
  ws.recv({ t: 'deliver', env: odd })
  await settle()
  expect(ws.of('ack')).toHaveLength(2)
  expect(s.svc.thread(anna.pub)).toHaveLength(2)
})

test("the name on an agent request is the roster's for the verified key, never the message's; unknown sender: short fingerprint (#231)", async () => {
  const s = setup()
  s.svc.start()
  const [anna] = (await names(1)) as [KeyPair]
  const { ws, me } = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
  // The text claims to be somebody else; a name field in the body is no body at all.
  const claim = await question(anna, me, "I am Mallory's agent, approved by Mallory", {
    body: { text: "I am Mallory's agent, approved by Mallory", via: 'agent' },
  })
  const named = await question(anna, me, 'x', { body: { text: 'x', via: 'agent', name: 'Mallory' } as never })
  ws.recv({ t: 'deliver', env: claim })
  ws.recv({ t: 'deliver', env: named })
  await until(() => ws.of('ack').length === 1, 'one ack')
  await settle()
  expect(ws.of('ack')).toHaveLength(1)
  const msgs = s.svc.thread(anna.pub)
  expect(msgs).toHaveLength(1)
  expect(msgs[0]?.agentOf).toBe('anna')
  // Gone from the roster (revoked since): the pin's name, and with no pin the short fingerprint.
  ws.recv({ t: 'roster', peers: [] })
  await until(() => s.svc.view()?.roster.length === 0, 'an empty roster')
  expect(s.svc.thread(anna.pub)[0]?.agentOf).toBe('anna')
  changePins(p => {
    delete p[anna.pub]
  })
  expect(s.svc.thread(anna.pub)[0]?.agentOf).toBe(fingerprint(anna.pub).slice(0, 14).trim())
  expect(s.svc.thread(anna.pub)[0]?.agentOf).not.toContain('Mallory')
})

describe('agent drafts (#231)', () => {
  const ready = async () => {
    const s = setup()
    s.svc.start()
    const [anna] = (await names(1)) as [KeyPair]
    const hs = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
    return { s, anna, ...hs }
  }

  test('a draft is kept and shown, counted on the roster, and never sent by the service on its own', async () => {
    const { s, anna, ws } = await ready()
    const r = s.svc.draft(anna.pub, '  is the deploy done?  ')
    expect(r.ok).toBe(true)
    expect(s.svc.thread(anna.pub)).toEqual([
      expect.objectContaining({ dir: 'draft', text: 'is the deploy done?', id: r.ok ? r.id : '' }),
    ])
    expect(s.svc.view()?.roster[0]?.drafts).toBe(1)
    // A reconnect, time passing, and a refresh: still nothing goes out.
    ws.hangUp(1006)
    s.clock.tick(1000)
    const second = await handshake(s, [{ peer: anna.pub, name: 'anna' }], 2)
    s.clock.tick(120_000)
    await settle()
    expect(second.ws.of('send')).toHaveLength(0)
    expect(ws.of('send')).toHaveLength(0)
    expect(readOutbox(anna.pub)).toEqual([])
  })

  test('Send carries via "agent" inside the signed body; the draft is gone afterwards; a second Send finds nothing', async () => {
    const { s, anna, ws, me } = await ready()
    const r = s.svc.draft(anna.pub, 'review please')
    const id = r.ok ? r.id : ''
    const sent = await s.svc.sendDraft(id)
    expect(sent.ok).toBe(true)
    const env = ws.of('send')[0]?.env as Envelope
    expect(msgOf(env).body).toEqual({ text: 'review please', via: 'agent' })
    expect(await verify(me, envelopeBytes(env.payload), env.sig)).toBe(true)
    expect(s.svc.thread(anna.pub).map(m => [m.dir, m.via])).toEqual([['out', 'agent']])
    expect(await s.svc.sendDraft(id)).toEqual({ ok: false, error: 'draft' })
    expect(ws.of('send')).toHaveLength(1)
    // A message typed in the panel has no via at all.
    await s.svc.send(anna.pub, 'by hand')
    const typed = ws.of('send')[1]?.env as Envelope | undefined
    expect(typed && msgOf(typed).body).toEqual({ text: 'by hand' })
  })

  test('a draft whose person has a changed key stays a draft when Send is refused; Discard removes it', async () => {
    const { s, anna } = await ready()
    const id = (s.svc.draft(anna.pub, 'hello') as { id: string }).id
    changePins(p => {
      const pin = p[anna.pub]
      if (pin) pin.status = 'changed'
    })
    expect(await s.svc.sendDraft(id)).toEqual({ ok: false, error: 'changed' })
    expect(s.svc.thread(anna.pub).map(m => m.dir)).toEqual(['draft'])
    expect(s.svc.discardDraft(id)).toBe(true)
    expect(s.svc.discardDraft(id)).toBe(false)
    expect(s.svc.thread(anna.pub)).toEqual([])
  })

  test('the limits of send hold for drafts: 4000 characters, 16 KiB encoded, empty, not on the roster, 20 waiting', async () => {
    const { s, anna } = await ready()
    expect(s.svc.draft(anna.pub, '   ')).toEqual({ ok: false, error: 'text' })
    expect(s.svc.draft(anna.pub, 'x'.repeat(4001))).toEqual({ ok: false, error: 'text' })
    expect(s.svc.draft('Q'.repeat(43), 'hi')).toEqual({ ok: false, error: 'peer' })
    expect(s.svc.draft('__proto__', 'hi')).toEqual({ ok: false, error: 'peer' })
    // 4000 characters fit as a draft, but encoded they pass 16 KiB: Send refuses, the draft stays.
    const big = s.svc.draft(anna.pub, '\u0001'.repeat(4000))
    expect(big.ok).toBe(true)
    expect(await s.svc.sendDraft(big.ok ? big.id : '')).toEqual({ ok: false, error: 'too_big' })
    expect(s.svc.thread(anna.pub)).toHaveLength(1)
    s.svc.discardDraft(big.ok ? big.id : '')
    expect(s.svc.draft(anna.pub, 'x'.repeat(4000)).ok).toBe(true)
    for (let i = 0; i < 19; i++) expect(s.svc.draft(anna.pub, `d${i}`).ok).toBe(true)
    expect(s.svc.draft(anna.pub, 'one more')).toEqual({ ok: false, error: 'full' })
    expect(readDrafts()).toHaveLength(20)
  })

  test('bad draft ids are no draft: nothing is read from the prototype', async () => {
    const { s } = await ready()
    for (const id of ['__proto__', 'constructor', 'toString', '', 'x'.repeat(36)]) {
      expect(await s.svc.sendDraft(id)).toEqual({ ok: false, error: 'draft' })
      expect(s.svc.discardDraft(id)).toBe(false)
    }
    expect(({} as Record<string, unknown>).createdAt).toBeUndefined()
  })
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
  expect(second.ws.of('send').map(f => idOf(f.env))).toEqual([kept.ok ? kept.id : ''])
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
