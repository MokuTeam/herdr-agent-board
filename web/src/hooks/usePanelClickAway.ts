// A click on the board beside an open panel closes it. A card switches the panel to its own
// session instead, controls keep their own job, and a press that travelled (a card drag, a text
// selection ending outside the panel) is not a click, nor is one that only put the panel's
// place menu away.
import { useEffect } from 'react'
import type { PanelPlace } from '../components/panel/place.ts'
import { outsidePanelPress, type Press, panelPress } from '../models/click-away.ts'

const KEEPS =
  '.sheet, .ql, .launch, .limits-pop, .setup-pop, .menu, .rename, .card, .lane-head, .layout-menu, button, input, textarea, select, label, a, [data-act]'

/** Listens on the window for presses beside the open panel; returns the way to stop. */
export function listenClickAway(place: PanelPlace): () => void {
  let down: Press | null = null
  // On the window, so it sees the press before the place menu's own listener on the document.
  const onDown = (e: PointerEvent) => {
    down = panelPress(e, KEEPS, place.menu.isOpen())
  }
  const onClick = (e: MouseEvent) => {
    const press = down
    down = null
    const open = place.openPanel()
    if (!open || !outsidePanelPress(press, e, KEEPS)) return
    open.close()
  }
  addEventListener('pointerdown', onDown, true)
  addEventListener('click', onClick)
  return () => {
    removeEventListener('pointerdown', onDown, true)
    removeEventListener('click', onClick)
  }
}

export function usePanelClickAway(place: PanelPlace): void {
  useEffect(() => listenClickAway(place), [place])
}
