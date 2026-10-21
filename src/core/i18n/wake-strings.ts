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
    'err.wakeSetting': '{field}: {why}',
    // Task 4.6: the panel and the toolbar note
    'wake.stopped': 'Wake stopped',
    'wake.stoppedHint': 'Sleep and wake is on but not running: open its settings',
    'wake.readOnly': 'Changed on the computer only',
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
    'setup.wake.urlUnused': 'wakeUrl in config.json is not used while Sleep and wake is on',
    // Task 6.2: claude-tg
    // Task 7.2: Switch over…
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
    'err.wakeSetting': '{field}: {why}',
    // Task 4.6: the panel and the toolbar note
    'wake.stopped': 'Пробуждение остановлено',
    'wake.stoppedHint': 'Сон и пробуждение включены, но не работают: открой их настройки',
    'wake.readOnly': 'Меняется только на компьютере',
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
    'setup.wake.urlUnused': 'wakeUrl в config.json не используется, пока сон и пробуждение включены',
    // Task 6.2: claude-tg
    // Task 7.2: Switch over…
  },
}
