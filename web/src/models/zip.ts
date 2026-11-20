// The little of a zip the quick look's Office workers read themselves (viewers/*-worker.ts):
// its central directory, to know how big it is once unpacked before a library unpacks all of
// it (a zip of 400 KB can hold 400 MB), and a part's first bytes or all of it (a sheet's frozen
// rows, an .ods's hidden sheets), never more than the directory says it holds; and the zip the
// libraries are given, rebuilt from what its parts really unpack to (storedZip). Stored and
// deflated parts; ZIP64 sizes and directories as their extra records give them.

export interface ZipEntry {
  name: string
  method: number
  compressed: number
  /** Unpacked, in bytes: Infinity when the directory says ZIP64 and gives no size. */
  size: number
  offset: number
  /** Where its central directory record is. */
  record: number
}

const u16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0
const u64 = (b: Uint8Array, at: number) => u32(b, at) + u32(b, at + 4) * 2 ** 32

const FULL32 = 0xffffffff

/**
 * Where the end of central directory record is: searched from the end of the whole file, so bytes
 * put after it (past a comment's 64 KB) do not hide it. The libraries never read this file's own
 * records (storedZip), so a reading of theirs that differs gets them nothing.
 */
function endRecord(bytes: Uint8Array): number {
  for (let at = bytes.length - 22; at >= 0; at--)
    if (bytes[at] === 0x50 && bytes[at + 1] === 0x4b && u32(bytes, at) === 0x06054b50) return at
  return -1
}

/**
 * A ZIP64 central directory: its place, size and number of entries, by its locator just before
 * `end` and the end record it points to, which must follow the directory and come right before
 * the locator.
 */
function zip64Directory(bytes: Uint8Array, end: number): { offset: number; size: number; count: number } | null {
  const locator = end - 20
  if (locator < 0 || u32(bytes, locator) !== 0x07064b50) return null
  const record = u64(bytes, locator + 8)
  if (u32(bytes, record) !== 0x06064b50 || record + 12 + u64(bytes, record + 4) !== locator) return null
  const offset = u64(bytes, record + 48)
  const size = u64(bytes, record + 40)
  if (offset + size !== record) return null
  return { count: Math.max(u64(bytes, record + 24), u64(bytes, record + 32)), offset, size }
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
      // Within its own block, and within the extra field the entry gives.
      const stop = Math.min(at + 4 + size, from + length)
      const take = (wanted: boolean) => {
        if (!wanted || field + 8 > stop) return undefined
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

/**
 * The entries of a zip by its central directory, or null when it has none to read: the ZIP64
 * directory whenever any field of the end record is full, and then every entry as long as their
 * signature goes on, whatever the counts say (a second entry the counts leave out is unpacked all
 * the same); fewer than the counts say is no directory.
 */
export function zipEntries(bytes: Uint8Array): ZipEntry[] | null {
  const end = endRecord(bytes)
  if (end < 0) return null
  // The entries on this disk (+8) and in all (+10): a zip says the same in both; the larger counts.
  let count = Math.max(u16(bytes, end + 8), u16(bytes, end + 10))
  let at = u32(bytes, end + 16)
  let size = u32(bytes, end + 12)
  const full16 = [4, 6, 8, 10].some(field => u16(bytes, end + field) === 0xffff)
  const zip64 = full16 || size === FULL32 || at === FULL32 ? zip64Directory(bytes, end) : null
  if (zip64) ({ count, offset: at, size } = zip64)
  // The directory ends where its end record starts (zip64Directory has its own record checked):
  // bytes between them, or before the archive, have JSZip shift every offset by them and read
  // another directory than this would. Two readings must not differ.
  else if (size === FULL32 || at === FULL32 || at + size !== end) return null
  const entries: ZipEntry[] = []
  const names = new TextDecoder()
  while (u32(bytes, at) === 0x02014b50) {
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
      record: at,
    })
    at += 46 + nameLength + extraLength + u16(bytes, at + 32)
  }
  return entries.length && entries.length >= Math.min(count, 0xffff) ? entries : null
}

/**
 * Whether SheetJS reads the bytes as a zip: `PK` and two bytes below 9, a local file header's
 * start among them. One with no directory to read is broken.
 */
export const looksLikeZip = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] ?? 9) < 9 && (bytes[3] ?? 9) < 9

/** All of a zip's parts, unpacked, in bytes, as the directory says. */
export const unpackedSize = (entries: ZipEntry[]): number => entries.reduce((sum, e) => sum + e.size, 0)

export type Rezipped =
  | { ok: true; bytes: Uint8Array; size: number }
  | { ok: false; why: 'big' | 'broken'; size: number }

/**
 * The zip as the libraries are given it (#230): every part unpacked, all of them together no more
 * than `limit`, and stored again in a zip of this file's own making. JSZip (mammoth's) and SheetJS
 * each read a zip's headers their own way (where the directory is, which ZIP64 field counts, the
 * size they allocate before inflating), and a directory can say a part is smaller than it is:
 * neither library ever reads this file's headers, only parts whose sizes were counted here, with
 * nothing in their headers but those sizes. Two passes: the first counts what each part unpacks
 * to, stopping one byte past the limit; the second unpacks it again into the new zip, whose size is
 * known by then. A part neither stored nor deflated, one that does not unpack whole, or more parts
 * than a plain zip holds: broken.
 */
export async function storedZip(bytes: Uint8Array, entries: ZipEntry[], limit: number): Promise<Rezipped> {
  // 0xFFFF in the end record's counts reads as ZIP64 (JSZip then looks for its locator)
  if (entries.length >= 0xffff) return { ok: false, why: 'broken', size: 0 }
  const parts: { data: Uint8Array; size: number; name: Uint8Array }[] = []
  let size = 0
  for (const entry of entries) {
    const data = partData(bytes, entry)
    if (!data) return { ok: false, why: 'broken', size }
    const unpacked = entry.method === 0 ? data.length : await inflate(data, limit - size)
    if (unpacked === null) return { ok: false, why: 'broken', size }
    size += unpacked
    if (size > limit) return { ok: false, why: 'big', size }
    const name = bytes.subarray(entry.record + 46, entry.record + 46 + u16(bytes, entry.record + 28))
    parts.push({ data, size: unpacked, name })
  }
  let out: Uint8Array
  try {
    out = new Uint8Array(parts.reduce((n, p) => n + 76 + 2 * p.name.length + p.size, 22))
  } catch {
    // no memory for it here: too big to show, as a part past the limit is
    return { ok: false, why: 'big', size }
  }
  const view = new DataView(out.buffer)
  const offsets: number[] = []
  let at = 0
  for (const [i, part] of parts.entries()) {
    const entry = entries[i] as ZipEntry
    offsets.push(at)
    view.setUint32(at, 0x04034b50, true)
    header(view, at + 4, bytes, entry, part.size, part.name.length)
    out.set(part.name, at + 30)
    at += 30 + part.name.length
    if (entry.method === 0) out.set(part.data, at)
    else {
      const room = out.subarray(at, at + part.size)
      if ((await inflate(part.data, part.size, room)) !== part.size) return { ok: false, why: 'broken', size }
    }
    at += part.size
  }
  const directory = at
  for (const [i, part] of parts.entries()) {
    const entry = entries[i] as ZipEntry
    view.setUint32(at, 0x02014b50, true)
    view.setUint16(at + 4, 20, true)
    header(view, at + 6, bytes, entry, part.size, part.name.length)
    // no comment, disk 0, internal attributes 0, the external ones (a folder's) as they were
    view.setUint32(at + 38, u32(bytes, entry.record + 38), true)
    view.setUint32(at + 42, offsets[i] as number, true)
    out.set(part.name, at + 46)
    at += 46 + part.name.length
  }
  view.setUint32(at, 0x06054b50, true)
  view.setUint16(at + 8, parts.length, true)
  view.setUint16(at + 10, parts.length, true)
  view.setUint32(at + 12, at - directory, true)
  view.setUint32(at + 16, directory, true)
  return { ok: true, bytes: out, size }
}

/**
 * The 26 bytes a local header and a directory record share, from "version needed" on: stored, the
 * size as it unpacked, no extra field; the UTF-8 name flag, time, date and CRC as the directory had them.
 */
function header(view: DataView, at: number, bytes: Uint8Array, entry: ZipEntry, size: number, nameLength: number) {
  view.setUint16(at, 20, true)
  view.setUint16(at + 2, u16(bytes, entry.record + 8) & 0x0800, true)
  view.setUint16(at + 4, 0, true)
  view.setUint32(at + 6, u32(bytes, entry.record + 12), true)
  view.setUint32(at + 10, u32(bytes, entry.record + 16), true)
  view.setUint32(at + 14, size, true)
  view.setUint32(at + 18, size, true)
  view.setUint16(at + 22, nameLength, true)
  view.setUint16(at + 24, 0, true)
}

/** A part's compressed bytes, from where its local header says they start; null when they are not all in the file or it has no local header. */
function partData(bytes: Uint8Array, entry: ZipEntry): Uint8Array | null {
  if (u32(bytes, entry.offset) !== 0x04034b50 || (entry.method !== 0 && entry.method !== 8)) return null
  const start = entry.offset + 30 + u16(bytes, entry.offset + 26) + u16(bytes, entry.offset + 28)
  return start + entry.compressed <= bytes.length ? bytes.subarray(start, start + entry.compressed) : null
}

/** The compressed bytes fed to the inflater at a time: what one step can unpack is bounded by it (deflate packs 1032 to 1 at most). */
const STEP = 4 << 10

/**
 * A deflate stream inflated: its output counted up to one byte past `budget`, where the inflating
 * stops, and written into `into` as far as it holds. The bytes go in a step at a time, so no more
 * than a step's output is held at once. Null when the stream does not end exactly where its bytes
 * do (cut short, or more after it).
 */
async function inflate(data: Uint8Array, budget: number, into?: Uint8Array): Promise<number | null> {
  const inflater = new DecompressionStream('deflate-raw')
  const writer = inflater.writable.getWriter()
  const reader = inflater.readable.getReader()
  // Each write waits while its output is unread; one that fails is said by the read.
  const feeding = (async () => {
    for (let at = 0; at < data.length; at += STEP)
      await writer.write(data.subarray(at, at + STEP) as Uint8Array<ArrayBuffer>)
    await writer.close()
  })().catch(() => {})
  let got = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return got
      if (into && got < into.length) into.set(value.subarray(0, into.length - got), got)
      got += value.length
      if (got > budget) return got
    }
  } catch {
    return null
  } finally {
    await reader.cancel().catch(() => {})
    await feeding
  }
}

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
