// The hub's blobs (#371): sealed bytes it keeps once for the peers their sender named, and never a
// key to them (core/team-file.ts seals them on the sender's board). One file per blob in
// <dir>/blobs, named by its id (a UUID); the row in hub.db says whose it is, for whom, and how far
// it got. In memory for tests. Nothing here reads a clock or knows a peer.
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isMessageId } from '../../src/core/team.ts'

export interface BlobStore {
  /** The bytes held of a blob (0 when there is none). */
  have(id: string): number
  /** Appends at the end; the caller checked that `at` is where it ends. */
  append(id: string, data: Uint8Array): void
  read(id: string, at: number, n: number): Uint8Array
  /** SHA-256 of what is held, base64url. */
  hash(id: string): string
  remove(id: string): void
  /** Every blob held, for the cleanup at start. */
  ids(): string[]
}

const named = (id: string): string => {
  // The id is a file name: only a UUID may be one.
  if (!isMessageId(id)) throw new TypeError('a blob id is a UUID')
  return id
}

/** Blobs as files in `dir` (made 0700). */
export function fileBlobs(dir: string): BlobStore {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = (id: string) => join(dir, named(id))
  const size = (id: string): number => {
    try {
      return statSync(path(id)).size
    } catch {
      return 0
    }
  }
  return {
    have: size,
    append: (id, data) => appendFileSync(path(id), data, { mode: 0o600 }),
    read: (id, at, n) => {
      const fd = openSync(path(id), 'r')
      try {
        const out = Buffer.alloc(Math.max(0, Math.min(n, size(id) - at)))
        const got = readSync(fd, out, 0, out.length, at)
        return new Uint8Array(out.subarray(0, got))
      } finally {
        closeSync(fd)
      }
    },
    hash: id => {
      const h = createHash('sha256')
      const fd = openSync(path(id), 'r')
      try {
        const chunk = Buffer.alloc(1 << 20)
        for (let at = 0; ; ) {
          const got = readSync(fd, chunk, 0, chunk.length, at)
          if (got <= 0) break
          h.update(chunk.subarray(0, got))
          at += got
        }
      } finally {
        closeSync(fd)
      }
      return h.digest('base64url')
    },
    remove: id => {
      try {
        unlinkSync(path(id))
      } catch {}
    },
    ids: () => {
      try {
        return readdirSync(dir).filter(isMessageId)
      } catch {
        return []
      }
    },
  }
}

/** Blobs in memory, for tests: `bytes` shows what the hub holds. */
export function memoryBlobs(): BlobStore & { bytes(id: string): Uint8Array | undefined } {
  const m = new Map<string, Buffer>()
  return {
    have: id => m.get(id)?.length ?? 0,
    append: (id, data) => void m.set(named(id), Buffer.concat([m.get(id) ?? Buffer.alloc(0), data])),
    read: (id, at, n) => new Uint8Array((m.get(id) ?? Buffer.alloc(0)).subarray(at, at + n)),
    hash: id =>
      createHash('sha256')
        .update(m.get(id) ?? Buffer.alloc(0))
        .digest('base64url'),
    remove: id => void m.delete(id),
    ids: () => [...m.keys()],
    bytes: id => {
      const b = m.get(id)
      return b ? new Uint8Array(b) : undefined
    },
  }
}
