// The session sheet's title, compact so the conversation gets the room: a row of pills (where the
// card shows and its lane, each opening a menu to change it; the pencil shows the fields to fill),
// its name (a click, Enter or F2 renames it there), a line with its workspace, last activity and
// context (the workspace's name renames the workspace there on a click, where the page can), and
// the card's fields that say something. Before a session was ever open, the empty places of the page.
import { Fragment, type KeyboardEvent, type MouseEvent } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import type { SheetPick } from '../../hooks/useContextMenus.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { categoryInfo, catOf, colOf } from '../../models/board-view.ts'
import { linkedSessions } from '../../models/helper-model.ts'
import { sheetHead, type WorkspaceFact } from '../../models/sheet.ts'
import { COLUMN_COLORS } from '../../models/toolbar.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { MoonGlyph, UpDownGlyph, WriteGlyph } from '../icons.tsx'
import type { ScheduleActions } from './ScheduleRow.tsx'
import { SheetCard } from './SheetCard.tsx'

/** The card's part of the head: its pills' menus and its fields. */
export interface HeadCard {
  /** Card edits cannot be made now: the pills open nothing, the fields do not take typing. */
  disabled: boolean
  /** The fields with nothing in them show too, to be filled. */
  open: boolean
  onToggle?: (() => void) | undefined
  /** The pill whose menu is open. */
  pickOpen?: SheetPick | null | undefined
  /** A pill's choices as a menu out of it (`keyboard`: pressed by keys, it lights its first item). */
  onPick?: ((kind: SheetPick, button: HTMLElement, keyboard: boolean) => void) | undefined
  schedule?: ScheduleActions | undefined
  /** A linked session's name: that session. */
  onSession?: ((key: string) => void) | undefined
}

export interface SheetHeadProps {
  item: Item | null
  missing: boolean
  /** Rename where the name is (hooks/useRenameInPlace.ts). */
  onRename?: ((name: HTMLElement) => void) | undefined
  /** Rename the session's herdr workspace where its name is; without it, the name is the line's text. */
  onRenameWorkspace?: ((name: HTMLElement) => void) | undefined
  card?: HeadCard | undefined
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

const NO_CARD: HeadCard = { disabled: true, open: false }

export function SheetHead({ item, missing, onRename, onRenameWorkspace, card = NO_CARD }: SheetHeadProps) {
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
  const lane = categoryInfo(data?.categories ?? [], catOf(ui.moves, item))
  // Where it shows on screen now: a move the board has not confirmed yet shows at once.
  const column = colOf(ui.moves, item)
  const head = sheetHead(item, { missing, now, t })
  const color = COLUMN_COLORS[column]
  const locked = card.disabled || missing
  // Nothing of the card's to show: its place folds away (the reminders as their row shows them, a
  // cancelled one while it folds).
  const schedules = (card.schedule?.held ? card.schedule.held.view.data : data)?.schedules ?? []
  const fields =
    card.open ||
    !!item.doing ||
    !!item.wait ||
    schedules.some(e => e.key === item.key) ||
    linkedSessions(item, key => !!data?.items.some(i => i.key === key)).length > 0
  // A pill's menu out of it; a click with no pointer (detail 0) came from the keys.
  const pick = (kind: SheetPick) => (e: MouseEvent<HTMLButtonElement>) =>
    card.onPick?.(kind, e.currentTarget, e.detail === 0)
  return (
    <>
      <div className="sheet-pills">
        {head.pill.kind === 'missing' ? (
          <span className="status-pill" id="sheet-status">
            {t('detail.missingShort')}
          </span>
        ) : (
          <button
            type="button"
            className="status-pill"
            id="sheet-status"
            style={{ '--c': color }}
            title={t('menu.status')}
            aria-haspopup="menu"
            aria-expanded={card.pickOpen === 'status'}
            disabled={locked}
            onClick={pick('status')}
          >
            {head.pill.kind === 'asleep' ? (
              <>
                <MoonGlyph />
                {t('sheet.asleep')}
              </>
            ) : (
              <>
                <span className={`dot ${column}`} style={{ '--c': color }} />
                {t(`col.${column}`)}
              </>
            )}
            <UpDownGlyph />
          </button>
        )}
        <button
          type="button"
          className="lane-pill"
          id="sheet-lane"
          style={{ '--lane': lane.color }}
          title={t('menu.category')}
          aria-haspopup="menu"
          aria-expanded={card.pickOpen === 'category'}
          disabled={locked}
          onClick={pick('category')}
        >
          <span>{lane.title}</span>
          <UpDownGlyph />
        </button>
        <button
          type="button"
          className="sheet-properties-toggle"
          id="sheet-properties-toggle"
          aria-expanded={card.open}
          aria-controls="sheet-card"
          title={t('sheet.properties')}
          aria-label={t('sheet.properties')}
          onClick={() => card.onToggle?.()}
        >
          <WriteGlyph />
        </button>
      </div>
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
      <div className="sheet-card" id="sheet-card" hidden={!fields}>
        {/* Each session's card fields start afresh: nothing typed for one shows in another's. */}
        <SheetCard
          key={item.key}
          item={item}
          open={card.open}
          disabled={locked}
          schedule={card.schedule}
          onSession={key => card.onSession?.(key)}
        />
      </div>
    </>
  )
}
