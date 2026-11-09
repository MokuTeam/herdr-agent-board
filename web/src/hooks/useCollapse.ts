// A part of the sheet folding up and opening again, on the board's own spring (#345): the head's
// fold, the helpers' strip, the action row, the open question's text. The part carries `data-folded`
// while it is folded (React's, so the first paint and the markup say it); the stylesheet gives the
// folded and the open state their sizes (styles/sheet-compact.css). On a change the hook takes both
// sizes as the stylesheet draws them and springs between them from where the part is on screen, so a
// second tap midway turns it back with its speed, no jump; `data-moving` and inline sizes are its
// own while it moves, and nothing is left on the part at rest. With reduced motion the part does
// not move: what folds fades out, and what opens fades in.
import { type RefObject, useLayoutEffect, useRef } from 'react'
import { collapseFrame, SIZE_PROPS, type Sizes } from '../models/collapse.ts'
import { reducedMotion } from '../models/spring.ts'
import { useSpring } from './useSpring.ts'

export interface CollapseOptions {
  /** The content rises this many pixels as it folds, and comes back down as it opens. */
  rise?: number
  /** What is not in the folded state fades with it (false: the text of a question, cut to two lines). */
  fade?: boolean
}

interface Ends {
  folded: Sizes
  open: Sizes
}

const FADE_MS = 160

function sizesOf(el: HTMLElement): Sizes {
  const style = getComputedStyle(el)
  const px = (value: string) => Number.parseFloat(value) || 0
  return {
    height: px(style.height),
    paddingTop: px(style.paddingTop),
    paddingBottom: px(style.paddingBottom),
    marginTop: px(style.marginTop),
    marginBottom: px(style.marginBottom),
  }
}

/** The part as the stylesheet draws it at rest: nothing of the hook's on it. */
function clear(el: HTMLElement): void {
  el.removeAttribute('data-moving')
  for (const prop of SIZE_PROPS) el.style[prop] = ''
  el.style.opacity = ''
  el.style.visibility = ''
  const inner = el.firstElementChild
  if (inner instanceof HTMLElement) inner.style.transform = ''
}

/** Both states' sizes, as the stylesheet draws them (the attribute is flipped for a moment to read the other). */
function measure(el: HTMLElement, folded: boolean): Ends {
  clear(el)
  const here = sizesOf(el)
  const was = el.hasAttribute('data-folded')
  if (was) el.removeAttribute('data-folded')
  else el.setAttribute('data-folded', '')
  const there = sizesOf(el)
  if (was) el.setAttribute('data-folded', '')
  else el.removeAttribute('data-folded')
  return folded ? { folded: here, open: there } : { folded: there, open: here }
}

export function useCollapse(box: RefObject<HTMLElement | null>, folded: boolean, options: CollapseOptions = {}): void {
  const { rise = 0, fade = true } = options
  const ends = useRef<Ends | null>(null)
  const last = useRef(folded)
  const fading = useRef<Animation | null>(null)

  const spring = useSpring({
    value: folded ? 0 : 1,
    damping: 1,
    response: 0.28,
    precision: 0.002,
    onUpdate(progress) {
      const el = box.current
      const at = ends.current
      if (!el || !at) return
      const frame = collapseFrame(progress, at.folded, at.open, rise, fade)
      el.dataset.moving = ''
      for (const prop of SIZE_PROPS) el.style[prop] = `${frame[prop]}px`
      if (fade) el.style.opacity = String(frame.opacity)
      el.style.visibility = 'visible'
      const inner = el.firstElementChild
      if (rise && inner instanceof HTMLElement)
        inner.style.transform = frame.shift ? `translateY(${frame.shift}px)` : ''
    },
    onRest() {
      if (box.current) clear(box.current)
    },
  })

  // A change of state after the first draw is the motion; the first draw is the stylesheet's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the part is read when the state changes; its element is not a reason to move
  useLayoutEffect(() => {
    if (last.current === folded) return
    last.current = folded
    const el = box.current
    fading.current?.cancel()
    fading.current = null
    const target = folded ? 0 : 1
    if (!el) return
    if (reducedMotion.matches) {
      spring.stop()
      spring.value = spring.target = target
      spring.velocity = 0
      clear(el)
      if (typeof el.animate !== 'function') return
      // What opens fades in; so does the new text of a question, cut or whole (it has no opacity of its own to fold).
      if (!folded || !fade) return void el.animate({ opacity: [0, 1] }, { duration: FADE_MS, easing: 'ease-out' })
      // Folding: it stays as it was while it fades, then the folded state is drawn.
      el.dataset.moving = ''
      const out = el.animate({ opacity: [1, 0] }, { duration: FADE_MS, easing: 'ease-in', fill: 'forwards' })
      fading.current = out
      out.finished.then(
        () => {
          if (fading.current !== out) return
          fading.current = null
          clear(el)
          out.cancel()
        },
        () => {},
      )
      return
    }
    ends.current = measure(el, folded)
    spring.onUpdate(spring.value)
    spring.to(target)
  }, [folded, fade, spring])
}
