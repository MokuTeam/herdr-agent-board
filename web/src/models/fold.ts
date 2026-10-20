// A card folded down (models/card.ts `folds`): it unfolds in place while a mouse or a pen points at
// it, while the keyboard is on it, or after a first tap on a touch screen; the next tap opens it.
// As the board's Settings say (src/core/fold-mode.ts), the cards below move apart to make room, or
// it lies over them and they stay where they are. hooks/useFold.ts moves it.

/** What keeps a folded card open; any one of them does. */
export interface FoldWants {
  hover: boolean
  focus: boolean
  touch: boolean
}

export const wantsOpen = (w: FoldWants): boolean => w.hover || w.focus || w.touch

/** Pointing at a card unfolds it after this long, so a sweep across the column leaves the cards be. */
export const HOVER_INTENT_MS = 120

/** A mouse or a pen points before it presses; a finger only touches. */
export const hovers = (pointerType: string): boolean => pointerType !== 'touch'

export interface Press {
  pointerType: string
  /** The card is open already. */
  open: boolean
  /** On one of its buttons. */
  onControl: boolean
}

/** A tap on a folded card unfolds it and opens nothing; a tap on one of its buttons acts as before. */
export const tapUnfolds = ({ pointerType, open, onControl }: Press): boolean =>
  pointerType === 'touch' && !open && !onControl

export interface FoldFrame {
  height: number
  /** Over the cards below, it gives the room back so they stay where they are; else 0. */
  marginBottom: number
  /** The hidden lines fade in as the card grows. */
  opacity: number
}

/** The card at height `h` on its way between `folded` and `full`, `over` the cards below or making room. */
export function foldFrame(h: number, folded: number, full: number, over: boolean): FoldFrame {
  const span = full - folded
  const opacity = span > 0 ? Math.min(1, Math.max(0, (h - folded) / span)) : 1
  return { height: h, marginBottom: over ? folded - h : 0, opacity }
}
