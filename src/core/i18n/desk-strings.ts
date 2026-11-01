// Texts of an agent's own browser as the web board shows it (its card's mark, the session panel's
// Browser fold, full size), merged into the board's dictionaries by strings.ts (same rules:
// {name} placeholders, arrays are plural forms).

import type { Lang } from '../types.ts'

export const DESK_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    // the card
    'desk.mark': 'Its browser is running: open it',
    'desk.openIt': 'Open its browser',
    // what it asks to be done in its browser, in the question's place (the card; the panel's "needs you")
    'desk.askLabel': 'In its browser',
    'desk.askWhy': 'IN ITS BROWSER',
    // the fold and full size
    'desk.title': 'Browser',
    'desk.meter':
      'Round trip to the server · frames a second · how the picture comes: h264 video, or VNC with its JPEG quality (0–9)',
    'desk.agent': 'The agent has control',
    'desk.you': 'You have control',
    'desk.take': 'Take control',
    'desk.takeHint':
      'Your mouse and keys go to its browser and its own actions wait. The agent can see what you type there.',
    'desk.give': 'Give back',
    'desk.warn': 'The agent can see what you type into its browser.',
    // the clipboard both ways while the owner has it
    'desk.paste': 'Paste',
    'desk.pasteHint': 'Your clipboard into its browser, where its cursor is',
    'desk.pasteFailed': 'Could not read your clipboard: {why}',
    'desk.pasteDenied':
      'The browser does not let the board read your clipboard. Allow the clipboard in this site’s settings (the icon left of the address), or press Ctrl+V (Cmd+V on a Mac or an iPad) on the picture.',
    'desk.copied': 'Copied in its browser — tap to copy it to yours',
    'desk.copiedDone': 'Copied to your clipboard',
    'desk.copyFailed': 'Could not copy it: {why}',
    'desk.full': 'Full size',
    'desk.back': 'Back to the panel (Esc)',
    'desk.close': 'Close the view (its browser keeps running)',
    'desk.shownFull': 'Shown full size',
    // the conversation beside it full size
    'desk.chat': 'Chat',
    'desk.chatHint': 'The conversation with the agent beside its browser',
    'desk.chatBottom': 'Chat at the bottom',
    'desk.chatRight': 'Chat on the right',
    'desk.chatEdge': 'Chat size',
    // what the agent asks the owner to do in it (browser_ask_owner), folded or open, and full size
    'desk.asks': 'The agent asks you',
    // the connection
    'desk.connecting': 'Connecting to its browser…',
    'desk.closed': 'Its browser closed the view',
    'desk.unreachable': 'Its browser did not answer',
    'desk.failed': 'Could not show its browser: {why}',
    'desk.why.protocol': 'what answered is not its display',
    'desk.why.security': 'its display asks for a password',
    'desk.why.data': 'its display sent what the board cannot draw ({what})',
  },
  ru: {
    'desk.mark': 'Его браузер запущен: открыть',
    'desk.openIt': 'Открыть его браузер',
    'desk.askLabel': 'В его браузере',
    'desk.askWhy': 'В ЕГО БРАУЗЕРЕ',
    'desk.title': 'Браузер',
    'desk.meter':
      'Задержка до сервера и обратно · кадров в секунду · как идёт картинка: видео h264 или VNC с качеством JPEG (0–9)',
    'desk.agent': 'Управляет агент',
    'desk.you': 'Управляете вы',
    'desk.take': 'Взять управление',
    'desk.takeHint':
      'Мышь и клавиши идут в его браузер, а его собственные действия ждут. Агент видит, что вы там вводите.',
    'desk.give': 'Вернуть',
    'desk.warn': 'Агент видит, что вы вводите в его браузер.',
    'desk.paste': 'Вставить',
    'desk.pasteHint': 'Ваш буфер обмена в его браузер, туда, где курсор',
    'desk.pasteFailed': 'Не удалось прочитать ваш буфер обмена: {why}',
    'desk.pasteDenied':
      'Браузер не даёт доске прочитать ваш буфер обмена. Разрешите буфер обмена в настройках этого сайта (значок слева от адреса) или нажмите Ctrl+V (Cmd+V на Mac и iPad) на картинке.',
    'desk.copied': 'Скопировано в его браузере — нажмите, чтобы скопировать к себе',
    'desk.copiedDone': 'Скопировано в ваш буфер обмена',
    'desk.copyFailed': 'Не удалось скопировать: {why}',
    'desk.full': 'Во весь экран',
    'desk.back': 'Обратно в панель (Esc)',
    'desk.close': 'Закрыть показ (сам браузер продолжит работать)',
    'desk.shownFull': 'Показан во весь экран',
    'desk.chat': 'Чат',
    'desk.chatHint': 'Разговор с агентом рядом с его браузером',
    'desk.chatBottom': 'Чат снизу',
    'desk.chatRight': 'Чат справа',
    'desk.chatEdge': 'Размер чата',
    'desk.asks': 'Агент просит вас',
    'desk.connecting': 'Подключение к его браузеру…',
    'desk.closed': 'Его браузер закрыл показ',
    'desk.unreachable': 'Его браузер не ответил',
    'desk.failed': 'Не удалось показать его браузер: {why}',
    'desk.why.protocol': 'ответил не его экран',
    'desk.why.security': 'его экран просит пароль',
    'desk.why.data': 'его экран прислал то, что доска не умеет рисовать ({what})',
  },
}
