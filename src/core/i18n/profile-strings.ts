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
    // a session's profile in a message when the board knows neither it nor its folder (core/profiles.ts)
    'profile.unknown': 'unknown profile',
    // a wake the board cannot keep in the session's profile (services/actions.ts wake)
    'err.wakeProfile':
      'Started outside the board in profile {profile}, so waking could resume it in the wrong account; wake it in herdr where you started it',
    // a wake into a pane the board opened in another profile than the session's (services/actions.ts wake)
    'err.wakePane':
      'Its pane was opened in profile {profile}, so waking could resume it in the wrong account; wake it in herdr where you started it',
    // a MokuPilot call from a session in another profile than the board's (services/mokupilot.ts)
    'mokupilot.err.profile':
      'MokuPilot takes the profile of its running copy, {board}: a call from {profile} would run in the wrong account',
    // herdr's notification of a session whose hooks report another profile than its start asked for (server/board-state.ts)
    'profile.wrongTitle': 'Wrong profile: {name}',
    'profile.wrongBody': '{name} was started in {want} but runs in {got}',
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
    // a session's profile in a message when the board knows neither it nor its folder (core/profiles.ts)
    'profile.unknown': 'неизвестный профиль',
    // a wake the board cannot keep in the session's profile (services/actions.ts wake)
    'err.wakeProfile':
      'Запущена вне доски в профиле {profile}: пробуждение может продолжить её не в том аккаунте; разбуди её в herdr, там, где запускал',
    // a wake into a pane the board opened in another profile than the session's (services/actions.ts wake)
    'err.wakePane':
      'Её панель открыта в профиле {profile}: пробуждение может продолжить её не в том аккаунте; разбуди её в herdr, там, где запускал',
    // a MokuPilot call from a session in another profile than the board's (services/mokupilot.ts)
    'mokupilot.err.profile':
      'MokuPilot берёт профиль своей запущенной копии, {board}: звонок из {profile} пошёл бы не в том аккаунте',
    // herdr's notification of a session whose hooks report another profile than its start asked for (server/board-state.ts)
    'profile.wrongTitle': 'Не тот профиль: {name}',
    'profile.wrongBody': '{name}: запущена в профиле {want}, а работает в {got}',
  },
}
