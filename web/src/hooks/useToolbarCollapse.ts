// The two-row toolbar folds its filters away while the lanes scroll and brings them back on the way
// up (models/toolbar-collapse.ts decides). Folding the filters moves the page under the finger by
// the height they give up (a browser with scroll anchoring moves the scroll by exactly that, one
// without leaves the lanes where they were), so the position it goes by is the scroll plus what the
// filters have given up: the same either way, and a fold or an unfold never reads as the user going
// the other way. The filters' own height is what counts, not the toolbar's (a banner coming or
// going moves the page too, and is not the filters'). A filter that has the focus keeps them open.
// The scroll is read once a frame, and only a change of fold is a render: where the direction began
// is kept beside the state, not in it.
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { OPEN, openedAt, type ToolbarScroll, toolbarScroll } from '../models/toolbar-collapse.ts'

export interface ToolbarCollapse {
  collapsed: boolean
  /** Brings the filters back (a tap on the title or the filter button); they stay for a little scrolling down. */
  open(): void
}

/** The filters' height with the gap above them: what a fold gives the page. */
function taken(el: HTMLElement): number {
  return el.offsetHeight + (Number.parseFloat(getComputedStyle(el).marginTop) || 0)
}

/**
 * `filters`: the part that folds, which moves while it has `data-moving`. `enabled`: the two-row
 * toolbar; the one-row toolbar has nothing to fold.
 */
export function useToolbarCollapse(filters: RefObject<HTMLElement | null>, enabled: boolean): ToolbarCollapse {
  const [collapsed, setCollapsed] = useState(false)
  const state = useRef<ToolbarScroll>(OPEN)
  /** The filters' height whole and at rest. */
  const whole = useRef(0)

  /** How far down the page is, counting what the filters have given up. */
  const position = useCallback((): number => {
    const el = filters.current
    if (!el) return scrollY
    const height = taken(el)
    if (!state.current.collapsed && !el.hasAttribute('data-moving')) whole.current = height
    return scrollY + Math.max(0, whole.current - height)
  }, [filters])

  /** The state after the page is where it is now; a render only if the fold changed. */
  const read = useCallback(() => {
    const next = toolbarScroll(state.current, position())
    // A filter being used keeps them as they are: a folded part would take the focus with it.
    if (next.collapsed && !state.current.collapsed && filters.current?.contains(document.activeElement)) return
    const was = state.current.collapsed
    state.current = next
    if (next.collapsed !== was) setCollapsed(next.collapsed)
  }, [filters, position])

  useEffect(() => {
    if (!enabled) {
      if (state.current.collapsed) setCollapsed(false)
      state.current = OPEN
      return
    }
    let frame = 0
    const onScroll = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          read()
        })
    }
    read()
    addEventListener('scroll', onScroll, { passive: true })
    return () => {
      removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [enabled, read])

  const open = useCallback(() => {
    const was = state.current.collapsed
    state.current = openedAt(position())
    if (was) setCollapsed(false)
  }, [position])
  return { collapsed: enabled && collapsed, open }
}
