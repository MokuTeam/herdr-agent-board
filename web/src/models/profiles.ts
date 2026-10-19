// The Claude profiles on the web board: the profile switch's options and the profile it shows,
// which sessions that pick shows, and the words and color of a card's profile tag
// (src/core/profile-tag.ts says which tag a card has). With fewer than two profiles shown there is
// no switch, and every session shows, as before profiles.
import type { ProfileTag } from '../../../src/core/profile-tag.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import type { BoardProfile } from '../api/client.ts'

/** One segment of the switch: "All profiles" (`all`), or a shown profile; `n`: its sessions on show. */
export type ProfileOption = { id: string; title: string; color: string; n: number }

const shownOf = (profiles: readonly BoardProfile[] | undefined): BoardProfile[] =>
  (profiles ?? []).filter(p => !p.hidden)

/**
 * The switch: "All profiles" with every session on show (`visible`, whatever the switch picks),
 * then each shown profile with its own, in the list's order. Null with fewer than two shown.
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
      n: visible.filter(i => i.profile === p.id).length,
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

/** Whether the switch (`picked`: 'all' or a profile id) shows a session. */
export const profileShown = (picked: string, item: Pick<Item, 'profile'>): boolean =>
  picked === 'all' || item.profile === picked

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
