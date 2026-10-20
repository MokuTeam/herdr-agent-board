// The categories editor's rules: the latin id a new category gets from its title, what the "new
// category" form creates and in which color, and what a row says and saves (its title, folders
// and the folders it offers to add, delete, usual profile). The editor is components/categories;
// the server keeps the categories in config.json.
import { folderSuggestions, sameDir } from '../../../src/core/launch/names.ts'
import type { BoardCategory, BoardProfile, Swatch } from '../../../src/core/payload.ts'
import type { Item, Translator } from '../../../src/core/types.ts'

// A category titled in Cyrillic gets a latin id agents can type: "Ромашка" -> "romashka".
const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
}

export const slug = (s: string): string =>
  [...String(s).toLowerCase()]
    .map(c => TRANSLIT[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)

/** What the "new category" form creates: an id typed by hand, else the title's slug; null when nothing is typed. */
export function draftCategory(title: string, id: string): { id: string; title: string } | null {
  const name = title.trim()
  const own = id.trim() || slug(name)
  if (!name && !own) return null
  return { id: own, title: name || own }
}

/** A new category's color: the first swatch no category has yet, else blue. */
export function draftColor(categories: BoardCategory[], swatches: Swatch[]): Swatch {
  const used = new Set(categories.map(c => c.colorName))
  const name = swatches.find(s => !used.has(s.name))?.name ?? 'blue'
  return { name, hex: swatches.find(s => s.name === name)?.hex ?? 'var(--accent)' }
}

/** Sessions per lane: every session on the board, in the lane it shows in. */
export function categoryCounts(items: Item[], categoryOf: (item: Item) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const it of items) counts.set(categoryOf(it), (counts.get(categoryOf(it)) ?? 0) + 1)
  return counts
}

/** A row's count of sessions and its id; a lane an agent made, not in the settings, says so. */
export function rowText(c: BoardCategory, count: number, t: Translator): { count: string; id: string } {
  return {
    count: count ? t('cat.sessions', { n: count }) : t('cat.empty'),
    id: c.configured ? c.id : t('cat.byAgent', { id: c.id }),
  }
}

/** The title to save when the title field is left: a configured lane's, trimmed and new; else null (it goes back). */
export function renamed(c: BoardCategory | undefined, value: string): string | null {
  const title = value.trim()
  return c?.configured && title && title !== c.title ? title : null
}

/**
 * The lane's folders with one more, as typed (trimmed): `C:\work`, `\\server\share`, `/home/me`
 * and `~/src` alike. The server drops a trailing separator and matches either one
 * (src/adapters/config-file.ts, src/core/categories.ts). Null when nothing is typed, or when the
 * lane has that folder already, however it is written (case, separators, a trailing one).
 */
export function withPath(c: BoardCategory, value: string): string[] | null {
  const path = value.trim()
  return path && !c.paths.some(p => sameDir(p, path)) ? [...c.paths, path] : null
}

/** Where a lane's "+ folder" finds folders to offer: the board's sessions, in the lanes they show in, and recent ones. */
export interface FolderSources {
  sessions: { cwd?: string; category?: string; activity?: number }[]
  /** Folders of recent Claude sessions on this machine (GET /api/launch/options). */
  recent: string[]
}

/** How many folders a lane's "+ folder" offers at most. */
const OFFERED = 10

/**
 * What a lane's "+ folder" offers while it is empty, best first: the folders of the lane's sessions,
 * newest first, then of recent sessions, then of the board's other sessions (core/launch/names.ts
 * folderSuggestions, without the lanes' own folders); none the lane has already.
 */
export function laneSuggestions(c: BoardCategory, { sessions, recent }: FolderSources) {
  const offered = folderSuggestions(
    { context: { category: c.id }, categories: [], items: sessions, recent },
    OFFERED + c.paths.length,
  )
  return offered.filter(x => !c.paths.some(p => sameDir(p, x.path))).slice(0, OFFERED)
}

/** The lane's folders without the one whose × was clicked (by its exact text). */
export const withoutPath = (c: BoardCategory, path: string): string[] => c.paths.filter(p => p !== path)

/** Delete asks first, saying how many sessions then go by their folder. */
export const confirmText = (sessions: number, t: Translator): string =>
  sessions ? t('cat.confirmN', { n: sessions }) : t('cat.confirm')

/** The row whose swatches are open after a click on `c`'s color: its own toggle (a configured lane's), the others close. */
export const paletteAfter = (open: string | null, c: BoardCategory): string | null =>
  c.configured && open !== c.id ? c.id : null

/** The swatch of the lane's color, named or as hex. */
export const swatchPressed = (s: Swatch, c: BoardCategory): boolean =>
  s.name === c.colorName || s.hex.toLowerCase() === String(c.colorName).toLowerCase()

/**
 * What a lane's usual profile can be (besides none): the shown profiles, in the list's order. Null
 * with fewer than two shown: one profile shown, the rows have no such field, as before profiles.
 */
export function profileChoices(profiles: BoardProfile[] | undefined): { id: string; title: string }[] | null {
  const shown = (profiles ?? []).filter(p => !p.hidden)
  return shown.length < 2 ? null : shown.map(p => ({ id: p.id, title: p.title }))
}

/**
 * The options of a lane's usual profile (besides none): the profiles it can be (`choices`), then
 * the one it has (`usual`) when that is none of them, hidden or no longer listed: as itself, by its
 * id, and off (`off`), so the field shows what is set and it can be cleared, but not picked again.
 */
export function usualOptions(
  choices: readonly { id: string; title: string }[],
  usual: string | undefined,
): { id: string; title: string; off: boolean }[] {
  const options = choices.map(p => ({ id: p.id, title: p.title, off: false }))
  return usual && !choices.some(p => p.id === usual) ? [...options, { id: usual, title: usual, off: true }] : options
}
