// The board's settings, %APPDATA%\herdr\plugins\config\agent-board\config.json. Written with
// the defaults on first use; edited by hand or from the web board, and picked up live by the
// running board (liveConfig). Categories are the board's lanes, in this order; `paths` guess the
// category of a session from its folder (the longest match wins) until the agent sets one
// itself. Agents may use ids that are not listed: they get a lane too.
import { existsSync, mkdirSync, watch } from 'node:fs'
import { join } from 'node:path'
import { builtinTitle, DEFAULT_CONFIG, normalizeConfig, validColor } from '../core/categories.ts'
import { LANGUAGES } from '../core/i18n/translator.ts'
import { t, useLanguage } from '../core/lang.ts'
import type { Category, Config } from '../core/types.ts'
import { allCards, writeCard } from './cards.ts'
import { isRecord, readJson, replaceFile } from './json-store.ts'
import { configDir } from './paths.ts'

type Raw = Record<string, unknown>
/** What an edit answers the web board and the CLI with. */
export type EditResult = { ok: true } | { ok: false; error: string }

export const configFile = (): string => join(configDir(), 'config.json')

const readRaw = (): Raw | null => readJson(configFile(), isRecord)

function writeRaw(raw: Raw): void {
  mkdirSync(configDir(), { recursive: true })
  replaceFile(configFile(), `${JSON.stringify(raw, null, 2)}\n`)
}

export function loadConfig(): Config {
  const raw = readRaw()
  if (!raw && !existsSync(configFile())) {
    try {
      writeRaw(DEFAULT_CONFIG)
    } catch {}
  }
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  useLanguage(typeof raw?.language === 'string' ? raw.language : DEFAULT_CONFIG.language)
  return normalizeConfig(raw)
}

/** Change settings in config.json from the web board: { language }. */
export function editSettings(body: unknown): EditResult {
  const raw = readRaw() ?? structuredClone<Raw>(DEFAULT_CONFIG)
  const language = isRecord(body) ? body.language : undefined
  if (language !== undefined) {
    const l = String(language)
    if (l !== 'auto' && !LANGUAGES[l as keyof typeof LANGUAGES])
      return { ok: false, error: t('err.language', { lang: l }) }
    raw.language = l
  }
  writeRaw(raw)
  return { ok: true }
}

/**
 * The config, kept current: the returned object is updated in place whenever config.json
 * changes (by hand or from the web board), then `onChange` runs. One watcher per process.
 */
export function liveConfig(onChange: (cfg: Config) => void = () => {}): Config {
  const cfg = loadConfig()
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = JSON.stringify(cfg)
  try {
    mkdirSync(configDir(), { recursive: true })
    watch(configDir(), (_, name) => {
      if (name && name !== 'config.json') return
      clearTimeout(timer)
      timer = setTimeout(() => {
        // A half-written file by an editor reads as invalid: keep the last good config then.
        if (!readRaw()) return
        const next = loadConfig()
        const text = JSON.stringify(next)
        if (text === last) return
        last = text
        for (const k of Object.keys(cfg)) delete cfg[k]
        Object.assign(cfg, next)
        onChange(cfg)
      }, 120)
    })
  } catch {}
  return cfg
}

const ID = /^[a-z0-9_-]{1,32}$/

function cleanPaths(paths: unknown): string[] | null {
  if (!Array.isArray(paths)) return null
  return [
    ...new Set(
      paths
        .map(p =>
          String(p ?? '')
            .trim()
            .replace(/[\\/]+$/, ''),
        )
        .filter(Boolean),
    ),
  ]
}

const cleanTitle = (title: unknown): string =>
  String(title ?? '')
    .trim()
    .slice(0, 40)

/**
 * An entry the editor can change: an object, the lane the board makes of it (core/categories.ts
 * normalizeConfig), its id as it is, as upstream's editor took them.
 */
const editable = isRecord

/**
 * The categories in a raw config file, as the editor works on them: every entry as it is; one
 * that is not an object stays in its place, untouched. With no object among them the board shows
 * the default lanes: the editor works on those then, the other entries kept after them, as
 * upstream's did on a file without lanes.
 */
function categoriesOf(raw: Raw): unknown[] {
  const listed = Array.isArray(raw.categories) ? raw.categories : []
  if (listed.some(editable)) return [...listed]
  return [...structuredClone(DEFAULT_CONFIG.categories), ...listed]
}

/** `cats` with its editable entries in the order `ids` gives (the others after, as they were); the rest stay put. */
function ordered(cats: unknown[], ids: unknown[]): unknown[] {
  const listed = cats.filter(editable)
  const rank = (id: unknown) => (ids.includes(id) ? ids.indexOf(id) : ids.length + listed.findIndex(c => c.id === id))
  const sorted = [...listed].sort((a, c) => rank(a.id) - rank(c.id))
  let next = 0
  return cats.map(c => (editable(c) ? (sorted[next++] ?? c) : c))
}

/**
 * Change the categories in config.json: { op: 'create' | 'update' | 'delete' | 'order', ... }.
 * Ids are fixed once created (cards point at them). Deleting one drops it from the cards that
 * named it, so those sessions fall back to the folder guess. "other" is the fallback lane and stays.
 */
export function editCategories(body: unknown): EditResult {
  const raw = readRaw() ?? structuredClone<Raw>(DEFAULT_CONFIG)
  let cats = categoriesOf(raw)
  const find = (id: unknown) => cats.filter(editable).find(c => c.id === id)
  const b: Raw = isRecord(body) ? body : {}
  switch (b.op) {
    case 'create': {
      const id = String(b.id ?? '')
        .trim()
        .toLowerCase()
      if (!ID.test(id)) return { ok: false, error: t('err.cat.id') }
      if (find(id)) return { ok: false, error: t('err.cat.exists', { id }) }
      const cat: Category = {
        id,
        title: cleanTitle(b.title) || id,
        color: validColor(b.color) ? String(b.color) : 'blue',
        paths: cleanPaths(b.paths) ?? [],
      }
      const other = cats.findIndex(c => editable(c) && c.id === 'other')
      cats.splice(other >= 0 ? other : cats.length, 0, cat)
      break
    }
    case 'update': {
      const cat = find(b.id)
      if (!cat) return { ok: false, error: t('err.cat.missing', { id: String(b.id) }) }
      if (b.title !== undefined) {
        if (!cleanTitle(b.title)) return { ok: false, error: t('err.cat.emptyTitle') }
        cat.title = cleanTitle(b.title)
      }
      if (b.color !== undefined && validColor(b.color)) cat.color = String(b.color)
      if (b.paths !== undefined) cat.paths = cleanPaths(b.paths) ?? cat.paths
      break
    }
    case 'delete': {
      if (b.id === 'other') {
        return {
          ok: false,
          error: t('err.cat.other', { title: t('q', { s: String(find('other')?.title || builtinTitle('other')) }) }),
        }
      }
      const i = cats.findIndex(c => editable(c) && c.id === b.id)
      if (i < 0) return { ok: false, error: t('err.cat.missing', { id: String(b.id) }) }
      cats.splice(i, 1)
      for (const card of allCards().values())
        if (card.key && card.category === b.id) writeCard(card.key, { category: '' })
      break
    }
    case 'order': {
      cats = ordered(cats, Array.isArray(b.ids) ? b.ids : [])
      break
    }
    default:
      return { ok: false, error: `unknown op ${String(b.op)}` }
  }
  raw.categories = cats
  writeRaw(raw)
  return { ok: true }
}
