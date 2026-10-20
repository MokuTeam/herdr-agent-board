// The side panels, one open at a time in their shared place: the session sheet, the categories,
// the schedule, the archive and, with more than one Claude profile folder found, the profiles; the
// phones while the remote mode is on. A session sheet that fails to draw says so on its own and
// leaves the board; opening another session tries again.
import type { Archive } from '../hooks/useArchive.ts'
import { offersProfiles } from '../models/profiles.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { ArchivePanel } from './archive/ArchivePanel.tsx'
import { CategoriesPanel, type CategoriesPanelProps } from './categories/CategoriesPanel.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { PhonesPanel, type PhonesPanelProps } from './phones/PhonesPanel.tsx'
import { ProfilesPanel, type ProfilesPanelProps } from './profiles/ProfilesPanel.tsx'
import { SchedulePanel, type SchedulePanelProps } from './schedule/SchedulePanel.tsx'
import { Sheet, type SheetSlots } from './sheet/Sheet.tsx'

export interface SidePanelsProps {
  categories: CategoriesPanelProps
  schedule: SchedulePanelProps
  /** Settings → Profiles…; drawn only with more than one profile folder (models/profiles.ts offersProfiles). */
  profiles?: ProfilesPanelProps
  /** Settings → Phones…; drawn only while the remote mode is on (the payload's `remote`). */
  phones?: PhonesPanelProps
  /** What the page hands the session sheet. */
  sheet?: SheetSlots
  /** The archive's panel (hooks/useArchive.ts); none: not drawn. */
  archive?: Archive
}

export function SidePanels({ categories, schedule, profiles, phones, sheet, archive }: SidePanelsProps) {
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
      {phones && data?.remote && <PhonesPanel {...phones} />}
    </>
  )
}
