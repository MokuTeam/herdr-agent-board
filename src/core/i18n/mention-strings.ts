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
    'team.exposedAbout':
      'Every session in a lane you share with a teammate, with Agents on for them, is in their list by its handle. It leaves the list when it leaves the lane, is archived, or the lane is no longer shared.',
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
      'Каждая сессия в полосе, открытой коллеге (с включёнными для него агентами), есть в его списке по своему имени. Она пропадает из списка, когда уходит из полосы, архивируется или полоса закрывается.',
    'team.exposeReaches': 'Доступен: {names}',
    'team.err.agent': 'такого агента нет в их списке',
    'team.mentionNone':
      'Пока не к кому обратиться: вам не открыта ни одна их категория с агентами, или их доске нужно обновление',
    'team.mentionNoneLane': 'Пока не к кому обратиться: вам не открыта ни одна их категория с агентами',
    'team.mentionNoneKey': 'Их ключ изменился: сначала доверьтесь новому ключу',
  },
}
