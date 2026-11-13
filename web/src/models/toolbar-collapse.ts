// When the toolbar folds its filters away and when it brings them back (#347), as a large title
// collapses: down far enough and then a little further folds it, up a little brings it back, the
// top of the page always has it whole. Without a page: the position goes in, the state comes out.
// hooks/useToolbarCollapse.ts feeds it the scroll and draws the result.

/** Scrolled this far (px) before the toolbar may fold at all. */
export const COLLAPSE_AFTER = 64
/** Travel in one direction (px) that turns it: down to fold, up to unfold. */
export const TURN = 24
/** Within this many px of the top the toolbar is always whole. */
export const TOP = 8
/** After a tap that opened it, this much more downward travel than TURN folds it again. */
export const HOLD = 24

export interface ToolbarScroll {
  collapsed: boolean
  /** Where the direction it is going in now started: the lowest point while open, the highest while folded. */
  ref: number
}

export const OPEN: ToolbarScroll = { collapsed: false, ref: 0 }

/**
 * The state after the page is at `y` (px from the top; the caller leaves out the shift the toolbar's
 * own folding gives the page). Open: it follows the lowest point reached, and folds once the page is
 * past COLLAPSE_AFTER and TURN below that point. Folded: it follows the highest, and opens once the
 * page is TURN above it, or at the top. The same object comes back while nothing changed.
 */
export function toolbarScroll(state: ToolbarScroll, y: number): ToolbarScroll {
  if (y <= TOP) return !state.collapsed && state.ref === y ? state : { collapsed: false, ref: y }
  if (state.collapsed) {
    if (y <= state.ref - TURN) return { collapsed: false, ref: y }
    return y > state.ref ? { collapsed: true, ref: y } : state
  }
  if (y >= state.ref + TURN && y > COLLAPSE_AFTER) return { collapsed: true, ref: y }
  return y < state.ref ? { collapsed: false, ref: y } : state
}

/** The toolbar opened by a tap at `y`: it stays open for TURN + HOLD of downward travel. */
export const openedAt = (y: number): ToolbarScroll => ({ collapsed: false, ref: y + HOLD })

/** The toolbar folded by hand at `y` (the filter button when it is open). */
export const foldedAt = (y: number): ToolbarScroll => ({ collapsed: true, ref: y })

/** What the folded toolbar's filter button says: the filters on, each as the page names it; none: null. */
export interface FilterState {
  /** The lanes on show, by name (none picked: every lane). */
  lanes: readonly string[]
  /** The profile on show, by name; null for all profiles (or no profile switch). */
  profile: string | null
  /** The search text, trimmed. */
  query: string
}

/** How many filters are on: lanes, profile, search, each one. */
export const filterCount = (f: FilterState): number =>
  (f.lanes.length ? 1 : 0) + (f.profile ? 1 : 0) + (f.query ? 1 : 0)

/** The filters in words for a button's name: "Alpha, Beta · Work · “text”"; none: the empty string. */
export function filterText(f: FilterState): string {
  return [f.lanes.join(', '), f.profile ?? '', f.query ? `“${f.query}”` : ''].filter(Boolean).join(' · ')
}
