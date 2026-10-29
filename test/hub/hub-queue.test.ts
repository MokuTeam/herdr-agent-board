// The hub's queue (#231): send, deliver, signed ack, idempotency, the TTL sweeper, and that no
// body is ever written anywhere but the queue itself.
import { afterEach, beforeEach, describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { ackBytes, envelopeBytes, type KeyPair, sign, verify } from '../../src/core/team.ts'
import { ackOf, type Harness, idOf, keys, msgOf, question, signPayload, startHarness } from './harness.ts'

let h: Harness
let A: KeyPair
let B: KeyPair
let C: KeyPair
beforeEach(async () => {
  h = await startHarness()
  ;[A, B, C] = (await keys(3)) as [KeyPair, KeyPair, KeyPair]
})
afterEach(() => h.stop())

const MARKER = 'zebra-marker-7731'

test('a body with via "agent" is relayed unchanged, signature and all (#231)', async () => {
  const a = await h.join(A, 'anna')
  const b = await h.join(B, 'ben')
  const env = await question(A, B.pub, 'asked by an agent', { body: { text: 'asked by an agent', via: 'agent' } })
  a.send({ t: 'send', env })
  const d = await b.take('deliver')
  assert.deepEqual(d.env, env)
  assert.equal(msgOf(d.env).body.via, 'agent')
  assert.equal(await verify(A.pub, envelopeBytes(d.env.payload), d.env.sig), true)
  // A via the board never writes is refused by the hub, not relayed.
  const bad = await question(A, B.pub, 'x', { body: { text: 'x', via: 'human' } as never })
  a.send({ t: 'send', env: bad })
  assert.equal((await a.take('error')).code, 'bad_frame')
})

test('offline recipient: queued, delivered on connect, signed ack comes back as acked', async () => {
  const a = await h.join(A, 'anna')
  const b0 = await h.join(B, 'ben')
  b0.close()
  await b0.closed
  const env = await question(A, B.pub, `${MARKER} hello`)
  a.send({ t: 'send', env })
  const queued = await a.take('state')
  assert.deepEqual([queued.id, queued.state], [idOf(env), 'queued'])
  assert.equal(h.db.message(idOf(env))?.state, 'queued')

  const b = await h.login(B)
  const d = await b.take('deliver')
  assert.deepEqual(d.env, env)
  const delivered = await a.take('state')
  assert.deepEqual([delivered.id, delivered.state], [idOf(env), 'delivered'])

  b.send(await ackOf(B, env))
  const acked = await a.take('state')
  assert.equal(acked.state, 'acked')
  assert.equal(acked.ack?.by, B.pub)
  assert.equal(
    await verify(
      B.pub,
      ackBytes({ by: B.pub, id: idOf(env), to: A.pub, ts: acked.ack?.ts ?? '' }),
      acked.ack?.sig ?? '',
    ),
    true,
  )
  const row = h.db.message(idOf(env))
  assert.equal(row?.state, 'acked')
  assert.equal(row?.payload, null)
})

test('online recipient gets it at once; the sender sees queued then delivered', async () => {
  const a = await h.join(A, 'anna')
  const b = await h.join(B, 'ben')
  const env = await question(A, B.pub, 'now')
  a.send({ t: 'send', env })
  assert.equal(idOf((await b.take('deliver')).env), idOf(env))
  assert.equal((await a.take('state')).state, 'queued')
  assert.equal((await a.take('state')).state, 'delivered')
})

test('a delivered message that was not acked is delivered again after a reconnect', async () => {
  const a = await h.join(A, 'anna')
  const b = await h.join(B, 'ben')
  const env = await question(A, B.pub, 'again')
  a.send({ t: 'send', env })
  await b.take('deliver')
  b.close()
  await b.closed
  const b2 = await h.login(B)
  assert.equal(idOf((await b2.take('deliver')).env), idOf(env))
})

test('the same id and content again is no duplicate: one row, one delivery, the state again', async () => {
  const a = await h.join(A, 'anna')
  const b = await h.join(B, 'ben')
  const env = await question(A, B.pub, 'once')
  a.send({ t: 'send', env })
  await b.take('deliver')
  await a.take('state')
  await a.take('state')
  a.send({ t: 'send', env })
  assert.equal((await a.take('state')).state, 'delivered')
  assert.equal(h.db.raw.query<{ n: number }, []>('SELECT count(*) AS n FROM message').get()?.n, 1)
  assert.equal((await b.settle()).filter(f => f.t === 'deliver').length, 0)
})

test('the same id with other content is dup_id, and so is another sender using it', async () => {
  const a = await h.join(A, 'anna')
  const b = await h.join(B, 'ben')
  const env = await question(A, B.pub, 'first')
  a.send({ t: 'send', env })
  await a.take('state')
  const other = await question(A, B.pub, 'second', { id: idOf(env) })
  a.send({ t: 'send', env: other })
  const e = await a.take('error')
  assert.deepEqual([e.code, e.id], ['dup_id', idOf(env)])
  const theirs = await question(B, A.pub, 'mine', { id: idOf(env) })
  b.send({ t: 'send', env: theirs })
  assert.equal((await b.take('error')).code, 'dup_id')
  assert.equal(h.db.message(idOf(env))?.from_peer, A.pub)
})

test('refusals leave the socket open and queue nothing', async () => {
  const a = await h.join(A, 'anna')
  const b = await h.join(B, 'ben')
  await h.join(C, 'cy').then(c => c.close())
  h.hub.revoke('cy')
  const cases: Array<[string, unknown]> = [
    ['broadcast', await question(A, '*', 'all')],
    ['not_member', await question(A, 'N'.repeat(43), 'who')],
    ['not_member', await question(A, C.pub, 'revoked')],
    ['bad_sig', await question(B, A.pub, 'as ben')],
    ['kind', await question(A, B.pub, 'x', { kind: 'offer' as never })],
    ['version', await question(A, B.pub, 'x', { v: 2 })],
    ['bad_frame', await question(A, B.pub, 'x'.repeat(4001))],
    ['bad_frame', await question(A, A.pub, 'self')],
    ['too_big', await signPayload(A, `${(await question(A, B.pub, 'big')).payload}${' '.repeat(17_000)}`)],
    ['bad_frame', { nothing: true }],
    ['bad_frame', 'junk'],
  ]
  for (const [code, env] of cases) {
    a.send({ t: 'send', env })
    assert.equal((await a.take('error')).code, code, code)
  }
  // A signature of someone else's over A's envelope.
  const forged = await question(A, B.pub, 'forged')
  a.send({ t: 'send', env: { ...forged, sig: await sign(B.pkcs8, envelopeBytes(forged.payload)) } })
  assert.equal((await a.take('error')).code, 'bad_sig')
  // A tampered body.
  const tampered = await question(A, B.pub, 'real')
  a.send({ t: 'send', env: { ...tampered, payload: tampered.payload.replace('real', 'fake') } })
  assert.equal((await a.take('error')).code, 'bad_sig')
  assert.equal(h.db.raw.query<{ n: number }, []>('SELECT count(*) AS n FROM message').get()?.n, 0)
  assert.equal((await b.settle()).filter(f => f.t === 'deliver').length, 0)
  a.send({ t: 'ping' })
  await a.take('pong')
})

test('an ack by the wrong peer, over the wrong data, or for nothing is refused', async () => {
  const a = await h.join(A, 'anna')
  const b = await h.join(B, 'ben')
  const c = await h.join(C, 'cy')
  const env = await question(A, B.pub, 'ack me')
  a.send({ t: 'send', env })
  await b.take('deliver')
  c.send(await ackOf(C, env))
  assert.equal((await c.take('error')).code, 'bad_frame')
  b.send({ ...(await ackOf(B, env)), ts: '2030-01-01T00:00:00.000Z' })
  assert.equal((await b.take('error')).code, 'bad_sig')
  b.send({ t: 'ack', id: 'nothing', ts: '2026-01-01T00:00:00.000Z', sig: 's' })
  assert.equal((await b.take('error')).code, 'bad_frame')
  assert.equal(h.db.message(idOf(env))?.state, 'delivered')
  b.send(await ackOf(B, env))
  await new Promise(r => setTimeout(r, 50))
  assert.equal(h.db.message(idOf(env))?.state, 'acked')
  // A second ack changes nothing.
  b.send(await ackOf(B, env, '2026-02-02T00:00:00.000Z'))
  await new Promise(r => setTimeout(r, 50))
  assert.equal(JSON.parse(h.db.message(idOf(env))?.ack_json ?? '{}').ts, '2026-01-02T03:05:00.000Z')
})

test('the sweeper expires what is due, drops the body and tells the sender', async () => {
  const a = await h.join(A, 'anna')
  const b = await h.join(B, 'ben')
  b.close()
  await b.closed
  const env = await question(A, B.pub, `${MARKER} soon`, { ttl_s: 60 })
  a.send({ t: 'send', env })
  await a.take('state')
  h.clock.tick(59_000)
  assert.equal(h.db.message(idOf(env))?.state, 'queued')
  h.clock.tick(2000)
  const gone = await a.take('state')
  assert.deepEqual([gone.id, gone.state], [idOf(env), 'expired'])
  assert.equal(h.db.message(idOf(env))?.payload, null)
  const b2 = await h.login(B)
  assert.equal((await b2.settle()).filter(f => f.t === 'deliver').length, 0)
  assert.equal(
    h.db.auditRows().some(r => r.action === 'expired'),
    true,
  )
})

test('a sender that was away is told of the expiry on its next welcome, once', async () => {
  const a0 = await h.join(A, 'anna')
  await h.join(B, 'ben').then(async b => {
    b.close()
    await b.closed
  })
  const env = await question(A, B.pub, 'while away', { ttl_s: 60 })
  a0.send({ t: 'send', env })
  await a0.take('state')
  a0.close()
  await a0.closed
  h.clock.tick(120_000)
  assert.equal(h.db.message(idOf(env))?.state, 'expired')
  const a = await h.login(A)
  assert.equal((await a.take('state')).state, 'expired')
  a.close()
  await a.closed
  const again = await h.login(A)
  assert.equal((await again.settle()).filter(f => f.t === 'state').length, 0)
})

test('ttl is clamped to 60 s .. 7 days; an acked message does not expire', async () => {
  const a = await h.join(A, 'anna')
  const b = await h.join(B, 'ben')
  const short = await question(A, B.pub, 'short', { ttl_s: 1 })
  const long = await question(A, B.pub, 'long', { ttl_s: 99_999_999 })
  const done = await question(A, B.pub, 'done', { ttl_s: 60 })
  for (const env of [short, long, done]) a.send({ t: 'send', env })
  await b.take('deliver')
  await b.take('deliver')
  await b.take('deliver')
  const t0 = h.clock.now()
  assert.equal(h.db.message(idOf(short))?.expires_at, t0 + 60_000)
  assert.equal(h.db.message(idOf(long))?.expires_at, t0 + 604_800_000)
  b.send(await ackOf(B, done))
  await a.settle(100)
  h.clock.tick(61_000)
  assert.equal(h.db.message(idOf(done))?.state, 'acked')
  assert.equal(h.db.message(idOf(short))?.state, 'expired')
  assert.equal(h.db.message(idOf(long))?.state, 'delivered')
})

test('no body text reaches the log, the audit, or any column but the queue payload', async () => {
  const a = await h.join(A, 'anna')
  const b = await h.join(B, 'ben')
  const e1 = await question(A, B.pub, `${MARKER} one`)
  const e2 = await question(A, B.pub, `${MARKER} two`, { ttl_s: 60 })
  const e3 = await question(A, B.pub, `${MARKER} three`, { kind: 'offer' as never })
  for (const env of [e1, e2, e3]) a.send({ t: 'send', env })
  await b.take('deliver')
  await b.take('deliver')
  b.send(await ackOf(B, e1))
  await a.settle(100)
  h.clock.tick(61_000)
  await a.settle(50)
  const dump = JSON.stringify([
    h.logs,
    h.db.auditRows(),
    h.db.raw.query('SELECT * FROM presence_event').all(),
    h.db.raw.query('SELECT * FROM peer').all(),
    h.db.raw.query('SELECT * FROM invite').all(),
    h.db.raw
      .query('SELECT id, v, from_peer, to_peer, kind, reply_to, state, size, body_hash, ack_json FROM message')
      .all(),
  ])
  assert.ok(!dump.includes(MARKER), 'a body leaked')
  assert.equal(
    h.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM message WHERE payload LIKE '%zebra%'").get()?.n,
    0,
  )
})

test("a revoked sender's queued messages expire (audited) and are never delivered (#231)", async () => {
  const a = await h.join(A, 'anna')
  const b0 = await h.join(B, 'ben')
  b0.close()
  await b0.closed
  const env = await question(A, B.pub, 'before I was revoked')
  a.send({ t: 'send', env })
  await a.take('state')
  h.hub.revoke('anna')
  const row = h.db.message(idOf(env))
  assert.deepEqual([row?.state, row?.payload], ['expired', null])
  const log = h.db.auditRows().filter(r => r.action === 'expired')
  assert.equal(log.length, 1)
  assert.match(log[0]?.detail ?? '', /sender_revoked/)
  const b = await h.login(B)
  await new Promise(r => setTimeout(r, 60))
  assert.equal(b.frames.filter(f => f.t === 'deliver').length, 0)
})

test('what a revoked sender left behind is not delivered even if only the peer row changed (#231)', async () => {
  const a = await h.join(A, 'anna')
  const b0 = await h.join(B, 'ben')
  b0.close()
  await b0.closed
  const env = await question(A, B.pub, 'queued')
  a.send({ t: 'send', env })
  await a.take('state')
  h.db.revokePeer(A.pub, 5) // not through hub.revoke: pendingFor and deliver must look at the sender themselves
  assert.deepEqual(h.db.pendingFor(B.pub, 0), [])
  const b = await h.login(B)
  await new Promise(r => setTimeout(r, 60))
  assert.equal(b.frames.filter(f => f.t === 'deliver').length, 0)
})

test('send and ack look at the peer again: a revoked peer on a still open socket gets revoked, nothing happens (#231)', async () => {
  const a = await h.join(A, 'anna')
  const b = await h.join(B, 'ben')
  const env = await question(A, B.pub, 'sent while active')
  a.send({ t: 'send', env })
  const got = await b.take('deliver')
  h.db.revokePeer(B.pub, 5) // the socket stays open: only the row changed
  b.send(await ackOf(B, got.env))
  assert.equal((await b.take('error')).code, 'revoked')
  assert.notEqual(h.db.message(idOf(env))?.state, 'acked')
  h.db.revokePeer(A.pub, 6)
  a.send({ t: 'send', env: await question(A, B.pub, 'after') })
  assert.equal((await a.take('error')).code, 'revoked')
})

test('an envelope with a field nobody signed is refused, and so is a signed payload with one (#231)', async () => {
  const a = await h.join(A, 'anna')
  await h.join(B, 'ben')
  const env = await question(A, B.pub, 'plain')
  a.send({ t: 'send', env: { ...env, note: 'smuggled' } })
  assert.equal((await a.take('error')).code, 'bad_frame')
  assert.equal(h.db.message(idOf(env)), null)
  // Signed by A, but with a field that is no message's: the signature is fine, the shape is not.
  const extra = await signPayload(A, JSON.stringify({ ...msgOf(env), note: 'smuggled' }))
  a.send({ t: 'send', env: extra })
  const e = await a.take('error')
  assert.deepEqual([e.code, e.id], ['bad_frame', idOf(env)])
  assert.equal(h.db.message(idOf(env)), null)
  a.send({ t: 'send', env })
  await a.take('state')
  assert.deepEqual(JSON.parse(h.db.message(idOf(env))?.payload ?? 'null'), env)
})

// #217: the payload string is what is signed, passed on byte for byte, checked before it is read.
describe('the payload is signed as the string it is (#217)', () => {
  test('keys in another order, or one byte changed, do not pass the hub; nothing is queued', async () => {
    const a = await h.join(A, 'anna')
    const b = await h.join(B, 'ben')
    const env = await question(A, B.pub, 'real question')
    const msg = msgOf(env)
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(msg).reverse()))
    // The same fields and values, in the order canonical JSON would not write: still not what was signed.
    assert.notEqual(reordered, env.payload)
    assert.deepEqual(JSON.parse(reordered), JSON.parse(env.payload))
    const oneByte = env.payload.replace('real question', 'real Question')
    assert.equal(oneByte.length, env.payload.length)
    const spaced = env.payload.replace('"v":1,', '"v":1, ')
    for (const payload of [reordered, oneByte, spaced, ` ${env.payload}`, `${env.payload} `]) {
      a.send({ t: 'send', env: { ...env, payload } })
      const e = await a.take('error')
      assert.deepEqual([e.code, e.id], ['bad_sig', undefined], payload)
    }
    assert.equal(h.db.raw.query<{ n: number }, []>('SELECT count(*) AS n FROM message').get()?.n, 0)
    assert.equal((await b.settle()).filter(f => f.t === 'deliver').length, 0)
    // The envelope as it was signed still goes through.
    a.send({ t: 'send', env })
    assert.equal((await a.take('state')).state, 'queued')
  })

  test('a valid payload written with extra whitespace and signed as is is accepted, and reaches the recipient byte for byte', async () => {
    const a = await h.join(A, 'anna')
    const b = await h.join(B, 'ben')
    const plain = await question(A, B.pub, 'spaced out')
    // Indented, keys in a non-canonical order: nothing the hub could rebuild by writing it again.
    const payload = `${JSON.stringify(Object.fromEntries(Object.entries(msgOf(plain)).reverse()), null, 2)}\n`
    const env = await signPayload(A, payload)
    a.send({ t: 'send', env })
    assert.equal((await a.take('state')).state, 'queued')
    const d = await b.take('deliver')
    assert.equal(d.env.payload, payload)
    assert.deepEqual(d.env, env)
    assert.equal(await verify(A.pub, envelopeBytes(d.env.payload), d.env.sig), true)
    assert.equal((JSON.parse(h.db.message(idOf(env))?.payload ?? 'null') as typeof env).payload, payload)
  })

  test('the signer named outside must be the connected peer and the own from of the message; ill-formed text is no payload', async () => {
    const a = await h.join(A, 'anna')
    await h.join(B, 'ben')
    // B signed it, but A is the one connected: not A's to send.
    const theirs = await question(B, A.pub, 'not yours')
    a.send({ t: 'send', env: theirs })
    assert.equal((await a.take('error')).code, 'bad_sig')
    // A signed a message that says it is from B.
    const lie = await signPayload(A, JSON.stringify({ ...msgOf(await question(A, B.pub, 'x')), from: B.pub }))
    a.send({ t: 'send', env: lie })
    assert.equal((await a.take('error')).code, 'bad_frame')
    // A lone surrogate has no one spelling in bytes, so it is not accepted as text.
    const ill = await signPayload(A, `${(await question(A, B.pub, 'x')).payload}\ud800`)
    a.send({ t: 'send', env: ill })
    assert.equal((await a.take('error')).code, 'bad_frame')
    assert.equal(h.db.raw.query<{ n: number }, []>('SELECT count(*) AS n FROM message').get()?.n, 0)
  })
})
