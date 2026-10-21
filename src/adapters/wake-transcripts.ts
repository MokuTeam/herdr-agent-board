// Whether a session scheduled work for itself (core/wake/reaper.ts scheduledIn), from its Claude
// transcript. Read asynchronously, so the reaper's round never blocks the wake process on a large
// transcript, and only again once the file changed.
import { readFile, stat } from 'node:fs/promises'
import { scheduledIn } from '../core/wake/reaper.ts'

/** The answer for each transcript read, with the time and size it was read at. */
const read = new Map<string, { mtimeMs: number; size: number; scheduled: boolean }>()

/**
 * scheduledIn() on the transcript's text, read asynchronously, cached by path until its mtime or
 * size changes; null → false; a file that cannot be read → true (kept up, as today).
 */
export async function scheduledJobs(path: string | null, now: number = Date.now()): Promise<boolean> {
  if (!path) return false
  try {
    const { mtimeMs, size } = await stat(path)
    const before = read.get(path)
    if (before && before.mtimeMs === mtimeMs && before.size === size) return before.scheduled
    const scheduled = scheduledIn(await readFile(path, 'utf8'), now)
    read.set(path, { mtimeMs, size, scheduled })
    return scheduled
  } catch {
    return true
  }
}
