// On a computer with Omarchy the page links the theme's colors for the Terminal style
// (omarchy-theme.css, src/adapters/omarchy.ts). A theme switched meanwhile changes the board's
// `omarchy` stamp: the page loads the stylesheet again, without loading itself again.
import { useEffect, useRef } from 'react'

export function useOmarchyTheme(stamp: string | undefined): void {
  // The stylesheet the page came with is the theme of the stamp it first sees.
  const first = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!stamp) return
    if (first.current === undefined) {
      first.current = stamp
      return
    }
    const link = document.querySelector<HTMLLinkElement>('link[href^="omarchy-theme.css"]')
    const href = `omarchy-theme.css?v=${stamp}`
    if (link && link.getAttribute('href') !== href) link.setAttribute('href', href)
  }, [stamp])
}
