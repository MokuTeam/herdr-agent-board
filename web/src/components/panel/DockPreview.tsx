// Where a panel let go now would dock (dock-preview.ts moves it; `hidden` is only where it starts).
import { useLayoutEffect, useRef } from 'react'
import type { PanelPlace } from './place.ts'

export function DockPreview({ place }: { place: PanelPlace }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => (ref.current ? place.preview.attach(ref.current) : undefined), [place])
  return <div className="dock-preview" hidden ref={ref} />
}
