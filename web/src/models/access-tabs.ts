// The Remote access panel's tabs (components/access/AccessPanel.tsx): the tunnel, the server (its
// login, the tunnel on it, the board on it), the sync of the Claude profiles, and the board's own
// login and devices. The last one picked is this browser's (localStorage, which may be missing or
// refuse: a private window), never the board's.

export const ACCESS_TABS = ['tunnel', 'server', 'sync', 'login'] as const
export type AccessTab = (typeof ACCESS_TABS)[number]

/** Where this browser keeps the tab last picked. */
export const TAB_KEY = 'board.accessTab'

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** The page's localStorage; null where there is none or it refuses. */
function pageStore(): Store | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const isTab = (v: unknown): v is AccessTab => ACCESS_TABS.includes(v as AccessTab)

/** The tab last picked in this browser; the tunnel's when none is kept or it cannot be read. */
export function loadTab(store: Store | null = pageStore()): AccessTab {
  try {
    const kept = store?.getItem(TAB_KEY)
    return isTab(kept) ? kept : 'tunnel'
  } catch {
    return 'tunnel'
  }
}

/** The tab picked, kept for this browser where it can be. */
export function saveTab(tab: AccessTab, store: Store | null = pageStore()): void {
  try {
    store?.setItem(TAB_KEY, tab)
  } catch {
    // a browser that keeps nothing: the panel opens on the tunnel's tab next time
  }
}
