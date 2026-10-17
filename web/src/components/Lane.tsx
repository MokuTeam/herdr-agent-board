// One lane of the board: its tag and count, a "new session here" button, and its cards in the
// columns. Empty or filtered lanes stay in the page, hidden by the stylesheet (a drag shows
// the empty ones as drop places).
import type { ReactNode } from 'react'
import type { Item } from '../../../src/core/types.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import type { DropLit, LaneView } from '../models/board-view.ts'
import { COLUMN_COLORS } from '../models/toolbar.ts'
import { classNames } from './class-names.ts'
import { PlusIcon } from './icons.tsx'

/** Where a new session starts: in a lane, or by a session (its lane and folder: the sheet's "New here"). */
export type NewSessionContext = { category?: string; item?: Item }

export interface LaneProps {
  lane: LaneView
  /** The lane or column lit up as the drop place of a drag. */
  lit: DropLit | null
  /** New sessions go through herdr: they wait for fresh data like going to a session does. */
  canMutate: boolean
  onNewSession(ctx: NewSessionContext, from: HTMLElement): void
  renderCard(item: Item): ReactNode
}

export function Lane({ lane, lit, canMutate, onNewSession, renderCard }: LaneProps) {
  const t = useT()
  const litHere = lit?.lane === lane.id ? lit : null
  return (
    <section
      className={classNames(
        'lane',
        !lane.items.length && 'empty-lane',
        !lane.shown && 'filtered',
        litHere?.column === null && 'drop',
      )}
      data-cat={lane.id}
      style={{ '--lane': lane.color }}
    >
      <div className="lane-bar">
        <header className="lane-head">
          <span className="lane-tag">{lane.title}</span>
          <span className="lane-count">{lane.items.length || ''}</span>
        </header>
        <button
          type="button"
          className="lane-new"
          title={t(canMutate ? 'launch.inLane' : 'mobile.readOnly')}
          aria-label={t('launch.inLane')}
          disabled={!canMutate}
          onClick={e => onNewSession({ category: lane.id }, e.currentTarget)}
        >
          <PlusIcon />
        </button>
      </div>
      <div className="lane-grid">
        {lane.columns.map(col => (
          <div
            key={col.id}
            className={classNames('col', col.items.length > 0 && 'has-cards', litHere?.column === col.id && 'drop')}
            data-col={col.id}
          >
            {/* The column's title for a narrow window, where the columns stack; it stays first. */}
            <div className="col-label">
              <span className="dot" style={{ '--c': COLUMN_COLORS[col.id] }} />
              {t(`col.${col.id}`)}
            </div>
            {col.items.map(renderCard)}
          </div>
        ))}
      </div>
    </section>
  )
}
