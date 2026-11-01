// The one open vault, shared by the login fill (services/login-fill.ts) and the login save
// (services/login-save.ts): there is one Bitwarden CLI with one data file, so there is one unlock.
// A request opens it with the master password (services/vault.ts) and holds the session here, in
// the board's memory only: kept for the owner ("keep unlocked for 15 minutes", `for` null, every
// request sees it), or for that one request's own turn, locked again after its time. The session
// bw gives is never logged, said or written; a board restart forgets it, and the vault locks as the
// board starts again (services/vault.ts).
import type { Vault } from './vault.ts'

export interface VaultHold {
  /** The open session for request `id`: kept for the owner (any request), or opened for this one; null when locked. */
  session(id: string): string | null
  /** The vault kept open for the owner until then (not for one request): the card's `unlockedUntil`; null otherwise. */
  keptUntil(): number | null
  /** Holds the session open for `ms`: for every request (`forId` null, "keep unlocked") or for one only. */
  hold(session: string, ms: number, forId: string | null): void
  /** Locked again, unless it is kept open for longer than `forId` needs it (a request settling locks only its own). */
  lock(forId?: string): Promise<void>
  /** Locked now whatever it was kept for (the owner's "Lock now"). */
  lockNow(): Promise<void>
  close(): Promise<void>
}

export function createVaultHold(o: { vault: Vault; onChange: () => void; now?: () => number }): VaultHold {
  const now = o.now ?? Date.now
  let held: { session: string; until: number; for: string | null } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  async function lock(forId?: string): Promise<void> {
    // nothing open: nothing to lock (a declined or expired request never touched the vault)
    if (!held) return
    // kept for the owner, or for another request: a request settling locks only its own
    if (forId !== undefined && held.for !== forId) return
    held = null
    clearTimeout(timer)
    await o.vault.lock().catch(() => {})
    o.onChange()
  }

  return {
    session: id => (held && held.until > now() && (held.for === null || held.for === id) ? held.session : null),
    keptUntil: () => (held && held.for === null && held.until > now() ? held.until : null),
    hold(session, ms, forId) {
      held = { session, until: now() + ms, for: forId }
      clearTimeout(timer)
      timer = setTimeout(() => void lock(), ms)
      timer.unref?.()
    },
    lock,
    async lockNow() {
      await lock()
    },
    async close() {
      clearTimeout(timer)
      if (held) await lock()
    },
  }
}
