// The minute now, moving on each minute while `on` (the calendar's current-time line and its
// toolbar button, #328): one timer per user, none while off.
import { useEffect, useState } from 'react'

export function useMinute(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    let timer: ReturnType<typeof setTimeout>
    const next = () => {
      timer = setTimeout(
        () => {
          setNow(Date.now())
          next()
        },
        60_000 - (Date.now() % 60_000) + 50,
      )
    }
    next()
    return () => clearTimeout(timer)
  }, [on])
  return now
}
