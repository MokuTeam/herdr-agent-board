// The "new session" window as drawn: over the dimmed board, its title and how sessions start, the
// form (name, folder, category, the agent and the Claude profile when there is a choice, where it
// opens, a worktree, the first message) and its buttons, the profile it starts in beside Start.
// It lives in <body> itself, beside the page (hooks/useModalFocus.ts); its motion, focus, keys
// and what the form does are launch-window.ts's (and folder-field.ts's for the folder).
import { type RefObject, useLayoutEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { NAME_MAX } from '../../../../src/core/launch/names.ts'
import type { Translator } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { type LauncherInfo, launcherLine } from '../../models/launch.ts'
import { useStore } from '../../state/store.ts'
import { CloseIcon } from '../icons.tsx'
import { type FolderHandlers, FolderPickerView, Note } from './FolderPicker.tsx'
import type { FolderView } from './folder-field.ts'
import type { LaunchWindow, LaunchWindowView } from './launch-window.ts'

export interface LaunchRefs {
  /** The layer: a direct child of <body> (useModalFocus makes the rest of the page inert). */
  layer: RefObject<HTMLDivElement | null>
  win: RefObject<HTMLElement | null>
}

/** What the window's parts do: the window's own handlers. */
export type LaunchHandlers = Pick<
  LaunchWindow,
  | 'close'
  | 'scrim'
  | 'submit'
  | 'name'
  | 'newWorkspace'
  | 'workspace'
  | 'worktree'
  | 'branch'
  | 'message'
  | 'pickCategory'
  | 'pickAgent'
  | 'pickProfile'
> & { folder: FolderHandlers }

export const launchHandlers = (w: LaunchWindow): LaunchHandlers => ({
  close: w.close,
  scrim: w.scrim,
  submit: w.submit,
  name: w.name,
  newWorkspace: w.newWorkspace,
  workspace: w.workspace,
  worktree: w.worktree,
  branch: w.branch,
  message: w.message,
  pickCategory: w.pickCategory,
  pickAgent: w.pickAgent,
  pickProfile: w.pickProfile,
  folder: w.folder,
})

export function LaunchDialog({ launch, refs }: { launch: LaunchWindow; refs: LaunchRefs }) {
  const view = useStore(launch.view)
  const folder = useStore(launch.folder.view)
  const launcher = useStore(launch.launcher)
  const t = useT()
  const on = useMemo(() => launchHandlers(launch), [launch])
  // Drawn: an opening grows now, and focus and scrolling that waited for the draw are done.
  useLayoutEffect(() => launch.afterDraw())
  if (typeof document === 'undefined') return null
  return createPortal(
    <LaunchDialogView view={view} folder={folder} launcher={launcher} t={t} on={on} refs={refs} />,
    document.body,
  )
}

export interface LaunchDialogViewProps {
  view: LaunchWindowView
  folder: FolderView
  launcher: LauncherInfo
  t: Translator
  on: LaunchHandlers
  refs?: LaunchRefs
}

/** The window as drawn for one state. */
export function LaunchDialogView({ view, folder, launcher, t, on, refs }: LaunchDialogViewProps) {
  const f = view.fields
  return (
    <div className="launch" hidden={!view.shown} ref={refs?.layer}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click beside the window, as before; Esc is the way by keys */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above */}
      <div className="launch-scrim" onClick={() => on.scrim()} />
      <section
        className="launch-win"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-title"
        tabIndex={-1}
        ref={refs?.win}
      >
        <header className="launch-head">
          <div className="launch-titles">
            <h3 id="launch-title">{t(view.retry ? 'launch.retryTitle' : 'launch.title')}</h3>
            <p className="launch-sub">{launcherLine(launcher, t)}</p>
          </div>
          <button
            type="button"
            className="icon-button launch-close"
            title={t('sheet.close')}
            aria-label={t('sheet.closeLabel')}
            onClick={() => on.close()}
          >
            <CloseIcon />
          </button>
        </header>
        <form
          className="launch-body"
          noValidate
          autoComplete="off"
          onSubmit={e => {
            e.preventDefault()
            on.submit()
          }}
        >
          <div className="group">
            <label className="row">
              <span className="row-label">{t('launch.name')}</span>
              <input
                className="row-value"
                name="name"
                maxLength={NAME_MAX}
                spellCheck={false}
                placeholder={t('launch.namePlaceholder')}
                value={f.name}
                onChange={e => on.name(e.currentTarget.value)}
              />
            </label>
            <Note field="name" note={view.notes.name} />
            <FolderPickerView view={folder} note={view.notes.cwd} t={t} on={on.folder} />
            <div className="row">
              <span className="row-label">{t('row.category')}</span>
              <div className="row-value chips launch-cats">
                {view.cats.map(c => (
                  <button
                    type="button"
                    key={c.id}
                    data-cat={c.id}
                    style={{ '--lane': c.color }}
                    aria-pressed={c.pressed}
                    onClick={() => on.pickCategory(c.id)}
                  >
                    {c.title}
                  </button>
                ))}
              </div>
            </div>
            {view.agent.offered && (
              <div className="row agent-row">
                <span className="row-label">{t('launch.agent')}</span>
                <div className="row-value chips launch-agents">
                  {view.agent.options.map(a => (
                    <button
                      type="button"
                      key={a.id}
                      name="agent"
                      data-agent={a.id}
                      aria-pressed={a.pressed}
                      onClick={() => on.pickAgent(a.id)}
                    >
                      {a.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {view.profile.offered && (
              <>
                <div className="row profile-row">
                  <span className="row-label">{t('launch.profile')}</span>
                  <div className="row-value chips launch-profiles">
                    {view.profile.options.map(p => (
                      <button
                        type="button"
                        key={p.id}
                        name="profile"
                        data-profile={p.id}
                        style={{ '--lane': p.color }}
                        aria-pressed={p.pressed}
                        onClick={() => on.pickProfile(p.id)}
                      >
                        {p.title}
                      </button>
                    ))}
                  </div>
                </div>
                <Note field="profile" note={view.notes.profile} />
              </>
            )}
            <div className="row where-row">
              <span className="row-label">{t('launch.where')}</span>
              <div className="row-value where">
                <select name="workspace" value={f.workspace} onChange={e => on.workspace(e.currentTarget.value)}>
                  {view.workspaces.map((w, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: herdr's ids, in herdr's order; the place keeps one that repeats apart
                    <option key={`${i}:${w.id}`} value={w.id}>
                      {w.label}
                    </option>
                  ))}
                  <option value="">{t('launch.newWorkspace')}</option>
                </select>
                <input
                  name="newWorkspace"
                  maxLength={40}
                  spellCheck={false}
                  hidden={view.newWorkspaceHidden}
                  placeholder={t('launch.workspaceName')}
                  value={f.newWorkspace}
                  onChange={e => on.newWorkspace(e.currentTarget.value)}
                />
              </div>
            </div>
            <Note field="workspace" note={view.notes.workspace} />
            <div className="row wt-row" hidden={!view.worktree}>
              <span className="row-label">{t('launch.worktree')}</span>
              <div className="row-value wt">
                <label className="wt-toggle">
                  <input
                    type="checkbox"
                    name="wt"
                    checked={f.wt}
                    onChange={e => on.worktree(e.currentTarget.checked)}
                  />
                  <span>{t('launch.worktreeNew')}</span>
                </label>
                <input
                  name="branch"
                  maxLength={100}
                  spellCheck={false}
                  hidden={view.branchHidden}
                  placeholder={t('launch.branch')}
                  value={f.branch}
                  onChange={e => on.branch(e.currentTarget.value)}
                />
              </div>
            </div>
            <Note field="worktree" className="wt-note" note={view.notes.worktree} />
          </div>
          <div className="group message-group">
            <textarea
              name="message"
              rows={3}
              spellCheck={true}
              placeholder={t('launch.message')}
              value={f.message}
              onChange={e => on.message(e.currentTarget.value)}
            />
          </div>
          <p className="launch-error" role="alert" hidden={view.error.hidden}>
            {view.error.text}
          </p>
        </form>
        <footer className="launch-foot">
          <span className="launch-keys">{t('launch.keys')}</span>
          <button type="button" className="button launch-cancel" onClick={() => on.close()}>
            {t('cancel')}
          </button>
          {view.profile.chosen && (
            <span className="launch-profile" style={{ '--c': view.profile.chosen.color }}>
              {view.profile.chosen.title}
            </span>
          )}
          <button
            type="button"
            className="button primary launch-go"
            disabled={view.go?.disabled}
            title={view.go?.title}
            onClick={() => on.submit()}
          >
            {t('launch.start')}
          </button>
        </footer>
      </section>
    </div>
  )
}
