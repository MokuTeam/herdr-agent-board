// What the terminal board shows and where its cursor is. Plain data: app.ts changes it, render.ts
// draws it.
import { COLUMNS } from '../core/board.ts'
import { categoryInfo, laneRank } from '../core/categories.ts'
import { type Dir, gridStep, listStep } from '../core/grid-nav.ts'
import type { Profile } from '../core/profiles.ts'
import type { ScheduleEntry } from '../core/schedule-rules.ts'
import type { Category, ColumnId, Config, Item } from '../core/types.ts'
import type { Hit } from './input.ts'

export type Mode = 'board' | 'input' | 'category'
export type { Dir }

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
  /** Each change of the text, as it is typed (the search filters as you type). */
  change?: (text: string) => void
  /** Escape: what it does besides closing the prompt. */
  cancel?: () => void
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
  /** The one column shown (W, M, O, D, I; core/board-keys.ts), or null for all. */
  column: ColumnId | null
  /** What the search (/) keeps: cards whose name, notes or lane say it. */
  query: string
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
    column: null,
    query: '',
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

/** Whether the search's text is in the card: its name, what it does, waits for, said or asks, its lane. */
export function matches(it: Item, query: string, laneTitle: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [
    it.name,
    it.autoName,
    it.doing,
    it.wait,
    it.title,
    it.lastText,
    it.prompt,
    it.question,
    it.workspace,
    laneTitle,
  ].some(v => v && String(v).toLowerCase().includes(q))
}

/** Groups the items into lanes (after the filters) and keeps the selection on something visible. */
export function build(state: TuiState): void {
  const { cfg } = state
  // The column shown alone and the search take cards off; the lanes stay those of every card.
  const items = state.items.filter(
    i =>
      (!state.column || i.column === state.column) &&
      (!state.query || matches(i, state.query, categoryInfo(cfg, i.category).title)),
  )
  state.allCats = [...new Set(state.items.map(i => i.category))].sort(
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
    .filter(l => (!filter || l.cat === filter) && (l.cols.some(c => c.length) || (!state.column && !state.query)))
  const visible = flat(state)
  if (!visible.some(i => i.key === state.sel)) {
    state.sel = visible[0]?.key ?? null
    state.follow = true
  }
}

/**
 * Moves the selection. The wide layout is a grid (lanes x columns); the narrow one a plain list.
 * Returns whether the screen needs redrawing.
 */
export function move(state: TuiState, dir: Dir, wide: boolean): boolean {
  if (!wide || dir === 'home' || dir === 'last') {
    state.sel = listStep(narrowOrder(state), state.sel, dir) ?? state.sel
    state.follow = true
    return true
  }
  const next = gridStep(state.lanes, state.sel, dir)
  if (!next) return false
  state.sel = next
  state.follow = true
  return true
}
