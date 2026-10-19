// The Claude profile a new session starts in: what the new-session window preselects and whether
// it offers the choice, the profile last used in each folder (this browser keeps it), the row of
// shown profiles and the tag beside Start, and what the start sends. A session started from a card
// keeps the card's profile, by the server's own rule (src/core/item-profile.ts); a card whose
// profile the board does not know offers the choice with nothing picked, as the server refuses to
// guess it (src/core/profiles.ts launchTarget). With one profile shown and nothing unknown, the
// window and what it sends are as before profiles.
import { itemProfile, shownProfiles } from '../../../src/core/item-profile.ts'
import { normDir } from '../../../src/core/launch/names.ts'
import type { BoardCategory, BoardProfile } from '../../../src/core/payload.ts'
import type { LaunchContext } from './launch-form.ts'

/** The key the profile last used in each folder is kept under: { [normDir(cwd)]: profileId }. */
export const LAUNCH_PROFILES = 'board.launch.profiles'
/** How many folders it keeps (the newest). */
const KEPT = 50

/**
 * The window's profile: the one picked (null for none), whether it is the card's own (`locked`:
 * no other may be picked), and whether the window offers the choice.
 */
export interface ProfilePick {
  picked: string | null
  locked: boolean
  offered: boolean
}

/**
 * What the window starts with, first match wins: (1) from a card, its profile, locked (a failed
 * launch started again: the profile it asked for); a card whose profile is not known, or a launch
 * whose profile is gone, picks nothing and offers the choice while any profile is shown; (2) the
 * lane's usual profile, (3) the profile last used in the folder, each only when shown; (4)
 * nothing. Offered otherwise with two or more shown.
 */
export function profileStart(
  ctx: LaunchContext,
  s: {
    profiles: BoardProfile[]
    categories: BoardCategory[]
    category: string
    cwd: string
    remembered: Record<string, string>
  },
): ProfilePick {
  const shown = shownProfiles(s.profiles)
  const ask: ProfilePick = { picked: null, locked: false, offered: shown.length > 0 }
  if (ctx.item) {
    const own = itemProfile(ctx.item, s.profiles)
    return own ? { picked: own.id, locked: true, offered: false } : ask
  }
  const again = ctx.retry?.profile
  if (again) {
    const known = s.profiles.find(p => p.id === again)
    return known ? { picked: known.id, locked: true, offered: false } : ask
  }
  const isShown = (id: unknown): id is string => typeof id === 'string' && shown.some(p => p.id === id)
  const usual = s.categories.find(c => c.id === s.category)?.profile
  const dir = normDir(s.cwd)
  const last = dir ? s.remembered[dir] : undefined
  const picked = isShown(usual) ? usual : isShown(last) ? last : null
  return { picked, locked: false, offered: shown.length >= 2 }
}

/** The profiles kept per folder, as localStorage holds them; anything else is none. */
export function rememberedProfiles(text: string | null): Record<string, string> {
  let raw: unknown
  try {
    raw = JSON.parse(text ?? '')
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return Object.fromEntries(
    Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
  )
}

/** The book with `id` as the profile last used in `cwd`: the newest last, the newest 50 kept. */
export function rememberProfile(book: Record<string, string>, cwd: string, id: string): Record<string, string> {
  const dir = normDir(cwd)
  if (!dir) return book
  const rest = Object.entries(book).filter(([k]) => k !== dir)
  return Object.fromEntries([...rest, [dir, id]].slice(-KEPT))
}

/**
 * The window's profile as drawn: the row (one chip per shown profile) only when the choice is
 * offered, and the profile beside Start (`chosen`) when the choice is offered or the card's own is
 * not the only one shown.
 */
export interface ProfileRow {
  offered: boolean
  options: { id: string; title: string; color: string; pressed: boolean }[]
  chosen: { title: string; color: string } | null
}

/** Whether the start names its profile: offered, or the card's own when it is not the only one shown. */
function named(pick: ProfilePick, profiles: readonly BoardProfile[]): boolean {
  if (!pick.picked) return false
  if (pick.offered) return true
  const shown = shownProfiles(profiles)
  return pick.locked && !(shown.length === 1 && shown[0]?.id === pick.picked)
}

export function profileRow(pick: ProfilePick, profiles: BoardProfile[]): ProfileRow {
  const picked = pick.picked ? profiles.find(p => p.id === pick.picked) : undefined
  return {
    offered: pick.offered,
    options: pick.offered
      ? shownProfiles(profiles).map(p => ({ id: p.id, title: p.title, color: p.color, pressed: p.id === pick.picked }))
      : [],
    chosen: picked && named(pick, profiles) ? { title: picked.title, color: picked.color } : null,
  }
}

/**
 * What a start sends of its profile: the one picked when the choice is offered, or the card's own
 * when it is not the only one shown; with it, the key of the card it was started from (`parent`),
 * so the server checks it against that session's profile. Nothing else is new.
 */
export function profileBody(
  pick: ProfilePick,
  profiles: BoardProfile[],
  parent: string | null,
): { profile?: string; parent?: string } {
  if (!pick.picked || !named(pick, profiles)) return {}
  return { profile: pick.picked, ...(parent ? { parent } : {}) }
}
