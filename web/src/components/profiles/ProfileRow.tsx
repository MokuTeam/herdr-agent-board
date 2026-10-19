// One Claude profile in the Profiles panel, drawn as a lane is in the categories panel: its color,
// its name (saved when the field is left or on Enter, Escape puts it back), its sessions now,
// Shown or Hidden, and under them its folder, which is only read, and "Folder not found" when it
// is gone, then its start command, saved as the name is. Renaming or hiding never changes its id
// or its folder.
import { type ChangeEvent, type FocusEvent, type KeyboardEvent, useRef, useState } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import { commandEdited, type ProfileRowView, profileRenamed } from '../../models/profiles.ts'
import { classNames } from '../class-names.ts'

/** POST /api/profiles; true when it went through (a failure says why in a toast). */
export type ProfileEdit = (body: Record<string, unknown>) => Promise<boolean>

export interface ProfileRowProps {
  row: ProfileRowView
  disabled: boolean
  edit: ProfileEdit
  /** What is typed without a start command (`launch.claude`'s program): the field's placeholder. */
  program?: string
}

/** What is being typed: kept while the field has the focus, then until the board says another value. */
interface Typed {
  text: string
  focused: boolean
  /** The board's value when it was typed. */
  was: string
}

/**
 * A field of the row saved when it is left (Enter leaves it), Escape putting the board's value
 * (`board`) back. `changed` says what to send for what was typed, null for nothing; `save` sends it,
 * and a refusal (a toast says why) shows the board's value again.
 */
function useSavedField(
  board: string,
  changed: (board: string, value: string) => string | null,
  save: (next: string) => Promise<boolean>,
) {
  const [typing, setTyping] = useState<Typed | null>(null)
  const escaping = useRef(false)
  const typed = typing && (typing.focused || typing.was === board) ? typing : null
  return {
    value: typed?.text ?? board,
    onFocus: () => setTyping({ text: typed?.text ?? board, focused: true, was: board }),
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      setTyping({ text: e.currentTarget.value, focused: true, was: board }),
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') e.currentTarget.blur()
      if (e.key === 'Escape') {
        e.stopPropagation()
        escaping.current = true
        e.currentTarget.blur()
      }
    },
    onBlur: (e: FocusEvent<HTMLInputElement>) => {
      // Escape put the board's value back: nothing to save.
      const value = escaping.current ? board : e.currentTarget.value
      escaping.current = false
      const next = changed(board, value)
      if (next === null) {
        setTyping(null)
        return
      }
      setTyping({ text: value, focused: false, was: board })
      void save(next).then(ok => {
        if (!ok) setTyping(null)
      })
    },
  }
}

export function ProfileRow({ row, disabled, edit, program = 'claude' }: ProfileRowProps) {
  const t = useT()
  const name = useSavedField(row.title, profileRenamed, title => edit({ op: 'update', id: row.id, title }))
  const command = useSavedField(row.command, commandEdited, command => edit({ op: 'update', id: row.id, command }))
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
          value={name.value}
          disabled={disabled}
          onFocus={name.onFocus}
          onChange={name.onChange}
          onKeyDown={name.onKeyDown}
          onBlur={name.onBlur}
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
      <label className="profile-command">
        <span>{t('prof.command')}</span>
        <input
          className="path-add profile-command-field"
          spellCheck={false}
          aria-label={t('prof.command')}
          placeholder={program}
          value={command.value}
          disabled={disabled}
          onFocus={command.onFocus}
          onChange={command.onChange}
          onKeyDown={command.onKeyDown}
          onBlur={command.onBlur}
        />
      </label>
    </div>
  )
}
