// A new tab for a sleeper whose pane is gone: a pi session whose pane was closed (#178), or a Claude
// session whose pane wake closed when it went to sleep (#204). In its workspace (by id and label,
// else by label, else by id), in its folder (the home folder when that is gone), under its tab's
// label; a new workspace of its workspace's label when that is gone too. herdr opens a tab at the
// end of its workspace: its CLI cannot move one back to its place.
import { homedir } from 'node:os'
import { tabCreateRoot, tabRename, workspaceCreate } from '../../adapters/herdr.ts'

/** What opening a tab needs: herdr's new tabs and workspaces, and whether a folder is there. */
export interface TabOps {
  /** A new tab in the workspace, in `cwd`, labelled `label`: its pane. */
  newTab(workspace: string, cwd: string, label: string): Promise<string>
  /** A new workspace in `cwd`, labelled `label`, its first tab labelled `tabLabel` when given: its pane. */
  newWorkspace(cwd: string, label: string, tabLabel?: string): Promise<string>
  /** Whether the file or folder is there. */
  exists(path: string): boolean
  home: string
}

/** Where the sleeper was: its workspace's id and label then, its folder, its name, its tab's label. */
export interface TabPlace {
  workspace?: string
  workspaceLabel?: string
  cwd: string
  /** Its name: the tab's label when it had none, and the workspace's. */
  label: string
  tabLabel?: string
}

/** herdr's workspaces, the fields read here. */
export interface TabSnapshot {
  workspaces: { workspace_id: string; label?: string }[]
}

/**
 * The workspace a new tab goes to: the sleeper's own by id, while its label is the one it had (or
 * either is not known: herdr gives an id out again after it starts over), else one of that label;
 * none: a new one.
 */
export function workspaceFor(snap: TabSnapshot, s: Pick<TabPlace, 'workspace' | 'workspaceLabel'>): string | null {
  const byId = snap.workspaces.find(w => w.workspace_id === s.workspace)
  if (byId && (!s.workspaceLabel || !byId.label || byId.label === s.workspaceLabel)) return byId.workspace_id
  const byLabel = s.workspaceLabel ? snap.workspaces.find(w => w.label === s.workspaceLabel) : undefined
  return byLabel?.workspace_id ?? null
}

/** The new tab's pane, where the sleeper was (see the top of the file). */
export async function openTab(ops: TabOps, place: TabPlace, snap: TabSnapshot): Promise<string> {
  const cwd = place.cwd && ops.exists(place.cwd) ? place.cwd : ops.home
  const workspace = workspaceFor(snap, place)
  return workspace
    ? ops.newTab(workspace, cwd, place.tabLabel || place.label)
    : ops.newWorkspace(cwd, place.workspaceLabel || place.label, place.tabLabel)
}

/** TabOps for real: herdr's CLI and the files. */
export function defaultTabOps(exists: (path: string) => boolean): TabOps {
  return {
    newTab: async (workspace, cwd, label) => (await tabCreateRoot(workspace, cwd, label)).pane,
    async newWorkspace(cwd, label, tabLabel) {
      const ws = await workspaceCreate(cwd, label)
      if (!ws.pane) throw new Error('herdr workspace create: no pane in its answer')
      // Its first tab is labelled "1" by herdr: the sleeper's tab's label instead, where it had one.
      if (tabLabel && ws.tab) await tabRename(ws.tab, tabLabel).catch(() => {})
      return ws.pane
    },
    exists,
    home: homedir(),
  }
}
