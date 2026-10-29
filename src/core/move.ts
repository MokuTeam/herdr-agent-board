// A session moved to another Claude profile, keeping its conversation (#250, `board move`): the
// profile it may go to, and the trust its project folder needs there. A session belongs to the
// profile its conversation lives in, so a move copies the conversation into the target profile's
// folder and switches the card (and wake's entry) to it; `board resume` and every wake then run it
// there. Claude asks a profile once whether it trusts a folder and keeps the answer in that
// profile's own `.claude.json`; a wake would stop at that dialog, so the source's yes for the
// session's folder goes with it.
//
// Pure: services/move.ts reads the profiles and the files, adapters/move-files.ts copies.
import { posix, win32 } from 'node:path'
import { itemProfile } from './item-profile.ts'
import { normDir, sameDir } from './launch/names.ts'
import { defaultProfileDir, type Profile } from './profiles.ts'
import type { Item } from './types.ts'

export const MOVE_USAGE = 'board move <id|name|pane>... --profile <id> [--when-free]'

/** `board move`'s arguments: the sessions and the profile id; throws with the usage. */
export function parseMove(args: readonly string[]): { targets: string[]; profile: string } {
  const targets: string[] = []
  let profile: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i])
    if (arg === '--profile') {
      const value = args[++i]
      if (value === undefined || value.startsWith('-')) throw new Error(`--profile needs a profile id. ${MOVE_USAGE}`)
      profile = value
    } else if (arg.startsWith('--')) throw new Error(`unexpected "${arg}". ${MOVE_USAGE}`)
    else if (arg.trim()) targets.push(arg)
  }
  if (!targets.length) throw new Error(`which sessions? ${MOVE_USAGE}`)
  if (!profile) throw new Error(`to which profile? ${MOVE_USAGE}`)
  return { targets, profile }
}

/** The profile `id` names, when a session may be moved there: listed and shown; else why not. */
export function moveProfile(list: readonly Profile[], id: string): { profile: Profile } | { error: string } {
  if (list.filter(p => !p.hidden).length < 2) return { error: 'a move needs two profiles shown (Settings → Profiles)' }
  const profile = list.find(p => p.id === id)
  if (!profile) return { error: `no profile "${id}" (the profiles: ${list.map(p => p.id).join(', ') || 'none'})` }
  if (profile.hidden) return { error: `the profile "${id}" is hidden: show it in Settings → Profiles first` }
  return { profile }
}

/**
 * The folder the session's conversation is in now, or why a move cannot start from it: its
 * profile (itemProfile), else the folder it reported that no profile has; refused when neither is
 * known, or when it is the target's.
 */
export function moveSource(
  item: Pick<Item, 'profile' | 'profileFolder'>,
  list: readonly Profile[],
  to: Profile,
): { dir: string } | { error: string } {
  const dir = itemProfile(item, list)?.dir ?? item.profileFolder
  if (!dir) return { error: 'its profile is not known' }
  if (sameDir(dir, to.dir)) return { error: `it is in the profile "${to.id}" already` }
  return { dir }
}

/**
 * Claude's own state file for a profile folder, where it keeps which folders the profile trusts:
 * `~/.claude.json` for the default folder (Claude runs there without CLAUDE_CONFIG_DIR, and the
 * board unsets it for that folder), `<dir>/.claude.json` for any other.
 */
export function claudeStateFile(dir: string, home: string, platform: string = process.platform): string {
  const path = platform === 'win32' ? win32 : posix
  return sameDir(dir, defaultProfileDir(home, platform))
    ? path.join(home, '.claude.json')
    : path.join(dir, '.claude.json')
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Whether `key` is `cwd` or a folder above it. */
const holds = (key: string, cwd: string): boolean => {
  const k = normDir(key)
  const c = normDir(cwd)
  return !!k && (c === k || c.startsWith(k.endsWith('/') ? k : `${k}/`))
}

/** The key under the state's `projects` whose trust covers `cwd` (it or a folder above it, the nearest), or null. */
export function trustedKey(state: unknown, cwd: string): string | null {
  const projects = isRecord(state) && isRecord(state.projects) ? state.projects : {}
  let best: string | null = null
  for (const [key, value] of Object.entries(projects))
    if (isRecord(value) && value.hasTrustDialogAccepted === true && holds(key, cwd))
      if (best === null || normDir(key).length > normDir(best).length) best = key
  return best
}

/**
 * The target's state with the source's trust for `cwd` added, or null when nothing is to change:
 * the target trusts the folder already, or the source does not. Only `hasTrustDialogAccepted` of
 * the session's own folder is set, even when the source trusts it through a folder above it (so a
 * profile kept apart never comes to trust a whole tree, as `C:\Work`), under the key the target
 * has for that folder, else the folder as Claude writes its keys (with `/` on Windows); every
 * other field of the file and of the project kept.
 */
export function withTrust(
  source: unknown,
  target: unknown,
  cwd: string,
  platform: string = process.platform,
): Record<string, unknown> | null {
  if (!cwd || !isRecord(target) || trustedKey(target, cwd) !== null) return null
  if (trustedKey(source, cwd) === null) return null
  const projects = isRecord(target.projects) ? target.projects : {}
  const own = cwd.replace(/(.)[\\/]+$/, '$1')
  const key = Object.keys(projects).find(k => sameDir(k, cwd)) ?? (platform === 'win32' ? own.replace(/\\/g, '/') : own)
  const project = isRecord(projects[key]) ? projects[key] : {}
  return { ...target, projects: { ...projects, [key]: { ...project, hasTrustDialogAccepted: true } } }
}
