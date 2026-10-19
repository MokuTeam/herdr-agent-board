// Reorder a list's rows by a handle: the row follows the pointer 1:1 (soft past the ends), the
// others make room with springs, and on release everything settles into the new order from where
// it is on screen (FLIP), the row with the pointer's velocity. The categories editor's lanes.
import { type RefObject, useLayoutEffect, useState } from 'react'
import { type PointerSample, rubberband, Spring, velocityOf } from '../models/spring.ts'
import { useLatest } from './useLatest.ts'

export interface ReorderOptions {
  /** A row was picked up by its handle. */
  onLift(row: HTMLElement): void
  /**
   * Let go: the rows in their new order (`to === from`: the same). The page draws them in that
   * order and then calls `flip()`, which springs every row from where it was let go.
   */
  onDrop(order: HTMLElement[], from: number, to: number): void
}

interface Drag {
  row: HTMLElement
  rows: HTMLElement[]
  rects: DOMRect[]
  from: number
  to: number
  gap: number
  sy: number
  id: number
  samples: PointerSample[]
}

/** Where the rows were on screen when let go, to spring from once they are in their new order. */
interface Landing {
  row: HTMLElement
  order: HTMLElement[]
  before: Map<HTMLElement, number>
  velocity: number
}

export interface RowReorder {
  /** A row is being dragged. */
  dragging(): boolean
  /** After the rows were drawn in the order onDrop gave: each springs from where it was let go. */
  flip(): void
  /** Listeners off, springs stopped. */
  detach(): void
}

/** The engine on `list`, whose children are the rows; a press on `handle` inside one starts a drag. */
export function rowReorder(list: HTMLElement, handle: string, options: () => ReorderOptions): RowReorder {
  const springs = new WeakMap<HTMLElement, Spring>()
  const made = new Set<Spring>()
  let drag: Drag | null = null
  let landing: Landing | null = null

  function springOf(row: HTMLElement): Spring {
    const known = springs.get(row)
    if (known) return known
    const s = new Spring({
      damping: 1,
      response: 0.3,
      precision: 0.2,
      onUpdate: v => {
        row.style.transform = v ? `translateY(${v}px)` : ''
      },
    })
    springs.set(row, s)
    made.add(s)
    return s
  }

  const rowsOf = (): HTMLElement[] => [...list.children].filter((el): el is HTMLElement => el instanceof HTMLElement)

  function down(e: PointerEvent): void {
    const grip = e.target instanceof Element ? e.target.closest<HTMLElement>(handle) : null
    if (!grip || e.button !== 0) return
    e.preventDefault()
    const rows = rowsOf()
    const row = rows.find(r => r.contains(grip))
    if (!row) return
    const rects = rows.map(r => r.getBoundingClientRect())
    const from = rows.indexOf(row)
    const [first, second] = rects
    const gap = first && second ? second.top - first.bottom : 8
    drag = {
      row,
      rows,
      rects,
      from,
      to: from,
      gap,
      sy: e.clientY,
      id: e.pointerId,
      samples: [{ x: 0, y: e.clientY, t: e.timeStamp }],
    }
    options().onLift(row)
    row.classList.add('lifted')
    grip.setPointerCapture(e.pointerId)
  }

  function move(e: PointerEvent): void {
    const d = drag
    if (!d || e.pointerId !== d.id) return
    d.samples.push({ x: 0, y: e.clientY, t: e.timeStamp })
    if (d.samples.length > 12) d.samples.shift()
    const at = d.rects[d.from]
    const firstRect = d.rects[0]
    const lastRect = d.rects.at(-1)
    if (!at || !firstRect || !lastRect) return
    const top = firstRect.top - at.top
    const bottom = lastRect.top - at.top
    let dy = e.clientY - d.sy
    if (dy < top) dy = top + rubberband(dy - top, 200)
    if (dy > bottom) dy = bottom + rubberband(dy - bottom, 200)
    springOf(d.row).set(dy)
    const center = at.top + at.height / 2 + dy
    let to = d.from
    d.rects.forEach((r, i) => {
      if (i > d.from && center > r.top + r.height / 2) to = i
      if (i < d.from && center < r.top + r.height / 2 && i < to) to = i
    })
    d.to = to
    const room = at.height + d.gap
    d.rows.forEach((r, i) => {
      if (r === d.row) return
      const shift = d.from < to && i > d.from && i <= to ? -room : to < d.from && i >= to && i < d.from ? room : 0
      if (springOf(r).target !== shift) springOf(r).to(shift)
    })
  }

  function end(e: PointerEvent): void {
    const d = drag
    if (!d || e.pointerId !== d.id) return
    const velocity = velocityOf(d.samples).y
    // Where everything is now; then the rows at rest in their new order, and from there to rest.
    const before = new Map(d.rows.map(r => [r, r.getBoundingClientRect().top]))
    for (const r of d.rows) {
      springOf(r).stop()
      r.style.transform = ''
    }
    const order = d.rows.slice()
    order.splice(d.to, 0, ...order.splice(d.from, 1))
    landing = { row: d.row, order, before, velocity }
    drag = null
    // The same order: nothing to draw anew, the rows spring back from here.
    if (d.to === d.from) flip()
    d.row.classList.remove('lifted')
    options().onDrop(order, d.from, d.to)
  }

  function flip(): void {
    const l = landing
    if (!l) return
    landing = null
    for (const r of l.order) {
      const s = springOf(r)
      s.value = (l.before.get(r) ?? 0) - r.getBoundingClientRect().top
      s.velocity = r === l.row ? l.velocity : 0
      s.onUpdate(s.value)
      s.to(0)
    }
  }

  list.addEventListener('pointerdown', down)
  list.addEventListener('pointermove', move)
  list.addEventListener('pointerup', end)
  list.addEventListener('pointercancel', end)
  return {
    dragging: () => drag !== null,
    flip,
    detach() {
      list.removeEventListener('pointerdown', down)
      list.removeEventListener('pointermove', move)
      list.removeEventListener('pointerup', end)
      list.removeEventListener('pointercancel', end)
      for (const s of made) s.stop()
    },
  }
}

export interface RowReorderState {
  /** A row is being dragged: the list keeps what it shows until it is let go. */
  dragging: boolean
}

/**
 * The engine on the list `list` (its rows' handles match `handle`). While a row is dragged the
 * list should not be drawn anew; after the drop it is drawn in the new order and flips into it.
 */
export function useRowReorder(
  list: RefObject<HTMLElement | null>,
  handle: string,
  options: ReorderOptions,
): RowReorderState {
  const latest = useLatest(options)
  const [dragging, setDragging] = useState(false)
  const [engine, setEngine] = useState<RowReorder | null>(null)

  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    const reorder = rowReorder(el, handle, () => ({
      onLift(row) {
        setDragging(true)
        latest.current.onLift(row)
      },
      onDrop(order, from, to) {
        setDragging(false)
        latest.current.onDrop(order, from, to)
      },
    }))
    setEngine(reorder)
    return () => reorder.detach()
  }, [list, handle, latest])

  // After every draw: rows let go spring from where they were into the order now drawn.
  useLayoutEffect(() => engine?.flip())
  return { dragging }
}
