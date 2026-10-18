// How the board looks (Settings): light, dark, or as the system has it. The choice is this
// browser's (board.theme in localStorage) and sits on <html> as data-theme, which the stylesheets
// read; without one the page follows the system. theme.ts applies it before the page paints.

export const THEMES = ['auto', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

/** Where the choice is kept. */
export const THEME_KEY = 'board.theme'

/** A kept choice that sets the page's look: light or dark; anything else follows the system. */
export const keptTheme = (raw: string | null): 'light' | 'dark' | null =>
  raw === 'light' || raw === 'dark' ? raw : null

/** What the page shows now: its data-theme, else as the system has it. */
export const themeNow = (root: { dataset: DOMStringMap }): string => root.dataset.theme ?? 'auto'

export interface ThemeDeps {
  root: { dataset: DOMStringMap }
  keep(theme: string): void
  /** document.startViewTransition, when the browser has it and motion is not reduced. */
  transition?: ((apply: () => void) => unknown) | undefined
}

/** Settings picked `theme`: kept, and the page goes over in a cross-fade, not a flash from one brightness to the other. */
export function setTheme(theme: string, { root, keep, transition }: ThemeDeps): void {
  if (theme === themeNow(root)) return
  keep(theme)
  const apply = () => {
    if (theme === 'auto') delete root.dataset.theme
    else root.dataset.theme = theme
  }
  if (transition) transition(apply)
  else apply()
}
