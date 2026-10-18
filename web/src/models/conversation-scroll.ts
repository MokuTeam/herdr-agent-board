// Where the session sheet's conversation (#sheet-body) scrolls to, as upstream's renderSheetBody
// (web/app.js): to the bottom when a session opens, and again each time the conversation is drawn
// anew while the reader is near the bottom. A render that does not draw it anew (a menu opening,
// the composer growing) leaves it where it is: a scroll then would close the menu just opened
// (components/menu/menu-engine.ts closes every menu on a scroll outside it, as upstream's does).

/** The conversation's scroll box. */
export interface ScrollBox {
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

/** Within this many pixels of the bottom, it stays at the bottom. */
const NEAR = 40

const same = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((value, i) => Object.is(value, b[i]))

export class ConversationScroll {
  private stick = true
  private drawn: readonly unknown[] | null = null

  /** A session opened (or opened again): it starts at the bottom. */
  opened(): void {
    this.stick = true
  }

  /** The reader scrolled: near the bottom it stays there. */
  scrolled(box: ScrollBox): void {
    this.stick = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR
  }

  /**
   * After a render, with what the conversation was drawn from: when any of it changed, it was
   * drawn anew, and it goes to the bottom if it was there.
   */
  rendered(box: ScrollBox | null, from: readonly unknown[]): void {
    const anew = !this.drawn || !same(this.drawn, from)
    this.drawn = from
    if (box && anew && this.stick) box.scrollTop = box.scrollHeight
  }
}
