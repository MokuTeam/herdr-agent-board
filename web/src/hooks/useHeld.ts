// A value as it was the last time `hold` was off: a list that must not be drawn anew while a row
// of it is dragged keeps showing what it showed. `value` must keep its identity between draws
// while it does not change (a board, a number).
import { useState } from 'react'

export function useHeld<T>(value: T, hold: boolean): T {
  const [held, setHeld] = useState(value)
  if (!hold && held !== value) setHeld(value)
  return hold ? held : value
}
