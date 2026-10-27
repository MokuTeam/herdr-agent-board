// What knew a session by its pane follows it when wake closes that pane and wakes it in a new tab
// (#204). Its card keeps the panes it had (`panes`, the newest last): spawn-agent's line names the
// pane a session started in, and the board's links find the session by it (core/links.ts relate).
// Its schedule entries take the pane it woke in: the scheduler follows an entry by its pane into
// the session /clear starts there (core/schedule-rules.ts targetOf). The card and the entries are
// the board's files, each changed under its own lock, as the board changes them.
import { readCard, writeCard } from '../../adapters/cards.ts'
import { listEntries, updateEntry } from '../../adapters/schedule-store.ts'

/** How many earlier panes a card keeps. */
const KEEP_PANES = 8

/** The session's card with `pane` among its earlier panes (closed by wake). */
export function paneClosed(session: string, pane: string): void {
  const had = readCard(session)?.panes
  const panes = Array.isArray(had) ? had.filter((p): p is string => typeof p === 'string') : []
  if (!panes.includes(pane)) writeCard(session, { panes: [...panes, pane].slice(-KEEP_PANES) })
}

/** The session's schedule entries in `pane`, the one it woke in. */
export function paneOpened(session: string, pane: string): void {
  for (const e of listEntries())
    if (e.key === session && e.pane !== pane) updateEntry(e.id, x => (x.key === session ? { ...x, pane } : undefined))
}

/** What follows a session from pane to pane, for the wake engine and the board's own wake. */
export interface Follow {
  paneClosed(session: string, pane: string): void
  paneOpened(session: string, pane: string): void
}

export const followFiles: Follow = { paneClosed, paneOpened }
