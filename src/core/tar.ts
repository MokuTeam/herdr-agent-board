// A file added to the end of a tar archive (POSIX ustar), as `tar -r` would: the board's pack of
// its checkout (adapters/board-pack.ts) gets its mark this way, after `git archive` made the rest.
// Pure, with no node: import.

const BLOCK = 512

const octal = (n: number, width: number): string => `${n.toString(8).padStart(width - 1, '0')}\0`

/** Where the archive's entries end: the first all-zero header block (its end-of-archive marker). */
function endOf(tar: Uint8Array): number {
  let at = 0
  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK)
    if (header.every(b => b === 0)) return at
    const size = Number.parseInt(
      new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim() || '0',
      8,
    )
    if (!Number.isFinite(size)) throw new Error('not a tar archive')
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK
  }
  throw new Error('a tar archive without its end')
}

/** One ustar header for a regular file (a name of 100 bytes at most). */
function header(name: string, size: number, mtime: number, mode = 0o644): Uint8Array {
  const h = new Uint8Array(BLOCK)
  const put = (text: string, at: number): void => {
    h.set(new TextEncoder().encode(text), at)
  }
  const bytes = new TextEncoder().encode(name)
  if (bytes.length > 100) throw new Error(`a name too long for a tar header: ${name}`)
  h.set(bytes, 0)
  put(octal(mode, 8), 100)
  put(octal(0, 8), 108)
  put(octal(0, 8), 116)
  put(octal(size, 12), 124)
  put(octal(Math.floor(mtime / 1000), 12), 136)
  put('        ', 148)
  put('0', 156)
  put('ustar\0', 257)
  put('00', 263)
  const sum = h.reduce((a, b) => a + b, 0)
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return h
}

/** The archive with the file added after its last entry, and its end again. */
export function tarAppend(tar: Uint8Array, name: string, data: Uint8Array, mtime: number): Uint8Array {
  const end = endOf(tar)
  const padded = Math.ceil(data.length / BLOCK) * BLOCK
  const out = new Uint8Array(end + BLOCK + padded + 2 * BLOCK)
  out.set(tar.subarray(0, end), 0)
  out.set(header(name, data.length, mtime), end)
  out.set(data, end + BLOCK)
  return out
}
