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
    // a launch from the board (services/launch/request.ts, launcher.ts, run.ts)
    'launch.err.profileChoose': 'Choose a profile',
    'launch.err.profileHidden': 'The profile {title} is hidden: show it in Settings → Profiles',
    'launch.err.profileParent': 'A session started from {name} runs in its profile, {title}',
    'launch.err.profileUnknown': 'The profile of {name} is not one the board knows: choose one',
    'launch.err.profileFolder': 'The folder of the profile {title} is not there: {path}',
    'launch.err.env':
      'herdr cannot set CLAUDE_CONFIG_DIR={dir} for the new tab (--env needs herdr 0.9.5 or newer): update herdr, or start this session yourself',
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
    // a launch from the board (services/launch/request.ts, launcher.ts, run.ts)
    'launch.err.profileChoose': 'Выбери профиль',
    'launch.err.profileHidden': 'Профиль {title} скрыт: покажи его в Настройки → Профили',
    'launch.err.profileParent': 'Сессия, начатая из {name}, работает в её профиле, {title}',
    'launch.err.profileUnknown': 'Профиль сессии {name} доске не известен: выбери профиль',
    'launch.err.profileFolder': 'Папки профиля {title} нет: {path}',
    'launch.err.env':
      'herdr не может задать CLAUDE_CONFIG_DIR={dir} для новой вкладки (--env есть в herdr с 0.9.5): обнови herdr или запусти эту сессию сам',
  },
}
