// A QR code of a short text (the board's address for a phone): byte mode, error correction level
// M, versions 1 to 10 (up to 213 bytes). The Phones panel draws it, `board remote pwa` prints it.
// After the standard (ISO/IEC 18004) and Project Nayuki's QR Code generator.

/** Dark modules, row by row: `modules[y][x]`. */
export type QrMatrix = boolean[][]

// Level M, by version (index 0 unused): error correction codewords per block, and blocks.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
const MAX_VERSION = 10
/** Level M in the format bits. */
const FORMAT_M = 0

function rawDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    n -= (25 * align - 10) * align - 55
    if (ver >= 7) n -= 36
  }
  return n
}

const dataCodewords = (ver: number): number =>
  Math.floor(rawDataModules(ver) / 8) - (ECC_PER_BLOCK[ver] ?? 0) * (BLOCKS[ver] ?? 0)

// ------------------------------------------------------------------ Reed-Solomon over GF(256)

function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function divisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j] ?? 0, root)
      if (j + 1 < degree) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0)
    }
    root = gfMul(root, 0x02)
  }
  return result
}

/** The error correction codewords of `data`, `degree` of them. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  const div = divisor(degree)
  const result = new Array<number>(degree).fill(0)
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0)
    result.push(0)
    for (let i = 0; i < degree; i++) result[i] = (result[i] ?? 0) ^ gfMul(div[i] ?? 0, factor)
  }
  return result
}

// ------------------------------------------------------------------ codewords

function codewords(bytes: Uint8Array, ver: number): number[] {
  const capacity = dataCodewords(ver) * 8
  const bits: number[] = []
  const put = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  put(0b0100, 4)
  put(bytes.length, ver < 10 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  put(0, Math.min(4, capacity - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))

  // Split into blocks, each with its error correction, then interleave.
  const blocks = BLOCKS[ver] ?? 1
  const ecc = ECC_PER_BLOCK[ver] ?? 0
  const raw = Math.floor(rawDataModules(ver) / 8)
  const short = blocks - (raw % blocks)
  const shortLen = Math.floor(raw / blocks)
  const all: number[][] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const take = shortLen - ecc + (i < short ? 0 : 1)
    const block = data.slice(k, k + take)
    k += take
    const tail = reedSolomon(block, ecc)
    if (i < short) block.push(-1)
    all.push([...block, ...tail])
  }
  const out: number[] = []
  for (let i = 0; i < (all[0]?.length ?? 0); i++)
    for (const block of all) {
      const v = block[i]
      if (v !== undefined && v >= 0) out.push(v)
    }
  return out
}

// ------------------------------------------------------------------ the matrix

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return []
  const n = Math.floor(ver / 7) + 2
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2
  const result = [6]
  for (let pos = ver * 4 + 10; result.length < n; pos -= step) result.splice(1, 0, pos)
  return result
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

function build(ver: number, data: number[], mask: number): QrMatrix {
  const size = ver * 4 + 17
  const m: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (x: number, y: number, dark: boolean) => {
    const row = m[y]
    const f = fixed[y]
    if (!row || !f || x < 0 || x >= size) return
    row[x] = dark
    f[x] = true
  }

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        if (cy + dy >= 0 && cy + dy < size && cx + dx >= 0 && cx + dx < size) set(cx + dx, cy + dy, d !== 2 && d !== 4)
      }
  const align = alignmentPositions(ver)
  const last = align.length - 1
  for (let i = 0; i < align.length; i++)
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set((align[i] ?? 0) + dx, (align[j] ?? 0) + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }

  // Format bits (with the mask), and the version bits from version 7.
  const format = (FORMAT_M << 3) | mask
  let rem = format
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const fbits = ((format << 10) | rem) ^ 0x5412
  const fb = (i: number) => ((fbits >>> i) & 1) === 1
  for (let i = 0; i <= 5; i++) set(8, i, fb(i))
  set(8, 7, fb(6))
  set(8, 8, fb(7))
  set(7, 8, fb(8))
  for (let i = 9; i < 15; i++) set(14 - i, 8, fb(i))
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, fb(i))
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, fb(i))
  set(8, size - 8, true)
  if (ver >= 7) {
    let r = ver
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25)
    const vbits = (ver << 12) | r
    for (let i = 0; i < 18; i++) {
      const dark = ((vbits >>> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(a, b, dark)
      set(b, a, dark)
    }
  }

  // The codewords, two columns at a time from the right, up and down in turn; then the mask.
  let bit = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
        const row = m[y]
        if (!row || fixed[y]?.[x]) continue
        if (bit < data.length * 8) row[x] = (((data[bit >>> 3] ?? 0) >>> (7 - (bit & 7))) & 1) === 1
        bit++
        if (MASKS[mask]?.(x, y)) row[x] = !row[x]
      }
  }
  return m
}

/** How bad a mask looks to a reader (the standard's four penalty rules). */
function penalty(m: QrMatrix): number {
  const size = m.length
  let score = 0
  const lines: boolean[][] = [...m, ...m.map((_, x) => m.map(row => row[x] === true))]
  const finder = [/10111010000/g, /00001011101/g]
  for (const line of lines) {
    let run = 1
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++
      else {
        if (run >= 5) score += run - 2
        run = 1
      }
    }
    const text = `0000${line.map(d => (d ? '1' : '0')).join('')}0000`
    for (const re of finder) score += (text.match(re)?.length ?? 0) * 40
  }
  let dark = 0
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = m[y]?.[x]
      if (c) dark++
      if (x + 1 < size && y + 1 < size && c === m[y]?.[x + 1] && c === m[y + 1]?.[x] && c === m[y + 1]?.[x + 1])
        score += 3
    }
  const total = size * size
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
  return score
}

/** The QR code of `text`; throws for one too long for version 10. */
export function qrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  let ver = 1
  while (ver <= MAX_VERSION && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++
  if (ver > MAX_VERSION) throw new Error('too long for a QR code')
  const data = codewords(bytes, ver)
  let best: QrMatrix | null = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const m = build(ver, data, mask)
    const s = penalty(m)
    if (s < bestScore) {
      best = m
      bestScore = s
    }
  }
  return best ?? build(ver, data, 0)
}

/** The code as an SVG path (one unit per module, a 4-module quiet zone around it). */
export function qrPath(m: QrMatrix): { d: string; size: number } {
  const parts: string[] = []
  for (let y = 0; y < m.length; y++)
    for (let x = 0; x < m.length; x++) if (m[y]?.[x]) parts.push(`M${x + 4} ${y + 4}h1v1h-1z`)
  return { d: parts.join(''), size: m.length + 8 }
}

/**
 * The code for a terminal: two rows per line with half blocks, with its quiet zone. Black on
 * white whatever the terminal's own colors, so a phone reads it in a dark terminal too.
 */
export function qrText(m: QrMatrix): string {
  const size = m.length
  const dark = (x: number, y: number) => m[y]?.[x] === true
  const lines: string[] = []
  for (let y = -4; y < size + 4; y += 2) {
    let line = ''
    for (let x = -4; x < size + 4; x++) {
      const top = dark(x, y)
      const bottom = dark(x, y + 1)
      line += top ? (bottom ? '█' : '▀') : bottom ? '▄' : ' '
    }
    lines.push(`\x1b[30;107m${line}\x1b[0m`)
  }
  return lines.join('\n')
}
