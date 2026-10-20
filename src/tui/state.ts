// What the terminal board shows and where its cursor is. Plain data: app.ts changes it, render.ts
// draws it.
import { COLUMNS } from '../core/board.ts'
import { categoryInfo, laneRank } from '../core/categories.ts'
import type { Profile } from '../core/profiles.ts'
import type { ScheduleEntry } from '../core/schedule-rules.ts'
import type { Category, ColumnId, Config, Item } from '../core/types.ts'
import type { Hit } from './input.ts'

export type Mode = 'board' | 'input' | 'category'
export type Dir = 'up' | 'down' | 'left' | 'right' | 'home'

/** A category's row of cards: one list per column, after the filter. */
export interface Lane {
  cat: string
  /** The 1-9 filter key. */
  num: number
  info: Category & { title: string }
  cols: Item[][]
}

export interface InputPrompt {
  label: string
  text: string
  submit: (text: string) => void
}

export interface Flash {
  text: string
  error: boolean
  until: number
}

export interface TuiState {
  /** The live config (updated in place when config.json changes). */
  cfg: Config
  /** The clock render() reads: the time in the header, card ages, how long a flash lasts. */
  now: number
  /** The board closes once you leave it (an overlay) or has nothing to go back to. */
  closesOnQuit: boolean
  items: Item[]
  /** The Claude profiles, shown and hidden: which tag a card shows (core/profile-tag.ts). */
  profiles: Profile[]
  /** Session key -> its soonest schedule entry. */
  alarms: Map<string, ScheduleEntry>
  scheduled: number
  lanes: Lane[]
  /** Every category on the board, in lane order (the 1-9 filter keys). */
  allCats: string[]
  /** Key of the selected item. */
  sel: string | null
  filter: string | null
  mode: Mode
  input: InputPrompt | null
  flash: Flash | null
  scroll: number
  /** Scroll the selection into view on the next render. */
  follow: boolean
  /** Body line -> clickable runs, for mouse clicks (render() fills it). */
  hits: Hit[][]
  lastClick: { key: string | null; at: number }
  loading: boolean
  loadError: string | null
  pasting: boolean
  /** Key -> short state shown on the card while an action runs. */
  busy: Map<string, string>
}

export function createState(cfg: Config, closesOnQuit: boolean): TuiState {
  return {
    cfg,
    now: Date.now(),
    closesOnQuit,
    items: [],
    profiles: [],
    alarms: new Map(),
    scheduled: 0,
    lanes: [],
    allCats: [],
    sel: null,
    filter: null,
    mode: 'board',
    input: null,
    flash: null,
    scroll: 0,
    follow: true,
    hits: [],
    lastClick: { key: null, at: 0 },
    loading: true,
    loadError: null,
    pasting: false,
    busy: new Map(),
  }
}

export function colOf(id: ColumnId): (typeof COLUMNS)[number] {
  const col = COLUMNS.find(c => c.id === id)
  if (!col) throw new Error(`no column ${id}`)
  return col
}

export const byKey = (state: TuiState, key: string | null): Item | undefined => state.items.find(i => i.key === key)

export const selected = (state: TuiState): Item | undefined => byKey(state, state.sel)

/** Visible items in reading order: lane by lane, column by column. */
export const flat = (state: TuiState): Item[] => state.lanes.flatMap(l => l.cols.flat())

/** One lane's items top to bottom, as the narrow layout lists them (by column). */
export function laneOrder(lane: Lane): Item[] {
  const order = new Map(COLUMNS.map((c, i) => [c.id, i]))
  return lane.cols.flat().sort((a, b) => (order.get(a.column) ?? 0) - (order.get(b.column) ?? 0))
}

/** Every visible item in the narrow layout's order. */
export const narrowOrder = (state: TuiState): Item[] => state.lanes.flatMap(laneOrder)

/** Groups the items into lanes (after the filter) and keeps the selection on something visible. */
export function build(state: TuiState): void {
  const { cfg, items } = state
  state.allCats = [...new Set(items.map(i => i.category))].sort(
    (a, b) => laneRank(cfg, a) - laneRank(cfg, b) || a.localeCompare(b),
  )
  if (state.filter && !state.allCats.includes(state.filter)) state.filter = null
  const filter = state.filter
  state.lanes = state.allCats
    .map(
      (cat, n): Lane => ({
        cat,
        num: n + 1,
        info: categoryInfo(cfg, cat),
        cols: COLUMNS.map(col => items.filter(i => i.category === cat && i.column === col.id)),
      }),
    )
    .filter(l => !filter || l.cat === filter)
  const visible = flat(state)
  if (!visible.some(i => i.key === state.sel)) {
    state.sel = visible[0]?.key ?? null
    state.follow = true
  }
}

/** Where the selected item sits in the wide grid. */
function positionOf(state: TuiState): { li: number; ci: number; ii: number } | null {
  for (const [li, lane] of state.lanes.entries()) {
    for (const [ci, col] of lane.cols.entries()) {
      const ii = col.findIndex(x => x.key === state.sel)
      if (ii >= 0) return { li, ci, ii }
    }
  }
  return null
}

/**
 * The card of a lane in the column nearest to `ci` (the left one first on a tie): its last one
 * going up, its first going down. So up and down reach a lane with nothing in this column.
 */
function nearestIn(lane: Lane | undefined, ci: number, last: boolean): Item | null {
  if (!lane) return null
  for (let d = 0; d < COLUMNS.length; d++) {
    for (const c of d ? [ci - d, ci + d] : [ci]) {
      const col = lane.cols[c]
      if (col?.length) return (last ? col.at(-1) : col[0]) ?? null
    }
  }
  return null
}

/** The neighbour of the selected item in the wide grid, or null at the edge. */
function neighbour(state: TuiState, dir: Exclude<Dir, 'home'>): Item | null {
  const pos = positionOf(state)
  if (!pos) return null
  const { li, ci, ii } = pos
  const { lanes } = state
  const col = lanes[li]?.cols[ci] ?? []
  let next: Item | null = null
  if (dir === 'up') {
    if (ii > 0) next = col[ii - 1] ?? null
    else for (let l = li - 1; l >= 0 && !next; l--) next = nearestIn(lanes[l], ci, true)
  } else if (dir === 'down') {
    if (ii < col.length - 1) next = col[ii + 1] ?? null
    else for (let l = li + 1; l < lanes.length && !next; l++) next = nearestIn(lanes[l], ci, false)
  } else {
    const step = dir === 'right' ? 1 : -1
    for (let c = ci + step; c >= 0 && c < COLUMNS.length && !next; c += step) {
      const other = lanes[li]?.cols[c] ?? []
      if (other.length) next = other[Math.min(ii, other.length - 1)] ?? null
    }
  }
  return next
}

/**
 * Moves the selection. The wide layout is a grid (lanes x columns); the narrow one a plain list.
 * Returns whether the screen needs redrawing.
 */
export function move(state: TuiState, dir: Dir, wide: boolean): boolean {
  if (!wide || dir === 'home') {
    const list = narrowOrder(state)
    const i = list.findIndex(x => x.key === state.sel)
    if (dir === 'home') state.sel = list[0]?.key ?? state.sel
    else if (dir === 'up' || dir === 'left') state.sel = list[Math.max(0, i - 1)]?.key ?? state.sel
    else state.sel = list[Math.min(list.length - 1, i + 1)]?.key ?? state.sel
    state.follow = true
    return true
  }
  const next = neighbour(state, dir)
  if (!next) return false
  state.sel = next.key
  state.follow = true
  return true
}
