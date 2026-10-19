// Which language the page shows: the one picked in Settings, and a board from the server switches
// the page to the config's language.

/** The user's pick on this page and when: a board sent before it may still come in. */
export type Asked = { lang: string; at: number } | null

/** How long after the user's pick a board in another language is taken as sent before it. */
export const ASKED_MS = 4000

/** The language a board from the server switches the page to, or null to stay. */
export function serverLanguage(boardLang: string, current: string, asked: Asked, now: number): string | null {
  const pending = asked && now - asked.at < ASKED_MS ? asked.lang : null
  return boardLang && boardLang !== current && (!pending || boardLang === pending) ? boardLang : null
}
