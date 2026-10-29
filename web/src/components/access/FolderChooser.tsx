// The profile sync's folder picker, for a rule's folders and a project's own path: a folder's
// breadcrumbs, Up, its folders to open with a click, "Choose this folder", and on the server "New
// folder" (made by the sync as the board's user). Its listings are the host's (`list`, `make`):
// this computer's by POST /api/fs/dirs, the server's by the sync's ops. A start that is not there
// yet (a rule's folder to be made) opens its parent.
import { useEffect, useState } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import { crumbs, inside, type Listing, type Side } from '../../models/folder-chooser.ts'
import { FolderIcon } from '../icons.tsx'

/** Why a folder was not listed, in the picker's words. */
const KNOWN = new Set(['denied', 'missing', 'notDir', 'slow'])

export interface FolderChooserProps {
  side: Side
  /** Where it opens ('' the top: this computer's home and drives, the server's board user's home). */
  start: string
  /** A folder's listing, or why not. */
  list(path: string): Promise<Listing | string>
  /** A folder made in a folder, its listing; none: no New folder. */
  make?(path: string, name: string): Promise<Listing | string>
  onChoose(path: string): void
  onCancel(): void
  /** Drawn at once with this listing (a test's; else it is listed when shown). */
  initial?: Listing
}

export function FolderChooser({ side, start, list, make, onChoose, onCancel, initial }: FolderChooserProps) {
  const t = useT()
  const [at, setAt] = useState<Listing | null>(initial ?? null)
  const [busy, setBusy] = useState(initial === undefined)
  const [why, setWhy] = useState('')
  const [name, setName] = useState<string | null>(null)

  async function open(path: string, first = false): Promise<void> {
    setBusy(true)
    setWhy('')
    const r = await list(path)
    setBusy(false)
    if (typeof r === 'string') {
      setWhy(r)
      return
    }
    // a start not there yet: its parent
    if (first && r.error === 'missing' && r.parent !== '' && r.parent !== path) return open(r.parent)
    setAt(r)
    setName(null)
  }

  async function made(): Promise<void> {
    if (!make || !at || name === null || name.trim() === '') return
    setBusy(true)
    setWhy('')
    const r = await make(at.path, name.trim())
    setBusy(false)
    if (typeof r === 'string') setWhy(r)
    else {
      setAt(r)
      setName(null)
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: listed once, where it opens
  useEffect(() => {
    if (initial === undefined) void open(start, true)
  }, [])

  const here = at?.path ?? ''
  const sep = at?.sep ?? (side === 'server' ? '/' : '\\')
  const top = here === '' && (at?.roots.length ?? 0) > 0
  return (
    <fieldset className="sync-pick">
      <legend className="sync-pick-title">{t(`sync.pick.title.${side}`)}</legend>
      <div className="sync-pick-crumbs">
        {side === 'pc' && (
          <button type="button" className="sync-pick-link" disabled={busy || top} onClick={() => void open('')}>
            {t('sync.pick.top')}
          </button>
        )}
        {crumbs(here, sep).map(c => (
          <button
            type="button"
            className="sync-pick-link"
            key={c.path}
            disabled={busy}
            onClick={() => void open(c.path)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="access-actions">
        <button
          type="button"
          className="button"
          disabled={busy || !at || at.path === '' || (at.parent === '' && side === 'server')}
          onClick={() => void open(at?.parent ?? '')}
        >
          {t('sync.pick.up')}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || here === '' || !!at?.error}
          onClick={() => onChoose(here)}
        >
          {t('sync.pick.here')}
        </button>
        {make && (
          <button
            type="button"
            className="button"
            disabled={busy || here === '' || !!at?.error}
            onClick={() => setName(name === null ? '' : null)}
          >
            {t('sync.pick.newFolder')}
          </button>
        )}
        <button type="button" className="button" onClick={onCancel}>
          {t('sync.pick.cancel')}
        </button>
      </div>
      {name !== null && (
        <div className="access-actions">
          <input
            type="text"
            name="sync-pick-new"
            aria-label={t('sync.pick.newName')}
            placeholder={t('sync.pick.newName')}
            value={name}
            onChange={e => setName(e.currentTarget.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void made()
            }}
          />
          <button type="button" className="button" disabled={busy || name.trim() === ''} onClick={() => void made()}>
            {t('sync.pick.make')}
          </button>
        </div>
      )}
      {why && <p className="access-why">{why}</p>}
      {at?.error && <p className="access-why">{KNOWN.has(at.error) ? t(`sync.pick.err.${at.error}`) : at.error}</p>}
      {busy && <p className="access-note">{t('sync.pick.loading')}</p>}
      {at && !busy && (
        <ul className="sync-list sync-pick-list">
          {(top
            ? at.roots.map(r => ({ name: r.name, path: r.path }))
            : at.entries.map(n => ({ name: n, path: inside(here, n, sep) }))
          ).map(f => (
            <li key={f.path}>
              <button type="button" className="sync-pick-link" onClick={() => void open(f.path)}>
                <FolderIcon /> {f.name}
              </button>
            </li>
          ))}
          {!top && at.entries.length === 0 && !at.error && <li className="access-note">{t('sync.pick.empty')}</li>}
        </ul>
      )}
    </fieldset>
  )
}
