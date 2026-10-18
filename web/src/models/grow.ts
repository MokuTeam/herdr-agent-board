// A window that grows out of what opened it and folds back into it (the launch window, the quick
// look, the terminal, the helpers): one spring value p, 0 folded and 1 open, drawn as the
// window's offset, scale and opacity and its scrim's opacity; reduced motion only fades.
import { reducedMotion } from './spring.ts'

/** Where the window grows out of, against its own place: offset of the centre and scale. */
export interface GrowFrom {
  dx: number
  dy: number
  s: number
}

/** A little drop from below: for nothing to grow out of, or something off screen. */
export const FROM_BELOW: GrowFrom = { dx: 0, dy: 24, s: 0.94 }

/** The window's and the scrim's inline style at spring value `p` (0 folded, 1 open). */
export interface WindowPaint {
  transform: string
  opacity: string
  scrim: string
}

export function windowPaint(p: number, from: GrowFrom, reduced: boolean): WindowPaint {
  const q = Math.max(0, p)
  const scrim = String(Math.min(1, q))
  if (reduced) return { transform: '', opacity: String(Math.min(1, q)), scrim }
  const k = from.s + (1 - from.s) * q
  return {
    transform: `translate(${from.dx * (1 - q)}px, ${from.dy * (1 - q)}px) scale(${k})`,
    opacity: String(Math.min(1, q * 1.8)),
    scrim,
  }
}

/** The window and its scrim drawn at `p` (one that is missing is not drawn). */
export function paintWindow(
  win: Pick<HTMLElement, 'style'> | null,
  scrim: Pick<HTMLElement, 'style'> | null,
  p: number,
  from: GrowFrom,
): void {
  const look = windowPaint(p, from, reducedMotion.matches)
  if (win) {
    win.style.transform = look.transform
    win.style.opacity = look.opacity
  }
  if (scrim) scrim.style.opacity = look.scrim
}
