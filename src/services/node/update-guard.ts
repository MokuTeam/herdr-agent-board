// The guard of a Windows node's update (#699, services/node/update.ts): a process of its own,
// started before the plugin's files change, that outlives the board it watches. It waits for the
// pending record (adapters/plugin-update.ts) to go: the board that came back on the new commit
// removes it. When the record is still there at the deadline, the new code did not come up: the
// guard takes the record (one of the two only), puts the copy before back and touches a code file,
// so run.ts restarts the board on it.
import type { PendingUpdate } from '../../adapters/plugin-update.ts'

/** The board comes back on the new commit within this long. */
export const GUARD_MS = 120_000
export const GUARD_POLL_MS = 1000

export interface GuardDeps {
  /** The pending record's file. */
  file: string
  waitMs: number
  pollMs: number
  /** The record is still there. */
  pending(file: string): boolean
  /** Takes the record; null when it is gone (the board confirmed meanwhile). */
  claim(file: string): PendingUpdate | null
  /** The copy before (`old`) put into the plugin's folder (`root`). */
  restore(old: string, root: string): void
  /** One code file of the plugin touched, so the watcher of run.ts restarts the board. */
  touch(root: string): void
  log(text: string): void
  sleep(ms: number): Promise<void>
  now(): number
}

const short = (sha: string): string => sha.slice(0, 12)

export async function guardUpdate(d: GuardDeps): Promise<'started' | 'rolled-back' | 'failed'> {
  const end = d.now() + d.waitMs
  while (d.now() < end) {
    if (!d.pending(d.file)) return 'started'
    await d.sleep(Math.max(0, Math.min(d.pollMs, end - d.now())))
  }
  const p = d.claim(d.file)
  if (!p) return 'started'
  try {
    d.restore(p.old, p.root)
  } catch (err) {
    d.log(
      `node: the update to ${short(p.commit)} did not start and the copy before could not be put back: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return 'failed'
  }
  d.touch(p.root)
  d.log(
    `node: the update to ${short(p.commit)} did not start within ${Math.round(d.waitMs / 1000)} s: the copy before (${short(p.from)}) is back in place and the board restarts on it`,
  )
  return 'rolled-back'
}
