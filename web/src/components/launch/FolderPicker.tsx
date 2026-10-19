// The launch window's folder field as drawn: the path field with its mark and Browse, the list
// under it, its note, and the columns to browse. What they do is folder-field.ts's.
import type { KeyboardEvent, ReactNode } from 'react'
import type { Translator } from '../../../../src/core/types.ts'
import type { FolderRow } from '../../models/launch.ts'
import { classNames } from '../class-names.ts'
import { BadIcon, ChevIcon, DriveIcon, FolderIcon, HomeIcon, OkIcon, WaitIcon } from '../icons.tsx'
import type { FolderField, FolderView } from './folder-field.ts'
import type { FieldNote } from './launch-window.ts'

const MARKS: Record<string, ReactNode> = { ok: <OkIcon />, bad: <BadIcon />, wait: <WaitIcon /> }
const ROW_ICONS: Record<FolderRow['icon'], ReactNode> = {
  home: <HomeIcon />,
  drive: <DriveIcon />,
  folder: <FolderIcon />,
}

/** What the field's parts do: the folder field's own handlers. */
export type FolderHandlers = Pick<
  FolderField,
  'input' | 'focus' | 'blur' | 'key' | 'takePop' | 'toggleBrowse' | 'pickRow' | 'closeBrowse' | 'rowKey'
>

/** A key as the field reads it, from React's. */
export const fieldKey = (e: KeyboardEvent<HTMLElement>) => ({
  key: e.key,
  isComposing: e.nativeEvent.isComposing,
  keyCode: e.keyCode,
  preventDefault: () => e.preventDefault(),
  stopPropagation: () => e.stopPropagation(),
})

export function Note({ field, note, className }: { field: string; note: FieldNote; className?: string }) {
  return (
    <p className={classNames('field-note', className, note.error && 'error')} data-for={field} hidden={note.hidden}>
      {note.text}
    </p>
  )
}

export function FolderPickerView({
  view,
  note,
  t,
  on,
}: {
  view: FolderView
  note: FieldNote
  t: Translator
  on: FolderHandlers
}) {
  return (
    <>
      <div className="row folder-row">
        <span className="row-label">{t('launch.folder')}</span>
        <div className="row-value folder-field">
          <input
            name="cwd"
            spellCheck={false}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={view.expanded}
            aria-controls="launch-pop"
            aria-activedescendant={view.activeId ?? undefined}
            placeholder={t('launch.folderPlaceholder')}
            value={view.text}
            onChange={e => on.input(e.currentTarget.value)}
            onFocus={() => on.focus()}
            onBlur={() => on.blur()}
            onKeyDown={e => on.key(fieldKey(e))}
          />
          <span className="folder-state" aria-hidden="true" data-state={view.state ?? undefined}>
            {view.state ? MARKS[view.state] : null}
          </span>
          <button
            type="button"
            className="folder-browse"
            aria-expanded={view.browse.open}
            onClick={() => on.toggleBrowse()}
          >
            {t('launch.browse')}
          </button>
        </div>
        {/* A press in the list keeps the focus in the field. */}
        <div
          className="folder-pop"
          id="launch-pop"
          role="listbox"
          hidden={view.pop.hidden}
          onPointerDown={e => e.preventDefault()}
        >
          {view.pop.items.map((x, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the field's arrows and Enter pick, as before (aria-activedescendant)
            // biome-ignore lint/a11y/useFocusableInteractive: as above: the focus stays in the field
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a line is its place in the list (data-i, its id)
              key={i}
              className={classNames('pop-item', view.pop.lit === i && 'active')}
              role="option"
              id={`launch-opt-${i}`}
              data-i={i}
              title={x.detail}
              onClick={() => on.takePop(i)}
            >
              <FolderIcon />
              <span className="pop-name">{x.label}</span>
              <span className="pop-detail">{x.why ?? x.detail}</span>
            </div>
          ))}
        </div>
      </div>
      <Note field="cwd" note={note} />
      <div className="folder-cols" hidden={!view.browse.open}>
        {view.browse.columns.map((col, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a column is its depth
          <div key={i} className="col-list" role="listbox" aria-label={col.label}>
            {col.rows.length ? (
              col.rows.map((x, j) => (
                <button
                  type="button"
                  // biome-ignore lint/suspicious/noArrayIndexKey: a row is its place in the column
                  key={j}
                  className={classNames('col-row', x.on && 'on')}
                  data-path={x.path}
                  data-col={i}
                  title={x.path}
                  onClick={() => on.pickRow(i, x.path)}
                  onDoubleClick={() => on.closeBrowse()}
                  onKeyDown={e => on.rowKey(e, i, j)}
                >
                  {ROW_ICONS[x.icon]}
                  <span>{x.name}</span>
                  {x.chev && <ChevIcon />}
                </button>
              ))
            ) : (
              <p className="col-empty">{col.empty}</p>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
