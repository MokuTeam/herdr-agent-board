// The board page: the toolbar over the board, the side panels, the usage popover, the quick look
// and the toasts, the keys and the Back button; the chat's files and links, and the question forms.
import { useEffect, useRef, useState } from 'react'
import { Board } from './components/Board.tsx'
import { FileChips } from './components/files/FileChip.tsx'
import { QuickLook } from './components/files/QuickLook.tsx'
import { LimitsPop } from './components/LimitsPop.tsx'
import { SheetQuestion } from './components/questions/SheetQuestion.tsx'
import { SidePanels } from './components/SidePanels.tsx'
import { Toasts } from './components/Toasts.tsx'
import { Toolbar } from './components/Toolbar.tsx'
import { useBoardKeys } from './hooks/useBoardKeys.ts'
import { useDialogHistory } from './hooks/useDialogHistory.ts'
import { useFileChips } from './hooks/useFileChips.ts'
import { useFileLinks } from './hooks/useFileLinks.ts'
import { laneContext, useNewSession } from './hooks/useNewSession.ts'
import { useNextAttention } from './hooks/useNextAttention.ts'
import { usePanelLayout } from './hooks/usePanelLayout.ts'
import { useQuestions } from './hooks/useQuestions.ts'
import { useQuickLook } from './hooks/useQuickLook.ts'
import { useSchedule } from './hooks/useSchedule.ts'
import { useBoardContext } from './state/BoardProvider.tsx'

export function App() {
  const limitsAnchor = useRef<HTMLButtonElement>(null)
  const { ui, dispatch } = useBoardContext()
  const panels = usePanelLayout()
  // The categories and schedule panels, each opened at a lane or a session when asked.
  const [categories, setCategories] = useState(false)
  const [lane, setLane] = useState<{ id: string } | null>(null)
  const openCategories = (id?: string) => {
    setCategories(true)
    setLane(id ? { id } : null)
  }
  const [schedule, setSchedule] = useState(false)
  const [session, setSession] = useState<{ key: string } | null>(null)
  const openSchedule = (key?: string | null) => {
    setSchedule(true)
    setSession(key ? { key } : null)
  }
  // The reminders' buttons, shared by the schedule panel and the sheet.
  const reminders = useSchedule()
  // The launch window (Task 27) opens from here; until then only the "no fresh data" toast.
  const newSession = useNewSession()
  const openNextAttention = useNextAttention()
  // Paths in the chat become chips; a chip, the sheet's Changes and History open the quick look.
  const chips = useFileChips()
  const quickLook = useQuickLook(chips.upgrade)
  useFileLinks(quickLook.look)
  const questions = useQuestions()
  useBoardKeys({
    openNextAttention,
    newSession,
    quickLookOpen: quickLook.isOpen,
    panelOpen: () => !!panels.place.openPanel(),
    closePanel: panels.closeOpen,
    sessionPanelOpen: () => !!panels.place.openPanel(),
    pickOption: questions.pickOption,
  })
  // Layers above the board, topmost first: Back on a phone closes them one at a time (the quick
  // look a step at a time).
  useDialogHistory([
    { open: quickLook.open, close: quickLook.back },
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
          onCategories={() => (categories ? setCategories(false) : openCategories())}
          onSchedule={() => (schedule ? setSchedule(false) : openSchedule())}
        />
        <Board onNewSession={newSession} onLaneHead={openCategories} roomBelow={panels.roomBelow} />
      </div>
      <SidePanels
        categories={{ open: categories, focus: lane, onClose: () => setCategories(false), onOpen: openCategories }}
        schedule={{ open: schedule, focus: session, onClose: () => setSchedule(false), schedule: reminders }}
        sheet={{
          onNewSession: newSession,
          schedule: {
            armed: reminders.armed,
            held: reminders.held,
            onCancel: reminders.cancel,
            onMode: reminders.mode,
            onMore: () => openSchedule(ui.open),
          },
          question: (item, detail) => questions.mount(item, detail) && <SheetQuestion questions={questions} />,
          upgradeFiles: chips.upgrade,
          onChanges: quickLook.lookChanges,
          onHistory: quickLook.lookHistory,
        }}
      />
      <LimitsPop anchor={limitsAnchor} />
      <FileChips chips={chips} />
      <QuickLook engine={quickLook.engine} />
      <Toasts />
    </>
  )
}
