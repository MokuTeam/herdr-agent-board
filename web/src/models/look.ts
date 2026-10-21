// The board's style (Settings): Classic, the board's own, or Terminal, a terminal-style look (a
// One Dark palette, or the Omarchy theme's on a computer with Omarchy; monospace, outlines;
// styles/look-terminal.css), with the terminal board's keys (models/terminal-keys.ts). The choice is
// this browser's (board.look in localStorage) and sits on <html> as data-look, which only that
// stylesheet reads; without one the page is Classic, exactly as before, unless config.json's `look`
// makes Terminal the style a browser starts in (data-look-default, core/omarchy-theme.ts). theme.ts
// applies it before the page paints, and it goes with light, dark or the system's (models/theme.ts).

export const LOOKS = ['classic', 'terminal'] as const
export type Look = (typeof LOOKS)[number]

/** Where the choice is kept. */
export const LOOK_KEY = 'board.look'

export const isLook = (value: string): value is Look => (LOOKS as readonly string[]).includes(value)

/**
 * The style a page starts in: Terminal when this browser picked it, or picked none and the board
 * starts in it (`fallback`, data-look-default); otherwise Classic, no data-look.
 */
export const keptLook = (raw: string | null, fallback?: string): 'terminal' | null =>
  raw === 'terminal' || (raw !== 'classic' && fallback === 'terminal') ? 'terminal' : null

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
