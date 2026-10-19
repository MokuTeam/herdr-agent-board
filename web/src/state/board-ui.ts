// The page's own state across the board (the live data is in api/useBoard.ts): what is on show,
// which session is open, the usage popover, the toasts, cards the user moved, sessions busy and
// the page's edits to the board until the next one comes in; sessions on their way to the
// archive, and those back from it.
import type { ColumnId, Item, LaunchView } from '../../../src/core/types.ts'
import { type AttentionItem, recordView, type Seen } from '../models/attention.ts'
import { type BoardEdit, type BoardEdits, NO_EDITS, withEdit } from '../models/board-edits.ts'
import { NO_MOVES, type PendingMoves, settleMoves, withMove, withoutMove } from '../models/board-view.ts'
import { keepsLocal } from '../models/launch.ts'

/** A toast's button (Return, after an archive), which also closes it. */
export interface ToastAction {
  label: string
  run(): void
}

/**
 * What a toast may carry besides its text: a button, how long it stays when not the usual, and a
 * token (nextToastToken) that takes it away early ({ type: 'toastHide', token }).
 */
export interface ToastOptions {
  action?: ToastAction
  ms?: number
  token?: number
}

export interface Toast extends ToastOptions {
  id: number
  text: string
  error: boolean
  /** Asked to go before its time: it fades away now. */
  hiding?: boolean
}

let toastTokens = 0
/** A token for a toast to be taken away early. */
export const nextToastToken = (): number => ++toastTokens

/** How long a session stays off the board on this page alone, waiting for the server's board to agree. */
export const ARCHIVING_MS = 20_000
/** How long a card back from the archive is awaited, to come out of the archive's button. */
export const FLY_BACK_MS = 90_000

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
  /** key -> when: off the board at once, until the server's board has it no more (20 s at most). */
  archiving: ReadonlyMap<string, number>
  /** key (or launch:<id>) -> when: a card back from the archive comes out of its button (90 s at most). */
  flyBack: ReadonlyMap<string, number>
}

export type BoardAction =
  | { type: 'filter'; id: string }
  | { type: 'profile'; id: string }
  | { type: 'query'; text: string }
  | { type: 'toggleSleepers' }
  | { type: 'open'; key: string | null; compose?: boolean }
  | { type: 'viewed'; item: AttentionItem }
  | { type: 'limits'; open: boolean }
  | ({ type: 'toast'; text: string; error: boolean } & ToastOptions)
  | { type: 'toastGone'; id: number }
  | { type: 'toastHide'; token: number }
  | { type: 'move'; key: string; cat: string | null; column: ColumnId | null; at: number }
  | { type: 'unmove'; key: string }
  | { type: 'settle'; items: Item[]; launches?: LaunchView[]; now: number }
  | { type: 'busy'; key: string; label: string | null }
  | { type: 'edit'; edit: BoardEdit }
  | { type: 'launched'; launch: LaunchView }
  | { type: 'launchGone'; id: string }
  | { type: 'archiving'; keys: readonly string[]; at: number }
  | { type: 'unarchiving'; keys: readonly string[] }
  | { type: 'flyBack'; keys: readonly string[]; at: number }
  | { type: 'flewBack'; key: string }

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
    archiving: new Map(),
    flyBack: new Map(),
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
      const { text, error, action: button, ms, token } = action
      const toast: Toast = {
        id,
        text,
        error,
        ...(button && { action: button }),
        ...(ms && { ms }),
        ...(token !== undefined && { token }),
      }
      return { ...state, lastToast: id, toasts: [...state.toasts, toast] }
    }
    case 'toastGone':
      return { ...state, toasts: state.toasts.filter(toast => toast.id !== action.id) }
    case 'toastHide':
      return state.toasts.some(toast => toast.token === action.token && !toast.hiding)
        ? {
            ...state,
            toasts: state.toasts.map(toast => (toast.token === action.token ? { ...toast, hiding: true } : toast)),
          }
        : state
    case 'move':
      return { ...state, moves: withMove(state.moves, action.key, action) }
    case 'unmove':
      return { ...state, moves: withoutMove(state.moves, action.key) }
    case 'settle': {
      // A new board is the server's word: the page's own edits of the last one are let go, and
      // its own launches once the board has them (or they waited too long for it); a session gone
      // from the board (in the archive), or there still long after (the server said no), and a
      // card back from the archive that never came.
      const moves = settleMoves(state.moves, action.items, action.now)
      const launched = settledLaunches(state.launched, action.launches, action.now)
      const archiving = settledArchiving(state.archiving, action.items, action.now)
      const flyBack = keptSince(state.flyBack, action.now, FLY_BACK_MS)
      return moves === state.moves &&
        state.edits === NO_EDITS &&
        launched === state.launched &&
        archiving === state.archiving &&
        flyBack === state.flyBack
        ? state
        : { ...state, moves, edits: NO_EDITS, launched, archiving, flyBack }
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
    case 'archiving':
      return { ...state, archiving: withKeys(state.archiving, action.keys, action.at) }
    case 'unarchiving':
      return action.keys.some(k => state.archiving.has(k))
        ? { ...state, archiving: withoutKeys(state.archiving, action.keys) }
        : state
    case 'flyBack':
      return { ...state, flyBack: withKeys(state.flyBack, action.keys, action.at) }
    case 'flewBack':
      return state.flyBack.has(action.key) ? { ...state, flyBack: withoutKeys(state.flyBack, [action.key]) } : state
  }
}

function withKeys(map: ReadonlyMap<string, number>, keys: readonly string[], at: number): ReadonlyMap<string, number> {
  const next = new Map(map)
  for (const key of keys) next.set(key, at)
  return next
}

function withoutKeys(map: ReadonlyMap<string, number>, keys: readonly string[]): ReadonlyMap<string, number> {
  const next = new Map(map)
  for (const key of keys) next.delete(key)
  return next
}

/** The entries `ms` old at most; the same map when all are. */
function keptSince(map: ReadonlyMap<string, number>, now: number, ms: number): ReadonlyMap<string, number> {
  if (!map.size) return map
  const kept = [...map].filter(([, at]) => now - at <= ms)
  return kept.length === map.size ? map : new Map(kept)
}

/** Sessions on their way to the archive that the server's board still has, for 20 s at most. */
function settledArchiving(
  archiving: ReadonlyMap<string, number>,
  items: readonly Pick<Item, 'key'>[],
  now: number,
): ReadonlyMap<string, number> {
  if (!archiving.size) return archiving
  const keys = new Set(items.map(i => i.key))
  const kept = [...archiving].filter(([key, at]) => keys.has(key) && now - at <= ARCHIVING_MS)
  return kept.length === archiving.size ? archiving : new Map(kept)
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
