// Drag a card to another lane or column. A press becomes a drag after 6 px; a ghost of the card
// then follows the pointer 1:1 (lifted a little), the drop place lights up, the page scrolls at
// its edges, and on release the ghost lands where the card lives with the pointer's velocity.
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  DRAG,
  type DropLit,
  type DropPlace,
  type DropTarget,
  dragAfterDraw,
  dragStarted,
  dropLit,
  edgeScroll,
  mayDrag,
} from '../models/board-view.ts'
import { type PointerSample, reducedMotion, Spring, velocityOf } from '../models/spring.ts'
import { useLatest } from './useLatest.ts'

export interface DragOptions {
  /** The board can edit (it is connected). */
  canEdit(): boolean
  /** The card is a session on the board (a launch's card does not move). */
  known(key: string): boolean
  /** What dropping `key` at `place` changes; null: nothing. */
  targetAt(key: string, place: DropPlace): DropTarget | null
  onDrop(key: string, target: DropTarget): void
  /** The height of a panel docked at the bottom: the page scrolls above it. */
  roomBelow?: (() => number) | undefined
}

export interface DragHandlers {
  onPointerDown(e: ReactPointerEvent<HTMLElement>, key: string): void
  /** The click that follows a drag's release is not a click (one later is). */
  justDragged(key: string): boolean
  /** The card faded in its place while dragged and while its ghost lands. */
  placeholder: string | null
  /** The lane or column lit up as the drop place. */
  lit: DropLit | null
}

interface Ghost {
  el: HTMLElement
  x: Spring
  y: Spring
  s: Spring
}

interface Drag {
  card: HTMLElement
  key: string
  id: number
  start: { x: number; y: number }
  /** Where it was grabbed, kept for the whole drag. */
  grab: { x: number; y: number }
  rect: DOMRect
  samples: PointerSample[]
  ghost: Ghost | null
  target: DropTarget | null
  lit: DropLit | null
  /** Listens on `card` (the pointer is captured there) and makes it the drag's card. */
  attach(card: HTMLElement): void
  release(): void
}

/** The lane and column under the pointer. */
function placeAt(el: Element | null): DropPlace {
  const lane = el?.closest<HTMLElement>('.lane')
  const col = el?.closest<HTMLElement>('.col')
  return { lane: lane?.dataset.cat ?? null, column: col?.dataset.col ?? null }
}

const sameLit = (a: DropLit | null, b: DropLit | null) => a?.lane === b?.lane && a?.column === b?.column

/** The card of `key` in the page (not a ghost), when there is one. */
const cardElement = (key: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('.card[data-key]')].find(
    el => el.dataset.key === key && !el.classList.contains('ghost'),
  )

/** The ghost: a copy of the card on top of everything, springs for its place and its lift. */
function lift(d: Drag): Ghost | null {
  const el = d.card.cloneNode(true)
  if (!(el instanceof HTMLElement)) return null
  el.classList.remove('selected', 'moving')
  el.classList.add('ghost')
  el.style.width = `${d.rect.width}px`
  el.style.transformOrigin = `${d.grab.x}px ${d.grab.y}px`
  el.style.transform = ''
  document.body.append(el)
  const apply = () => {
    el.style.transform = `translate3d(${x.value}px, ${y.value}px, 0) scale(${s.value})`
  }
  const x: Spring = new Spring({ value: d.rect.left, damping: 0.8, response: 0.35, precision: 0.3, onUpdate: apply })
  const y: Spring = new Spring({ value: d.rect.top, damping: 0.8, response: 0.35, precision: 0.3, onUpdate: apply })
  const s: Spring = new Spring({ value: 1, damping: 0.75, response: 0.28, precision: 0.001, onUpdate: apply })
  s.to(1.035)
  apply()
  return { el, x, y, s }
}

export function useCardDrag(opts: DragOptions): DragHandlers {
  const options = useLatest(opts)
  const [placeholder, setPlaceholder] = useState<string | null>(null)
  const [lit, setLit] = useState<DropLit | null>(null)
  const current = useRef<Drag | null>(null)
  const dragged = useRef<{ key: string; at: number } | null>(null)

  /** The drag ends without a drop: no listener, ghost, light or faded card stays behind. */
  const cancel = useCallback((d: Drag) => {
    if (current.current === d) current.current = null
    d.release()
    if (d.ghost) {
      for (const spring of [d.ghost.x, d.ghost.y, d.ghost.s]) spring.stop()
      d.ghost.el.remove()
    }
    d.card.classList.remove('placeholder')
    document.body.classList.remove('dragging')
    setLit(null)
    setPlaceholder(key => (key === d.key ? null : key))
  }, [])

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, key: string) => {
      const onControl = e.target instanceof Element && !!e.target.closest('[data-act], [data-launch]')
      const { canEdit, known } = options.current
      const start = { canEdit: canEdit(), pointerType: e.pointerType, button: e.button, onControl, known: known(key) }
      if (!mayDrag(start)) return
      // A drag that never saw its release (a pointer lost elsewhere) ends here, without a drop.
      if (current.current) cancel(current.current)
      const card = e.currentTarget
      const rect = card.getBoundingClientRect()
      const d: Drag = {
        card,
        key,
        id: e.pointerId,
        start: { x: e.clientX, y: e.clientY },
        grab: { x: e.clientX - rect.left, y: e.clientY - rect.top },
        rect,
        samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }],
        ghost: null,
        target: null,
        lit: null,
        attach: () => {},
        release: () => {},
      }

      const move = (ev: PointerEvent) => {
        if (current.current !== d || ev.pointerId !== d.id) return
        d.samples.push({ x: ev.clientX, y: ev.clientY, t: ev.timeStamp })
        if (d.samples.length > DRAG.samples) d.samples.shift()
        if (!d.ghost) {
          if (!dragStarted(d.start, { x: ev.clientX, y: ev.clientY })) return
          d.ghost = lift(d)
          if (!d.ghost) return
          d.card.classList.add('placeholder') // now, not at the next render
          setPlaceholder(d.key)
          document.body.classList.add('dragging')
        }
        d.ghost.x.set(ev.clientX - d.grab.x)
        d.ghost.y.set(ev.clientY - d.grab.y)
        const place = placeAt(document.elementFromPoint(ev.clientX, ev.clientY))
        const target = options.current.targetAt(d.key, place)
        // The column lights up when the card changes column there, else the lane when only the lane changes.
        const nextLit = dropLit(target, place)
        if (!sameLit(nextLit, d.lit)) {
          d.lit = nextLit
          setLit(nextLit)
        }
        d.target = target
        const step = edgeScroll(ev.clientY, innerHeight, options.current.roomBelow?.() ?? 0)
        if (step) scrollBy(0, step)
      }

      const end = (ev: PointerEvent) => {
        if (current.current !== d || ev.pointerId !== d.id) return
        current.current = null
        d.release()
        const ghost = d.ghost
        if (!ghost) return // a plain click; the card's click opens the sheet
        dragged.current = { key: d.key, at: performance.now() }
        const v = velocityOf(d.samples)
        setLit(null)
        document.body.classList.remove('dragging')
        if (d.target) options.current.onDrop(d.key, d.target)
        // Land where the card is on screen, carrying the release velocity into the spring. React
        // draws the drop after this handler, so this is where the card was when let go.
        const r = d.card.getBoundingClientRect()
        let resting = 0
        const landed = () => {
          if (++resting < 3) return
          ghost.el.remove()
          d.card.classList.remove('placeholder')
          setPlaceholder(key => (key === d.key ? null : key))
        }
        ghost.x.onRest = ghost.y.onRest = ghost.s.onRest = landed
        ghost.x.to(r.left, { velocity: v.x })
        ghost.y.to(r.top, { velocity: v.y })
        ghost.s.to(1, { damping: 1, response: 0.3 })
        if (reducedMotion.matches) {
          ghost.el.remove()
          d.card.classList.remove('placeholder')
          setPlaceholder(key => (key === d.key ? null : key))
        }
      }

      // The pointer taken away from the card (not by its release, nor taken back after a draw):
      // the drag ends, no drop.
      const lost = () => {
        if (current.current === d && !d.card.hasPointerCapture(d.id)) cancel(d)
      }

      d.attach = (el: HTMLElement) => {
        d.release()
        d.card = el
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', end)
        el.addEventListener('pointercancel', end)
        el.addEventListener('lostpointercapture', lost)
        d.release = () => {
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', end)
          el.removeEventListener('pointercancel', end)
          el.removeEventListener('lostpointercapture', lost)
        }
      }
      current.current = d
      card.setPointerCapture(e.pointerId)
      d.attach(card)
    },
    [options, cancel],
  )

  // After every draw of the board: a session that left mid-drag ends the drag; a card React drew
  // anew (another column) takes the drag over. Moving or replacing the card's node drops the
  // pointer capture (the old page lost its drag then): it is taken back before the next event.
  useLayoutEffect(() => {
    const d = current.current
    if (!d) return
    const next = d.card.isConnected ? d.card : cardElement(d.key)
    const fate = dragAfterDraw({ known: options.current.known(d.key), connected: d.card.isConnected, redrawn: !!next })
    if (fate === 'cancel' || !next) {
      cancel(d)
      return
    }
    if (fate === 'follow') d.attach(next)
    try {
      if (!next.hasPointerCapture(d.id)) next.setPointerCapture(d.id)
    } catch {
      cancel(d) // the pointer is up already: its release went to a card that is gone
    }
  })

  // The board going away mid-drag: no listener or ghost stays behind.
  useEffect(
    () => () => {
      if (current.current) cancel(current.current)
    },
    [cancel],
  )

  const justDragged = useCallback(
    (key: string) => dragged.current?.key === key && performance.now() - dragged.current.at < DRAG.clickAfterMs,
    [],
  )

  return useMemo(
    () => ({ onPointerDown, justDragged, placeholder, lit }),
    [onPointerDown, justDragged, placeholder, lit],
  )
}
