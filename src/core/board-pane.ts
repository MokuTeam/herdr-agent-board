// Whether the board that ran last still runs in its pane (entrypoints/open.ts). The terminal board
// (tui/app.ts) writes board.json as it starts: the pane it runs in and its own process.

/** What board.json says of the board that ran last. */
export interface SavedBoard {
  pane: string
  /** The terminal board's process. Older boards wrote none. */
  pid?: number
}

/** board.json's content, or null when it names no pane. A pid that is no process id counts as none. */
export function asSavedBoard(value: unknown): SavedBoard | null {
  if (!value || typeof value !== 'object') return null
  const { pane, pid } = value as Record<string, unknown>
  if (typeof pane !== 'string' || !pane) return null
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? { pane, pid } : { pane }
}

/**
 * The board's pane, when it is there. `stale`: the pane is there but the board's process is gone:
 * after a restart herdr brings a session's panes back under the same ids with a shell in them, not
 * the plugin's process, so the pane is no board (and no plugin pane) any more. A board.json with no
 * pid (an older board wrote it) trusts the pane, as before. Null: no board.json, or its pane is gone.
 */
export function lastBoard(
  saved: SavedBoard | null,
  panes: readonly { pane_id: string }[],
  alive: (pid: number) => boolean,
): { pane: string; stale: boolean } | null {
  if (!saved || !panes.some(p => p.pane_id === saved.pane)) return null
  return { pane: saved.pane, stale: saved.pid !== undefined && !alive(saved.pid) }
}
