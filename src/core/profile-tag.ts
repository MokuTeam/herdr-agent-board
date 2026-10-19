// The profile tag on a session's card, the web board's and the terminal board's: whether the card
// names its profile, and which. core/profiles.ts re-exports it; it lives apart, with no import but
// types, so the web page can bundle it (profiles.ts reads folders with node:path).
import type { Item } from './types.ts'

/**
 * What a card's tag says: the profile the session runs in, a folder no profile has (`unknown`),
 * or that it runs in another profile than its start asked for (`wrong`; `want`: that one, null
 * when the list no longer has it).
 */
export type ProfileTag<P> =
  | { kind: 'profile'; profile: P }
  | { kind: 'unknown'; folder: string }
  | { kind: 'wrong'; wantId: string; want: P | null }

/**
 * The tag on a session's card, null for none. A session running in another profile than its start
 * asked for always says so, and one in a folder no profile has names the folder. A session in a
 * known profile names it when the profile is hidden, or when two or more are shown and the switch
 * shows them all (`picked`: 'all', or the id of the one it shows); with one shown, only a hidden
 * one is named, as before profiles. None for a session that reported no profile (no card yet) or
 * one the list lacks.
 */
export function profileTag<P extends { id: string; hidden: boolean }>(
  item: Pick<Item, 'profile' | 'profileFolder' | 'profileWanted'>,
  list: readonly P[],
  picked = 'all',
): ProfileTag<P> | null {
  const { profileWanted, profileFolder } = item
  if (profileWanted)
    return { kind: 'wrong', wantId: profileWanted, want: list.find(p => p.id === profileWanted) ?? null }
  if (profileFolder) return { kind: 'unknown', folder: profileFolder }
  const profile = item.profile ? list.find(p => p.id === item.profile) : undefined
  if (!profile) return null
  const shown = list.filter(p => !p.hidden).length
  return profile.hidden || (shown >= 2 && picked === 'all') ? { kind: 'profile', profile } : null
}
