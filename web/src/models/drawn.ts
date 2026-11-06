// Whether the page is drawn (#333). A window covered by another one can stay on show to the page
// (document.hidden false, no visibilitychange) while the browser draws it no more: no animation
// frame comes, yet its timers and the board's event stream go on. Every update the page takes in
// then is kept by what waits for a frame to let go of it (a card's springs in flight, the browser's
// queue of transition events, a script that batches DOM changes for the next frame), so a page left
// covered all day grew until the browser killed its renderer. The board's stream is suspended
// while the page is not drawn, as while it is hidden (api/useBoard.ts).
//
// The watch asks for one frame at a time and looks every `everyMs` whether it came. Two looks in a
// row without it mean the page is not drawn (`undrawn`, once): one alone can be a long task that
// held the frame back. The frame that comes at last means it is drawn again (`drawn`, once). While
// not drawn, each look asks anew in place of the frame before (one asked for at a time, so none
// pile up, and a frame the browser dropped is asked for again). A page drawn as usual pays one
// frame every few seconds and nothing more.

/** How often the watch looks whether the frame it asked for came. */
export const DRAWN_EVERY_MS = 2000
/** Looks in a row without the frame before the page counts as not drawn. */
export const DRAWN_MISSES = 2

export interface DrawnOptions {
  /** The page is not drawn: no frame came over DRAWN_MISSES looks. */
  undrawn(): void
  /** It is drawn again: the frame came at last. */
  drawn(): void
  everyMs?: number
  /** requestAnimationFrame and cancelAnimationFrame. */
  frame?: (fn: () => void) => unknown
  cancel?: (id: unknown) => void
  /** setInterval and clearInterval. */
  every?: (fn: () => void, ms: number) => unknown
  stopEvery?: (id: unknown) => void
}

export interface DrawnWatch {
  /** No more looks; a frame still asked for comes to nothing. */
  stop(): void
}

export function watchDrawn({
  undrawn,
  drawn,
  everyMs = DRAWN_EVERY_MS,
  frame = fn => requestAnimationFrame(fn),
  cancel = id => cancelAnimationFrame(id as number),
  every = (fn, ms) => setInterval(fn, ms),
  stopEvery = id => clearInterval(id as ReturnType<typeof setInterval>),
}: DrawnOptions): DrawnWatch {
  let asked: unknown = null
  let misses = 0
  let away = false
  let stopped = false
  const ask = (): void => {
    if (asked !== null) cancel(asked)
    asked = frame(() => {
      asked = null
      misses = 0
      if (stopped || !away) return
      away = false
      drawn()
    })
  }
  const look = (): void => {
    if (asked === null) {
      ask()
      return
    }
    misses++
    if (away) ask()
    else if (misses >= DRAWN_MISSES) {
      away = true
      undrawn()
    }
  }
  ask()
  const id = every(look, everyMs)
  return {
    stop() {
      stopped = true
      stopEvery(id)
      if (asked !== null) cancel(asked)
      asked = null
    },
  }
}
