// Whether the page is scrolled down: the toolbar gets its shadow then.
import { useEffect, useState } from 'react'

export function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(scrollY > 2)
    addEventListener('scroll', onScroll, { passive: true })
    return () => removeEventListener('scroll', onScroll)
  }, [])
  return scrolled
}
