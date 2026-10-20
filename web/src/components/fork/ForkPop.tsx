// The fork window (hooks/useFork.ts keeps its state): what a fork of the session is, in a line,
// where it goes (the session's lane, workspace and folder, which it keeps), its name (the
// session's with "· fork" after it, ready to type over) and an optional first message. Enter in
// the name, or Ctrl+Enter in the message, forks; Esc closes.
import type { KeyboardEvent } from 'react'
import { forkName, NAME_MAX } from '../../../../src/core/launch/names.ts'
import type { Forker, ForkView } from '../../hooks/useFork.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { categoryInfo, catOf } from '../../models/board-view.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { ForkIcon } from '../icons.tsx'

const folderName = (cwd: string): string =>
  cwd
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || cwd

export function ForkPop({ fork }: { fork: Forker }) {
  return (
    <div
      className="fork-pop"
      id="fork-pop"
      role="dialog"
      aria-labelledby="fork-title"
      tabIndex={-1}
      hidden={fork.hidden}
      ref={fork.popRef}
    >
      {fork.view && <ForkForm key={fork.view.id} view={fork.view} fork={fork} />}
    </div>
  )
}

function ForkForm({ view, fork }: { view: ForkView; fork: Forker }) {
  const t = useT()
  const { data, ui } = useBoardContext()
  const item = data?.items.find(i => i.key === view.key)
  if (!item) return null
  const lane = categoryInfo(data?.categories ?? [], catOf(ui.moves, item))
  const name = view.draft.name || forkName(item.name, t('fork.mark'))
  const error = fork.error
  const submit = (form: HTMLFormElement | null) => {
    if (!form) return
    const fields = new FormData(form)
    void fork.submit(String(fields.get('name') ?? ''), String(fields.get('message') ?? ''))
  }
  const onNoteKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.nativeEvent.isComposing) return
    e.preventDefault()
    submit(e.currentTarget.form)
  }
  return (
    <form
      className="fork-form"
      onSubmit={e => {
        e.preventDefault()
        submit(e.currentTarget)
      }}
    >
      <header className="fork-head">
        <span className="fork-glyph" aria-hidden="true">
          <ForkIcon />
        </span>
        <div className="fork-titles">
          <h3 id="fork-title">{t('fork.title', { name: item.name })}</h3>
          <p>{t('fork.about')}</p>
        </div>
      </header>
      <p className="fork-where" title={item.cwd}>
        <span className="fork-lane" style={{ '--lane': lane.color }}>
          {lane.title}
        </span>
        {item.workspace && <span>{item.workspace}</span>}
        {item.cwd && <span className="fork-folder">{folderName(item.cwd)}</span>}
      </p>
      <div className="group fork-group">
        <label className={classNames('row', error?.field === 'name' && 'bad')}>
          <span className="row-label">{t('fork.name')}</span>
          <input
            name="name"
            defaultValue={name}
            maxLength={NAME_MAX}
            spellCheck={false}
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the window opens to name the fork
            autoFocus
            onFocus={e => e.currentTarget.select()}
          />
        </label>
        <label className="row fork-note">
          <span className="row-label">{t('fork.note')}</span>
          <textarea
            name="message"
            rows={2}
            defaultValue={view.draft.message ?? ''}
            placeholder={t('fork.notePlaceholder')}
            onKeyDown={onNoteKey}
          />
        </label>
      </div>
      {error && (
        <p className="fork-error" role="alert">
          {error.text}
        </p>
      )}
      <footer className="fork-foot">
        <span className="fork-stays">{t('fork.stays')}</span>
        <button type="button" className="button" onClick={() => fork.close(true)}>
          {t('fork.cancel')}
        </button>
        <button type="submit" className="button primary" disabled={fork.busy} aria-busy={fork.busy}>
          <ForkIcon />
          <span>{t('fork.start')}</span>
        </button>
      </footer>
    </form>
  )
}
