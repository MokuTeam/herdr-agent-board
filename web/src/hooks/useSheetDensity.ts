// The session sheet's compact or whole head (models/sheet-density.ts): this browser's choice for
// the width the page has now, kept in localStorage (which may be missing or refuse: a private
// window, then the choice lasts until the page closes). A flow outside the sheet that needs what is
// in the head's fold (models/sheet-reveal.ts) shows it whole for as long as the session shows, which
// the choice does not keep.
import { useEffect, useState } from 'react'
import { PHONE_QUERY } from '../models/panel-motion.ts'
import { DENSITY_KEYS, type DensityClass, densityClass, densityValue, keptCompact } from '../models/sheet-density.ts'
import { onRevealDetails } from '../models/sheet-reveal.ts'
import { useLatest } from './useLatest.ts'
import { useMediaQuery } from './useMediaQuery.ts'

export interface SheetDensity {
  compact: boolean
  /** Compact, or whole, from the head's chevron; kept for this width. */
  toggle(): void
}

function read(width: DensityClass): string | null {
  try {
    return localStorage.getItem(DENSITY_KEYS[width])
  } catch {
    return null
  }
}

function keep(width: DensityClass, value: string): void {
  try {
    localStorage.setItem(DENSITY_KEYS[width], value)
  } catch {}
}

/** `shown`: the session the sheet shows; a head shown whole for a flow outside it is whole for that session only. */
export function useSheetDensity(shown: string | null): SheetDensity {
  const width = densityClass(useMediaQuery(PHONE_QUERY))
  const [kept, setKept] = useState<Record<DensityClass, string | null>>(() => ({
    phone: read('phone'),
    wide: read('wide'),
  }))
  const [revealedFor, setRevealedFor] = useState<string | null>(null)
  const revealed = shown !== null && revealedFor === shown
  const choice = keptCompact(width, kept[width])
  const compact = !revealed && choice
  // An ask is for a session that may not be the one shown yet: its head is compact if the choice says so,
  // unless it is the one shown and already whole.
  const now = useLatest({ shown, compact, choice })
  useEffect(
    () =>
      onRevealDetails(key => {
        setRevealedFor(key)
        return now.current.shown === key ? now.current.compact : now.current.choice
      }),
    [now],
  )
  return {
    compact,
    toggle() {
      // What the chevron shows is what it flips, and that is what is kept.
      const next = densityValue(!compact)
      keep(width, next)
      setKept(was => ({ ...was, [width]: next }))
      setRevealedFor(null)
    },
  }
}
