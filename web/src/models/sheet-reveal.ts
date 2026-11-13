// Parts of the session sheet that flows outside it act on (what a card waits for, the workspace's name)
// sit in the compact head's fold. Those flows ask for the fold to open (`revealSheetDetails`) and the
// sheet shows it whole for as long as that session shows, without changing the choice it kept
// (hooks/useSheetDensity.ts). The flow and the sheet know nothing of each other: the ask goes through
// here, and the sheet says whether the head was compact for that session (so what is in the fold is
// not in place yet: it springs open).

/** Hears an ask for session `key`; true when its head was compact. */
type Listener = (key: string) => boolean
const listeners = new Set<Listener>()

/** The sheet hears the asks (until it goes). */
export function onRevealDetails(listener: Listener): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** How long the fold takes to open, for a flow that waits for what is in it to be where it will stay. */
export const REVEAL_SETTLE_MS = 700

/**
 * Ask the sheet to show session `key` with its fold open. True when the head was compact for it, so the
 * fold is opening and what is in it is not in place yet; false when nothing needed opening.
 */
export function revealSheetDetails(key: string): boolean {
  let folded = false
  for (const listener of [...listeners]) folded = listener(key) || folded
  return folded
}
