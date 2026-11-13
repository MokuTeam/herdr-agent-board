// The hub's blobs (#371): box keys in the roster, a blob put in chunks, fetched by the peers it is
// for and nobody else, its size, quota and hash held, and gone when everyone fetched it, at its
// TTL, when its upload stops, or when its sender is revoked. And that what the hub keeps is the
// sealed bytes, with no name and no key anywhere on the hub.
import { afterEach, beforeEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { memoryBlobs } from '../../hub/src/blobs.ts'
import { STALE_UPLOAD_MS, SWEEP_MS } from '../../hub/src/hub.ts'
import { BLOB_CHUNK, b64u, boxBytes, type KeyPair, type RosterPeer, sign, unb64u } from '../../src/core/team.ts'
import { generateBoxKey, wrapSecret } from '../../src/core/team-box.ts'
import { fileContext, openFile, sealFile, sha256 } from '../../src/core/team-file.ts'
import { type Client, type Harness, keys, msgOf, question, startHarness } from './harness.ts'

const MB = 1024 * 1024
let h: Harness
let store: ReturnType<typeof memoryBlobs>
let A: KeyPair
let B: KeyPair
let C: KeyPair
beforeEach(async () => {
  store = memoryBlobs()
  h = await startHarness({ blobs: store, maxFileBytes: 1 * MB, quotaBytes: 2 * MB })
  ;[A, B, C] = (await keys(3)) as [KeyPair, KeyPair, KeyPair]
})
afterEach(() => h.stop())

const FILES = ['threads', 'channels', 'files']
let n = 0
const blobId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

async function boxOf(k: KeyPair) {
  const box = await generateBoxKey()
  return { box, claim: { key: box.pub, sig: await sign(k.pkcs8, boxBytes({ box: box.pub, peer: k.pub })) } }
}

/** Puts `bytes` as blob `id` for `to`, all of it, and waits for blob_ready. */
async function upload(c: Client, id: string, bytes: Uint8Array, to: string[], ttl_s = 86_400) {
  c.send({ t: 'blob_open', id, size: bytes.length, hash: await sha256(bytes), to, ttl_s })
  let have = (await c.take('blob_have')).have
  while (have < bytes.length) {
    c.send({ t: 'blob_put', id, at: have, data: b64u(bytes.subarray(have, have + BLOB_CHUNK)) })
    if (have + BLOB_CHUNK >= bytes.length) break
    have = (await c.take('blob_have')).have
  }
  return c.take('blob_ready')
}

/** Fetches blob `id` of `size` bytes window by window. */
async function download(c: Client, id: string, size: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let have = 0
  while (have < size) {
    c.send({ t: 'blob_get', id, at: have })
    for (let i = 0; i < 8 && have < size; i++) {
      const d = await c.take('blob_data')
      assert.equal(d.at, have)
      const bytes = unb64u(d.data) as Uint8Array
      parts.push(bytes)
      have += bytes.length
    }
  }
  return new Uint8Array(Buffer.concat(parts))
}

test('a box key signed by its board is kept and passed on in the roster and with presence; a bad one, or none, is not', async () => {
  const a = await boxOf(A)
  const bad = await boxOf(B)
  const ca = await h.join(A, 'anna', undefined, FILES, { box: a.claim })
  // Ben claims a key signed for another peer: the signature does not verify for him.
  const cb = await h.join(B, 'ben', undefined, FILES, { box: { key: bad.claim.key, sig: a.claim.sig } })
  const roster = (await cb.take('roster')).peers as RosterPeer[]
  assert.deepEqual(roster.find(p => p.peer === A.pub)?.box, a.claim)
  assert.equal(roster.find(p => p.peer === B.pub)?.box, undefined)
  assert.equal(h.db.peer(B.pub)?.box, null)
  // Cleo's board is older: no box, no files.
  const cc = await h.join(C, 'cleo')
  const cRoster = (await cc.take('roster')).peers as RosterPeer[]
  assert.equal(cRoster.find(p => p.peer === C.pub)?.box, undefined)
  // Anna comes back with the same key: her presence carries it.
  ca.close()
  await ca.closed
  await h.offline(A.pub)
  await h.login(A, FILES, { box: a.claim })
  const p = (await cc.take('presence', 2000).then(async x => (x.online ? x : cc.take('presence')))) as {
    box?: unknown
  }
  assert.deepEqual(p.box, a.claim)
})

test('the welcome says the limits; a blob goes up in chunks, comes down in windows to its peer, and is gone when fetched', async () => {
  const ca = await h.join(A, 'anna', undefined, FILES)
  const cb = await h.join(B, 'ben', undefined, FILES)
  const bytes = crypto.getRandomValues(new Uint8Array(300_000))
  const id = blobId()
  await upload(ca, id, bytes, [B.pub])
  assert.equal(h.db.blob(id)?.state, 'ready')
  const got = await download(cb, id, bytes.length)
  assert.ok(Buffer.from(got).equals(Buffer.from(bytes)))
  cb.send({ t: 'blob_done', id })
  await cb.settle()
  assert.equal(h.db.blob(id)?.state, 'gone')
  assert.equal(h.db.blob(id)?.gone_why, 'fetched')
  assert.equal(store.bytes(id), undefined)
  const actions = h.db.auditRows().map(r => r.action)
  for (const a of ['blob_open', 'blob_ready', 'blob_fetched', 'blob_gone']) assert.ok(actions.includes(a), a)
})

test('what the hub keeps is the sealed file: no byte, no name, no key of it in the store, the rows or the audit', async () => {
  const ca = await h.join(A, 'anna', undefined, FILES)
  const cb = await h.join(B, 'ben', undefined, FILES)
  const ben = await generateBoxKey()
  const marker = new TextEncoder().encode('zebra-marker-7731 '.repeat(500))
  const id = blobId()
  const sealed = await sealFile(marker, { name: 'acme-plan.txt', type: 'text/plain', size: marker.length }, id)
  const w = await wrapSecret(sealed.secret, [{ peer: B.pub, box: ben.pub }], fileContext(id))
  await upload(ca, id, sealed.blob, [B.pub])
  const held = store.bytes(id) as Uint8Array
  assert.ok(Buffer.from(held).equals(Buffer.from(sealed.blob)))
  assert.equal(Buffer.from(held).toString('latin1').includes('zebra-marker'), false)
  // The message that names it, with no caption: relayed as signed.
  const file = {
    blob: id,
    size: sealed.blob.length,
    hash: sealed.hash,
    eph: w.eph,
    key: w.keys[B.pub],
    meta: sealed.meta,
  }
  const env = await question(A, B.pub, '', { body: { text: '', file } as never })
  ca.send({ t: 'send', env })
  const d = await cb.take('deliver')
  assert.deepEqual(msgOf(d.env).body.file, file)
  // The hub has nothing that opens it, and nothing that names it.
  const everything = JSON.stringify([h.db.auditRows(), h.db.blob(id), h.db.peers()])
  for (const s of ['acme-plan', 'zebra-marker', 'text/plain', b64u(sealed.secret)])
    assert.equal(everything.includes(s), false, s)
  const sendRow = h.db.auditRows().find(r => r.action === 'send')
  assert.equal(JSON.parse(sendRow?.detail ?? '{}').file, id)
  // Ben's board opens it.
  const got = await download(cb, id, sealed.blob.length)
  const { unwrapSecret } = await import('../../src/core/team-box.ts')
  const secret = (await unwrapSecret(
    file.key as string,
    file.eph,
    { peer: B.pub, box: ben },
    fileContext(id),
  )) as Uint8Array
  const opened = await openFile(file, got, secret)
  assert.ok(opened.ok && Buffer.from(opened.bytes).equals(Buffer.from(marker)))
})

test('a member the blob is not for cannot fetch it, nor put into it, nor say it is done', async () => {
  const ca = await h.join(A, 'anna', undefined, FILES)
  await h.join(B, 'ben', undefined, FILES)
  const cc = await h.join(C, 'cleo', undefined, FILES)
  const id = blobId()
  await upload(ca, id, crypto.getRandomValues(new Uint8Array(1000)), [B.pub])
  cc.send({ t: 'blob_get', id, at: 0 })
  const e = await cc.take('error')
  assert.deepEqual([e.code, e.id], ['not_member', id])
  cc.send({ t: 'blob_put', id, at: 1000, data: 'AAAA' })
  assert.equal((await cc.take('error')).code, 'no_blob')
  cc.send({ t: 'blob_done', id })
  assert.equal((await cc.take('error')).code, 'not_member')
  assert.equal(
    (await cc.settle()).some(f => f.t === 'blob_data'),
    false,
  )
  assert.equal(h.db.blob(id)?.state, 'ready')
  // An id nobody opened: no such blob.
  cc.send({ t: 'blob_get', id: blobId(), at: 0 })
  assert.equal((await cc.take('error')).code, 'no_blob')
})

test('limits: a file over the size, a sender over its quota, recipients that are no members, and bytes off their hash are refused with clear errors', async () => {
  const ca = await h.join(A, 'anna', undefined, FILES)
  await h.join(B, 'ben', undefined, FILES)
  const big = blobId()
  ca.send({ t: 'blob_open', id: big, size: MB + 1, hash: b64u(new Uint8Array(32)), to: [B.pub], ttl_s: 60 })
  let e = await ca.take('error')
  assert.deepEqual([e.code, e.id], ['too_big', big])
  assert.match(e.message, /at most 1 MB/)
  // Two of 0.9 MB fit the quota of 2 MB, a third does not, until one is gone.
  const one = crypto.getRandomValues(new Uint8Array(900_000))
  const first = blobId()
  await upload(ca, first, one, [B.pub])
  await upload(ca, blobId(), one, [B.pub])
  const third = blobId()
  ca.send({ t: 'blob_open', id: third, size: one.length, hash: await sha256(one), to: [B.pub], ttl_s: 60 })
  e = await ca.take('error')
  assert.deepEqual([e.code, e.id], ['quota', third])
  assert.match(e.message, /at most 2 MB of your files at a time/)
  assert.deepEqual(
    h.db
      .auditRows()
      .filter(r => r.action === 'blob_refused')
      .map(r => JSON.parse(r.detail).why),
    ['too_big', 'quota'],
  )
  ca.send({ t: 'blob_open', id: blobId(), size: 10, hash: await sha256(one), to: [C.pub], ttl_s: 60 })
  assert.equal((await ca.take('error')).code, 'not_member')
  ca.send({ t: 'blob_open', id: blobId(), size: 10, hash: await sha256(one), to: [A.pub], ttl_s: 60 })
  assert.equal((await ca.take('error')).code, 'bad_frame')
  // Bytes that are not what their hash says: dropped at the last chunk.
  const lie = blobId()
  ca.send({ t: 'blob_open', id: lie, size: 4, hash: await sha256(new Uint8Array(4)), to: [B.pub], ttl_s: 60 })
  await ca.take('blob_have')
  ca.send({ t: 'blob_put', id: lie, at: 0, data: b64u(new Uint8Array([1, 2, 3, 4])) })
  e = await ca.take('error')
  assert.deepEqual([e.code, e.id], ['bad_hash', lie])
  assert.equal(h.db.blob(lie)?.state, 'gone')
  assert.equal(store.bytes(lie), undefined)
  // What is gone leaves the quota: once Ben fetched the first, the third fits.
  const cb = h.clients[1] as Client
  cb.send({ t: 'blob_done', id: first })
  await cb.settle()
  ca.send({ t: 'blob_open', id: third, size: one.length, hash: await sha256(one), to: [B.pub], ttl_s: 60 })
  assert.equal((await ca.take('blob_have')).have, 0)
})

test('an upload resumes where the hub stopped; a chunk in the wrong place only tells the sender where it is', async () => {
  const ca = await h.join(A, 'anna', undefined, FILES)
  await h.join(B, 'ben', undefined, FILES)
  const bytes = crypto.getRandomValues(new Uint8Array(3 * BLOB_CHUNK))
  const id = blobId()
  const hash = await sha256(bytes)
  ca.send({ t: 'blob_open', id, size: bytes.length, hash, to: [B.pub], ttl_s: 60 })
  await ca.take('blob_have')
  ca.send({ t: 'blob_put', id, at: 0, data: b64u(bytes.subarray(0, BLOB_CHUNK)) })
  assert.equal((await ca.take('blob_have')).have, BLOB_CHUNK)
  ca.send({ t: 'blob_put', id, at: 2 * BLOB_CHUNK, data: b64u(bytes.subarray(2 * BLOB_CHUNK)) })
  assert.equal((await ca.take('blob_have')).have, BLOB_CHUNK)
  ca.close()
  await ca.closed
  await h.offline(A.pub)
  const again = await h.login(A, FILES)
  again.send({ t: 'blob_open', id, size: bytes.length, hash, to: [B.pub], ttl_s: 60 })
  assert.equal((await again.take('blob_have')).have, BLOB_CHUNK)
  // Another sender cannot take the id over.
  const cb = h.clients[1] as Client
  cb.send({ t: 'blob_open', id, size: bytes.length, hash, to: [A.pub], ttl_s: 60 })
  assert.equal((await cb.take('error')).code, 'dup_id')
})

test('TTL: a blob nobody fetched is gone at its expiry, and an upload that stopped is gone after an hour', async () => {
  const ca = await h.join(A, 'anna', undefined, FILES)
  await h.join(B, 'ben', undefined, FILES)
  const ready = blobId()
  await upload(ca, ready, crypto.getRandomValues(new Uint8Array(100)), [B.pub], 7200)
  const stuck = blobId()
  ca.send({ t: 'blob_open', id: stuck, size: 2 * BLOB_CHUNK, hash: b64u(new Uint8Array(32)), to: [B.pub], ttl_s: 7200 })
  await ca.take('blob_have')
  ca.send({ t: 'blob_put', id: stuck, at: 0, data: b64u(new Uint8Array(BLOB_CHUNK)) })
  await ca.take('blob_have')
  h.clock.tick(STALE_UPLOAD_MS + SWEEP_MS)
  assert.deepEqual([h.db.blob(stuck)?.state, h.db.blob(stuck)?.gone_why], ['gone', 'stale'])
  assert.equal(h.db.blob(ready)?.state, 'ready')
  assert.equal(h.db.heldBytes(A.pub), 100)
  h.clock.tick(7200 * 1000)
  assert.deepEqual([h.db.blob(ready)?.state, h.db.blob(ready)?.gone_why], ['gone', 'expired'])
  assert.equal(store.ids().length, 0)
  assert.equal(h.db.heldBytes(A.pub), 0)
})

test('a blob for two waits for both; revoking a recipient settles it, revoking its sender deletes it', async () => {
  const ca = await h.join(A, 'anna', undefined, FILES)
  const cb = await h.join(B, 'ben', undefined, FILES)
  await h.join(C, 'cleo', undefined, FILES)
  const both = blobId()
  await upload(ca, both, crypto.getRandomValues(new Uint8Array(100)), [B.pub, C.pub])
  cb.send({ t: 'blob_done', id: both })
  await cb.settle()
  assert.equal(h.db.blob(both)?.state, 'ready')
  h.hub.revoke(C.pub)
  assert.deepEqual([h.db.blob(both)?.state, h.db.blob(both)?.gone_why], ['gone', 'fetched'])
  const mine = blobId()
  await upload(ca, mine, crypto.getRandomValues(new Uint8Array(100)), [B.pub])
  h.hub.revoke(A.pub)
  assert.deepEqual([h.db.blob(mine)?.state, h.db.blob(mine)?.gone_why], ['gone', 'revoked'])
  assert.equal(store.ids().length, 0)
})

test('at start the hub drops bytes no row keeps, and ready blobs whose bytes are not all there', async () => {
  const ca = await h.join(A, 'anna', undefined, FILES)
  await h.join(B, 'ben', undefined, FILES)
  const id = blobId()
  await upload(ca, id, crypto.getRandomValues(new Uint8Array(100)), [B.pub])
  store.append('11111111-1111-4111-8111-111111111111', new Uint8Array(5))
  store.remove(id)
  const { createHub } = await import('../../hub/src/hub.ts')
  const again = createHub({ db: h.db, clock: h.clock, log: () => {}, blobs: store })
  again.stop()
  assert.deepEqual(store.ids(), [])
  assert.deepEqual([h.db.blob(id)?.state, h.db.blob(id)?.gone_why], ['gone', 'lost'])
})

test('gone blobs are pruned with the other finished rows, and the count is audited', async () => {
  const ca = await h.join(A, 'anna', undefined, FILES)
  await h.join(B, 'ben', undefined, FILES)
  const id = blobId()
  await upload(ca, id, crypto.getRandomValues(new Uint8Array(100)), [B.pub], 60)
  h.clock.tick(120_000)
  assert.equal(h.db.blob(id)?.state, 'gone')
  h.clock.tick(91 * 86_400_000)
  assert.equal(h.db.blob(id), null)
  const prune = h.db.auditRows().find(r => r.action === 'prune')
  assert.ok((JSON.parse(prune?.detail ?? '{}').blobs ?? 0) >= 1)
})

test('a message that names a blob not its sender ready for its recipient is refused, not relayed (#371 review)', async () => {
  const ca = await h.join(A, 'anna', undefined, FILES)
  const cb = await h.join(B, 'ben', undefined, FILES)
  const cc = await h.join(C, 'cleo', undefined, FILES)
  const id = blobId()
  const bytes = crypto.getRandomValues(new Uint8Array(100))
  await upload(ca, id, bytes, [B.pub])
  const sealedish = {
    blob: id,
    size: 100,
    hash: await sha256(bytes),
    eph: b64u(new Uint8Array(32).fill(9)),
    key: b64u(new Uint8Array(60)),
    meta: b64u(new Uint8Array(40)),
  }
  // Cleo names Anna's blob; Anna names it for Cleo, who is not its recipient; and a blob nobody opened.
  for (const [c, from, to, file] of [
    [cc, C, B.pub, sealedish],
    [ca, A, C.pub, sealedish],
    [ca, A, B.pub, { ...sealedish, blob: blobId() }],
  ] as const) {
    const env = await question(from, to, '', { id: crypto.randomUUID(), body: { text: '', file } as never })
    c.send({ t: 'send', env })
    const e = await c.take('error')
    assert.deepEqual([e.code, e.id], ['no_blob', msgOf(env).id])
  }
  // A file that is no file shape is no caption-less message either.
  const junk = await question(A, B.pub, '', { id: crypto.randomUUID(), body: { text: '', file: {} } as never })
  ca.send({ t: 'send', env: junk })
  assert.equal((await ca.take('error')).code, 'bad_frame')
  assert.equal(
    (await cb.settle()).some(f => f.t === 'deliver'),
    false,
  )
})

test('a peer has at most 64 blobs on the hub at once, whatever their size (#371 review)', async () => {
  const ca = await h.join(A, 'anna', undefined, FILES)
  await h.join(B, 'ben', undefined, FILES)
  const one = new Uint8Array([1])
  const hash = await sha256(one)
  for (let i = 0; i < 64; i++) {
    ca.send({ t: 'blob_open', id: blobId(), size: 1, hash, to: [B.pub], ttl_s: 60 })
    await ca.take('blob_have')
  }
  const last = blobId()
  ca.send({ t: 'blob_open', id: last, size: 1, hash, to: [B.pub], ttl_s: 60 })
  const e = await ca.take('error')
  assert.deepEqual([e.code, e.id], ['quota', last])
})
