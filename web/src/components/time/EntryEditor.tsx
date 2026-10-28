// An entry opened in place in the Time panel (#233): its description, its project (the client's
// list), its start and stop on this browser's clock with the duration between them and -15 and
// +15 steps (a trim is the usual change), its work date (a change moves it), its tags; Save,
// Delete and Cancel. A new entry has a client too, and no Delete. What the board refuses (another
// change since, a project not the client's) is said under the fields, and the draft stays.
import { type FormEvent, useState } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import { type Draft, draftSeconds, hm, nudge } from '../../models/time.ts'
import { classNames } from '../class-names.ts'

export interface EntryEditorProps {
  draft: Draft
  /** A new entry: the client can be chosen among these. */
  clients?: string[] | undefined
  clientTitle(id: string): string
  /** The client's projects (null: any, typed). */
  projects(client: string): string[] | null
  busy: boolean
  error: string | null
  onSave(d: Draft): void
  onDelete?: (() => void) | undefined
  onCancel(): void
}

export function EntryEditor({
  draft,
  clients,
  clientTitle,
  projects,
  busy,
  error,
  onSave,
  onDelete,
  onCancel,
}: EntryEditorProps) {
  const t = useT()
  const [d, setD] = useState(draft)
  const set = (field: keyof Draft, value: string) => setD(x => ({ ...x, [field]: value }))
  const listed = projects(d.client)
  const seconds = draftSeconds(d)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSave(d)
  }
  return (
    <form
      className="time-editor"
      onSubmit={submit}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      {clients && (
        <label className="time-field">
          <span>{t('time.edit.client')}</span>
          <select value={d.client} disabled={busy} onChange={e => set('client', e.target.value)}>
            {clients.map(c => (
              <option key={c} value={c}>
                {clientTitle(c)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="time-field time-field-wide">
        <span>{t('time.edit.description')}</span>
        <textarea
          rows={2}
          value={d.description}
          disabled={busy}
          // biome-ignore lint/a11y/noAutofocus: the field the tap opened, as a sheet's composer
          autoFocus
          onChange={e => set('description', e.target.value)}
        />
      </label>
      {listed ? (
        <label className="time-field">
          <span>{t('time.edit.project')}</span>
          <select value={d.project} disabled={busy} onChange={e => set('project', e.target.value)}>
            {!listed.includes(d.project) && <option value={d.project}>{d.project}</option>}
            {listed.map(p => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="time-field">
          <span>{t('time.edit.project')}</span>
          <input value={d.project} disabled={busy} onChange={e => set('project', e.target.value)} />
        </label>
      )}
      <div className="time-field-row">
        <label className="time-field">
          <span>{t('time.edit.start')}</span>
          <input type="time" value={d.start} disabled={busy} onChange={e => set('start', e.target.value)} />
        </label>
        <label className="time-field">
          <span>{t('time.edit.stop')}</span>
          <input type="time" value={d.stop} disabled={busy} onChange={e => set('stop', e.target.value)} />
        </label>
        <div className="time-field time-duration">
          <span>{t('time.edit.duration')}</span>
          <div className="time-steps">
            <button type="button" className="button" disabled={busy} onClick={() => setD(x => nudge(x, -15))}>
              −15
            </button>
            <strong className={classNames(seconds === null && 'access-warn')}>
              {seconds === null ? '?' : hm(seconds)}
            </strong>
            <button type="button" className="button" disabled={busy} onClick={() => setD(x => nudge(x, 15))}>
              +15
            </button>
          </div>
        </div>
      </div>
      <div className="time-field-row">
        <label className="time-field">
          <span>{t('time.edit.date')}</span>
          <input type="date" value={d.date} disabled={busy} onChange={e => set('date', e.target.value)} />
        </label>
        <label className="time-field time-field-grow">
          <span>{t('time.edit.tags')}</span>
          <input value={d.tags} disabled={busy} placeholder="deferred" onChange={e => set('tags', e.target.value)} />
        </label>
      </div>
      {error && (
        <p className="access-problem" role="alert">
          {error}
        </p>
      )}
      <div className="access-actions">
        <button type="submit" className="button primary" disabled={busy || seconds === null || !d.description.trim()}>
          {t('backup.save')}
        </button>
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          {t('backup.cancel')}
        </button>
        {onDelete && (
          <button type="button" className="button time-delete" disabled={busy} onClick={onDelete}>
            {t('time.edit.delete')}
          </button>
        )}
      </div>
    </form>
  )
}
