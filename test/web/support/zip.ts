// A zip made in a test (an Office file's parts): stored or deflated, with a central directory a
// reader can trust or one that says a part is bigger than it is (a zip bomb's), sizes in ZIP64
// extra fields, bytes after its end, or entry counts that disagree.
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipPart {
  name: string
  data: string | Uint8Array
  /** Stored as it is, rather than deflated. */
  stored?: boolean
  /** The unpacked size the central directory says, instead of the true one. */
  claims?: number
  /** The sizes as 0xFFFFFFFF, the true ones in a ZIP64 extra field. */
  zip64?: boolean
}

export interface ZipOptions {
  /** Bytes after the end of central directory record. */
  tail?: number
  /** The entries this disk says it holds (+8), when it should say otherwise than the total (+10). */
  onDisk?: number
  total?: number
}

/** The parts zipped. */
export function zip(parts: ZipPart[], options: ZipOptions = {}): Uint8Array {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const part of parts) {
    const raw = typeof part.data === 'string' ? Buffer.from(part.data) : Buffer.from(part.data)
    const body = part.stored ? raw : deflateRawSync(raw)
    const name = Buffer.from(part.name)
    const crc = crc32(raw)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(part.stored ? 0 : 8, 8)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(raw.length, 22)
    head.writeUInt16LE(name.length, 26)
    local.push(head, name, body)
    const extra = Buffer.alloc(part.zip64 ? 20 : 0)
    if (part.zip64) {
      extra.writeUInt16LE(1, 0)
      extra.writeUInt16LE(16, 2)
      extra.writeBigUInt64LE(BigInt(part.claims ?? raw.length), 4)
      extra.writeBigUInt64LE(BigInt(body.length), 12)
    }
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(45, 4)
    entry.writeUInt16LE(45, 6)
    entry.writeUInt16LE(part.stored ? 0 : 8, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(part.zip64 ? 0xffffffff : body.length, 20)
    entry.writeUInt32LE(part.zip64 ? 0xffffffff : (part.claims ?? raw.length), 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt16LE(extra.length, 30)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name, extra)
    offset += head.length + name.length + body.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(options.onDisk ?? parts.length, 8)
  end.writeUInt16LE(options.total ?? parts.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...local, directory, end, Buffer.alloc(options.tail ?? 0)]))
}
