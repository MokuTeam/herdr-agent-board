// Incremental streaming reader and bounded cache for transcript token spend (#636).
// Reads only new appended bytes when a transcript grows in place; skips half-written trailing
// lines until completed; resets cleanly when a file is replaced or truncated.
import { open, stat } from 'node:fs/promises'
import {
  createSpendParser,
  dateIn,
  localZone,
  type SessionSpend,
  type SpendAgent,
  type SpendParser,
} from '../core/spend.ts'

const CHUNK_BYTES = 256 * 1024
const MAX_CACHE = 2000
const EMPTY_BUF = Buffer.alloc(0)

interface CacheEntry {
  mtimeMs: number
  size: number
  ino: number
  offset: number
  parser: SpendParser
  spend: SessionSpend
  title: string
}

const cache = new Map<string, CacheEntry>()

function setCached(key: string, entry: CacheEntry): void {
  if (cache.has(key)) cache.delete(key)
  else if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, entry)
}

export function clearSpendCache(): void {
  cache.clear()
}

export interface TranscriptSpendRead {
  spend: SessionSpend
  title: string
}

/**
 * Read a transcript file's token spend and title asynchronously, using an incremental byte-offset
 * cache keyed by `(agent, zone, minAt, file)`. Returns null when the file cannot be read or is empty.
 */
export async function readTranscriptSpend(
  file: string,
  agent: SpendAgent,
  opts: { zone?: string; minAt?: number } = {},
): Promise<TranscriptSpendRead | null> {
  if (!file) return null
  const zone = opts.zone || localZone()
  const minAt = opts.minAt ?? 0
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(file)
  } catch {
    return null
  }
  if (!st.isFile() || st.size === 0) return null

  const key = `${agent}|${zone}|${minAt}|${file}`
  const prev = cache.get(key)
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && prev.ino === st.ino) {
    return { spend: prev.spend, title: prev.title }
  }

  const append = !!prev && prev.ino === st.ino && st.size > prev.size && prev.offset <= st.size
  const parser = append
    ? prev.parser
    : createSpendParser(agent, { zone, fallbackDay: dateIn(st.mtimeMs, zone), ...(minAt > 0 && { minAt }) })
  let pos = append ? prev.offset : 0
  let completeOffset = pos
  let pending: Buffer = EMPTY_BUF

  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(file, 'r')
    const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(1, st.size - pos)))
    while (pos < st.size) {
      const toRead = Math.min(buf.length, st.size - pos)
      const { bytesRead } = await fh.read(buf, 0, toRead, pos)
      if (bytesRead <= 0) break
      const chunk = buf.subarray(0, bytesRead)
      let start = 0
      while (true) {
        const nl = chunk.indexOf(0x0a, start)
        if (nl < 0) break
        const slice = chunk.subarray(start, nl)
        const raw = pending.length ? Buffer.concat([pending, slice]) : slice
        pending = EMPTY_BUF
        const text = raw.toString('utf8').replace(/\r$/, '')
        if (text) parser.feed(text)
        completeOffset = pos + nl + 1
        start = nl + 1
      }
      if (start < chunk.length) {
        const rest = chunk.subarray(start)
        pending = pending.length ? Buffer.concat([pending, rest]) : Buffer.from(rest)
      }
      pos += bytesRead
    }
  } catch {
    return null
  } finally {
    await fh?.close()
  }

  if (pending.length > 0) {
    const tail = pending.toString('utf8').replace(/\r$/, '').trim()
    if (!tail) {
      completeOffset = st.size
    } else {
      try {
        JSON.parse(tail)
        parser.feed(tail)
        completeOffset = st.size
      } catch {
        // Half-written line at EOF: leave completeOffset before it so the next read catches it whole.
      }
    }
  }

  const spend = parser.result()
  const title = parser.title()
  setCached(key, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    ino: st.ino,
    offset: completeOffset,
    parser,
    spend,
    title,
  })
  return { spend, title }
}
