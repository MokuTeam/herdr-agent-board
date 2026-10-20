// Texts of a fork of a session (a new session with a copy of its conversation), merged into the
// board's dictionaries by strings.ts (same rules: {name} placeholders, arrays are plural forms).

import type { Lang } from '../types.ts'

export const FORK_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    // a fork's default name: "<name> · fork"
    'fork.mark': 'fork',
    // where it opens from: the sheet's button, the card's menu
    'fork.action': 'Fork',
    'fork.menu': 'Fork…',
    'fork.hint': 'A new session in a new tab with a copy of this conversation; this one goes on as it is',
    // the window
    'fork.title': 'Fork “{name}”',
    'fork.about': 'A new session in a new tab with a copy of this conversation: same folder, lane and workspace.',
    'fork.stays': 'This session goes on as it is.',
    'fork.name': 'Name',
    'fork.note': 'Message',
    'fork.notePlaceholder': 'Optional: the fork’s first message',
    'fork.start': 'Fork',
    'fork.cancel': 'Cancel',
    // how it went
    'fork.started': 'Fork of “{name}” is starting: “{fork}”',
    'fork.label': 'fork',
    // why it cannot be forked
    'fork.err.notClaude': 'Only a Claude session with an id can be forked, and “{name}” is not one',
    'fork.err.noTranscript': 'The conversation of {session} is not on this computer: there is nothing to fork',
    'fork.err.herdr': 'herdr did not list its workspaces: {why}',
    'fork.err.launcher':
      'The board starts sessions with launch.agent here, and it is not Claude or its arguments pick the session: it cannot fork one that way',
    // links between sessions
    'rel.forkOfHint': 'A fork of {name}: it started with a copy of its conversation. Click to open it',
    'rel.forkedThis': 'A fork of this session',
  },
  ru: {
    'fork.mark': 'форк',
    'fork.action': 'Форк',
    'fork.menu': 'Форк…',
    'fork.hint': 'Новая сессия в новой вкладке с копией этой переписки; эта остаётся как есть',
    'fork.title': 'Форк «{name}»',
    'fork.about': 'Новая сессия в новой вкладке с копией этой переписки: та же папка, полоса и рабочее пространство.',
    'fork.stays': 'Эта сессия остаётся как есть.',
    'fork.name': 'Имя',
    'fork.note': 'Сообщение',
    'fork.notePlaceholder': 'Необязательно: первое сообщение форку',
    'fork.start': 'Форк',
    'fork.cancel': 'Отмена',
    'fork.started': 'Форк «{name}» запускается: «{fork}»',
    'fork.label': 'форк',
    'fork.err.notClaude': 'Форк можно сделать только у сессии Claude с id, а «{name}» не такая',
    'fork.err.noTranscript': 'Переписки {session} нет на этом компьютере: форкать нечего',
    'fork.err.herdr': 'herdr не отдал список рабочих пространств: {why}',
    'fork.err.launcher':
      'Здесь доска запускает сессии через launch.agent, а он не Claude или его аргументы сами выбирают сессию: так форк не сделать',
    'rel.forkOfHint': 'Форк сессии {name}: начат с копии её переписки. Щелчок откроет её',
    'rel.forkedThis': 'Форк этой сессии',
  },
}
