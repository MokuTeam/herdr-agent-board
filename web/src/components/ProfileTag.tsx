// A card's profile tag, right after its name: the profile's name in its color, "unknown profile"
// for a folder no profile has, or a red warning for a session running in another profile than its
// start asked for. None with one profile shown, as before profiles (src/core/profile-tag.ts). On a
// card it carries its mark too, which it shows instead when the name needs the room (#324).
import { profileTag } from '../../../src/core/profile-tag.ts'
import type { Item } from '../../../src/core/types.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { profileMark } from '../models/card-head.ts'
import { pickedProfile, tagView } from '../models/profiles.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'

/**
 * `item`: a card's session, or an archive row's record (its profile facts at archive time).
 * `picked`: the pick to tag by, the profile switch's when not given; the archive, which the switch
 * does not filter, passes 'all'. `mark`: a card's, whose head may show the tag as its mark.
 */
export function ProfileTag({
  item,
  picked,
  mark,
}: {
  item: Pick<Item, 'profile' | 'profileFolder' | 'profileWanted'>
  picked?: string
  mark?: boolean
}) {
  const t = useT()
  const { data, ui } = useBoardContext()
  const profiles = data?.profiles
  const tag = profileTag(item, profiles ?? [], picked ?? pickedProfile(ui.profile, profiles))
  if (!tag) return null
  const view = tagView(tag, t)
  return (
    <span
      className={`profile-tag ${view.kind}`}
      style={{ '--c': view.color }}
      title={view.title}
      data-mark={mark ? profileMark(tag, profiles ?? []) : undefined}
    >
      {view.text}
    </span>
  )
}
