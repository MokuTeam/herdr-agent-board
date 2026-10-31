// A swipe on the agent's display moves its picture at once (hooks/useDesktop.ts attachInput): the
// picture follows the finger here, while the wheel's steps go to the display and its frames come
// back a round trip later. Each batch of steps sent is followed by a mark (models/rfb.ts mark);
// once the server has the mark, the next big frame drawn shows those steps, and the picture is
// moved back by as far as they scroll, so it stays where the finger put it. Steps no frame shows
// in time (the page's end) are given back; so is what of the finger's way never made a step, once
// it lifts. All shown, the picture is moved by nothing: exactly the server's.

/** A batch of steps sent: how far the picture's own content moves (client px) once a frame shows it. */
interface Batch {
  id: number
  x: number
  y: number
  answered: boolean
}

export class LocalScroll {
  /** How far the picture is moved now (client px), ahead of the server's frames. */
  x = 0
  y = 0
  private batches: Batch[] = []

  /** `moved`: the picture is to be moved now (by x, y; `settle` true when it is not the finger's). */
  constructor(private readonly moved: (settle: boolean) => void) {}

  /** Nothing ahead of the server: the picture is its own. */
  get idle(): boolean {
    return !this.batches.length && !this.x && !this.y
  }

  /** The finger (or the wheel) moved the picture by (dx, dy). */
  move(dx: number, dy: number, settle = false): void {
    if (!dx && !dy) return
    this.x += dx
    this.y += dy
    this.moved(settle)
  }

  /** Steps sent, then mark `id`: shown, the picture's content has moved by (x, y) client px. */
  sent(id: number, x: number, y: number): void {
    this.batches.push({ id, x, y, answered: false })
  }

  /** The server has mark `id`: true when it is one of these. */
  answered(id: number): boolean {
    const b = this.batches.find(b => b.id === id)
    if (b) b.answered = true
    return !!b
  }

  /** The last batch the server has (answered), or null. */
  lastAnswered(): number | null {
    let id: number | null = null
    for (const b of this.batches) if (b.answered) id = b.id
    return id
  }

  /** A big frame drawn that came after the server had batch `upTo`: that and those before it moved back by as far. */
  drawn(upTo: number): void {
    this.shown(
      this.batches.findIndex(b => b.id === upTo),
      false,
    )
  }

  /** Mark `id` answered a while ago and no big frame since (the page's end): given back. */
  expire(id: number): void {
    const i = this.batches.findIndex(b => b.id === id && b.answered)
    if (i >= 0) this.shown(i, true)
  }

  /** Nothing waits any more: whatever is left goes, the picture is the server's again. */
  reset(): void {
    this.batches = []
    this.x = 0
    this.y = 0
  }

  /** The batches up to `last` shown: the picture moved back by as far. */
  private shown(last: number, settle: boolean): void {
    if (last < 0) return
    let dx = 0
    let dy = 0
    for (const b of this.batches.splice(0, last + 1)) {
      dx += b.x
      dy += b.y
    }
    this.move(dx, dy, settle)
    // nearly nothing left (a fraction of a pixel's rounding): exactly nothing
    if (!this.batches.length && Math.abs(this.x) < 0.5 && Math.abs(this.y) < 0.5 && (this.x || this.y)) {
      this.x = 0
      this.y = 0
      this.moved(settle)
    }
  }
}
