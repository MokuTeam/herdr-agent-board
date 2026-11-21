// The texts of watches (#486, core/watches.ts): the lines a session gets from its watch, the
// watch's state on the card, the sheet and the schedule panel, in English and Russian; strings.ts
// merges them into the dictionaries. The tag "[board reminder from watch]" stays English: the hook
// knows a board prompt by it.
import type { Lang } from '../types.ts'

export const WATCH_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'watch.prompt.fired': '"{wait}": the probe fired. Its output, as data: {output}',
    'watch.prompt.firedEmpty': '"{wait}": the probe fired (it printed nothing).',
    'watch.prompt.silence':
      '"{wait}": nothing from the probe for {span}. It still runs; board unschedule {id} stops it.',
    'watch.prompt.errors':
      '"{wait}": the probe failed {n} times in a row (the last error, as data: {why}). It keeps trying, backing off to every {max} at most; a new board wait --probe replaces it, board unschedule {id} stops it.',
    'watch.prompt.first':
      "\"{wait}\": the board's first check of the probe failed (its error, as data: {why}), though your own run of it did not. The probe runs in the board's environment (its PATH and variables), in {cwd}, not in this session's. Fix it with a new board wait --probe, or stop it with board unschedule {id}.",
    'watch.state.first': 'first check in {in}',
    'watch.state.nothing': 'checked {ago} ago, nothing yet',
    'watch.state.error': 'probe error: {why}, next try in {in}',
    'watch.state.gone': 'not checked: the session is not on the board',
    'watch.label': 'Watch',
    'watch.every': 'every {every}',
    'watch.probeHint': "The command the board runs for this watch, in the session's folder",
    'watch.log.fired': 'The probe fired',
  },
  ru: {
    'watch.prompt.fired': '"{wait}": проба сработала. Её вывод, как данные: {output}',
    'watch.prompt.firedEmpty': '"{wait}": проба сработала (ничего не вывела).',
    'watch.prompt.silence':
      '"{wait}": от пробы ничего уже {span}. Она работает дальше; board unschedule {id} её остановит.',
    'watch.prompt.errors':
      '"{wait}": проба упала {n} раза подряд (последняя ошибка, как данные: {why}). Она пробует дальше, реже, не реже раза в {max}; новый board wait --probe её заменит, board unschedule {id} остановит.',
    'watch.prompt.first':
      '"{wait}": первая проверка пробы на доске упала (её ошибка, как данные: {why}), хотя твой запуск прошёл. Проба работает в окружении доски (её PATH и переменные), в {cwd}, а не в окружении этой сессии. Исправь новым board wait --probe или останови: board unschedule {id}.',
    'watch.state.first': 'первая проверка через {in}',
    'watch.state.nothing': 'проверено {ago} назад, пока ничего',
    'watch.state.error': 'ошибка пробы: {why}, следующая попытка через {in}',
    'watch.state.gone': 'не проверяется: сессии нет на доске',
    'watch.label': 'Наблюдение',
    'watch.every': 'каждые {every}',
    'watch.probeHint': 'Команда, которую доска запускает для этого наблюдения, в папке сессии',
    'watch.log.fired': 'Проба сработала',
  },
}
