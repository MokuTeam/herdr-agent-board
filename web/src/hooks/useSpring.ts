// A spring (models/spring.ts) that lives as long as the component: made on the first render with
// these options, stopped when the component goes.
import { useEffect, useRef } from 'react'
import { Spring, type SpringOptions } from '../models/spring.ts'

export function useSpring(options: SpringOptions): Spring {
  const spring = useRef<Spring | null>(null)
  if (!spring.current) spring.current = new Spring(options)
  useEffect(() => () => void spring.current?.stop(), [])
  return spring.current
}
