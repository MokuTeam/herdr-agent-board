// How a card shows text longer than its line (Settings → Card text): cut short with an ellipsis,
// the board as it always was, or wrapped, for a narrow column or a small screen: the name whole on
// as many lines as it takes, and what it does, asks, waits for and said last on up to three
// (styles/card-wrap.css). The choice is this browser's (board.cardText in localStorage) and sits
// on <html> as data-card-text, which only that stylesheet reads; without one the cards are cut
// short, exactly as before. theme.ts applies it before the page paints, in either style
// (models/look.ts) and with light, dark or the system's (models/theme.ts).

export const CARD_TEXTS = ['cut', 'wrap'] as const
export type CardText = (typeof CARD_TEXTS)[number]

/** Where the choice is kept. */
export const CARD_TEXT_KEY = 'board.cardText'

export const isCardText = (value: string): value is CardText => (CARD_TEXTS as readonly string[]).includes(value)

/** What a page starts with: wrapped when this browser picked it; otherwise cut short, no data-card-text. */
export const keptCardText = (raw: string | null): 'wrap' | null => (raw === 'wrap' ? 'wrap' : null)

/** What the page shows now: its data-card-text, else cut short. */
export const cardTextNow = (root: { dataset: DOMStringMap }): string => root.dataset.cardText ?? 'cut'

export interface CardTextDeps {
  root: { dataset: DOMStringMap }
  keep(value: string): void
  /** document.startViewTransition, when the browser has it and motion is not reduced. */
  transition?: ((apply: () => void) => unknown) | undefined
}

/** Settings picked `value`: kept, and the cards go over in a cross-fade, as a style does. */
export function setCardText(value: string, { root, keep, transition }: CardTextDeps): void {
  if (value === cardTextNow(root)) return
  keep(value)
  const apply = () => {
    if (value === 'cut') delete root.dataset.cardText
    else root.dataset.cardText = value
  }
  if (transition) transition(apply)
  else apply()
}
