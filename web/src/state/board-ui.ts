// The page's own state across the board (the live data is in api/useBoard.ts): what is on show,
// which session is open, the usage popover and the toasts.
import type { Seen } from '../models/attention.ts'

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
  limitsOpen: boolean
  toasts: Toast[]
  lastToast: number
}

export type BoardAction =
  | { type: 'filter'; id: string }
  | { type: 'query'; text: string }
  | { type: 'toggleSleepers' }
  | { type: 'open'; key: string | null }
  | { type: 'limits'; open: boolean }
  | { type: 'toast'; text: string; error: boolean }
  | { type: 'toastGone'; id: number }

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
    limitsOpen: false,
    toasts: [],
    lastToast: 0,
  }
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
      return { ...state, open: action.key }
    case 'limits':
      return { ...state, limitsOpen: action.open }
    case 'toast': {
      const id = state.lastToast + 1
      return { ...state, lastToast: id, toasts: [...state.toasts, { id, text: action.text, error: action.error }] }
    }
    case 'toastGone':
      return { ...state, toasts: state.toasts.filter(toast => toast.id !== action.id) }
  }
}
