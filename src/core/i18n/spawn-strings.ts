// The texts of agent starts' limits (#815, core/spawn-limits.ts): Settings → Board & Agents, the
// question a refused start puts on its session's card, and the refusal of POST /api/settings.
// English and Russian; strings.ts merges them into the dictionaries.
import type { Lang } from '../types.ts'

export const SPAWN_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'set.spawn': 'Agent starts',
    'set.spawn.note':
      'Whether sessions on this computer may start sessions, and how many. Your own starts are never limited.',
    'set.spawn.children': 'Running at once, per session',
    'set.spawn.depth': 'Levels of starts below yours',
    'set.spawn.perHour': 'Starts per session in an hour',
    'set.spawn.none': 'No limit',
    'spawn.ask.agents':
      'Wants to start "{name}", but sessions on this computer may not start sessions (Settings → Board & Agents)',
    'spawn.ask.children': [
      'Wants to start "{name}": {n} session it started still runs, the limit is {limit} (Settings → Board & Agents)',
      'Wants to start "{name}": {n} sessions it started still run, the limit is {limit} (Settings → Board & Agents)',
    ],
    'spawn.ask.depth':
      'Wants to start "{name}", which would be {n} levels of starts deep, the limit is {limit} (Settings → Board & Agents)',
    'spawn.ask.perHour': [
      'Wants to start "{name}": it started {n} session in the last hour, the limit is {limit} (Settings → Board & Agents)',
      'Wants to start "{name}": it started {n} sessions in the last hour, the limit is {limit} (Settings → Board & Agents)',
    ],
    'err.spawnLimitsLocal': 'Agent starts are set on the computer itself, not from another device',
    'err.spawnLimits': 'Agent starts: a limit is a whole number from 0 (no limit) to 1000, and "agents" is on or off',
  },
  ru: {
    'set.spawn': 'Запуски агентов',
    'set.spawn.note':
      'Могут ли сессии на этом компьютере запускать сессии и сколько. Ваши собственные запуски не ограничиваются.',
    'set.spawn.children': 'Одновременно от одной сессии',
    'set.spawn.depth': 'Уровней запусков ниже ваших',
    'set.spawn.perHour': 'Запусков от сессии за час',
    'set.spawn.none': 'Без лимита',
    'spawn.ask.agents':
      'Хочет запустить «{name}», но сессиям на этом компьютере запускать сессии нельзя (Настройки → Доска и агенты)',
    'spawn.ask.children': [
      'Хочет запустить «{name}»: уже работает {n} запущенная ею сессия, лимит {limit} (Настройки → Доска и агенты)',
      'Хочет запустить «{name}»: уже работают {n} запущенные ею сессии, лимит {limit} (Настройки → Доска и агенты)',
      'Хочет запустить «{name}»: уже работают {n} запущенных ею сессий, лимит {limit} (Настройки → Доска и агенты)',
    ],
    'spawn.ask.depth':
      'Хочет запустить «{name}», это был бы {n}-й уровень запусков, лимит {limit} (Настройки → Доска и агенты)',
    'spawn.ask.perHour': [
      'Хочет запустить «{name}»: за последний час она запустила {n} сессию, лимит {limit} (Настройки → Доска и агенты)',
      'Хочет запустить «{name}»: за последний час она запустила {n} сессии, лимит {limit} (Настройки → Доска и агенты)',
      'Хочет запустить «{name}»: за последний час она запустила {n} сессий, лимит {limit} (Настройки → Доска и агенты)',
    ],
    'err.spawnLimitsLocal': 'Запуски агентов настраиваются на самом компьютере, не с другого устройства',
    'err.spawnLimits':
      'Запуски агентов: лимит это целое число от 0 (без лимита) до 1000, а "agents" включено или выключено',
  },
}
