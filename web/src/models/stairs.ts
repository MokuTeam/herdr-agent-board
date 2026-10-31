// The staircase: a board too narrow for its columns (styles/stairs.css, hooks/useStairs.ts). Where
// the board cannot give each column with cards a card's readable width beside the empty ones' heads,
// its cards go in one list instead, lane by lane, top to bottom, every one a card's width, its left
// edge at its column's step, under its column's head. The four columns but Idle share what the
// board shows: a card as wide as it can be, the steps as small as the heads above them allow in two
// rows; Idle starts past the board's right edge, its head peeking there until the board scrolls to
// it. Only where the page lays its board out in columns (wider than 960px): a phone and a narrow
// window keep their stacked column, a board with room its columns. Here: when it applies, where
// each column's cards and head go, where a dragged card lands, and the keys.
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
  /** A card's width in the staircase: at least, and at most (wider only spreads its lines out). */
  card: { min: 320, max: 420 },
  /** px between two heads in a row of the heads. */
  headGap: 8,
  /** The column out of the way, past the board's right edge. */
  aside: 'idle',
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
  /** The board's padding at each side (--gutter). */
  gutter: number
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

/** A column head's width, as wide as its name and count. */
export interface HeadSize {
  id: string
  width: number
}

/** Where the staircase puts the cards and the heads (--stair-* on <html>), in px from the board's left edge for its cards. */
export interface StairsLayout {
  /** Every card's width. */
  card: number
  /** Each column's step: where its cards' and its head's left edges are. */
  steps: Record<string, number>
  /** The row of the heads each head is in, from 1. */
  rows: Record<string, number>
  /** Where the last column's cards end: as far as the heads' row goes sideways. */
  end: number
}

const round = (px: number): number => Math.round(px * 100) / 100

/**
 * The staircase's sizes for a board `room` wide (its gutter past it), its heads `heads` wide.
 * The columns but Idle fill the room: a card's width and a step for each but the first, the card
 * as wide as STAIRS.card allows, the steps as small as the heads allow when every other head shares
 * a row (two rows, each head's left edge at its step), wider where the card has all it may.
 * Idle's step is past the room and the gutter, out of sight until the board scrolls there.
 */
export function stairsLayout(heads: readonly HeadSize[], room: Pick<BoardRoom, 'room' | 'gutter'>): StairsLayout {
  const shown = heads.filter(h => h.id !== STAIRS.aside)
  const aside = heads.find(h => h.id === STAIRS.aside)
  const n = Math.max(1, shown.length - 1)
  // Two rows: a head and the one two further on share one.
  const least = Math.max(0, ...shown.slice(0, -2).map(h => (h.width + STAIRS.headGap) / 2))
  const card = Math.min(STAIRS.card.max, Math.max(STAIRS.card.min, room.room - n * least))
  const step = shown.length > 1 ? Math.max(least, (room.room - card) / n) : 0
  const steps: Record<string, number> = {}
  shown.forEach((h, k) => {
    steps[h.id] = round(k * step)
  })
  const last = (shown.length - 1) * step + card
  if (aside) steps[aside.id] = round(Math.max(room.room, last) + room.gutter)
  // Each head in the first row it fits in; Idle's where it peeks, at the room's right edge.
  const ends: number[] = []
  const rows: Record<string, number> = {}
  for (const h of heads) {
    const left = h.id === STAIRS.aside ? room.room - h.width : (steps[h.id] ?? 0)
    let row = ends.findIndex(end => left >= end + STAIRS.headGap)
    if (row < 0) row = ends.push(0) - 1
    ends[row] = left + h.width
    rows[h.id] = row + 1
  }
  return { card: round(card), steps, rows, end: round(aside ? (steps[aside.id] ?? 0) + card : last) }
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
