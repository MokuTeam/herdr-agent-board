// The side panels, one open at a time in their shared place: the session sheet, the categories,
// the schedule and, with more than one Claude profile folder found, the profiles.
import { offersProfiles } from '../models/profiles.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { CategoriesPanel, type CategoriesPanelProps } from './categories/CategoriesPanel.tsx'
import { ProfilesPanel, type ProfilesPanelProps } from './profiles/ProfilesPanel.tsx'
import { SchedulePanel, type SchedulePanelProps } from './schedule/SchedulePanel.tsx'
import { Sheet, type SheetSlots } from './sheet/Sheet.tsx'

export interface SidePanelsProps {
  categories: CategoriesPanelProps
  schedule: SchedulePanelProps
  /** Settings → Profiles…; drawn only with more than one profile folder (models/profiles.ts offersProfiles). */
  profiles?: ProfilesPanelProps
  /** What the page hands the session sheet. */
  sheet?: SheetSlots
}

export function SidePanels({ categories, schedule, profiles, sheet }: SidePanelsProps) {
  const { data } = useBoardContext()
  return (
    <>
      <Sheet {...sheet} />
      <CategoriesPanel {...categories} />
      <SchedulePanel {...schedule} />
      {profiles && offersProfiles(data?.profiles) && <ProfilesPanel {...profiles} />}
    </>
  )
}
