// Claude profiles: the config folders (CLAUDE_CONFIG_DIR) the board's sessions run in. A profile
// is known by its folder; its id comes from the folder's name (`.claude` → default, `.claude-work`
// → work) and never changes, its title and color are the owner's. Here: how a folder as typed or
// inherited reads, the listed profiles merged with the folders found on this computer, the folder
// a start sets, the profile a launch from the board starts in, what a session's card is told about
// its profile, and the profile it reports.
//
// Pure: the adapters find the folders and read the env and the config, and hand them in.
import { posix, win32 } from 'node:path'
import { validColor } from './categories.ts'
import { baseName, sameDir, uniqueSlug } from './launch/names.ts'
import type { SpawnOptions } from './launch/spawn-args.ts'
import type { Card, Item } from './types.ts'

/** A profile as config.json lists it. Unknown fields survive. */
export interface Profile {
  id: string
  title: string
  dir: string
  color: string
  hidden: boolean
  /** Extra Claude arguments for this profile's launches. */
  args?: string[]
  [extra: string]: unknown
}

/** The profiles, with the folder the board's own env points to and the profile that has it (or null). */
export interface ProfileSet {
  list: Profile[]
  inheritedDir: string
  inherited: Profile | null
}

export const DEFAULT_PROFILE = 'default'

/**
 * Colors new profiles get, in this order: from the categories' palette, never a column's (green,
 * orange, purple, blue, gray) nor red, which marks a session in the wrong profile.
 */
export const PROFILE_COLORS: readonly string[] = ['indigo', 'teal', 'pink', 'brown', 'mint', 'cyan', 'yellow']

const pathFor = (platform: string) => (platform === 'win32' ? win32 : posix)
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** The folder Claude uses when CLAUDE_CONFIG_DIR is not set: <home>/.claude. */
export function defaultProfileDir(home: string, platform: string = process.platform): string {
  return pathFor(platform).join(home, '.claude')
}

/** `dir` without trailing separators, a root (`C:\`, `/`) excepted. */
function trimEnd(dir: string): string {
  const head = dir.replace(/[\\/]+$/, '')
  if (head === dir) return dir
  return !head || /^[A-Za-z]:$/.test(head) ? head + dir.charAt(head.length) : head
}

/**
 * A Claude config folder as CLAUDE_CONFIG_DIR or the owner gives it: unset or blank is the default
 * folder, `~` the home folder, and on Windows Git Bash's `/c/…` is `c:/…`. Otherwise as given.
 */
export function resolveProfileDir(
  value: string | null | undefined,
  home: string,
  platform: string = process.platform,
): string {
  const s = String(value ?? '')
    .trim()
    .replace(/^(["'])(.*)\1$/s, '$2')
    .trim()
  if (!s) return defaultProfileDir(home, platform)
  const tilde = /^~(?:[\\/](.*))?$/s.exec(s)
  if (tilde) return trimEnd(pathFor(platform).join(home, tilde[1] ?? ''))
  if (platform === 'win32') return trimEnd(s.replace(/^\/([A-Za-z])(?:\/|$)/, '$1:/'))
  return trimEnd(s)
}

/**
 * The folder a profile written down (`value`) is in, read as resolveProfileDir reads it; null when
 * nothing is written or it is not absolute. A folder named relative to wherever a process runs is
 * another folder for each start, so it is never a profile's.
 */
export function absoluteProfileDir(value: unknown, home: string, platform: string = process.platform): string | null {
  if (!filled(value)) return null
  const dir = resolveProfileDir(value, home, platform)
  return pathFor(platform).isAbsolute(dir) ? dir : null
}

/**
 * The id of a profile in `dir`: `default` for the default folder, `<name>` for `.claude-<name>`,
 * else the folder's name; lower-case letters, digits, `_` and `-`, at most 32, unique in `taken`.
 */
export function profileIdOf(dir: string, home: string, taken: ReadonlySet<string> = new Set()): string {
  let id = DEFAULT_PROFILE
  if (!sameDir(dir, defaultProfileDir(home))) {
    const name = baseName(dir)
    const own = /^\.claude-(.*)$/is.exec(name)
    id =
      (own ? (own[1] ?? '') : name.replace(/^\.+/, ''))
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32)
        .replace(/-+$/, '') || 'profile'
  }
  return uniqueSlug(id, taken)
}

/** A title for a profile that has none: its id with the first letter upper-cased ("Default", "Work"). */
export function profileTitleOf(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/** The profile whose folder `dir` is (same-folder rules), or null. */
export function profileForDir(list: readonly Profile[], dir: string | null | undefined): Profile | null {
  return list.find(p => sameDir(p.dir, dir)) ?? null
}

const isEntry = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The profiles config.json lists (`listed`, as read), each with every field it has, followed by
 * every folder in `found` that none of them has. A listed one's `dir` is its folder resolved
 * (absoluteProfileDir: `~`, Git Bash's `/c/…`, no trailing separator); an entry whose folder is not
 * absolute is no profile. The default folder and the board's own (`shownDir`, when absolute) count
 * as found even when they are not there. A found folder is added shown only when it is one of
 * those two; `added` holds the ones added.
 */
export function mergeProfiles(
  listed: unknown,
  found: readonly string[],
  home: string,
  shownDir?: string | null,
  platform: string = process.platform,
): { list: Profile[]; added: Profile[] } {
  const entries = (Array.isArray(listed) ? listed : [])
    .filter((e): e is Record<string, unknown> => isEntry(e) && filled(e.id))
    .flatMap(e => {
      const dir = absoluteProfileDir(e.dir, home, platform)
      return dir ? [{ e, dir }] : []
    })
  const used = new Set<unknown>(entries.map(({ e }) => e.color).filter(validColor))
  let spare = 0
  const nextColor = (): string => {
    const color = PROFILE_COLORS.find(c => !used.has(c)) ?? PROFILE_COLORS[spare++ % PROFILE_COLORS.length] ?? 'indigo'
    used.add(color)
    return color
  }

  const list = entries.map(({ e, dir }): Profile => {
    const id = String(e.id)
    const profile: Profile = {
      ...e,
      id,
      title: filled(e.title) ? e.title : profileTitleOf(id),
      dir,
      color: validColor(e.color) ? String(e.color) : nextColor(),
      hidden: e.hidden === true,
    }
    if ('args' in e) {
      if (Array.isArray(e.args)) profile.args = e.args.filter((a): a is string => typeof a === 'string')
      else delete profile.args
    }
    return profile
  })

  // The default folder first, as found spelled it; the board's own last when found has not got it.
  const defaultDir = defaultProfileDir(home, platform)
  const ownDir = absoluteProfileDir(shownDir, home, platform)
  const dirs = [found.find(f => sameDir(f, defaultDir)) ?? defaultDir, ...found.filter(f => !sameDir(f, defaultDir))]
  if (ownDir && !dirs.some(d => sameDir(d, ownDir))) dirs.push(ownDir)

  const added: Profile[] = []
  for (const dir of dirs) {
    if (profileForDir(list, dir)) continue
    const id = profileIdOf(dir, home, new Set(list.map(p => p.id)))
    const shown = sameDir(dir, defaultDir) || sameDir(dir, ownDir)
    const profile: Profile = { id, title: profileTitleOf(id), dir, color: nextColor(), hidden: !shown }
    list.push(profile)
    added.push(profile)
  }
  return { list, added }
}

/** The profiles with the folder the board's own env points to (`inheritedDir`). */
export function profileSet(list: Profile[], inheritedDir: string): ProfileSet {
  return { list, inheritedDir, inherited: profileForDir(list, inheritedDir) }
}

/** The profiles the owner has not hidden. */
export function shownProfiles(list: readonly Profile[]): Profile[] {
  return list.filter(p => !p.hidden)
}

/**
 * CLAUDE_CONFIG_DIR for a start in `target`: null when it is the inherited folder (the start leaves
 * the env exactly as inherited), else its folder.
 */
export function configDirFor(target: Pick<Profile, 'dir'>, inheritedDir: string): string | null {
  return sameDir(target.dir, inheritedDir) ? null : target.dir
}

/**
 * Where a launch from the board starts: the profile, and CLAUDE_CONFIG_DIR for it (null: the env
 * as the board inherited it). Refused (`id`: the profile asked for, or the parent's for `parent`):
 * none chosen while more than one is shown (`choose`), one hidden or not listed (`missing`),
 * another than the parent's (`parent`), or none chosen for a parent whose profile is not known.
 */
export type LaunchTarget =
  | { ok: true; profile: Profile; configDir: string | null }
  | { ok: false; error: 'choose' | 'hidden' | 'missing' | 'parent' | 'unknownParent'; id: string }

/**
 * The profile a launch from the board starts in. Started from a session (`parent`, "New here"):
 * that session's profile (the only one listed when the card does not say, but never for a folder
 * no profile has, `profileFolder`), hidden or not, and no other. A parent whose profile is not
 * known, or none: the profile `asked` names, listed and shown; none asked is the only shown one,
 * else the owner chooses. Never a guess.
 */
export function launchTarget(
  asked: string | undefined,
  parent: Pick<Item, 'name' | 'profile' | 'profileFolder'> | null,
  set: ProfileSet,
): LaunchTarget {
  const target = (profile: Profile): LaunchTarget => ({
    ok: true,
    profile,
    configDir: configDirFor(profile, set.inheritedDir),
  })
  if (parent) {
    const only = set.list.length === 1 && !parent.profileFolder ? set.list[0] : undefined
    const own = parent.profile ? set.list.find(p => p.id === parent.profile) : only
    if (own) return asked === undefined || asked === own.id ? target(own) : { ok: false, error: 'parent', id: own.id }
    if (asked === undefined) return { ok: false, error: 'unknownParent', id: '' }
  }
  if (asked === undefined) {
    const shown = shownProfiles(set.list)
    return shown.length === 1 && shown[0] ? target(shown[0]) : { ok: false, error: 'choose', id: '' }
  }
  const profile = set.list.find(p => p.id === asked)
  if (!profile) return { ok: false, error: 'missing', id: asked }
  if (profile.hidden) return { ok: false, error: 'hidden', id: asked }
  return target(profile)
}

/**
 * Where spawn-agent starts: `configDir`, CLAUDE_CONFIG_DIR for the new tab (null: the env as herdr
 * makes it), and the profile the session is meant to run in (null only when the env is kept and
 * no listed one has its folder). Refused (`detail`: the id asked for, or the folder): a profile
 * not listed (`missing`) or hidden, the agent's own folder no listed profile has (`unknown`), or a
 * folder to set that no listed profile has (`unlisted`).
 */
export type SpawnEnv =
  | { ok: true; configDir: string | null; profile: Profile | null }
  | { ok: false; error: 'missing' | 'hidden' | 'unknown' | 'unlisted'; detail: string }

/**
 * The profile a spawn-agent start is in. The board's own starts say it: `keepEnv` leaves the env
 * (the profile is the one of the folder spawn-agent's own env points to, `own`), `configDir` sets
 * the folder as given (the board checked it), the folder of a listed profile, hidden or not: the
 * pane and the card are recorded in it, and a folder no listed profile has is refused, as nothing
 * could say which profile its session is in. `profile` names a listed, shown profile. Without
 * any, an agent starts its helper in its own folder, hidden profile or not: a folder no listed
 * profile has, or one named relative to wherever the agent runs, is refused, never folded into
 * another. herdr's env is taken to be the default profile's, as on every computer before
 * profiles, so a start in the default folder leaves it alone, whether it is the agent's own or
 * named with `profile`: setting it would move Claude's `.claude.json` state where it is unset.
 */
export function spawnEnv(
  o: Pick<SpawnOptions, 'profile' | 'configDir' | 'keepEnv'>,
  own: string | undefined,
  list: readonly Profile[],
  home: string,
  platform: string = process.platform,
): SpawnEnv {
  const defaultDir = defaultProfileDir(home, platform)
  const ownDir = filled(own) ? absoluteProfileDir(own, home, platform) : defaultDir
  const startIn = (dir: string, profile: Profile): SpawnEnv => ({
    ok: true,
    configDir: sameDir(dir, defaultDir) ? null : profile.dir,
    profile,
  })
  if (o.keepEnv) return { ok: true, configDir: null, profile: profileForDir(list, ownDir) }
  if (o.configDir !== undefined) {
    const listed = profileForDir(list, o.configDir)
    return listed
      ? { ok: true, configDir: o.configDir, profile: listed }
      : { ok: false, error: 'unlisted', detail: o.configDir }
  }
  if (o.profile !== undefined) {
    const asked = list.find(p => p.id === o.profile)
    if (!asked) return { ok: false, error: 'missing', detail: o.profile }
    if (asked.hidden) return { ok: false, error: 'hidden', detail: o.profile }
    return startIn(asked.dir, asked)
  }
  const mine = profileForDir(list, ownDir)
  if (!ownDir || !mine) return { ok: false, error: 'unknown', detail: ownDir ?? resolveProfileDir(own, home, platform) }
  return startIn(ownDir, mine)
}

/** herdr said it does not take --env (older than 0.9.5). */
export function envRejected(message: unknown): boolean {
  const text = message instanceof Error ? message.message : String(message ?? '')
  return /unexpected argument '--env'|unrecognized (option|argument) '?--env|unknown (option|flag|argument).*--env/i.test(
    text,
  )
}

/**
 * What a session's card is told about its profile when the session runs in `dir`: the folder, and
 * the id of the profile that has it ('' removes it: no profile has the folder, and it is never
 * folded into another). Only what the card does not say already; {} when nothing changed. The
 * hooks and the status line both write it, so they never undo each other.
 */
export function profileReport(
  card: Pick<Card, 'profile' | 'profileDir'> | null | undefined,
  dir: string,
  list: readonly Profile[],
): Partial<Pick<Card, 'profile' | 'profileDir'>> {
  const id = profileForDir(list, dir)?.id ?? ''
  return {
    ...(!sameDir(card?.profileDir, dir) && { profileDir: dir }),
    ...((card?.profile ?? '') !== id && { profile: id }),
  }
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * A session's profile from its card. The folder the hooks reported decides; a folder no profile has
 * is "unknown" (`profileFolder`), never folded into another. Without a folder: the profile the
 * card names when the list has it, else the only profile there is, else null. `profileWanted`: the
 * profile a start asked for, when the folder reported is not that profile's.
 */
export function sessionProfile(
  card: Pick<Card, 'profile' | 'profileDir' | 'profileWant'> | null | undefined,
  list: readonly Profile[],
): Pick<Item, 'profile' | 'profileFolder' | 'profileWanted'> {
  const dir = text(card?.profileDir)
  if (dir) {
    const known = profileForDir(list, dir)
    const want = text(card?.profileWant)
    return {
      ...(known ? { profile: known.id } : { profile: null, profileFolder: dir }),
      ...(want && want !== known?.id ? { profileWanted: want } : {}),
    }
  }
  const named = text(card?.profile)
  if (named) return { profile: list.some(p => p.id === named) ? named : null }
  return { profile: list.length === 1 ? (list[0]?.id ?? null) : null }
}
