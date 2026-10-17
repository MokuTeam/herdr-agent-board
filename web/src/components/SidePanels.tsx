// The three side panels, one open at a time in their shared place: the session sheet, the
// categories and the schedule (Task 26; until then their bodies are the empty containers of
// today's page).
import { useT } from '../i18n/I18nProvider.tsx'
import { Panel } from './panel/Panel.tsx'
import { Sheet, type SheetSlots } from './sheet/Sheet.tsx'

export interface SidePanelsProps {
  categories: boolean
  schedule: boolean
  onCategoriesClose(): void
  onScheduleClose(): void
  /** What the page hands the session sheet. */
  sheet?: SheetSlots
}

export function SidePanels({ categories, schedule, onCategoriesClose, onScheduleClose, sheet }: SidePanelsProps) {
  const t = useT()
  return (
    <>
      <Sheet {...sheet} />
      <Panel
        id="cats-sheet"
        kind="categories"
        open={categories}
        onClose={onCategoriesClose}
        title={
          <>
            <h2>{t('cats.title')}</h2>
            <p className="sheet-meta">{t('cats.about')}</p>
          </>
        }
      >
        <div className="sheet-body cats-body">
          <div className="cats-list" id="cats-list" />
          <div id="cat-draft" />
        </div>
      </Panel>
      <Panel
        id="sched-sheet"
        kind="schedule"
        open={schedule}
        onClose={onScheduleClose}
        title={
          <>
            <h2>{t('sched.title')}</h2>
            <p className="sheet-meta">{t('sched.about')}</p>
          </>
        }
      >
        <div className="sheet-body sched-body" id="sched-body" />
      </Panel>
    </>
  )
}
