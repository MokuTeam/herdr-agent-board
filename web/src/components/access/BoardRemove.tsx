// "Remove the board from this server" in the Server tab's card "The board on the server": its Look's
// plan in plain words (the install's own --undo lines, models/server-setup.ts removePlainOf), the
// tick that takes the user and its home too (off by default, with what it deletes said plainly),
// the web server's steps folded under Details, Remove or Cancel; then the run's output as the server
// prints it, and how it ended. The board's side is services/server-setup.ts (server-remove-*).
import type { ReactNode } from 'react'
import type { ServerView } from '../../../../src/core/server-view.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { removePlainOf, type SetupState } from '../../models/server-setup.ts'

export interface BoardRemoveProps {
  s: ServerView
  state: SetupState
  onState(patch: Partial<SetupState>): void
  canEdit: boolean
  canLook: boolean
  /** The board's hint in words ('' when none). */
  hint: string
  /** The server's key the login met, in words ('' before one did). */
  hostKey: string
  /** The web server's steps, folded under Details (none: it has no part of the install's). */
  details: ReactNode
  onRemove(): void
  onCancel(): void
  onLookAgain(): void
}

export function BoardRemove({
  s,
  state,
  onState,
  canEdit,
  canLook,
  hint,
  hostKey,
  details,
  onRemove,
  onCancel,
  onLookAgain,
}: BoardRemoveProps) {
  const t = useT()
  const { phase } = s
  const r = s.remove
  const plain = phase === 'plan' ? removePlainOf(s, state.removeUser, t) : null
  const running = phase === 'undoing'
  // the user and its home are offered only when the installer made it
  const user = r?.facts.ours && r.facts.home !== null ? { user: r.facts.user, home: r.facts.home } : null
  return (
    <div className="access-remove">
      {phase !== 'failed' && hint && <p className="access-hint">{hint}</p>}
      {phase !== 'failed' && s.error && <p className="access-why">{s.error}</p>}

      {plain && (
        <div className="access-plain">
          <p className="access-note">{t('install.remove.intro')}</p>
          {plain.found && (
            <>
              <h4 className="access-sub">{t('server.panel.plainFound')}</h4>
              <p className="access-found-line">{plain.found}</p>
            </>
          )}
          {hostKey && <p className="access-hostkey">{hostKey}</p>}
          <h4 className="access-sub">{t('server.panel.plainWill')}</h4>
          <ul className="access-will">
            {plain.will.map(line => (
              <li className="access-will-line" key={line}>
                {line}
              </li>
            ))}
          </ul>
          {user && (
            <label className="access-tick">
              <input
                type="checkbox"
                name="tick-removeUser"
                checked={state.removeUser}
                disabled={!canEdit}
                onChange={() => onState({ removeUser: !state.removeUser })}
              />
              <span>{t('install.remove.tickUser', user)}</span>
            </label>
          )}
          {user && state.removeUser && <p className="access-warn">{t('install.remove.warnUser', user)}</p>}
          {plain.notes.map(note => (
            <p className="access-caution" key={note}>
              {note}
            </p>
          ))}
          {plain.untouched && <p className="access-untouched">{plain.untouched}</p>}
        </div>
      )}

      {plain && details && (
        <details className="access-details">
          <summary className="access-summary">{t('server.panel.details')}</summary>
          {details}
        </details>
      )}

      {plain && (
        <div className="access-actions">
          <button type="button" className="button primary" disabled={!canEdit} onClick={onRemove}>
            {t('install.remove.apply')}
          </button>
          <button type="button" className="button" disabled={!canEdit} onClick={onCancel}>
            {t('access.cancel')}
          </button>
        </div>
      )}

      {r && (running || phase === 'done' || phase === 'failed') && (
        <div className="access-install">
          {running && <p className="access-sub">{t('install.remove.running')}</p>}
          {r.out.length > 0 && <pre className="access-pre">{r.out.join('\n')}</pre>}
          {phase === 'done' && <p className="access-result">{t('install.remove.done')}</p>}
          {phase === 'failed' && (
            <div className="access-failure">
              <p className="access-warn">{t('install.remove.failed')}</p>
              {hint && <p className="access-hint">{hint}</p>}
              {s.error && <p className="access-why">{s.error}</p>}
              <div className="access-actions">
                <button type="button" className="button primary" disabled={!canLook} onClick={onLookAgain}>
                  {t('server.panel.lookAgain')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
