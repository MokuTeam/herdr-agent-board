// The clocks of what works now move on every second, wherever they are on show (the old page's
// tickClocks): one timer for the page, running only while a clock is drawn.
import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let now = 0
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  timer ??= setInterval(() => {
    now = Date.now()
    for (const l of [...listeners]) l()
  }, 1000)
  return () => {
    listeners.delete(listener)
    if (!listeners.size && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

// Between ticks the same second reads the same: a draw asks twice and must get one answer.
const second = () => Math.floor(Date.now() / 1000) * 1000

function snapshot(): number {
  if (!timer) now = second()
  return now
}

/** The time, moved on every second while a component reads it. */
export function useSecond(): number {
  return useSyncExternalStore(subscribe, snapshot, second)
}
