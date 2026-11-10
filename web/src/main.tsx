// The web board in React: the language, the live board, the side panels' place and the page,
// mounted on #root. In a phone's browser (models/remote-page.ts) the board waits behind pairing. The
// live signs loop at a pace of their own (models/pace.ts). A part that fails to draw shows what went
// wrong instead of an empty page (ErrorBoundary.tsx). On http://localhost:<port>/?confirm=<id> the
// page is the owner's confirmation window instead (#224, team/ConfirmScreen.tsx), and nothing of
// the board starts there.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { RemoteGate } from './components/remote/RemoteGate.tsx'
import { ConfirmScreen } from './components/team/ConfirmScreen.tsx'
import { I18nProvider } from './i18n/I18nProvider.tsx'
import { startPace } from './models/pace.ts'
import { keptLanguage, remotePage } from './models/remote-page.ts'
import { confirmPage } from './models/team-confirm.ts'
import { startPhoneApp } from './phone-app.ts'
import { BoardProvider } from './state/BoardProvider.tsx'
import { PanelProvider } from './state/PanelProvider.tsx'

const root = document.getElementById('root')
const confirming = confirmPage()
const board = (
  <BoardProvider>
    <PanelProvider>
      <App />
    </PanelProvider>
  </BoardProvider>
)
if (root && confirming)
  createRoot(root).render(
    <StrictMode>
      <I18nProvider lang={document.documentElement.lang}>
        <ConfirmScreen id={confirming} />
      </I18nProvider>
    </StrictMode>,
  )
else if (root)
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary scope="page">
        <I18nProvider lang={(remotePage() && keptLanguage()) || document.documentElement.lang}>
          {remotePage() ? <RemoteGate>{board}</RemoteGate> : board}
        </I18nProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
if (!confirming) {
  if (remotePage()) startPhoneApp()
  startPace()
}
