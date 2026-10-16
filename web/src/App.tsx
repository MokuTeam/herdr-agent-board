// The board page: the toolbar over the board, the usage popover and the toasts.
import { useRef } from 'react'
import { LimitsPop } from './components/LimitsPop.tsx'
import { Toasts } from './components/Toasts.tsx'
import { Toolbar } from './components/Toolbar.tsx'

export function App() {
  const limitsAnchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <div className="page">
        <Toolbar limitsAnchor={limitsAnchor} />
        <main className="board" id="board" />
      </div>
      <LimitsPop anchor={limitsAnchor} />
      <Toasts />
    </>
  )
}
