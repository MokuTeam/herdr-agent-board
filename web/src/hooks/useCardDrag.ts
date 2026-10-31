// Drag a card to another lane or column. A press becomes a drag after 6 px; a ghost of the card
// then follows the pointer 1:1 (lifted a little), the drop place lights up, the page scrolls at
// its edges, and on release the ghost lands where the card lives with the pointer's velocity.
// Or to the archive: its place comes up with the drag (components/DropArchive.tsx); let go over
// it, or flicked at it, the ghost goes into it and the archive takes the session. In the staircase
// (styles/stairs.css) the column is the step nearest the card's left edge (models/stairs.ts
// stairsPlace); a board that scrolls sideways there or beside a side panel scrolls at its edges too.
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type DropArchiveView, dropsOn } from '../models/archive-drop.ts'
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
import { sidewaysStep, stairsPlace } from '../models/stairs.ts'
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
  /** The archive as a place to drop a card on; none: no such place. */
  archive?: ArchiveDrop | undefined
}

export interface ArchiveDrop {
  /** The place's element (components/DropArchive.tsx). */
  place(): HTMLElement | null
  /** Why `key` may not go to the archive now, a text key, or '' (models/archive-drop.ts dropWhy). */
  why(key: string): string
  /** Let go on the place, and it may go: the archive takes it (its ghost went into the place). */
  onDrop(key: string): void
  /** Let go on the place, but it may not go: say why (`why`'s text key). */
  onRefused(why: string): void
}

export interface DragHandlers {
  onPointerDown(e: ReactPointerEvent<HTMLElement>, key: string): void
  /** The click that follows a drag's release is not a click (one later is). */
  justDragged(key: string): boolean
  /** The card faded in its place while dragged and while its ghost lands. */
  placeholder: string | null
  /** The lane or column lit up as the drop place. */
  lit: DropLit | null
  /** The archive's place as the drag has it; null: no drag yet. */
  archive: DropArchiveView | null
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
  /** Over the archive's place. */
  over: boolean
  /** Why it may not go to the archive, or '' (asked as the drag starts). */
  archiveWhy: string
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

/** The column heads' left edges, in the window (the staircase's steps). */
const headEdges = () =>
  [...(document.getElementById('columns-head')?.querySelectorAll<HTMLElement>('.col-head') ?? [])].map(head => ({
    id: head.dataset.col ?? '',
    left: head.getBoundingClientRect().left,
  }))

/**
 * The lane and column a dragged `card` is over, the pointer over `el` and the card's left edge at
 * `left`: the lane and column `el` is in; in the staircase (hooks/useStairs.ts) the column by its
 * steps (models/stairs.ts stairsPlace).
 */
export function dropPlaceAt(el: Element | null, card: Element, left: number): DropPlace {
  if (!document.documentElement.hasAttribute('data-stairs')) return placeAt(el)
  return stairsPlace({
    lane: el?.closest<HTMLElement>('.lane')?.dataset.cat ?? null,
    inCards: !!el?.closest('.lane-grid'),
    head: el?.closest<HTMLElement>('#columns-head .col-head')?.dataset.col ?? null,
    own: card.closest<HTMLElement>('.lane')?.dataset.cat ?? null,
    left,
    heads: headEdges(),
  })
}

/** A board that scrolls sideways (the staircase, beside a side panel): a drag near its left or right edge scrolls it that way. */
export function scrollSideways(x: number): void {
  const html = document.documentElement
  if (!html.hasAttribute('data-stairs') && !html.hasAttribute('data-panel-side')) return
  const board = document.getElementById('board')
  if (!board) return
  const r = board.getBoundingClientRect()
  const edges = { left: Math.max(0, r.left), right: Math.min(html.clientWidth, r.right) }
  const step = sidewaysStep(x, edges, { at: board.scrollLeft, max: board.scrollWidth - board.clientWidth })
  if (step) board.scrollLeft += step
}

const sameLit = (a: DropLit | null, b: DropLit | null) => a?.lane === b?.lane && a?.column === b?.column

/** Over the archive's place while it is drawn (with some slop), or, with `v`, flicked at it from close by. */
const overPlace = (place: HTMLElement | null | undefined, p: { x: number; y: number }, v?: { x: number; y: number }) =>
  !!place?.classList.contains('on') && dropsOn(place.getBoundingClientRect(), p, v)

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
  const [archive, setArchive] = useState<DropArchiveView | null>(null)
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
    setArchive(view => view && { ...view, up: false })
    setPlaceholder(key => (key === d.key ? null : key))
  }, [])

  /**
   * A card let go on the archive's place goes into it, shrinking and fading where the place is,
   * and the archive takes it as "Archive" in its menu does (the same checks, the toast with Return).
   */
  const dropInArchive = useCallback((d: Drag, ghost: Ghost, place: HTMLElement) => {
    const to = place.getBoundingClientRect()
    const from = ghost.el.getBoundingClientRect()
    const dx = to.left + to.width / 2 - (from.left + from.width / 2)
    const dy = to.top + to.height / 2 - (from.top + from.height / 2)
    // From where the drag left it, its own springs done.
    for (const s of [ghost.x, ghost.y, ghost.s]) s.stop()
    const x0 = ghost.x.value
    const y0 = ghost.y.value
    const s0 = ghost.s.value
    const gone = () => {
      ghost.el.remove()
      d.card.classList.remove('placeholder')
      setPlaceholder(key => (key === d.key ? null : key))
    }
    if (reducedMotion.matches) gone()
    else {
      const s = new Spring({
        value: 0,
        damping: 1,
        response: 0.32,
        precision: 0.002,
        onUpdate: k => {
          ghost.el.style.transform = `translate3d(${x0 + dx * k}px, ${y0 + dy * k}px, 0) scale(${s0 - (s0 - 0.12) * k})`
          ghost.el.style.opacity = String(1 - k * k)
        },
        onRest: gone,
      })
      s.to(1)
    }
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
        over: false,
        archiveWhy: '',
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
          // The archive's place comes up, saying why the session may not go there now.
          const archive = options.current.archive
          if (archive) {
            d.archiveWhy = archive.why(d.key)
            setArchive({ up: true, over: false, why: d.archiveWhy })
          }
        }
        d.ghost.x.set(ev.clientX - d.grab.x)
        d.ghost.y.set(ev.clientY - d.grab.y)
        // Over the archive's place, no lane or column is a drop place, and the page does not scroll.
        const over = overPlace(options.current.archive?.place(), { x: ev.clientX, y: ev.clientY })
        if (over !== d.over) {
          d.over = over
          setArchive(view => view && { ...view, over })
        }
        const place = dropPlaceAt(document.elementFromPoint(ev.clientX, ev.clientY), d.card, ev.clientX - d.grab.x)
        const target = over ? null : options.current.targetAt(d.key, place)
        // The column lights up when the card changes column there, else the lane when only the lane changes.
        const nextLit = dropLit(target, place)
        if (!sameLit(nextLit, d.lit)) {
          d.lit = nextLit
          setLit(nextLit)
        }
        d.target = target
        if (over) return
        const step = edgeScroll(ev.clientY, innerHeight, options.current.roomBelow?.() ?? 0)
        if (step) scrollBy(0, step)
        scrollSideways(ev.clientX)
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
        // Let go over the archive's place, or flicked at it from close by.
        const archive = options.current.archive
        const place = archive?.place()
        const over = overPlace(place, { x: ev.clientX, y: ev.clientY }, v)
        setArchive(view => view && { ...view, up: false })
        if (over && place && !d.archiveWhy) {
          dropInArchive(d, ghost, place)
          archive?.onDrop(d.key)
          return
        }
        // It may not go: it says why, and the card lands back where it lives.
        if (over) archive?.onRefused(d.archiveWhy)
        if (d.target && !over) options.current.onDrop(d.key, d.target)
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
    [options, cancel, dropInArchive],
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
    () => ({ onPointerDown, justDragged, placeholder, lit, archive }),
    [onPointerDown, justDragged, placeholder, lit, archive],
  )
}
