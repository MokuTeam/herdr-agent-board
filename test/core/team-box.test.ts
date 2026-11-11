// Sealing to box keys and files (#371, core/team-box.ts and core/team-file.ts). First that the
// platform's primitives are what the code takes them for (RFC 7748 X25519, RFC 5869 HKDF, a GCM
// vector of AES-256), on whichever OS runs the suite; then known answers for the construction with
// every key and nonce fixed, so a change to it shows; then round trips and every way to fail.
import { describe, expect, test } from 'bun:test'
import { b64u, readFileRef, unb64u } from '../../src/core/team.ts'
import {
  boxKeyOf,
  generateBoxKey,
  hkdf,
  open,
  seal,
  unwrapSecret,
  wrapSecret,
  x25519,
} from '../../src/core/team-box.ts'
import { checkMeta, fileContext, openFile, openMeta, sealFile } from '../../src/core/team-file.ts'

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'))
const toHex = (b: Uint8Array | null): string => (b ? Buffer.from(b).toString('hex') : 'null')
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v)

const ALICE = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'
const BOB = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb'

describe('the platform does what the code takes it for', () => {
  test('X25519: RFC 7748, section 6.1 (public keys and the shared secret, both ways)', async () => {
    const a = await boxKeyOf(hex(ALICE))
    const b = await boxKeyOf(hex(BOB))
    expect(toHex(unb64u(a.pub))).toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a')
    expect(toHex(unb64u(b.pub))).toBe('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f')
    const k = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742'
    expect(toHex(await x25519(a.pkcs8, unb64u(b.pub) as Uint8Array))).toBe(k)
    expect(toHex(await x25519(b.pkcs8, unb64u(a.pub) as Uint8Array))).toBe(k)
  })

  test('X25519 refuses a public key of low order (the secret would be all zeros)', async () => {
    const a = await boxKeyOf(hex(ALICE))
    expect(await x25519(a.pkcs8, new Uint8Array(32))).toBeNull()
    expect(await x25519(a.pkcs8, fill(31, 9))).toBeNull()
    expect(await x25519('not a key', fill(32, 9))).toBeNull()
  })

  test('HKDF-SHA256: RFC 5869, test case 1', async () => {
    const okm = await hkdf(hex('0b'.repeat(22)), hex('000102030405060708090a0b0c'), hex('f0f1f2f3f4f5f6f7f8f9'), 42)
    expect(toHex(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')
  })

  test('AES-256-GCM: the GCM spec, test case 16 (nonce, then ciphertext and tag)', async () => {
    const key = hex('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308')
    const plain = hex(
      'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39',
    )
    const aad = hex('feedfacedeadbeeffeedfacedeadbeefabaddad2')
    const iv = hex('cafebabefacedbaddecaf888')
    const sealed = await seal(key, plain, aad, iv)
    expect(toHex(sealed)).toBe(
      'cafebabefacedbaddecaf888' +
        '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662' +
        '76fc6ece0f4e1768cddf8853bb2d551b',
    )
    expect(toHex(await open(key, sealed, aad))).toBe(toHex(plain))
  })
})

const BLOB = '11111111-2222-4333-8444-555555555555'
const BEN = 'B'.repeat(43)
const CLEO = 'C'.repeat(43)
const NOTE = { name: 'note.txt', type: 'text/plain', size: 10 }
const fixedFile = () =>
  sealFile(new TextEncoder().encode('hello, ben'), NOTE, BLOB, {
    secret: fill(32, 7),
    dataNonce: fill(12, 1),
    metaNonce: fill(12, 2),
  })

describe('known answers: the construction with every key and nonce fixed', () => {
  test('a sealed file: blob, hash and meta', async () => {
    const f = await fixedFile()
    expect(b64u(f.blob)).toBe('AQEBAQEBAQEBAQEBPmWa2DbbvmsB7k2xPcBi8j98c9UEl3wg88Q')
    expect(f.hash).toBe('4kv5G_H-LpajVY26xK2yh1tn-KYwQ26YArGN3pgTvEk')
    expect(f.meta).toBe(
      'AgICAgICAgICAgICn49Sxx3mwGkJGMhkWCDGrvtZcLEKsXvTg6VKAqAYSkJXc6B2oCRGxC92yJlVj4hjWM7BetDKqwKgjfkLym5UbZQ',
    )
  })

  test('the file key wrapped for one board: the ephemeral key and the wrapped key', async () => {
    const bob = await boxKeyOf(hex(BOB))
    const w = await wrapSecret(fill(32, 7), [{ peer: BEN, box: bob.pub }], fileContext(BLOB), {
      eph: hex(ALICE),
      nonces: [fill(12, 3)],
    })
    expect(w.eph).toBe('hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo')
    expect(w.keys[BEN]).toBe('AwMDAwMDAwMDAwMDJz6woTV2koOxOOo8C4CLzB-rrisNgwrvZSa4TVQQYNRjlIu0e8iTANY8FarQk9v0')
    expect(toHex(await unwrapSecret(w.keys[BEN] as string, w.eph, { peer: BEN, box: bob }, fileContext(BLOB)))).toBe(
      '07'.repeat(32),
    )
  })
})

describe('round trips and failures', () => {
  test('a file seals and opens; its meta opens on its own', async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(100_000))
    const meta = { name: 'shot.png', type: 'image/png', size: bytes.length }
    const f = await sealFile(bytes, meta, BLOB)
    expect(f.blob.length).toBe(bytes.length + 12 + 16)
    expect(await openMeta(f.meta, f.secret, BLOB)).toEqual(meta)
    const opened = await openFile({ blob: BLOB, hash: f.hash, meta: f.meta }, f.blob, f.secret)
    expect(opened.ok && Buffer.from(opened.bytes).equals(Buffer.from(bytes))).toBe(true)
  })

  test('the blob carries neither the bytes nor the name in the clear', async () => {
    const marker = new TextEncoder().encode('zebra-marker-7731 '.repeat(50))
    const f = await sealFile(marker, { name: 'acme-secret-plan.txt', type: 'text/plain', size: marker.length }, BLOB)
    const seen = Buffer.from(f.blob).toString('latin1') + Buffer.from(unb64u(f.meta) as Uint8Array).toString('latin1')
    expect(seen.includes('zebra-marker')).toBe(false)
    expect(seen.includes('acme-secret')).toBe(false)
  })

  test('a changed byte anywhere, a wrong hash, a wrong key or another blob id fail, and say which', async () => {
    const f = await fixedFile()
    const ref = { blob: BLOB, hash: f.hash, meta: f.meta }
    for (let i = 0; i < f.blob.length; i++) {
      const bad = f.blob.slice()
      bad[i] = (bad[i] as number) ^ 1
      expect(await openFile(ref, bad, f.secret)).toEqual({ ok: false, why: 'hash' })
      // With the hash claimed for the changed blob, GCM still refuses it.
      const { sha256 } = await import('../../src/core/team-file.ts')
      expect(await openFile({ ...ref, hash: await sha256(bad) }, bad, f.secret)).toEqual({ ok: false, why: 'data' })
    }
    expect(await openFile(ref, f.blob, fill(32, 8))).toEqual({ ok: false, why: 'key' })
    expect(await openMeta(f.meta, f.secret, '11111111-2222-4333-8444-666666666666')).toBeNull()
    const meta = unb64u(f.meta) as Uint8Array
    meta[20] = (meta[20] as number) ^ 1
    expect(await openFile({ ...ref, meta: b64u(meta) }, f.blob, f.secret)).toEqual({ ok: false, why: 'key' })
  })

  test('a wrapped key opens only for its board, its context and its own bytes', async () => {
    const [ben, cleo] = [await generateBoxKey(), await generateBoxKey()]
    const secret = fill(32, 5)
    const w = await wrapSecret(
      secret,
      [
        { peer: BEN, box: ben.pub },
        { peer: CLEO, box: cleo.pub },
      ],
      fileContext(BLOB),
    )
    const ctx = fileContext(BLOB)
    expect(toHex(await unwrapSecret(w.keys[BEN] as string, w.eph, { peer: BEN, box: ben }, ctx))).toBe(toHex(secret))
    expect(toHex(await unwrapSecret(w.keys[CLEO] as string, w.eph, { peer: CLEO, box: cleo }, ctx))).toBe(toHex(secret))
    // Ben's wrap does not open for Cleo, nor for Ben under Cleo's id, nor for another blob.
    expect(await unwrapSecret(w.keys[BEN] as string, w.eph, { peer: CLEO, box: cleo }, ctx)).toBeNull()
    expect(await unwrapSecret(w.keys[BEN] as string, w.eph, { peer: CLEO, box: ben }, ctx)).toBeNull()
    expect(await unwrapSecret(w.keys[BEN] as string, w.eph, { peer: BEN, box: ben }, fileContext(CLEO))).toBeNull()
    const bad = unb64u(w.keys[BEN] as string) as Uint8Array
    bad[30] = (bad[30] as number) ^ 1
    expect(await unwrapSecret(b64u(bad), w.eph, { peer: BEN, box: ben }, ctx)).toBeNull()
    // A low-order ephemeral key opens nothing.
    expect(await unwrapSecret(w.keys[BEN] as string, b64u(new Uint8Array(32)), { peer: BEN, box: ben }, ctx)).toBeNull()
  })

  test('a meta must be a name, a media type and a size, nothing else', () => {
    expect(checkMeta(NOTE)).toEqual(NOTE)
    for (const bad of [
      { ...NOTE, name: '' },
      { ...NOTE, name: 'a/b.txt' },
      { ...NOTE, name: 'a\\b.txt' },
      { ...NOTE, name: ' lead.txt' },
      { ...NOTE, name: `x${String.fromCharCode(0x202e)}txt.exe` },
      { ...NOTE, name: 'x'.repeat(201) },
      { ...NOTE, type: 'text' },
      { ...NOTE, type: 'Text/Plain' },
      { ...NOTE, size: -1 },
      { ...NOTE, size: 1.5 },
      { ...NOTE, extra: 1 },
      null,
      [],
    ])
      expect(checkMeta(bad)).toBeNull()
  })

  test('a file in a body is held to its six fields (readFileRef)', async () => {
    const f = await fixedFile()
    const ben = await generateBoxKey()
    const w = await wrapSecret(f.secret, [{ peer: BEN, box: ben.pub }], fileContext(BLOB))
    const ref = { blob: BLOB, size: f.blob.length, hash: f.hash, eph: w.eph, key: w.keys[BEN], meta: f.meta }
    expect(readFileRef(ref)).toEqual(ref as never)
    for (const bad of [
      { ...ref, blob: 'x' },
      { ...ref, size: 0 },
      { ...ref, hash: 'x' },
      { ...ref, eph: b64u(fill(31, 1)) },
      { ...ref, key: b64u(fill(59, 1)) },
      { ...ref, meta: 'a'.repeat(2049) },
      { ...ref, meta: b64u(fill(28, 1)) },
      { ...ref, name: 'note.txt' },
      (({ meta: _m, ...rest }) => rest)(ref),
    ])
      expect(readFileRef(bad)).toBeNull()
  })
})
