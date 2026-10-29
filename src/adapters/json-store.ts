// JSON files shared by several processes (cards, schedule entries): read with a type guard,
// changed under a lock.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

export type Guard<T> = (value: unknown) => value is T

/** A plain JSON object (not null, not an array). */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const errorCode = (err: unknown): unknown => (err as { code?: unknown } | null)?.code

/** A JSON file's contents, or null when it is missing, unreadable or not what `guard` accepts. */
export function readJson<T>(path: string, guard: Guard<T>): T | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return guard(value) ? value : null
  } catch {
    return null
  }
}

// An atomic mkdir serializes the whole read/merge/rename across processes. A writer holds the
// lock for milliseconds, so one older than LOCK_STALE_MS was left by a process killed mid-write
// (a closed terminal, a hook cut off): it is taken over, or that file could never be written
// again. Two writers taking over the same dead lock at the same instant is the one race left.
const LOCK_TIMEOUT_MS = 2000
const LOCK_STALE_MS = 30_000
const pause = new Int32Array(new SharedArrayBuffer(4))

function lockAge(lock: string): number {
  try {
    return Date.now() - statSync(lock).mtimeMs
  } catch {
    return 0 // gone already: the next mkdir tells
  }
}

function lockFile(path: string, recoverStale = true): () => void {
  const lock = `${path}.lock`
  const deadline = performance.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      return () => rmdirSync(lock)
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err
      if (recoverStale && lockAge(lock) > LOCK_STALE_MS) {
        try {
          rmdirSync(lock)
        } catch {}
        continue
      }
      if (performance.now() >= deadline) {
        throw new Error(`Timed out waiting for lock: ${lock}`)
      }
      Atomics.wait(pause, 0, 0, 10)
    }
  }
}

const RENAME_TRIES = 10
const RENAME_RETRY_MS = 20

/**
 * Rename over an existing file. On Windows that can fail for a moment with EPERM/EBUSY/EACCES
 * while a virus scanner, the indexer or a reader still has the target or the fresh temp file
 * open, so those are retried briefly (about 200 ms at most) before the error is passed on.
 */
export function renameWithRetry(from: string, to: string, rename: (a: string, b: string) => void = renameSync): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (err) {
      const code = errorCode(err)
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!transient || attempt >= RENAME_TRIES) throw err
      Atomics.wait(pause, 0, 0, RENAME_RETRY_MS)
    }
  }
}

function unlinkIfThere(path: string): void {
  try {
    unlinkSync(path)
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err
  }
}

/**
 * Write `text` to a temp file beside `path`, then rename it over `path` (renameWithRetry), so a
 * reader never sees half a file. When that fails, the temp file goes too and the error is passed on.
 * `mode` (POSIX): the permissions the file gets, the ones it had for a file only its owner may read;
 * without it, as before.
 */
export function replaceFile(
  path: string,
  text: string,
  rename: (a: string, b: string) => void = renameSync,
  mode?: number,
): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text, mode === undefined ? undefined : { mode })
    // The umask may have taken bits off.
    if (mode !== undefined) chmodSync(tmp, mode)
    renameWithRetry(tmp, path, rename)
  } catch (err) {
    unlinkIfThere(tmp)
    throw err
  }
}

/**
 * `mode`: the permissions a written file gets (POSIX; 0o600 for call receipts). `recoverStale`
 * false: a lock left by a writer that died is never taken over, however old (call-receipts.ts).
 */
export type UpdateOptions = { mode?: number; recoverStale?: boolean }

/**
 * Read, change and save a JSON file under its lock, so writers in other processes never lose
 * each other's fields. `change(current)` gets the contents (null when there is no file or it
 * is not what `guard` accepts) and returns the new contents, null to delete the file, or
 * undefined to leave it as it is. Returns what `change` returned.
 */
export function updateJson<T>(
  path: string,
  change: (current: T | null) => T,
  guard: Guard<T>,
  options?: UpdateOptions,
): T
export function updateJson<T>(
  path: string,
  change: (current: T | null) => T | null | undefined,
  guard: Guard<T>,
  options?: UpdateOptions,
): T | null | undefined
export function updateJson<T>(
  path: string,
  change: (current: T | null) => T | null | undefined,
  guard: Guard<T>,
  { mode, recoverStale = true }: UpdateOptions = {},
): T | null | undefined {
  const unlock = lockFile(path, recoverStale)
  const tmp = `${path}.${process.pid}.tmp`
  try {
    const next = change(readJson(path, guard))
    if (next === null) {
      unlinkIfThere(path)
    } else if (next !== undefined) {
      writeFileSync(tmp, JSON.stringify(next), mode === undefined ? undefined : { mode })
      renameWithRetry(tmp, path)
    }
    return next
  } finally {
    try {
      unlinkIfThere(tmp)
    } finally {
      unlock()
    }
  }
}
