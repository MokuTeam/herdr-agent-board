// The board's style (Settings): Classic, the board's own, or Terminal, a terminal-style look (a
// One Dark palette, monospace, outlines; styles/look-terminal.css). Appearance only. The choice is
// this browser's (board.look in localStorage) and sits on <html> as data-look, which only that
// stylesheet reads; without one the page is Classic, exactly as before. theme.ts applies it before
// the page paints, and it goes with light, dark or the system's (models/theme.ts).

export const LOOKS = ['classic', 'terminal'] as const
export type Look = (typeof LOOKS)[number]

/** Where the choice is kept. */
export const LOOK_KEY = 'board.look'

export const isLook = (value: string): value is Look => (LOOKS as readonly string[]).includes(value)

/** A kept choice that sets the page's style: Terminal; anything else is Classic, no data-look. */
export const keptLook = (raw: string | null): 'terminal' | null => (raw === 'terminal' ? raw : null)

/** What the page shows now: its data-look, else Classic. */
export const lookNow = (root: { dataset: DOMStringMap }): string => root.dataset.look ?? 'classic'

export interface LookDeps {
  root: { dataset: DOMStringMap }
  keep(look: string): void
  /** document.startViewTransition, when the browser has it and motion is not reduced. */
  transition?: ((apply: () => void) => unknown) | undefined
}

/** Settings picked `look`: kept, and the page goes over in a cross-fade, as a theme does. */
export function setLook(look: string, { root, keep, transition }: LookDeps): void {
  if (look === lookNow(root)) return
  keep(look)
  const apply = () => {
    if (look === 'classic') delete root.dataset.look
    else root.dataset.look = look
  }
  if (transition) transition(apply)
  else apply()
}
