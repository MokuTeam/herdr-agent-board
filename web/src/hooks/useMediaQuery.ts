// Whether a media query matches now, drawn again when that changes (false where there is none:
// on the server, in the tests).
import { useCallback, useSyncExternalStore } from 'react'

const media = (query: string): MediaQueryList | null => (typeof matchMedia === 'function' ? matchMedia(query) : null)

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (changed: () => void) => {
      const list = media(query)
      list?.addEventListener('change', changed)
      return () => list?.removeEventListener('change', changed)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => media(query)?.matches ?? false,
    () => false,
  )
}
