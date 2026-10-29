// An entry opened in place in the Time panel (#233): its description, its project (the client's
// list), its start and stop on this browser's clock with the duration between them, typed (it
// moves the stop once it is one: on Enter, on leaving the field, on Save; until then the draft is
// as it was, and a duration that is none is said and keeps Save waiting) or stepped by -15 and
// +15 (a trim is the usual change; an untouched time keeps its seconds), its work date (a change
// moves it), its tags as tokens (Enter or a comma adds one, its x or Backspace in the empty field
// takes one off, the board's tags offered under them, twenty at most), billable as a switch (its
// default the config's, said while the entry follows it); Save, Delete and Cancel. An entry
// entered into its client's systems says so (a change is to be made there too). A new entry has a
// client too (its projects follow it), no Delete, and its date is the day its times are on.
// Changed elsewhere since it was opened (`stale`): it says so, and Save waits for Reload, which
// shows the entry as it is now. What the board refuses is said under the fields, and the draft
// stays. Times that make no duration, or over 12 hours, are said under the times.
// Laid out as the row it opened from grown in place: the description first, then what it is for,
// when, and the rest; who logged it quietly under them; Delete apart from Cancel and Save.
// The Project field offers "New project…" last (#237): a name typed there goes with Save, which adds
// it to the client's list; a line under it says so, or that the client has it already (case and
// spaces aside: the entry takes that one), or that it is retired (Save waits). A client with no
// project yet asks for its first one at once.
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { projectIn } from '../../../../src/core/time.ts'
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
  timesAreTimes,
  typed,
  withDuration,
  withoutTag,
  withTag,
} from '../../models/time.ts'
import { classNames } from '../class-names.ts'

/** Names joined as the language joins them: "ERP and Tracker", "ERP и Tracker". */
function listText(names: readonly string[], lang: string): string {
  try {
    return new Intl.ListFormat(lang, { type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}

/** The most tags an entry has (the board refuses more). */
const MAX_TAGS = 20

/** The Project field's choice that is no project: "New project…". */
const NEW_PROJECT = '\u0000new'

export interface EntryEditorProps {
  draft: Draft
  /** A new entry: the client can be chosen among these. */
  clients?: string[] | undefined
  clientTitle(id: string): string
  /** The client's projects (null: any, typed). */
  projects(client: string): string[] | null
  /** The client's retired projects: a new one by that name waits. */
  retired?: ((client: string) => string[]) | undefined
  /** Who logged the entry (a session's name opens it); none for a new one. */
  by?: ReactNode
  /** Tags to offer, in the order to offer them (the board's: the held ones first). */
  tags?: string[] | undefined
  /** Whether a client's entries on a project are billable as the config says. */
  billableDefault?: ((client: string, project: string) => boolean) | undefined
  /** The systems the entry is entered in (their names): a change is to be made there too. */
  entered?: string[] | undefined
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
  retired = () => [],
  by,
  tags: offered = [],
  billableDefault = () => true,
  entered = [],
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
  const whole = (x: Draft): Draft =>
    tagOf(pending) && tagList(x.tags).length < MAX_TAGS ? { ...x, tags: withTag(x.tags, pending) } : x
  // the duration as typed, while it is; null: the draft's own, said as the panel says durations
  const [lasting, setLasting] = useState<string | null>(null)
  const typedSeconds = lasting === null ? null : parseDuration(lasting)
  const badDuration = lasting !== null && typedSeconds === null
  /** The draft with the duration typed in it (the stop moved), once what is typed is one. */
  const withTyped = (x: Draft): Draft => (typedSeconds === null ? x : withDuration(x, typedSeconds))
  // each change of the draft, not the one it opened with: an editor opened and left as it was has
  // nothing to keep, and must not wipe what another kept
  const opened = useRef(d)
  const touched = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each change of the draft, the tag or the duration being typed
  useEffect(() => {
    if (d === opened.current && !touched.current && !pending && lasting === null) return
    touched.current = true
    // what is typed counts as it would on Save: an editor that closes without a blur keeps it too
    onDraft?.(whole(withTyped(d)))
  }, [d, pending, lasting])
  const set = (field: 'description' | 'project', value: string) => setD(x => ({ ...x, [field]: value }))
  const listed = projects(d.client)
  // a name typed for a new project, or a client with none yet: its first one
  const [named, setNamed] = useState(draft.newProject)
  const naming = !!listed && (named || listed.length === 0)
  const typedName = d.project.trim()
  const sameAs = naming && typedName ? projectIn(listed ?? [], typedName) : null
  const retiredAs = naming && typedName && !sameAs ? projectIn(retired(d.client), typedName) : null
  const projectNote =
    !naming || !typedName
      ? ''
      : retiredAs
        ? t('time.edit.newProjectRetired', { project: retiredAs })
        : sameAs
          ? t('time.edit.newProjectSame', { client: clientTitle(d.client), project: sameAs })
          : t('time.edit.newProjectAdds', { client: clientTitle(d.client) })
  const commitDuration = () => {
    if (typedSeconds === null) return
    setD(withTyped)
    setLasting(null)
  }
  const seconds = draftSeconds(withTyped(d))
  // one line under the times, its room kept, so nothing moves under the pointer: a duration that is
  // none, times that make none (a stop before the start), or a long one asked about
  const warning = badDuration
    ? t('time.edit.badDuration')
    : seconds === null
      ? t(timesAreTimes(withTyped(d)) ? 'time.err.stopBeforeStart' : 'time.edit.badTime')
      : seconds > LONG_SECONDS
        ? t('time.edit.long')
        : ''
  const billable = d.billable ?? billableDefault(d.client, d.project)
  const tags = tagList(d.tags)
  const full = tags.length >= MAX_TAGS
  const addTag = (text: string) => {
    if (tagOf(text)) setD(x => (tagList(x.tags).length >= MAX_TAGS ? x : { ...x, tags: withTag(x.tags, text) }))
  }
  const typing = tagOf(pending)
  const hints = full ? [] : offered.filter(x => !tags.includes(x) && x.startsWith(typing)).slice(0, 4)
  const tagField = useRef<HTMLInputElement>(null)
  const tagsLabel = useId()
  const newName = useId()
  const newNote = useId()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!stale && !badDuration) onSave(whole(withTyped(d)))
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
                setNamed(false)
                // one with no project yet: its first one is typed, not the last client's carried over
                const list = projects(client)
                setD(x => ({ ...x, client, project: list ? (list[0] ?? '') : x.project, newProject: false }))
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
        {listed && naming ? (
          <div className="time-field time-new-project">
            <label htmlFor={newName}>{t('time.edit.project')}</label>
            <div className="time-new-row">
              <input
                id={newName}
                value={d.project}
                disabled={busy}
                autoComplete="off"
                placeholder={t('time.edit.newProjectName')}
                aria-describedby={projectNote ? newNote : undefined}
                aria-invalid={!!retiredAs}
                // biome-ignore lint/a11y/noAutofocus: the field "New project…" opened, typed into next
                autoFocus={named}
                onChange={e => setD(x => ({ ...x, project: e.target.value, newProject: true }))}
              />
              {listed.length > 0 && (
                <button
                  type="button"
                  className="time-new-back"
                  disabled={busy}
                  onClick={() => {
                    setNamed(false)
                    setD(x => ({
                      ...x,
                      project: draft.newProject ? (listed[0] ?? '') : draft.project,
                      newProject: false,
                    }))
                  }}
                >
                  {t('time.edit.projectList')}
                </button>
              )}
            </div>
          </div>
        ) : listed ? (
          <label className="time-field">
            <span>{t('time.edit.project')}</span>
            <select
              value={d.project}
              disabled={busy}
              onChange={e => {
                if (e.target.value !== NEW_PROJECT) return set('project', e.target.value)
                setNamed(true)
                setD(x => ({ ...x, project: '', newProject: true }))
              }}
            >
              {!listed.includes(d.project) && <option value={d.project}>{d.project}</option>}
              {listed.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
              <option value={NEW_PROJECT}>{t('time.edit.newProject')}</option>
            </select>
          </label>
        ) : (
          <label className="time-field">
            <span>{t('time.edit.project')}</span>
            <input value={d.project} disabled={busy} onChange={e => set('project', e.target.value)} />
          </label>
        )}
      </div>
      {projectNote && (
        <p id={newNote} className={classNames('time-project-note', retiredAs && 'access-warn')} aria-live="polite">
          {projectNote}
        </p>
      )}
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
              aria-invalid={badDuration}
              // half typed ("1" of "1:10") is no duration yet: the draft waits for Enter or leaving
              onChange={e => setLasting(e.target.value)}
              onKeyDown={e => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                e.preventDefault()
                commitDuration()
              }}
              // a duration: into the draft, said as the panel says durations; none: kept, and said
              onBlur={commitDuration}
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
      <p className="access-warn time-warn" aria-live="polite">
        {warning}
      </p>
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
                if (e.nativeEvent.isComposing) return
                // Enter ends a tag, never the form
                if (e.key === 'Enter') {
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
          {full && <p className="time-tag-note">{t('time.err.tags', { n: MAX_TAGS })}</p>}
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
      <label className="time-switch">
        <input
          type="checkbox"
          role="switch"
          checked={billable}
          aria-checked={billable}
          disabled={busy}
          // the config's way again is no setting of its own: the entry follows the config from then on
          onChange={e => {
            const on = e.target.checked
            setD(x => ({ ...x, billable: on === billableDefault(x.client, x.project) ? null : on }))
          }}
        />
        <span>{t('time.edit.billable')}</span>
        {d.billable === null && <small>{t('time.edit.billableDefault')}</small>}
      </label>
      {entered.length > 0 && (
        <p className="time-entered">{t('time.edit.entered', { systems: listText(entered, t.lang) })}</p>
      )}
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
          disabled={
            busy ||
            !!stale ||
            badDuration ||
            seconds === null ||
            !d.description.trim() ||
            (naming && (!typedName || !!retiredAs))
          }
        >
          {t('backup.save')}
        </button>
      </div>
    </form>
  )
}
