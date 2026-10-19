// The side panels' shared place, for the page around them: the viewer's layout and the way to
// change it, whether a panel is open, and the room a bottom panel takes. A panel's own gestures,
// sizes and keys are its motion's (hooks/usePanel.ts, components/panel/motion.ts).
import { useContext, useMemo } from 'react'
import type { PanelPlace } from '../components/panel/place.ts'
import type { Dock, PanelLayout } from '../models/panel-layout.ts'
import { PanelContext } from '../state/PanelProvider.tsx'
import { useStore } from '../state/store.ts'

export interface PanelLayoutApi {
  /** The viewer's place for the panels (this browser's, kept in localStorage `board.panel`). */
  layout: PanelLayout
  /** A panel is open. */
  open: boolean
  /** To another place: the open panel moves there; with none open, the next one opens there. */
  dockTo(dock: Dock): void
  /** Closes the open panel (Escape, Back). */
  closeOpen(): void
  /** The height a panel at the bottom takes now: the board's visible part ends above it. */
  roomBelow(): number
  /** The place itself (`boardTop`, `openPanel()`). */
  place: PanelPlace
}

export function usePanelPlace(): PanelPlace {
  const place = useContext(PanelContext)
  if (!place) throw new Error('usePanelPlace outside PanelProvider')
  return place
}

export function usePanelLayout(): PanelLayoutApi {
  const place = usePanelPlace()
  const { layout, open } = useStore(place.state)
  return useMemo<PanelLayoutApi>(
    () => ({
      layout,
      open,
      dockTo(dock) {
        const panel = place.openPanel()
        if (panel) panel.setDock(dock)
        else if (dock !== place.layout.dock) place.setLayout({ ...place.layout, dock }, true)
      },
      closeOpen: () => place.openPanel()?.close(),
      roomBelow: () => place.roomBelow(),
      place,
    }),
    [place, layout, open],
  )
}
