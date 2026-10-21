// The side panels, one open at a time in their shared place: the session sheet, the categories,
// the schedule, the archive and, with more than one Claude profile folder found, the profiles; the
// phones while the remote mode is on; Remote access once it was first opened, on the local board.
import type { Archive } from '../hooks/useArchive.ts'
import { offersProfiles } from '../models/profiles.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { AccessPanel, type AccessPanelProps } from './access/AccessPanel.tsx'
import { ArchivePanel } from './archive/ArchivePanel.tsx'
import { CategoriesPanel, type CategoriesPanelProps } from './categories/CategoriesPanel.tsx'
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
  /** Settings → Remote access…; drawn when given (the page gives it once opened, on the local board only). */
  access?: AccessPanelProps
  /** What the page hands the session sheet. */
  sheet?: SheetSlots
  /** The archive's panel (hooks/useArchive.ts); none: not drawn. */
  archive?: Archive
}

export function SidePanels({ categories, schedule, profiles, phones, access, sheet, archive }: SidePanelsProps) {
  const { data } = useBoardContext()
  return (
    <>
      <Sheet {...sheet} />
      <CategoriesPanel {...categories} />
      <SchedulePanel {...schedule} />
      {archive && <ArchivePanel archive={archive} />}
      {profiles && offersProfiles(data?.profiles) && <ProfilesPanel {...profiles} />}
      {phones && data?.remote && <PhonesPanel {...phones} />}
      {access && <AccessPanel {...access} />}
    </>
  )
}
