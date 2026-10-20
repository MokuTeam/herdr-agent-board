// The session panel's row of actions without a page: how many of its buttons a width holds.
// The DOM side (measuring the buttons, hiding the rest, the More menu) is in hooks/useActionRow.ts.

/** One button's width with its words and as an icon. */
export interface RowButton {
  words: number
  icon: number
}

export interface RowFit {
  /** The buttons show their words (else icons, the first keeping its words). */
  words: boolean
  /** How many show, from the front; More has the rest. */
  shown: number
}

export interface RowOptions {
  gap?: number
  more?: number
  wordsFor?: number
  /** More shows however many fit: it holds a button the row never shows (the terminal on a phone). */
  moreAlways?: boolean
  /** As icons, the first keeps its words (Focus does; a row without it has none that does). */
  firstWords?: boolean
}

/**
 * How a row `room` px wide shows `buttons`, given in priority order as { words, icon }: each
 * one's width with its words and as an icon. With words while at least `wordsFor` of them fit
 * so (all of them, when there are fewer), else as icons, the first keeping its words either
 * way. As many as fit from the front, then More (`more` px) for the rest; no More when all fit,
 * unless `moreAlways`.
 * The first always shows, shrinking if it must. → { words, shown }
 */
export function fitRow(
  buttons: readonly RowButton[],
  room: number,
  { gap = 6, more = 30, wordsFor = 4, moreAlways = false, firstWords = true }: RowOptions = {},
): RowFit {
  if (!buttons.length) return { words: true, shown: 0 }
  const fits = (widths: readonly number[]): number => {
    let used = 0
    for (let i = 0; i < widths.length; i++) {
      used += (i ? gap : 0) + (widths[i] ?? 0)
      if (used + (i < widths.length - 1 || moreAlways ? gap + more : 0) > room) return i
    }
    return widths.length
  }
  const words = fits(buttons.map(b => b.words))
  if (words >= Math.min(wordsFor, buttons.length)) return { words: true, shown: Math.max(1, words) }
  return { words: false, shown: Math.max(1, fits(buttons.map((b, i) => (i || !firstWords ? b.icon : b.words)))) }
}
