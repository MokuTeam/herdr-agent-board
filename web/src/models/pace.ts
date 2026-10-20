// The board's live signs loop for as long as their state lasts: a working card's pulse, the
// spinners, the terminal's caret, a side answer's shimmer. Left to the browser, any one of them
// has the page drawn at the display's full rate (144 frames a second on a laptop's panel), and each
// frame costs the renderer and the GPU process about the same whatever moved: the GPU busy and a
// core warm all day for a dot (#109). So the endless animations advance at PACE_FPS frames a second
// instead, like Apple's own activity indicator, which steps rather than glides: each is paused and
// set to the frame its clock is at, on one timer for the page. What the user moves (a drag, a
// spring, a transition, a card appearing) is finite and keeps the display's rate. Stopped while the
// page is hidden; with reduced motion there is nothing endless to pace (the sheets turn loops off).

export const PACE_FPS = 12
const FRAME_MS = 1000 / PACE_FPS

/** What the pace reads and sets of an animation (the Web Animations API's Animation). */
export interface Paceable {
  currentTime: CSSNumberish | null
  readonly playState: AnimationPlayState
  readonly effect: AnimationEffect | null
  pause(): void
}

/** Whether it loops for good: the live signs do, a transition or an entrance does not. */
export const endless = (a: Paceable): boolean => a.effect?.getTiming().iterations === Infinity

/** The frame a clock that started `elapsed` ms ago is at. */
export const frameAt = (elapsed: number): number => Math.floor(elapsed / FRAME_MS) * FRAME_MS

/**
 * One tick at `now` (the document timeline's time): every endless animation paused at the frame of
 * its own clock, which runs from where it was when first seen. Returns whether any was there.
 */
export function tick(animations: Iterable<Paceable>, now: number, starts: WeakMap<Paceable, number>): boolean {
  let any = false
  for (const a of animations) {
    if (!endless(a)) continue
    any = true
    let start = starts.get(a)
    if (start === undefined) {
      start = now - Number(a.currentTime ?? 0)
      starts.set(a, start)
    }
    if (a.playState !== 'paused') a.pause()
    a.currentTime = frameAt(now - start)
  }
  return any
}

/**
 * Paces the document's endless animations from now on: the timer runs while there is one and the
 * page is on show, and a CSS animation that starts wakes it. Returns what stops it all.
 */
export function startPace(doc: Document = document): () => void {
  const starts = new WeakMap<Paceable, number>()
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    clearInterval(timer)
    timer = undefined
  }
  const step = () => tick(doc.getAnimations(), Number(doc.timeline.currentTime ?? performance.now()), starts)
  const run = () => {
    if (!step()) stop()
  }
  const wake = () => {
    if (!doc.hidden && step() && !timer) timer = setInterval(run, FRAME_MS)
  }
  const visibility = () => (doc.hidden ? stop() : wake())
  doc.addEventListener('animationstart', wake)
  doc.addEventListener('visibilitychange', visibility)
  wake()
  return () => {
    stop()
    doc.removeEventListener('animationstart', wake)
    doc.removeEventListener('visibilitychange', visibility)
  }
}
