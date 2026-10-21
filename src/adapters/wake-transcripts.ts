// Whether a session scheduled work for itself (core/wake/reaper.ts scheduledIn), from its Claude
// transcript. Read asynchronously, so the reaper's round never blocks the wake process on a large
// transcript, and only again once the file changed. What is kept is the time of the last schedule,
// so the 7-day window is counted at every look, not frozen at the read.
import { readFile, stat } from 'node:fs/promises'
import { lastScheduledAt, scheduleLive } from '../core/wake/reaper.ts'

/** The last schedule found in each transcript read, with the time and size it was read at. */
const read = new Map<string, { mtimeMs: number; size: number; at: number | null }>()

/**
 * scheduledIn() on the transcript's text, read asynchronously; the last schedule's time cached by
 * path until its mtime or size changes, the window judged against `now` on every call; null →
 * false; a file that cannot be read → true (kept up, as today).
 */
export async function scheduledJobs(path: string | null, now: number = Date.now()): Promise<boolean> {
  if (!path) return false
  try {
    const { mtimeMs, size } = await stat(path)
    let last = read.get(path)
    if (!last || last.mtimeMs !== mtimeMs || last.size !== size) {
      last = { mtimeMs, size, at: lastScheduledAt(await readFile(path, 'utf8')) }
      read.set(path, last)
    }
    return scheduleLive(last.at, now)
  } catch {
    return true
  }
}
