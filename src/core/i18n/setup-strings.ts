// Texts of the setup check (core/setup.ts: `board doctor`, the install action, the web board's
// setup note), merged into the board's dictionaries by strings.ts (same rules).

import type { Lang } from '../types.ts'

export const SETUP_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'setup.cards.title': 'Card store',
    'setup.cards.check': 'Check the card store used by this preview',
    'setup.cards.invalid': 'The explicit card-store path is invalid',
    'setup.cards.detail': 'Cards: {cards} ({source}). Schedules: {schedule}.',
    'setup.cards.fix': 'Set HERDR_BOARD_CARDS_DIR to an absolute folder, or unset it to use the normal state layout.',
    'setup.cards.writers':
      'The dashboard, board CLI and hooks must resolve the same cards folder. These paths describe this process; other processes may have different environments.',
    'setup.cards.preview':
      'LOCALAPPDATA changes this process’s cards and schedules. Writers outside this preview may still use the ordinary cards. Set HERDR_BOARD_CARDS_DIR to the intended authoritative cards folder to share cards only; keep preview schedules separate. No files are copied or merged.',
    'setup.title': 'Setup',
    'setup.incomplete': 'Setup incomplete',
    'setup.incompleteHint': 'Some of the board is not set up on this computer',
    'setup.allSet': 'Everything the board needs is set up.',
    'setup.todo': ['{n} thing needs a look.', '{n} things need a look.'],
    'setup.recheck': 'Check again',
    'setup.checking': 'Checking…',
    'setup.loadFailed': 'The board did not answer. Check again in a moment.',
    'setup.hide': 'Hide until something changes',
    'setup.copy': 'Copy',
    'setup.copied': 'Copied',
    'setup.cli': 'The same in a terminal: board doctor',
    'setup.runInstall': 'Run the install:',
    'setup.run': 'Run:',
    'setup.level.ok': 'Set up',
    'setup.level.error': 'Missing',
    'setup.level.warn': 'Needs a look',
    'setup.level.off': 'Off',
    'setup.level.na': 'Not on this system',

    'setup.node': 'Node {version} is too old',
    'setup.node.detail': 'The board needs Node 20 or newer.',

    'setup.cmd.ok': '{name} command',
    'setup.cmd.foreign': '{name} command is not the board’s',
    'setup.cmd.foreignDetail': 'Runs instead of the board’s: {files}.',
    'setup.cmd.foreignFix': 'Remove or rename it, then run the install again.',
    'setup.cmd.stale': '{name} command runs another copy of the board',
    'setup.cmd.staleDetail': 'It runs {file}. After the plugin moved or was updated, run the install again.',
    'setup.cmd.gone': '{name} command runs a copy of the board that is gone',
    'setup.cmd.goneDetail': 'It runs {file}, which is not there any more.',
    'setup.cmd.path': '{name} command is not on PATH',
    'setup.cmd.pathDetail': '{dir} is not on the PATH the board runs with.',
    'setup.cmd.pathFixWin': 'Add {dir} to PATH (user environment variables), then open a new terminal.',
    'setup.cmd.pathFix': 'Add {dir} to PATH in your shell profile, then open a new terminal.',
    'setup.cmd.missing': '{name} command is missing',
    'setup.cmd.missingFor': '{name} command is missing for {shells}',
    'setup.shell.ps': 'PowerShell',
    'setup.shell.gitBash': 'Git Bash',
    'setup.shell.sh': 'the shell',
    'setup.board.without':
      'Without it agents cannot keep their cards current (lane, what they do, what they wait for).',
    'setup.spawn.without': 'Agents start other sessions with it; the board itself does not need it on PATH.',

    'setup.hooks.ok': 'Claude Code hooks',
    'setup.hooks.okDetail': '{events} in {file}',
    'setup.hooks.unreadable': 'Claude Code settings cannot be read',
    'setup.hooks.unreadableFix': 'Fix the JSON there, then run the install again.',
    'setup.hooks.stale': 'Claude Code hooks run another copy of the board',
    'setup.hooks.missing': 'Claude Code hooks are missing: {events}',
    'setup.hooks.without':
      'Without them sessions do not learn about the board: agents do not set their lanes, and a question an agent asked is not cleared when you answer.',
    'setup.hooks.question': 'Claude Code hooks of an older install: no question hook',
    'setup.hooks.questionDetail':
      'Without the PreToolUse hook on AskUserQuestion in {file}, a question asked in auto or plan mode is answered in the terminal only: Claude Code writes it into the transcript once it is answered.',

    'setup.line.ok': 'Status line',
    'setup.line.okDetail': 'usage windows and context fill for the board',
    'setup.line.own': 'Status line is your own',
    'setup.line.ownDetail':
      'the board reads usage from the usagebar cache, if there is one, and context fill from the transcripts',
    'setup.line.stale': 'Status line runs another copy of the board',
    'setup.line.none': 'No status line',
    'setup.line.noneDetail': 'Without it the board shows no usage windows (5h, 7d) and guesses the context fill.',

    'setup.skill.ok': 'Skill {name} for the agents',
    'setup.skill.okDetail':
      'how sessions in herdr start and message others, do things later, run a server and get a dropped MCP server back',
    'setup.skill.missing': 'No skill {name} for the agents',
    'setup.skill.stale': 'Skill {name} is an older copy',
    'setup.skill.without':
      'The brief points sessions in herdr to it; without it they guess how to work with other sessions and with herdr.',
    'setup.skill.foreign': "Skill {name} is not the board's",
    'setup.skill.foreignDetail': "{file} is someone else's skill of that name, so the install leaves it alone.",
    'setup.skill.foreignFix': 'Rename or move that folder, then run the install again.',

    'setup.herdr.ok': 'herdr’s Claude hook',
    'setup.herdr.okDetail': 'herdr learns from it which conversation each session has',
    'setup.herdr.missing': 'herdr’s Claude hook is missing',
    'setup.herdr.without':
      'Without it herdr does not see which conversation a session has: its card shows no conversation and no profile.',

    'setup.key.ok': 'herdr key for the board',
    'setup.key.okDetail': '{key} in {file}',
    'setup.key.none': 'No herdr key for the board',
    'setup.key.noneDetail': 'Without it, open the board with: herdr plugin action invoke agent-board.open',
    'setup.key.noneFix': 'Add this to {file}, then run herdr server reload-config:',

    'setup.mokupilot.ok': 'MokuPilot: calls with a fork of a session',
    'setup.mokupilot.link': 'MokuPilot: calls from the viewer’s computer, by a mokupilot:// link',
    'setup.mokupilot.linkDetail':
      'Settings → MokuPilot… says “The computer you’re viewing from”: the page opens the link, the MokuPilot on the computer the board is opened on takes the call and runs the fork here over ssh. Nothing starts on this computer, and MokuPilot need not be installed here.',
    'setup.mokupilot.autoDetail':
      'Settings → MokuPilot… says “Auto”: a call asked from this computer starts here, one asked from another computer starts there, by a mokupilot:// link.',
    'setup.mokupilot.localMissingDetail':
      'Settings → MokuPilot… says “This machine”: calls start here, so MokuPilot must be installed here. Without it the “Call in MokuPilot” button stays hidden.',
    'setup.mokupilot.linkHint':
      'Under “Auto” a call asked from another computer goes there by a mokupilot:// link; one asked from this computer needs MokuPilot here, or “The computer you’re viewing from” in Settings → MokuPilot….',
    'setup.mokupilot.autoMissingDetail':
      'Under “Auto” a call asked from this computer fails until it is found; one asked from another computer goes there by a mokupilot:// link.',
    'setup.mokupilot.off': 'MokuPilot is not on this computer',
    'setup.mokupilot.offDetail':
      'With MokuPilot, a session’s sheet starts a call whose agent is a fork of that session.',
    'setup.mokupilot.offFix': 'Install MokuPilot, or point the board’s config.json at its folder:',
    'setup.mokupilot.disabled': 'MokuPilot calls are turned off',
    'setup.mokupilot.disabledDetail': '"mokupilot": false in the board’s config.json.',
    'setup.mokupilot.missing': 'MokuPilot not found: {file}',
    'setup.mokupilot.missingDetail': 'Without it the “Call in MokuPilot” button stays hidden.',
    'setup.mokupilot.missingFix': 'Fix "mokupilot" in the board’s config.json:',

    'setup.wake.ok': 'herdr-wake',
    'setup.wake.okDetail': 'answers at {url}',
    'setup.wake.off': 'herdr-wake is off',
    'setup.wake.offDetail': 'wakeUrl in the board’s config.json is empty.',
    'setup.wake.down': 'herdr-wake does not answer at {url}',
    'setup.wake.without':
      'Without it there is no “Put to sleep”, “Wake” or “Restart”, agents cannot restart themselves (board restart, the way to get a dropped MCP server back), no sleeping sessions show on the board, and reminders cannot wake a session that sleeps.',

    'setup.launch.command': 'New sessions: your launch.command ({name})',
    'setup.launch.commandBad': 'New sessions: launch.command ({name}) cannot run',
    'setup.launch.commandBadDetail': '{what} not found. “New session” fails until it is fixed.',
    'setup.launch.commandBadFix':
      'Fix launch.command in the board’s config.json, or remove it to use the board’s own spawn-agent.',
    'setup.launch.herdr': 'New sessions: herdr agent start --kind {agent}',
    'setup.launch.herdrDetail': 'launch.agent is set, so herdr starts the agent itself',
    'setup.launch.builtin': 'New sessions: the board’s spawn-agent, Claude as “{claude}”',
    'setup.launch.builtinDetail':
      'launch.claude in config.json changes it: your own launcher, --dangerously-skip-permissions, a model',
    'setup.launch.claudeBad': 'New sessions: launch.claude cannot be used',
    'setup.launch.claudeBadFix': 'Fix launch.claude in the board’s config.json.',
    'setup.launch.notFound': 'New sessions: {program} is not on PATH',
    'setup.launch.notFoundDetail':
      'The board’s spawn-agent types it into a new tab, and the PATH the board runs with has no {program} (the tab’s shell may still find it).',
    'setup.launch.notFoundFix': 'Set launch.claude in the board’s config.json to the command that starts Claude Code.',

    'setup.toast.na': 'Desktop notifications: Windows and macOS only',
    'setup.toast.naDetail': 'On Linux herdr shows its own: [ui.toast] delivery = "system" in herdr’s config.toml.',
    'setup.toast.off': 'Desktop notifications are off',
    'setup.toast.offDetail':
      'A desktop notification with the agent’s own words when a session finishes, asks a question or needs a permission; a click opens that session on the board.',
    'setup.toast.offFix': 'Turn them on:',
    'setup.toast.stale': 'Desktop notifications run another copy of the board',
    'setup.toast.twice': 'Desktop notifications come twice',
    'setup.toast.twiceDetail': 'herdr shows its own too: [ui.toast] delivery = "{delivery}" in {file}.',
    'setup.toast.twiceFix': 'Set delivery = "off" under [ui.toast] there, then run herdr server reload-config.',
    'setup.toast.theirs': 'Another hook shows them too: {command}',
    'setup.toast.theirsFix':
      'Remove that hook from {file}, or turn the board’s off with bun src/entrypoints/install.ts --no-toast in the plugin’s folder.',
    'setup.toast.own': 'Desktop notifications from a hook of your own',
    'setup.toast.ok': 'Desktop notifications',
    'setup.toast.okDetail': 'when a session finishes, asks or needs a permission, except in the pane you look at',
  },
  ru: {
    'setup.cards.title': 'Хранилище карточек',
    'setup.cards.check': 'Проверь хранилище карточек этого preview',
    'setup.cards.invalid': 'Неверный явный путь к карточкам',
    'setup.cards.detail': 'Карточки: {cards} ({source}). Расписания: {schedule}.',
    'setup.cards.fix': 'Задай в HERDR_BOARD_CARDS_DIR абсолютный путь или убери переменную для обычного расположения.',
    'setup.cards.writers':
      'Доска, команда board и хуки должны использовать одну папку карточек. Здесь показаны пути этого процесса; у других процессов окружение может отличаться.',
    'setup.cards.preview':
      'LOCALAPPDATA меняет карточки и расписания этого процесса. Команды и хуки вне preview могут писать в обычную папку. Для общих карточек задай HERDR_BOARD_CARDS_DIR, оставив расписания preview отдельно. Файлы не копируются и не объединяются.',
    'setup.title': 'Настройка',
    'setup.incomplete': 'Настроено не всё',
    'setup.incompleteHint': 'Часть доски на этом компьютере не настроена',
    'setup.allSet': 'Всё, что нужно доске, настроено.',
    'setup.todo': ['{n} пункт требует внимания.', '{n} пункта требуют внимания.', '{n} пунктов требуют внимания.'],
    'setup.recheck': 'Проверить снова',
    'setup.checking': 'Проверяю…',
    'setup.loadFailed': 'Доска не ответила. Проверь снова чуть позже.',
    'setup.hide': 'Скрыть, пока ничего не изменится',
    'setup.copy': 'Копировать',
    'setup.copied': 'Скопировано',
    'setup.cli': 'То же в терминале: board doctor',
    'setup.runInstall': 'Запусти установку:',
    'setup.run': 'Выполни:',
    'setup.level.ok': 'Настроено',
    'setup.level.error': 'Не хватает',
    'setup.level.warn': 'Требует внимания',
    'setup.level.off': 'Выключено',
    'setup.level.na': 'Нет на этой системе',

    'setup.node': 'Node {version} слишком старый',
    'setup.node.detail': 'Доске нужен Node 20 или новее.',

    'setup.cmd.ok': 'Команда {name}',
    'setup.cmd.foreign': 'Команда {name} не от доски',
    'setup.cmd.foreignDetail': 'Вместо команды доски запускается: {files}.',
    'setup.cmd.foreignFix': 'Удали или переименуй её, потом снова запусти установку.',
    'setup.cmd.stale': 'Команда {name} запускает другую копию доски',
    'setup.cmd.staleDetail': 'Она запускает {file}. Если плагин переехал или обновился, запусти установку снова.',
    'setup.cmd.gone': 'Команда {name} запускает копию доски, которой больше нет',
    'setup.cmd.goneDetail': 'Она запускает {file}, а его уже нет.',
    'setup.cmd.path': 'Команды {name} нет в PATH',
    'setup.cmd.pathDetail': 'Папки {dir} нет в PATH, с которым работает доска.',
    'setup.cmd.pathFixWin': 'Добавь {dir} в PATH (переменные среды пользователя) и открой новый терминал.',
    'setup.cmd.pathFix': 'Добавь {dir} в PATH в профиле оболочки и открой новый терминал.',
    'setup.cmd.missing': 'Нет команды {name}',
    'setup.cmd.missingFor': 'Нет команды {name} для {shells}',
    'setup.shell.ps': 'PowerShell',
    'setup.shell.gitBash': 'Git Bash',
    'setup.shell.sh': 'оболочки',
    'setup.board.without': 'Без неё агенты не обновляют свои карточки (дорожку, чем заняты, чего ждут).',
    'setup.spawn.without': 'Ею агенты запускают другие сессии; самой доске она в PATH не нужна.',

    'setup.hooks.ok': 'Хуки Claude Code',
    'setup.hooks.okDetail': '{events} в {file}',
    'setup.hooks.unreadable': 'Не читаются настройки Claude Code',
    'setup.hooks.unreadableFix': 'Исправь там JSON, потом запусти установку снова.',
    'setup.hooks.stale': 'Хуки Claude Code запускают другую копию доски',
    'setup.hooks.missing': 'Нет хуков Claude Code: {events}',
    'setup.hooks.without':
      'Без них сессии не узнают о доске: агенты не ставят себе дорожку, а вопрос агента не снимается, когда ты ответил.',
    'setup.hooks.question': 'Хуки Claude Code от прежней установки: нет хука вопросов',
    'setup.hooks.questionDetail':
      'Без хука PreToolUse на AskUserQuestion в {file} на вопрос в режиме auto или plan отвечают только в терминале: Claude Code пишет его в переписку, лишь когда на него ответили.',

    'setup.line.ok': 'Строка статуса',
    'setup.line.okDetail': 'окна лимитов и заполнение контекста для доски',
    'setup.line.own': 'Строка статуса своя',
    'setup.line.ownDetail': 'лимиты доска берёт из кэша usagebar, если он есть, а заполнение контекста из переписок',
    'setup.line.stale': 'Строка статуса запускает другую копию доски',
    'setup.line.none': 'Нет строки статуса',
    'setup.line.noneDetail': 'Без неё доска не показывает окна лимитов (5ч, 7д) и угадывает заполнение контекста.',

    'setup.skill.ok': 'Скилл {name} для агентов',
    'setup.skill.okDetail':
      'как сессии в herdr запускают другие и пишут им, делают что-то позже, держат сервер и возвращают отвалившийся MCP',
    'setup.skill.missing': 'Нет скилла {name} для агентов',
    'setup.skill.stale': 'Скилл {name} устарел',
    'setup.skill.without':
      'Вводная отсылает к нему сессии в herdr; без него они гадают, как работать с другими сессиями и с herdr.',
    'setup.skill.foreign': 'Скилл {name} не от доски',
    'setup.skill.foreignDetail': '{file}: чужой скилл с таким именем, установка его не трогает.',
    'setup.skill.foreignFix': 'Переименуй или перенеси эту папку, потом снова запусти установку.',

    'setup.herdr.ok': 'Хук Claude для herdr',
    'setup.herdr.okDetail': 'из него herdr узнаёт, какой разговор у каждой сессии',
    'setup.herdr.missing': 'Нет хука Claude для herdr',
    'setup.herdr.without':
      'Без него herdr не видит, какой разговор у сессии: в её карточке нет ни переписки, ни профиля.',

    'setup.key.ok': 'Клавиша доски в herdr',
    'setup.key.okDetail': '{key} в {file}',
    'setup.key.none': 'В herdr нет клавиши для доски',
    'setup.key.noneDetail': 'Без неё доска открывается так: herdr plugin action invoke agent-board.open',
    'setup.key.noneFix': 'Добавь это в {file}, потом выполни herdr server reload-config:',

    'setup.mokupilot.ok': 'MokuPilot: звонки с форком сессии',
    'setup.mokupilot.link': 'MokuPilot: звонки с компьютера зрителя, по ссылке mokupilot://',
    'setup.mokupilot.linkDetail':
      'В Настройках → MokuPilot… выбрано «Компьютер, с которого ты смотришь»: страница открывает ссылку, звонок берёт MokuPilot на компьютере, где открыта доска, и запускает форк здесь по ssh. На этом компьютере ничего не запускается, ставить сюда MokuPilot не нужно.',
    'setup.mokupilot.autoDetail':
      'В Настройках → MokuPilot… выбрано «Авто»: звонок с этого компьютера начинается здесь, звонок с другого компьютера начинается там, по ссылке mokupilot://.',
    'setup.mokupilot.localMissingDetail':
      'В Настройках → MokuPilot… выбрано «Этот компьютер»: звонки начинаются здесь, и MokuPilot должен быть установлен здесь. Без него кнопки «Звонок в MokuPilot» не будет.',
    'setup.mokupilot.linkHint':
      'В режиме «Авто» звонок с другого компьютера идёт туда по ссылке mokupilot://; звонку с этого компьютера нужен MokuPilot здесь или «Компьютер, с которого ты смотришь» в Настройках → MokuPilot….',
    'setup.mokupilot.autoMissingDetail':
      'В режиме «Авто» звонок с этого компьютера не начнётся, пока MokuPilot не найден; звонок с другого компьютера идёт туда по ссылке mokupilot://.',
    'setup.mokupilot.off': 'MokuPilot на этом компьютере нет',
    'setup.mokupilot.offDetail': 'С MokuPilot панель сессии начинает звонок, где агент: форк этой сессии.',
    'setup.mokupilot.offFix': 'Установи MokuPilot или укажи его папку в config.json доски:',
    'setup.mokupilot.disabled': 'Звонки в MokuPilot выключены',
    'setup.mokupilot.disabledDetail': '"mokupilot": false в config.json доски.',
    'setup.mokupilot.missing': 'MokuPilot не найден: {file}',
    'setup.mokupilot.missingDetail': 'Без него кнопки «Звонок в MokuPilot» не будет.',
    'setup.mokupilot.missingFix': 'Поправь "mokupilot" в config.json доски:',

    'setup.wake.ok': 'herdr-wake',
    'setup.wake.okDetail': 'отвечает на {url}',
    'setup.wake.off': 'herdr-wake выключен',
    'setup.wake.offDetail': 'wakeUrl в config.json доски пустой.',
    'setup.wake.down': 'herdr-wake не отвечает на {url}',
    'setup.wake.without':
      'Без него нет «Усыпить», «Разбудить» и «Перезапустить», агенты не могут перезапустить себя (board restart, способ вернуть отвалившийся MCP-сервер), спящих сессий на доске не видно, и напоминания не будят спящую сессию.',

    'setup.launch.command': 'Новые сессии: твой launch.command ({name})',
    'setup.launch.commandBad': 'Новые сессии: launch.command ({name}) не запустится',
    'setup.launch.commandBadDetail': 'Не найдено: {what}. «Новая сессия» не сработает, пока это не исправлено.',
    'setup.launch.commandBadFix':
      'Исправь launch.command в config.json доски или убери его, чтобы доска запускала своим spawn-agent.',
    'setup.launch.herdr': 'Новые сессии: herdr agent start --kind {agent}',
    'setup.launch.herdrDetail': 'задан launch.agent, агента запускает сам herdr',
    'setup.launch.builtin': 'Новые сессии: spawn-agent доски, Claude как «{claude}»',
    'setup.launch.builtinDetail':
      'меняется через launch.claude в config.json: свой запускатель, --dangerously-skip-permissions, модель',
    'setup.launch.claudeBad': 'Новые сессии: launch.claude не годится',
    'setup.launch.claudeBadFix': 'Исправь launch.claude в config.json доски.',
    'setup.launch.notFound': 'Новые сессии: {program} нет в PATH',
    'setup.launch.notFoundDetail':
      'spawn-agent доски набирает её в новой вкладке, а в PATH, с которым работает доска, нет {program} (оболочка вкладки может всё же его найти).',
    'setup.launch.notFoundFix': 'Укажи в launch.claude (config.json доски) команду, которая запускает Claude Code.',

    'setup.toast.na': 'Уведомления на рабочем столе: только Windows и macOS',
    'setup.toast.naDetail': 'На Linux herdr показывает свои: [ui.toast] delivery = "system" в config.toml herdr.',
    'setup.toast.off': 'Уведомления на рабочем столе выключены',
    'setup.toast.offDetail':
      'Уведомление на рабочем столе словами самого агента, когда сессия закончила, спрашивает или просит разрешение; щелчок открывает эту сессию на доске.',
    'setup.toast.offFix': 'Включить:',
    'setup.toast.stale': 'Уведомления запускают другую копию доски',
    'setup.toast.twice': 'Уведомления приходят дважды',
    'setup.toast.twiceDetail': 'herdr показывает и свои: [ui.toast] delivery = "{delivery}" в {file}.',
    'setup.toast.twiceFix': 'Поставь там delivery = "off" в [ui.toast], потом выполни herdr server reload-config.',
    'setup.toast.theirs': 'Их показывает и другой хук: {command}',
    'setup.toast.theirsFix':
      'Убери этот хук из {file} или выключи уведомления доски: bun src/entrypoints/install.ts --no-toast в папке плагина.',
    'setup.toast.own': 'Уведомления на рабочем столе от твоего хука',
    'setup.toast.ok': 'Уведомления на рабочем столе',
    'setup.toast.okDetail':
      'когда сессия закончила, спрашивает или просит разрешение, кроме панели, на которую ты смотришь',
  },
}
