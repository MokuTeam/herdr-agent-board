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
import { isMokupilotMode } from '../core/mokupilot-mode.ts'
import { isPresenceMode, MAX_IDLE_MINUTES, presenceConfig } from '../core/presence.ts'
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
import type { Admin } from '../core/server-admin.ts'
import type { SetupCase } from '../core/server-plan.ts'
import { projectKey } from '../core/time.ts'
import { isTodoMode } from '../core/todos.ts'
import { fieldProblem, type TunnelField } from '../core/tunnel.ts'
import type { Category, Config } from '../core/types.ts'
import { wakeConfig } from '../core/wake/config.ts'
import { allCards, writeCard } from './cards.ts'
import { isRecord, readJson, replaceFile, withLock } from './json-store.ts'
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

/**
 * `fn` under config.json's lock (json-store.ts withLock), with the file as it is (null: missing, or
 * no JSON object) and `save` to write it changed. Every edit of the file goes through here: the
 * Settings panels, `board time --new-project`, the import's projects and Settings → Time writing
 * at once never lose each other's change (each read before the other wrote, once, did).
 */
export function withConfigFile<T>(fn: (raw: Raw | null, save: (next: Raw) => void) => T): T {
  mkdirSync(configDir(), { recursive: true })
  return withLock(configFile(), () => fn(readConfigFile(), writeRaw))
}

/** The lock another writer holds past its wait (json-store.ts lockFile), or one left by a writer that stopped. */
export const configBusy = (err: unknown): boolean =>
  err instanceof Error && /Timed out waiting for lock:/.test(err.message)

/**
 * The usual edit: the file (the defaults when there is none) changed by `change`, written when it
 * says ok. A file that is there but does not read as JSON is left as it is, and said. The lock
 * still taken after its wait (another writer, or one that stopped mid-write a moment ago: its lock
 * goes after 30 seconds) is a refusal in words, the file as it was.
 */
function editConfig(change: (raw: Raw) => EditResult): EditResult {
  try {
    return withConfigFile((had, save) => {
      // there but not JSON (a comma too many): never replaced by the defaults, the owner's settings with it
      if (!had && existsSync(configFile())) return { ok: false, error: t('err.configUnreadable') }
      const raw = had ?? structuredClone<Raw>(DEFAULT_CONFIG)
      const r = change(raw)
      if (r.ok) save(raw)
      return r
    })
  } catch (err) {
    if (configBusy(err)) return { ok: false, error: t('err.configBusy') }
    throw err
  }
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
  return editConfig(raw => {
    raw.remote = { ...(isRecord(raw.remote) ? raw.remote : {}), on }
    return { ok: true }
  })
}

/**
 * Turn the board in a phone's browser (core/pwa.ts) on or off in config.json, keeping the other
 * fields of `remote.pwa`. On turns the remote mode on too; off leaves it as it is.
 */
export function setPwaOn(on: boolean): EditResult {
  return editConfig(raw => {
    const remote = isRecord(raw.remote) ? raw.remote : raw.remote === true ? { on: true } : {}
    const pwa = isRecord(remote.pwa) ? remote.pwa : {}
    raw.remote = { ...remote, ...(on ? { on: true } : {}), pwa: { ...pwa, on } }
    return { ok: true }
  })
}

/** config.json's `tunnel` object as it is on disk (core/tunnel.ts reads it), or a new one. */
const tunnelOf = (raw: Raw): Raw => (isRecord(raw.tunnel) ? { ...raw.tunnel } : {})

/**
 * Change the tunnel's settings (core/tunnel.ts) in config.json, keeping its other fields (and the
 * file's): each field given is set, a null or '' value removes it (its default then), and one left
 * out or undefined stays as it is. Checking them is the caller's (fieldProblem).
 */
export function editTunnel(fields: Partial<Record<TunnelField, unknown>>): EditResult {
  return editConfig(raw => {
    const tunnel = tunnelOf(raw)
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) continue
      if (value === null || value === '') delete tunnel[field]
      else tunnel[field] = value
    }
    raw.tunnel = tunnel
    return { ok: true }
  })
}

/**
 * The admin connection's fields (`tunnel.admin`, core/server-admin.ts) in config.json, keeping its
 * other fields: each given is set, '' removes it; none left removes `admin`. Checking them is the
 * caller's (adminProblems).
 */
export function editTunnelAdmin(a: Partial<Admin>): EditResult {
  return editConfig(raw => {
    const tunnel = tunnelOf(raw)
    const admin: Raw = isRecord(tunnel.admin) ? { ...tunnel.admin } : {}
    for (const [field, value] of Object.entries(a)) {
      if (value === undefined) continue
      if (value === '') delete admin[field]
      else admin[field] = value
    }
    if (Object.keys(admin).length) tunnel.admin = admin
    else delete tunnel.admin
    raw.tunnel = tunnel
    return { ok: true }
  })
}

/**
 * The board installed on the server itself (`tunnel.install`, path B of the board on a server): its
 * domain, apart from the tunnel's own (`tunnel.domain` stays the tunnel's). Each field given is
 * set, '' removes it; none left removes `install`. Checking them is the caller's.
 */
export function editTunnelInstall(i: { domain?: string }): EditResult {
  return editConfig(raw => {
    const tunnel = tunnelOf(raw)
    const install: Raw = isRecord(tunnel.install) ? { ...tunnel.install } : {}
    for (const [field, value] of Object.entries(i)) {
      if (value === undefined) continue
      if (value === '') delete install[field]
      else install[field] = value
    }
    if (Object.keys(install).length) tunnel.install = install
    else delete tunnel.install
    raw.tunnel = tunnel
    return { ok: true }
  })
}

/**
 * The profile sync's path rules for a server (`tunnel.syncPaths[host]`, core/profile-sync/rules.ts),
 * keeping the other servers' and the file's other fields; none left removes the server's.
 * Checking them is the caller's (cleanRules).
 */
export function editSyncPaths(host: string, rules: { pc: string; server: string }[]): boolean {
  try {
    return editConfig(raw => {
      const tunnel = tunnelOf(raw)
      const all: Raw = isRecord(tunnel.syncPaths) ? { ...tunnel.syncPaths } : {}
      if (rules.length) all[host] = rules.map(r => ({ pc: r.pc, server: r.server }))
      else delete all[host]
      if (Object.keys(all).length) tunnel.syncPaths = all
      else delete tunnel.syncPaths
      raw.tunnel = tunnel
      return { ok: true }
    }).ok
  } catch {
    return false
  }
}

/** The setup on record, as the panel shows it (`tunnel.setup`: its case, address and when), or none (null). */
export function setTunnelSetup(s: { case: SetupCase; address: string; at: string } | null): EditResult {
  return editConfig(raw => {
    const tunnel = tunnelOf(raw)
    if (s) tunnel.setup = { ...(isRecord(tunnel.setup) ? tunnel.setup : {}), ...s }
    else delete tunnel.setup
    raw.tunnel = tunnel
    return { ok: true }
  })
}

/** Turn the tunnel on or off in config.json, keeping its other fields; the running board follows (liveConfig). */
export function setTunnelOn(on: boolean): EditResult {
  return editConfig(raw => {
    raw.tunnel = { ...tunnelOf(raw), on }
    return { ok: true }
  })
}

/**
 * The board on a server of the owner's (core/server-install.ts): `serverMode` in config.json, its
 * domain and its login listener's socket, which turn the server mode on; null takes it out. The
 * server's installer writes it, as the board's user.
 */
export function setServerMode(mode: { domain: string; socket: string } | null): EditResult {
  return editConfig(raw => {
    if (mode) raw.serverMode = { domain: mode.domain, socket: mode.socket }
    else delete raw.serverMode
    return { ok: true }
  })
}

/** Change settings in config.json from the web board: { language, foldWaiting }. */
export function editSettings(body: unknown): EditResult {
  return editConfig(raw => {
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
    return { ok: true }
  })
}

/**
 * Where a MokuPilot call starts (core/mokupilot-mode.ts), from Settings → MokuPilot…: { mode:
 * 'auto' | 'local' | 'link' } into config.json's `mokupilot`, its other fields (`dir`, `command`)
 * kept. The older `link` goes: `mode` says it now. MokuPilot turned off (`"mokupilot": false`) is
 * left as it is, and said. The running board picks the change up as any edit (liveConfig).
 */
export function editMokupilot(body: unknown): EditResult {
  const mode = isRecord(body) ? body.mode : undefined
  if (!isMokupilotMode(mode)) return { ok: false, error: t('mokupilot.err.mode', { mode: String(mode) }) }
  return editConfig(raw => {
    if (raw.mokupilot === false) return { ok: false, error: t('mokupilot.err.off') }
    const { link: _link, ...own } = isRecord(raw.mokupilot) ? raw.mokupilot : {}
    raw.mokupilot = { ...own, mode }
    return { ok: true }
  })
}

/**
 * Presence's settings (#172) in config.json's `presence` section: { on?: boolean; mode?: 'auto' |
 * 'suggest' | 'off'; idleMinutes?: number }. On writes the section (as it reads now, or { mode:
 * 'auto' }), off takes it out: a setup with presence off has no section at all, as one that never
 * turned it on. A value of the wrong kind refuses the whole edit.
 */
export function editPresence(body: unknown): EditResult {
  const b: Raw = isRecord(body) ? body : {}
  if (b.on !== undefined && typeof b.on !== 'boolean') return { ok: false, error: t('err.presenceSetting') }
  if (b.mode !== undefined && !isPresenceMode(b.mode)) return { ok: false, error: t('err.presenceSetting') }
  if (
    b.idleMinutes !== undefined &&
    !(Number.isInteger(b.idleMinutes) && Number(b.idleMinutes) >= 1 && Number(b.idleMinutes) <= MAX_IDLE_MINUTES)
  )
    return { ok: false, error: t('err.presenceMinutes', { max: MAX_IDLE_MINUTES }) }
  return editConfig(raw => {
    const now = presenceConfig(raw.presence)
    if (b.on === false || (b.on === undefined && !now && b.mode === undefined && b.idleMinutes === undefined)) {
      delete raw.presence
    } else {
      const section: Raw = isRecord(raw.presence) ? { ...raw.presence } : {}
      section.mode = b.mode ?? now?.mode ?? 'auto'
      if (b.idleMinutes !== undefined) section.idleMinutes = b.idleMinutes
      raw.presence = section
    }
    return { ok: true }
  })
}

/**
 * Tasks (#202) from Settings → Tasks: { mode: 'none' | 'mine' | 'agents' } into config.json's
 * `todos`: none deletes the section (the points stay on the cards), mine is `{ agents: false }`,
 * agents `true`. The running board picks the change up as any edit (liveConfig).
 */
export function editTodos(body: unknown): EditResult {
  const mode = isRecord(body) ? body.mode : undefined
  if (!isTodoMode(mode)) return { ok: false, error: t('todo.err.mode') }
  return editConfig(raw => {
    if (mode === 'none') delete raw.todos
    else raw.todos = mode === 'agents' ? true : { agents: false }
    return { ok: true }
  })
}

/**
 * The backup's targets (#233) in config.json's `backup`: `folder` (a path, or null to drop the
 * folder target), `server` (host, port and the admin's user and key, merged into what is there;
 * null drops it), `serverSet` (when Apply, or the owner's own setup and a Test, made the server
 * take snapshots; null: not set). Checked as the tunnel's fields are; the folder by the caller.
 */
export function editBackup(b: {
  folder?: string | null
  server?: { host?: unknown; port?: unknown; adminUser?: unknown; adminKey?: unknown } | null
  serverSet?: string | null
}): EditResult {
  return editConfig(raw => {
    const section: Raw = isRecord(raw.backup) ? { ...raw.backup } : {}
    if (b.folder !== undefined) {
      if (b.folder === null || b.folder.trim() === '') delete section.folder
      else section.folder = b.folder.trim()
    }
    const setNow = isRecord(section.server) && typeof section.server.set === 'string'
    // a server that takes snapshots keeps its address: Undo first (or a new host would leave the old
    // one set up, its user and key still there); the admin's login may change (a key moved)
    if (b.server === null) {
      if (setNow) return { ok: false, error: t('backup.err.serverSet') }
      delete section.server
    } else if (b.server !== undefined) {
      const s = b.server
      const now: Raw = isRecord(section.server) ? { ...section.server } : {}
      const was = JSON.stringify([now.host, now.port])
      const admin: Raw = isRecord(now.admin) ? { ...now.admin } : {}
      if (s.host !== undefined) {
        const host = typeof s.host === 'string' ? s.host.trim() : ''
        if (!host) return { ok: false, error: t('tunnel.err.required', { field: t('tunnel.field.host') }) }
        const problem = fieldProblem('host', host)
        if (problem) return { ok: false, error: problem }
        now.host = host
      }
      if (s.port !== undefined) {
        const port = Number(s.port)
        const problem = fieldProblem('sshPort', port)
        if (problem) return { ok: false, error: problem }
        now.port = port
      }
      for (const [field, key] of [
        ['user', s.adminUser],
        ['key', s.adminKey],
      ] as const) {
        if (key === undefined) continue
        const value = typeof key === 'string' ? key.trim() : ''
        const problem = fieldProblem(field, value)
        if (problem) return { ok: false, error: problem }
        admin[field] = value
      }
      now.admin = admin
      if (!now.host) return { ok: false, error: t('tunnel.err.required', { field: t('tunnel.field.host') }) }
      if (setNow && JSON.stringify([now.host, now.port]) !== was) return { ok: false, error: t('backup.err.serverSet') }
      section.server = now
    }
    if (b.serverSet !== undefined && isRecord(section.server)) {
      if (b.serverSet === null) delete section.server.set
      else section.server = { ...section.server, set: b.serverSet }
    }
    if (Object.keys(section).length) raw.backup = section
    else delete raw.backup
    return { ok: true }
  })
}

/**
 * Projects added to a lane's list in a raw config's `time.clients.<lane>.projects` (#233), each
 * one it has not got: neither listed nor retired, case and spaces aside (core/time.ts projectKey).
 * A lane without a list takes any project, and stays so. The names added (none: nothing changed).
 */
export function withTimeProjects(raw: Raw, lane: string, projects: readonly string[]): string[] {
  if (!isRecord(raw.time) || !isRecord(raw.time.clients)) return []
  const client = raw.time.clients[lane]
  if (!isRecord(client) || !Array.isArray(client.projects)) return []
  const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [])
  const have = new Set([...names(client.projects), ...names(client.retired)].map(projectKey))
  const added: string[] = []
  for (const p of projects.map(x => x.trim()).filter(Boolean)) {
    if (have.has(projectKey(p))) continue
    have.add(projectKey(p))
    added.push(p)
  }
  if (added.length) client.projects = [...client.projects, ...added]
  return added
}

/**
 * Projects added to a lane's list in config.json (withTimeProjects), under the file's lock: by
 * `board time add --new-project` and by the import. Nothing is written when every one is there.
 */
export function addTimeProjects(lane: string, projects: readonly string[]): EditResult {
  if (!readConfigFile())
    return existsSync(configFile()) ? { ok: false, error: t('err.configUnreadable') } : { ok: true }
  try {
    return withConfigFile((raw, save) => {
      if (raw && withTimeProjects(raw, lane, projects).length) save(raw)
      return { ok: true }
    })
  } catch (err) {
    if (configBusy(err)) return { ok: false, error: t('err.configBusy') }
    throw err
  }
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

  return editConfig(raw => {
    const section: Raw = isRecord(raw.wake)
      ? { ...raw.wake }
      : raw.wake === undefined
        ? {}
        : { enabled: wakeConfig(raw.wake).enabled }
    if (typeof b.on === 'boolean') section.enabled = b.on
    if (reaper) section.reaper = { ...(isRecord(section.reaper) ? section.reaper : {}), ...reaper }
    if (b.telegram !== undefined) section.telegram = b.telegram
    raw.wake = section
    return { ok: true }
  })
}

/**
 * The takeover's write of the `wake` section (#119, Migration: services/wake/takeover.ts): `fields`
 * over the section's own (a section that is `true` or `false` read as its `enabled`), every other
 * key of config.json kept. A config.json that is there but does not read as an object is left as it
 * is, and said; none there is made from the defaults, as editWake does.
 */
export function takeOverWake(fields: Raw): EditResult {
  try {
    return withConfigFile((raw, save) => {
      if (!raw && existsSync(configFile()))
        return { ok: false, error: `${configFile()} does not read as JSON; nothing was taken over` }
      const next = raw ?? structuredClone<Raw>(DEFAULT_CONFIG)
      const section: Raw = isRecord(next.wake)
        ? { ...next.wake }
        : next.wake === undefined
          ? {}
          : { enabled: wakeConfig(next.wake).enabled }
      next.wake = { ...section, ...fields }
      save(next)
      return { ok: true }
    })
  } catch (err) {
    if (configBusy(err)) return { ok: false, error: t('err.configBusy') }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
export const editCategories = (body: unknown): EditResult => editConfig(raw => categoriesEdited(raw, body))

/** editCategories on a raw config, in place (Settings → Time makes a lane in its own edit of the file). */
export function categoriesEdited(raw: Raw, body: unknown): EditResult {
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
  return editConfig(raw => {
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
    return { ok: true }
  })
}

/** Adds the found folders config.json does not list (shownDir: shown too); true when it wrote. */
export function saveFoundProfiles(inheritedDir: string, home: string = homedir()): boolean {
  // Only into a file that is there: the board's loadConfig makes it, with its defaults, on first use
  // (none: not even its folder, nor the lock in it)
  if (!readConfigFile()) return false
  try {
    return withConfigFile((raw, save) => {
      if (!raw) return false
      const profiles = profilesIn(raw, home, inheritedDir)
      if (!profiles.added.length) return false
      profiles.save()
      save(raw)
      return true
    })
  } catch (err) {
    // another writer holds the file: the folders are saved at the next start
    if (configBusy(err)) return false
    throw err
  }
}

/** A config edit that must go through, for a caller with no answer of its own to give: a refusal thrown, its words the message. */
export function mustEdit(r: EditResult): void {
  if (!r.ok) throw new Error(r.error)
}

/**
 * The running board's `time` and lanes as config.json has them now, at once, after a write of its
 * own (Settings → Time, a new project): the watcher (liveConfig) follows ~120 ms later, and a
 * change asked in between must already see it. A file that does not read leaves them as they are.
 */
export function freshTime(cfg: Config): void {
  const raw = readConfigFile()
  if (!raw) return
  cfg.time = raw.time
  cfg.categories = normalizeConfig(raw).categories
}
