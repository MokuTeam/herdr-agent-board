// The lanes control fades out at an edge with more lanes past it (models/toolbar.ts laneFades), so
// the strip reads as one that scrolls: after every draw, as it scrolls, and as the window resizes.
import { type RefObject, useEffect, useLayoutEffect } from 'react'
import { laneFades } from '../models/toolbar.ts'

/** The strip's fade-start and fade-end classes for where it is scrolled to now. */
export function fadeLanes(seg: HTMLElement): void {
  const { start, end } = laneFades(seg)
  seg.classList.toggle('fade-start', start)
  seg.classList.toggle('fade-end', end)
}

/** The fades kept up as the strip scrolls and as the window resizes, until the function it gives back is called. */
export function followLaneFades(seg: HTMLElement): () => void {
  const fade = () => fadeLanes(seg)
  seg.addEventListener('scroll', fade, { passive: true })
  addEventListener('resize', fade)
  return () => {
    seg.removeEventListener('scroll', fade)
    removeEventListener('resize', fade)
  }
}

export function useLaneFades(control: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    if (control.current) fadeLanes(control.current)
  })
  useEffect(() => {
    if (control.current) return followLaneFades(control.current)
  }, [control])
}
