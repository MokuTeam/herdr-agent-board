// What a redraw keeps (the old page's helpers.js redraw): the focus, on what opens the same thing.
// React keeps an element it draws again, and the focus with it. Where a row changes kind or place
// it draws a new one instead: a helper that finishes turns from a running row into the strip's
// "last" line, or moves from "At work" to "Finished" in the window; "N more" goes when fewer run.
// The focus then falls to <body>, and the element that opens the same helper, run, session or list
// takes it back: the same one of several that open it, else the first.
import { type FocusEvent, useLayoutEffect, useState } from 'react'

/** What an element opens, by the attribute that says so (the first of these it has). */
const OPENERS = ['data-helper', 'data-run-open', 'data-session', 'data-helpers-all'] as const
const ANY_OPENER = OPENERS.map(name => `[${name}]`).join(', ')

/** The focused opener: where it is, the selector of what opens the same thing, which of those it is. */
interface Mark {
  root: Element
  el: Element
  same: string
  nth: number
}

function markOf(root: Element, target: unknown): Mark | null {
  const el = target instanceof Element ? target.closest(ANY_OPENER) : null
  const name = el && root.contains(el) ? OPENERS.find(n => el.hasAttribute(n)) : undefined
  if (!el || !name) return null
  const same = `[${name}="${CSS.escape(el.getAttribute(name) ?? '')}"]`
  return { root, el, same, nth: [...root.querySelectorAll(same)].indexOf(el) }
}

export interface FocusKeeper {
  /** The focus came to `target` inside `root` (React's onFocus, a focusin). */
  focused(root: Element, target: unknown): void
  /** The focus left an element inside it (onBlur). */
  blurred(): void
  /** After a draw: the focus back where it was, if the focused element went with that draw. */
  drawn(): void
}

export function focusKeeper(): FocusKeeper {
  let mark: Mark | null = null
  return {
    focused(root, target) {
      mark = markOf(root, target)
    },
    blurred() {
      const was = mark
      // Gone elsewhere, or to nothing by a click beside it: there is nothing to keep. An element a
      // draw takes away may say blur as well (Chrome does); that one comes back after the draw.
      queueMicrotask(() => {
        if (mark === was && was?.el.isConnected && !was.root.contains(document.activeElement)) mark = null
      })
    },
    drawn() {
      const m = mark
      if (!m) return
      if (m.el.isConnected) {
        // Still there: which of the same it is now (lines above it may have gone).
        m.nth = [...m.root.querySelectorAll(m.same)].indexOf(m.el)
        return
      }
      mark = null
      // The focus is somewhere the reader put it: it stays there.
      const active = document.activeElement
      if (active && active !== document.body) return
      const all = m.root.querySelectorAll<HTMLElement>(m.same)
      const next = all[m.nth] ?? all[0]
      if (!next) return
      next.focus({ preventScroll: true })
      mark = markOf(m.root, next)
    },
  }
}

/** The handlers for the element whose focus is kept. */
export interface KeepFocus {
  onFocus(e: FocusEvent<HTMLElement>): void
  onBlur(): void
}

/** The focus kept across draws inside the element these handlers go on. */
export function useKeepFocus(): KeepFocus {
  const [keeper] = useState(focusKeeper)
  const [handlers] = useState<KeepFocus>(() => ({
    onFocus: e => keeper.focused(e.currentTarget, e.target),
    onBlur: () => keeper.blurred(),
  }))
  useLayoutEffect(() => keeper.drawn())
  return handlers
}
