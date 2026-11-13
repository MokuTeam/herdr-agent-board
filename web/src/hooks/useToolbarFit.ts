// What the toolbar shows at the width it has (#347): one row or two, and which of its actions stay
// in the row (components/Toolbar.tsx, `.toolbar-actions`) with the rest in More. models/toolbar-fit.ts
// decides; this measures and draws.
//
// One row while the summary (a wide board's only), the filters (folded into pills) and every action fit
// side by side, else two: the actions on top, the filters under them. In two rows the actions show as many as
// their row holds, in PRIORITY order, and More the rest. The row's width does not depend on what it
// shows (the stylesheet gives it what is left of its row in two rows), so fitting it again never resizes it. The
// widths are taken once per set of actions and words, all shown within one task so nothing flickers;
// the toolbar fits again when its width changes, an action shows or hides (no calendar, no presence, a
// note appears) or a word changes (the language, a count). Both answers are attributes of ours that a
// component's own render leaves alone: `data-rows` on the toolbar's container, `data-over` on what left
// the row (and on More while nothing is left over); the stylesheet draws them (styles/toolbar.css).
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { byPriority, fitToolbar, oneRowFits, TOOLBAR_PRIORITY, type ToolbarItem } from '../models/toolbar-fit.ts'

const NONE: ReadonlySet<string> = new Set()

/** What <html> says about the page's type: its look, its card text, its theme. */
const PAGE_LOOK = ['data-look', 'data-card-text', 'data-theme']

/** The buttons that never leave the row (the gear, the live dot, the folded toolbar's filters button). */
const PINNED = ['toolbar-peek', 'settings', 'live']
const MORE = 'toolbar-more'

/** The layout's width, whatever a transform does. */
const width = (el: Element): number => Number.parseFloat(getComputedStyle(el).width) || 0

const shown = (el: Element): el is HTMLElement => el instanceof HTMLElement && !el.hidden

/** The widths of the toolbar's parts in one layout. */
interface Sizes {
  items: ToolbarItem[]
  more: number
  /** The pinned buttons and the gap before each. */
  pinned: number
}

interface Measured {
  /** What the widths go by: the actions on show and their words. */
  key: string
  /** As one row draws them, and as two rows do (Tasks is an icon with its counts there). */
  one: Sizes
  two: Sizes
}

const NONE_SIZED: Sizes = { items: [], more: 0, pinned: 0 }
const NOT_MEASURED: Measured = { key: '', one: NONE_SIZED, two: NONE_SIZED }

/** The row's actions on show in the order the page draws them: those that may leave, the pinned ones. */
function actionsIn(row: HTMLElement): { items: HTMLElement[]; pinned: HTMLElement[]; key: string } {
  const children = Array.from(row.children).filter(shown)
  const items = byPriority(children.filter(el => TOOLBAR_PRIORITY.includes(el.id)))
  const pinned = children.filter(el => PINNED.includes(el.id))
  const text = (el: HTMLElement) => `${el.id} ${(el.textContent ?? '').trim()}`
  return { items, pinned, key: [...items.map(text), '|', ...pinned.map(text)].join('\n') }
}

/** Every action whole, measured as one row and as two draw them; the container's attribute and the row's classes as they were after. */
function measure(el: Elements, now: ReturnType<typeof actionsIn>): Measured {
  const was = el.fit.hasAttribute('data-rows')
  const sized = (rows: boolean): Sizes => {
    el.fit.toggleAttribute('data-rows', rows)
    el.actions.classList.add('measuring')
    const gap = Number.parseFloat(getComputedStyle(el.actions).columnGap) || 0
    const more = el.actions.querySelector(`#${MORE}`)
    const sizes: Sizes = {
      items: now.items.map(item => ({ id: item.id, width: width(item) })),
      more: more ? width(more) : 0,
      pinned: now.pinned.reduce((sum, pin) => sum + gap + width(pin), 0),
    }
    el.actions.classList.remove('measuring')
    return sizes
  }
  const measured: Measured = { key: now.key, one: sized(false), two: sized(true) }
  el.fit.toggleAttribute('data-rows', was)
  return measured
}

export interface ToolbarShape {
  /** Two rows: the actions, then the filters. */
  rows: boolean
  /** The ids that left the row for More (two rows only). */
  over: ReadonlySet<string>
}

interface Elements {
  /** `.toolbar-fit`: the container, whose width is the toolbar's. */
  fit: HTMLElement
  /** `.toolbar-actions`. */
  actions: HTMLElement
  /** The summary (`#summary`), the only thing at the start of the row: no width while it is not shown. */
  title: HTMLElement | null
}

/** How the toolbar shows at the width it has, with the widths it went by; null while it has no width. */
export function fitToolbarIn(el: Elements, widths: Measured): { shape: ToolbarShape; widths: Measured } | null {
  const total = el.fit.clientWidth
  if (!total) return null
  const now = actionsIn(el.actions)
  const measured = now.key === widths.key ? widths : measure(el, now)
  const gap = Number.parseFloat(getComputedStyle(el.actions).columnGap) || 0
  const { one, two } = measured
  // The summary is not measured with the rest: it shows only on a wide board (a container query of app.css), so its width goes with the toolbar's, not with the actions.
  const title = el.title ? width(el.title) : 0
  const natural = one.items.reduce((sum, it, i) => sum + (i ? gap : 0) + it.width, 0) + one.pinned
  const rows = !oneRowFits(total, { title, actions: natural })
  if (!rows) return { shape: { rows, over: NONE }, widths: measured }
  // The row's own width is the two-row layout's: drawn first, then read.
  el.fit.toggleAttribute('data-rows', true)
  const fit = fitToolbar(two.items, width(el.actions), { gap, more: two.more, pinned: two.pinned })
  return { shape: { rows, over: new Set(fit.over) }, widths: measured }
}

/** `data-rows` on the container; `data-over` on what left the row, and on More while nothing is left over. */
function draw(el: Elements, { rows, over }: ToolbarShape): void {
  el.fit.toggleAttribute('data-rows', rows)
  for (const child of Array.from(el.actions.children)) {
    if (!(child instanceof HTMLElement)) continue
    if (child.id === MORE) child.toggleAttribute('data-over', over.size === 0)
    else if (TOOLBAR_PRIORITY.includes(child.id)) child.toggleAttribute('data-over', over.has(child.id))
  }
}

const same = (a: ToolbarShape, b: ToolbarShape): boolean =>
  a.rows === b.rows && a.over.size === b.over.size && [...a.over].every(id => b.over.has(id))

const ONE_ROW: ToolbarShape = { rows: false, over: NONE }

/**
 * How the toolbar shows now, fitted again as it changes. `fit`: `.toolbar-fit`; `actions`:
 * `.toolbar-actions`.
 */
export function useToolbarFit(
  fit: RefObject<HTMLElement | null>,
  actions: RefObject<HTMLElement | null>,
): ToolbarShape {
  const [shape, setShape] = useState(ONE_ROW)
  const widths = useRef(NOT_MEASURED)
  const drawn = useRef('')
  const refit = useRef<() => ToolbarShape | null>(() => null)

  const elements = (): Elements | null => {
    const container = fit.current
    const row = actions.current
    if (!container || !row) return null
    return { fit: container, actions: row, title: container.querySelector<HTMLElement>('#summary') }
  }

  // On every draw: the actions on show and their words; fitted again (and drawn before the frame
  // shows) only when one of them changed. What the page drew over them (a component rendering
  // again) is put back either way.
  useLayoutEffect(() => {
    const el = elements()
    if (!el) return
    const fitted = (): ToolbarShape | null => {
      const next = fitToolbarIn(el, widths.current)
      if (!next) return null
      widths.current = next.widths
      return next.shape
    }
    refit.current = fitted
    const now = actionsIn(el.actions).key
    if (now === drawn.current) return draw(el, shape)
    drawn.current = now
    const next = fitted()
    if (!next) return
    draw(el, next)
    setShape(was => (same(was, next) ? was : next))
  })

  // The container's width and the row's: fitted again and drawn at once, in the frame that resized them.
  // The page's look (Classic or Terminal: another typeface) or card text changes every width without a
  // word changing, so the widths are taken anew then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the elements are read when they are observed
  useLayoutEffect(() => {
    const el = elements()
    if (!el || typeof ResizeObserver !== 'function') return
    const run = () => {
      const next = refit.current()
      if (!next) return
      draw(el, next)
      flushSync(() => setShape(was => (same(was, next) ? was : next)))
    }
    const observer = new ResizeObserver(run)
    observer.observe(el.fit)
    observer.observe(el.actions)
    const look =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            widths.current = NOT_MEASURED
            run()
          })
        : null
    look?.observe(document.documentElement, { attributes: true, attributeFilter: PAGE_LOOK })
    return () => {
      observer.disconnect()
      look?.disconnect()
    }
  }, [fit, actions])

  return shape
}
