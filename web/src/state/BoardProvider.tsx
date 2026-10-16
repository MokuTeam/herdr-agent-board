// One context for the whole board: the live data, what the page can do with it, the page's own
// state and the toasts.
import {
  createContext,
  type Dispatch,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useReducer,
} from 'react'
import { type LiveBoard, useBoard } from '../api/useBoard.ts'
import { useLanguage } from '../i18n/I18nProvider.tsx'
import { type BoardAction, type BoardUi, boardUi, initialUi } from './board-ui.ts'
import { storage } from './storage.ts'
import { usePersisted } from './usePersisted.ts'

export interface Board extends LiveBoard {
  ui: BoardUi
  dispatch: Dispatch<BoardAction>
  /** A short note at the bottom of the page; errors stay longer. */
  toast(text: string, error?: boolean): void
}

export const BoardContext = createContext<Board | null>(null)

export function BoardProvider({ children }: { children: ReactNode }) {
  const live = useBoard()
  const [ui, dispatch] = useReducer(boardUi, storage.get, initialUi)
  const { follow } = useLanguage()

  // Before the paint, so a board in another language does not flash in the old one.
  useLayoutEffect(() => {
    if (live.data) follow(live.data.lang)
  }, [live.data, follow])
  usePersisted('board.filter', ui.filter)
  usePersisted('board.sleepers', ui.sleepers ? '1' : '0')
  usePersisted('board.viewed', JSON.stringify(ui.viewed))

  const toast = useCallback((text: string, error = false) => {
    if (text) dispatch({ type: 'toast', text, error })
  }, [])
  const value = useMemo<Board>(() => ({ ...live, ui, dispatch, toast }), [live, ui, toast])
  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>
}

export function useBoardContext(): Board {
  const value = useContext(BoardContext)
  if (!value) throw new Error('useBoardContext outside BoardProvider')
  return value
}
