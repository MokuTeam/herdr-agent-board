// The guard of a Windows node's update (#699, services/node/update.ts): a process of its own,
// started by the board before anything of the plugin changes, that outlives the board and run.ts's
// restarts of it. It says it runs (a heartbeat the board waits for), waits for the board's `go`,
// puts the new copy in place (the plugin's files, the commit stamp last), touches a code file so
// that run.ts restarts the board on the complete copy, and waits for the board that came back on
// the new commit to take the pending record. When the record is still there `waitMs` after the
// copy was in place, it takes the record (one of the two only), puts the copy before back and
// touches a code file again. A copy that cannot be put back keeps the record, in phase
// `restoring`, and is tried again after a pause.
import type { PendingUpdate } from '../../adapters/plugin-update.ts'

/** The board is back on the new commit within this long after the copy is in place. */
export const GUARD_MS = 120_000
export const GUARD_POLL_MS = 1000
/** The board says go within this long after the guard runs. */
export const GO_MS = 60_000
/** The pauses between the tries to put the copy before back. */
export const RETRIES: readonly number[] = [2000, 5000, 15_000, 30_000, 60_000]

export interface GuardDeps {
  /** The pending record's file. */
  file: string
  waitMs: number
  pollMs: number
  goMs: number
  retries: readonly number[]
  /** The record; null when there is none. */
  read(file: string): PendingUpdate | null
  write(file: string, p: PendingUpdate): void
  /** Takes the record; null when it is gone (taken by the other side, or removed). */
  claim(file: string): PendingUpdate | null
  /** Says the guard runs. */
  alive(file: string): void
  /** The new copy `fresh` put into the plugin's folder `root` (`old` is the copy before). */
  apply(fresh: string, root: string, old: string): void
  /** The copy before (`old`) put into the plugin's folder (`root`). */
  restore(old: string, root: string): void
  /** The new copy beside the plugin removed; never throws. */
  drop(fresh: string): void
  /** One code file of the plugin touched, so the watcher of run.ts restarts the board. */
  touch(root: string): void
  log(text: string): void
  sleep(ms: number): Promise<void>
  now(): number
}

export type GuardResult = 'cancelled' | 'started' | 'rolled-back' | 'failed'

const short = (sha: string): string => sha.slice(0, 12)
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export async function guardUpdate(d: GuardDeps): Promise<GuardResult> {
  const beat = (): void => {
    try {
      d.alive(d.file)
    } catch {}
  }
  /** A pause of at most `pollMs`, never past `end`, never below 0. */
  const nap = async (end: number): Promise<void> => {
    await d.sleep(Math.max(0, Math.min(d.pollMs, end - d.now())))
    beat()
  }
  beat()

  // The board's go.
  const goEnd = d.now() + d.goMs
  let p: PendingUpdate | null
  for (;;) {
    p = d.read(d.file)
    if (!p) return 'cancelled'
    if (p.phase === 'go') break
    if (d.now() >= goEnd) {
      const taken = d.claim(d.file)
      if (taken) {
        d.drop(taken.fresh)
        d.log(
          `node: the update to ${short(taken.commit)} got no go from the board: dropped, the plugin was not touched`,
        )
      }
      return 'cancelled'
    }
    await nap(goEnd)
  }

  // The new copy in place.
  let reason = ''
  try {
    d.apply(p.fresh, p.root, p.old)
  } catch (err) {
    reason = `could not be put in place (${why(err)})`
  }
  if (!reason) {
    d.drop(p.fresh)
    const applied: PendingUpdate = { ...p, phase: 'applied', at: d.now() }
    d.write(d.file, applied)
    d.touch(p.root)
    d.log(`node: ${short(p.commit)} is in place; waiting for the board to come back on it`)
    const end = applied.at + d.waitMs
    while (d.now() < end) {
      if (!d.read(d.file)) return 'started'
      await nap(end)
    }
    reason = `did not start within ${Math.round(d.waitMs / 1000)} s`
  }

  // The copy before back.
  let q = d.claim(d.file)
  if (!q) return 'started'
  for (let i = 0; ; i++) {
    try {
      d.restore(q.old, q.root)
      d.touch(q.root)
      d.drop(q.fresh)
      d.log(
        `node: the update to ${short(q.commit)} ${reason}: the copy before (${short(q.from)}) is back in place and the board restarts on it`,
      )
      return 'rolled-back'
    } catch (err) {
      d.log(`node: the update to ${short(q.commit)} ${reason} and the copy before could not be put back: ${why(err)}`)
      try {
        d.write(d.file, { ...q, phase: 'restoring' })
      } catch {}
      const pause = d.retries[i]
      if (pause === undefined) return 'failed'
      await d.sleep(pause)
      beat()
      const again = d.claim(d.file)
      if (!again) return 'started'
      q = again
    }
  }
}
