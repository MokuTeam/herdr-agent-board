// The session panel's row of actions without a page: how many of its buttons a width holds.
// The DOM side (measuring the buttons, hiding the rest, the More menu) is in app.js.

/**
 * How a row `room` px wide shows `buttons`, given in priority order as { words, icon }: each
 * one's width with its words and as an icon. With words while at least `wordsFor` of them fit
 * so (all of them, when there are fewer), else as icons, the first keeping its words either
 * way. As many as fit from the front, then More (`more` px) for the rest; no More when all fit.
 * The first always shows, shrinking if it must. → { words, shown }
 */
export function fitRow(buttons, room, { gap = 6, more = 30, wordsFor = 4 } = {}) {
  if (!buttons.length) return { words: true, shown: 0 }
  const fits = widths => {
    let used = 0
    for (let i = 0; i < widths.length; i++) {
      used += (i ? gap : 0) + widths[i]
      if (used + (i < widths.length - 1 ? gap + more : 0) > room) return i
    }
    return widths.length
  }
  const words = fits(buttons.map(b => b.words))
  if (words >= Math.min(wordsFor, buttons.length)) return { words: true, shown: Math.max(1, words) }
  return { words: false, shown: Math.max(1, fits(buttons.map((b, i) => (i ? b.icon : b.words)))) }
}
