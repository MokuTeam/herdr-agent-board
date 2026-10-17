// The page's own state across the board (the live data is in api/useBoard.ts): what is on show,
// which session is open, the usage popover, the toasts, cards the user moved and sessions busy.
import type { ColumnId, Item } from '../../../src/core/types.ts'
import { type AttentionItem, recordView, type Seen } from '../models/attention.ts'
import { NO_MOVES, type PendingMoves, settleMoves, withMove, withoutMove } from '../models/board-view.ts'

export interface Toast {
  id: number
  text: string
  error: boolean
}

export interface BoardUi {
  /** The lane on show, or 'all' (kept in localStorage as board.filter). */
  filter: string
  query: string
  /** Show sessions asleep in the idle column (board.sleepers). */
  sleepers: boolean
  /** Results viewed in this browser (board.viewed). */
  viewed: Seen
  /** The key of the session in the sheet. */
  open: string | null
  /** Counts the openings: a session opened again (its card clicked) starts its sheet over. */
  opened: number
  /** The latest opening asked for the message box ("Write"). */
  compose: boolean
  limitsOpen: boolean
  toasts: Toast[]
  lastToast: number
  /** Cards the user dropped in another lane or column, until the server agrees. */
  moves: PendingMoves
  /** key -> what is happening to the session ("Waking…"). */
  busy: ReadonlyMap<string, string>
}

export type BoardAction =
  | { type: 'filter'; id: string }
  | { type: 'query'; text: string }
  | { type: 'toggleSleepers' }
  | { type: 'open'; key: string | null; compose?: boolean }
  | { type: 'viewed'; item: AttentionItem }
  | { type: 'limits'; open: boolean }
  | { type: 'toast'; text: string; error: boolean }
  | { type: 'toastGone'; id: number }
  | { type: 'move'; key: string; cat: string | null; column: ColumnId | null; at: number }
  | { type: 'unmove'; key: string }
  | { type: 'settle'; items: Item[]; now: number }
  | { type: 'busy'; key: string; label: string | null }

/** board.viewed as stored; anything else in it is dropped. */
export function parseSeen(text: string): Seen {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return {}
    return Object.fromEntries(Object.entries(value).filter(([, token]) => typeof token === 'string'))
  } catch {
    return {}
  }
}

export function initialUi(read: (key: string, fallback: string) => string): BoardUi {
  return {
    filter: read('board.filter', 'all'),
    query: '',
    sleepers: read('board.sleepers', '1') === '1',
    viewed: parseSeen(read('board.viewed', '{}')),
    open: null,
    opened: 0,
    compose: false,
    limitsOpen: false,
    toasts: [],
    lastToast: 0,
    moves: NO_MOVES,
    busy: new Map(),
  }
}

function withBusy(busy: ReadonlyMap<string, string>, key: string, label: string | null): ReadonlyMap<string, string> {
  const next = new Map(busy)
  if (label) next.set(key, label)
  else next.delete(key)
  return next
}

export function boardUi(state: BoardUi, action: BoardAction): BoardUi {
  switch (action.type) {
    case 'filter':
      return { ...state, filter: action.id }
    case 'query':
      return { ...state, query: action.text }
    case 'toggleSleepers':
      return { ...state, sleepers: !state.sleepers }
    case 'open':
      if (action.key === null) return { ...state, open: null }
      return { ...state, open: action.key, opened: state.opened + 1, compose: !!action.compose }
    case 'viewed':
      return { ...state, viewed: recordView(state.viewed, action.item) }
    case 'limits':
      return { ...state, limitsOpen: action.open }
    case 'toast': {
      const id = state.lastToast + 1
      return { ...state, lastToast: id, toasts: [...state.toasts, { id, text: action.text, error: action.error }] }
    }
    case 'toastGone':
      return { ...state, toasts: state.toasts.filter(toast => toast.id !== action.id) }
    case 'move':
      return { ...state, moves: withMove(state.moves, action.key, action) }
    case 'unmove':
      return { ...state, moves: withoutMove(state.moves, action.key) }
    case 'settle': {
      const moves = settleMoves(state.moves, action.items, action.now)
      return moves === state.moves ? state : { ...state, moves }
    }
    case 'busy':
      return { ...state, busy: withBusy(state.busy, action.key, action.label) }
  }
}
