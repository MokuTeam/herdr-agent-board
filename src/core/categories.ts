// The board's lanes: colours, the default settings, and how raw settings from config.json become
// a Config. Categories are the board's lanes, in this order; `paths` guess the category of a
// session from its folder (the longest match wins) until the agent sets one itself. Agents may
// use ids that are not listed: they get a lane too.
import { t } from './lang.ts'
import type { Category, Config } from './types.ts'

// Apple's system colors; a category's color is one of these names or a #hex.
export const PALETTE: Readonly<Record<string, string>> = {
  blue: '#007AFF',
  cyan: '#32ADE6',
  teal: '#30B0C7',
  mint: '#00C7BE',
  green: '#34C759',
  yellow: '#FFCC00',
  orange: '#FF9500',
  red: '#FF3B30',
  pink: '#FF2D55',
  magenta: '#FF2D55',
  purple: '#AF52DE',
  indigo: '#5856D6',
  brown: '#A2845E',
  gray: '#8E8E93',
  white: '#8E8E93',
}

export const validColor = (c: unknown): boolean => !!PALETTE[String(c)] || /^#[0-9a-f]{3,8}$/i.test(String(c))

export const colorHex = (c: string): string => PALETTE[c] ?? (validColor(c) ? c : (PALETTE.gray as string))

export const DEFAULT_CONFIG: Config = {
  // "auto" (the system's language), "en" or "ru": the board's texts and the language agents
  // write their cards in.
  language: 'auto',
  // A start; lanes for clients come from the agents (`board cat <id> "<Title>"`) or the web
  // board's category editor, which also sets the folders that guess a session's lane. These
  // three have no title of their own: they read in the board's language until one is given.
  categories: [
    { id: 'work', color: 'cyan', paths: [] },
    { id: 'personal', color: 'green', paths: [] },
    { id: 'other', color: 'gray', paths: [] },
  ],
  // workspace: a workspace of its own that stays open (default); tab: a tab in the current
  // workspace; overlay: over the current pane, closed when you leave it
  placement: 'workspace',
  workspace: 'Board',
  refreshSec: 2,
  // herdr-wake router, for sleeping sessions; the board works without it
  wakeUrl: 'http://127.0.0.1:12421',
  // A reminder due while its session works or waits on a dialog is tried this long, then missed.
  scheduleWaitMin: 240,
}

/** Title of a lane that has none: the built-in ones in the board's language, else the id. */
export function builtinTitle(id: string): string {
  const key = `lane.${id}`
  const title = t(key)
  return title === key ? id : title
}

/** Raw settings (as read from config.json, or nothing) merged over the defaults. */
export function normalizeConfig(raw: unknown): Config {
  const file = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const listed = file.categories
  const cats = (
    Array.isArray(listed) && listed.length ? listed : structuredClone(DEFAULT_CONFIG.categories)
  ) as Category[]
  return {
    ...DEFAULT_CONFIG,
    ...file,
    categories: cats.map(c => (c.title ? c : { ...c, title: builtinTitle(c.id) })),
  } as Config
}

const norm = (p: unknown): string =>
  String(p ?? '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()

/** The category id configured for a folder, or null. */
export function categoryFor(cfg: Pick<Config, 'categories'>, cwd: string): string | null {
  const dir = norm(cwd)
  let best: string | null = null
  let bestLen = -1
  for (const c of cfg.categories) {
    for (const p of c.paths ?? []) {
      const n = norm(p)
      if (n && (dir === n || dir.startsWith(`${n}/`)) && n.length > bestLen) {
        best = c.id
        bestLen = n.length
      }
    }
  }
  return best
}

/** Sort key of a lane: config order, with lanes agents made up just before "other". */
export function laneRank(cfg: Pick<Config, 'categories'>, id: string): number {
  const order = cfg.categories.map(c => c.id)
  const i = order.indexOf(id)
  if (i >= 0) return i
  const other = order.indexOf('other')
  return other >= 0 ? other - 0.5 : order.length
}

/** Category record for an id, including ids agents made up. */
export function categoryInfo(cfg: Pick<Config, 'categories'>, id: string): Category & { title: string } {
  const found = cfg.categories.find(c => c.id === id)
  return { id, color: 'gray', paths: [], ...found, title: found?.title ?? builtinTitle(id) }
}
