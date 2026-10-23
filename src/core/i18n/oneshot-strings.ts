// What the one command ("Do it myself", core/server-oneshot.ts) says on the server while it looks,
// asks and runs, in English and Russian; strings.ts merges them into the dictionaries. The board
// writes them into the command in its own language when it makes the command.
import type { Lang } from '../types.ts'

export const ONESHOT_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'server.oneshot.looking': 'agent-board: looking at this server. Nothing changes until you say so.',
    'server.oneshot.root': 'agent-board: this needs root; it runs itself again with sudo.',
    'server.oneshot.noSudo': 'agent-board: run this as root (there is no sudo here). Nothing was changed.',
    'server.oneshot.missing': 'agent-board: {tool} is missing on this server. Nothing was changed.',
    'server.oneshot.found': 'Found:',
    'server.oneshot.plan': 'The plan:',
    'server.oneshot.notes': 'Good to know:',
    'server.oneshot.unchanged': 'Nothing has changed on this server yet.',
    'server.oneshot.ask': 'Go ahead? [y/N] ',
    'server.oneshot.no': 'Stopped: nothing was changed.',
    'server.oneshot.running': 'Running (if this window closes, the run goes on by itself on the server):',
    'server.oneshot.done': 'done: {address}',
    'server.oneshot.test': 'Now press Test connection on the board.',
    'server.oneshot.rolledBack':
      'Stopped: a step failed, and what the run had changed was rolled back (a finished Docker install stays).',
    'server.oneshot.rollbackFailed':
      'Stopped: a step failed and the rollback did not finish: what is left is named above. Paste the Undo command to remove it.',
    'server.oneshot.busy': 'Another run of the board is going on here: paste this again in a minute.',
    'server.oneshot.changed': 'The server changed after it was looked at: nothing was changed. Paste this again.',
    'server.oneshot.lost':
      'The run did not say how it ended: paste this again in a minute (it sees what the run left).',
    'server.oneshot.stopHint': 'On the board, "Your server needs steps by hand" has the commands for such a server.',
    'server.oneshot.unreadable': 'Looking at this server did not work: nothing was changed.',
    'server.oneshot.refuse':
      'A name on this server ({what}) has a quote, a backslash, $ or a backquote, which this command does not take: nothing was changed. Use "Set up the server" on the board.',
    'server.oneshot.internal':
      'This command has no plan for what it found ({what}): nothing was changed. Use "Set up the server" on the board.',
    'server.oneshot.same': 'Set up already: {address}. Nothing to change.',
    'server.oneshot.interrupted':
      'A run of the board did not finish here: paste the Undo command first, then this one again.',
    'server.oneshot.unfinished':
      "The board's last run here ended as {state}: paste the Undo command first, then this one again.",
    'server.oneshot.inPlace': 'in place already',
    'server.oneshot.byHand': 'it stays: yours to remove by hand, if you want it gone',
    'server.oneshot.undid': 'rolled back',
    'server.oneshot.undoFailed': 'could not roll back',
    'server.oneshot.undo.looking': 'agent-board: looking at this server before Undo. Nothing changes until you say so.',
    'server.oneshot.undo.kept': 'Docker, and files of the board you changed since, stay.',
    'server.oneshot.undo.nothing': "Nothing of the board's is on this server.",
    'server.oneshot.undo.done': "undone: the board's setup is off this server.",
    'server.oneshot.undo.stop': 'Nothing was changed:',
    'server.oneshot.undo.unknown':
      'The record here names a setup this command does not know ({what}): nothing was changed. Undo it on the board (Set up the server, then Undo).',
  },
  ru: {
    'server.oneshot.looking': 'agent-board: осматриваю сервер. Ничего не меняется, пока вы не скажете.',
    'server.oneshot.root': 'agent-board: нужен root; команда запустит себя снова через sudo.',
    'server.oneshot.noSudo': 'agent-board: запустите это от root (sudo здесь нет). Ничего не изменено.',
    'server.oneshot.missing': 'agent-board: на сервере нет {tool}. Ничего не изменено.',
    'server.oneshot.found': 'Найдено:',
    'server.oneshot.plan': 'План:',
    'server.oneshot.notes': 'Полезно знать:',
    'server.oneshot.unchanged': 'На сервере пока ничего не изменено.',
    'server.oneshot.ask': 'Продолжить? [y/N] ',
    'server.oneshot.no': 'Остановлено: ничего не изменено.',
    'server.oneshot.running': 'Выполняется (если это окно закроется, запуск продолжится на сервере сам):',
    'server.oneshot.done': 'готово: {address}',
    'server.oneshot.test': 'Теперь нажмите на доске «Проверить соединение».',
    'server.oneshot.rolledBack':
      'Остановлено: шаг не удался, и всё, что запуск изменил, откачено (законченная установка Docker остаётся).',
    'server.oneshot.rollbackFailed':
      'Остановлено: шаг не удался, и откат не завершился: что осталось, названо выше. Вставьте команду отмены, чтобы убрать это.',
    'server.oneshot.busy': 'Здесь идёт другой запуск доски: вставьте это снова через минуту.',
    'server.oneshot.changed': 'Сервер изменился после осмотра: ничего не изменено. Вставьте это снова.',
    'server.oneshot.lost':
      'Запуск не сообщил, чем закончился: вставьте это снова через минуту (команда увидит, что он оставил).',
    'server.oneshot.stopHint': 'На доске в «Вашему серверу нужны шаги вручную» есть команды для такого сервера.',
    'server.oneshot.unreadable': 'Осмотреть сервер не удалось: ничего не изменено.',
    'server.oneshot.refuse':
      'В имени на сервере ({what}) есть кавычка, обратная косая черта, $ или обратная кавычка, их эта команда не принимает: ничего не изменено. Используйте «Настроить сервер» на доске.',
    'server.oneshot.internal':
      'У команды нет плана для найденного ({what}): ничего не изменено. Используйте «Настроить сервер» на доске.',
    'server.oneshot.same': 'Уже настроено: {address}. Менять нечего.',
    'server.oneshot.interrupted': 'Запуск доски здесь не завершился: сначала вставьте команду отмены, потом снова эту.',
    'server.oneshot.unfinished':
      'Последний запуск доски здесь закончился как {state}: сначала вставьте команду отмены, потом снова эту.',
    'server.oneshot.inPlace': 'уже на месте',
    'server.oneshot.byHand': 'остаётся: убрать это можно вручную, если нужно',
    'server.oneshot.undid': 'откачено',
    'server.oneshot.undoFailed': 'не удалось откатить',
    'server.oneshot.undo.looking':
      'agent-board: осматриваю сервер перед отменой. Ничего не меняется, пока вы не скажете.',
    'server.oneshot.undo.kept': 'Docker и файлы доски, которые вы с тех пор меняли, остаются.',
    'server.oneshot.undo.nothing': 'Ничего от доски на этом сервере нет.',
    'server.oneshot.undo.done': 'отменено: настройки доски на сервере больше нет.',
    'server.oneshot.undo.stop': 'Ничего не изменено:',
    'server.oneshot.undo.unknown':
      'Запись здесь называет настройку, которую эта команда не знает ({what}): ничего не изменено. Отмените её на доске («Настроить сервер», затем «Отменить»).',
  },
}
