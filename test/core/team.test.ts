// The peer network (#231), its pure rules: config.json's section, the canonical form (for what
// the verifier rebuilds), the golden vectors of what is signed (Ed25519 is deterministic), the
// envelope's payload signed as the string it is (#217), tampering, and the kinds.
import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  ackBytes,
  authBytes,
  b64u,
  canonicalJson,
  checkEnvelope,
  checkMessage,
  type Envelope,
  envelopeBytes,
  fingerprint,
  generateKey,
  joinBytes,
  type Message,
  normalizeHub,
  openEnvelope,
  parseFrame,
  peerIdOf,
  printable,
  sealEnvelope,
  sign,
  teamConfig,
  unb64u,
  validName,
  verify,
} from '../../src/core/team.ts'

// Two fixed keys: the seeds 0..31 and 32..63.
const A = {
  pkcs8: 'MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f',
  pub: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
}
const B = {
  pkcs8: 'MC4CAQAwBQYDK2VwBCIEICAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_',
  pub: 'Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc',
}
const HUB = 'hub-0123456789abcdef'
const NONCE = '__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA'
const INVITE = 'hab-aaaa-bbbb-cccc-dddd-eeee-ffff'
const ENV: Message = {
  v: 1,
  id: '11111111-2222-4333-8444-555555555555',
  from: A.pub,
  to: B.pub,
  kind: 'question',
  reply_to: null,
  ts: '2026-01-02T03:04:05.000Z',
  ttl_s: 86400,
  body: { text: 'Привет, é "q"' },
}
// The payload as its sender wrote it: JSON.stringify of the message, once.
const PAYLOAD = JSON.stringify(ENV)
const SIG = {
  auth: 'fdIdZu7qahY-hO0ls0c_rMBNix5IZq4xtf79mg4rV3K34AuIcAOQbsECwGf9tBh0Bo-bHlNI3mJgwUfa00-aCw',
  join: 'd9jSErJDVCzjnFq5XcjYzTeZF5FWjAL30CjkqkhGLa_Yz8tMPx6X52RxYWDpf00tSLBqpBYgnYuSQfiEc422Bw',
  envelope: 'VLmD-x12D30DiV7XqfEOzjDmDdnY67Jfv6X_Icrp8xLg9OUCGbJ_bLnSIvCTmmk_r2Px6HStdVxGjwxQLJH4DA',
  ack: 'WARRRVKINTw6Owxs1An0hJNRVqGtmkJs0s6ffsg0ATsdQH5kK5Ys6DT66rdhhAYpUDEnTcgVkv6vZjQGzgjcDQ',
}
const ENVELOPE: Envelope = { from: A.pub, payload: PAYLOAD, sig: SIG.envelope }
const ACK = { by: B.pub, id: ENV.id, to: A.pub, ts: '2026-01-02T03:05:00.000Z' }
const text = (b: Uint8Array) => new TextDecoder().decode(b)

test('teamConfig: off without an object holding a ws:// or wss:// hub', () => {
  for (const off of [undefined, null, false, true, 'x', 3, [], {}, { hub: 3 }, { hub: 'nope' }, { hub: 'http://h:1' }])
    assert.equal(teamConfig(off), null)
  assert.deepEqual(teamConfig({ hub: 'ws://100.64.0.7:7443' }), { hub: 'ws://100.64.0.7:7443', name: null })
  assert.deepEqual(teamConfig({ hub: 'wss://hub.example', name: 'anna' }), { hub: 'wss://hub.example', name: 'anna' })
  assert.equal(teamConfig({ hub: 'ws://h:1', name: '' })?.name, null)
  assert.equal(teamConfig({ hub: 'ws://h:1', name: 'x'.repeat(41) })?.name, null)
})

test('normalizeHub: with or without a trailing slash or /v1 it is one hub; only ws and wss', () => {
  for (const spelled of ['ws://h:7443', 'ws://h:7443/', 'ws://h:7443/v1', 'ws://h:7443/v1/', ' ws://h:7443/v1 '])
    assert.equal(normalizeHub(spelled), 'ws://h:7443')
  assert.equal(normalizeHub('wss://hub.example/v1'), 'wss://hub.example')
  assert.equal(normalizeHub('ws://h:1/v10'), 'ws://h:1/v10')
  for (const bad of [undefined, 3, '', 'h:7443', 'http://h/v1', 'ws://']) assert.equal(normalizeHub(bad), null)
  assert.equal(teamConfig({ hub: 'ws://h:7443/v1', name: 'a' })?.hub, 'ws://h:7443')
})

test('canonicalJson: keys by UTF-16 code units, nesting, unicode, numbers', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [3, { z: null, y: true }], c: 'x' } }),
    '{"a":{"c":"x","d":[3,{"y":true,"z":null}]},"b":1}',
  )
  assert.equal(canonicalJson({ '\u{1F600}': 1, ﬁ: 2, a: 3 }), '{"a":3,"\u{1F600}":1,"ﬁ":2}')
  assert.equal(canonicalJson('é"\n '), JSON.stringify('é"\n '))
  assert.equal(canonicalJson([1, 1.5, -0, 1e21, 0.1]), '[1,1.5,0,1e+21,0.1]')
  assert.equal(canonicalJson({}), '{}')
  assert.equal(canonicalJson({ a: [] }), '{"a":[]}')
})

test('canonicalJson: refuses what has no canonical form', () => {
  assert.throws(() => canonicalJson(undefined))
  assert.throws(() => canonicalJson({ a: undefined }))
  assert.throws(() => canonicalJson(() => 1))
  assert.throws(() => canonicalJson(Number.NaN))
  assert.throws(() => canonicalJson([Number.POSITIVE_INFINITY]))
  assert.throws(() => canonicalJson(1n))
})

test('golden vectors: the signed bytes and the signatures never change', async () => {
  const auth = authBytes({ hub: HUB, nonce: NONCE, peer: A.pub })
  assert.equal(text(auth), `hab-team/1 auth\n{"hub":"${HUB}","nonce":"${NONCE}","peer":"${A.pub}"}`)
  assert.equal(await sign(A.pkcs8, auth), SIG.auth)
  const join = joinBytes({ hub: HUB, invite: INVITE, name: 'anna', nonce: NONCE, peer: A.pub })
  assert.equal(
    text(join),
    `hab-team/1 join\n{"hub":"${HUB}","invite":"${INVITE}","name":"anna","nonce":"${NONCE}","peer":"${A.pub}"}`,
  )
  assert.equal(await sign(A.pkcs8, join), SIG.join)
  // The payload is written in the order its sender wrote it, not sorted: what is signed is that string.
  const env = envelopeBytes(PAYLOAD)
  assert.ok(text(env).startsWith('hab-team/1 envelope\n{"v":1,"id":"11111111-2222-4333-8444-555555555555","from":'))
  assert.equal(text(env), `hab-team/1 envelope\n${PAYLOAD}`)
  assert.equal(await sign(A.pkcs8, env), SIG.envelope)
  const ack = ackBytes(ACK)
  assert.equal(text(ack), `hab-team/1 ack\n{"by":"${B.pub}","id":"${ENV.id}","to":"${A.pub}","ts":"${ACK.ts}"}`)
  assert.equal(await sign(B.pkcs8, ack), SIG.ack)
  for (const [peer, bytes, sig] of [
    [A.pub, auth, SIG.auth],
    [A.pub, join, SIG.join],
    [A.pub, env, SIG.envelope],
    [B.pub, ack, SIG.ack],
  ] as const)
    assert.equal(await verify(peer, bytes, sig), true)
})

test('envelopeBytes: the domain prefix and the payload string exactly as it is; nothing is parsed, sorted or trimmed (#217)', () => {
  for (const payload of ['{"b":1,"a":2}', ' {"a" : 2 ,\n"b":1} ', 'not json at all', '', PAYLOAD])
    assert.equal(text(envelopeBytes(payload)), `hab-team/1 envelope\n${payload}`)
  assert.notEqual(text(envelopeBytes('{"b":1,"a":2}')), text(envelopeBytes('{"a":2,"b":1}')))
  // The prefix binds the signature to one use.
  assert.notEqual(text(envelopeBytes(PAYLOAD)), text(authBytes({ hub: HUB, nonce: NONCE, peer: A.pub })))
})

test('tampering breaks a signature; so does another key or another purpose', async () => {
  assert.equal(
    await verify(A.pub, envelopeBytes(JSON.stringify({ ...ENV, body: { text: 'other' } })), SIG.envelope),
    false,
  )
  assert.equal(await verify(A.pub, envelopeBytes(JSON.stringify({ ...ENV, to: A.pub })), SIG.envelope), false)
  assert.equal(await verify(B.pub, envelopeBytes(PAYLOAD), SIG.envelope), false)
  assert.equal(await verify(A.pub, authBytes({ hub: HUB, nonce: NONCE, peer: B.pub }), SIG.auth), false)
  assert.equal(await verify(A.pub, authBytes({ hub: 'other', nonce: NONCE, peer: A.pub }), SIG.auth), false)
  // The auth signature is no join signature and no envelope signature.
  assert.equal(
    await verify(A.pub, joinBytes({ hub: HUB, invite: INVITE, name: 'anna', nonce: NONCE, peer: A.pub }), SIG.auth),
    false,
  )
  assert.equal(await verify(A.pub, envelopeBytes(PAYLOAD), SIG.auth), false)
  assert.equal(await verify(B.pub, authBytes({ hub: HUB, nonce: NONCE, peer: A.pub }), SIG.ack), false)
})

test('verify: malformed keys and signatures are false, never thrown', async () => {
  const bytes = authBytes({ hub: HUB, nonce: NONCE, peer: A.pub })
  for (const [peer, sig] of [
    ['short', SIG.auth],
    [A.pub, 'short'],
    [A.pub, ''],
    ['', SIG.auth],
    [`${A.pub}=`, SIG.auth],
    [A.pub, `${SIG.auth}=`],
  ] as const)
    assert.equal(await verify(peer, bytes, sig), false)
})

test('keys: a generated key signs, its id is 43 characters, the fingerprint is stable', async () => {
  const k = await generateKey()
  assert.equal(k.pub.length, 43)
  assert.equal(peerIdOf(unb64u(k.pub) as Uint8Array), k.pub)
  const bytes = authBytes({ hub: HUB, nonce: NONCE, peer: k.pub })
  const sig = await sign(k.pkcs8, bytes)
  assert.equal(sig.length, 86)
  assert.equal(await verify(k.pub, bytes, sig), true)
  assert.equal(fingerprint(A.pub), '5647 5aa7 5463 474c 0285 df5d bf2b cab7')
  assert.equal(fingerprint('!!'), '')
})

test('checkEnvelope: the wire shape is from, payload and sig and nothing else; the payload stays a string within 16 KiB', () => {
  assert.deepEqual(checkEnvelope(ENVELOPE), { ok: true, env: ENVELOPE })
  const code = (o: unknown) => {
    const r = checkEnvelope(o)
    return r.ok ? 'ok' : r.code
  }
  assert.equal(code({ ...ENVELOPE, note: 'x' }), 'bad_frame')
  assert.equal(code({ ...ENVELOPE, id: ENV.id }), 'bad_frame')
  assert.equal(code({ from: A.pub, payload: PAYLOAD }), 'bad_frame')
  assert.equal(code({ ...ENVELOPE, from: 'nobody' }), 'bad_frame')
  assert.equal(code({ ...ENVELOPE, sig: 'x' }), 'bad_frame')
  assert.equal(code({ ...ENVELOPE, payload: ENV }), 'bad_frame')
  assert.equal(code({ ...ENVELOPE, payload: null }), 'bad_frame')
  // The old flat shape, with the fields outside a payload, is no envelope.
  assert.equal(code({ ...ENV, sig: SIG.envelope }), 'bad_frame')
  // 16 KiB of payload are fine, a byte more is not (bytes, not characters).
  const pad = (n: number) => ({ ...ENVELOPE, payload: ' '.repeat(n) })
  assert.equal(code(pad(16 * 1024)), 'ok')
  assert.equal(code(pad(16 * 1024 + 1)), 'too_big')
  assert.equal(code({ ...ENVELOPE, payload: 'é'.repeat(8 * 1024 + 1) }), 'too_big')
  // A lone surrogate has no spelling in bytes of its own, so the payload is not one string with one set of bytes.
  assert.equal(code({ ...ENVELOPE, payload: `${PAYLOAD}\ud800` }), 'bad_frame')
  assert.equal(code({ ...ENVELOPE, payload: `${PAYLOAD}\u{1F600}` }), 'ok')
  for (const junk of [null, 3, 'x', [], undefined]) assert.equal(code(junk), 'bad_frame')
})

test('checkEnvelope hands back only the three fields (#231)', () => {
  const r = checkEnvelope({ ...ENVELOPE })
  assert.equal(r.ok && r.env.payload, PAYLOAD)
  assert.deepEqual(r.ok && Object.keys(r.env), ['from', 'payload', 'sig'])
})

test('checkMessage: the kind whitelist, no broadcast, the field set, the types and the shape of the payload', () => {
  const code = (o: unknown, from = A.pub) => {
    const r = checkMessage(typeof o === 'string' ? o : JSON.stringify(o), from)
    return r.ok ? 'ok' : r.code
  }
  assert.deepEqual(checkMessage(PAYLOAD, A.pub), { ok: true, msg: ENV })
  for (const kind of ['invite', 'offer', 'response', 'status', 'data', 'ack', 'x'])
    assert.equal(code({ ...ENV, kind }), 'kind')
  assert.equal(code({ ...ENV, to: '*' }), 'broadcast')
  assert.equal(code({ ...ENV, v: 2 }), 'version')
  assert.equal(code({ ...ENV, to: 'nobody' }), 'bad_frame')
  assert.equal(code({ ...ENV, id: 'not-a-uuid' }), 'bad_frame')
  assert.equal(code({ ...ENV, body: {} }), 'bad_frame')
  assert.equal(code({ ...ENV, body: { text: '' } }), 'bad_frame')
  assert.equal(code({ ...ENV, body: { text: 'x', extra: 1 } }), 'bad_frame')
  assert.equal(code({ ...ENV, body: { text: 'x'.repeat(4001) } }), 'bad_frame')
  assert.equal(code({ ...ENV, body: { text: 'x'.repeat(4000) } }), 'ok')
  assert.equal(code({ ...ENV, reply_to: 5 }), 'bad_frame')
  assert.equal(code({ ...ENV, ts: 'yesterday' }), 'bad_frame')
  // A field nobody meant is refused, not carried along (#231); so is one that is missing.
  assert.equal(code({ ...ENV, note: 'x' }), 'bad_frame')
  assert.equal(code({ ...ENV, ttl: 1 }), 'bad_frame')
  assert.equal(code({ ...ENV, sig: SIG.envelope }), 'bad_frame')
  const { reply_to: _gone, ...noReply } = ENV
  assert.equal(code(noReply), 'bad_frame')
  // The message says who it is from, and it is the key that signed.
  assert.equal(code(PAYLOAD, B.pub), 'bad_frame')
  for (const junk of ['', 'nope', '[]', 'null', '3', '"x"', '{"v":1']) assert.equal(code(junk), 'bad_frame', junk)
  // A refusal names the message when the payload has an id.
  assert.deepEqual(checkMessage(JSON.stringify({ ...ENV, kind: 'offer' }), A.pub), {
    ok: false,
    code: 'kind',
    id: ENV.id,
  })
  assert.deepEqual(checkMessage('[]', A.pub), { ok: false, code: 'bad_frame' })
})

test('checkMessage: body.via is accepted as "agent" only, kept in the rebuilt body (#231)', () => {
  const code = (o: unknown) => {
    const r = checkMessage(JSON.stringify(o), A.pub)
    return r.ok ? 'ok' : r.code
  }
  const viaAgent: Message = { ...ENV, body: { text: 'asked by an agent', via: 'agent' } }
  assert.deepEqual(checkMessage(JSON.stringify(viaAgent), A.pub), { ok: true, msg: viaAgent })
  for (const via of ['human', 'Agent', '', 'agent ', null, 1, true, ['agent'], { v: 'agent' }])
    assert.equal(code({ ...viaAgent, body: { text: 'x', via } }), 'bad_frame', JSON.stringify(via))
  assert.equal(code({ ...viaAgent, body: { text: 'x', via: 'agent', more: 1 } }), 'bad_frame')
  assert.equal(code({ ...viaAgent, body: { via: 'agent' } }), 'bad_frame')
  assert.equal(code({ ...viaAgent, body: { text: 'x'.repeat(4001), via: 'agent' } }), 'bad_frame')
})

// #217: no canonical JSON for the envelope. The ready payload string is signed and passed on as it
// is; the signature is checked before the string is parsed.
describe('an envelope is opened by its signature over the payload string (#217)', () => {
  const code = async (env: unknown, from?: string) => {
    const r = await openEnvelope(env, from)
    return r.ok ? 'ok' : r.code
  }
  const reversed = (msg: Message): string => JSON.stringify(Object.fromEntries(Object.entries(msg).reverse()))

  test('a sealed envelope opens: the payload is JSON.stringify of the message, the signature is over those bytes', async () => {
    const env = await sealEnvelope(A, ENV)
    assert.deepEqual(env, ENVELOPE)
    assert.equal(env.payload, JSON.stringify(ENV))
    assert.equal(await verify(A.pub, envelopeBytes(env.payload), env.sig), true)
    const r = await openEnvelope(env)
    assert.deepEqual(r, { ok: true, env, msg: ENV })
    assert.equal((await openEnvelope(env, A.pub)).ok, true)
  })

  test('keys in another order do not pass, though every field and value is the same', async () => {
    const other = reversed(ENV)
    assert.notEqual(other, PAYLOAD)
    assert.deepEqual(JSON.parse(other), JSON.parse(PAYLOAD))
    assert.deepEqual(await openEnvelope({ ...ENVELOPE, payload: other }), { ok: false, code: 'bad_sig', from: A.pub })
    // Not even when the order is the sorted one canonical JSON would write.
    const sorted = JSON.stringify(Object.fromEntries(Object.entries(ENV).sort(([a], [b]) => (a < b ? -1 : 1))))
    assert.equal(await code({ ...ENVELOPE, payload: sorted }), 'bad_sig')
  })

  test('one byte changed does not pass, nor does one added or taken away (whitespace too)', async () => {
    for (const payload of [
      PAYLOAD.replace('Привет', 'Привеt'),
      PAYLOAD.replace('"v":1', '"v":2'),
      PAYLOAD.replace('"v":1,', '"v":1, '),
      PAYLOAD.replace('"ttl_s":86400', '"ttl_s":86400.0'),
      PAYLOAD.replace('"reply_to":null', '"reply_to": null'),
      ` ${PAYLOAD}`,
      `${PAYLOAD}\n`,
      PAYLOAD.slice(0, -1),
      PAYLOAD.replace('\\"q\\"', '\\u0022q\\u0022'),
    ]) {
      assert.notEqual(payload, PAYLOAD)
      assert.equal(await code({ ...ENVELOPE, payload }), 'bad_sig', payload)
    }
  })

  test('a payload with extra whitespace or another key order, signed as it is, is accepted: nothing is written again', async () => {
    for (const payload of [
      JSON.stringify(ENV, null, 2),
      `\n${reversed(ENV)}\n`,
      PAYLOAD.replace('"v":1,', '"v" : 1 ,\n  '),
    ]) {
      // The signed bytes are spelled out: the prefix and the string, as they are.
      const bytes = new TextEncoder().encode(`hab-team/1 envelope\n${payload}`)
      const env = { from: A.pub, payload, sig: await sign(A.pkcs8, bytes) }
      const r = await openEnvelope(env)
      assert.deepEqual(r, { ok: true, env, msg: ENV }, payload)
      // The string comes back as it went in.
      assert.equal(r.ok && r.env.payload, payload)
    }
  })

  test('the signature is checked before the payload is read: an unsigned oddity is a bad signature, a signed one is what it is', async () => {
    const offer = JSON.stringify({ ...ENV, kind: 'offer' })
    assert.equal(await code({ ...ENVELOPE, payload: offer }), 'bad_sig')
    assert.equal(await code({ ...ENVELOPE, payload: 'not json' }), 'bad_sig')
    const signed = async (payload: string) => ({
      from: A.pub,
      payload,
      sig: await sign(A.pkcs8, envelopeBytes(payload)),
    })
    assert.equal(await code(await signed(offer)), 'kind')
    assert.equal(await code(await signed('not json')), 'bad_frame')
    assert.equal(await code(await signed(JSON.stringify({ ...ENV, to: '*' }))), 'broadcast')
    assert.equal(await code(await signed(JSON.stringify({ ...ENV, v: 2 }))), 'version')
    assert.equal(await code(await signed(JSON.stringify({ ...ENV, note: 1 }))), 'bad_frame')
  })

  test("the key that checks the signature is the envelope's from; it has to be the sender the caller knows and the message's own", async () => {
    // Signed by B, said to be from A: B's signature is not A's.
    const byB = { from: A.pub, payload: PAYLOAD, sig: await sign(B.pkcs8, envelopeBytes(PAYLOAD)) }
    assert.equal(await code(byB), 'bad_sig')
    // The hub knows who is connected: an envelope of another peer is not this peer's to send.
    assert.equal(await code(ENVELOPE, B.pub), 'bad_sig')
    assert.equal(await code(ENVELOPE, A.pub), 'ok')
    // Signed by B and from B, but the message says A: a good signature of a message that lies.
    const lie = await sealEnvelope(B, ENV)
    assert.equal(await code(lie), 'bad_frame')
    // The wire shape comes first.
    assert.equal(await code({ ...ENVELOPE, extra: 1 }), 'bad_frame')
    assert.equal(await code(null), 'bad_frame')
  })

  test('a refusal tells who it was from once the shape passed, and the id only when the payload was signed', async () => {
    assert.deepEqual(await openEnvelope({ ...ENVELOPE, payload: `${PAYLOAD} ` }), {
      ok: false,
      code: 'bad_sig',
      from: A.pub,
    })
    assert.deepEqual(await openEnvelope({ ...ENVELOPE, extra: 1 }), { ok: false, code: 'bad_frame' })
    const offer = JSON.stringify({ ...ENV, kind: 'offer' })
    const env = { from: A.pub, payload: offer, sig: await sign(A.pkcs8, envelopeBytes(offer)) }
    assert.deepEqual(await openEnvelope(env), { ok: false, code: 'kind', from: A.pub, id: ENV.id })
  })
})

test('parseFrame: known frames come back, junk is null', () => {
  assert.deepEqual(parseFrame('{"t":"ping"}'), { t: 'ping' })
  assert.deepEqual(parseFrame('{"t":"hello","v":1,"peer":"p","client":"c"}'), {
    t: 'hello',
    v: 1,
    peer: 'p',
    client: 'c',
  })
  assert.deepEqual(parseFrame('{"t":"error","code":"kind","id":"i","message":"m"}'), {
    t: 'error',
    code: 'kind',
    id: 'i',
    message: 'm',
  })
  assert.deepEqual(parseFrame('{"t":"state","id":"i","state":"acked","at":5,"ack":{"by":"b","ts":"t","sig":"s"}}'), {
    t: 'state',
    id: 'i',
    state: 'acked',
    at: 5,
    ack: { by: 'b', ts: 't', sig: 's' },
  })
  for (const junk of [
    '',
    'nope',
    '[]',
    '3',
    '{}',
    '{"t":"x"}',
    '{"t":"auth"}',
    '{"t":"state","id":"i","state":"gone","at":1}',
    '{"t":"error","code":"zzz","message":"m"}',
  ])
    assert.equal(parseFrame(junk), null)
})

test('unb64u: only the canonical spelling; a signature or a key has one (#231)', async () => {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  // The same bytes spelled with other unused bits in the last character.
  const twin = (s: string) => `${s.slice(0, -1)}${ALPHABET[ALPHABET.indexOf(s.slice(-1)) ^ 1]}`
  const k = await generateKey()
  const bytes = new TextEncoder().encode('hello')
  const sig = await sign(k.pkcs8, bytes)
  assert.equal(sig.length, 86)
  assert.equal(await verify(k.pub, bytes, sig), true)
  assert.deepEqual(Buffer.from(twin(sig), 'base64url'), Buffer.from(sig, 'base64url'))
  assert.equal(unb64u(twin(sig)), null)
  assert.equal(await verify(k.pub, bytes, twin(sig)), false)
  assert.equal(unb64u(twin(k.pub)), null)
  assert.equal(await verify(twin(k.pub), bytes, sig), false)
  assert.equal(b64u(unb64u(k.pub) as Uint8Array), k.pub)
  assert.equal(unb64u('Z'.repeat(43)), null)
  for (const bad of ['A', 'AA==', 7]) assert.equal(unb64u(bad), null)
})

test('validName: no controls, no bidi controls, nothing that reorders or breaks a line (#231)', () => {
  for (const ok of ['anna', 'Анна', 'a b', 'ann-a_1', 'é', '名前', 'x'.repeat(40)])
    assert.equal(validName(ok), true, ok)
  for (const bad of [
    'a\nb',
    'a\tb',
    'a\u0000b',
    'a\u001bb',
    'a\u007fb',
    'a\u0085b',
    'a\u009fb',
    'a\u200eb',
    'a\u200fb',
    'a\u061cb',
    'a\u202eb',
    'a\u202ab',
    'a\u2066b',
    'a\u2069b',
    'a\u2028b',
    ' a',
    '',
    'x'.repeat(41),
  ])
    assert.equal(validName(bad), false, JSON.stringify(bad))
  assert.equal(printable('ok Анна ●'), 'ok Анна ●')
  assert.equal(printable('a\u001b[2Jb\u202ec\nd'), 'a\\u{1b}[2Jb\\u{202e}c\\u{a}d')
})
