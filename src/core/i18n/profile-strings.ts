// The texts of Claude profiles (the config folders sessions run in), in English and Russian;
// strings.ts merges them into the dictionaries.
import type { Lang } from '../types.ts'

export const PROFILE_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    // the Profiles panel's edits (adapters/config-file.ts editProfiles)
    'err.profile.missing': 'No profile “{id}”',
    'err.profile.title': 'A profile needs a name',
    'err.profile.lastShown': 'At least one profile stays shown',
    'err.profile.noFolder': 'There is no folder {path}',
    'err.profile.exists': '{path} is the profile {title} already',
    // Install from the Profiles panel (services/profiles.ts installProfile)
    'err.profile.hiddenInstall': 'Show {title} first: the board installs only into shown profiles',
    // the setup check with more than one profile shown (core/setup.ts)
    'setup.inProfile': '{profile}: {check}',
    'setup.profile.missing': '{profile}: its folder {dir} is not there',
  },
  ru: {
    // the Profiles panel's edits (adapters/config-file.ts editProfiles)
    'err.profile.missing': 'Нет профиля «{id}»',
    'err.profile.title': 'Профилю нужно название',
    'err.profile.lastShown': 'Хотя бы один профиль остаётся показанным',
    'err.profile.noFolder': 'Нет папки {path}',
    'err.profile.exists': '{path} — это уже профиль {title}',
    // Install from the Profiles panel (services/profiles.ts installProfile)
    'err.profile.hiddenInstall': 'Сначала покажи {title}: доска ставит хуки только в показанные профили',
    // the setup check with more than one profile shown (core/setup.ts)
    'setup.inProfile': '{profile}: {check}',
    'setup.profile.missing': '{profile}: папки {dir} нет',
  },
}
