// The session sheet's title: a pill with where the session is (or that it sleeps, or is gone), its
// name — a click, Enter or F2 renames it there — and a line with its lane, workspace, last
// activity and context; the workspace's name renames the workspace there on a click, where the
// page can. Before a session was ever open, the empty places of the page.
import { Fragment, type KeyboardEvent, type MouseEvent } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { categoryInfo, catOf } from '../../models/board-view.ts'
import { sheetHead, type WorkspaceFact } from '../../models/sheet.ts'
import { COLUMN_COLORS } from '../../models/toolbar.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { MoonGlyph } from '../icons.tsx'

export interface SheetHeadProps {
  item: Item | null
  missing: boolean
  /** Rename where the name is (hooks/useRenameInPlace.ts). */
  onRename?: ((name: HTMLElement) => void) | undefined
  /** Rename the session's herdr workspace where its name is; without it, the name is the line's text. */
  onRenameWorkspace?: ((name: HTMLElement) => void) | undefined
}

/** One fact of the line under the name: the workspace's name a button where it can be renamed. */
function Fact({
  part,
  onRenameWorkspace,
}: {
  part: string | WorkspaceFact
  onRenameWorkspace: ((name: HTMLElement) => void) | undefined
}) {
  const t = useT()
  if (typeof part === 'string') return <span>{part}</span>
  const { before, name, after } = part
  if (!onRenameWorkspace) return <span>{`${before}${name}${after}`}</span>
  return (
    <span>
      {before}
      <button
        type="button"
        className="sheet-workspace"
        id="sheet-workspace"
        title={t('menu.renameWorkspace')}
        onClick={e => onRenameWorkspace(e.currentTarget)}
      >
        {name}
      </button>
      {after}
    </span>
  )
}

export function SheetHead({ item, missing, onRename, onRenameWorkspace }: SheetHeadProps) {
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
        {/* Each fact whole on its line: the line breaks between them, after a separator, never inside one. */}
        {head.meta.map((part, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the facts in their order
          <Fragment key={i}>
            {i > 0 && ' · '}
            <Fact part={part} onRenameWorkspace={onRenameWorkspace} />
          </Fragment>
        ))}
      </p>
    </>
  )
}
