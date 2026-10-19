// Texts of the archive (sessions taken off the board), merged into the board's dictionaries by
// strings.ts (same rules: {name} placeholders, arrays are plural forms).

import type { Lang } from '../types.ts'

export const ARCHIVE_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    // where it opens from
    'archive.menu': 'Archive',
    'archive.sheetHint':
      'Take it off the board: its tab in herdr closes, Claude keeps the conversation. Return brings it back',
    'archive.open': 'Archive',
    'archive.openHint': 'Archive: sessions taken off the board, to find and bring back',
    'archive.menuOpen': 'Archive…',

    // why a session cannot go now
    'archive.why.starting': 'It is still starting',
    'archive.why.notClaude': 'Only a Claude session can come back from the archive',
    'archive.why.noPane': 'It has no pane in herdr',
    'archive.why.working': 'It is working; it can go once its turn is over',
    'archive.why.dialog': 'A dialog waits in its terminal',
    'archive.why.helpers': 'Its helpers are at work',
    'archive.why.restarting': 'It is restarting',
    'archive.why.report': 'A MokuPilot call report waits to go into it',
    'archive.why.draft': 'Text you started typing waits in its input box',
    'archive.why.tasks': 'A background command or Monitor runs in it',
    'archive.why.gone': 'Another session runs in its pane now',
    'archive.why.exited': 'It no longer runs in its pane',
    'archive.why.shellBusy': 'Something else runs in its pane now',
    'archive.why.herdr': 'herdr did not answer ({why})',
    'archive.why.already': 'It is in the archive already',

    // toasts
    'archive.done': '“{name}” archived',
    'archive.doneHeld': [
      '“{name}” archived, its reminder waits with it',
      '“{name}” archived, its {n} reminders wait with it',
    ],
    'archive.doneMany': ['{n} session archived', '{n} sessions archived'],
    'archive.stayed': ['{n} stayed on the board: {why}', '{n} stayed on the board, e.g.: {why}'],
    'archive.return': 'Return',
    'archive.back': '“{name}” is back',
    'archive.backMany': ['{n} session is back', '{n} sessions are back'],
    'archive.resuming': '“{name}” comes back in a new tab',
    'archive.resumingMany': ['{n} session comes back in a new tab', '{n} sessions come back in new tabs'],
    'archive.kept': '“{name}” stayed on the board: {why}',
    'archive.removed': '“{name}” removed from the archive',

    // the panel
    'archive.title': 'Archive',
    'archive.about':
      'Sessions taken off the board. Claude keeps their conversations: Return resumes one in a new herdr tab, with its name, lane and card.',
    'archive.search': 'Search the archive',
    'archive.empty': 'Nothing in the archive',
    'archive.emptyHint':
      '“Archive” in a card’s menu takes a session off the board; the menu of the “Idle” column takes the sleeping ones.',
    'archive.noMatch': 'Nothing found',
    'archive.held': ['{n} reminder', '{n} reminders'],
    'archive.heldHint': 'Its reminders wait with it and come back with it',
    'archive.returning': 'Returning…',
    'archive.returnHint': 'Resume it in a new herdr tab, with its name, lane and card',
    'archive.remove': 'Remove from the archive',
    'archive.removeConfirm': 'Remove?',
    'archive.removeHint':
      'Remove from the archive: the record, its card and its reminders go. Claude keeps the conversation',
    'archive.by': 'by {name}',

    // tidying up the sleeping ones
    'archive.tidy.menu': 'Archive the sleeping ones',
    'archive.tidy.days': ['Asleep over {n} day', 'Asleep over {n} days'],
    'archive.tidy.week': 'Asleep over a week',
    'archive.tidy.all': 'All sleeping ones',
    'archive.tidy.none': 'No session sleeps in “Idle”',
    'archive.tidy.suggest': [
      '{n} session in “Idle” has slept for over 3 days',
      '{n} sessions in “Idle” have slept for over 3 days',
    ],
    'archive.tidy.go': 'Archive them',

    // a session on its way back
    'archive.returnLabel': 'back',
    'archive.step': 'Resuming the conversation…',

    // errors
    'archive.err.gone': 'It is not in the archive any more',
    'archive.err.busy': 'Its tab is closing right now: try again in a moment',
    'archive.err.closing': 'Its tab closes in a moment: Return it now, or remove it once it is closed',
    'archive.err.noTranscript': '“{name}” cannot come back: its conversation is not on this computer any more',
    'archive.err.herdr': 'herdr did not answer ({why})',
    'archive.err.cannotResume':
      'The board starts sessions with launch.agent here, and its arguments pick the session: it cannot resume one that way',
  },
  ru: {
    'archive.menu': 'В архив',
    'archive.sheetHint':
      'Убрать с доски: вкладка в herdr закроется, переписку хранит Claude. «Вернуть» поднимет сессию снова',
    'archive.open': 'Архив',
    'archive.openHint': 'Архив: убранные с доски сессии, найти и вернуть',
    'archive.menuOpen': 'Архив…',

    'archive.why.starting': 'Ещё запускается',
    'archive.why.notClaude': 'Из архива возвращается только сессия Claude',
    'archive.why.noPane': 'У неё нет панели в herdr',
    'archive.why.working': 'Работает; убрать можно, когда закончит ход',
    'archive.why.dialog': 'В её терминале открыт диалог',
    'archive.why.helpers': 'Работают её помощники',
    'archive.why.restarting': 'Перезапускается',
    'archive.why.report': 'Её ждёт отчёт звонка MokuPilot',
    'archive.why.draft': 'В её поле ввода недописанный текст',
    'archive.why.tasks': 'В ней идёт фоновая команда или Monitor',
    'archive.why.gone': 'В её панели теперь другая сессия',
    'archive.why.exited': 'Она больше не работает в своей панели',
    'archive.why.shellBusy': 'В её панели теперь работает что-то другое',
    'archive.why.herdr': 'herdr не ответил ({why})',
    'archive.why.already': 'Она уже в архиве',

    'archive.done': '«{name}» в архиве',
    'archive.doneHeld': [
      '«{name}» в архиве, её напоминание ждёт с ней',
      '«{name}» в архиве, {n} напоминания ждут с ней',
      '«{name}» в архиве, {n} напоминаний ждут с ней',
    ],
    'archive.doneMany': ['{n} сессия в архиве', '{n} сессии в архиве', '{n} сессий в архиве'],
    'archive.stayed': [
      '{n} осталась на доске: {why}',
      '{n} остались на доске, например: {why}',
      '{n} остались на доске, например: {why}',
    ],
    'archive.return': 'Вернуть',
    'archive.back': '«{name}» снова на доске',
    'archive.backMany': ['{n} сессия снова на доске', '{n} сессии снова на доске', '{n} сессий снова на доске'],
    'archive.resuming': '«{name}» возвращается в новой вкладке',
    'archive.resumingMany': [
      '{n} сессия возвращается в новой вкладке',
      '{n} сессии возвращаются в новых вкладках',
      '{n} сессий возвращаются в новых вкладках',
    ],
    'archive.kept': '«{name}» осталась на доске: {why}',
    'archive.removed': '«{name}» убрана из архива',

    'archive.title': 'Архив',
    'archive.about':
      'Сессии, убранные с доски. Переписку хранит Claude: «Вернуть» продолжит сессию в новой вкладке herdr, с прежним именем, полосой и карточкой.',
    'archive.search': 'Поиск по архиву',
    'archive.empty': 'В архиве пусто',
    'archive.emptyHint': '«В архив» в меню карточки убирает сессию с доски; меню колонки «Простой» убирает спящие.',
    'archive.noMatch': 'Ничего не нашлось',
    'archive.held': ['{n} напоминание', '{n} напоминания', '{n} напоминаний'],
    'archive.heldHint': 'Её напоминания ждут с ней и вернутся вместе с ней',
    'archive.returning': 'Возвращается…',
    'archive.returnHint': 'Продолжить сессию в новой вкладке herdr, с прежним именем, полосой и карточкой',
    'archive.remove': 'Убрать из архива',
    'archive.removeConfirm': 'Убрать?',
    'archive.removeHint': 'Убрать из архива: запись, карточка и напоминания удалятся. Переписку хранит Claude',
    'archive.by': 'убрала {name}',

    'archive.tidy.menu': 'Убрать спящие в архив',
    'archive.tidy.days': ['Спят больше {n} дня', 'Спят больше {n} дней', 'Спят больше {n} дней'],
    'archive.tidy.week': 'Спят больше недели',
    'archive.tidy.all': 'Все спящие',
    'archive.tidy.none': 'В «Простое» нет спящих сессий',
    'archive.tidy.suggest': [
      '{n} сессия в «Простое» спит больше 3 дней',
      '{n} сессии в «Простое» спят больше 3 дней',
      '{n} сессий в «Простое» спят больше 3 дней',
    ],
    'archive.tidy.go': 'Убрать в архив',

    'archive.returnLabel': 'возврат',
    'archive.step': 'Продолжаю переписку…',

    'archive.err.gone': 'Её уже нет в архиве',
    'archive.err.busy': 'Её вкладка как раз закрывается: попробуй чуть позже',
    'archive.err.closing': 'Её вкладка вот-вот закроется: верни её сейчас или убери, когда закроется',
    'archive.err.noTranscript': '«{name}» не вернуть: её переписки больше нет на этом компьютере',
    'archive.err.herdr': 'herdr не ответил ({why})',
    'archive.err.cannotResume':
      'Здесь доска запускает сессии через launch.agent, и его аргументы сами выбирают сессию: так её не продолжить',
  },
}
