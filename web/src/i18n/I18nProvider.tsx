// Texts in the board's language. The server says which one (config `language`); the toolbar
// switches it, and the page shows the pick at once.
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { translator } from '../../../src/core/i18n/translator.ts'
import type { Translator } from '../../../src/core/types.ts'
import { type Asked, serverLanguage } from '../models/language.ts'

export interface I18n {
  t: Translator
  /** The user's pick on this page. */
  choose(lang: string): void
  /** The language of a board from the server, unless the user just picked another. */
  follow(lang: string): void
}

const I18nContext = createContext<I18n | null>(null)

export function I18nProvider({ lang: initial, children }: { lang: string; children: ReactNode }) {
  const [lang, setLang] = useState(initial)
  const asked = useRef<Asked>(null)
  const t = useMemo(() => translator(lang), [lang])

  useEffect(() => {
    document.documentElement.lang = t.lang
  }, [t])

  const value = useMemo<I18n>(
    () => ({
      t,
      choose(next) {
        asked.current = { lang: next, at: Date.now() }
        setLang(next)
      },
      follow(boardLang) {
        const next = serverLanguage(boardLang, t.lang, asked.current, Date.now())
        if (next) setLang(next)
      },
    }),
    [t],
  )
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useLanguage(): I18n {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useLanguage outside I18nProvider')
  return value
}

export function useT(): Translator {
  return useLanguage().t
}
