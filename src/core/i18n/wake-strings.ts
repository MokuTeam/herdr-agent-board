// The texts of sleep and wake (#119): Settings → Sleep and wake…, its state and switches, the
// board's own wake and its refusals, the toolbar note and `board doctor`'s wake line, in English
// and Russian; strings.ts merges them into the dictionaries. Each task adds its keys under its own
// heading, in both languages.
import type { Lang } from '../types.ts'

export const WAKE_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    // Task 4.1: Settings → Sleep and wake…, its state and switches
    'set.wake': 'Sleep and wake…',
    'wake.title': 'Sleep and wake',
    'wake.switch': 'Sleep and wake',
    'wake.switchHint': 'Put to sleep, Wake and Restart, in every profile',
    'wake.state.off': 'Off',
    'wake.state.offAsleep': 'Off. {n} asleep still wake from their cards',
    'wake.state.starting': 'Starting…',
    'wake.state.running': 'Running since {time}, {n} asleep',
    'wake.state.crashed': 'Crashed: stopped after {n} crashes in 10 minutes. {error}',
    'wake.state.notRunning': 'Not running',
    'wake.state.held': 'The separate herdr-wake plugin does this now',
    'wake.state.portTaken': 'Port {port} is taken by another program',
    'wake.start': 'Start',
    'wake.again': 'Start again',
    'wake.log': 'Log',
    'wake.reaper': 'Put idle sessions to sleep',
    'wake.reaper.after': 'after {min} minutes',
    'wake.reaper.minutes': 'Minutes idle',
    'wake.reaper.exclude': 'Never put to sleep',
    'wake.reaper.excludeHint': 'Names, workspaces or /regex/, one per line',
    'wake.telegram': 'Telegram messages (tg-mcp)',
    'wake.telegram.auto': 'Auto',
    'wake.telegram.off': 'Off',
    'wake.telegram.connected': 'connected to {host}',
    'wake.telegram.none': 'no tg-mcp set up',
    'wake.telegram.error': 'last poll: {error}',
    // why a switch's value is refused (adapters/config-file.ts editWake, err.wakeSetting's {why})
    'wake.why.onOff': 'on or off',
    'wake.why.minutes': 'a whole number of minutes, 1 or more',
    'wake.why.mode': 'auto or off',
    'wake.why.names': 'a list of names',
    // Task 4.3: the board's own wake and the refusals
    'err.wakeOff': 'Sleep and wake is off (Settings → Sleep and wake…)',
    'err.wakeBusy': 'Wake is slow to answer and may be waking {name} already; try again in a minute',
    'err.canWake.board': '{name} could not be woken again: the board command is not on PATH',
    'err.canWake.profile': '{name} could not be woken again: its profile is not known',
    'err.canWake.transcript': "{name} could not be woken again: its conversation is not in its profile's folder",
    'err.piFileGone': '{name} cannot be woken: its pi session file is gone',
    'err.wakeNoAnswer': 'Sleep and wake is on but does not answer on port {port}',
    'err.wakeSetting': '{field}: {why}',
    // Task 4.6: the panel and the toolbar note
    'wake.stopped': 'Wake stopped',
    'wake.stoppedHint': 'Sleep and wake is on but not running: open its settings',
    'wake.readOnly': 'Changed on the computer only',
    // wake's hooks in a shown profile (the panel's Install), and the Profiles panel's Install beside the old plugin's
    'wake.hooks.missing':
      'Sleep and wake’s hooks are not in {title}’s settings.json: its sessions do not see sleeping sessions, and a message to one does not wake it',
    'wake.hooks.old':
      '{title}’s settings.json has the separate herdr-wake plugin’s hooks: its sessions ask that plugin, not the board’s wake',
    'wake.installOld':
      'Sleep and wake’s hooks were not added to {title}: its settings.json has the separate herdr-wake plugin’s hooks',
    // Task 4.7: board doctor's wake line
    'setup.wake.running': 'Sleep and wake runs',
    'setup.wake.runningDetail': 'on 127.0.0.1:{port}, {n} asleep',
    'setup.wake.newOff': 'Sleep and wake is off',
    'setup.wake.newOffFix':
      'Turn it on in Settings → Sleep and wake…, or set "wake": { "enabled": true } in the board\'s config.json',
    'setup.wake.crashed': 'Sleep and wake crashed',
    'setup.wake.crashedFix': 'Settings → Sleep and wake… → Start again. Its log: {file}',
    'setup.wake.held': 'The separate herdr-wake plugin puts sessions to sleep',
    'setup.wake.heldFix': 'Settings → Sleep and wake… → Switch over…',
    'setup.wake.notAnswering': 'Sleep and wake is on but does not answer on port {port}',
    'setup.wake.notAnsweringFix': 'Settings → Sleep and wake… → Start. Its log: {file}',
    'setup.wake.portTaken': 'Port {port} is taken by another program',
    'setup.wake.portTakenFix': 'Set another "port" in the wake section of the board\'s config.json',
    'setup.wake.portRouter': 'Port {port} is held by the separate herdr-wake plugin’s router (process {pid})',
    'setup.wake.portRouterFix':
      'Close the pane of the herdr-wake router (process {pid}), then Settings → Sleep and wake… → Start again',
    'setup.wake.urlUnused': 'wakeUrl in config.json is not used while Sleep and wake is on',
    'setup.wake.starting': 'Sleep and wake is starting',
    // wake's ListAgents and SendMessage hooks in each shown profile, while it is on and not held
    'setup.wake.hooks.ok': 'Sleep and wake’s hooks',
    'setup.wake.hooks.okDetail': 'ListAgents and SendMessage in {file}',
    'setup.wake.hooks.missing': 'Sleep and wake’s hooks are not in place',
    'setup.wake.hooks.without':
      'Without them, sessions do not see sleeping sessions in ListAgents, and a SendMessage to one does not wake it.',
    'setup.wake.hooks.old': 'The separate herdr-wake plugin’s hooks are in place',
    'setup.wake.hooks.oldDetail': 'Sessions here ask the separate plugin, not the board’s wake.',
    // Task 6.2: claude-tg
    'wake.launcher': 'Install claude-tg',
    'wake.launcherDone': 'claude-tg is in {dir}',
    'err.launcherForeign':
      '{files}: not the board’s nor herdr-wake’s, so it was left as it is. Move it away and try again',
    // Task 7.2: Switch over…
    'wake.switchOver': 'Switch over…',
    'wake.switchConfirm':
      "Take over the herdr-wake plugin's settings and sleeping sessions, uninstall it, move its hooks to the board's in every profile, close its tg-router workspace and start the board's wake?",
    'wake.switchGo': 'Switch over',
    'wake.switched': 'Taken over: {summary}',
    'wake.launcherNote':
      "herdr-wake woke sessions with {old}; the board starts them with {now}. Set launch.claude in the board's config.json to keep {old}.",
    'wake.bindings': "Rename in herdr's config.toml: {list}",
    // what was taken over, in wake.switched's {summary}: "reaper on, 60 min, 2 excluded; Telegram; 4 sleeping sessions"
    'wake.summary.reaperOn': 'reaper on, {min} min',
    'wake.summary.reaperOff': 'reaper off',
    'wake.summary.excluded': '{n} excluded',
    'wake.summary.telegram': 'Telegram',
    'wake.summary.asleep': ['{n} sleeping session', '{n} sleeping sessions'],
    'err.switchOver': 'Switch over stopped: {error}',
    'err.oldRouter':
      'The herdr-wake plugin’s router still answers on port {port} (process {pid}): close its pane, then Switch over… again',
    // the Telegram router's state while wake runs
    'wake.router.polling': 'Receiving messages from {host}',
    'wake.router.error': 'Not receiving messages: {error}',
    'wake.router.off': 'Not receiving messages',
    // the board's own wake named where herdr-wake was before (err.wakeDown, err.sleep.unknown, rename.alsoClaudeHint)
    'err.boardWakeDown': 'Wake did not answer: {why}',
    'err.sleep.unknownToWake': 'wake does not know it',
    'rename.alsoClaudeHintWake': 'Types /rename into the session; other sessions and the board’s wake see the new name',
    // the takeover at wake's first start (the old plugin removed by hand): said until seen in the panel
    'wake.takenOver': [
      'At its first start, wake took over the separate herdr-wake plugin’s settings and {n} sleeping session. The reaper and Telegram were left off: turn them on below when you want them.',
      'At its first start, wake took over the separate herdr-wake plugin’s settings and {n} sleeping sessions. The reaper and Telegram were left off: turn them on below when you want them.',
    ],
    'wake.takenOverSeen': 'Got it',
    'setup.wake.takenOver': 'Sleep and wake took over the separate herdr-wake plugin at its first start',
    'setup.wake.takenOverDetail': [
      'Its settings and {n} sleeping session were taken over; the reaper and Telegram were left off.',
      'Its settings and {n} sleeping sessions were taken over; the reaper and Telegram were left off.',
    ],
    'setup.wake.takenOverFix':
      'Turn them on in Settings → Sleep and wake… when you want them; this note goes once it was seen there.',
  },
  ru: {
    // Task 4.1: Settings → Sleep and wake…, its state and switches
    'set.wake': 'Сон и пробуждение…',
    'wake.title': 'Сон и пробуждение',
    'wake.switch': 'Сон и пробуждение',
    'wake.switchHint': '«Усыпить», «Разбудить» и «Перезапустить» во всех профилях',
    'wake.state.off': 'Выключено',
    'wake.state.offAsleep': [
      'Выключено. {n} спящая сессия всё ещё будится со своей карточки',
      'Выключено. {n} спящие сессии всё ещё будятся со своих карточек',
      'Выключено. {n} спящих сессий всё ещё будятся со своих карточек',
    ],
    'wake.state.starting': 'Запускается…',
    'wake.state.running': ['Работает с {time}, {n} спит', 'Работает с {time}, {n} спят', 'Работает с {time}, {n} спят'],
    'wake.state.crashed': [
      'Упало: остановлено после {n} падения за 10 минут. {error}',
      'Упало: остановлено после {n} падений за 10 минут. {error}',
      'Упало: остановлено после {n} падений за 10 минут. {error}',
    ],
    'wake.state.notRunning': 'Не работает',
    'wake.state.held': 'Сейчас этим занимается отдельный плагин herdr-wake',
    'wake.state.portTaken': 'Порт {port} занят другой программой',
    'wake.start': 'Запустить',
    'wake.again': 'Запустить заново',
    'wake.log': 'Журнал',
    'wake.reaper': 'Усыплять простаивающие сессии',
    'wake.reaper.after': 'через {min} мин',
    'wake.reaper.minutes': 'Минут простоя',
    'wake.reaper.exclude': 'Никогда не усыплять',
    'wake.reaper.excludeHint': 'Имена, рабочие пространства или /regex/, по одному в строке',
    'wake.telegram': 'Сообщения из Telegram (tg-mcp)',
    'wake.telegram.auto': 'Авто',
    'wake.telegram.off': 'Выкл',
    'wake.telegram.connected': 'подключено к {host}',
    'wake.telegram.none': 'tg-mcp не настроен',
    'wake.telegram.error': 'последний опрос: {error}',
    // why a switch's value is refused (adapters/config-file.ts editWake, err.wakeSetting's {why})
    'wake.why.onOff': 'включено или выключено',
    'wake.why.minutes': 'целое число минут, от 1',
    'wake.why.mode': 'auto или off',
    'wake.why.names': 'список имён',
    // Task 4.3: the board's own wake and the refusals
    'err.wakeOff': 'Сон и пробуждение выключены (Настройки → Сон и пробуждение…)',
    'err.wakeBusy': 'Пробуждение долго не отвечает и, возможно, уже будит {name}; попробуй через минуту',
    'err.canWake.board': '{name} не разбудить: команды board нет в PATH',
    'err.canWake.profile': '{name} не разбудить: её профиль неизвестен',
    'err.canWake.transcript': '{name} не разбудить: её разговора нет в папке её профиля',
    'err.piFileGone': '{name} не разбудить: файла её сессии pi больше нет',
    'err.wakeNoAnswer': 'Сон и пробуждение включены, но не отвечают на порту {port}',
    'err.wakeSetting': '{field}: {why}',
    // Task 4.6: the panel and the toolbar note
    'wake.stopped': 'Пробуждение остановлено',
    'wake.stoppedHint': 'Сон и пробуждение включены, но не работают: открой их настройки',
    'wake.readOnly': 'Меняется только на компьютере',
    // wake's hooks in a shown profile (the panel's Install), and the Profiles panel's Install beside the old plugin's
    'wake.hooks.missing':
      'Хуков сна и пробуждения нет в settings.json профиля {title}: его сессии не видят спящих, а сообщение спящей сессии её не будит',
    'wake.hooks.old':
      'В settings.json профиля {title} стоят хуки отдельного плагина herdr-wake: его сессии спрашивают этот плагин, а не пробуждение доски',
    'wake.installOld':
      'Хуки сна и пробуждения не добавлены в профиль {title}: в его settings.json стоят хуки отдельного плагина herdr-wake',
    // Task 4.7: board doctor's wake line
    'setup.wake.running': 'Сон и пробуждение работают',
    'setup.wake.runningDetail': [
      'на 127.0.0.1:{port}, {n} спит',
      'на 127.0.0.1:{port}, {n} спят',
      'на 127.0.0.1:{port}, {n} спят',
    ],
    'setup.wake.newOff': 'Сон и пробуждение выключены',
    'setup.wake.newOffFix':
      'Включи их в Настройки → Сон и пробуждение… или задай "wake": { "enabled": true } в config.json доски',
    'setup.wake.crashed': 'Сон и пробуждение упали',
    'setup.wake.crashedFix': 'Настройки → Сон и пробуждение… → Запустить заново. Журнал: {file}',
    'setup.wake.held': 'Сессии усыпляет отдельный плагин herdr-wake',
    'setup.wake.heldFix': 'Настройки → Сон и пробуждение… → Переключиться…',
    'setup.wake.notAnswering': 'Сон и пробуждение включены, но не отвечают на порту {port}',
    'setup.wake.notAnsweringFix': 'Настройки → Сон и пробуждение… → Запустить. Журнал: {file}',
    'setup.wake.portTaken': 'Порт {port} занят другой программой',
    'setup.wake.portTakenFix': 'Задай другой "port" в разделе wake в config.json доски',
    'setup.wake.portRouter': 'Порт {port} держит роутер отдельного плагина herdr-wake (процесс {pid})',
    'setup.wake.portRouterFix':
      'Закрой панель роутера herdr-wake (процесс {pid}), затем Настройки → Сон и пробуждение… → Запустить заново',
    'setup.wake.urlUnused': 'wakeUrl в config.json не используется, пока сон и пробуждение включены',
    'setup.wake.starting': 'Сон и пробуждение запускаются',
    // wake's ListAgents and SendMessage hooks in each shown profile, while it is on and not held
    'setup.wake.hooks.ok': 'Хуки сна и пробуждения',
    'setup.wake.hooks.okDetail': 'ListAgents и SendMessage в {file}',
    'setup.wake.hooks.missing': 'Хуков сна и пробуждения нет',
    'setup.wake.hooks.without': 'Без них сессии не видят спящих в ListAgents, а SendMessage спящей сессии её не будит.',
    'setup.wake.hooks.old': 'Стоят хуки отдельного плагина herdr-wake',
    'setup.wake.hooks.oldDetail': 'Сессии здесь спрашивают отдельный плагин, а не пробуждение доски.',
    // Task 6.2: claude-tg
    'wake.launcher': 'Установить claude-tg',
    'wake.launcherDone': 'claude-tg теперь в {dir}',
    'err.launcherForeign':
      '{files}: не от доски и не от herdr-wake, поэтому оставлен как есть. Убери его и попробуй снова',
    // Task 7.2: Switch over…
    'wake.switchOver': 'Переключиться…',
    'wake.switchConfirm':
      'Перенести настройки и спящие сессии плагина herdr-wake, удалить его, заменить его хуки хуками доски во всех профилях, закрыть его рабочее пространство tg-router и запустить пробуждение доски?',
    'wake.switchGo': 'Переключиться',
    'wake.switched': 'Перенесено: {summary}',
    'wake.launcherNote':
      'herdr-wake будил сессии через {old}; доска запускает их через {now}. Чтобы оставить {old}, задай launch.claude в config.json доски.',
    'wake.bindings': 'Переименуй в config.toml herdr: {list}',
    // what was taken over, in wake.switched's {summary}: "reaper on, 60 min, 2 excluded; Telegram; 4 sleeping sessions"
    'wake.summary.reaperOn': 'усыпление вкл., через {min} мин',
    'wake.summary.reaperOff': 'усыпление выкл.',
    'wake.summary.excluded': ['{n} исключение', '{n} исключения', '{n} исключений'],
    'wake.summary.telegram': 'Телеграм',
    'wake.summary.asleep': ['{n} спящая сессия', '{n} спящие сессии', '{n} спящих сессий'],
    'err.switchOver': 'Переключение остановлено: {error}',
    'err.oldRouter':
      'Роутер плагина herdr-wake всё ещё отвечает на порту {port} (процесс {pid}): закрой его панель и нажми «Переключиться…» ещё раз',
    // the Telegram router's state while wake runs
    'wake.router.polling': 'Получает сообщения от {host}',
    'wake.router.error': 'Сообщения не приходят: {error}',
    'wake.router.off': 'Сообщения не получает',
    // the board's own wake named where herdr-wake was before (err.wakeDown, err.sleep.unknown, rename.alsoClaudeHint)
    'err.boardWakeDown': 'Пробуждение не ответило: {why}',
    'err.sleep.unknownToWake': 'пробуждение её не знает',
    'rename.alsoClaudeHintWake': 'Наберёт /rename в сессии; новое имя увидят другие сессии и пробуждение доски',
    // the takeover at wake's first start (the old plugin removed by hand): said until seen in the panel
    'wake.takenOver': [
      'При первом запуске пробуждение перенесло настройки отдельного плагина herdr-wake и {n} спящую сессию. Усыпление и Телеграм оставлены выключенными: включи их ниже, когда понадобятся.',
      'При первом запуске пробуждение перенесло настройки отдельного плагина herdr-wake и {n} спящие сессии. Усыпление и Телеграм оставлены выключенными: включи их ниже, когда понадобятся.',
      'При первом запуске пробуждение перенесло настройки отдельного плагина herdr-wake и {n} спящих сессий. Усыпление и Телеграм оставлены выключенными: включи их ниже, когда понадобятся.',
    ],
    'wake.takenOverSeen': 'Понятно',
    'setup.wake.takenOver': 'При первом запуске сон и пробуждение перенесли отдельный плагин herdr-wake',
    'setup.wake.takenOverDetail': [
      'Перенесены его настройки и {n} спящая сессия; усыпление и Телеграм оставлены выключенными.',
      'Перенесены его настройки и {n} спящие сессии; усыпление и Телеграм оставлены выключенными.',
      'Перенесены его настройки и {n} спящих сессий; усыпление и Телеграм оставлены выключенными.',
    ],
    'setup.wake.takenOverFix':
      'Включи их в Настройки → Сон и пробуждение…, когда понадобятся; это сообщение пропадёт, когда его там увидят.',
  },
}
