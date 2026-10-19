// `t(key, vars)` for one language, and the choice of the language from the config / the system.
import type { Lang, Translator, Vars } from '../types.ts'
import { STRINGS } from './strings.ts'

export type { Lang, Translator, Vars }

export const LANGUAGES: Record<Lang, string> = { en: 'English', ru: 'Русский' }
/** The language's name in English, for the agents' brief. */
export const LANGUAGE_NAMES: Record<Lang, string> = { en: 'English', ru: 'Russian' }

const PLURAL: Record<Lang, (n: number) => number> = {
  en: n => (n === 1 ? 0 : 1),
  ru: n => {
    const m10 = n % 10
    const m100 = n % 100
    return m10 === 1 && m100 !== 11 ? 0 : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 1 : 2
  },
}

function isLang(code: string | undefined): code is Lang {
  return code !== undefined && Object.hasOwn(STRINGS, code)
}

/** "auto" or anything without a dictionary: the system's language when there is one for it, else English. */
export function resolveLanguage(pref: string | undefined, locale?: string): Lang {
  if (isLang(pref)) return pref
  let sys = locale
  if (!sys) {
    try {
      sys = Intl.DateTimeFormat().resolvedOptions().locale
    } catch {}
  }
  const code = String(sys ?? '')
    .slice(0, 2)
    .toLowerCase()
  return isLang(code) ? code : 'en'
}

/** `t(key, vars)` for one language; `t.lang` is its code. */
export function translator(lang: string): Translator {
  const code: Lang = isLang(lang) ? lang : 'en'
  const t = (key: string, vars: Vars = {}): string => {
    const own = STRINGS[code][key]
    const from: Lang = own !== undefined ? code : 'en'
    let s = own ?? STRINGS.en[key] ?? key
    if (Array.isArray(s)) s = s[PLURAL[from](Number(vars.n) || 0)] ?? s.at(-1) ?? key
    return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
  }
  return Object.assign(t, { lang: code })
}

/** Keys that exist in English but not in `lang` (for the tests). */
export function missingKeys(lang: Lang): string[] {
  return Object.keys(STRINGS.en).filter(k => !(k in (STRINGS[lang] ?? {})) && k !== 'status.unknown')
}
