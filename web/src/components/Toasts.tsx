// Short notes at the bottom of the page, read out politely by screen readers.
import { useCallback } from 'react'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { Toast } from './Toast.tsx'

export function Toasts() {
  const { ui, dispatch } = useBoardContext()
  const onGone = useCallback((id: number) => dispatch({ type: 'toastGone', id }), [dispatch])
  return (
    <div className="toasts" id="toasts" aria-live="polite">
      {ui.toasts.map(toast => (
        <Toast key={toast.id} toast={toast} onGone={onGone} />
      ))}
    </div>
  )
}
