// What the page shows in place of a part that failed to draw, instead of nothing: the whole page
// (main.tsx), or the session panel on its own (SidePanels.tsx), so a panel that fails leaves the
// board. A short note with the error and Reload; the panel's has Close too. In a phone's browser
// the error goes to the board's log as well (phone-app.ts); on the computer it is in the console.
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { translator } from '../../../src/core/i18n/translator.ts'
import { errorMessage, type ReportError } from '../models/page-errors.ts'
import { keptLanguage, remotePage } from '../models/remote-page.ts'
import { reportPageError } from '../phone-app.ts'

export type ErrorScope = 'page' | 'panel'

interface Props {
  scope: ErrorScope
  /** Another value (another session opened) draws the part again. */
  resetKey?: unknown
  /** The panel's way out besides Reload. */
  onClose?: (() => void) | undefined
  /** Where the error goes; by default the board's log in a phone's browser, nowhere on the computer. */
  report?: ReportError | undefined
  children?: ReactNode
}

interface State {
  failed: boolean
  error: unknown
  resetKey: unknown
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { failed: false, error: null, resetKey: props.resetKey }
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { failed: false, error: null, resetKey: props.resetKey }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const report = this.props.report ?? (remotePage() ? reportPageError : null)
    report?.('render', error, info.componentStack ?? '')
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return <ErrorScreen scope={this.props.scope} error={this.state.error} onClose={this.props.onClose} />
  }
}

/**
 * The page's language as it shows now (I18nProvider sets it), so the note needs no provider above
 * it; on a phone, the one kept from the board before, for a page that failed before it heard.
 */
const pageLang = (): string =>
  typeof document === 'undefined' ? 'en' : (remotePage() && keptLanguage()) || document.documentElement.lang

export function ErrorScreen({
  scope,
  error,
  onClose,
}: {
  scope: ErrorScope
  error: unknown
  onClose?: (() => void) | undefined
}) {
  const t = translator(pageLang())
  const panel = scope === 'panel'
  const Title = panel ? 'h2' : 'h1'
  return (
    <div className={`error-screen ${scope}`} role="alert">
      <div className="error-note">
        <Title className="error-title">{t(panel ? 'error.panel' : 'error.title')}</Title>
        <p className="error-about">{t(panel ? 'error.panelAbout' : 'error.about')}</p>
        <pre className="error-detail">{errorMessage(error)}</pre>
        <div className="error-actions">
          {panel && onClose && (
            <button type="button" className="error-button" onClick={onClose}>
              {t('error.close')}
            </button>
          )}
          <button type="button" className="error-button primary" onClick={() => location.reload()}>
            {t('error.reload')}
          </button>
        </div>
      </div>
    </div>
  )
}
