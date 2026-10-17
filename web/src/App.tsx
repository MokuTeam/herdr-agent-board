// The board page: the toolbar over the board, the side panels, the usage popover and the toasts,
// the keys and the Back button.
import { useEffect, useRef, useState } from 'react'
import { Board } from './components/Board.tsx'
import { LimitsPop } from './components/LimitsPop.tsx'
import { SidePanels } from './components/SidePanels.tsx'
import { Toasts } from './components/Toasts.tsx'
import { Toolbar } from './components/Toolbar.tsx'
import { useBoardKeys } from './hooks/useBoardKeys.ts'
import { useDialogHistory } from './hooks/useDialogHistory.ts'
import { laneContext, useNewSession } from './hooks/useNewSession.ts'
import { useNextAttention } from './hooks/useNextAttention.ts'
import { usePanelLayout } from './hooks/usePanelLayout.ts'
import { useBoardContext } from './state/BoardProvider.tsx'

export function App() {
  const limitsAnchor = useRef<HTMLButtonElement>(null)
  const { ui, dispatch } = useBoardContext()
  const panels = usePanelLayout()
  const [categories, setCategories] = useState(false)
  const [schedule, setSchedule] = useState(false)
  // The launch window (Task 27) opens from here; until then only the "no fresh data" toast.
  const newSession = useNewSession()
  const openNextAttention = useNextAttention()
  useBoardKeys({
    openNextAttention,
    newSession,
    panelOpen: () => !!panels.place.openPanel(),
    closePanel: panels.closeOpen,
  })
  // Layers above the board, topmost first: Back on a phone closes them one at a time.
  useDialogHistory([
    {
      open: ui.limitsOpen,
      close: () => {
        dispatch({ type: 'limits', open: false })
        limitsAnchor.current?.focus({ preventScroll: true })
      },
    },
    { open: panels.open, close: panels.closeOpen },
  ])
  // A card kept in sight while the board makes room for a panel stays below the toolbar.
  useEffect(() => {
    panels.place.boardTop = () => document.querySelector('.toolbar')?.getBoundingClientRect().bottom ?? 0
  }, [panels.place])
  return (
    <>
      <div className="page">
        <Toolbar
          limitsAnchor={limitsAnchor}
          onNewSession={from => newSession(laneContext(ui.filter), from)}
          onCategories={() => setCategories(open => !open)}
          onSchedule={() => setSchedule(open => !open)}
        />
        <Board onNewSession={newSession} roomBelow={panels.roomBelow} />
      </div>
      <SidePanels
        categories={categories}
        schedule={schedule}
        onCategoriesClose={() => setCategories(false)}
        onScheduleClose={() => setSchedule(false)}
        sheet={{ onNewSession: newSession, schedule: { onMore: () => setSchedule(true) } }}
      />
      <LimitsPop anchor={limitsAnchor} />
      <Toasts />
    </>
  )
}
