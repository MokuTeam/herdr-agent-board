// A card's head gives way to its name (#324; models/card-head.ts). The steps are tried on the row
// itself, before the frame is painted: each sets the row's data-give, which styles/cards.css reads,
// and the name is measured; the fewest steps that leave it whole stay. A card whose name fits takes
// none and is drawn as before. Measured again when the row's words change (an age, a state, a
// profile), when its width does, and when the page changes its type (the look, wrapped card text,
// a font loaded late). Where nothing can be measured (no layout) the row takes no step.
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { HEAD_STEPS, type HeadStep, headFit } from '../models/card-head.ts'

/** What each step shortens, a child of the row. */
const STEP_OF: Record<HeadStep, string> = { status: 'card-status', profile: 'profile-tag', alarm: 'alarm' }

/** Whether `el`'s text runs past its box (its ellipsis shows). */
const runsOver = (el: Element): boolean => el.scrollWidth > el.clientWidth

/** Whether the name is cut: a name cut in the middle is cut where either part is. */
export function nameCut(name: Element): boolean {
  return name.classList.contains('split') ? Array.from(name.children).some(runsOver) : runsOver(name)
}

/**
 * Takes the steps `row` needs for its name to show whole (its data-give) and says whether the name
 * is cut even so. `cut`: the page's measure (a test's stand-in).
 */
export function fitHead(row: HTMLElement, cut: (name: Element) => boolean = nameCut): boolean {
  const name = row.querySelector('.name')
  if (!name) return false
  const present = HEAD_STEPS.filter(s => Array.from(row.children).some(c => c.classList.contains(STEP_OF[s])))
  return headFit(present, given => {
    give(row, given)
    return !cut(name)
  }).cut
}

function give(row: HTMLElement, given: readonly HeadStep[]) {
  const value = given.join(' ')
  if ((row.dataset.give ?? '') === value) return
  if (value) row.dataset.give = value
  else delete row.dataset.give
}

/** The page's type changed under every card: each measures again. */
const pageWatchers = new Set<() => void>()
let watchingPage = false
function watchPage() {
  if (watchingPage || typeof MutationObserver === 'undefined') return
  watchingPage = true
  const all = () => {
    for (const again of pageWatchers) again()
  }
  new MutationObserver(all).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-look', 'data-card-text'],
  })
  document.fonts?.addEventListener?.('loadingdone', all)
}

/** Fits the head in `ref` to its name; true while the name is cut even so (its tooltip names it). */
export function useHeadFit(ref: RefObject<HTMLElement | null>): boolean {
  const [cut, setCut] = useState(false)
  const seen = useRef('')
  const measure = (row: HTMLElement, force: boolean) => {
    const width = row.getBoundingClientRect().width
    // The words and the width: a render that changes neither (the board's clock) measures nothing.
    const key = `${width} ${row.childElementCount} ${row.textContent}`
    if (!width || (!force && key === seen.current)) return
    seen.current = key
    setCut(fitHead(row))
  }
  useLayoutEffect(() => {
    if (ref.current) measure(ref.current, false)
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure reads only the row and refs
  useLayoutEffect(() => {
    const row = ref.current
    if (!row || typeof ResizeObserver === 'undefined') return
    // Before the frame is painted, so a resize never shows the old steps at the new width.
    const watch = new ResizeObserver(() => flushSync(() => measure(row, false)))
    watch.observe(row)
    const again = () => measure(row, true)
    watchPage()
    pageWatchers.add(again)
    return () => {
      watch.disconnect()
      pageWatchers.delete(again)
    }
  }, [ref])
  return cut
}
