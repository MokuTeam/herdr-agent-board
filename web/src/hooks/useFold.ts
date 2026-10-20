// A folded card unfolding (models/fold.ts): its height springs between folded and whole from where
// it is on screen, so pointing away midway turns it back without a jump. The cards below move with
// it, or (`over`) stay where they are while it lies over them. With reduced motion it does not
// move: its hidden lines fade in and out. The card's class stays React's; the fold is `data-fold`
// (its mode while open) and inline styles.
import { type FocusEvent, type PointerEvent, type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { type FoldWants, foldFrame, HOVER_INTENT_MS, hovers, tapUnfolds, wantsOpen } from '../models/fold.ts'
import { reducedMotion } from '../models/spring.ts'
import { useSpring } from './useSpring.ts'

export interface Fold {
  onPointerEnter(e: PointerEvent<HTMLElement>): void
  onPointerLeave(e: PointerEvent<HTMLElement>): void
  onPointerDown(e: PointerEvent<HTMLElement>): void
  onFocus(e: FocusEvent<HTMLElement>): void
  /** Focus left the card and all in it. */
  onBlur(): void
  /** A first tap, which only unfolds: true when the fold took the click. */
  tookClick(): boolean
}

const FADE_MS = 160

/** The card's height with no height set on it. */
function natural(el: HTMLElement): number {
  const set = el.style.height
  el.style.height = ''
  const h = el.offsetHeight
  el.style.height = set
  return h
}

export function useFold(card: RefObject<HTMLElement | null>, on: boolean, over: boolean): Fold {
  const mode = over ? 'over' : 'push'
  const wants = useRef<FoldWants>({ hover: false, focus: false, touch: false })
  const size = useRef({ folded: 0, full: 0 })
  const hoverTimer = useRef(0)
  const tap = useRef(false)
  const fade = useRef<Animation | null>(null)
  const away = useRef<((e: Event) => void) | null>(null)
  const more = () => card.current?.querySelector<HTMLElement>(':scope > .fold-more') ?? null

  const paint = (h: number) => {
    const el = card.current
    if (!el) return
    const f = foldFrame(h, size.current.folded, size.current.full, el.dataset.fold === 'over')
    el.style.height = `${f.height}px`
    el.style.marginBottom = f.marginBottom ? `${f.marginBottom}px` : ''
    const m = more()
    if (m) m.style.opacity = String(f.opacity)
  }
  /** Folded and at rest: the card as the stylesheet draws it. */
  const flat = () => {
    const el = card.current
    if (!el) return
    delete el.dataset.fold
    el.style.height = ''
    el.style.marginBottom = ''
    const m = more()
    if (m) m.style.opacity = ''
  }
  const spring = useSpring({
    damping: 1,
    response: 0.34,
    precision: 0.5,
    onUpdate: paint,
    onRest: h => h === size.current.folded && !wantsOpen(wants.current) && flat(),
  })

  const stopListening = () => {
    if (away.current) document.removeEventListener('pointerdown', away.current, true)
    away.current = null
  }

  const update = () => {
    const el = card.current
    if (!el) return
    fade.current?.cancel()
    fade.current = null
    if (wantsOpen(wants.current)) {
      const opening = !el.dataset.fold
      if (opening) {
        size.current.folded = el.offsetHeight
        el.dataset.fold = mode
      }
      size.current.full = natural(el)
      if (opening) spring.set(size.current.folded)
      spring.to(size.current.full)
      if (opening && reducedMotion.matches)
        more()?.animate({ opacity: [0, 1] }, { duration: FADE_MS, easing: 'ease-out' })
    } else if (el.dataset.fold) {
      if (!reducedMotion.matches) {
        spring.to(size.current.folded)
        return
      }
      const out = more()?.animate({ opacity: [1, 0] }, { duration: FADE_MS, easing: 'ease-in', fill: 'forwards' })
      if (!out) return void spring.set(size.current.folded)
      fade.current = out
      out.finished.then(
        () => {
          if (fade.current !== out) return
          fade.current = null
          spring.set(size.current.folded)
          out.cancel()
        },
        () => {},
      )
    }
  }

  const want = (key: keyof FoldWants, value: boolean) => {
    if (wants.current[key] === value) return
    wants.current[key] = value
    update()
  }

  const reset = () => {
    clearTimeout(hoverTimer.current)
    stopListening()
    fade.current?.cancel()
    fade.current = null
    tap.current = false
    wants.current = { hover: false, focus: false, touch: false }
    spring.stop()
    flat()
  }

  // Each render: a card that no longer folds is drawn whole; an open one fits what it says now.
  useLayoutEffect(() => {
    const el = card.current
    if (!el) return
    // Another mode in Settings: flat at once, open the new way next time.
    if (!on || (el.dataset.fold && el.dataset.fold !== mode)) {
      if (el.dataset.fold || wantsOpen(wants.current)) reset()
      return
    }
    if (el.dataset.fold && wantsOpen(wants.current) && !fade.current) {
      size.current.full = natural(el)
      if (spring.moving) spring.to(size.current.full)
      else spring.set(size.current.full)
    }
  })
  useEffect(
    () => () => {
      clearTimeout(hoverTimer.current)
      if (away.current) document.removeEventListener('pointerdown', away.current, true)
    },
    [],
  )

  return {
    onPointerEnter(e) {
      if (!on || !hovers(e.pointerType)) return
      clearTimeout(hoverTimer.current)
      hoverTimer.current = window.setTimeout(() => want('hover', true), HOVER_INTENT_MS)
    },
    onPointerLeave(e) {
      if (!hovers(e.pointerType)) return
      clearTimeout(hoverTimer.current)
      want('hover', false)
    },
    onPointerDown(e) {
      const onControl = e.target instanceof Element && !!e.target.closest('[data-act]')
      tap.current = on && tapUnfolds({ pointerType: e.pointerType, open: wantsOpen(wants.current), onControl })
    },
    onFocus(e) {
      if (on && e.target instanceof Element && e.target.matches(':focus-visible')) want('focus', true)
    },
    onBlur() {
      want('focus', false)
    },
    tookClick() {
      if (!tap.current) return false
      tap.current = false
      // Folds again at a touch anywhere else.
      stopListening()
      away.current = ev => {
        if (ev.target instanceof Node && card.current?.contains(ev.target)) return
        stopListening()
        want('touch', false)
      }
      document.addEventListener('pointerdown', away.current, true)
      want('touch', true)
      return true
    },
  }
}
