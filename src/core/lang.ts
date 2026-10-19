// The board's language in this process. loadConfig() sets it from the config's `language`, so a
// switch on the web board reaches the terminal board, the server and the next brief at once.
import { LANGUAGE_NAMES, resolveLanguage, translator } from './i18n/translator.ts'
import type { Lang, Translator, Vars } from './types.ts'

let current: Translator = translator(resolveLanguage('auto'))
const listeners = new Set<(lang: Lang) => void>()

/** Text in the board's language: t('col.me'), t('sent.files', { n: 2 }); t.lang is its code. */
export const t: Translator = Object.defineProperty((key: string, vars?: Vars) => current(key, vars), 'lang', {
  get: () => current.lang,
}) as Translator

export const lang = (): Lang => current.lang

/** For the brief: "English", "Russian". */
export const languageName = (): string => LANGUAGE_NAMES[current.lang] ?? 'English'

/** Switch to `pref` ("auto", "en", "ru"); returns the language now in use. */
export function useLanguage(pref: string | undefined): Lang {
  const next = resolveLanguage(pref)
  if (next !== current.lang) {
    current = translator(next)
    for (const fn of listeners) fn(next)
  }
  return next
}

/** Runs `fn(lang)` after every switch (caches that hold translated text clear themselves). */
export function onLanguage(fn: (lang: Lang) => void): void {
  listeners.add(fn)
}
