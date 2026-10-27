// Texts of a side question to a session (/btw from the board), merged into the board's
// dictionaries by strings.ts (same rules: {name} placeholders, arrays are plural forms).

import type { Lang } from '../types.ts'

export const ASIDE_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    // the composer's switch
    'aside.toggle': 'Ask aside',
    'aside.toggleHint':
      'A side question: typed into the session as Claude Code’s /btw, answered from its conversation with no tools, and nothing goes into the conversation. A message that starts with /btw goes aside too',
    'aside.placeholder': 'Ask aside: the answer stays out of the conversation',
    // its cards
    'aside.label': 'Aside',
    'aside.asking': 'Asking the session with /btw…',
    'aside.cancel': 'Cancel',
    'aside.close': 'Close',
    'aside.again': 'Ask again',
    'aside.via': 'asked with /btw',
    'aside.seconds': '{s} s',
    'aside.viaHint':
      'Typed into the session as /btw and read off its screen: Claude Code answers it apart from the conversation and keeps nothing of it. Lists and code come back as the terminal showed them',
    // why there is no answer
    'aside.err.empty': 'Type the question first',
    'aside.err.long': 'A side question is up to {n} characters',
    'aside.err.notClaude': 'Only a Claude session with an id can be asked aside, and “{name}” is not one',
    'aside.err.asleep': '“{name}” is asleep: /btw needs the running session. Wake it first',
    'aside.err.already': '“{name}” is already answering a side question',
    'aside.err.covered': '“{name}” has a dialog or an overlay open in the terminal: /btw would land in it',
    'aside.err.noOverlay':
      '“{name}” did not open /btw: its Claude Code may be older than /btw, or the line went somewhere else. Look at the terminal',
    'aside.err.lost':
      'The /btw answer of “{name}” went off the screen before it was read: someone pressed a key in the terminal?',
    'aside.err.herdr': 'Could not ask “{name}” through herdr: {why}',
    'aside.err.timeout': 'No answer in {s} s',
    'aside.err.cancelled': 'Cancelled',
    'aside.err.none': 'Claude gave no answer',
  },
  ru: {
    'aside.toggle': 'Спросить в сторонке',
    'aside.toggleHint':
      'Вопрос в сторонке: набирается в сессии как /btw Claude Code, ответ по её переписке без инструментов, в саму переписку ничего не попадёт. Сообщение, начатое с /btw, тоже уходит в сторонку',
    'aside.placeholder': 'Спросить в сторонке: ответ не попадёт в переписку',
    'aside.label': 'В сторонке',
    'aside.asking': 'Спрашиваю сессию через /btw…',
    'aside.cancel': 'Отменить',
    'aside.close': 'Закрыть',
    'aside.again': 'Спросить ещё раз',
    'aside.via': 'спрошено через /btw',
    'aside.seconds': '{s} с',
    'aside.viaHint':
      'Набрано в сессии как /btw и прочитано с её экрана: Claude Code отвечает в стороне от переписки и ничего из этого не сохраняет. Списки и код приходят такими, какими их показал терминал',
    'aside.err.empty': 'Сначала напиши вопрос',
    'aside.err.long': 'Вопрос в сторонке: не больше {n} символов',
    'aside.err.notClaude': 'В сторонке можно спросить только сессию Claude с id, а «{name}» не такая',
    'aside.err.asleep': '«{name}» спит: /btw нужна запущенная сессия. Сначала разбуди её',
    'aside.err.already': '«{name}» уже отвечает на вопрос в сторонке',
    'aside.err.covered': 'У «{name}» в терминале открыт диалог или оверлей: /btw попал бы в него',
    'aside.err.noOverlay':
      'В «{name}» /btw не открылся: может быть, Claude Code там старше /btw, или строка ушла не туда. Загляни в терминал',
    'aside.err.lost':
      'Ответ /btw у «{name}» пропал с экрана раньше, чем его прочитали: кто-то нажал клавишу в терминале?',
    'aside.err.herdr': 'Не получилось спросить «{name}» через herdr: {why}',
    'aside.err.timeout': 'Ответа нет за {s} с',
    'aside.err.cancelled': 'Отменено',
    'aside.err.none': 'Claude не ответил',
  },
}
