// Inflate (RFC 1950 zlib around RFC 1951 deflate) for the board's VNC client's Tight pictures
// (models/rfb.ts): one zlib stream that goes on from rectangle to rectangle, each rectangle's part
// of it ending where the server flushed it (Z_SYNC_FLUSH). So each part starts on a block of its
// own, and only the last 32 KB of what came out (the window) carries over to the next. Small and
// synchronous: a part is inflated the moment all of it has come, into exactly the size Tight says.

/** How far back a match reaches. */
const WINDOW = 32768
/** The first bits of a code looked up at once; a longer code is read a bit at a time. */
const FAST = 10
const MAX_BITS = 15

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
/** The order the code lengths' own code lengths come in. */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

/** A Huffman code: how many codes of each length, the symbols in code order, and the fast table. */
class Code {
  readonly count = new Uint16Array(MAX_BITS + 1)
  readonly symbol: Uint16Array
  /** By the next FAST bits: (symbol << 4) | length, or 0 for a code longer than FAST. */
  readonly fast = new Uint16Array(1 << FAST)
  private readonly offs = new Uint16Array(MAX_BITS + 2)

  constructor(symbols: number) {
    this.symbol = new Uint16Array(symbols)
  }

  /** The code of these lengths (0: no code); false when they cannot make one. */
  build(lengths: ArrayLike<number>, n: number): boolean {
    const { count, symbol, fast, offs } = this
    count.fill(0)
    for (let i = 0; i < n; i++) {
      const len = lengths[i] as number
      count[len] = (count[len] as number) + 1
    }
    count[0] = 0
    let left = 1
    for (let len = 1; len <= MAX_BITS; len++) {
      left = (left << 1) - (count[len] as number)
      if (left < 0) return false
    }
    offs[1] = 0
    for (let len = 1; len < MAX_BITS; len++) offs[len + 1] = (offs[len] as number) + (count[len] as number)
    for (let s = 0; s < n; s++) {
      const len = lengths[s] as number
      if (!len) continue
      const at = offs[len] as number
      symbol[at] = s
      offs[len] = at + 1
    }
    fast.fill(0)
    let code = 0
    let k = 0
    for (let len = 1; len <= MAX_BITS; len++) {
      for (let i = 0; i < (count[len] as number); i++, k++, code++) {
        if (len > FAST) continue
        // deflate sends a code's first bit first: the table is by the bits reversed
        let rev = 0
        for (let b = 0; b < len; b++) rev |= ((code >> b) & 1) << (len - 1 - b)
        const entry = ((symbol[k] as number) << 4) | len
        for (let j = rev; j < 1 << FAST; j += 1 << len) fast[j] = entry
      }
      code <<= 1
    }
    return true
  }
}

const fixedLit = new Code(288)
const fixedDist = new Code(30)
{
  const lengths = new Uint8Array(288)
  lengths.fill(8, 0, 144)
  lengths.fill(9, 144, 256)
  lengths.fill(7, 256, 280)
  lengths.fill(8, 280, 288)
  fixedLit.build(lengths, 288)
  fixedDist.build(new Uint8Array(30).fill(5), 30)
}

/** One zlib stream, inflated a part at a time. */
export class Inflater {
  /** The window (what came out last, up to WINDOW of it) and then the part coming out now. */
  private buf = new Uint8Array(WINDOW + 65536)
  private end = 0
  private started = false
  private finished = false
  private readonly lit = new Code(288)
  private readonly dist = new Code(30)
  private readonly cl = new Code(19)
  private readonly lengths = new Uint8Array(288 + 32)

  /** As new: the next part starts the stream again (Tight's reset bits). */
  reset(): void {
    this.end = 0
    this.started = false
    this.finished = false
  }

  /**
   * What `data`, the stream's next part, inflates to: exactly `size` bytes (or, `atMost`, up to
   * that many: a clipboard's text, its length inside), valid until the next call (the caller copies
   * them out). Null when it is not that: then the stream cannot go on.
   */
  inflate(data: Uint8Array, size: number, atMost = false): Uint8Array | null {
    if (this.finished) return null
    // room for the part after the window: slide the window down, or grow
    if (this.end + size > this.buf.length) {
      const keep = Math.min(this.end, WINDOW)
      if (keep + size > this.buf.length) {
        const bigger = new Uint8Array(WINDOW + Math.max(size, this.buf.length))
        bigger.set(this.buf.subarray(this.end - keep, this.end))
        this.buf = bigger
      } else this.buf.copyWithin(0, this.end - keep, this.end)
      this.end = keep
    }
    const out = this.buf
    const start = this.end
    const limit = start + size
    let op = start
    const len = data.length
    let pos = 0
    if (!this.started) {
      if (len < 2) return null
      const cmf = data[0] as number
      const flg = data[1] as number
      if ((cmf & 15) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0 || flg & 32) return null
      pos = 2
      this.started = true
    }
    // the bits: bitbuf holds bitcnt of them, the first in its lowest bit; past the end, zeros
    let bitbuf = 0
    let bitcnt = 0
    const fill = () => {
      while (bitcnt <= 24) {
        bitbuf |= (pos < len ? (data[pos] as number) : 0) << bitcnt
        pos++
        bitcnt += 8
      }
    }
    const bits = (n: number): number => {
      if (bitcnt < n) fill()
      const v = bitbuf & ((1 << n) - 1)
      bitbuf >>>= n
      bitcnt -= n
      return v
    }
    const decode = (h: Code): number => {
      if (bitcnt < MAX_BITS) fill()
      const e = h.fast[bitbuf & ((1 << FAST) - 1)] as number
      if (e) {
        const n = e & 15
        bitbuf >>>= n
        bitcnt -= n
        return e >> 4
      }
      let code = 0
      let first = 0
      let index = 0
      for (let n = 1; n <= MAX_BITS; n++) {
        code |= bitbuf & 1
        bitbuf >>>= 1
        bitcnt--
        const count = h.count[n] as number
        if (code - count < first) return h.symbol[index + code - first] as number
        index += count
        first = (first + count) << 1
        code <<= 1
      }
      return -1
    }
    /** The bits of the part not read yet (the ones past its end, read as zeros, not counted). */
    const left = () => len * 8 - (pos * 8 - bitcnt)

    for (;;) {
      const rest = left()
      // all of it read, or only the padding to a byte after the last block
      if (rest <= 0 || (rest < 8 && (bitbuf & ((1 << rest) - 1)) === 0)) break
      const last = bits(1)
      const type = bits(2)
      if (type === 0) {
        // stored: from the next byte on, its length and its bytes as they are
        bits(bitcnt & 7)
        pos -= bitcnt >> 3
        bitbuf = 0
        bitcnt = 0
        if (pos + 4 > len) return null
        const n = (data[pos] as number) | ((data[pos + 1] as number) << 8)
        const not = (data[pos + 2] as number) | ((data[pos + 3] as number) << 8)
        pos += 4
        if ((n ^ 0xffff) !== not || pos + n > len || op + n > limit) return null
        out.set(data.subarray(pos, pos + n), op)
        pos += n
        op += n
      } else if (type === 1 || type === 2) {
        let lit = fixedLit
        let dist = fixedDist
        if (type === 2) {
          const nlen = bits(5) + 257
          const ndist = bits(5) + 1
          const ncode = bits(4) + 4
          if (nlen > 286 || ndist > 30) return null
          const lengths = this.lengths
          lengths.fill(0, 0, 19)
          for (let i = 0; i < ncode; i++) lengths[CL_ORDER[i] as number] = bits(3)
          if (!this.cl.build(lengths, 19)) return null
          let i = 0
          while (i < nlen + ndist) {
            const sym = decode(this.cl)
            if (sym < 0) return null
            if (sym < 16) {
              lengths[i++] = sym
              continue
            }
            let repeat: number
            let value = 0
            if (sym === 16) {
              if (i === 0) return null
              value = lengths[i - 1] as number
              repeat = 3 + bits(2)
            } else repeat = sym === 17 ? 3 + bits(3) : 11 + bits(7)
            if (i + repeat > nlen + ndist) return null
            lengths.fill(value, i, i + repeat)
            i += repeat
          }
          if (!lengths[256]) return null
          if (!this.lit.build(lengths, nlen)) return null
          if (!this.dist.build(lengths.subarray(nlen, nlen + ndist), ndist)) return null
          lit = this.lit
          dist = this.dist
        }
        for (;;) {
          const sym = decode(lit)
          if (sym < 256) {
            if (sym < 0 || op >= limit) return null
            out[op++] = sym
            continue
          }
          if (sym === 256) break
          const li = sym - 257
          if (li >= 29) return null
          const n = (LENGTH_BASE[li] as number) + bits(LENGTH_EXTRA[li] as number)
          const di = decode(dist)
          if (di < 0 || di >= 30) return null
          const d = (DIST_BASE[di] as number) + bits(DIST_EXTRA[di] as number)
          const from = op - d
          if (from < 0 || op + n > limit) return null
          for (let k = 0; k < n; k++) out[op + k] = out[from + k] as number
          op += n
        }
      } else return null
      if (left() < 0) return null
      if (last) {
        // the stream's end (a server that never flushes this way: none of Tight's)
        this.finished = true
        break
      }
    }
    if (atMost ? op > limit : op !== limit) return null
    this.end = op
    return out.subarray(start, op)
  }
}
