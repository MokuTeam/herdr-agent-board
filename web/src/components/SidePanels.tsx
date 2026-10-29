// The side panels, one open at a time in their shared place: the session sheet, the categories,
// the schedule, the archive and, with more than one Claude profile folder found, the profiles; sleep
// and wake while the payload carries its state line; the phones while the remote mode is on;
// MokuPilot always; tasks while the board has them on (#202); Team while the payload carries teamRev (#231,
// local page only); Remote access, Backup and Time tracking once each was first opened, on the local
// board. A session sheet that fails to draw says so
// on its own and leaves the board; opening another session tries again.
import type { Archive } from '../hooks/useArchive.ts'
import { offersProfiles } from '../models/profiles.ts'
import { offersTeam } from '../models/team.ts'
import { isWakeView } from '../models/wake.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { AccessPanel, type AccessPanelProps } from './access/AccessPanel.tsx'
import { ArchivePanel } from './archive/ArchivePanel.tsx'
import { BackupPanel, type BackupPanelProps } from './backup/BackupPanel.tsx'
import { CategoriesPanel, type CategoriesPanelProps } from './categories/CategoriesPanel.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { MokupilotPanel, type MokupilotPanelProps } from './mokupilot/MokupilotPanel.tsx'
import { PhonesPanel, type PhonesPanelProps } from './phones/PhonesPanel.tsx'
import { ProfilesPanel, type ProfilesPanelProps } from './profiles/ProfilesPanel.tsx'
import { SchedulePanel, type SchedulePanelProps } from './schedule/SchedulePanel.tsx'
import { Sheet, type SheetSlots } from './sheet/Sheet.tsx'
import { TeamPanel, type TeamPanelProps } from './team/TeamPanel.tsx'
import { TimePanel, type TimePanelProps } from './time/TimePanel.tsx'
import { TimeSettingsPanel, type TimeSettingsPanelProps } from './time/TimeSettingsPanel.tsx'
import { TodosPanel, type TodosPanelProps } from './todos/TodosPanel.tsx'
import { WakePanel, type WakePanelProps } from './wake/WakePanel.tsx'

export interface SidePanelsProps {
  categories: CategoriesPanelProps
  schedule: SchedulePanelProps
  /** Settings → Profiles…; drawn only with more than one profile folder (models/profiles.ts offersProfiles). */
  profiles?: ProfilesPanelProps
  /** Settings → Sleep and wake…; drawn only while the payload carries wake's state line. */
  wake?: WakePanelProps
  /** Settings → Phones…; drawn only while the remote mode is on (the payload's `remote`). */
  phones?: PhonesPanelProps
  /** Settings → MokuPilot…; drawn when given (the page gives it once opened; offered always, models/settings-menu.ts offersMokupilot). */
  mokupilot?: MokupilotPanelProps
  /** Settings → Remote access…; drawn when given (the page gives it once opened, on the local board only). */
  access?: AccessPanelProps
  /** What the page hands the session sheet. */
  sheet?: SheetSlots
  /** The archive's panel (hooks/useArchive.ts); none: not drawn. */
  archive?: Archive
  /** Tasks (#202): drawn while the board has them on. */
  todos?: TodosPanelProps
  /** Settings → Backup… (#233); drawn when given (the page gives it once opened, on the local board only). */
  backup?: BackupPanelProps
  /** Time (#233): drawn while the board has time tracking on. */
  time?: TimePanelProps
  /** Settings → Time tracking… (#237); drawn when given (the page gives it once opened, on the local board only). */
  timeSettings?: TimeSettingsPanelProps
  /** Settings → Team… (#231): given by the page while it offers it (the local page, the payload's teamRev). */
  team?: TeamPanelProps
}

export function SidePanels({
  categories,
  schedule,
  profiles,
  wake,
  phones,
  mokupilot,
  access,
  sheet,
  archive,
  todos,
  backup,
  time,
  timeSettings,
  team,
}: SidePanelsProps) {
  const { data, ui, dispatch } = useBoardContext()
  return (
    <>
      <ErrorBoundary scope="panel" resetKey={ui.open} onClose={() => dispatch({ type: 'open', key: null })}>
        <Sheet {...sheet} />
      </ErrorBoundary>
      <CategoriesPanel {...categories} />
      <SchedulePanel {...schedule} />
      {archive && <ArchivePanel archive={archive} />}
      {profiles && offersProfiles(data?.profiles) && <ProfilesPanel {...profiles} />}
      {wake && isWakeView(data?.wake) && <WakePanel {...wake} />}
      {phones && data?.remote && <PhonesPanel {...phones} />}
      {mokupilot && <MokupilotPanel {...mokupilot} />}
      {access && <AccessPanel {...access} />}
      {todos && data?.todos && <TodosPanel {...todos} />}
      {backup && <BackupPanel {...backup} />}
      {time && data?.time && <TimePanel {...time} />}
      {timeSettings && <TimeSettingsPanel {...timeSettings} />}
      {team && offersTeam(data) && <TeamPanel {...team} />}
    </>
  )
}
