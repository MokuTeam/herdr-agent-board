// The one place the side panels share (components/panel/place.ts), for every panel under it: the
// viewer's layout, the room the board makes, the dock preview and the place menu (both drawn in
// <body>, as before), and a press on the board beside an open panel closing it.
import { createContext, type ReactNode, useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { DockPreview } from '../components/panel/DockPreview.tsx'
import { LayoutMenu } from '../components/panel/LayoutMenu.tsx'
import { PanelPlace } from '../components/panel/place.ts'
import { usePanelClickAway } from '../hooks/usePanelClickAway.ts'
import type { Viewport } from '../models/panel-layout.ts'

export const PanelContext = createContext<PanelPlace | null>(null)

export interface PanelProviderProps {
  children: ReactNode
  /** The window's size (tests hand one in; the page measures <html>). */
  viewport?: () => Viewport
}

export function PanelProvider({ children, viewport }: PanelProviderProps) {
  const [place] = useState(() => new PanelPlace(viewport))
  // The menu and the preview go in <body>, after the page's first draw (no portals on a server).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  useLayoutEffect(() => place.attach(), [place])
  usePanelClickAway(place)
  return (
    <PanelContext.Provider value={place}>
      {children}
      {mounted &&
        createPortal(
          <>
            <DockPreview place={place} />
            <LayoutMenu place={place} />
          </>,
          document.body,
        )}
    </PanelContext.Provider>
  )
}
