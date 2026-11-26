// The texts of addressing a peer's agent (#832): the composer's list after `@`, and what teammates
// can address in People and agents. strings.ts merges them into the dictionaries.
import type { Lang } from '../types.ts'

export const MENTION_STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    'team.mentions': 'Agents you can address',
    'team.mentionPeople': 'Teammates',
    'team.exposed': 'Agents teammates can address',
    'team.publishAlias': 'Published alias',
    'team.saveAlias': 'Save alias',
    'team.exposedAbout': 'Teammates can reach agents only in lanes shared with them and with Agents on.',
    'team.exposureMode': 'Peers can reach',
    'team.exposureAll': 'Every agent in shared lanes',
    'team.exposureMasters': 'Only masters in shared lanes',
    'team.masterCard': 'Session to mark as master',
    'team.pickMasterCard': 'Select a session',
    'team.markMaster': 'Mark as master',
    'team.unmarkMaster': 'Remove master flag',
    'team.confirm.markMaster': 'Mark {name} as master',
    'team.exposeReaches': 'Reached by {names}',
    'team.err.agent': 'that agent is not in their list',
    'team.mentionNone':
      'No agents to address yet: they share no lane with you with Agents on, or their board needs the update',
    'team.mentionNoneLane': 'No agents to address yet: they share no lane with you with Agents on',
    'team.mentionNoneKey': 'Their key changed: trust the new key first',
  },
  ru: {
    'team.mentions': 'Агенты, к которым можно обратиться',
    'team.mentionPeople': 'Коллеги',
    'team.exposed': 'Агенты, к которым могут обратиться коллеги',
    'team.publishAlias': 'Публичный псевдоним',
    'team.saveAlias': 'Сохранить псевдоним',
    'team.exposedAbout':
      'Коллеги могут обращаться к агентам в открытых для них категориях, если для них включены агенты.',
    'team.exposureMode': 'К кому могут обратиться коллеги',
    'team.exposureAll': 'Все агенты в открытых категориях',
    'team.exposureMasters': 'Только мастера в открытых категориях',
    'team.masterCard': 'Сессия для отметки мастера',
    'team.pickMasterCard': 'Выбрать сессию',
    'team.markMaster': 'Отметить мастером',
    'team.unmarkMaster': 'Снять отметку мастера',
    'team.confirm.markMaster': 'Отметить {name} мастером',
    'team.exposeReaches': 'Доступен: {names}',
    'team.err.agent': 'такого агента нет в их списке',
    'team.mentionNone':
      'Пока не к кому обратиться: вам не открыта ни одна их категория с агентами, или их доске нужно обновление',
    'team.mentionNoneLane': 'Пока не к кому обратиться: вам не открыта ни одна их категория с агентами',
    'team.mentionNoneKey': 'Их ключ изменился: сначала доверьтесь новому ключу',
  },
}
