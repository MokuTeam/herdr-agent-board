// The launch window's folder field as drawn: the path field with its mark and Browse, the list
// under it, its note, and the columns to browse. What they do is folder-field.ts's. Its parts are
// drawn apart too, for a lane's "+ folder" in the categories panel (categories/CategoryRow.tsx).
import type { KeyboardEvent, ReactNode } from 'react'
import type { Translator } from '../../../../src/core/types.ts'
import type { FolderRow } from '../../models/launch.ts'
import { classNames } from '../class-names.ts'
import { BadIcon, ChevIcon, DriveIcon, FolderIcon, HomeIcon, OkIcon, WaitIcon } from '../icons.tsx'
import type { FieldKey, FieldNote, FolderView } from './folder-field.ts'

const MARKS: Record<string, ReactNode> = { ok: <OkIcon />, bad: <BadIcon />, wait: <WaitIcon /> }
const ROW_ICONS: Record<FolderRow['icon'], ReactNode> = {
  home: <HomeIcon />,
  drive: <DriveIcon />,
  folder: <FolderIcon />,
}

/** What the field's parts do: the folder field's own handlers (folder-field.ts), or a host's around them. */
export interface FolderHandlers {
  input(value: string): void
  focus(): void
  blur(): void
  key(e: FieldKey): void
  takePop(i: number): void
  toggleBrowse(): void
  pickRow(col: number, path: string): void
  chooseRow(): void
  /** A key on row `row` of column `col`; a host may stop one there (a lane's Escape). */
  rowKey(e: Pick<FieldKey, 'key' | 'preventDefault' | 'stopPropagation'>, col: number, row: number): void
}

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
        <FolderInput view={view} t={t} on={on} className="row-value" placeholder={t('launch.folderPlaceholder')} />
        <FolderPop view={view} on={on} />
      </div>
      <Note field="cwd" note={note} />
      <FolderColumns view={view} on={on} />
    </>
  )
}

export interface FolderInputProps {
  view: FolderView
  t: Translator
  /** None: drawn for a state alone. */
  on?: FolderHandlers | undefined
  /** Beside `folder-field`, the box's own classes. */
  className?: string
  placeholder: string
  /** The path field's own class and name for assistive technology, where no label says it. */
  inputClass?: string
  label?: string
  /** Off while the page cannot do what the field is for. */
  disabled?: boolean
}

/** The path field, the mark that says whether the folder is there, and Browse. */
export function FolderInput({ view, t, on, className, placeholder, inputClass, label, disabled }: FolderInputProps) {
  return (
    <div className={classNames(className, 'folder-field')}>
      <input
        name="cwd"
        className={inputClass}
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={view.expanded}
        aria-controls={`${view.id}-pop`}
        aria-activedescendant={view.activeId ?? undefined}
        aria-label={label}
        placeholder={placeholder}
        value={view.text}
        disabled={disabled}
        onChange={e => on?.input(e.currentTarget.value)}
        onFocus={() => on?.focus()}
        onBlur={() => on?.blur()}
        onKeyDown={e => on?.key(fieldKey(e))}
      />
      <span className="folder-state" aria-hidden="true" data-state={view.state ?? undefined}>
        {view.state ? MARKS[view.state] : null}
      </span>
      <button
        type="button"
        className="folder-browse"
        aria-expanded={view.browse.open}
        disabled={disabled}
        onClick={() => on?.toggleBrowse()}
      >
        {t('launch.browse')}
      </button>
    </div>
  )
}

/** The list under the field: suggestions, or the folders that match what is typed. */
export function FolderPop({ view, on }: { view: FolderView; on?: FolderHandlers | undefined }) {
  return (
    // A press in the list keeps the focus in the field.
    <div
      className="folder-pop"
      id={`${view.id}-pop`}
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
          id={`${view.id}-opt-${i}`}
          data-i={i}
          title={x.detail}
          onClick={() => on?.takePop(i)}
        >
          <FolderIcon />
          <span className="pop-name">{x.label}</span>
          <span className="pop-detail">{x.why ?? x.detail}</span>
        </div>
      ))}
    </div>
  )
}

/** The columns to browse, Finder style. */
export function FolderColumns({ view, on }: { view: FolderView; on?: FolderHandlers | undefined }) {
  return (
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
                onClick={() => on?.pickRow(i, x.path)}
                onDoubleClick={() => on?.chooseRow()}
                onKeyDown={e => on?.rowKey(e, i, j)}
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
  )
}
