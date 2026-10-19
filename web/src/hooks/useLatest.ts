// The latest value for listeners and async steps that outlive the render they were made in.
import { type RefObject, useLayoutEffect, useRef } from 'react'

export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}
