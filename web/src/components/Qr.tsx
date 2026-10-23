// A text as a QR code (src/core/qr.ts), black on white whatever the theme, for a phone's camera:
// the Phones panel's address, and what the Remote access panel shows a phone.
import { useMemo } from 'react'
import { qrMatrix, qrPath } from '../../../src/core/qr.ts'

export function Qr({ text, className }: { text: string; className: string }) {
  const { d, size } = useMemo(() => qrPath(qrMatrix(text)), [text])
  return (
    <svg className={className} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={text} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}
