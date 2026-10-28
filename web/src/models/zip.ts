// The little of a zip the quick look's Office workers read themselves (viewers/*-worker.ts):
// its central directory, to know how big it is once unpacked before a library unpacks all of
// it (a zip of 400 KB can hold 400 MB), and a part's first bytes or all of it (a sheet's frozen
// rows, an .ods's hidden sheets), never more than the directory says it holds. Stored and
// deflated parts; ZIP64 sizes and directories as their extra records give them.

export interface ZipEntry {
  name: string
  method: number
  compressed: number
  /** Unpacked, in bytes: Infinity when the directory says ZIP64 and gives no size. */
  size: number
  offset: number
}

const u16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0
const u64 = (b: Uint8Array, at: number) => u32(b, at) + u32(b, at + 4) * 2 ** 32

const FULL32 = 0xffffffff

/**
 * Where the end of central directory record is: searched from the end of the whole file, as
 * SheetJS and JSZip search, so bytes put after it (past a comment's 64 KB) do not hide it.
 */
function endRecord(bytes: Uint8Array): number {
  for (let at = bytes.length - 22; at >= 0; at--)
    if (bytes[at] === 0x50 && bytes[at + 1] === 0x4b && u32(bytes, at) === 0x06054b50) return at
  return -1
}

/** A ZIP64 central directory's place and number of entries, by its locator just before `end`. */
function zip64Directory(bytes: Uint8Array, end: number): { offset: number; count: number } | null {
  const locator = end - 20
  if (locator < 0 || u32(bytes, locator) !== 0x07064b50) return null
  const record = u64(bytes, locator + 8)
  if (u32(bytes, record) !== 0x06064b50) return null
  return { count: Math.max(u64(bytes, record + 24), u64(bytes, record + 32)), offset: u64(bytes, record + 48) }
}

interface Wanted {
  size: boolean
  compressed: boolean
  offset: boolean
}

/** An entry's ZIP64 sizes and offset from its extra field (id 1): each there only when its own field says 0xFFFFFFFF. */
function zip64Extra(bytes: Uint8Array, from: number, length: number, need: Wanted) {
  for (let at = from; at + 4 <= from + length; ) {
    const id = u16(bytes, at)
    const size = u16(bytes, at + 2)
    if (id === 1) {
      let field = at + 4
      const take = (wanted: boolean) => {
        if (!wanted || field + 8 > at + 4 + size) return undefined
        const value = u64(bytes, field)
        field += 8
        return value
      }
      return { size: take(need.size), compressed: take(need.compressed), offset: take(need.offset) }
    }
    at += 4 + size
  }
  return {}
}

/** The entries of a zip by its central directory, or null when it has none to read. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] | null {
  const end = endRecord(bytes)
  if (end < 0) return null
  // The entries on this disk (+8) and in all (+10): a zip says the same in both; the larger counts.
  let count = Math.max(u16(bytes, end + 8), u16(bytes, end + 10))
  let at = u32(bytes, end + 16)
  if (count === 0xffff || at === FULL32) {
    const zip64 = zip64Directory(bytes, end)
    if (!zip64) return null
    count = zip64.count
    at = zip64.offset
  }
  const entries: ZipEntry[] = []
  const names = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (u32(bytes, at) !== 0x02014b50) return null
    const nameLength = u16(bytes, at + 28)
    const extraLength = u16(bytes, at + 30)
    let compressed = u32(bytes, at + 20)
    let size = u32(bytes, at + 24)
    let offset = u32(bytes, at + 42)
    if (size === FULL32 || compressed === FULL32 || offset === FULL32) {
      const extra = zip64Extra(bytes, at + 46 + nameLength, extraLength, {
        size: size === FULL32,
        compressed: compressed === FULL32,
        offset: offset === FULL32,
      })
      size = size === FULL32 ? (extra.size ?? Number.POSITIVE_INFINITY) : size
      compressed = compressed === FULL32 ? (extra.compressed ?? 0) : compressed
      offset = offset === FULL32 ? (extra.offset ?? 0) : offset
    }
    entries.push({
      name: names.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      method: u16(bytes, at + 10),
      compressed,
      size,
      offset,
    })
    at += 46 + nameLength + extraLength + u16(bytes, at + 32)
  }
  return entries
}

/** Whether the bytes start as a zip does (a local file header): one with no directory to read is broken. */
export const looksLikeZip = (bytes: Uint8Array): boolean => u32(bytes, 0) === 0x04034b50

/** All of a zip's parts, unpacked, in bytes. */
export const unpackedSize = (entries: ZipEntry[]): number => entries.reduce((sum, e) => sum + e.size, 0)

/**
 * A part's bytes, unpacked: all of it, or its first `limit` bytes, and never more than the
 * directory says it holds (the inflating stops there). Empty for a part this does not unpack
 * (neither stored nor deflated).
 */
export async function zipRead(
  bytes: Uint8Array,
  entry: ZipEntry,
  limit = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  const most = Math.min(limit, entry.size)
  const start = entry.offset + 30 + u16(bytes, entry.offset + 26) + u16(bytes, entry.offset + 28)
  const data = bytes.subarray(start, start + entry.compressed)
  if (entry.method === 0) return data.subarray(0, Math.min(data.length, most))
  if (entry.method !== 8) return new Uint8Array()
  // The bytes come from a fetch's ArrayBuffer, never a shared one.
  const reader = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader()
  const parts: Uint8Array[] = []
  let got = 0
  while (got < most) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    got += value.length
  }
  await reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(got, most))
  let at = 0
  for (const part of parts) {
    if (at >= out.length) break
    out.set(part.subarray(0, out.length - at), at)
    at += part.length
  }
  return out
}

/** A part as text (UTF-8), or its first `limit` bytes; '' when the zip has no such part. */
export async function zipText(
  bytes: Uint8Array,
  entries: ZipEntry[],
  name: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<string> {
  const entry = entries.find(e => e.name === name)
  return entry ? new TextDecoder().decode(await zipRead(bytes, entry, limit)) : ''
}
