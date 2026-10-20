// Texts of a side question to a session (/btw from the board), merged into the board's
// dictionaries by strings.ts (same rules: {name} placeholders, arrays are plural forms).

import type { Lang } from '../types.ts'

export const ASIDE_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    // the composer's switch
    'aside.toggle': 'Ask aside',
    'aside.toggleHint':
      'A side question, as /btw: answered from this conversation in a request of its own, and nothing goes into the conversation. A message that starts with /btw goes aside too',
    'aside.placeholder': 'Ask aside: the answer stays out of the conversation',
    // its cards
    'aside.label': 'Aside',
    'aside.asking': 'Asking a copy of the conversation…',
    'aside.cancel': 'Cancel',
    'aside.close': 'Close',
    'aside.again': 'Ask again',
    'aside.cost': 'a request of its own · ≈ {cost}',
    'aside.costNone': 'a request of its own',
    'aside.tokens': '{n}k tokens of context',
    'aside.cached': '{n}k from the cache',
    'aside.seconds': '{s} s',
    'aside.costHint':
      'Asked of a copy of the conversation, with no tools: the session knows nothing of it. The price is Claude Code’s own figure at API rates',
    // why there is no answer
    'aside.err.empty': 'Type the question first',
    'aside.err.long': 'A side question is up to {n} characters',
    'aside.err.notClaude': 'Only a Claude session with an id can be asked aside, and “{name}” is not one',
    'aside.err.noTranscript': '“{name}” has no conversation on this computer yet',
    'aside.err.noClaude': 'Claude Code (claude) is not on the board’s PATH',
    'aside.err.timeout': 'No answer in {s} s',
    'aside.err.cancelled': 'Cancelled',
    'aside.err.none': 'Claude gave no answer',
  },
  ru: {
    'aside.toggle': 'Спросить в сторонке',
    'aside.toggleHint':
      'Вопрос в сторонке, как /btw: ответ по этой переписке отдельным запросом, в саму переписку ничего не попадёт. Сообщение, начатое с /btw, тоже уходит в сторонку',
    'aside.placeholder': 'Спросить в сторонке: ответ не попадёт в переписку',
    'aside.label': 'В сторонке',
    'aside.asking': 'Спрашиваю копию переписки…',
    'aside.cancel': 'Отменить',
    'aside.close': 'Закрыть',
    'aside.again': 'Спросить ещё раз',
    'aside.cost': 'отдельный запрос · ≈ {cost}',
    'aside.costNone': 'отдельный запрос',
    'aside.tokens': '{n}k токенов контекста',
    'aside.cached': '{n}k из кэша',
    'aside.seconds': '{s} с',
    'aside.costHint':
      'Спрошено у копии переписки, без инструментов: сама сессия о вопросе не знает. Цена: оценка Claude Code по тарифам API',
    'aside.err.empty': 'Сначала напиши вопрос',
    'aside.err.long': 'Вопрос в сторонке: не больше {n} символов',
    'aside.err.notClaude': 'В сторонке можно спросить только сессию Claude с id, а «{name}» не такая',
    'aside.err.noTranscript': 'У «{name}» пока нет переписки на этом компьютере',
    'aside.err.noClaude': 'Claude Code (claude) не найден в PATH доски',
    'aside.err.timeout': 'Ответа нет за {s} с',
    'aside.err.cancelled': 'Отменено',
    'aside.err.none': 'Claude не ответил',
  },
}
