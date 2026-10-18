// Claude profiles: the config folders (CLAUDE_CONFIG_DIR) the board's sessions run in. A profile
// is known by its folder; its id comes from the folder's name (`.claude` → default, `.claude-work`
// → work) and never changes, its title and color are the owner's. Here: how a folder as typed or
// inherited reads, the listed profiles merged with the folders found on this computer, the folder
// a start sets, and the profile a session's card reports.
//
// Pure: the adapters find the folders and read the env and the config, and hand them in.
import { posix, win32 } from 'node:path'
import { validColor } from './categories.ts'
import { baseName, sameDir, uniqueSlug } from './launch/names.ts'
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
const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/**
 * The profiles config.json lists (`listed`, as read), each with every field it has, followed by
 * every folder in `found` that none of them has. The default folder and the board's own
 * (`shownDir`) count as found even when they are not there. A found folder is added shown only
 * when it is one of those two; `added` holds the ones added.
 */
export function mergeProfiles(
  listed: unknown,
  found: readonly string[],
  home: string,
  shownDir?: string | null,
): { list: Profile[]; added: Profile[] } {
  const entries = (Array.isArray(listed) ? listed : []).filter(
    (e): e is Record<string, unknown> => isEntry(e) && filled(e.id) && filled(e.dir),
  )
  const used = new Set<unknown>(entries.map(e => e.color).filter(validColor))
  let spare = 0
  const nextColor = (): string => {
    const color = PROFILE_COLORS.find(c => !used.has(c)) ?? PROFILE_COLORS[spare++ % PROFILE_COLORS.length] ?? 'indigo'
    used.add(color)
    return color
  }

  const list = entries.map((e): Profile => {
    const id = String(e.id)
    const profile: Profile = {
      ...e,
      id,
      title: filled(e.title) ? e.title : profileTitleOf(id),
      dir: String(e.dir),
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
  const defaultDir = defaultProfileDir(home)
  const dirs = [found.find(f => sameDir(f, defaultDir)) ?? defaultDir, ...found.filter(f => !sameDir(f, defaultDir))]
  if (shownDir && !dirs.some(d => sameDir(d, shownDir))) dirs.push(shownDir)

  const added: Profile[] = []
  for (const dir of dirs) {
    if (profileForDir(list, dir)) continue
    const id = profileIdOf(dir, home, new Set(list.map(p => p.id)))
    const shown = sameDir(dir, defaultDir) || sameDir(dir, shownDir)
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
