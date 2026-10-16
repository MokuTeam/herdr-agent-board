// Keeps a setting in localStorage when it changes (not when the page starts with it).
import { useEffect, useRef } from 'react'
import { storage } from './storage.ts'

export function usePersisted(key: string, value: string): void {
  const saved = useRef(value)
  useEffect(() => {
    if (value === saved.current) return
    saved.current = value
    storage.set(key, value)
  }, [key, value])
}
