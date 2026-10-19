// One context for the whole board: the live data, what the page can do with it, the page's own
// state, the toasts and the board's clock.
import {
  createContext,
  type Dispatch,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
} from 'react'
import { type LiveBoard, useBoard } from '../api/useBoard.ts'
import { useLanguage } from '../i18n/I18nProvider.tsx'
import { withEdits } from '../models/board-edits.ts'
import { type BoardAction, type BoardUi, boardUi, initialUi } from './board-ui.ts'
import { storage } from './storage.ts'
import { usePersisted } from './usePersisted.ts'

export interface Board extends LiveBoard {
  ui: BoardUi
  dispatch: Dispatch<BoardAction>
  /** A short note at the bottom of the page; errors stay longer. */
  toast(text: string, error?: boolean): void
  /** The time the page was drawn at: card ages and due alarms are against it. */
  now: number
}

export const BoardContext = createContext<Board | null>(null)

/** Ages ("5 min") and due alarms move on without new data: the page draws again this often. */
const TICK_MS = 30_000

function useTick(ms: number): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick(n => n + 1), ms)
    return () => clearInterval(timer)
  }, [ms])
  return tick
}

export function BoardProvider({ children }: { children: ReactNode }) {
  const live = useBoard()
  const [ui, dispatch] = useReducer(boardUi, storage.get, initialUi)
  const { follow } = useLanguage()
  const tick = useTick(TICK_MS)

  // Every board settles the user's moves the server now shows, before it is drawn.
  const [settled, setSettled] = useState(live.data)
  if (settled !== live.data) {
    setSettled(live.data)
    if (live.data) dispatch({ type: 'settle', items: live.data.items, launches: live.data.launches, now: Date.now() })
  }

  // Before the paint, so a board in another language does not flash in the old one.
  useLayoutEffect(() => {
    if (live.data) follow(live.data.lang)
  }, [live.data, follow])
  usePersisted('board.filter', ui.filter)
  usePersisted('board.profile', ui.profile)
  usePersisted('board.sleepers', ui.sleepers ? '1' : '0')
  usePersisted('board.viewed', JSON.stringify(ui.viewed))

  const toast = useCallback((text: string, error = false) => {
    if (text) dispatch({ type: 'toast', text, error })
  }, [])
  // Read at every draw (a new board, the connection, the page state, the tick), as the old page's
  // render() read the clock.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are when to read the clock, not what it reads
  const now = useMemo(() => Date.now(), [tick, live, ui])
  // The board as the page shows it: with its own edits (lanes reordered, reminders cancelled or switched).
  const data = useMemo(() => live.data && withEdits(live.data, ui.edits), [live.data, ui.edits])
  const value = useMemo<Board>(() => ({ ...live, data, ui, dispatch, toast, now }), [live, data, ui, toast, now])
  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>
}

export function useBoardContext(): Board {
  const value = useContext(BoardContext)
  if (!value) throw new Error('useBoardContext outside BoardProvider')
  return value
}
