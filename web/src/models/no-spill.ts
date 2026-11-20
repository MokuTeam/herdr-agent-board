// What the toolbar tries out to measure itself (every action in one row, a folded control's segments
// at full width) is wider than the page for a moment, within one task. On a phone that moment is
// enough: the browser widens the layout viewport to take the overflow in, and near the end of the page
// the scroll is clamped to that taller viewport's end and stays there once the toolbar is back to its
// width (#474: the board jumped up about 400 px at its bottom on every fold of the toolbar). The box
// contains its paint while it measures: what spills out of it, the absolutely placed words of an
// icon button too (their containing block is the sticky toolbar, which `overflow: clip` on the box
// would leave out), adds nothing to the page's width. No size inside it changes, and the box is as it
// was after.

/** `measure` run with `box` containing its paint; its result. */
export function withoutSpill<T>(box: HTMLElement, measure: () => T): T {
  const was = box.style.contain
  box.style.contain = 'paint'
  try {
    return measure()
  } finally {
    box.style.contain = was
  }
}
