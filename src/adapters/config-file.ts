// The board's settings, %APPDATA%\herdr\plugins\config\agent-board\config.json. Written with
// the defaults on first use; edited by hand or from the web board, and picked up live by the
// running board (liveConfig). Categories are the board's lanes, in this order; `paths` guess the
// category of a session from its folder (the longest match wins) until the agent sets one
// itself. Agents may use ids that are not listed: they get a lane too. `profiles` are the Claude
// config folders sessions run in (core/profiles.ts), the ones found on this computer added.
import { existsSync, mkdirSync, statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { builtinTitle, DEFAULT_CONFIG, normalizeConfig, validColor } from '../core/categories.ts'
import { isFoldMode } from '../core/fold-mode.ts'
import { LANGUAGES } from '../core/i18n/translator.ts'
import { t, useLanguage } from '../core/lang.ts'
import { profileCommand } from '../core/launch/spawn-args.ts'
import {
  absoluteProfileDir,
  mergeProfiles,
  PROFILE_COLORS,
  type Profile,
  profileForDir,
  profileIdOf,
  profileTitleOf,
  resolveProfileDir,
  shownProfiles,
} from '../core/profiles.ts'
import type { Category, Config } from '../core/types.ts'
import { wakeConfig } from '../core/wake/config.ts'
import { allCards, writeCard } from './cards.ts'
import { isRecord, readJson, replaceFile } from './json-store.ts'
import { configDir } from './paths.ts'
import { findProfileDirs } from './profiles.ts'

type Raw = Record<string, unknown>
/** What an edit answers the web board and the CLI with. */
export type EditResult = { ok: true } | { ok: false; error: string }

export const configFile = (): string => join(configDir(), 'config.json')

/** config.json as it is on disk, or null when it is missing or no JSON object (half-written, say). */
export const readConfigFile = (): Raw | null => readJson(configFile(), isRecord)

function writeRaw(raw: Raw): void {
  mkdirSync(configDir(), { recursive: true })
  replaceFile(configFile(), `${JSON.stringify(raw, null, 2)}\n`)
}

export function loadConfig(): Config {
  const raw = readConfigFile()
  if (!raw && !existsSync(configFile())) {
    try {
      writeRaw(DEFAULT_CONFIG)
    } catch {}
  }
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  useLanguage(typeof raw?.language === 'string' ? raw.language : DEFAULT_CONFIG.language)
  return normalizeConfig(raw)
}

/**
 * Turn the remote mode (core/remote.ts) on or off in config.json, keeping its other fields. The
 * running board picks it up as any edit (liveConfig).
 */
export function setRemoteOn(on: boolean): EditResult {
  const raw = readConfigFile() ?? structuredClone<Raw>(DEFAULT_CONFIG)
  raw.remote = { ...(isRecord(raw.remote) ? raw.remote : {}), on }
  writeRaw(raw)
  return { ok: true }
}

/**
 * Turn the board in a phone's browser (core/pwa.ts) on or off in config.json, keeping the other
 * fields of `remote.pwa`. On turns the remote mode on too; off leaves it as it is.
 */
export function setPwaOn(on: boolean): EditResult {
  const raw = readConfigFile() ?? structuredClone<Raw>(DEFAULT_CONFIG)
  const remote = isRecord(raw.remote) ? raw.remote : raw.remote === true ? { on: true } : {}
  const pwa = isRecord(remote.pwa) ? remote.pwa : {}
  raw.remote = { ...remote, ...(on ? { on: true } : {}), pwa: { ...pwa, on } }
  writeRaw(raw)
  return { ok: true }
}

/** Change settings in config.json from the web board: { language, foldWaiting }. */
export function editSettings(body: unknown): EditResult {
  const raw = readConfigFile() ?? structuredClone<Raw>(DEFAULT_CONFIG)
  const language = isRecord(body) ? body.language : undefined
  if (language !== undefined) {
    const l = String(language)
    if (l !== 'auto' && !LANGUAGES[l as keyof typeof LANGUAGES])
      return { ok: false, error: t('err.language', { lang: l }) }
    raw.language = l
  }
  // How a session asleep in "Waiting" folds on the web board.
  const fold = isRecord(body) ? body.foldWaiting : undefined
  if (fold !== undefined) {
    if (!isFoldMode(fold)) return { ok: false, error: t('err.foldWaiting', { mode: String(fold) }) }
    raw.foldWaiting = fold
  }
  writeRaw(raw)
  return { ok: true }
}

/** Why a wake switch's value is refused, in the panel's words (err.wakeSetting). */
const wakeRefusal = (field: string, why: string): EditResult => ({
  ok: false,
  error: t('err.wakeSetting', { field: t(field), why: t(why) }),
})

/**
 * Change the Sleep and wake panel's switches in config.json's `wake` section (#119): { on?: boolean;
 * reaper?: { enabled?: boolean; idleMinutes?: number; exclude?: string[] }; telegram?: 'auto' |
 * 'off' }, merged into the section, its other fields (and the reaper's) kept. `"wake": true` or
 * `false`, or a section of another type, first becomes { enabled } as it reads now. A value of the
 * wrong kind refuses the whole edit, and config.json stays as it was. The running board and wake
 * pick the change up as any edit (liveConfig).
 */
export function editWake(body: unknown): EditResult {
  const b: Raw = isRecord(body) ? body : {}
  if (b.on !== undefined && typeof b.on !== 'boolean') return wakeRefusal('wake.switch', 'wake.why.onOff')
  let reaper: Raw | undefined
  if (b.reaper !== undefined) {
    if (!isRecord(b.reaper)) return wakeRefusal('wake.reaper', 'wake.why.onOff')
    const r = b.reaper
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') return wakeRefusal('wake.reaper', 'wake.why.onOff')
    if (r.idleMinutes !== undefined && !(Number.isInteger(r.idleMinutes) && Number(r.idleMinutes) >= 1))
      return wakeRefusal('wake.reaper.minutes', 'wake.why.minutes')
    if (r.exclude !== undefined && !(Array.isArray(r.exclude) && r.exclude.every(e => typeof e === 'string')))
      return wakeRefusal('wake.reaper.exclude', 'wake.why.names')
    reaper = {
      ...(r.enabled !== undefined && { enabled: r.enabled }),
      ...(r.idleMinutes !== undefined && { idleMinutes: r.idleMinutes }),
      ...(Array.isArray(r.exclude) && {
        exclude: r.exclude.map(e => String(e).trim()).filter(Boolean),
      }),
    }
  }
  if (b.telegram !== undefined && b.telegram !== 'auto' && b.telegram !== 'off')
    return wakeRefusal('wake.telegram', 'wake.why.mode')

  const raw = readConfigFile() ?? structuredClone<Raw>(DEFAULT_CONFIG)
  const section: Raw = isRecord(raw.wake)
    ? { ...raw.wake }
    : raw.wake === undefined
      ? {}
      : { enabled: wakeConfig(raw.wake).enabled }
  if (typeof b.on === 'boolean') section.enabled = b.on
  if (reaper) section.reaper = { ...(isRecord(section.reaper) ? section.reaper : {}), ...reaper }
  if (b.telegram !== undefined) section.telegram = b.telegram
  raw.wake = section
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
        if (!readConfigFile()) return
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
  const raw = readConfigFile() ?? structuredClone<Raw>(DEFAULT_CONFIG)
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
      // The lane's usual profile: '' clears it; one that is no id is ignored.
      if (b.profile === '') delete cat.profile
      else if (typeof b.profile === 'string' && ID.test(b.profile)) cat.profile = b.profile
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

/**
 * The profiles config.json lists merged with the folders found in `home` (core/profiles.ts
 * mergeProfiles), and how they go back into the file. A listed one stays the file's own object,
 * its `dir` as typed (`~/.claude-work` stays so): only the fields an edit sets change, and those
 * the board shows it with that it lacks (title, color, hidden) are filled in. The folders added
 * follow in full, then every entry that is no profile (a relative folder, say), as it was.
 */
function profilesIn(raw: Raw, home: string, shownDir?: string | null) {
  const listed: unknown[] = Array.isArray(raw.profiles) ? raw.profiles : []
  const { list, added } = mergeProfiles(listed, findProfileDirs(home), home, shownDir)
  // mergeProfiles takes the listed ones in the file's order, with their id as written and their
  // folder resolved (absoluteProfileDir), so each is found again by both.
  const rest = [...listed]
  const own = new Map<Profile, Raw>()
  for (const p of list) {
    if (added.includes(p)) continue
    const i = rest.findIndex(e => isRecord(e) && e.id === p.id && absoluteProfileDir(e.dir, home) === p.dir)
    const entry = rest[i]
    if (!isRecord(entry)) continue
    own.set(p, entry)
    rest.splice(i, 1)
  }
  return {
    list,
    added,
    /** The object the file keeps `p` in: its own entry, or `p` itself when it is new. */
    entryOf: (p: Profile): Raw => own.get(p) ?? p,
    /** Puts the profiles, changed, back into `raw`. */
    save(): void {
      const entries = list.map(p => {
        const entry = own.get(p)
        if (!entry) return p
        for (const key of ['title', 'color', 'hidden'] as const) if (!(key in entry)) entry[key] = p[key]
        return entry
      })
      raw.profiles = [...entries, ...rest]
    },
  }
}

/** A folder (not a file) that is there. */
function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The first profile color no profile has; with every one taken, round again. */
const freeColor = (list: readonly Profile[]): string =>
  PROFILE_COLORS.find(c => !list.some(p => p.color === c)) ??
  PROFILE_COLORS[list.length % PROFILE_COLORS.length] ??
  'indigo'

/**
 * Change the profiles in config.json from the Profiles panel: { op: 'update', id, title?, color?,
 * hidden?, command? } renames, recolors, shows or hides one, or sets its start command ('' clears
 * it; one profileCommand refuses is refused with its message), never changing its id or folder,
 * and one stays shown; { op: 'add', dir } adds a folder somewhere else ("~" is the home folder), shown.
 */
export function editProfiles(body: unknown, { home = homedir() }: { home?: string } = {}): EditResult {
  const raw = readConfigFile() ?? structuredClone<Raw>(DEFAULT_CONFIG)
  const profiles = profilesIn(raw, home)
  const { list } = profiles
  const b: Raw = isRecord(body) ? body : {}
  switch (b.op) {
    case 'update': {
      const p = list.find(x => x.id === b.id)
      if (!p) return { ok: false, error: t('err.profile.missing', { id: String(b.id) }) }
      const entry = profiles.entryOf(p)
      // The start command first: a refused one leaves the whole edit unwritten.
      if (b.command !== undefined) {
        let words: string[] | null
        try {
          words = profileCommand(b.command)
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        if (words === null) delete entry.command
        else entry.command = typeof b.command === 'string' ? b.command.trim() : b.command
      }
      if (b.title !== undefined) {
        if (!cleanTitle(b.title)) return { ok: false, error: t('err.profile.title') }
        entry.title = cleanTitle(b.title)
      }
      if (b.color !== undefined && validColor(b.color)) entry.color = String(b.color)
      if (typeof b.hidden === 'boolean') {
        if (b.hidden && !p.hidden && !shownProfiles(list).some(x => x !== p))
          return { ok: false, error: t('err.profile.lastShown') }
        entry.hidden = b.hidden
      }
      break
    }
    case 'add': {
      // A folder named relative to wherever the board runs would be another one for each start.
      const dir = resolveProfileDir(typeof b.dir === 'string' ? b.dir : '', home)
      if (!isAbsolute(dir) || !isFolder(dir)) return { ok: false, error: t('err.profile.noFolder', { path: dir }) }
      const known = profileForDir(list, dir)
      if (known) return { ok: false, error: t('err.profile.exists', { path: dir, title: known.title }) }
      const id = profileIdOf(dir, home, new Set(list.map(p => p.id)))
      list.push({ id, title: profileTitleOf(id), dir, color: freeColor(list), hidden: false })
      break
    }
    default:
      return { ok: false, error: `unknown op ${String(b.op)}` }
  }
  profiles.save()
  writeRaw(raw)
  return { ok: true }
}

/** Adds the found folders config.json does not list (shownDir: shown too); true when it wrote. */
export function saveFoundProfiles(inheritedDir: string, home: string = homedir()): boolean {
  // Only into a file that is there: the board's loadConfig makes it, with its defaults, on first use.
  const raw = readConfigFile()
  if (!raw) return false
  const profiles = profilesIn(raw, home, inheritedDir)
  if (!profiles.added.length) return false
  profiles.save()
  writeRaw(raw)
  return true
}
