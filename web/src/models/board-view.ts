// What the board shows of the payload: the items on show, the lane and column each card is in
// (with the user's drops the server has not confirmed yet), the lanes in category order, and the
// pure parts of dragging a card and of cards appearing.
import type { BoardCategory } from '../../../src/core/payload.ts'
import type { ColumnId, Item } from '../../../src/core/types.ts'
import { profileShown } from './profiles.ts'

/** Whether the lanes control (`filter`: a category id or 'all') shows lane `category`. */
export const laneShown = (filter: string, category: string): boolean => filter === 'all' || filter === category

export type CategoryLook = { id: string; title: string; color: string }

/** A lane's title and color; one the payload does not list shows its id in gray. */
export function categoryInfo(categories: BoardCategory[], id: string): CategoryLook {
  return categories.find(c => c.id === id) ?? { id, title: id, color: 'var(--gray)' }
}

export interface ViewOptions {
  query: string
  /** Show sessions asleep in the idle column. */
  sleepers: boolean
  categories: BoardCategory[]
  categoryOf: (item: Item) => string
  /** The profile switch's pick ('all' when not given), as it reads (models/profiles.ts pickedProfile). */
  profile?: string
  /** Sessions on their way to the archive: off the board at once (hooks/useArchive.ts). */
  archiving?: ReadonlyMap<string, number>
}

/**
 * The items on the board: none on its way to the archive, sleeping idle ones only when asked for
 * (favorites always), those of the profile the switch shows, and those the search matches.
 */
export function visibleItems(
  items: Item[],
  { query, sleepers, categories, categoryOf, profile = 'all', archiving }: ViewOptions,
): Item[] {
  const q = query.trim().toLowerCase()
  return items.filter(it => {
    if (archiving?.has(it.key)) return false
    if (!sleepers && it.sleeping && it.column === 'idle' && !it.favorite) return false
    if (!profileShown(profile, it)) return false
    if (!q) return true
    const title = categoryInfo(categories, categoryOf(it)).title
    // What its helpers at work do counts too.
    const helping = (it.helpers?.live ?? []).map(h => h.label)
    return [
      it.name,
      it.autoName,
      it.doing,
      it.wait,
      it.title,
      it.lastText,
      it.prompt,
      it.workspace,
      title,
      ...helping,
    ].some(v => v && String(v).toLowerCase().includes(q))
  })
}

// ---------------------------------------------------------------- moves the server has not confirmed

export type MovedColumn = { col: ColumnId; at: number }

/** Where the user dropped cards, until the server agrees. */
export interface PendingMoves {
  /** key -> category the user dropped it in. */
  cat: ReadonlyMap<string, string>
  /** key -> column the user dropped it in, and when (it waits 8 s at most). */
  col: ReadonlyMap<string, MovedColumn>
}

export const NO_MOVES: PendingMoves = { cat: new Map(), col: new Map() }

/** How long a dropped column holds against a server that does not show it. */
export const MOVED_COLUMN_MS = 8000

type Placed = Pick<Item, 'key' | 'category' | 'column'>

export const catOf = (moves: PendingMoves, it: Pick<Item, 'key' | 'category'>): string =>
  moves.cat.get(it.key) ?? it.category

export const colOf = (moves: PendingMoves, it: Pick<Item, 'key' | 'column'>): ColumnId =>
  moves.col.get(it.key)?.col ?? it.column

export interface Move {
  cat: string | null
  column: ColumnId | null
  at: number
}

/** A drop: the lane and/or column it names, on screen at once. */
export function withMove(moves: PendingMoves, key: string, { cat, column, at }: Move): PendingMoves {
  if (!cat && !column) return moves
  return {
    cat: cat ? new Map(moves.cat).set(key, cat) : moves.cat,
    col: column ? new Map(moves.col).set(key, { col: column, at }) : moves.col,
  }
}

/** The server refused the move: the card goes back. */
export function withoutMove(moves: PendingMoves, key: string): PendingMoves {
  if (!moves.cat.has(key) && !moves.col.has(key)) return moves
  const cat = new Map(moves.cat)
  const col = new Map(moves.col)
  cat.delete(key)
  col.delete(key)
  return { cat, col }
}

/** On every board: drops the server now shows, and columns that waited too long, are let go. */
export function settleMoves(moves: PendingMoves, items: Placed[], now: number): PendingMoves {
  const byKey = new Map(items.map(it => [it.key, it]))
  const cat = new Map([...moves.cat].filter(([key, c]) => byKey.get(key)?.category !== c))
  const col = new Map(
    [...moves.col].filter(([key, m]) => byKey.get(key)?.column !== m.col && now - m.at <= MOVED_COLUMN_MS),
  )
  if (cat.size === moves.cat.size && col.size === moves.col.size) return moves
  return { cat, col }
}

// ---------------------------------------------------------------- lanes

export interface ColumnView {
  id: ColumnId
  items: Item[]
}

export interface LaneView {
  id: string
  title: string
  color: string
  /** Its cards on show, in board order. */
  items: Item[]
  /** The lanes control shows it. */
  shown: boolean
  columns: ColumnView[]
}

export interface BoardShape {
  categories: BoardCategory[]
  columns: { id: ColumnId }[]
}

/** One lane per category in the payload's order, its cards split into the columns. */
export function lanesOf(board: BoardShape, visible: Item[], filter: string, moves: PendingMoves): LaneView[] {
  return board.categories.map(({ id, title, color }) => {
    const items = visible.filter(it => catOf(moves, it) === id)
    return {
      id,
      title,
      color,
      items,
      shown: laneShown(filter, id),
      columns: board.columns.map(c => ({ id: c.id, items: items.filter(it => colOf(moves, it) === c.id) })),
    }
  })
}

/** Some lane on show has cards (else the board says why it is empty). */
export const anyShown = (lanes: LaneView[]): boolean => lanes.some(l => l.shown && l.items.length > 0)

// ---------------------------------------------------------------- dragging a card

export const DRAG = {
  /** px the pointer travels before a press becomes a drag. */
  threshold: 6,
  /** A click this soon after a drag ended is the drag's own release. */
  clickAfterMs: 350,
  /** Pointer samples kept for the release velocity. */
  samples: 12,
  /** px from the top where the page scrolls up. */
  edgeTop: 150,
  /** px above the bottom (and a panel docked there) where it scrolls down. */
  edgeBottom: 70,
  /** px the page scrolls per pointer move at an edge. */
  scrollStep: 14,
} as const

export interface DragStart {
  canEdit: boolean
  pointerType: string
  button: number
  /** Pressed on one of the card's buttons. */
  onControl: boolean
  /** The session is on the board. */
  known: boolean
}

/** Mouse and pen drag cards; touch scrolls the page. */
export const mayDrag = ({ canEdit, pointerType, button, onControl, known }: DragStart): boolean =>
  canEdit && pointerType !== 'touch' && button === 0 && !onControl && known

type Point = { x: number; y: number }

export const dragStarted = (from: Point, to: Point): boolean =>
  Math.hypot(to.x - from.x, to.y - from.y) >= DRAG.threshold

/** Where the pointer is: the lane (data-cat) and column (data-col) under it, if any. */
export interface DropPlace {
  lane: string | null
  column: string | null
}

/** What a drop changes: another lane, another column, or both. */
export interface DropTarget {
  cat: string | null
  column: ColumnId | null
}

const COLUMN_IDS: ReadonlySet<string> = new Set<ColumnId>(['work', 'me', 'ext', 'done', 'idle'])
const isColumnId = (id: string | null): id is ColumnId => id !== null && COLUMN_IDS.has(id)

/**
 * What dropping the card at `place` changes, null when nothing. A lane head or the gap between
 * columns changes only the lane; "Working" takes no cards.
 */
export function dropTarget(it: Placed | undefined, moves: PendingMoves, place: DropPlace): DropTarget | null {
  if (!it || place.lane === null) return null
  const cat = place.lane !== catOf(moves, it) ? place.lane : null
  const column =
    isColumnId(place.column) && place.column !== 'work' && place.column !== colOf(moves, it) ? place.column : null
  return cat || column ? { cat, column } : null
}

/** The lane or column lit up as the drop place: the column when the column changes there, else the lane. */
export interface DropLit {
  lane: string
  column: ColumnId | null
}

export function dropLit(target: DropTarget | null, place: DropPlace): DropLit | null {
  if (!target || place.lane === null) return null
  if (target.column) return { lane: place.lane, column: target.column }
  return target.cat ? { lane: place.lane, column: null } : null
}

export interface DragAfterDraw {
  /** The session is still on the board. */
  known: boolean
  /** The dragged card's element is still in the page. */
  connected: boolean
  /** The page has a card for it again (React drew it anew, in another column). */
  redrawn: boolean
}

/**
 * What becomes of a drag when the board is drawn while it goes on: the session left the board →
 * it ends, ghost and all; its card was drawn anew elsewhere → it goes on with that element.
 */
export function dragAfterDraw({ known, connected, redrawn }: DragAfterDraw): 'keep' | 'follow' | 'cancel' {
  if (!known) return 'cancel'
  if (connected) return 'keep'
  return redrawn ? 'follow' : 'cancel'
}

/** px to scroll the page by for a pointer at `y`: up near the top, down above the bottom (and a panel there). */
export function edgeScroll(y: number, viewportHeight: number, roomBelow: number): number {
  if (y < DRAG.edgeTop) return -DRAG.scrollStep
  if (y > viewportHeight - roomBelow - DRAG.edgeBottom) return DRAG.scrollStep
  return 0
}

// ---------------------------------------------------------------- cards appearing

/**
 * The cards that materialize: all on the first board, later the new ones. A card that takes over
 * one on screen (`aliases`: its key -> the key it takes over) is not new.
 */
export function appearing(
  keys: string[],
  previous: ReadonlySet<string> | null,
  aliases: ReadonlyMap<string, string> = new Map(),
): string[] {
  if (!previous) return keys
  return keys.filter(key => {
    const was = aliases.get(key)
    return !previous.has(key) && !(was !== undefined && previous.has(was))
  })
}
