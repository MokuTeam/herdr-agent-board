// Whether the board that ran last still runs in its pane (entrypoints/open.ts). The terminal board
// (tui/app.ts) writes board.json as it starts: the pane it runs in, its own process, and the one
// that runs it in that pane (run.ts).

/** What board.json says of the board that ran last. */
export interface SavedBoard {
  pane: string
  /** The terminal board's process. Older boards wrote none. */
  pid?: number
  /** The process that runs the terminal board in its pane (run.ts, the pane's own). Older boards wrote none. */
  host?: number
}

const isPid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

/** board.json's content, or null when it names no pane. A pid or host that is no process id counts as none. */
export function asSavedBoard(value: unknown): SavedBoard | null {
  if (!value || typeof value !== 'object') return null
  const { pane, pid, host } = value as Record<string, unknown>
  if (typeof pane !== 'string' || !pane) return null
  return { pane, ...(isPid(pid) && { pid }), ...(isPid(host) && { host }) }
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

/** What runs in a pane, as herdr says (`pane process-info`). */
export interface PaneProcesses {
  /** The pane's own process: its shell, or the plugin's command (run.ts in the board's pane). */
  shell: number
  /** Those in its foreground, each with its command line (none when herdr gives none). */
  foreground: readonly { pid: number; args: readonly string[] }[]
}

/** What herdr says runs in a pane; null when it cannot say. Rejects as null too. */
export type PaneLookup = (pane: string) => Promise<PaneProcesses | null>

/** The board's own scripts: run.ts in its pane and the terminal board (tui.ts) under it. */
const BOARD_SCRIPT = /(?:^|[\\/\s"'])entrypoints[\\/](?:run|tui)\.ts(?=$|[\s"'])/

/** A process that may be the board: its command line names one of the board's scripts, or herdr gave none. */
const maybeBoard = (p: PaneProcesses['foreground'][number]): boolean =>
  p.args.length === 0 || p.args.some(a => BOARD_SCRIPT.test(a))

/**
 * Whether the pane runs the board board.json names: its pid or host among the pane's processes, or
 * a process in its foreground that may be the board. herdr naming nothing in the foreground is no
 * sign either way: the board is trusted.
 */
function runsBoard(info: PaneProcesses, saved: SavedBoard): boolean {
  if (info.foreground.length === 0) return true
  const pids = new Set([info.shell, ...info.foreground.map(p => p.pid)])
  return pids.has(saved.pid ?? 0) || pids.has(saved.host ?? 0) || info.foreground.some(maybeBoard)
}

/** The label herdr gives the board's panes, and keeps on a pane it restores: the board pane's title in herdr-plugin.toml. */
export const BOARD_LABEL = 'Agent board'

/** A pane as these functions read herdr's snapshot. */
interface SnapPane {
  pane_id: string
  tab_id?: string
  label?: string
  agent?: string
  tokens?: Record<string, unknown>
}

/**
 * lastBoard, and when the board's process lives and board.json names its host too, herdr asked what
 * runs in the pane: Windows gives a dead process's id to the next program that starts (after a
 * restart, a driver's helper, say), so a live pid is no proof that the board runs. The pane is stale
 * when neither the pid nor the host is among its processes and none of them may be the board. Only
 * a pane with the board's label is judged so (herdr gives a pane's id out again, so one without it
 * may be the user's now). When herdr cannot say (an error, an older herdr), the pane is trusted as
 * before; a board.json without a host (an older board wrote it) is judged as before, and herdr is
 * not asked.
 */
export async function lastBoardChecked(
  saved: SavedBoard | null,
  panes: readonly SnapPane[],
  alive: (pid: number) => boolean,
  inPane: PaneLookup,
): Promise<{ pane: string; stale: boolean } | null> {
  const last = lastBoard(saved, panes, alive)
  if (!saved || !last || last.stale || saved.pid === undefined || saved.host === undefined) return last
  if (panes.find(p => p.pane_id === last.pane)?.label !== BOARD_LABEL) return last
  const info = await inPane(last.pane).catch(() => null)
  return info && !runsBoard(info, saved) ? { pane: last.pane, stale: true } : last
}

/** Whether the pane holds nothing but its own shell, idle: every foreground process is that shell, and no board. */
const idleShell = (info: PaneProcesses): boolean =>
  info.foreground.length > 0 && info.foreground.every(p => p.pid === info.shell && !maybeBoard(p))

/**
 * Panes herdr brought back from earlier boards: with the board's label, no agent, and nothing in
 * them but an idle shell. herdr restores a board's pane with a shell in it, and when the board's
 * start runs before herdr has put it back (or board.json names another pane), a new board opens
 * beside it. `keep` (board.json's pane) is never one; herdr is asked only of the other labelled
 * panes, one after another. A pane herdr cannot say of, or that runs anything else (a board too),
 * is no leftover.
 */
export async function leftoverBoards(
  panes: readonly SnapPane[],
  keep: string | null,
  inPane: PaneLookup,
): Promise<string[]> {
  const leftovers: string[] = []
  for (const p of panes) {
    if (p.label !== BOARD_LABEL || p.agent || p.pane_id === keep) continue
    const info = await inPane(p.pane_id).catch(() => null)
    if (info && idleShell(info)) leftovers.push(p.pane_id)
  }
  return leftovers
}

/** herdr-sidebar's pane, which that plugin adds to every tab. */
export const isSidebarPane = (p: SnapPane): boolean =>
  !p.agent && Object.keys(p.tokens ?? {}).some(k => k.startsWith('herdr-sidebar'))

/**
 * What closes a leftover board pane: its whole tab when nothing but herdr-sidebar's panes is beside
 * it, as that plugin adds its pane to every tab; else the pane alone (something of the user's is in
 * that tab).
 */
export function closeOfLeftover(panes: readonly SnapPane[], pane: string): string[] {
  const tab = panes.find(p => p.pane_id === pane)?.tab_id
  const alone =
    tab !== undefined && panes.filter(p => p.tab_id === tab).every(p => p.pane_id === pane || isSidebarPane(p))
  return alone ? ['tab', 'close', tab] : ['pane', 'close', pane]
}
