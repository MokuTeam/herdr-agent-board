// The terminal board's keys on the web board, in its Terminal style (models/look.ts): which action a
// key press takes. The letters are the terminal board's (src/core/board-keys.ts): h j k l and the
// arrows move between cards, g / G go to the first / last, m writes to the session, w sets what it
// waits for, x clears its card, z puts it to sleep, f makes it a favorite or not, c picks its lane,
// r refreshes, q closes the panel, 1-9 show one lane and 0 all; W M O D I show one column alone
// (again: all), and Escape ends that. The board's own keys (models/board-keys.ts: / search, n the
// next card that needs you, Escape, F2, digits answering a question) come first.
import { columnKey, type LetterAction, letterAction } from '../../../src/core/board-keys.ts'
import type { Dir } from '../../../src/core/grid-nav.ts'
import type { ColumnId } from '../../../src/core/types.ts'
import type { KeyPress } from './board-keys.ts'

export interface TerminalScene {
  /** A text field has the focus. */
  typing: boolean
  /** The quick look is open: it takes its keys. */
  quickLook: boolean
  /** The focus is on the board (a card, or nothing in particular), not in a panel or the toolbar: the arrows move between cards. */
  onBoard: boolean
  /** The column shown alone, if any: Escape shows them all again. */
  column: ColumnId | null
}

export type CardAct = 'message' | 'wait' | 'clear' | 'sleep' | 'favorite' | 'category'

export type TerminalKey =
  | { kind: 'move'; dir: Dir }
  | { kind: 'card'; act: CardAct }
  | { kind: 'lane'; n: number }
  | { kind: 'column'; column: ColumnId }
  | { kind: 'allColumns' }
  | { kind: 'refresh' }
  | { kind: 'close' }

const ARROWS: Readonly<Record<string, Dir>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'last',
}

const MOVES: ReadonlySet<LetterAction> = new Set(['up', 'down', 'left', 'right', 'home', 'last'])
const CARD: ReadonlySet<LetterAction> = new Set(['message', 'wait', 'clear', 'sleep', 'favorite', 'category'])

export function terminalKey(e: KeyPress, s: TerminalScene): TerminalKey | null {
  if (s.typing || s.quickLook || e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.key === 'Escape') return s.column ? { kind: 'allColumns' } : null
  // The arrows keep scrolling a panel that has the focus; on the board they move between cards.
  const arrow = ARROWS[e.key]
  if (arrow) return s.onBoard ? { kind: 'move', dir: arrow } : null
  if (/^[0-9]$/.test(e.key)) return { kind: 'lane', n: Number(e.key) }
  const column = columnKey(e.key)
  if (column) return { kind: 'column', column }
  const action = letterAction(e.key)
  if (!action) return null
  if (MOVES.has(action)) return { kind: 'move', dir: action as Dir }
  if (CARD.has(action)) return { kind: 'card', act: action as CardAct }
  if (action === 'refresh') return { kind: 'refresh' }
  if (action === 'quit') return { kind: 'close' }
  // "o" opens this page on the terminal board, and "/" is the board's own search.
  return null
}
