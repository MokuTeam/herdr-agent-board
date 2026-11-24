// The board page: the toolbar over the board, the side panels, the usage popover, the quick look
// and the toasts, the keys and the Back button; the chat's files and links, the question forms, the
// context menus, renaming in place, the "new session" window and the terminal window; the
// session's helpers in their window; the Claude profiles' panel and sleep and wake's from Settings
// (wake's also from the toolbar's "Wake stopped"); the archive (its panel, sessions off the board
// and back, Ctrl+Z); a fork of a session in a new tab; Remote access from Settings on the local
// board.
import { useEffect, useRef, useState } from 'react'
import { Board } from './components/Board.tsx'
import type { CalendarFocus } from './components/calendar/CalendarPanel.tsx'
import { Reminders } from './components/calendar/Reminders.tsx'
import { FileChips } from './components/files/FileChip.tsx'
import { QuickLook } from './components/files/QuickLook.tsx'
import { ForkPop } from './components/fork/ForkPop.tsx'
import { HelpersWindow } from './components/helpers/HelpersWindow.tsx'
import { AwayStrip } from './components/journal/AwayStrip.tsx'
import { closeLimits, LimitsPop } from './components/LimitsPop.tsx'
import { LaunchDialog } from './components/launch/LaunchDialog.tsx'
import { ContextMenu } from './components/menu/ContextMenu.tsx'
import { NavRail, RAIL_STORAGE_KEY, type RailPlace } from './components/NavRail.tsx'
import { usePhonesPanel } from './components/phones/PhonesPanel.tsx'
import { SheetQuestion } from './components/questions/SheetQuestion.tsx'
import { RenameField } from './components/RenameField.tsx'
import { SetupPop } from './components/SetupPop.tsx'
import { SidePanels } from './components/SidePanels.tsx'
import { SecretRequests, secretsOf } from './components/secrets/SecretForm.tsx'
import { Toasts } from './components/Toasts.tsx'
import { Toolbar } from './components/Toolbar.tsx'
import { Terminal } from './components/terminal/Terminal.tsx'
import { useArchive } from './hooks/useArchive.ts'
import { useBoardKeys } from './hooks/useBoardKeys.ts'
import { useContextMenus } from './hooks/useContextMenus.ts'
import { useDecisions } from './hooks/useDecisions.ts'
import { useDialogHistory } from './hooks/useDialogHistory.ts'
import { useFileChips } from './hooks/useFileChips.ts'
import { useFileLinks } from './hooks/useFileLinks.ts'
import { useFork } from './hooks/useFork.ts'
import { useHelpers } from './hooks/useHelpers.ts'
import { useJournal } from './hooks/useJournal.ts'
import { useLaunch } from './hooks/useLaunch.ts'
import { laneContext, useNewSession } from './hooks/useNewSession.ts'
import { useNextAttention } from './hooks/useNextAttention.ts'
import { useOmarchyTheme } from './hooks/useOmarchyTheme.ts'
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
import { useTerminalKeys } from './hooks/useTerminalKeys.ts'
import { useThreadLinks } from './hooks/useThreadLinks.ts'
import { linkThreadsSheet, useThreadsContext } from './hooks/useThreads.tsx'
import { useTodos } from './hooks/useTodos.ts'
import { useToolbarMenu } from './hooks/useToolbarMore.ts'
import { linkDecisionsSheet } from './models/decisions.ts'
import { pageLayers } from './models/lifecycle.ts'
import { adminHere, remotePage } from './models/remote-page.ts'
import { offersTeam, teamBadge } from './models/team.ts'
import { proposedCount } from './models/todos.ts'
import { scheduleBadge } from './models/toolbar.ts'
import { isWakeView, noteShown } from './models/wake.ts'
import { useBoardContext } from './state/BoardProvider.tsx'
import { storage } from './state/storage.ts'

export function App() {
  const limitsAnchor = useRef<HTMLButtonElement>(null)
  const { ui, dispatch, data, calOpen, teamOpen, now } = useBoardContext()
  const panels = usePanelLayout()
  // Collapsible left rail (#651): persisted expanded/collapsed on desktop, drawer state on phone.
  const [railExpanded, setRailExpanded] = useState(() => storage.get(RAIL_STORAGE_KEY, '') === '1')
  const toggleRailExpanded = () => {
    setRailExpanded(was => {
      const next = !was
      storage.set(RAIL_STORAGE_KEY, next ? '1' : '0')
      return next
    })
  }
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Structured Settings panel (#651).
  const [settingsOpen, setSettingsOpen] = useState(false)
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
  // Settings → MokuPilot…: where a call starts. Mounted at its first opening, as Remote access,
  // so until then the page is as it was.
  const [mokupilot, setMokupilot] = useState(false)
  const [mokupilotMounted, setMokupilotMounted] = useState(false)
  const openMokupilot = () => {
    setMokupilot(true)
    setMokupilotMounted(true)
  }
  // Settings → Remote access…, on the local board only: its panel is mounted at its first opening,
  // so until then the page is as it was.
  const [access, setAccess] = useState(false)
  const [accessMounted, setAccessMounted] = useState(false)
  const openAccess = () => {
    setAccess(true)
    setAccessMounted(true)
  }
  // Settings → Backup… (#233), on the local board only: mounted at its first opening, as Remote access.
  const [backup, setBackup] = useState(false)
  const [backupMounted, setBackupMounted] = useState(false)
  const openBackup = () => {
    setBackup(true)
    setBackupMounted(true)
  }
  // Settings → Updates… (#617), on the local board only: mounted at its first opening, as Backup.
  const [updates, setUpdates] = useState(false)
  const [updatesMounted, setUpdatesMounted] = useState(false)
  const openUpdates = () => {
    setUpdates(true)
    setUpdatesMounted(true)
  }
  // Settings → Housekeeping… (#652), on the local board only: mounted at its first opening.
  const [housekeeping, setHousekeeping] = useState(false)
  const [housekeepingMounted, setHousekeepingMounted] = useState(false)
  const openHousekeeping = () => {
    setHousekeeping(true)
    setHousekeepingMounted(true)
  }
  // Settings → Time tracking… (#237), on the local board only: mounted at its first opening, as Backup.
  const [timeSettings, setTimeSettings] = useState(false)
  const [timeSettingsMounted, setTimeSettingsMounted] = useState(false)
  const openTimeSettings = () => {
    setTimeSettings(true)
    setTimeSettingsMounted(true)
  }
  // Settings → Calendar (#328), on the local board only: mounted at its first opening, as Time tracking.
  const [calendarSettings, setCalendarSettings] = useState(false)
  const [calendarSettingsMounted, setCalendarSettingsMounted] = useState(false)
  const openCalendarSettings = () => {
    setCalendarSettings(true)
    setCalendarSettingsMounted(true)
  }
  // The calendar (#328), while the board has it on: its panel, out of the toolbar's button; an
  // event a reminder's Open asks for (#335: on the page, or its notification on the desktop).
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [calendarFocus, setCalendarFocus] = useState<CalendarFocus | null>(null)
  const showEvent = (e: Omit<CalendarFocus, 'n'>) => {
    setCalendarOpen(true)
    setCalendarFocus(f => ({ ...e, n: (f?.n ?? 0) + 1 }))
  }
  const asked = calOpen?.n ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once, by its count
  useEffect(() => {
    if (calOpen) showEvent(calOpen)
  }, [asked])
  // Time (#233), while the board has it on: its panel, out of the toolbar's button or a lane's day total.
  const [timeOpen, setTimeOpen] = useState(false)
  const [timeClient, setTimeClient] = useState<string | null>(null)
  // Token spend (#636): mounted at its first opening, so setups that never open it pay zero cost.
  const [spendOpen, setSpendOpen] = useState(false)
  const [spendMounted, setSpendMounted] = useState(false)
  const toggleSpend = () => {
    setSpendMounted(true)
    setSpendOpen(was => !was)
  }
  // Settings → Team… (#231), local page with the payload's teamRev: mounted at its first opening.
  const [team, setTeam] = useState(false)
  const [teamMounted, setTeamMounted] = useState(false)
  const openTeam = () => {
    setTeam(true)
    setTeamMounted(true)
  }
  // Settings → Devices… (#510), the local page (Add a server alone without `nodes`, #509): mounted at its first opening.
  const [devices, setDevices] = useState(false)
  const [devicesMounted, setDevicesMounted] = useState(false)
  const openDevices = () => {
    setDevices(true)
    setDevicesMounted(true)
  }
  // A team notification's click (#355): the panel opens on that thread.
  const [teamFocus, setTeamFocus] = useState<string | null>(null)
  const teamAsked = teamOpen?.n ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: each ask once, by its count
  useEffect(() => {
    if (!teamOpen || !offersTeam(data)) return
    openTeam()
    setTeamFocus(teamOpen.thread)
  }, [teamAsked])
  // Tasks (#202), while the board has them on: their panel, out of the toolbar's button.
  const [todosOpen, setTodosOpen] = useState(false)
  // Threads (#392), while the payload carries them: the panel, and links that open a thread.
  const threads = useThreadsContext()
  useThreadLinks()
  const threadsOn = !!threads
  useEffect(() => {
    if (threadsOn) linkThreadsSheet()
  }, [threadsOn])
  // Decisions (#487), while the payload carries them: the panel out of the toolbar's pill, and their sheet.
  const [decisionsOpen, setDecisionsOpen] = useState(false)
  const decisionsOn = !!data?.decisions
  const decisions = useDecisions()
  useEffect(() => {
    if (decisionsOn) linkDecisionsSheet()
  }, [decisionsOn])
  // Settings → Paths on this computer…, on the board seen from another device only: mounted at its
  // first opening, as Remote access.
  const [localPaths, setLocalPaths] = useState(false)
  const [localPathsMounted, setLocalPathsMounted] = useState(false)
  const openLocalPaths = () => {
    setLocalPaths(true)
    setLocalPathsMounted(true)
  }
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
  // The away journal's strip (#489), while the payload has `journal`.
  const journal = useJournal()
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
    openAccess,
    openMokupilot,
    openBackup,
    openTimeSettings,
    openLocalPaths,
    openCalendarSettings,
    openTeam,
    openDevices,
    openUpdates,
    openHousekeeping,
  )
  // Tasks' 📌 menu under an agent's message, and the panel's buttons.
  const todos = useTodos(menus.menu)
  // The lanes control and the profile switch folded into pills: their choices as menus.
  const picks = useSegmentPicks(menus.menu)
  // What left the toolbar's row at a narrow width: its More menu.
  const more = useToolbarMenu(menus.menu)
  const terminalKeys = useTerminalKeys(menus)
  useOmarchyTheme(data?.omarchy)
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
    openSettings: () => setSettingsOpen(was => !was),
    terminal: terminalKeys,
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

  const wakeDown = adminHere() && isWakeView(data?.wake) && noteShown(data.wake, now)
  const systemAlert = setup.shown || !!data?.backup?.problem || wakeDown
  const sched = scheduleBadge(data?.schedules ?? [], now)
  const railAlert =
    systemAlert ||
    sched.due ||
    (data?.decisions ? data.decisions.items.length + data.decisions.defaulted.length > 0 : false) ||
    (data?.threads ? data.threads.needsOwner > 0 : false) ||
    (offersTeam(data) ? teamBadge(data).count > 0 : false) ||
    (data?.todos ? proposedCount(data.items) > 0 : false) ||
    (data?.calendar ? data.calendar.failing > 0 : false)

  const activePlace: RailPlace = settingsOpen
    ? 'settings'
    : decisionsOpen
      ? 'decisions'
      : threads?.shown
        ? 'threads'
        : team
          ? 'team'
          : todosOpen
            ? 'todos'
            : calendarOpen
              ? 'calendar'
              : schedule
                ? 'schedule'
                : timeOpen
                  ? 'time'
                  : spendOpen
                    ? 'spend'
                    : categories
                      ? 'categories'
                      : archive.panel.open
                        ? 'archive'
                        : 'board'

  return (
    <>
      <NavRail
        expanded={railExpanded}
        onToggleExpand={toggleRailExpanded}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerOpen(false)}
        activePlace={activePlace}
        onBoard={() => panels.closeOpen()}
        {...(decisionsOn && { onDecisions: () => setDecisionsOpen(was => !was) })}
        {...(threads && { onThreads: () => threads.setShown(!threads.shown) })}
        {...(offersTeam(data) && { onTeam: () => (team ? setTeam(false) : openTeam()) })}
        {...(data?.todos && { onTodos: () => setTodosOpen(was => !was) })}
        {...(data?.calendar && { onCalendar: () => setCalendarOpen(was => !was) })}
        onSchedule={() => (schedule ? setSchedule(false) : openSchedule())}
        {...(data?.time && {
          onTime: () => {
            setTimeClient(null)
            setTimeOpen(was => !was)
          },
        })}
        onSpend={toggleSpend}
        onCategories={() => (categories ? setCategories(false) : openCategories())}
        onArchive={archive.togglePanel}
        onSettings={() => setSettingsOpen(was => !was)}
        systemAlert={systemAlert}
      />
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
          more={more}
          onTodos={() => setTodosOpen(!todosOpen)}
          {...(threads && { onThreads: () => threads.setShown(!threads.shown) })}
          {...(decisionsOn && { onDecisions: () => setDecisionsOpen(!decisionsOpen) })}
          onBackup={adminHere() ? openBackup : undefined}
          onTime={() => {
            setTimeClient(null)
            setTimeOpen(!timeOpen)
          }}
          onCalendar={() => setCalendarOpen(!calendarOpen)}
          {...(offersTeam(data) && { onTeam: () => (team ? setTeam(false) : openTeam()) })}
          {...(journal.button && {
            journal: { label: journal.button, open: !!journal.shown, onToggle: journal.toggle },
          })}
          onOpenDrawer={() => setDrawerOpen(true)}
          railAlert={railAlert}
        />
        <AwayStrip journal={journal} />
        <Board
          onNewSession={newSession}
          onLaneHead={openCategories}
          onLaneTime={id => {
            setTimeClient(id)
            setTimeOpen(true)
          }}
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
        {...(mokupilotMounted ? { mokupilot: { open: mokupilot, onClose: () => setMokupilot(false) } } : {})}
        {...(accessMounted && adminHere() ? { access: { open: access, onClose: () => setAccess(false) } } : {})}
        {...(backupMounted && adminHere() ? { backup: { open: backup, onClose: () => setBackup(false) } } : {})}
        {...(updatesMounted && adminHere() ? { updates: { open: updates, onClose: () => setUpdates(false) } } : {})}
        {...(housekeepingMounted && adminHere()
          ? { housekeeping: { open: housekeeping, onClose: () => setHousekeeping(false) } }
          : {})}
        {...(timeSettingsMounted && adminHere()
          ? { timeSettings: { open: timeSettings, onClose: () => setTimeSettings(false) } }
          : {})}
        {...(calendarSettingsMounted && adminHere()
          ? { calendarSettings: { open: calendarSettings, onClose: () => setCalendarSettings(false) } }
          : {})}
        calendar={{
          open: calendarOpen,
          focus: calendarFocus,
          onFocused: () => setCalendarFocus(null),
          onClose: () => {
            setCalendarOpen(false)
            setCalendarFocus(null)
          },
          onSettings: adminHere() ? openCalendarSettings : undefined,
        }}
        {...(localPathsMounted && remotePage()
          ? { localPaths: { open: localPaths, onClose: () => setLocalPaths(false) } }
          : {})}
        {...(devicesMounted && adminHere() ? { devices: { open: devices, onClose: () => setDevices(false) } } : {})}
        {...(teamMounted && offersTeam(data)
          ? {
              team: {
                open: team,
                onClose: () => setTeam(false),
                focus: teamFocus,
                onFocused: () => setTeamFocus(null),
              },
            }
          : {})}
        archive={archive}
        todos={{ open: todosOpen, onClose: () => setTodosOpen(false), todos }}
        decisions={{ open: decisionsOpen, onClose: () => setDecisionsOpen(false), decisions }}
        {...(threads && {
          threads: { open: threads.shown, onClose: () => threads.setShown(false), menu: menus.menu },
        })}
        time={{ open: timeOpen, onClose: () => setTimeOpen(false), client: timeClient, onClient: setTimeClient }}
        {...(spendMounted ? { spend: { open: spendOpen, onClose: () => setSpendOpen(false) } } : {})}
        settings={{
          open: settingsOpen,
          onClose: () => setSettingsOpen(false),
          setup,
          onOpenProfiles: () => setProfiles(true),
          onOpenWake: () => setWake(true),
          onOpenPhones: () => setPhones(true),
          onOpenMokupilot: openMokupilot,
          onOpenAccess: openAccess,
          onOpenBackup: openBackup,
          onOpenUpdates: openUpdates,
          onOpenTimeSettings: openTimeSettings,
          onOpenCalendarSettings: openCalendarSettings,
          onOpenLocalPaths: openLocalPaths,
          onOpenTeam: openTeam,
          onOpenDevices: openDevices,
        }}
        sheet={{
          onNewSession: newSession,
          schedule: {
            armed: reminders.armed,
            held: reminders.held,
            onCancel: reminders.cancel,
            onMode: reminders.mode,
            onMore: () => openSchedule(ui.open),
          },
          question: (item, detail) => {
            const asked = questions.mount(item, detail) && <SheetQuestion questions={questions} />
            // a secret the session waits for (#273) comes first: it holds the session until filled in
            return secretsOf(item).length ? (
              <>
                <SecretRequests item={item} />
                {asked}
              </>
            ) : (
              asked
            )
          },
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
          onPin: todos.pin,
        }}
      />
      <LimitsPop
        anchor={limitsAnchor}
        unified
        setup={setup}
        onBackup={adminHere() ? openBackup : undefined}
        onWake={() => setWake(true)}
      />
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
      {data?.calendar && <Reminders onOpen={showEvent} />}
      <Toasts />
    </>
  )
}
