// The panel's place glyphs (web/panel.js GLYPHS): a window frame with the part the panel takes.
import type { ReactNode } from 'react'
import type { Dock } from '../../models/panel-layout.ts'

function Glyph({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
      {children}
    </svg>
  )
}

const Frame = () => <rect x="2.5" y="4" width="15" height="12" rx="2.2" />

const RightGlyph = () => (
  <Glyph>
    <path className="fill" d="M12 4h3.3a2.2 2.2 0 0 1 2.2 2.2v7.6a2.2 2.2 0 0 1-2.2 2.2H12Z" />
    <Frame />
    <path d="M12 4v12" />
  </Glyph>
)

const LeftGlyph = () => (
  <Glyph>
    <path className="fill" d="M8 4H4.7a2.2 2.2 0 0 0-2.2 2.2v7.6A2.2 2.2 0 0 0 4.7 16H8Z" />
    <Frame />
    <path d="M8 4v12" />
  </Glyph>
)

const BottomGlyph = () => (
  <Glyph>
    <path className="fill" d="M2.5 11h15v2.8a2.2 2.2 0 0 1-2.2 2.2H4.7a2.2 2.2 0 0 1-2.2-2.2Z" />
    <Frame />
    <path d="M2.5 11h15" />
  </Glyph>
)

const FloatGlyph = () => (
  <Glyph>
    <Frame />
    <rect className="fill" x="8.5" y="7" width="6.5" height="6" rx="1.2" />
    <rect x="8.5" y="7" width="6.5" height="6" rx="1.2" />
  </Glyph>
)

export function DockGlyph({ dock }: { dock: Dock }) {
  if (dock === 'left') return <LeftGlyph />
  if (dock === 'bottom') return <BottomGlyph />
  if (dock === 'float') return <FloatGlyph />
  return <RightGlyph />
}

export const ResetGlyph = () => (
  <Glyph>
    <path d="M3.5 10h13M3.5 10 6 7.5M3.5 10 6 12.5M16.5 10 14 7.5m2.5 2.5L14 12.5" />
  </Glyph>
)

export const CheckMark = () => (
  <Glyph className="check">
    <path d="m4.5 10.5 3.5 3.5 7.5-8" />
  </Glyph>
)

export const CloseGlyph = () => (
  <Glyph>
    <path d="m5.5 5.5 9 9m0-9-9 9" />
  </Glyph>
)
