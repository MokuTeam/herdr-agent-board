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
    // a profile's start command, refused by the Profiles panel's edit, a launch from the board and
    // spawn-agent (core/launch/spawn-args.ts profileCommand)
    'err.profile.commandShape':
      'A start command is a program, or a list of the program and its arguments: "cld-work" or ["cld-work", "--model", "opus"]',
    'err.profile.commandDash': 'A start command begins with a program, not “{word}”, which starts with a dash',
    'err.profile.commandProgram':
      'The start command is typed at the new tab’s shell prompt, so its program “{word}” must be one word: a name the shell knows (cld-work) or a path, without spaces or quotes',
    'err.profile.commandChars':
      'The start command’s argument {word} has a quote or a control character in it, which cannot be typed into a shell',
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
    // a reminder whose session is gone, not sent to the session of another profile now in its pane (services/scheduler.ts)
    'sched.err.profile':
      'The session now in its pane runs in profile {now}, not in {was}, where this was set, so it does not go there; if it is for that session, set it there again',
    // a MokuPilot call from a session in another profile than the board's (services/mokupilot.ts)
    'mokupilot.err.profile':
      'MokuPilot takes the profile of its running copy, {board}: a call from {profile} would run in the wrong account',
    // herdr's notification of a session whose hooks report another profile than its start asked for (server/board-state.ts)
    'profile.wrongTitle': 'Wrong profile: {name}',
    'profile.wrongBody': '{name} was started in {want} but runs in {got}',
    // the profile switch beside the lanes control, and the tag on a card (web/src/components/ProfileSwitch.tsx, ProfileTag.tsx)
    'tb.profiles': 'Profiles',
    'profile.all': 'All profiles',
    'profile.wrong': 'Wrong profile: started for {want}',
    // the tag on the terminal board's line of a session in another profile than its start asked for (src/tui/render.ts)
    'tui.wrongProfile': 'wrong profile',
    // a shown profile with no usage reading, in the usage popover (web/src/components/LimitsPop.tsx)
    'limits.noSession': 'No session lately',
    // a lane's usual profile in the categories panel (web/src/components/categories/CategoryRow.tsx)
    'cat.profile': 'Usual profile',
    'cat.profileNone': 'None',
    // the profile choice in the new-session window (web/src/components/launch/LaunchDialog.tsx)
    'launch.profile': 'Profile',
    // the Profiles panel, from Settings with more than one profile folder (web/src/components/profiles)
    'set.profiles': 'Profiles…',
    'prof.title': 'Profiles',
    'prof.about':
      'The Claude Code folders the board found (CLAUDE_CONFIG_DIR). A hidden profile is left out of the switch, new sessions and Install.',
    'prof.name': 'Name',
    'prof.sessions': ['{n} session now', '{n} sessions now'],
    'prof.shown': 'Shown',
    'prof.hidden': 'Hidden',
    'prof.missing': 'Folder not found',
    'prof.addUnknown': 'Add {path}',
    'prof.dir': 'Folder, Enter',
    'prof.add': 'Add a folder somewhere else',
    'prof.noHooks': 'The board’s hooks are not in {title}’s settings.json: its sessions show no status or title',
    'prof.install': 'Install',
  },
  ru: {
    // the Profiles panel's edits (adapters/config-file.ts editProfiles)
    'err.profile.missing': 'Нет профиля «{id}»',
    'err.profile.title': 'Профилю нужно название',
    'err.profile.lastShown': 'Хотя бы один профиль остаётся показанным',
    'err.profile.noFolder': 'Нет папки {path}',
    'err.profile.exists': '{path} — это уже профиль {title}',
    // a profile's start command, refused by the Profiles panel's edit, a launch from the board and
    // spawn-agent (core/launch/spawn-args.ts profileCommand)
    'err.profile.commandShape':
      'Команда запуска — это программа или список из программы и её аргументов: "cld-work" или ["cld-work", "--model", "opus"]',
    'err.profile.commandDash': 'Команда запуска начинается с программы, а не с «{word}»: здесь в начале дефис',
    'err.profile.commandProgram':
      'Команда запуска набирается в оболочке новой вкладки, поэтому её программа «{word}» должна быть одним словом: имя, которое знает оболочка (cld-work), или путь без пробелов и кавычек',
    'err.profile.commandChars':
      'В аргументе команды запуска {word} есть кавычка или управляющий символ: такое не набрать в оболочке',
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
    // a reminder whose session is gone, not sent to the session of another profile now in its pane (services/scheduler.ts)
    'sched.err.profile':
      'Сессия, что сейчас в её панели, работает в профиле {now}, а не в {was}, где это поставлено, поэтому туда оно не уходит; если оно для той сессии, поставь его там заново',
    // a MokuPilot call from a session in another profile than the board's (services/mokupilot.ts)
    'mokupilot.err.profile':
      'MokuPilot берёт профиль своей запущенной копии, {board}: звонок из {profile} пошёл бы не в том аккаунте',
    // herdr's notification of a session whose hooks report another profile than its start asked for (server/board-state.ts)
    'profile.wrongTitle': 'Не тот профиль: {name}',
    'profile.wrongBody': '{name}: запущена в профиле {want}, а работает в {got}',
    // the profile switch beside the lanes control, and the tag on a card (web/src/components/ProfileSwitch.tsx, ProfileTag.tsx)
    'tb.profiles': 'Профили',
    'profile.all': 'Все профили',
    'profile.wrong': 'Не тот профиль: запущена для {want}',
    // the tag on the terminal board's line of a session in another profile than its start asked for (src/tui/render.ts)
    'tui.wrongProfile': 'не тот профиль',
    // a shown profile with no usage reading, in the usage popover (web/src/components/LimitsPop.tsx)
    'limits.noSession': 'Сессий давно не было',
    // a lane's usual profile in the categories panel (web/src/components/categories/CategoryRow.tsx)
    'cat.profile': 'Обычный профиль',
    'cat.profileNone': 'Нет',
    // the profile choice in the new-session window (web/src/components/launch/LaunchDialog.tsx)
    'launch.profile': 'Профиль',
    // the Profiles panel, from Settings with more than one profile folder (web/src/components/profiles)
    'set.profiles': 'Профили…',
    'prof.title': 'Профили',
    'prof.about':
      'Папки Claude Code, которые нашла доска (CLAUDE_CONFIG_DIR). Скрытого профиля нет в переключателе, в новых сессиях и в установке хуков.',
    'prof.name': 'Название',
    'prof.sessions': ['{n} сессия сейчас', '{n} сессии сейчас', '{n} сессий сейчас'],
    'prof.shown': 'Показан',
    'prof.hidden': 'Скрыт',
    'prof.missing': 'Папка не найдена',
    'prof.addUnknown': 'Добавить {path}',
    'prof.dir': 'Папка, Enter',
    'prof.add': 'Добавить папку из другого места',
    'prof.noHooks': 'Хуков доски нет в settings.json профиля {title}: его сессии не показывают ни статус, ни заголовок',
    'prof.install': 'Установить',
  },
}
