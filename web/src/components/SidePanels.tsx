// The three side panels, one open at a time in their shared place: the session sheet, the
// categories and the schedule.
import { CategoriesPanel, type CategoriesPanelProps } from './categories/CategoriesPanel.tsx'
import { SchedulePanel, type SchedulePanelProps } from './schedule/SchedulePanel.tsx'
import { Sheet, type SheetSlots } from './sheet/Sheet.tsx'

export interface SidePanelsProps {
  categories: CategoriesPanelProps
  schedule: SchedulePanelProps
  /** What the page hands the session sheet. */
  sheet?: SheetSlots
}

export function SidePanels({ categories, schedule, sheet }: SidePanelsProps) {
  return (
    <>
      <Sheet {...sheet} />
      <CategoriesPanel {...categories} />
      <SchedulePanel {...schedule} />
    </>
  )
}
