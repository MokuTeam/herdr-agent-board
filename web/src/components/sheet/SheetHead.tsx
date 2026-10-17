// The session sheet's title: a pill with where the session is (or that it sleeps, or is gone), its
// name — a click, Enter or F2 renames it there — and a line with its lane, workspace, last
// activity and context. Before a session was ever open, the empty places of the page.
import type { KeyboardEvent, MouseEvent } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { categoryInfo, catOf } from '../../models/board-view.ts'
import { sheetHead } from '../../models/sheet.ts'
import { COLUMN_COLORS } from '../../models/toolbar.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { MoonGlyph } from '../icons.tsx'

export interface SheetHeadProps {
  item: Item | null
  missing: boolean
  /** Rename where the name is (Task 27). */
  onRename?: ((name: HTMLElement) => void) | undefined
}

export function SheetHead({ item, missing, onRename }: SheetHeadProps) {
  const t = useT()
  const { data, ui, now } = useBoardContext()
  const rename = {
    onClick: (e: MouseEvent<HTMLElement>) => onRename?.(e.currentTarget),
    onKeyDown(e: KeyboardEvent<HTMLElement>) {
      if ((e.key !== 'Enter' && e.key !== 'F2') || !onRename) return
      e.preventDefault()
      onRename(e.currentTarget)
    },
  }
  if (!item)
    return (
      <>
        <span className="status-pill" id="sheet-status" />
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the name is where it is renamed, as before */}
        <h2 id="sheet-name" tabIndex={0} {...rename} />
        <p className="sheet-meta" id="sheet-meta" />
      </>
    )
  const categoryTitle = categoryInfo(data?.categories ?? [], catOf(ui.moves, item)).title
  const head = sheetHead(item, { missing, categoryTitle, now, t })
  const color = COLUMN_COLORS[item.column]
  return (
    <>
      <span className="status-pill" id="sheet-status" style={{ '--c': color }}>
        {head.pill.kind === 'missing' ? (
          t('detail.missingShort')
        ) : head.pill.kind === 'asleep' ? (
          <>
            <MoonGlyph />
            {t('sheet.asleep')}
          </>
        ) : (
          <>
            <span className={`dot ${item.column}`} style={{ '--c': color }} />
            {t(`col.${item.column}`)}
          </>
        )}
      </span>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the name is where it is renamed, as before */}
      <h2 id="sheet-name" tabIndex={0} title={head.name} {...rename}>
        {head.name}
      </h2>
      <p className="sheet-meta" id="sheet-meta" title={head.metaTitle}>
        {head.meta}
      </p>
    </>
  )
}
