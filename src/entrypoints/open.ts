// The "open" action (bind it to a key) toggles the board: opens it, or focuses it when it is
// open elsewhere, or goes back to where you were when it is the focused pane.
// Placement (config.json): "workspace" (default) keeps the board in a workspace of its own that
// stays open, so it is instant and jumping to a session leaves it in place; "tab" opens it as a
// tab of the current workspace; "overlay" lays it over the current pane and closes it on leave.
// --background (the startup hook): make sure the workspace board runs, without focusing it.
import { readFileSync } from 'node:fs'
import { loadConfig } from '../adapters/config-file.ts'
import { type HerdrPane, type HerdrWorkspace, herdr, snapshot } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import { boardFile, PLUGIN_ID, ROOT } from '../adapters/paths.ts'
import { goBack, rememberReturn } from '../services/nav.ts'

/** What `herdr workspace create` and `herdr plugin pane open` answer, as far as this reads them. */
interface Created {
  workspace?: HerdrWorkspace
  tab?: { tab_id?: string }
}
interface Opened {
  plugin_pane?: { pane?: { pane_id?: string } }
}

/** The pane of the board that ran last (board.json), if it says one. */
function boardPane(): string | null {
  try {
    const saved: unknown = JSON.parse(readFileSync(boardFile(), 'utf8'))
    return isRecord(saved) && typeof saved.pane === 'string' ? saved.pane : null
  } catch {
    return null
  }
}

const cfg = loadConfig()
const background = process.argv.includes('--background')
const board = boardPane()

const snap = await snapshot()
const placement = cfg.placement === 'tab' || cfg.placement === 'overlay' ? cfg.placement : 'workspace'
if (background && placement !== 'workspace') process.exit(0)
if (board && snap.panes.some(p => p.pane_id === board)) {
  if (background) process.exit(0)
  if (snap.focused_pane_id === board) {
    if (!(await goBack())) await herdr(['plugin', 'pane', 'close', board])
  } else {
    rememberReturn(snap, board)
    await herdr(['plugin', 'pane', 'focus', board])
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
    await zoom(opened?.plugin_pane?.pane?.pane_id)
  }
}

/** Tabs of the workspace with panes, all of them herdr-sidebar panes: nothing of the user's in there. */
function orphanTabs(workspace: string): string[] {
  const sidebar = (p: HerdrPane): boolean =>
    !p.agent && Object.keys(p.tokens ?? {}).some(k => k.startsWith('herdr-sidebar'))
  return snap.tabs
    .filter(tab => tab.workspace_id === workspace)
    .map(tab => tab.tab_id)
    .filter(id => {
      const panes = snap.panes.filter(p => p.tab_id === id)
      return panes.length > 0 && panes.every(sidebar)
    })
}

// Other plugins (herdr-sidebar) add their panes to every new tab; zoomed, the board keeps the
// whole tab. Zooming focuses the pane, so a background open leaves it to the first real open.
async function zoom(pane: string | undefined): Promise<void> {
  if (background) return
  if (pane) await herdr(['pane', 'zoom', pane, '--on']).catch(() => {})
}
