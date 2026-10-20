// One lane in the categories editor: its handle (drag to reorder: hooks/useRowReorder.ts), its
// color (a click opens the swatches), its title (saved when the field is left), how many sessions
// are in it, delete (the first click asks), its id, the folders that sort sessions in with the
// field that adds one (the new-session window's folder field: lane-folder.ts) and, with two
// profiles or more shown, its usual profile on a line of its own under them (a lane's + preselects
// it in the new-session window). A lane an agent made up, not in the settings, can only be added
// to them.
import { type FocusEvent, type KeyboardEvent, type Ref, useLayoutEffect, useRef, useState } from 'react'
import type { BoardCategory, Swatch } from '../../../../src/core/payload.ts'
import { launchApi } from '../../api/launch.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  confirmText,
  type FolderSources,
  renamed,
  rowText,
  swatchPressed,
  usualOptions,
  withoutPath,
} from '../../models/categories.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { useStore } from '../../state/store.ts'
import { classNames } from '../class-names.ts'
import { GripGlyph, TrashGlyph } from '../icons.tsx'
import { FolderColumns, type FolderHandlers, FolderInput, FolderPop, Note } from '../launch/FolderPicker.tsx'
import type { FieldNote, FolderView } from '../launch/folder-field.ts'
import { laneFolder } from './lane-folder.ts'

/** POST /api/categories; true when it went through (a failure says why in a toast). */
export type CategoryEdit = (body: Record<string, unknown>) => Promise<boolean>

export interface CategoryRowProps {
  category: BoardCategory
  /** Sessions in the lane now. */
  count: number
  swatches: Swatch[]
  disabled: boolean
  paletteOpen: boolean
  /** The color button: the panel opens this row's swatches (and closes the others). */
  onSwatch(): void
  /** A swatch was picked: the swatches close. */
  onPicked(): void
  edit: CategoryEdit
  /** What its usual profile can be (models/categories.ts profileChoices); null: no such field. */
  profiles: { id: string; title: string }[] | null
  /** What its "+ folder" offers from while it is empty. */
  folders: FolderSources
}

/** The title being typed: kept while the field has the focus, then until the board says anything new of the lane. */
interface TitleEdit {
  text: string
  focused: boolean
  base: BoardCategory
}

/** How long delete asks before it asks no more. */
const CONFIRM_MS = 4000

export function CategoryRow({ category: c, count, edit, onPicked, folders, ...rest }: CategoryRowProps) {
  const t = useT()
  const { toast } = useBoardContext()
  const [asking, setAsking] = useState<string | null>(null)
  const [title, setTitle] = useState<TitleEdit | null>(null)
  const row = useRef<HTMLDivElement>(null)
  const latest = useLatest({ c, t, folders, edit })
  const [lane] = useState(() =>
    laneFolder({
      t: () => latest.current.t,
      dirs: launchApi.dirs,
      category: () => latest.current.c,
      folders: () => latest.current.folders,
      edit: body => latest.current.edit(body),
      find: selector => row.current?.querySelector<HTMLElement>(selector) ?? null,
    }),
  )
  const folder = useStore(lane.folder.view)
  const { note } = useStore(lane.view)
  // Drawn: focus and scrolling that waited for the draw are done.
  useLayoutEffect(() => lane.afterDraw())
  // A swatch picked shows at once, until the board says anything new of the lane.
  const [picked, setPicked] = useState<{ hex: string; base: BoardCategory } | null>(null)
  const escaping = useRef(false)
  const typed = title && (title.focused || title.base === c) ? title : null
  const q = (s: string) => t('q', { s })

  return (
    <CategoryRowView
      {...rest}
      category={c}
      count={count}
      lane={picked?.base === c ? picked.hex : c.color}
      title={typed?.text ?? c.title}
      folder={folder}
      note={note}
      asking={asking}
      rowRef={row}
      on={{
        pick(s) {
          setPicked({ hex: s.hex, base: c })
          onPicked()
          void edit({ op: 'update', id: c.id, color: s.name })
        },
        removePath: p => void edit({ op: 'update', id: c.id, paths: withoutPath(c, p) }),
        add: () => void edit({ op: 'create', id: c.id, title: c.title }),
        async remove() {
          if (asking) {
            setAsking(null)
            if (await edit({ op: 'delete', id: c.id })) toast(t('cat.deleted', { title: q(c.title) }))
            return
          }
          // Destructive: the first click only asks.
          setAsking(confirmText(count, t))
          setTimeout(() => setAsking(null), CONFIRM_MS)
        },
        titleFocus: () => setTitle({ text: typed?.text ?? c.title, focused: true, base: c }),
        titleChange: text => setTitle({ text, focused: true, base: c }),
        titleKey(e) {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.stopPropagation()
            escaping.current = true
            e.currentTarget.blur()
          }
        },
        titleBlur(e) {
          // Escape put the title back: nothing to save.
          const value = escaping.current ? c.title : e.currentTarget.value
          escaping.current = false
          const next = renamed(c, value)
          if (!next) {
            setTitle(null)
            return
          }
          setTitle({ text: value, focused: false, base: c })
          void edit({ op: 'update', id: c.id, title: next })
        },
        profile: id => void edit({ op: 'update', id: c.id, profile: id }),
        folder: lane,
      }}
    />
  )
}

export interface RowHandlers {
  pick(s: Swatch): void
  removePath(path: string): void
  add(): void
  remove(): void
  titleFocus(): void
  titleChange(text: string): void
  titleKey(e: KeyboardEvent<HTMLInputElement>): void
  titleBlur(e: FocusEvent<HTMLInputElement>): void
  /** A usual profile picked: its id, or '' for none. */
  profile(id: string): void
  /** Its "+ folder" (lane-folder.ts). */
  folder: FolderHandlers
}

export interface CategoryRowViewProps {
  category: BoardCategory
  count: number
  swatches: Swatch[]
  disabled: boolean
  paletteOpen: boolean
  /** Its color on screen (a swatch just picked, until the board says so). */
  lane: string
  /** What the title field shows. */
  title: string
  /** Its "+ folder" as drawn, and the note under it. */
  folder: FolderView
  note: FieldNote
  /** Delete asks: its text ("Delete? 2 sessions go by folder"). */
  asking: string | null
  /** What its usual profile can be; null: no such field, as before profiles. */
  profiles: { id: string; title: string }[] | null
  onSwatch?: () => void
  on?: RowHandlers
  rowRef?: Ref<HTMLDivElement>
}

/** The row as drawn for one state. */
export function CategoryRowView(props: CategoryRowViewProps) {
  const {
    category: c,
    count,
    swatches,
    disabled,
    paletteOpen,
    lane,
    title,
    folder,
    note,
    asking,
    profiles,
    onSwatch,
    on,
    rowRef,
  } = props
  const t = useT()
  const text = rowText(c, count, t)
  return (
    <div
      className={classNames('cat-row', !c.configured && 'adhoc')}
      data-id={c.id}
      data-confirm={asking ? '1' : undefined}
      style={{ '--lane': lane }}
      ref={rowRef}
    >
      <div className="cat-main">
        <button
          type="button"
          className="handle"
          title={t('cat.handle')}
          aria-label={t('cat.order')}
          disabled={disabled}
        >
          <GripGlyph />
        </button>
        <button
          type="button"
          className="swatch"
          title={t('cat.color')}
          aria-label={t('cat.color')}
          disabled={disabled}
          onClick={() => onSwatch?.()}
        />
        <input
          className="cat-title"
          spellCheck={false}
          aria-label={t('cat.titleLabel')}
          value={title}
          readOnly={!c.configured}
          disabled={disabled}
          onFocus={() => on?.titleFocus()}
          onChange={e => on?.titleChange(e.currentTarget.value)}
          onKeyDown={e => on?.titleKey(e)}
          onBlur={e => on?.titleBlur(e)}
        />
        <span className="cat-count">{text.count}</span>
        <button
          type="button"
          className="cat-add button"
          hidden={c.configured}
          disabled={disabled}
          onClick={() => on?.add()}
        >
          {t('cat.add')}
        </button>
        <button
          type="button"
          className="cat-del"
          title={t('cat.delete')}
          hidden={!c.configured || c.fallback}
          disabled={disabled}
          onClick={() => on?.remove()}
        >
          <TrashGlyph />
          <span>{asking ?? ''}</span>
        </button>
      </div>
      <div className="cat-sub">
        <span className="cat-id">{text.id}</span>
        <span className="paths">
          {c.paths.map(p => (
            <span className="path" key={p}>
              <span>{p}</span>
              <button
                type="button"
                data-path={p}
                title={t('cat.pathRemove')}
                aria-label={t('file.remove')}
                disabled={disabled}
                onClick={() => on?.removePath(p)}
              >
                ×
              </button>
            </span>
          ))}
        </span>
        {c.configured && (
          <div className="cat-folder">
            <FolderInput
              view={folder}
              t={t}
              on={on?.folder}
              placeholder={t('cat.pathAdd')}
              inputClass="path-add"
              label={t('cat.pathAddLabel')}
              disabled={disabled}
            />
            <FolderPop view={folder} on={on?.folder} />
          </div>
        )}
      </div>
      {c.configured && (
        <>
          <Note field="cwd" note={note} />
          <FolderColumns view={folder} on={on?.folder} />
        </>
      )}
      {profiles && c.configured && (
        <label className="cat-profile">
          <span>{t('cat.profile')}</span>
          <select value={c.profile ?? ''} disabled={disabled} onChange={e => on?.profile(e.currentTarget.value)}>
            <option value="">{t('cat.profileNone')}</option>
            {usualOptions(profiles, c.profile).map(p => (
              <option key={p.id} value={p.id} disabled={p.off}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="palette" hidden={!paletteOpen}>
        {swatches.map(s => (
          <button
            type="button"
            className="sw"
            key={s.name}
            data-color={s.name}
            style={{ '--sw': s.hex }}
            title={s.name}
            aria-pressed={swatchPressed(s, c)}
            disabled={disabled}
            onClick={() => on?.pick(s)}
          />
        ))}
      </div>
    </div>
  )
}
