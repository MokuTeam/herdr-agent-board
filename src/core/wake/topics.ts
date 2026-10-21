// The Telegram topic a Claude session in herdr belongs to: the routing key tg-mcp takes in the
// X-Cwd header, which the claude-tg launcher puts in TG_KEY. A workspace's first tab is
// "topic:<workspace>", its other tabs "topic:<workspace> / <tab label>"; outside herdr, or for a
// workspace whose name has no ASCII letters left, it is the folder. Characters outside ASCII are
// dropped (HTTP headers must be ASCII) and the result is trimmed. The router maps keys back to
// tabs with the same functions (tabKeys).
//
// A port of herdr-wake's tg-key.mjs (without its command line) and topics.mjs. Pure: the caller
// hands in herdr's snapshot.

/** What of `herdr api snapshot` the keys are computed from. */
export interface TopicSnapshot {
  workspaces: { workspace_id: string; label?: string }[]
  tabs: { tab_id: string; workspace_id: string; label?: string; number?: number }[]
  panes: { pane_id: string; tab_id?: string; workspace_id?: string }[]
}

/** The printable ASCII of `raw`, trimmed: what an HTTP header can carry. */
export function asciiKey(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
}

/** A workspace's tabs in the order herdr shows them. */
export function workspaceTabs(snap: TopicSnapshot | null | undefined, workspaceId: string): TopicSnapshot['tabs'] {
  return (snap?.tabs ?? [])
    .filter(t => t.workspace_id === workspaceId)
    .sort((a, b) => Number(a.number) - Number(b.number))
}

/** The key of the tab at `index` (0: the first) of a workspace labelled `workspace`. */
export function tabKey(workspace: string, index: number, tabLabel: string | undefined): string {
  return asciiKey(index === 0 ? `topic:${workspace}` : `topic:${workspace} / ${tabLabel}`)
}

/**
 * The key for a pane in a herdr snapshot. The folder's when herdr does not know the pane, or its
 * workspace has no label, or none that survives the ASCII filter ("topic:" alone would put every
 * such workspace in one nameless topic).
 */
export function keyFor(snap: TopicSnapshot | null | undefined, paneId: string | undefined, cwd: string): string {
  const pane = paneId ? (snap?.panes ?? []).find(p => p.pane_id === paneId) : undefined
  const ws = pane ? (snap?.workspaces ?? []).find(w => w.workspace_id === pane.workspace_id) : undefined
  if (pane && ws?.label && asciiKey(ws.label)) {
    const tabs = workspaceTabs(snap, ws.workspace_id)
    const i = tabs.findIndex(t => t.tab_id === pane.tab_id)
    const tab = tabs[i]
    if (tab) return tabKey(ws.label, i, tab.label)
  }
  return asciiKey(cwd)
}

/** Routing key -> tab ids. Several tabs can collapse into one key once non-ASCII is stripped. */
export function tabKeys(snap: TopicSnapshot): Map<string, string[]> {
  const keys = new Map<string, string[]>()
  for (const ws of snap.workspaces) {
    if (!ws.label) continue
    const label = ws.label
    workspaceTabs(snap, ws.workspace_id).forEach((tab, i) => {
      const key = tabKey(label, i, tab.label)
      const ids = keys.get(key)
      if (ids) ids.push(tab.tab_id)
      else keys.set(key, [tab.tab_id])
    })
  }
  return keys
}
