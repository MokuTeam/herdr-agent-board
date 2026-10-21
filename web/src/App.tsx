// The board page: the toolbar over the board, the side panels, the usage popover, the quick look
// and the toasts, the keys and the Back button; the chat's files and links, the question forms, the
// context menus, renaming in place, the "new session" window and the terminal window; the
// session's helpers in their window; the Claude profiles' panel and sleep and wake's from Settings
// (wake's also from the toolbar's "Wake stopped"); the archive (its
// panel, sessions off the board and back, Ctrl+Z); a fork of a session in a new tab.
import { useEffect, useRef, useState } from 'react'
import { Board } from './components/Board.tsx'
import { FileChips } from './components/files/FileChip.tsx'
import { QuickLook } from './components/files/QuickLook.tsx'
import { ForkPop } from './components/fork/ForkPop.tsx'
import { HelpersWindow } from './components/helpers/HelpersWindow.tsx'
import { closeLimits, LimitsPop } from './components/LimitsPop.tsx'
import { LaunchDialog } from './components/launch/LaunchDialog.tsx'
import { ContextMenu } from './components/menu/ContextMenu.tsx'
import { usePhonesPanel } from './components/phones/PhonesPanel.tsx'
import { SheetQuestion } from './components/questions/SheetQuestion.tsx'
import { RenameField } from './components/RenameField.tsx'
import { SetupPop } from './components/SetupPop.tsx'
import { SidePanels } from './components/SidePanels.tsx'
import { Toasts } from './components/Toasts.tsx'
import { Toolbar } from './components/Toolbar.tsx'
import { Terminal } from './components/terminal/Terminal.tsx'
import { useArchive } from './hooks/useArchive.ts'
import { useBoardKeys } from './hooks/useBoardKeys.ts'
import { useContextMenus } from './hooks/useContextMenus.ts'
import { useDialogHistory } from './hooks/useDialogHistory.ts'
import { useFileChips } from './hooks/useFileChips.ts'
import { useFileLinks } from './hooks/useFileLinks.ts'
import { useFork } from './hooks/useFork.ts'
import { useHelpers } from './hooks/useHelpers.ts'
import { useLaunch } from './hooks/useLaunch.ts'
import { laneContext, useNewSession } from './hooks/useNewSession.ts'
import { useNextAttention } from './hooks/useNextAttention.ts'
import { usePanelLayout } from './hooks/usePanelLayout.ts'
import { useQuestions } from './hooks/useQuestions.ts'
import { useQuickLook } from './hooks/useQuickLook.ts'
import { useRenameInPlace } from './hooks/useRenameInPlace.ts'
import { useRestartNotes } from './hooks/useRestartNotes.ts'
import { useReveal } from './hooks/useReveal.ts'
import { useSchedule } from './hooks/useSchedule.ts'
import { useSegmentPicks } from './hooks/useSegmentPicks.ts'
import { useSettingsMenu } from './hooks/useSettingsMenu.ts'
import { useSetupNote } from './hooks/useSetupNote.ts'
import { useTerminal } from './hooks/useTerminal.ts'
import { pageLayers } from './models/lifecycle.ts'
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
  // Settings → Profiles…, with more than one profile folder found.
  const [profiles, setProfiles] = useState(false)
  // Settings → Sleep and wake…, while the payload carries wake's state line; the toolbar's note opens it too.
  const [wake, setWake] = useState(false)
  // Settings → Phones…, while the remote mode is on; a phone that asks to pair opens it.
  const [phones, setPhones] = usePhonesPanel()
  // The reminders' buttons, shared by the schedule panel and the sheet.
  const reminders = useSchedule()
  // Sessions off the board and back, the archive's panel; Retry on a session back from it is its Return again.
  const archive = useArchive()
  // A fork of a session in a new tab: its window, out of the button or the card it was asked from.
  const fork = useFork()
  // The launch window, and the cards of sessions on their way; without fresh data the board says why.
  // Retry on a fork opens its window again with what it was given.
  const launch = useLaunch({
    onResume: l => void archive.returnSessions([l.resume]),
    onFork: (l, from) => l.parent && fork.show(l.parent, from, { name: l.name, message: l.message }),
  })
  const newSession = useNewSession(launch.open)
  const openNextAttention = useNextAttention()
  // Paths in the chat become chips; a chip, the sheet's Changes and History open the quick look.
  const chips = useFileChips()
  const quickLook = useQuickLook(chips.upgrade)
  const openUrl = useFileLinks(quickLook.look)
  // A shell in the session's folder, or the session's own terminal, live in a window.
  const terminal = useTerminal(href => void openUrl(href))
  // Subagents, forks, workflow agents and teammates of the session in the sheet: the list, and one
  // helper's conversation drawn as the session's is.
  const helpers = useHelpers()
  const questions = useQuestions()
  // A session a notification was about: its sheet and its card in view.
  useReveal()
  // How the restarts asked for here went: a toast each.
  useRestartNotes()
  // "Setup incomplete" in the toolbar, and the list it opens.
  const setup = useSetupNote()
  // A session renamed where its name is; the menus of cards, lanes, the board and chips. The
  // menu's keys come after the quick look's, as the old page had them.
  const rename = useRenameInPlace()
  const menus = useContextMenus({
    quickLook,
    newSession,
    openCategories,
    rename: rename.start,
    launch: launch.menus,
    terminal: terminal.openTerminal,
    fork: fork.show,
    archive,
  })
  // Settings (the gear): light or dark, the language, where the panels sit, sleeping sessions, the profiles.
  const settings = useSettingsMenu(
    menus.menu,
    () => setProfiles(true),
    () => setPhones(true),
    () => setWake(true),
  )
  // The lanes control and the profile switch folded into pills: their choices as menus.
  const picks = useSegmentPicks(menus.menu)
  useBoardKeys({
    openNextAttention,
    newSession,
    // They take their keys first; the terminal window too, even while its screen has not the keys.
    layerOpen: () => menus.menu.isOpen() || launch.isOpen() || terminal.isOpen() || helpers.isOpen() || fork.isOpen(),
    quickLookOpen: quickLook.isOpen,
    panelOpen: () => !!panels.place.openPanel(),
    closePanel: panels.closeOpen,
    rename: rename.start,
    sessionPanelOpen: () => !!panels.place.openPanel(),
    pickOption: questions.pickOption,
    openTerminal: terminal.openTerminal,
    archive,
  })
  // Layers above the board, topmost first (models/lifecycle.ts PAGE_LAYERS): Back on a phone
  // closes them one at a time (the quick look and the helpers window a step at a time).
  useDialogHistory(
    pageLayers({
      menu: { open: menus.open, close: () => menus.menu.close() },
      launch: { open: launch.shown, close: launch.close },
      files: { open: quickLook.open, close: quickLook.back },
      terminal: { open: terminal.open, close: terminal.close },
      helpers: { open: helpers.open, close: helpers.back },
      limits: { open: ui.limitsOpen, close: () => closeLimits(dispatch, limitsAnchor, true) },
      setup: { open: setup.open, close: () => setup.close(true) },
      panels: { open: panels.open, close: panels.closeOpen },
    }),
  )
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
          onArchive={archive.togglePanel}
          setup={setup}
          onWake={() => setWake(true)}
          settings={settings}
          picks={picks}
        />
        <Board
          onNewSession={newSession}
          onLaneHead={openCategories}
          roomBelow={panels.roomBelow}
          launch={launch.slots}
          takeovers={launch.takeovers}
          archive={archive}
        />
      </div>
      <SidePanels
        categories={{ open: categories, focus: lane, onClose: () => setCategories(false), onOpen: openCategories }}
        schedule={{ open: schedule, focus: session, onClose: () => setSchedule(false), schedule: reminders }}
        profiles={{ open: profiles, onClose: () => setProfiles(false) }}
        wake={{ open: wake, onClose: () => setWake(false) }}
        phones={{ open: phones, onClose: () => setPhones(false) }}
        archive={archive}
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
          onMore: menus.sheetMore,
          moreOpen: menus.moreOpen,
          onPick: menus.sheetPick,
          pickOpen: menus.pickOpen,
          onRename: rename.start,
          onRenameWorkspace: (key, name) => rename.start(key, name, 'workspace'),
          onTerminal: terminal.openTerminal,
          helpers,
          onArchive: key => void archive.archiveSession(key),
          onFork: fork.show,
        }}
      />
      <LimitsPop anchor={limitsAnchor} />
      <SetupPop setup={setup} />
      <FileChips chips={chips} />
      <QuickLook engine={quickLook.engine} />
      <Terminal engine={terminal.engine} />
      <HelpersWindow engine={helpers.engine} upgrade={chips.upgrade} />
      <LaunchDialog launch={launch.dialog} refs={launch.refs} />
      {/* Only while it is open or folding away: the page is as it was otherwise. */}
      {!fork.hidden && <ForkPop fork={fork} />}
      <ContextMenu engine={menus.menu} />
      <RenameField rename={rename} />
      <Toasts />
    </>
  )
}
