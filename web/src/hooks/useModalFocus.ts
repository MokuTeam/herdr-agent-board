// A dialog's share of the page's one focus stack (models/modal-focus.ts, shared with the old
// page's dialogs): open() takes the focus into `win` and keeps Tab inside the layer, with the rest
// of the page inert; close() gives the focus back to where it came from.
//
// The layer must be a direct child of <body>: every other child of <body> goes inert while it is
// on top, so a layer drawn inside #root would make #root inert, and itself with it. Draw it with
// createPortal(…, document.body), as the quick look does (components/files/QuickLook.tsx).
import { type RefObject, useEffect, useMemo } from 'react'
import { type FocusElement, type FocusScope, modalFocus } from '../models/modal-focus.ts'

type MakeScope = (layer: FocusElement, win: FocusElement) => FocusScope

/** A scope over the elements `layer()` and `win()` give at open(): a new one when they were drawn anew. */
export function scopeOfElements(
  make: MakeScope,
  layer: () => FocusElement | null,
  win: () => FocusElement | null,
): FocusScope {
  let taken: { layer: FocusElement; win: FocusElement; scope: FocusScope } | null = null
  const scope = (): FocusScope | null => {
    const l = layer()
    const w = win()
    if (!l || !w) return null
    if (taken?.layer !== l || taken.win !== w) {
      taken?.scope.close()
      taken = { layer: l, win: w, scope: make(l, w) }
    }
    return taken.scope
  }
  return {
    open: origin => scope()?.open(origin),
    close: () => taken?.scope.close(),
    isTop: () => taken?.scope.isTop() ?? false,
  }
}

/** `layer`: a direct child of <body> (a portal), never an element inside #root. */
export function useModalFocus(
  layer: RefObject<HTMLElement | null>,
  win: RefObject<HTMLElement | null> = layer,
): FocusScope {
  const scope = useMemo(
    () =>
      scopeOfElements(
        modalFocus,
        () => layer.current,
        () => win.current,
      ),
    [layer, win],
  )
  // A dialog that goes away open leaves the stack too.
  useEffect(() => () => scope.close(), [scope])
  return scope
}
