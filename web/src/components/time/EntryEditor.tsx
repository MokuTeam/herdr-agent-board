// An entry opened in place in the Time panel (#233): its description, its project (the client's
// list), its start and stop on this browser's clock with the duration between them, typed (it
// moves the stop) or stepped by -15 and +15 (a trim is the usual change; an untouched time keeps
// its seconds), its work date (a change moves it), its tags as tokens (Enter or a comma adds one,
// its x or Backspace in the empty field takes one off, the board's tags offered under them); Save,
// Delete and Cancel. A new entry has a client too (its projects
// follow it), no Delete, and its date is the day its times are on. Changed elsewhere since it was
// opened (`stale`): it says so, and Save waits for Reload, which shows the entry as it is now.
// What the board refuses is said under the fields, and the draft stays. Over 12 hours, it asks.
// Laid out as the row it opened from grown in place: the description first, then what it is for,
// when, and the rest; who logged it quietly under them; Delete apart from Cancel and Save.
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  type Draft,
  draftSeconds,
  durationText,
  LONG_SECONDS,
  nudge,
  parseDuration,
  tagList,
  tagOf,
  typed,
  withDuration,
  withoutTag,
  withTag,
} from '../../models/time.ts'
import { classNames } from '../class-names.ts'

export interface EntryEditorProps {
  draft: Draft
  /** A new entry: the client can be chosen among these. */
  clients?: string[] | undefined
  clientTitle(id: string): string
  /** The client's projects (null: any, typed). */
  projects(client: string): string[] | null
  /** Who logged the entry (a session's name opens it); none for a new one. */
  by?: ReactNode
  /** Tags to offer, in the order to offer them (the board's: the held ones first). */
  tags?: string[] | undefined
  busy: boolean
  error: string | null
  /** The entry changed elsewhere since it was opened: Save waits for Reload. */
  stale?: boolean | undefined
  onReload?: (() => void) | undefined
  onSave(d: Draft): void
  onDelete?: (() => void) | undefined
  onCancel(): void
  /** The draft as it is typed: the panel keeps it, for when the editor closes without Save or Cancel. */
  onDraft?: ((d: Draft) => void) | undefined
}

export function EntryEditor({
  draft,
  clients,
  clientTitle,
  projects,
  by,
  tags: offered = [],
  busy,
  error,
  stale,
  onReload,
  onSave,
  onDelete,
  onCancel,
  onDraft,
}: EntryEditorProps) {
  const t = useT()
  const [d, setD] = useState(draft)
  // a tag being typed, not yet a token: it counts as one for Save and for the kept draft
  const [pending, setPending] = useState('')
  const whole = (x: Draft): Draft => (tagOf(pending) ? { ...x, tags: withTag(x.tags, pending) } : x)
  // each change of the draft, not the one it opened with: an editor opened and left as it was has
  // nothing to keep, and must not wipe what another kept
  const opened = useRef(d)
  const touched = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each change of the draft or the tag being typed
  useEffect(() => {
    if (d === opened.current && !touched.current && !pending) return
    touched.current = true
    onDraft?.(whole(d))
  }, [d, pending])
  const set = (field: 'description' | 'project', value: string) => setD(x => ({ ...x, [field]: value }))
  const listed = projects(d.client)
  const seconds = draftSeconds(d)
  // the duration as typed, while it is; null: the draft's own, said as the panel says durations
  const [lasting, setLasting] = useState<string | null>(null)
  const badDuration = lasting !== null && parseDuration(lasting) === null
  const tags = tagList(d.tags)
  const addTag = (text: string) => {
    if (tagOf(text)) setD(x => ({ ...x, tags: withTag(x.tags, text) }))
  }
  const typing = tagOf(pending)
  const hints = offered.filter(x => !tags.includes(x) && x.startsWith(typing)).slice(0, 4)
  const tagField = useRef<HTMLInputElement>(null)
  const tagsLabel = useId()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!stale && !badDuration) onSave(whole(d))
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
      {stale && (
        <div className="access-problem time-stale" role="alert">
          <span>{t('time.edit.stale')}</span>
          {onReload && (
            <button type="button" className="button" onClick={onReload}>
              {t('time.edit.reload')}
            </button>
          )}
        </div>
      )}
      <label className="time-field">
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
      <div className="time-field-row">
        {clients && (
          <label className="time-field">
            <span>{t('time.edit.client')}</span>
            <select
              value={d.client}
              disabled={busy}
              // another client: its own first project, not the last one's
              onChange={e => {
                const client = e.target.value
                setD(x => ({ ...x, client, project: projects(client)?.[0] ?? x.project }))
              }}
            >
              {clients.map(c => (
                <option key={c} value={c}>
                  {clientTitle(c)}
                </option>
              ))}
            </select>
          </label>
        )}
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
      </div>
      <div className="time-field-row">
        <label className="time-field time-clock">
          <span>{t('time.edit.start')}</span>
          <input
            type="time"
            value={d.start}
            disabled={busy}
            onChange={e => {
              setLasting(null)
              setD(x => typed(x, 'start', e.target.value))
            }}
          />
        </label>
        <label className="time-field time-clock">
          <span>{t('time.edit.stop')}</span>
          <input
            type="time"
            value={d.stop}
            disabled={busy}
            onChange={e => {
              setLasting(null)
              setD(x => typed(x, 'stop', e.target.value))
            }}
          />
        </label>
        <div className="time-field time-duration">
          <span>{t('time.edit.duration')}</span>
          <div className={classNames('time-steps', (badDuration || seconds === null) && 'bad')}>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setLasting(null)
                setD(x => nudge(x, -15))
              }}
            >
              −15
            </button>
            <input
              aria-label={t('time.edit.duration')}
              value={lasting ?? (seconds === null ? '' : durationText(seconds, t))}
              disabled={busy}
              autoComplete="off"
              onChange={e => {
                const text = e.target.value
                setLasting(text)
                const s = parseDuration(text)
                if (s !== null) setD(x => withDuration(x, s))
              }}
              // what was typed is said as the panel says durations, or goes back to the draft's own
              onBlur={() => setLasting(null)}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setLasting(null)
                setD(x => nudge(x, 15))
              }}
            >
              +15
            </button>
          </div>
        </div>
      </div>
      {badDuration && <p className="access-warn time-warn">{t('time.edit.badDuration')}</p>}
      {!badDuration && seconds !== null && seconds > LONG_SECONDS && (
        <p className="access-warn time-warn">{t('time.edit.long')}</p>
      )}
      <div className="time-field-row">
        <label className="time-field time-clock">
          <span>{t('time.edit.date')}</span>
          <input
            type="date"
            value={d.date}
            disabled={busy}
            // a new entry's times are on its date; an entry's date moves it, its times as they are
            onChange={e => {
              const date = e.target.value
              setD(x => (clients ? { ...x, date, day: date } : { ...x, date }))
            }}
          />
        </label>
        <div className="time-field">
          <span id={tagsLabel}>{t('time.edit.tags')}</span>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a click on the field's padding reaches its input, which has the keys */}
          <div className="time-tags" onClick={e => e.target === e.currentTarget && tagField.current?.focus()}>
            {tags.map(tag => (
              <span className="time-tag" key={tag}>
                {tag}
                <button
                  type="button"
                  aria-label={t('time.edit.removeTag', { tag })}
                  title={t('time.edit.removeTag', { tag })}
                  disabled={busy}
                  onClick={() => setD(x => ({ ...x, tags: withoutTag(x.tags, tag) }))}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              ref={tagField}
              value={pending}
              disabled={busy}
              autoComplete="off"
              aria-labelledby={tagsLabel}
              placeholder={tags.length ? '' : t('time.edit.addTag')}
              onChange={e => {
                // a comma ends a tag: what is before it is one, what follows is being typed
                const parts = e.target.value.split(',')
                const rest = parts.pop() ?? ''
                for (const part of parts) addTag(part)
                setPending(rest)
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && tagOf(pending)) {
                  e.preventDefault()
                  addTag(pending)
                  setPending('')
                } else if (e.key === 'Backspace' && !pending && tags.length) {
                  e.preventDefault()
                  setD(x => ({ ...x, tags: withoutTag(x.tags, tags[tags.length - 1] as string) }))
                }
              }}
              onBlur={() => {
                if (!tagOf(pending)) return
                addTag(pending)
                setPending('')
              }}
            />
          </div>
          {hints.length > 0 && (
            <div className="time-tag-hints">
              {hints.map(hint => (
                <button
                  type="button"
                  key={hint}
                  className="time-tag-hint"
                  disabled={busy}
                  onClick={() => {
                    addTag(hint)
                    setPending('')
                  }}
                >
                  + {hint}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {error && (
        <p className="access-problem" role="alert">
          {error}
        </p>
      )}
      {by && (
        <p className="time-by">
          {t('time.edit.by')} {by}
        </p>
      )}
      <div className="time-actions">
        {onDelete && (
          <button type="button" className="button time-delete" disabled={busy} onClick={onDelete}>
            {t('time.edit.delete')}
          </button>
        )}
        <button type="button" className="button" disabled={busy} onClick={onCancel}>
          {t('backup.cancel')}
        </button>
        <button
          type="submit"
          className="button primary"
          disabled={busy || !!stale || badDuration || seconds === null || !d.description.trim()}
        >
          {t('backup.save')}
        </button>
      </div>
    </form>
  )
}
