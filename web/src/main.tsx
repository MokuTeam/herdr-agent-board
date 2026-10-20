// The web board in React: the language, the live board, the side panels' place and the page,
// mounted on #root. In a phone's browser (models/remote-page.ts) the board waits behind pairing.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { RemoteGate } from './components/remote/RemoteGate.tsx'
import { I18nProvider } from './i18n/I18nProvider.tsx'
import { keptLanguage, remotePage } from './models/remote-page.ts'
import { startPhoneApp } from './phone-app.ts'
import { BoardProvider } from './state/BoardProvider.tsx'
import { PanelProvider } from './state/PanelProvider.tsx'

const root = document.getElementById('root')
const board = (
  <BoardProvider>
    <PanelProvider>
      <App />
    </PanelProvider>
  </BoardProvider>
)
if (root)
  createRoot(root).render(
    <StrictMode>
      <I18nProvider lang={(remotePage() && keptLanguage()) || document.documentElement.lang}>
        {remotePage() ? <RemoteGate>{board}</RemoteGate> : board}
      </I18nProvider>
    </StrictMode>,
  )
if (remotePage()) startPhoneApp()
