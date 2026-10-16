// The board's settings, %APPDATA%\herdr\plugins\config\agent-board\config.json. Written with
// the defaults on first use; edited by hand or from the web board, and picked up live by the
// running board (liveConfig). Categories are the board's lanes, in this order; `paths` guess the
// category of a session from its folder (the longest match wins) until the agent sets one
// itself. Agents may use ids that are not listed: they get a lane too.
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LANGUAGES } from './core/i18n/translator.ts'
import { builtinTitle, DEFAULT_CONFIG, normalizeConfig, validColor } from './core/categories.ts'
import { t, useLanguage } from './core/lang.ts'
import { CONFIG_DIR } from './paths.mjs'
import { allCards, writeCard } from './store.mjs'

export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

function readRaw() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeRaw(raw) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`)
  renameSync(tmp, CONFIG_FILE)
}

export function loadConfig() {
  const raw = readRaw()
  if (!raw && !existsSync(CONFIG_FILE)) {
    try {
      writeRaw(DEFAULT_CONFIG)
    } catch {}
  }
  useLanguage(raw?.language ?? DEFAULT_CONFIG.language)
  return normalizeConfig(raw)
}

/** Change settings in config.json from the web board: { language }. */
export function editSettings(body) {
  const raw = readRaw() ?? structuredClone(DEFAULT_CONFIG)
  if (body?.language !== undefined) {
    const l = String(body.language)
    if (l !== 'auto' && !LANGUAGES[l]) return { ok: false, error: t('err.language', { lang: l }) }
    raw.language = l
  }
  writeRaw(raw)
  return { ok: true }
}

/**
 * The config, kept current: the returned object is updated in place whenever config.json
 * changes (by hand or from the web board), then `onChange` runs. One watcher per process.
 */
export function liveConfig(onChange = () => {}) {
  const cfg = loadConfig()
  let timer = null
  let last = JSON.stringify(cfg)
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    watch(CONFIG_DIR, (_, name) => {
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

function cleanPaths(paths) {
  if (!Array.isArray(paths)) return null
  return [...new Set(paths.map(p => String(p ?? '').trim().replace(/[\\/]+$/, '')).filter(Boolean))]
}

/**
 * Change the categories in config.json: { op: 'create' | 'update' | 'delete' | 'order', ... }.
 * Ids are fixed once created (cards point at them). Deleting one drops it from the cards that
 * named it, so those sessions fall back to the folder guess. "other" is the fallback lane and stays.
 */
export function editCategories(body) {
  const raw = readRaw() ?? structuredClone(DEFAULT_CONFIG)
  const cats = raw.categories?.length ? raw.categories : structuredClone(DEFAULT_CONFIG.categories)
  const find = id => cats.find(c => c.id === id)
  const title = t => String(t ?? '').trim().slice(0, 40)
  switch (body?.op) {
    case 'create': {
      const id = String(body.id ?? '').trim().toLowerCase()
      if (!ID.test(id)) return { ok: false, error: t('err.cat.id') }
      if (find(id)) return { ok: false, error: t('err.cat.exists', { id }) }
      const cat = { id, title: title(body.title) || id, color: validColor(body.color) ? body.color : 'blue', paths: cleanPaths(body.paths) ?? [] }
      const other = cats.findIndex(c => c.id === 'other')
      cats.splice(other >= 0 ? other : cats.length, 0, cat)
      break
    }
    case 'update': {
      const cat = find(body.id)
      if (!cat) return { ok: false, error: t('err.cat.missing', { id: body.id }) }
      if (body.title !== undefined) {
        if (!title(body.title)) return { ok: false, error: t('err.cat.emptyTitle') }
        cat.title = title(body.title)
      }
      if (body.color !== undefined && validColor(body.color)) cat.color = body.color
      if (body.paths !== undefined) cat.paths = cleanPaths(body.paths) ?? cat.paths
      break
    }
    case 'delete': {
      if (body.id === 'other') return { ok: false, error: t('err.cat.other', { title: t('q', { s: find('other')?.title || builtinTitle('other') }) }) }
      const i = cats.findIndex(c => c.id === body.id)
      if (i < 0) return { ok: false, error: t('err.cat.missing', { id: body.id }) }
      cats.splice(i, 1)
      for (const card of allCards().values()) if (card.category === body.id) writeCard(card.key, { category: '' })
      break
    }
    case 'order': {
      const ids = Array.isArray(body.ids) ? body.ids : []
      const rank = id => (ids.includes(id) ? ids.indexOf(id) : ids.length + cats.findIndex(c => c.id === id))
      cats.sort((a, b) => rank(a.id) - rank(b.id))
      break
    }
    default:
      return { ok: false, error: `unknown op ${body?.op}` }
  }
  raw.categories = cats
  writeRaw(raw)
  return { ok: true }
}
