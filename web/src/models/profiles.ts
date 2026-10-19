// The Claude profiles on the web board: the profile switch's options and the profile it shows,
// which sessions that pick shows, and the words and color of a card's profile tag
// (src/core/profile-tag.ts says which tag a card has). With fewer than two profiles shown there is
// no switch, and every session shows, as before profiles. Then the Profiles panel's rows and the
// folders it offers to add; with one profile folder there is no such panel.
import { shownProfiles } from '../../../src/core/item-profile.ts'
import { sameDir } from '../../../src/core/launch/names.ts'
import type { ProfileTag } from '../../../src/core/profile-tag.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import type { BoardProfile } from '../api/client.ts'

/** One segment of the switch: "All profiles" (`all`), or a shown profile; `n`: its sessions on show. */
export type ProfileOption = { id: string; title: string; color: string; n: number }

const shownOf = (profiles: readonly BoardProfile[] | undefined): BoardProfile[] => shownProfiles(profiles ?? [])

/**
 * The switch: "All profiles" with every session on show (`visible`, whatever the switch picks),
 * then each shown profile with the sessions its pick shows, in the list's order. Null with fewer
 * than two shown.
 */
export function profileOptions(
  profiles: BoardProfile[] | undefined,
  visible: Item[],
  t: Translator,
): ProfileOption[] | null {
  const shown = shownOf(profiles)
  if (shown.length < 2) return null
  return [
    { id: 'all', title: t('profile.all'), color: '', n: visible.length },
    ...shown.map(p => ({
      id: p.id,
      title: p.title,
      color: p.color,
      n: visible.filter(i => profileShown(p.id, i)).length,
    })),
  ]
}

/**
 * The profile the switch shows: the one picked (`picked`, as this browser keeps it) while it is a
 * shown one and the switch is there, else 'all': a profile hidden or gone since, or a board with
 * fewer than two shown, shows every session.
 */
export function pickedProfile(picked: string, profiles: BoardProfile[] | undefined): string {
  const shown = shownOf(profiles)
  return shown.length >= 2 && shown.some(p => p.id === picked) ? picked : 'all'
}

/**
 * Whether the switch (`picked`: 'all' or a profile id) shows a session, or a session on its way
 * (its launch's profile). One in another profile than its start asked for (`profileWanted`), or in a
 * folder no profile has (`profileFolder`), shows whatever the pick: the owner must see it.
 */
export const profileShown = (
  picked: string,
  item: Pick<Item, 'profile' | 'profileWanted' | 'profileFolder'>,
): boolean => picked === 'all' || item.profile === picked || !!item.profileWanted || !!item.profileFolder

/**
 * The pick that shows a session just started in `profile` (the launch's): the one picked when it
 * does already, else that profile when it is a shown one, else 'all'. Null: no change.
 */
export function pickShowing(
  picked: string,
  profiles: BoardProfile[] | undefined,
  profile: string | undefined,
): string | null {
  const now = pickedProfile(picked, profiles)
  if (now === 'all' || now === profile) return null
  return profile && shownOf(profiles).some(p => p.id === profile) ? profile : 'all'
}

/** A tag's class (`kind`), text, tooltip and color. */
export interface TagView {
  kind: string
  text: string
  title: string
  color: string
}

/**
 * A card's profile tag as it shows: the profile's title in its color, its folder the tooltip; a
 * folder no profile has as "unknown profile" in gray, the folder the tooltip; a session in
 * another profile than its start asked for in red, naming that one.
 */
export function tagView(tag: ProfileTag<BoardProfile>, t: Translator): TagView {
  switch (tag.kind) {
    case 'profile':
      return { kind: 'profile', text: tag.profile.title, title: tag.profile.dir, color: tag.profile.color }
    case 'unknown':
      return { kind: 'unknown', text: t('profile.unknown'), title: tag.folder, color: 'var(--gray)' }
    case 'wrong': {
      const text = t('profile.wrong', { want: tag.want?.title || tag.wantId })
      return { kind: 'wrong', text, title: text, color: 'var(--red)' }
    }
  }
}

/**
 * Whether the board offers the Profiles panel (Settings → Profiles…): more than one profile folder
 * found, shown or hidden. With one, the menu is as before profiles.
 */
export const offersProfiles = (profiles: readonly BoardProfile[] | undefined): boolean => (profiles?.length ?? 0) > 1

/** A profile's row in the Profiles panel. */
export interface ProfileRowView {
  id: string
  title: string
  /** Its color as hex. */
  color: string
  dir: string
  /** Its sessions on the board now, in words. */
  sessions: string
  shown: boolean
  /** Its folder is not there. */
  missing: boolean
  /** Shown, its folder there, and the board's hooks not in its settings.json: the panel offers Install. */
  noHooks: boolean
}

/**
 * The panel's rows, every profile in the list's order. A folder that is gone gets no Install: it
 * could only fail, and its row says the folder is not found.
 */
export function profileRows(profiles: readonly BoardProfile[], t: Translator): ProfileRowView[] {
  return profiles.map(p => {
    const shown = !p.hidden
    const missing = !p.exists
    return {
      id: p.id,
      title: p.title,
      color: p.color,
      dir: p.dir,
      sessions: t('prof.sessions', { n: p.sessions }),
      shown,
      missing,
      noHooks: shown && !missing && p.hooks === false,
    }
  })
}

/** The folders sessions reported that no profile has, each once (as `sameDir` has it), as the first one wrote it. */
export function unknownFolders(items: readonly Item[]): string[] {
  const folders: string[] = []
  for (const { profileFolder } of items)
    if (profileFolder && !folders.some(f => sameDir(f, profileFolder))) folders.push(profileFolder)
  return folders
}

/** A profile's name as typed, when it is a new one: trimmed; null when it is empty or the same. */
export function profileRenamed(title: string, value: string): string | null {
  const next = value.trim()
  return next && next !== title ? next : null
}
