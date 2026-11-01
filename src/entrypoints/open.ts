// The "open" action (bind it to a key) toggles the board: opens it, or focuses it when it is
// open elsewhere, or goes back to where you were when it is the focused pane.
// Placement (config.json): "workspace" (default) keeps the board in a workspace of its own that
// stays open, so it is instant and jumping to a session leaves it in place; "tab" opens it as a
// tab of the current workspace; "overlay" lays it over the current pane and closes it on leave.
// --background (the startup hook): make sure the workspace board runs, without focusing it.
import { readFileSync } from 'node:fs'
import { loadConfig } from '../adapters/config-file.ts'
import { type HerdrWorkspace, herdr, paneProcesses, snapshot } from '../adapters/herdr.ts'
import { boardFile, PLUGIN_ID, ROOT } from '../adapters/paths.ts'
import { isAlive } from '../adapters/process.ts'
import {
  asSavedBoard,
  closeOfLeftover,
  isSidebarPane,
  lastBoardChecked,
  leftoverBoards,
  type SavedBoard,
} from '../core/board-pane.ts'
import { goBack, rememberReturn } from '../services/nav.ts'

/** What `herdr workspace create` and `herdr plugin pane open` answer, as far as this reads them. */
interface Created {
  workspace?: HerdrWorkspace
  tab?: { tab_id?: string }
}
interface Opened {
  plugin_pane?: { pane?: { pane_id?: string } }
}

/** The board that ran last (board.json), if it says one. */
function savedBoard(): SavedBoard | null {
  try {
    return asSavedBoard(JSON.parse(readFileSync(boardFile(), 'utf8')))
  } catch {
    return null
  }
}

const cfg = loadConfig()
const background = process.argv.includes('--background')
const saved = savedBoard()

let snap = await snapshot()
const placement = cfg.placement === 'tab' || cfg.placement === 'overlay' ? cfg.placement : 'workspace'
if (background && placement !== 'workspace') process.exit(0)
// One process-info call when board.json names a live board and its host, in a pane with the board's
// label; none for an older board.json.
const last = await lastBoardChecked(saved, snap.panes, isAlive, paneProcesses)
if (last?.stale) {
  // herdr brought the board's pane back (after a restart) with a shell in it, not the board: it is
  // no plugin pane any more. Close it and open a board as if there were none. Only a pane with the
  // board's label comes back stale; one without it may be the user's now and comes back as null.
  await herdr(['pane', 'close', last.pane]).catch(() => {})
}
// Other panes herdr brought back from earlier boards (the board's label, an idle shell in them):
// herdr is asked only of panes with that label, so with none there is no call.
const leftovers = await leftoverBoards(snap.panes, saved?.pane ?? null, paneProcesses)
for (const pane of leftovers) await herdr(closeOfLeftover(snap.panes, pane)).catch(() => {})
if (last?.stale || leftovers.length) snap = await snapshot()
const board = last && !last.stale ? last.pane : null
if (board) {
  if (background) process.exit(0)
  if (snap.focused_pane_id === board) {
    if (!(await goBack())) await herdr(['plugin', 'pane', 'close', board])
  } else {
    rememberReturn(snap, board)
    await herdr(['plugin', 'pane', 'focus', board])
    await show(snap.panes.find(p => p.pane_id === board)?.tab_id)
    if (placement === 'workspace') await zoom(board)
  }
} else {
  if (!background) rememberReturn(snap, null)
  const open = [
    'plugin',
    'pane',
    'open',
    '--plugin',
    PLUGIN_ID,
    '--entrypoint',
    'board',
    '--cwd',
    ROOT,
    '--env',
    `AGENT_BOARD_PLACEMENT=${placement}`,
    background ? '--no-focus' : '--focus',
  ]
  if (placement !== 'workspace') {
    await herdr([...open, '--placement', placement])
  } else {
    // Its own workspace; a new one comes with a shell tab, closed once the board tab is in.
    const label = cfg.workspace || 'Board'
    let ws = snap.workspaces.find(w => w.label === label)
    let initialTab: string | undefined
    if (!ws) {
      const created = await herdr<Created | null>([
        'workspace',
        'create',
        '--label',
        label,
        '--cwd',
        ROOT,
        '--no-focus',
      ])
      ws = created?.workspace
      initialTab = created?.tab?.tab_id
    }
    if (!ws) throw new Error('herdr workspace create: no workspace in the answer')
    // A reused workspace keeps its tabs, except the ones an earlier board left behind: when the
    // board pane ends, its tab keeps only the herdr-sidebar pane that plugin adds to every tab.
    const leftovers = initialTab ? [] : orphanTabs(ws.workspace_id)
    const opened = await herdr<Opened | null>([...open, '--placement', 'tab', '--workspace', ws.workspace_id])
    if (opened?.plugin_pane?.pane?.pane_id) {
      for (const tab of initialTab ? [initialTab] : leftovers) await herdr(['tab', 'close', tab]).catch(() => {})
    }
    const pane = opened?.plugin_pane?.pane?.pane_id
    if (!background && pane) await show((await snapshot()).panes.find(p => p.pane_id === pane)?.tab_id)
    await zoom(pane)
  }
}

// herdr (0.9.5) moves the attached windows' views only on workspace, tab, pane and agent focus:
// `plugin pane focus` and `--focus` change the server's focus alone, and no window shows the board.
async function show(tab: string | undefined): Promise<void> {
  if (tab) await herdr(['tab', 'focus', tab]).catch(() => {})
}

/** Tabs of the workspace with panes, all of them herdr-sidebar panes: nothing of the user's in there. */
function orphanTabs(workspace: string): string[] {
  return snap.tabs
    .filter(tab => tab.workspace_id === workspace)
    .map(tab => tab.tab_id)
    .filter(id => {
      const panes = snap.panes.filter(p => p.tab_id === id)
      return panes.length > 0 && panes.every(isSidebarPane)
    })
}

// Other plugins (herdr-sidebar) add their panes to every new tab; zoomed, the board keeps the
// whole tab. Zooming focuses the pane, so a background open leaves it to the first real open.
async function zoom(pane: string | undefined): Promise<void> {
  if (background) return
  if (pane) await herdr(['pane', 'zoom', pane, '--on']).catch(() => {})
}
