// The hub's door (#231): hello, challenge, auth or join by invite, the roster and presence only
// for those inside, and a revoked peer shut out at once. Real sockets on port 0, a clock the test
// moves.
import { afterEach, beforeEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { authBytes, joinBytes, type KeyPair, sign } from '../../src/core/team.ts'
import { type Harness, keys, startHarness } from './harness.ts'

let h: Harness
let A: KeyPair
let B: KeyPair
let C: KeyPair
beforeEach(async () => {
  h = await startHarness()
  ;[A, B, C] = (await keys(3)) as [KeyPair, KeyPair, KeyPair]
})
afterEach(() => h.stop())

test('an invite joins: welcome, then the roster with the new peer online', async () => {
  const a = await h.join(A, 'anna')
  const roster = await a.take('roster')
  assert.deepEqual(
    roster.peers.map(p => [p.peer, p.name, p.online]),
    [[A.pub, 'anna', true]],
  )
  assert.equal(h.db.peer(A.pub)?.status, 'active')
  assert.equal(h.db.auditRows().at(-1)?.action, 'join')
})

test('a member comes back with auth alone', async () => {
  const a = await h.join(A, 'anna')
  a.close()
  await a.closed
  const again = await h.login(A)
  const w = await again.take('roster')
  assert.equal(w.peers[0]?.name, 'anna')
})

test('a reused invite is refused with 4403', async () => {
  const code = h.invite()
  await h.join(A, 'anna', code)
  const { c, nonce } = await h.hello(B)
  c.send({
    t: 'join',
    invite: code,
    name: 'ben',
    sig: await sign(B.pkcs8, joinBytes({ hub: h.hubId, invite: code, name: 'ben', nonce, peer: B.pub })),
  })
  assert.equal((await c.take('error')).code, 'invite_invalid')
  assert.equal((await c.closed).code, 4403)
  assert.equal(h.db.peer(B.pub), null)
})

test('an expired invite and a revoked one are refused with 4403', async () => {
  const old = h.invite(1000)
  const gone = h.db.createInvite(h.clock.now(), 3_600_000, null)
  h.db.revokeInvite(gone.id, h.clock.now())
  h.clock.tick(2000)
  for (const code of [old, gone.code, 'hab-nope']) {
    const { c, nonce } = await h.hello(B)
    c.send({
      t: 'join',
      invite: code,
      name: 'ben',
      sig: await sign(B.pkcs8, joinBytes({ hub: h.hubId, invite: code, name: 'ben', nonce, peer: B.pub })),
    })
    assert.equal((await c.take('error')).code, 'invite_invalid')
    assert.equal((await c.closed).code, 4403)
  }
  assert.equal(h.db.peers().length, 0)
})

test('a name in use is refused; the invite stays open', async () => {
  await h.join(A, 'anna')
  const code = h.invite()
  const { c, nonce } = await h.hello(B)
  c.send({
    t: 'join',
    invite: code,
    name: 'anna',
    sig: await sign(B.pkcs8, joinBytes({ hub: h.hubId, invite: code, name: 'anna', nonce, peer: B.pub })),
  })
  assert.equal((await c.take('error')).code, 'name_taken')
  assert.equal((await c.closed).code, 4400)
  assert.equal(h.db.invites(h.clock.now()).find(i => i.state === 'open') !== undefined, true)
})

test('an unknown peer is closed with 4401', async () => {
  const { c, nonce } = await h.hello(A)
  c.send({ t: 'auth', sig: await sign(A.pkcs8, authBytes({ hub: h.hubId, nonce, peer: A.pub })) })
  assert.equal((await c.take('error')).code, 'unknown_peer')
  assert.equal((await c.closed).code, 4401)
})

test('a signature by another key, or over another hub, is bad_sig with 4401', async () => {
  await h.join(A, 'anna')
  for (const [signer, hub] of [
    [B, h.hubId],
    [A, 'hub-other'],
  ] as const) {
    const { c, nonce } = await h.hello(A)
    c.send({ t: 'auth', sig: await sign(signer.pkcs8, authBytes({ hub, nonce, peer: A.pub })) })
    assert.equal((await c.take('error')).code, 'bad_sig')
    assert.equal((await c.closed).code, 4401)
  }
  // Garbage is no signature either.
  const { c } = await h.hello(A)
  c.send({ t: 'auth', sig: 'x' })
  assert.equal((await c.take('error')).code, 'bad_sig')
})

test('a challenge older than 30 s is dead', async () => {
  const a = await h.join(A, 'anna')
  a.close()
  await a.closed
  const { c, nonce } = await h.hello(A)
  h.clock.tick(31_000)
  c.send({ t: 'auth', sig: await sign(A.pkcs8, authBytes({ hub: h.hubId, nonce, peer: A.pub })) })
  assert.equal((await c.closed).code, 4400)
  assert.equal(h.hub.online(A.pub), false)
})

test('the wrong protocol version, and frames out of order, are 4400', async () => {
  const v = await h.connect()
  v.send({ t: 'hello', v: 2, peer: A.pub, client: 't' })
  assert.equal((await v.take('error')).code, 'version')
  assert.equal((await v.closed).code, 4400)
  for (const first of [{ t: 'ping' }, { t: 'auth', sig: 'x' }, 'not json', { t: 'send', env: {} }]) {
    const c = await h.connect()
    c.send(first)
    assert.equal((await c.closed).code, 4400)
  }
  const { c } = await h.hello(A)
  c.send({ t: 'ping' })
  assert.equal((await c.closed).code, 4400)
})

test('before auth nothing is seen: no roster, no presence', async () => {
  const a = await h.join(A, 'anna')
  const { c } = await h.hello(B)
  const b = await h.join(C, 'cy')
  b.close()
  const seen = await c.settle()
  assert.deepEqual(
    seen.map(f => f.t),
    [],
  )
  assert.ok(a)
})

test('two peers see each other come and go', async () => {
  const a = await h.join(A, 'anna')
  await a.take('roster')
  const b = await h.join(B, 'ben')
  const broster = await b.take('roster')
  assert.deepEqual(broster.peers.map(p => [p.name, p.online]).sort(), [
    ['anna', true],
    ['ben', true],
  ])
  // anna is told of the new member (roster) and that ben is online (presence)
  assert.deepEqual((await a.take('roster')).peers.map(p => p.name).sort(), ['anna', 'ben'])
  const on = await a.take('presence')
  assert.deepEqual([on.peer, on.online], [B.pub, true])
  b.close()
  await b.closed
  const off = await a.take('presence')
  assert.deepEqual([off.peer, off.online], [B.pub, false])
  const back = await h.login(B)
  assert.equal((await a.take('presence')).online, true)
  assert.ok(back)
  const events = h.db.raw.query<{ state: string }, []>('SELECT state FROM presence_event ORDER BY rowid').all()
  assert.deepEqual(
    events.map(e => e.state),
    ['online', 'online', 'offline', 'online'],
  )
})

test('a second connection of a peer replaces the first with 4409, and is never shown offline', async () => {
  const a1 = await h.join(A, 'anna')
  const b = await h.join(B, 'ben')
  await b.take('roster')
  const a2 = await h.login(A)
  assert.equal((await a1.closed).code, 4409)
  assert.equal(h.hub.online(A.pub), true)
  assert.ok(a2)
  // The peer never went offline, so there is no presence frame at all.
  assert.equal((await b.settle()).filter(f => f.t === 'presence').length, 0)
})

test('revoke closes the peer at once, tells the others, and the door stays shut', async () => {
  const a = await h.join(A, 'anna')
  const b = await h.join(B, 'ben')
  await a.settle()
  a.frames.length = 0
  const t0 = Date.now()
  assert.equal(h.hub.revoke('ben')?.status, 'revoked')
  assert.equal((await b.closed).code, 4403)
  assert.ok(Date.now() - t0 < 1000)
  const r = await a.take('roster')
  assert.deepEqual(
    r.peers.map(p => p.name),
    ['anna'],
  )
  assert.equal(h.hub.online(B.pub), false)
  assert.equal(h.hub.revoke('ben'), null)
  const { c, nonce } = await h.hello(B)
  c.send({ t: 'auth', sig: await sign(B.pkcs8, authBytes({ hub: h.hubId, nonce, peer: B.pub })) })
  assert.equal((await c.take('error')).code, 'revoked')
  assert.equal((await c.closed).code, 4403)
  assert.equal(
    h.db.auditRows().some(r => r.action === 'revoke' && r.peer_id === B.pub),
    true,
  )
})

test('the hub answers a ping, and says so at GET /', async () => {
  const a = await h.join(A, 'anna')
  a.send({ t: 'ping' })
  await a.take('pong')
  const r = await fetch(`http://127.0.0.1:${h.server.port}/`)
  assert.equal(await r.text(), 'agent-board hub\n')
})
