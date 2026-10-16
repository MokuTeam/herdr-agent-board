// The web board in React: the language, the live board and the page, mounted on #root.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { I18nProvider } from './i18n/I18nProvider.tsx'
import { BoardProvider } from './state/BoardProvider.tsx'

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <StrictMode>
      <I18nProvider lang={document.documentElement.lang}>
        <BoardProvider>
          <App />
        </BoardProvider>
      </I18nProvider>
    </StrictMode>,
  )
