// The Profiles panel, opened from Settings → Profiles… (only with more than one profile folder
// found) and built like the categories panel: a row per Claude profile, a hint on what a start
// command does, then a folder a session reported that no profile has, a folder added from
// somewhere else, and Install for a shown profile whose settings.json lacks the board's hooks.
// Every change goes to config.json at once (POST /api/profiles) and comes back over the live
// stream; what the board refuses is toasted, and an Install that left wake's hooks out beside the
// separate herdr-wake plugin's says so (#119).
import { useCallback, useState } from 'react'
import { api, errorText } from '../../api/client.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { type ProfileRowView, profileRows, unknownFolders } from '../../models/profiles.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { Panel } from '../panel/Panel.tsx'
import { type ProfileEdit, ProfileRow } from './ProfileRow.tsx'

export interface ProfilesPanelProps {
  open: boolean
  onClose(): void
}

export function ProfilesPanel({ open, onClose }: ProfilesPanelProps) {
  const t = useT()
  const { data, canEdit, toast } = useBoardContext()
  const latest = useLatest({ canEdit, t, toast, profiles: data?.profiles })

  const edit: ProfileEdit = useCallback(
    async body => {
      const { canEdit, t, toast, profiles } = latest.current
      // The panel's controls are off while the board cannot edit.
      if (!canEdit) return false
      try {
        const reply = await api.post('/api/profiles', body)
        if (reply.wakeHooks === 'old') {
          const title = profiles?.find(p => p.id === body.id)?.title ?? String(body.id)
          toast(t('wake.installOld', { title }))
        }
        return true
      } catch (err) {
        toast(errorText(err, t), true)
        return false
      }
    },
    [latest],
  )

  const rows = profileRows(data?.profiles ?? [], t)
  // What a profile without a start command types: launch.claude's program.
  const program = data?.claudeProgram || 'claude'
  return (
    <Panel
      id="profiles-sheet"
      kind="profiles"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('prof.title')}</h2>
          <p className="sheet-meta">{t('prof.about')}</p>
        </>
      }
    >
      <div className="sheet-body cats-body profiles-body">
        <div className="cats-list">
          {rows.map(row => (
            <ProfileRow key={row.id} row={row} disabled={!canEdit} edit={edit} program={program} />
          ))}
        </div>
        <p className="profile-command-hint">{t('prof.commandHint', { program })}</p>
        <ProfileAdds rows={rows} unknown={unknownFolders(data?.items ?? [])} disabled={!canEdit} edit={edit} />
      </div>
    </Panel>
  )
}

interface ProfileAddsProps {
  rows: ProfileRowView[]
  /** Folders sessions reported that no profile has. */
  unknown: string[]
  disabled: boolean
  edit: ProfileEdit
}

/**
 * Below the rows: "Add <folder>" per folder a session reported, a folder typed in (Enter, as a
 * lane's "+ folder"), and Install per shown profile without the board's hooks.
 */
function ProfileAdds({ rows, unknown, disabled, edit }: ProfileAddsProps) {
  const t = useT()
  const [dir, setDir] = useState('')
  return (
    <div className="profiles-more">
      {unknown.map(path => (
        <button
          type="button"
          className="button profile-unknown"
          key={path}
          disabled={disabled}
          onClick={() => void edit({ op: 'add', dir: path })}
        >
          <span>{t('prof.addUnknown', { path })}</span>
        </button>
      ))}
      <label className="profile-add">
        <span>{t('prof.add')}</span>
        <input
          className="path-add"
          placeholder={t('prof.dir')}
          spellCheck={false}
          value={dir}
          disabled={disabled}
          onChange={e => setDir(e.currentTarget.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setDir('')
              e.currentTarget.blur()
            }
            if (e.key !== 'Enter') return
            // As typed, trimmed: the board takes ~ for the home folder (adapters/config-file.ts).
            const typed = e.currentTarget.value.trim()
            if (!typed) return
            void edit({ op: 'add', dir: typed }).then(ok => {
              if (ok) setDir('')
            })
          }}
        />
      </label>
      {rows
        .filter(row => row.noHooks)
        .map(row => (
          <div className="profile-note" key={row.id} data-id={row.id} style={{ '--lane': row.color }}>
            <p>{t('prof.noHooks', { title: row.title })}</p>
            <button
              type="button"
              className="button primary"
              disabled={disabled}
              onClick={() => void edit({ op: 'install', id: row.id })}
            >
              {t('prof.install')}
            </button>
          </div>
        ))}
    </div>
  )
}
