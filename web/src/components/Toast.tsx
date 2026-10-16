// One toast: it springs up, stays (errors longer) and fades away.
import { useEffect, useRef } from 'react'
import { Spring } from '../models/spring.ts'
import type { Toast as ToastItem } from '../state/board-ui.ts'

const SHOWN_MS = 2600
const ERROR_SHOWN_MS = 6000

export function Toast({ toast, onGone }: { toast: ToastItem; onGone: (id: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const { id, error } = toast

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const spring: Spring = new Spring({
      value: 0,
      damping: 1,
      response: 0.3,
      precision: 0.002,
      onUpdate: () => {
        const v = spring.value
        el.style.opacity = String(v)
        el.style.transform = `translateY(${(1 - v) * 14}px) scale(${0.97 + 0.03 * v})`
      },
    })
    spring.to(1)
    const timer = setTimeout(
      () => {
        spring.onRest = () => onGone(id)
        spring.to(0)
      },
      error ? ERROR_SHOWN_MS : SHOWN_MS,
    )
    return () => {
      clearTimeout(timer)
      spring.stop()
    }
  }, [id, error, onGone])

  return (
    <div ref={ref} className={error ? 'toast error' : 'toast'}>
      {toast.text}
    </div>
  )
}
