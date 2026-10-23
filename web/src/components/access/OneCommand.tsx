// "Do it myself (one command)" in "On the server" (the simple-setup spec's "Do it myself"): a fold
// with three short lines on what the command does, the one command with Copy, what is inside it
// (the script, readable), its Undo command with its own script, then Test connection, and "Set up
// by hand" with the address once Test connection found the board there. The command is the
// board's (models/server-oneshot.ts), asked for as the fold opens (ServerSetup.tsx); nothing here
// sends anything but Test connection.
import type { SyntheticEvent } from 'react'
import type { TestStep } from '../../../../src/core/tunnel.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { stepMarks } from '../../models/access.ts'
import { byHandAddress, type OneshotGot } from '../../models/server-oneshot.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { Paste } from './Snippets.tsx'

export interface OneCommandProps {
  open: boolean
  got: OneshotGot
  /** Why there is no command to show yet ('' for none): the board's address not typed. */
  why: string
  /** The fold opened (the command is asked for) or closed by the owner. */
  onToggle(open: boolean): void
  onTest(): void
  steps: TestStep[] | null
  testing: boolean
  /** The public port Test connection found the board on after the command; null before it did. */
  byHand: number | null
  /** The board's address, for "Set up by hand". */
  domain: string
}

export function OneCommand({ open, got, why, onToggle, onTest, steps, testing, byHand, domain }: OneCommandProps) {
  const t = useT()
  const { canEdit } = useBoardContext()
  // The browser opens and closes the fold; the part keeps whether it is open (what it holds is
  // asked for as it opens). Drawn open or closed by the part, it says so too: then nothing changed.
  const toggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    const now = e.currentTarget.hasAttribute('open')
    if (now !== open) onToggle(now)
  }
  return (
    <details className="access-oneshot" open={open} onToggle={toggle}>
      <summary className="access-summary">{t('server.panel.oneshot')}</summary>
      {open && (
        <div className="access-oneshot-body">
          <p className="access-note">{t('server.panel.oneshotWhere')}</p>
          <p className="access-note">{t('server.panel.oneshotWhat')}</p>
          <p className="access-note">{t('server.panel.oneshotEnd')}</p>
          {why && <p className="access-look-why">{why}</p>}
          {got.state === 'loading' && <p className="access-kept">{t('server.panel.oneshotMaking')}</p>}
          {got.state === 'error' && (
            <p className="access-why">{t('server.panel.oneshotFailed', { error: got.error })}</p>
          )}
          {got.state === 'ok' && (
            <>
              <div className="access-command">
                <Paste text={got.oneshot.command} />
              </div>
              <details className="access-inside">
                <summary className="access-summary">{t('server.panel.oneshotInside')}</summary>
                <pre className="access-pre">
                  <code>{got.oneshot.script}</code>
                </pre>
              </details>
              <details className="access-undo-command">
                <summary className="access-summary">{t('server.panel.oneshotUndo')}</summary>
                <div className="access-command">
                  <Paste text={got.oneshot.undoCommand} />
                </div>
                <details className="access-inside">
                  <summary className="access-summary">{t('server.panel.oneshotInside')}</summary>
                  <pre className="access-pre">
                    <code>{got.oneshot.undoScript}</code>
                  </pre>
                </details>
              </details>
            </>
          )}
          <div className="access-actions">
            <span className="access-then">{t('server.panel.oneshotThen')}</span>
            <button type="button" className="button" disabled={!canEdit || testing} onClick={onTest}>
              {testing ? t('access.testing') : t('access.test')}
            </button>
          </div>
          {steps && <p className="access-marks">{stepMarks(steps, t)}</p>}
          {byHand !== null && (
            <p className="access-done">{t('server.panel.byHandDone', { address: byHandAddress(domain, byHand) })}</p>
          )}
        </div>
      )}
    </details>
  )
}
