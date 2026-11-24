// MokuBoard brand mark (Direction B: Moku Frame, #705). Two opposing framing brackets in
// currentColor around a centered focus tile in --brand-accent (or currentColor in mono mode).
import { classNames } from './class-names.ts'

export interface BrandMarkProps {
  /** Rendered width and height in CSS pixels (default 18). */
  size?: number
  /** Single-color monochrome mode for masks or badges. */
  mono?: boolean
  className?: string
  /** Optional accessible label; omits aria-hidden when provided. */
  title?: string
}

const TL_BRACKET =
  'M10 14a4 4 0 0 1 4-4h20.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H18v16.5a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5Z'
const BR_BRACKET =
  'M54 50a4 4 0 0 1-4 4H29.5a1.5 1.5 0 0 1-1.5-1.5v-5a1.5 1.5 0 0 1 1.5-1.5H46V29.5a1.5 1.5 0 0 1 1.5-1.5h5a1.5 1.5 0 0 1 1.5 1.5Z'

/** Renders the MokuBoard geometric frame mark at the requested size. */
export function BrandMark({ size = 18, mono = false, className, title }: BrandMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={classNames('brand-mark', mono && 'mono', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
      focusable={title ? undefined : 'false'}
    >
      <path d={TL_BRACKET} fill="currentColor" />
      <path d={BR_BRACKET} fill="currentColor" />
      <rect
        x="24.5"
        y="24.5"
        width="15"
        height="15"
        rx="3.5"
        fill={mono ? 'currentColor' : 'var(--brand-accent, #7b2fff)'}
      />
    </svg>
  )
}
