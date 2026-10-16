// Which language the page shows: the toolbar's button goes round the board's languages, and a
// board from the server switches the page to the config's language.

/** The language after `current` in `codes`, round again after the last. */
export function nextLanguage(codes: string[], current: string): string {
  return codes[(codes.indexOf(current) + 1) % codes.length] ?? current
}

/** The user's pick on this page and when: a board sent before it may still come in. */
export type Asked = { lang: string; at: number } | null

/** How long after the user's pick a board in another language is taken as sent before it. */
export const ASKED_MS = 4000

/** The language a board from the server switches the page to, or null to stay. */
export function serverLanguage(boardLang: string, current: string, asked: Asked, now: number): string | null {
  const pending = asked && now - asked.at < ASKED_MS ? asked.lang : null
  return boardLang && boardLang !== current && (!pending || boardLang === pending) ? boardLang : null
}
