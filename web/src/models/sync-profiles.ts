// "Profiles" in the sync's preview (components/access/SyncPlaces.tsx): each of the source's
// profiles, its folder on the source and on the target, whether the target has it or it will be
// made there, and its projects by their path, each where it lands and how (as "Where the projects
// go" places them: core/profile-sync/rules.ts placeGroups). What it shows only; the sync is the
// preview's. Pure.
import { type Preview, profileDir } from '../../../src/core/profile-sync/plan.ts'
import { type Placed, type PlaceKind, placeGroups } from '../../../src/core/profile-sync/rules.ts'

/** A project of a profile, with how it lands on the target. */
export interface ProfileProject extends Placed {
  kind: PlaceKind
}

export interface ProfileFold {
  name: string
  /** Its folder on the source and on the target (the PC's then the server's going up, the other way down). */
  from: string
  to: string
  /** Not on the target: made there. */
  create: boolean
  projects: ProfileProject[]
}

/** The most profiles whose folds open by themselves. */
export const PROFILES_OPEN = 2

const pathOf = (x: Placed): string => x.from ?? x.folder

/** The source's profiles in their order, each with its projects by their path. */
export function profileFolds(
  p: Pick<Preview, 'from' | 'profiles' | 'rules' | 'pairs' | 'unpaired' | 'there'>,
): ProfileFold[] {
  const all = placeGroups(p).flatMap(g => g.list.map(x => ({ ...x, kind: g.kind })))
  return p.profiles.map(x => ({
    name: x.name,
    from: profileDir(p.from.home, x.name, p.from.platform),
    to: x.dir,
    create: x.create,
    projects: all.filter(y => y.profile === x.name).sort((a, b) => pathOf(a).localeCompare(pathOf(b))),
  }))
}
