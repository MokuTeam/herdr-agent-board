// The page's own state across the board (the live data is in api/useBoard.ts): what is on show,
// which session is open, the usage popover, the toasts, cards the user moved, sessions busy and
// the page's edits to the board until the next one comes in.
import type { ColumnId, Item, LaunchView } from '../../../src/core/types.ts'
import { type AttentionItem, recordView, type Seen } from '../models/attention.ts'
import { type BoardEdit, type BoardEdits, NO_EDITS, withEdit } from '../models/board-edits.ts'
import { NO_MOVES, type PendingMoves, settleMoves, withMove, withoutMove } from '../models/board-view.ts'
import { keepsLocal } from '../models/launch.ts'

export interface Toast {
  id: number
  text: string
  error: boolean
}

export interface BoardUi {
  /** The lane on show, or 'all' (kept in localStorage as board.filter). */
  filter: string
  /**
   * The profile switch's pick: 'all' or a profile's id (kept in localStorage as board.profile).
   * One hidden or gone since reads as 'all' (models/profiles.ts pickedProfile).
   */
  profile: string
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
  /** Lanes reordered, reminders cancelled or switched: on the board shown until the next board. */
  edits: BoardEdits
  /** Sessions this page started, until the server's board shows them (15 s at most). */
  launched: readonly LaunchView[]
}

export type BoardAction =
  | { type: 'filter'; id: string }
  | { type: 'profile'; id: string }
  | { type: 'query'; text: string }
  | { type: 'toggleSleepers' }
  | { type: 'open'; key: string | null; compose?: boolean }
  | { type: 'viewed'; item: AttentionItem }
  | { type: 'limits'; open: boolean }
  | { type: 'toast'; text: string; error: boolean }
  | { type: 'toastGone'; id: number }
  | { type: 'move'; key: string; cat: string | null; column: ColumnId | null; at: number }
  | { type: 'unmove'; key: string }
  | { type: 'settle'; items: Item[]; launches?: LaunchView[]; now: number }
  | { type: 'busy'; key: string; label: string | null }
  | { type: 'edit'; edit: BoardEdit }
  | { type: 'launched'; launch: LaunchView }
  | { type: 'launchGone'; id: string }

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
    profile: read('board.profile', 'all'),
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
    edits: NO_EDITS,
    launched: [],
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
    case 'profile':
      return { ...state, profile: action.id }
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
      // A new board is the server's word: the page's own edits of the last one are let go, and
      // its own launches once the board has them (or they waited too long for it).
      const moves = settleMoves(state.moves, action.items, action.now)
      const launched = settledLaunches(state.launched, action.launches, action.now)
      return moves === state.moves && state.edits === NO_EDITS && launched === state.launched
        ? state
        : { ...state, moves, edits: NO_EDITS, launched }
    }
    case 'busy':
      return { ...state, busy: withBusy(state.busy, action.key, action.label) }
    case 'edit':
      return { ...state, edits: withEdit(state.edits, action.edit) }
    case 'launched':
      return { ...state, launched: [...state.launched.filter(l => l.id !== action.launch.id), action.launch] }
    case 'launchGone':
      return state.launched.some(l => l.id === action.id)
        ? { ...state, launched: state.launched.filter(l => l.id !== action.id) }
        : state
  }
}

function settledLaunches(
  launched: readonly LaunchView[],
  server: LaunchView[] | undefined,
  now: number,
): readonly LaunchView[] {
  if (!server || !launched.length) return launched
  const kept = launched.filter(l => keepsLocal(l, server, now))
  return kept.length === launched.length ? launched : kept
}
