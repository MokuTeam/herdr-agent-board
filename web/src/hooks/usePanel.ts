// One side panel's motion (components/panel/motion.ts) for the component that draws it: the
// element to take, what to draw (shown, handles, the place menu up), and its buttons. `open` asks
// for the panel; `onClose` hears when it closed itself or gave way to another panel; `about` is
// the element it is about (the session's card), kept in its place on screen while the board
// makes room. Both are read when the panel moves, from the latest render.
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { PanelMotion } from '../components/panel/motion.ts'
import type { PanelChrome } from '../models/panel-motion.ts'
import { useStore } from '../state/store.ts'
import { useLatest } from './useLatest.ts'
import { usePanelPlace } from './usePanelLayout.ts'

export interface PanelOptions {
  open: boolean
  onClose(): void
  about?: (() => Element | null) | undefined
}

export interface PanelControls {
  ref: RefObject<HTMLElement | null>
  shown: boolean
  chrome: PanelChrome
  /** Docked at a side, it lies over the board. */
  over: boolean
  /** The place menu is up from this panel's button. */
  menuOpen: boolean
  togglePlaceMenu(button: HTMLElement): void
  close(): void
}

export function usePanel({ open, onClose, about }: PanelOptions): PanelControls {
  const place = usePanelPlace()
  // Updated in this component's layout effects, before the one below that opens or closes it.
  const latest = useLatest({ onClose, about })
  const [motion] = useState(() => {
    const m = new PanelMotion(place)
    m.onClose = () => latest.current.onClose()
    m.about = () => latest.current.about?.() ?? null
    return m
  })
  const { shown, chrome, over } = useStore(motion.state)
  const { menu } = useStore(place.state)
  const ref = useRef<HTMLElement>(null)

  useLayoutEffect(() => (ref.current ? motion.attach(ref.current) : undefined), [motion])
  // After the element is taken: a panel asked open comes in, one asked closed goes.
  useLayoutEffect(() => {
    if (open) motion.open()
    else motion.close()
  }, [open, motion])

  const [controls] = useState(() => ({
    togglePlaceMenu: (button: HTMLElement) => place.menu.toggle(motion, button),
    close: () => motion.close(),
  }))
  return { ref, shown, chrome, over, menuOpen: menu.expanded === motion, ...controls }
}
