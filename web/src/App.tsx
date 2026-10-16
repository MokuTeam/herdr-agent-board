// The board page: the toolbar over the board, the usage popover and the toasts, and the keys.
import { useRef } from 'react'
import { Board } from './components/Board.tsx'
import { LimitsPop } from './components/LimitsPop.tsx'
import { Toasts } from './components/Toasts.tsx'
import { Toolbar } from './components/Toolbar.tsx'
import { useBoardKeys } from './hooks/useBoardKeys.ts'
import { laneContext, useNewSession } from './hooks/useNewSession.ts'
import { useNextAttention } from './hooks/useNextAttention.ts'
import { useBoardContext } from './state/BoardProvider.tsx'

export function App() {
  const limitsAnchor = useRef<HTMLButtonElement>(null)
  const { ui } = useBoardContext()
  // The launch window (Task 27) opens from here; until then only the "no fresh data" toast.
  const newSession = useNewSession()
  const openNextAttention = useNextAttention()
  useBoardKeys({ openNextAttention, newSession })
  return (
    <>
      <div className="page">
        <Toolbar limitsAnchor={limitsAnchor} onNewSession={from => newSession(laneContext(ui.filter), from)} />
        <Board onNewSession={newSession} />
      </div>
      <LimitsPop anchor={limitsAnchor} />
      <Toasts />
    </>
  )
}
