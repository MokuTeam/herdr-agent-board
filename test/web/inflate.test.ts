// The board's VNC client's own inflate (web/src/models/inflate.ts) against node's zlib: one zlib
// stream cut where the server flushes it (Z_SYNC_FLUSH), as Tight sends each rectangle's part of
// its streams, at every level and strategy zlib has; what reaches back into an earlier part; a
// stream started again; and what is not that stream.
import { describe, expect, test } from 'bun:test'
import { constants, createDeflate, deflateSync, type ZlibOptions } from 'node:zlib'
import { Inflater } from '../../web/src/models/inflate.ts'

/** `chunks` deflated as one stream, flushed after each: each one's part. */
async function parts(chunks: Uint8Array[], options: ZlibOptions = {}): Promise<Uint8Array[]> {
  const deflate = createDeflate(options)
  const out: Uint8Array[] = []
  let now: Buffer[] = []
  deflate.on('data', (b: Buffer) => now.push(b))
  for (const chunk of chunks) {
    deflate.write(chunk)
    await new Promise<void>(done => deflate.flush(constants.Z_SYNC_FLUSH, () => done()))
    out.push(new Uint8Array(Buffer.concat(now)))
    now = []
  }
  deflate.close()
  return out
}

let seed = 7
const random = () => {
  seed = (seed * 16807) % 2147483647
  return seed / 2147483647
}
const prose = new TextEncoder().encode('the quick brown fox jumps over the lazy dog, again and again; '.repeat(2000))
const noise = Uint8Array.from({ length: 150_000 }, () => Math.floor(random() * 256))
// a screen's palette indices: runs of a few values, and gradients
const screen = Uint8Array.from({ length: 200_000 }, (_, i) => (i % 5000 < 2000 ? (i * 7) & 255 : (i >> 6) % 4))
/** Pieces of each, of every size from 1 byte to 70 KB: one stream's parts. */
const chunks: Uint8Array[] = []
for (let i = 0; i < 45; i++) {
  const from = [prose, noise, screen][i % 3] as Uint8Array
  const n = i < 3 ? i + 1 : 1 + Math.floor(random() * 70_000)
  const at = Math.floor(random() * (from.length - n))
  chunks.push(from.subarray(at, at + n))
}

describe('inflate', () => {
  const settings: [string, ZlibOptions][] = [
    ['stored (level 0)', { level: 0 }],
    ['level 1', { level: 1 }],
    ['level 6', { level: 6 }],
    ['level 9', { level: 9 }],
    ['fixed codes only', { strategy: constants.Z_FIXED }],
    ['Huffman only', { strategy: constants.Z_HUFFMAN_ONLY }],
    ['runs only', { strategy: constants.Z_RLE }],
  ]
  for (const [name, options] of settings)
    test(`one stream in flushed parts, ${name}: each part inflates to what went in`, async () => {
      const inflater = new Inflater()
      for (const [i, part] of (await parts(chunks, options)).entries()) {
        const want = chunks[i] as Uint8Array
        const got = inflater.inflate(part, want.length)
        expect(got && Buffer.from(got).equals(Buffer.from(want))).toBe(true)
      }
    })

  test('a part that reaches back into the one before it', async () => {
    const line = new TextEncoder().encode('a line of text that comes again in the next part')
    const [a, b] = await parts([line, line], { level: 9 })
    const inflater = new Inflater()
    expect(inflater.inflate(a as Uint8Array, line.length)).toEqual(line)
    // the second is all a match into the first: a few bytes for the whole line
    expect((b as Uint8Array).length).toBeLessThan(12)
    expect(inflater.inflate(b as Uint8Array, line.length)).toEqual(line)
  })

  test('started again (Tight’s reset): a new stream, its header first; without it, not the stream', () => {
    const one = deflateSync(prose.subarray(0, 3000), { finishFlush: constants.Z_SYNC_FLUSH })
    const two = deflateSync(prose.subarray(500, 4000), { finishFlush: constants.Z_SYNC_FLUSH })
    const inflater = new Inflater()
    expect(inflater.inflate(one, 3000)).toEqual(prose.subarray(0, 3000))
    expect(inflater.inflate(two, 3500)).toBeNull()
    inflater.reset()
    expect(inflater.inflate(two, 3500)).toEqual(prose.subarray(500, 4000))
  })

  test('not what it says: another size, a broken header, broken data', () => {
    const part = deflateSync(prose.subarray(0, 5000), { finishFlush: constants.Z_SYNC_FLUSH })
    expect(new Inflater().inflate(part, 4999)).toBeNull()
    expect(new Inflater().inflate(part, 5001)).toBeNull()
    expect(new Inflater().inflate(Uint8Array.of(0x78, 0x9d, 1, 2, 3), 3)).toBeNull()
    expect(new Inflater().inflate(Uint8Array.of(0x78), 1)).toBeNull()
    const broken = Uint8Array.from(part)
    broken[2] = 0xff
    expect(new Inflater().inflate(broken, 5000)).toBeNull()
  })
})

describe('up to a size', () => {
  test('a clipboard’s stream, its length inside: what it inflates to when no more than the size; more, null; Tight’s exact size as before', () => {
    const text = new TextEncoder().encode('Скопируй меня — and me too '.repeat(40))
    const whole = deflateSync(text)
    const got = new Inflater().inflate(whole, text.length + 1000, true)
    expect(got && new TextDecoder().decode(got)).toBe(new TextDecoder().decode(text))
    expect(new Inflater().inflate(whole, text.length, true)?.length).toBe(text.length)
    expect(new Inflater().inflate(whole, text.length - 1, true)).toBeNull()
    // without it, only the exact size
    expect(new Inflater().inflate(whole, text.length + 1000)).toBeNull()
    expect(new Inflater().inflate(whole, text.length)?.length).toBe(text.length)
  })
})
