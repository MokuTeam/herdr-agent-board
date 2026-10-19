// Every change of place animates with a spring from where the card is on screen (FLIP): the
// cards are measured right before React commits (during the render, the DOM still the old one),
// and after the commit each card that moved starts from where it was, a spring in flight
// included, and springs into its new place. New cards materialize with a little scale and fade.
import { type RefObject, useLayoutEffect, useRef } from 'react'
import { appearing } from '../models/board-view.ts'
import { reducedMotion, Spring } from '../models/spring.ts'

/** The springs of a card's offset from its layout place. */
interface Motion {
  x: Spring
  y: Spring
  apply(): void
}

const NO_ALIASES: ReadonlyMap<string, string> = new Map()

/** The cards in the board by key (the drag's ghost is outside it). */
function cardsIn(root: HTMLElement): Map<string, HTMLElement> {
  const cards = new Map<string, HTMLElement>()
  for (const el of root.querySelectorAll<HTMLElement>('.card[data-key]'))
    if (el.dataset.key) cards.set(el.dataset.key, el)
  return cards
}

/** Where every card on show is on screen now; nothing with reduced motion. */
function measure(root: HTMLElement | null): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>()
  if (!root || reducedMotion.matches) return rects
  for (const [key, el] of cardsIn(root))
    if (el.isConnected && el.offsetParent) rects.set(key, el.getBoundingClientRect())
  return rects
}

function motionOf(el: HTMLElement, motions: WeakMap<HTMLElement, Motion>): Motion {
  const known = motions.get(el)
  if (known) return known
  const apply = () => {
    if (!x.moving && !y.moving && !x.value && !y.value) {
      el.style.transform = ''
      el.classList.remove('moving')
    } else el.style.transform = `translate3d(${x.value}px, ${y.value}px, 0)`
  }
  const x: Spring = new Spring({ damping: 1, response: 0.42, precision: 0.2, onUpdate: apply, onRest: apply })
  const y: Spring = new Spring({ damping: 1, response: 0.42, precision: 0.2, onUpdate: apply, onRest: apply })
  const motion = { x, y, apply }
  motions.set(el, motion)
  return motion
}

/** Cards that changed place start from where they were on screen and spring into the new one. */
function flip(cards: Map<string, HTMLElement>, first: Map<string, DOMRect>, motions: WeakMap<HTMLElement, Motion>) {
  for (const [key, before] of first) {
    const el = cards.get(key)
    if (!el?.offsetParent) continue
    const after = el.getBoundingClientRect()
    const dx = before.left - after.left
    const dy = before.top - after.top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
    const m = motionOf(el, motions)
    el.classList.add('moving')
    m.x.value += dx
    m.y.value += dy
    m.apply() // this frame already, or it would flash at its new place
    m.x.to(0)
    m.y.to(0)
  }
}

/** A new card (or schedule entry) materializes: a little scale and fade, critically damped. */
export function appear(el: HTMLElement): void {
  if (reducedMotion.matches) return
  const s = new Spring({
    value: 0,
    damping: 1,
    response: 0.35,
    precision: 0.002,
    onUpdate: v => {
      el.style.opacity = String(v)
      el.style.scale = String(0.96 + 0.04 * v)
    },
    onRest: () => {
      el.style.opacity = ''
      el.style.scale = ''
    },
  })
  s.to(1)
}

/**
 * FLIP for the cards inside `container`; `keys` are the cards rendered. `aliases` (a card's key ->
 * the key of a card it takes over on screen) keep a takeover from materializing anew. `comeBack`:
 * a new card that arrives its own way (back from the archive, out of its button) — true when it did.
 */
export function useFlip(
  container: RefObject<HTMLElement | null>,
  keys: string[],
  aliases: ReadonlyMap<string, string> = NO_ALIASES,
  comeBack?: (key: string, el: HTMLElement) => boolean,
): void {
  const motions = useRef(new WeakMap<HTMLElement, Motion>())
  const shown = useRef<ReadonlySet<string> | null>(null)
  const first = useRef(new Map<string, DOMRect>())
  // Before the commit: React has not touched the DOM yet, so this is where the cards are now.
  first.current = measure(container.current)

  useLayoutEffect(() => {
    const root = container.current
    if (!root) return
    const cards = cardsIn(root)
    flip(cards, first.current, motions.current)
    for (const key of appearing(keys, shown.current, aliases)) {
      const el = cards.get(key)
      if (el && !comeBack?.(key, el)) appear(el)
    }
    shown.current = new Set(keys)
    // React writes `class` whole when it changes: a card still in flight keeps `moving`.
    for (const el of cards.values()) {
      const m = motions.current.get(el)
      if (m && (m.x.moving || m.y.moving)) el.classList.add('moving')
    }
  })
}
