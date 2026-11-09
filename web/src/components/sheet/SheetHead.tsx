// The session sheet's title, compact so the conversation gets the room: one row that never moves
// (where the card shows, a pill opening a menu to change it; its name, a click, Enter or F2 renames
// it there; the helpers' count; the chevron that folds the rest), and under it the fold: the lane
// (a pill with a menu too), the pencil that shows the fields to fill, a star that keeps it among the
// favorites, a line with its workspace, last activity and context (the workspace's name renames the
// workspace there on a click, where the page can), and the card's fields that say something. The fold
// is open or folded as the sheet's density says (#345, models/sheet-density.ts). Before a session was
// ever open, the empty places of the page.
import { Fragment, type KeyboardEvent, type MouseEvent, useRef } from 'react'
import type { Item } from '../../../../src/core/types.ts'
import { useCollapse } from '../../hooks/useCollapse.ts'
import type { SheetPick } from '../../hooks/useContextMenus.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { categoryInfo, catOf, colOf } from '../../models/board-view.ts'
import { linkedSessions } from '../../models/helper-model.ts'
import { foldLine, sheetHead, type WorkspaceFact } from '../../models/sheet.ts'
import { COLUMN_COLORS } from '../../models/toolbar.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { ChevronGlyph, MoonGlyph, StarGlyph, UpDownGlyph, WriteGlyph } from '../icons.tsx'
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
  /** The star: into the favorites, or out of them. */
  onFavorite?: (() => void) | undefined
}

/** The helpers' count in the head's row, for the compact head (their strip gives way to it). */
export interface HeadHelpers {
  /** The helpers at work now, else the ones that ended: the number shown. */
  count: number
  running: boolean
  /** What it says to a screen reader: "Helpers: 2 at work, 10 finished". */
  label: string
  /** The helpers' window (the list), grown from the button. */
  onOpen(button: HTMLElement): void
}

/** The head's fold: shown whole, or folded under its one row. */
export interface HeadFold {
  compact: boolean
  onToggle?: (() => void) | undefined
  helpers?: HeadHelpers | undefined
}

export interface SheetHeadProps {
  item: Item | null
  missing: boolean
  /** Rename where the name is (hooks/useRenameInPlace.ts). */
  onRename?: ((name: HTMLElement) => void) | undefined
  /** Rename the session's herdr workspace where its name is; without it, the name is the line's text. */
  onRenameWorkspace?: ((name: HTMLElement) => void) | undefined
  card?: HeadCard | undefined
  fold?: HeadFold | undefined
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
const WHOLE: HeadFold = { compact: false }

export function SheetHead({
  item,
  missing,
  onRename,
  onRenameWorkspace,
  card = NO_CARD,
  fold: shape = WHOLE,
}: SheetHeadProps) {
  const t = useT()
  const { data, ui, now } = useBoardContext()
  const details = useRef<HTMLDivElement>(null)
  useCollapse(details, shape.compact, { rise: 8 })
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
  const reminders = schedules.filter(e => e.key === item.key).length
  const linked = linkedSessions(item, key => !!data?.items.some(i => i.key === key))
  const fields = card.open || !!item.doing || !!item.wait || reminders > 0 || linked.length > 0
  // On a phone (session-head.css) the fields fold into the line that matters most, and that line
  // opens them as the pencil does elsewhere, the empty ones to fill included; with nothing to show
  // it reads as the pencil's own words.
  const fold = foldLine(
    item,
    { sessions: linked.map(l => data?.items.find(i => i.key === l.key)?.name ?? l.key), reminders },
    t,
  ) ?? { label: t('sheet.properties'), text: '' }
  // A pill's menu out of it; a click with no pointer (detail 0) came from the keys.
  const pick = (kind: SheetPick) => (e: MouseEvent<HTMLButtonElement>) =>
    card.onPick?.(kind, e.currentTarget, e.detail === 0)
  const helpers = shape.helpers
  return (
    <>
      <div className="sheet-headline">
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
                  <span className="pill-label">{t('sheet.asleep')}</span>
                </>
              ) : (
                <>
                  <span className={`dot ${column}`} style={{ '--c': color }} />
                  <span className="pill-label">{t(`col.${column}`)}</span>
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
          <button
            type="button"
            className="sheet-favorite"
            id="sheet-favorite"
            aria-pressed={!!item.favorite}
            title={t(item.favorite ? 'menu.unfavorite' : 'menu.favorite')}
            aria-label={t(item.favorite ? 'menu.unfavorite' : 'menu.favorite')}
            disabled={locked}
            onClick={() => card.onFavorite?.()}
          >
            <StarGlyph />
          </button>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the name is where it is renamed, as before */}
        <h2 id="sheet-name" tabIndex={0} title={head.name} {...rename}>
          {head.name}
        </h2>
        {helpers && (
          <button
            type="button"
            className="sheet-helpers-chip"
            id="sheet-helpers-chip"
            title={helpers.label}
            aria-label={helpers.label}
            onClick={e => helpers.onOpen(e.currentTarget)}
          >
            <span
              className={`dot ${helpers.running ? 'work' : 'done'}`}
              style={{ '--c': COLUMN_COLORS[helpers.running ? 'work' : 'done'] }}
            />
            <span className="chip-count">{helpers.count}</span>
          </button>
        )}
        <button
          type="button"
          className="sheet-compact-toggle"
          id="sheet-compact-toggle"
          aria-expanded={!shape.compact}
          aria-controls="sheet-details sheet-helpers sheet-actions"
          title={t(shape.compact ? 'sheet.detailsShow' : 'sheet.detailsHide')}
          aria-label={t('sheet.details')}
          onClick={() => shape.onToggle?.()}
        >
          <ChevronGlyph />
        </button>
      </div>
      <div className="sheet-details" id="sheet-details" ref={details} data-folded={shape.compact ? '' : undefined}>
        <div className="sheet-details-inner">
          <p className="sheet-meta" id="sheet-meta" title={head.metaTitle}>
            {/* Each fact whole on its line: the line breaks between them, after a separator, never inside
                one. A narrow column stacks them, without the separators (session-head.css). */}
            {head.meta.map((part, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the facts in their order
              <Fragment key={i}>
                {i > 0 && <span className="sep"> · </span>}
                <Fact part={part} onRenameWorkspace={onRenameWorkspace} />
              </Fragment>
            ))}
          </p>
          <button
            type="button"
            className="sheet-fold"
            aria-expanded={card.open}
            aria-controls="sheet-card"
            onClick={() => card.onToggle?.()}
          >
            <span className="sheet-fold-label">{fold.label}</span>
            <span className="sheet-fold-text">{fold.text}</span>
            <ChevronGlyph />
          </button>
          <div className="sheet-card" id="sheet-card" hidden={!fields} data-folded={card.open ? undefined : ''}>
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
        </div>
      </div>
    </>
  )
}
