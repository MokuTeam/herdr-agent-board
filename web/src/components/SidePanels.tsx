// The three side panels, one open at a time in their shared place: the session (its sheet comes in
// Task 25b), the categories and the schedule (Task 26). Until then their bodies are the empty
// containers of today's page.
import { useT } from '../i18n/I18nProvider.tsx'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { Panel } from './panel/Panel.tsx'

export interface SidePanelsProps {
  categories: boolean
  schedule: boolean
  onCategoriesClose(): void
  onScheduleClose(): void
}

/** The board's card of `key` (a drag's ghost is outside the board). */
function cardOf(key: string | null): HTMLElement | null {
  if (!key) return null
  const cards = document.getElementById('board')?.querySelectorAll<HTMLElement>('.card[data-key]') ?? []
  return [...cards].find(card => card.dataset.key === key) ?? null
}

export function SidePanels({ categories, schedule, onCategoriesClose, onScheduleClose }: SidePanelsProps) {
  const t = useT()
  const { ui, dispatch } = useBoardContext()
  return (
    <>
      <Panel
        id="sheet"
        kind="session"
        open={ui.open !== null}
        onClose={() => dispatch({ type: 'open', key: null })}
        about={() => cardOf(ui.open)}
        title={
          <>
            <span className="status-pill" id="sheet-status" />
            {/* biome-ignore lint/a11y/useHeadingContent: the session's name goes here (Task 25b), as in today's page */}
            <h2 id="sheet-name" />
            <p className="sheet-meta" id="sheet-meta" />
          </>
        }
      >
        <div className="sheet-body" id="sheet-body" />
      </Panel>
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
