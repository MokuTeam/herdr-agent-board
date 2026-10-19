// One Claude profile in the Profiles panel, drawn as a lane is in the categories panel: its color,
// its name (saved when the field is left or on Enter, Escape puts it back), its sessions now,
// Shown or Hidden, and under them its folder, which is only read, and "Folder not found" when it
// is gone. Renaming or hiding never changes its id or its folder.
import { useRef, useState } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import { type ProfileRowView, profileRenamed } from '../../models/profiles.ts'
import { classNames } from '../class-names.ts'

/** POST /api/profiles; true when it went through (a failure says why in a toast). */
export type ProfileEdit = (body: Record<string, unknown>) => Promise<boolean>

export interface ProfileRowProps {
  row: ProfileRowView
  disabled: boolean
  edit: ProfileEdit
}

/** The name being typed: kept while the field has the focus, then until the board says another name. */
interface NameEdit {
  text: string
  focused: boolean
  /** The board's name when it was typed. */
  was: string
}

export function ProfileRow({ row, disabled, edit }: ProfileRowProps) {
  const t = useT()
  const [name, setName] = useState<NameEdit | null>(null)
  const escaping = useRef(false)
  const typed = name && (name.focused || name.was === row.title) ? name : null
  // The one pressed already: nothing to send.
  const hide = (hidden: boolean) => {
    if (hidden !== !row.shown) void edit({ op: 'update', id: row.id, hidden })
  }

  return (
    <div
      className={classNames('cat-row', 'prof-row', !row.shown && 'hidden-profile')}
      data-id={row.id}
      style={{ '--lane': row.color }}
    >
      <div className="cat-main">
        <span className="swatch" />
        <input
          className="cat-title"
          spellCheck={false}
          aria-label={t('prof.name')}
          value={typed?.text ?? row.title}
          disabled={disabled}
          onFocus={() => setName({ text: typed?.text ?? row.title, focused: true, was: row.title })}
          onChange={e => setName({ text: e.currentTarget.value, focused: true, was: row.title })}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              e.stopPropagation()
              escaping.current = true
              e.currentTarget.blur()
            }
          }}
          onBlur={e => {
            // Escape put the name back: nothing to save.
            const value = escaping.current ? row.title : e.currentTarget.value
            escaping.current = false
            const next = profileRenamed(row.title, value)
            if (!next) {
              setName(null)
              return
            }
            setName({ text: value, focused: false, was: row.title })
            // Refused (a toast says why): the board's name again.
            void edit({ op: 'update', id: row.id, title: next }).then(ok => {
              if (!ok) setName(null)
            })
          }}
        />
        <span className="cat-count">{row.sessions}</span>
        <span className="profile-shown">
          <button type="button" aria-pressed={row.shown} disabled={disabled} onClick={() => hide(false)}>
            {t('prof.shown')}
          </button>
          <button type="button" aria-pressed={!row.shown} disabled={disabled} onClick={() => hide(true)}>
            {t('prof.hidden')}
          </button>
        </span>
      </div>
      <div className="cat-sub">
        <span className="profile-dir" title={row.dir}>
          {row.dir}
        </span>
        {row.missing && <span className="profile-missing">{t('prof.missing')}</span>}
      </div>
    </div>
  )
}
