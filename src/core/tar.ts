// A plugin archive read as data (#590, docs/design/nodes 6.2, 11.3): the tar `git archive` makes of
// the master's checkout, which a node unpacks beside its plugin folder. No I/O: the bytes come in,
// the entries go out, each path checked, so that what adapters/plugin-update.ts writes is exactly
// what was checked here. Nothing from the archive is run before that.
//
// What is read: ustar and pax headers (`git archive` writes a pax global header with the commit
// and pax records for long names), GNU long names, files and folders. Refused: an absolute path, a
// drive letter, a backslash, a `..` segment, any link (the board's checkout has none, and a link
// is the one way a later entry could be written outside), a device or fifo, a header whose checksum
// is wrong, an archive cut short.

export interface TarFile {
  kind: 'file'
  path: string
  /** 0o755 when any execute bit is set, else 0o644. */
  mode: number
  data: Uint8Array
}
export interface TarFolder {
  kind: 'folder'
  path: string
}
export type TarEntry = TarFile | TarFolder

export interface TarRead {
  entries: TarEntry[]
  /** The pax global header's `comment`: `git archive <commit>` writes the commit there. */
  comment: string | null
}

/** At most this many entries: the board's checkout has about two thousand. */
export const MAX_ENTRIES = 50_000

const BLOCK = 512
const text = new TextDecoder()

/** A NUL-ended field as text. */
function field(b: Uint8Array, at: number, len: number): string {
  const part = b.subarray(at, at + len)
  const end = part.indexOf(0)
  return text.decode(end === -1 ? part : part.subarray(0, end))
}

/** An octal number field; null when it is not one (base-256 sizes included: no plugin file needs them). */
function octal(b: Uint8Array, at: number, len: number): number | null {
  const s = field(b, at, len).trim()
  if (!/^[0-7]*$/.test(s)) return null
  return s === '' ? 0 : Number.parseInt(s, 8)
}

/** Whether a header block's checksum holds: the sum of its bytes with the checksum field read as spaces. */
function checksumHolds(h: Uint8Array): boolean {
  const told = octal(h, 148, 8)
  if (told === null) return false
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number)
  return sum === told
}

/** pax records, `<len> <key>=<value>\n` each. null when one does not parse. */
function paxRecords(data: Uint8Array): Record<string, string> | null {
  const out: Record<string, string> = {}
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(32, at)
    if (space === -1) return null
    const len = Number(text.decode(data.subarray(at, space)))
    if (!Number.isInteger(len) || len <= 0 || at + len > data.length) return null
    const record = text.decode(data.subarray(space + 1, at + len - 1))
    const eq = record.indexOf('=')
    if (eq <= 0) return null
    out[record.slice(0, eq)] = record.slice(eq + 1)
    at += len
  }
  return out
}

/**
 * An entry's path as it will be written under the folder: relative, forward slashes, no `.` or
 * empty segments; null when it is absolute, names a drive, carries a backslash or a NUL, or climbs
 * with `..`.
 */
export function safeTarPath(name: string): string | null {
  if (!name || name.includes('\\') || name.includes('\0')) return null
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null
  const parts = name.split('/').filter(p => p !== '' && p !== '.')
  if (!parts.length || parts.some(p => p === '..')) return null
  return parts.join('/')
}

/** The archive's entries, or why it is refused (in words for the log, never with a file's content). */
export function readTar(bytes: Uint8Array): TarRead | { error: string } {
  const entries: TarEntry[] = []
  let comment: string | null = null
  let next: Record<string, string> = {}
  let longName: string | null = null
  let at = 0
  for (;;) {
    if (at + BLOCK > bytes.length) return { error: 'the archive ends before its end marker' }
    const h = bytes.subarray(at, at + BLOCK)
    if (h.every(b => b === 0)) break
    if (!checksumHolds(h)) return { error: `a header at byte ${at} has a wrong checksum` }
    const size = octal(h, 124, 12)
    if (size === null) return { error: `a header at byte ${at} has no size` }
    const start = at + BLOCK
    if (start + size > bytes.length) return { error: 'the archive is cut short' }
    const data = bytes.subarray(start, start + size)
    at = start + Math.ceil(size / BLOCK) * BLOCK
    const type = String.fromCharCode(h[156] as number)
    if (type === 'g' || type === 'x') {
      const records = paxRecords(data)
      if (!records) return { error: 'a pax header does not parse' }
      if (type === 'g') comment = records.comment ?? comment
      else next = records
      continue
    }
    if (type === 'L') {
      longName = field(data, 0, data.length)
      continue
    }
    // GNU's long link name: a link follows, which is refused below.
    if (type === 'K') continue
    const prefix = field(h, 345, 155)
    const short = field(h, 0, 100)
    const raw = next.path ?? longName ?? (prefix ? `${prefix}/${short}` : short)
    next = {}
    longName = null
    const path = safeTarPath(raw)
    if (!path) return { error: `a path that leaves the folder: ${JSON.stringify(raw.slice(0, 200))}` }
    if (entries.length >= MAX_ENTRIES) return { error: `more than ${MAX_ENTRIES} entries` }
    if (type === '0' || type === '\0' || type === '7') {
      const mode = octal(h, 100, 8) ?? 0o644
      entries.push({ kind: 'file', path, mode: mode & 0o111 ? 0o755 : 0o644, data })
    } else if (type === '5') entries.push({ kind: 'folder', path })
    else if (type === '1' || type === '2') return { error: `a link: ${path}` }
    else return { error: `an entry of type ${JSON.stringify(type)}: ${path}` }
  }
  // A path written twice, or one under a path that is a file: refused, so nothing is written over
  // what the archive itself put there.
  const kinds = new Map<string, TarEntry['kind']>()
  for (const e of entries) {
    const parts = e.path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const up = kinds.get(parts.slice(0, i).join('/'))
      if (up && up !== 'folder') return { error: `a path under a file: ${e.path}` }
    }
    const seen = kinds.get(e.path)
    if (seen && !(seen === 'folder' && e.kind === 'folder')) return { error: `a path written twice: ${e.path}` }
    kinds.set(e.path, e.kind)
  }
  return { entries, comment }
}
