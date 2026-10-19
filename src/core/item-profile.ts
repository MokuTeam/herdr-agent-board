// The profile a session runs in, as its item says, the one a session started from its card keeps,
// and the profiles the owner has not hidden: the server's launches and checks (core/profiles.ts)
// and the web page's new-session window hold a card to its profile by these rules, so the page
// leaves the profile out of a start only where the server takes the same one. It lives apart, with no import but types, so the web page can bundle
// it (profiles.ts reads folders with node:path).
import type { Item } from './types.ts'

/** The profiles the owner has not hidden, in the list's order. */
export function shownProfiles<P extends { hidden: boolean }>(list: readonly P[]): P[] {
  return list.filter(p => !p.hidden)
}

/**
 * The profile a session runs in, as its item says: the one it names when the list has it, hidden
 * or not; with none named and no folder no profile has (`profileFolder`), the only one shown when
 * one is (a card from before profiles, or none yet, on a board with one shown: as before
 * profiles); else undefined (not known: a folder no profile has, an id the list no longer has, or
 * none named with two or more shown).
 */
export function itemProfile<P extends { id: string; hidden: boolean }>(
  item: Pick<Item, 'profile' | 'profileFolder'>,
  list: readonly P[],
): P | undefined {
  if (item.profile) return list.find(p => p.id === item.profile)
  const shown = shownProfiles(list)
  return shown.length === 1 && !item.profileFolder ? shown[0] : undefined
}

/**
 * The profile a session started from a card ("New here") keeps: the card's own (itemProfile), but
 * none when the card's session runs in another profile than its start asked for (`profileWanted`):
 * which one was meant is not known, so the owner chooses, as for a card whose profile is not known.
 */
export function parentProfile<P extends { id: string; hidden: boolean }>(
  item: Pick<Item, 'profile' | 'profileFolder' | 'profileWanted'>,
  list: readonly P[],
): P | undefined {
  return item.profileWanted ? undefined : itemProfile(item, list)
}
