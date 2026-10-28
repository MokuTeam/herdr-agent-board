// The little of a zip the quick look's Office workers read themselves (viewers/*-worker.ts):
// its central directory, to know how big it is once unpacked before a library unpacks all of
// it (a zip of 400 KB can hold 400 MB), and a part's first bytes or all of it (a sheet's frozen
// rows, an .ods's hidden sheets). Stored and deflated parts; a ZIP64 one counts as too big.

export interface ZipEntry {
  name: string
  method: number
  compressed: number
  /** Unpacked, in bytes: Infinity for a ZIP64 entry (its size is not read here). */
  size: number
  offset: number
}

const u16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0

/** The entries of a zip by its central directory, or null when it is not a zip. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] | null {
  // The end of central directory record: within the last 64 KB and 22 bytes (its comment).
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at--)
    if (u32(bytes, at) === 0x06054b50) {
      end = at
      break
    }
  if (end < 0) return null
  const count = u16(bytes, end + 10)
  const entries: ZipEntry[] = []
  const names = new TextDecoder()
  let at = u32(bytes, end + 16)
  for (let i = 0; i < count; i++) {
    if (u32(bytes, at) !== 0x02014b50) return null
    const nameLength = u16(bytes, at + 28)
    const compressed = u32(bytes, at + 20)
    const size = u32(bytes, at + 24)
    entries.push({
      name: names.decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      method: u16(bytes, at + 10),
      compressed,
      size: size === 0xffffffff || compressed === 0xffffffff ? Number.POSITIVE_INFINITY : size,
      offset: u32(bytes, at + 42),
    })
    at += 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32)
  }
  return entries
}

/** All of a zip's parts, unpacked, in bytes. */
export const unpackedSize = (entries: ZipEntry[]): number => entries.reduce((sum, e) => sum + e.size, 0)

/**
 * A part's bytes, unpacked: all of it, or at least its first `limit` bytes (the inflating stops
 * there). Empty for a part this does not unpack (neither stored nor deflated).
 */
export async function zipRead(
  bytes: Uint8Array,
  entry: ZipEntry,
  limit = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  const start = entry.offset + 30 + u16(bytes, entry.offset + 26) + u16(bytes, entry.offset + 28)
  const data = bytes.subarray(start, start + entry.compressed)
  if (entry.method === 0) return data.subarray(0, Math.min(data.length, limit))
  if (entry.method !== 8) return new Uint8Array()
  // The bytes come from a fetch's ArrayBuffer, never a shared one.
  const reader = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader()
  const parts: Uint8Array[] = []
  let got = 0
  while (got < limit) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    got += value.length
  }
  await reader.cancel().catch(() => {})
  const out = new Uint8Array(got)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
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
