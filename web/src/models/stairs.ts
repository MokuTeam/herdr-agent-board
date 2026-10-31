// The staircase: a board too narrow for its columns (styles/stairs.css, hooks/useStairs.ts). Where
// the board cannot give each column with cards a card's readable width beside the empty ones' heads,
// its cards go in one list instead, lane by lane, top to bottom, every one a card's width, its left
// edge under its column's head; the heads stay in one row at the top, each as wide as its name and
// count. Only where the page lays its board out in columns (wider than 960px): a phone and a narrow
// window keep their stacked column, a board with room its columns. Here: when it applies, where each
// column's cards start, where a dragged card lands, and the keys.
import { type Dir, type GridLane, gridStep, listStep } from '../../../src/core/grid-nav.ts'
import type { DropPlace } from './board-view.ts'

export const STAIRS = {
  /**
   * px a column with cards needs: what a card has on an iPad with no panel, the least width such a
   * column keeps beside a side panel (styles/beside.css --col-card). A board with less is a staircase.
   */
  column: 210,
  /** The page stacks its columns up to this width (app.css @container page (max-width: 960px)): no staircase there. */
  stacked: 960,
  /** px from the board's left or right edge where a dragged card scrolls it sideways. */
  edge: 56,
  /** px it scrolls per pointer move there, as the page does at its top and bottom (board-view.ts DRAG). */
  step: 14,
} as const

/** What the board has for its columns. */
export interface BoardRoom {
  /** The page's width (its container): up to STAIRS.stacked its columns stack. */
  page: number
  /** The board's width for its columns: its content box. */
  room: number
  /** The least width of a column with no card on show: its head's (--col-min). */
  colMin: number
  /** The gap between two columns (--gap). */
  gap: number
}

/**
 * The staircase, or the columns: a page that lays its board out in columns, some card on show,
 * and less room than every column with cards at STAIRS.column and every empty one at its head's.
 */
export function stairsWanted(heads: readonly { vacant: boolean }[], r: BoardRoom): boolean {
  if (r.page <= STAIRS.stacked || !heads.some(h => !h.vacant)) return false
  const need = heads.reduce((w, h) => w + (h.vacant ? r.colMin : STAIRS.column), 0) + r.gap * (heads.length - 1)
  return r.room < need
}

/** A column head's left edge, in the window. */
export interface HeadEdge {
  id: string
  left: number
}

/** Where each column's cards start: its head's left edge from the first head's (--stair-<column>). */
export function stairOffsets(heads: readonly HeadEdge[]): Record<string, number> {
  const first = heads[0]?.left ?? 0
  return Object.fromEntries(heads.map(h => [h.id, Math.round((h.left - first) * 100) / 100]))
}

/** The column whose head's left edge is nearest `x` (the left one of two as near); none without heads. */
export function nearestHead(heads: readonly HeadEdge[], x: number): string | null {
  let best: HeadEdge | null = null
  for (const h of heads) if (!best || Math.abs(h.left - x) < Math.abs(best.left - x)) best = h
  return best?.id ?? null
}

/** Where the pointer is while a card is dragged in the staircase. */
export interface StairsPointer {
  /** The lane under it (data-cat), if any. */
  lane: string | null
  /** Over the lane's cards (its grid), not its title's row. */
  inCards: boolean
  /** The column head under it (its data-col), if any. */
  head: string | null
  /** The lane the dragged card is in on screen. */
  own: string | null
  /** The dragged card's left edge (its ghost's), in the window. */
  left: number
  /** The column heads' left edges, in the window. */
  heads: readonly HeadEdge[]
}

/**
 * The lane and column a card dragged in the staircase is over. The lane is the one under the
 * pointer; its column is the one whose step the card's left edge is nearest, as its cards' left
 * edges line up under their heads, so a card goes on in its own column until it is moved toward
 * another step. Over a lane's title, the lane alone (as a lane's head in the columns). Over a
 * column's head at the top, that column, in the card's own lane. Then board-view.ts dropTarget.
 */
export function stairsPlace(p: StairsPointer): DropPlace {
  if (p.head) return { lane: p.own, column: p.head }
  if (p.lane === null) return { lane: null, column: null }
  return { lane: p.lane, column: p.inCards ? nearestHead(p.heads, p.left) : null }
}

/**
 * px to scroll a board that scrolls sideways by, for a dragged card's pointer at `x`: left near its
 * left edge, right near its right edge (or past them, over a panel), while it can go that way.
 */
export function sidewaysStep(
  x: number,
  board: { left: number; right: number },
  scroll: { at: number; max: number },
): number {
  if (x < board.left + STAIRS.edge && scroll.at > 0) return -STAIRS.step
  if (x > board.right - STAIRS.edge && scroll.at < scroll.max) return STAIRS.step
  return 0
}

/** How the board lays its cards out: in columns, stacked (a narrow page), or as a staircase. */
export type BoardLayout = 'columns' | 'stacked' | 'stairs'

/**
 * The card one step from `from` by keys (the Terminal style's, src/core/grid-nav.ts). Columns are a
 * grid; a stacked board is a list. A staircase is a list going up and down, its cards one under the
 * other, and a grid going left and right: the lane's next column with cards that way.
 */
export function boardStep(
  grid: readonly GridLane[],
  from: string | null,
  dir: Dir,
  layout: BoardLayout,
): string | null {
  const list = grid.flatMap(lane => lane.cols.flat())
  const at = from && list.some(c => c.key === from) ? from : null
  if (!at) return listStep(list, null, dir === 'last' ? 'last' : 'home')
  if (dir === 'home' || dir === 'last') return listStep(list, at, dir)
  const across = dir === 'left' || dir === 'right'
  return layout === 'columns' || (layout === 'stairs' && across) ? gridStep(grid, at, dir) : listStep(list, at, dir)
}
