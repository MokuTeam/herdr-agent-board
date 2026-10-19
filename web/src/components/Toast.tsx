// One toast: it springs up, stays (errors longer, or as long as it was asked to) and fades away. A
// toast with an action (Return, after an archive) has its button, which also closes it; one asked
// to go (`hiding`) fades away at once.
import { useEffect, useRef } from 'react'
import { Spring } from '../models/spring.ts'
import type { Toast as ToastItem } from '../state/board-ui.ts'

const SHOWN_MS = 2600
const ERROR_SHOWN_MS = 6000

export function Toast({ toast, onGone }: { toast: ToastItem; onGone: (id: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const goneRef = useRef<() => void>(() => {})
  const { id, error, ms, hiding, action } = toast

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
    let going = false
    const gone = () => {
      if (going) return
      going = true
      clearTimeout(timer)
      el.style.pointerEvents = 'none'
      spring.onRest = () => onGone(id)
      spring.to(0)
    }
    goneRef.current = gone
    const timer = setTimeout(gone, ms || (error ? ERROR_SHOWN_MS : SHOWN_MS))
    return () => {
      clearTimeout(timer)
      spring.stop()
    }
  }, [id, error, ms, onGone])

  useEffect(() => {
    if (hiding) goneRef.current()
  }, [hiding])

  if (!action)
    return (
      <div ref={ref} className={error ? 'toast error' : 'toast'}>
        {toast.text}
      </div>
    )
  return (
    <div ref={ref} className={error ? 'toast error with-action' : 'toast with-action'}>
      <span className="toast-text">{toast.text}</span>
      <button
        type="button"
        className="toast-action"
        onClick={() => {
          goneRef.current()
          action.run()
        }}
      >
        {action.label}
      </button>
    </div>
  )
}
