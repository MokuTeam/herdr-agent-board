// The peer network (#231), its pure rules: config.json's section, the canonical form, the golden
// vectors of what is signed (Ed25519 is deterministic), tampering, and the kinds.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  ackBytes,
  authBytes,
  b64u,
  canonicalJson,
  checkEnvelope,
  type Envelope,
  envelopeBytes,
  fingerprint,
  generateKey,
  joinBytes,
  parseFrame,
  peerIdOf,
  sign,
  teamConfig,
  unb64u,
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
const ENV: Omit<Envelope, 'sig'> = {
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
const SIG = {
  auth: 'fdIdZu7qahY-hO0ls0c_rMBNix5IZq4xtf79mg4rV3K34AuIcAOQbsECwGf9tBh0Bo-bHlNI3mJgwUfa00-aCw',
  join: 'd9jSErJDVCzjnFq5XcjYzTeZF5FWjAL30CjkqkhGLa_Yz8tMPx6X52RxYWDpf00tSLBqpBYgnYuSQfiEc422Bw',
  envelope: 'quFXls8bjwaxVGvOalwi7Ple-bbaA6A4bVij9gEwh70ei-QQvHsbeeIIHHLTMbeGULfxJjepqfuDbN6ujMKTCg',
  ack: 'WARRRVKINTw6Owxs1An0hJNRVqGtmkJs0s6ffsg0ATsdQH5kK5Ys6DT66rdhhAYpUDEnTcgVkv6vZjQGzgjcDQ',
}
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
  const env = envelopeBytes(ENV)
  assert.ok(text(env).startsWith('hab-team/1 envelope\n{"body":{"text":"Привет, é \\"q\\""},"from":'))
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

test('envelopeBytes: an absent reply_to is null; the signature is not part of it', () => {
  const withSig = { ...ENV, sig: SIG.envelope }
  assert.equal(text(envelopeBytes(withSig)), text(envelopeBytes(ENV)))
  const noReply = { ...ENV } as Record<string, unknown>
  noReply.reply_to = undefined
  assert.equal(text(envelopeBytes(noReply as unknown as Envelope)), text(envelopeBytes(ENV)))
})

test('tampering breaks a signature; so does another key or another purpose', async () => {
  assert.equal(await verify(A.pub, envelopeBytes({ ...ENV, body: { text: 'other' } }), SIG.envelope), false)
  assert.equal(await verify(A.pub, envelopeBytes({ ...ENV, to: A.pub }), SIG.envelope), false)
  assert.equal(await verify(B.pub, envelopeBytes(ENV), SIG.envelope), false)
  assert.equal(await verify(A.pub, authBytes({ hub: HUB, nonce: NONCE, peer: B.pub }), SIG.auth), false)
  assert.equal(await verify(A.pub, authBytes({ hub: 'other', nonce: NONCE, peer: A.pub }), SIG.auth), false)
  // The auth signature is no join signature and no envelope signature.
  assert.equal(
    await verify(A.pub, joinBytes({ hub: HUB, invite: INVITE, name: 'anna', nonce: NONCE, peer: A.pub }), SIG.auth),
    false,
  )
  assert.equal(await verify(A.pub, envelopeBytes(ENV), SIG.auth), false)
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

test('checkEnvelope: the kind whitelist, no broadcast, size and shape', () => {
  const ok = { ...ENV, sig: SIG.envelope }
  assert.deepEqual(checkEnvelope(ok), { ok: true, env: ok })
  const code = (o: unknown) => {
    const r = checkEnvelope(o)
    return r.ok ? 'ok' : r.code
  }
  for (const kind of ['invite', 'offer', 'response', 'status', 'data', 'ack', 'x'])
    assert.equal(code({ ...ok, kind }), 'kind')
  assert.equal(code({ ...ok, to: '*' }), 'broadcast')
  assert.equal(code({ ...ok, v: 2 }), 'version')
  assert.equal(code({ ...ok, to: 'nobody' }), 'bad_frame')
  assert.equal(code({ ...ok, id: 'not-a-uuid' }), 'bad_frame')
  assert.equal(code({ ...ok, body: {} }), 'bad_frame')
  assert.equal(code({ ...ok, body: { text: '' } }), 'bad_frame')
  assert.equal(code({ ...ok, body: { text: 'x', extra: 1 } }), 'bad_frame')
  assert.equal(code({ ...ok, body: { text: 'x'.repeat(4001) } }), 'bad_frame')
  assert.equal(code({ ...ok, body: { text: 'x'.repeat(4000) } }), 'ok')
  assert.equal(code({ ...ok, sig: 'x' }), 'bad_frame')
  assert.equal(code({ ...ok, reply_to: 5 }), 'bad_frame')
  assert.equal(code({ ...ok, ts: 'yesterday' }), 'bad_frame')
  assert.equal(code({ ...ok, pad: 'x'.repeat(17000) }), 'too_big')
  // A field nobody signed is refused, not carried along (#231).
  assert.equal(code({ ...ok, note: 'x' }), 'bad_frame')
  assert.equal(code({ ...ok, ttl: 1 }), 'bad_frame')
  for (const junk of [null, 3, 'x', [], undefined]) assert.equal(code(junk), 'bad_frame')
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

test('checkEnvelope hands back only the signed fields and the signature (#231)', async () => {
  const env: Envelope = { ...ENV, sig: SIG.envelope }
  const r = checkEnvelope(env)
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok && r.env, env)
  assert.notEqual(r.ok && r.env, env)
  assert.notEqual(r.ok && r.env.body, env.body)
})
