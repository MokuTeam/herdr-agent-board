// The archive's panel: sessions taken off the board, by the day they went, newest first, with a
// search over the name, lane, folder, what the card said last and the day. Return brings one back;
// the trash can removes its record (two clicks), never Claude's conversation. On top, while
// sleeping sessions pile up in "Idle", a quiet offer to take them along. Read from the server when
// the panel opens and again whenever the board changes while it is open (hooks/useArchive.ts);
// rows that come in while it is open materialize. With more than one profile shown, a row carries
// its session's profile tag, as its card did.
import { Fragment, type KeyboardEvent, useLayoutEffect, useRef } from 'react'
import { type PublicArchiveRecord, searchArchive } from '../../../../src/core/archive.ts'
import type { BoardCategory } from '../../../../src/core/payload.ts'
import type { Translator } from '../../../../src/core/types.ts'
import type { Archive } from '../../hooks/useArchive.ts'
import { appear } from '../../hooks/useFlip.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { archiveDayText, archiveGroups, archiveRowView } from '../../models/archive-view.ts'
import { categoryInfo } from '../../models/board-view.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { ArchiveGlyph, BackGlyph, MoonGlyph, SearchIcon, SpinGlyph, TrashGlyph } from '../icons.tsx'
import { ProfileTag } from '../ProfileTag.tsx'
import { Panel } from '../panel/Panel.tsx'

/** The days a tidy-up from the panel's offer takes: sessions asleep three days or more. */
export const OFFER_DAYS = 3

export function ArchivePanel({ archive }: { archive: Archive }) {
  const t = useT()
  const { data, canMutate, canEdit } = useBoardContext()
  const body = useRef<HTMLDivElement>(null)
  const { panel } = archive
  // Drawn from the first opening on; closed, it keeps what it showed while it slides out.
  const drawn = panel.opened > 0
  const sleepy = drawn && !panel.query ? archive.tidyItems(OFFER_DAYS).length : 0

  // New rows materialize; on opening the panel its own slide is motion enough.
  const seen = useRef<{ opened: number; keys: ReadonlySet<string> } | null>(null)
  useLayoutEffect(() => {
    const el = body.current
    if (!el || !panel.open) {
      seen.current = null
      return
    }
    const rows = [...el.querySelectorAll<HTMLElement>('.arch-row')]
    const keys = new Set(rows.map(row => row.dataset.key ?? ''))
    const before = seen.current?.opened === panel.opened ? seen.current.keys : null
    if (before) for (const row of rows) if (!before.has(row.dataset.key ?? '')) appear(row)
    seen.current = { opened: panel.opened, keys }
  })

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>): void {
    // Esc clears the search first, then (again) closes the panel.
    if (e.key !== 'Escape' || !e.currentTarget.value) return
    archive.setQuery('')
    e.stopPropagation()
    e.nativeEvent.stopImmediatePropagation()
  }

  return (
    <Panel
      id="archive-sheet"
      kind="archive"
      open={panel.open}
      onClose={archive.closePanel}
      title={
        <>
          <h2>{t('archive.title')}</h2>
          <p className="sheet-meta">{t('archive.about')}</p>
        </>
      }
    >
      <div className="archive-find">
        <label className="search">
          <SearchIcon />
          <input
            id="archive-search"
            type="search"
            placeholder={t('archive.search')}
            aria-label={t('archive.search')}
            autoComplete="off"
            spellCheck={false}
            value={panel.query}
            onChange={e => archive.setQuery(e.currentTarget.value)}
            onKeyDown={onSearchKey}
          />
        </label>
      </div>
      <div className="sheet-body archive-body" id="archive-body" ref={body}>
        {drawn && (
          <ArchiveBody
            records={panel.records}
            query={panel.query}
            sleepy={sleepy}
            returning={panel.returning}
            armed={panel.armed}
            canMutate={canMutate}
            canEdit={canEdit}
            categories={data?.categories ?? []}
            t={t}
            onReturn={key => void archive.returnSessions([key])}
            onTidy={days => void archive.archiveMany(archive.tidyItems(days).map(i => i.key))}
            onRemove={(key, row) => void archive.remove(key, row)}
          />
        )}
      </div>
    </Panel>
  )
}

export interface ArchiveBodyProps {
  records: readonly PublicArchiveRecord[]
  query: string
  /** Sleeping sessions in "Idle" the offer's tidy-up takes (none while searching). */
  sleepy: number
  returning: ReadonlySet<string>
  armed: string | null
  canMutate: boolean
  canEdit: boolean
  categories: readonly BoardCategory[]
  t: Translator
  /** The days are against it (the board's clock). */
  now?: number
  onReturn?: (key: string) => void
  onTidy?: (days: number) => void
  onRemove?: (key: string, row: HTMLElement | null) => void
}

/** What #archive-body shows: the tidy-up's offer, the archive by day, or why it is empty. */
export function ArchiveBody(props: ArchiveBodyProps) {
  const { records, query, sleepy, t, now = Date.now() } = props
  const list = searchArchive([...records], query, {
    laneTitle: id => categoryInfo([...props.categories], id).title,
    dayText: archiveDayText(t, now),
  })
  return (
    <>
      {sleepy > 0 && (
        <div className="arch-tidy">
          <MoonGlyph />
          <span>{t('archive.tidy.suggest', { n: sleepy })}</span>
          <button
            type="button"
            className="button"
            data-arch-tidy={OFFER_DAYS}
            disabled={!props.canMutate}
            onClick={() => props.onTidy?.(OFFER_DAYS)}
          >
            {t('archive.tidy.go')}
          </button>
        </div>
      )}
      {!records.length ? (
        <div className="sched-empty arch-empty">
          <ArchiveGlyph />
          <p>{t('archive.empty')}</p>
          <p className="hint">{t('archive.emptyHint')}</p>
        </div>
      ) : (
        !list.length && (
          <div className="sched-empty arch-empty">
            <p>{t('archive.noMatch')}</p>
          </div>
        )
      )}
      {archiveGroups(list, t, now).map(group => (
        <Fragment key={`${group.title} ${group.records[0]?.key}`}>
          <div className="section-title">{group.title}</div>
          <div className="group arch-group">
            {group.records.map(r => (
              <ArchiveRow key={r.key} record={r} {...props} />
            ))}
          </div>
        </Fragment>
      ))}
    </>
  )
}

function ArchiveRow({ record, ...props }: ArchiveBodyProps & { record: PublicArchiveRecord }) {
  const { t } = props
  const row = archiveRowView(record, {
    t,
    categories: props.categories,
    returning: props.returning.has(record.key),
    armed: props.armed === record.key,
    canMutate: props.canMutate,
    canEdit: props.canEdit,
  })
  return (
    <div className={row.returning ? 'arch-row returning' : 'arch-row'} data-key={row.key}>
      <div className="arch-main">
        <div className="arch-top">
          <span className="arch-name" style={{ '--lane': row.color }}>
            {row.name}
          </span>
          <ProfileTag item={record} picked="all" />
          <span className="arch-when" title={row.whenTitle}>
            {row.when}
          </span>
        </div>
        {row.note && <div className="arch-note">{row.note}</div>}
        <div className="arch-meta">
          <span className="arch-where" title={row.cwd}>
            {row.where}
          </span>
          {row.extra && (
            <span className="arch-extra" title={row.extraTitle ?? undefined}>
              {row.extra}
            </span>
          )}
        </div>
      </div>
      <div className="arch-actions">
        <button
          type="button"
          className="button arch-return"
          data-arch-return={row.key}
          title={t('archive.returnHint')}
          disabled={row.returnDisabled}
          onClick={() => props.onReturn?.(row.key)}
        >
          {row.returning ? <SpinGlyph /> : <BackGlyph />}
          <span>{t(row.returning ? 'archive.returning' : 'archive.return')}</span>
        </button>
        <button
          type="button"
          className="sched-x"
          data-arch-remove={row.key}
          data-confirm={row.armed ? '' : undefined}
          title={t('archive.removeHint')}
          aria-label={t(row.armed ? 'archive.removeConfirm' : 'archive.remove')}
          disabled={row.removeDisabled}
          onClick={e => props.onRemove?.(row.key, e.currentTarget.closest<HTMLElement>('.arch-row'))}
        >
          <TrashGlyph />
          <span>{row.armed ? t('archive.removeConfirm') : ''}</span>
        </button>
      </div>
    </div>
  )
}
