// A card's head gives way to its name (#324; models/card-head.ts). The page's one fitter
// (hooks/head-fitter.ts) fits every card's row together, before the frame is painted: each step
// sets the row's data-give, which styles/cards.css reads, and the name is measured. A card whose
// name fits takes none and is drawn as before. Where nothing can be measured (no ResizeObserver,
// no layout) there is no fitter and the row takes no step.
import { type RefObject, useLayoutEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { HEAD_STEPS, type HeadStep } from '../models/card-head.ts'
import { createHeadFitter, type HeadEnv, type HeadFitter } from './head-fitter.ts'

/** What each step shortens, a child of the row. */
const STEP_OF: Record<HeadStep, string> = { status: 'card-status', profile: 'profile-tag', alarm: 'alarm' }

/** Less than this past its box is no cut: what layout's rounding leaves. */
const EPSILON = 0.02

/**
 * Whether `el`'s text runs past its box, to the fraction of a pixel (an ellipsis shows at any
 * overflow; scrollWidth and clientWidth are whole pixels). The text's own end against the box's:
 * what stands before it in the box (the Terminal style's "› " before an open card's name) counts.
 */
let range: Range | undefined
function runsOver(el: Element): boolean {
  range ??= document.createRange()
  range.selectNodeContents(el)
  return range.getBoundingClientRect().right - el.getBoundingClientRect().right > EPSILON
}

/** Whether the name is cut: one cut in the middle is cut where either part is. */
export function nameCut(name: Element): boolean {
  if (!name.classList.contains('split')) return runsOver(name)
  return Array.from(name.children).some(part => !part.classList.contains('sr-only') && runsOver(part))
}

const PAGE: HeadEnv<HTMLElement> = {
  // The card's classes style the name (open, a result unseen, asleep in Idle), its words fill the row.
  key: row => `${row.parentElement?.className ?? ''}\n${row.childElementCount}\n${row.textContent}`,
  present: row => HEAD_STEPS.filter(s => Array.from(row.children).some(c => c.classList.contains(STEP_OF[s]))),
  give(row, given) {
    const value = given.join(' ')
    if ((row.dataset.give ?? '') === value) return
    if (value) row.dataset.give = value
    else delete row.dataset.give
  },
  cut(row) {
    const name = row.querySelector('.name')
    return !!name && nameCut(name)
  },
  observer(resized) {
    // The content box: a transform (a card pressed, dragged) leaves it as it is.
    const watch = new ResizeObserver(entries =>
      resized(entries.map(e => ({ row: e.target as HTMLElement, width: e.contentRect.width }))),
    )
    return { observe: row => watch.observe(row), unobserve: row => watch.unobserve(row) }
  },
  flushSync,
  later: fit => queueMicrotask(fit),
}

let page: HeadFitter<HTMLElement> | null | undefined
/** The page's fitter, made with the first card; null where nothing can be measured. */
function pageFitter(): HeadFitter<HTMLElement> | null {
  if (page !== undefined) return page
  if (typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined') {
    page = null
    return page
  }
  const fitter = createHeadFitter(PAGE)
  // The look and wrapped card text change the type under every card at once.
  new MutationObserver(() => fitter.pageChanged()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-look', 'data-card-text'],
  })
  page = fitter
  return fitter
}

/**
 * Fits the head the name in `ref` stands in (its parent, the row) to that name; true while the
 * name is cut even so (its tooltip names it). `fitter`: the page's (a test's stand-in).
 */
export function useHeadFit(
  ref: RefObject<HTMLElement | null>,
  fitter: HeadFitter<HTMLElement> | null = pageFitter(),
): boolean {
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const row = ref.current?.parentElement
    if (!row || !fitter) return
    fitter.add(row, setCut)
    return () => fitter.remove(row)
  }, [ref, fitter])
  // Every render: what styles or fills the row may have changed (the fitter compares).
  useLayoutEffect(() => {
    const row = ref.current?.parentElement
    if (row) fitter?.changed(row)
  })
  return cut
}
