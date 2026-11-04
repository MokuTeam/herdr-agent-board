// The calendar's texts (#328, core/calendar.ts): config.json's problems, the refusals of `board cal`
// and the routes, Settings → Calendar and the Calendar panel, in English and Russian; strings.ts
// merges them into the dictionaries.
import type { Lang } from '../types.ts'

export const CAL_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'cal.problem.type': 'not the right kind of value ({value})',
    'cal.problem.unknown': 'not a setting the calendar knows',
    'cal.problem.required': 'missing',
    'cal.problem.id': 'not an id: lowercase letters, digits and dashes ({value})',
    'cal.problem.kind': 'not one the calendar knows ({value})',
    'cal.problem.duplicate': 'another source has this id ({value})',
    'cal.problem.url': 'not an address the board calls: https, or http on this computer ({value})',
    'cal.problem.color': 'not a colour: #rrggbb ({value})',
    'cal.problem.range': 'out of range ({value})',

    'cal.err.off':
      'The calendar is off: turn it on in Settings → Calendar, or "calendar": { "on": true } in config.json',
    'cal.err.window': 'Not a window the calendar shows: from before to, at most 62 days',
    'cal.err.noDb': 'The board’s database cannot be opened',
    'cal.err.when': 'Not a time: {value}',
    'cal.err.endBeforeStart': 'The event ends before it starts',
    'cal.err.noTitle': 'An event needs a title',
    'cal.err.join': 'Not a web address to join: {value}',
    'cal.err.notFound': 'No event {id} in the board’s calendar',
    'cal.err.changed': 'Event {id} changed since it was read (now rev {rev}): read it again',
    'cal.err.bothTimes': 'From all day to a time, or back: give the start and the end together',
    'cal.err.usage': 'Not something the calendar does',
    'cal.err.noAddress': 'No iCal address for {source} yet: add it in Settings → Calendar',
    'cal.err.notFetched': '{source} is not fetched by the board',
    'cal.err.noEventsInAnswer': 'The answer has no events the board can read',
    'cal.err.noSource': 'No calendar source {source}: see board cal sources',
    'cal.err.readOnly':
      '{source} takes no writes: only the board’s own calendar, or a source with "write" in config.json',
    'cal.err.asked':
      'A provider’s calendar is changed only for an event the owner asked for: say their words with --asked "…"',
    'cal.err.provider': 'The provider refused: {error}',
    'cal.err.notPush': '{source} is not a push source',
    'cal.sink.title': 'Calendar address (iCal)',

    'cal.set.err.usage': 'Not a change Settings → Calendar makes',
    'cal.set.err.address': 'Not an iCal address: https://… or webcal://…',
    'cal.set.err.source': 'The source does not check out: {problems}',
    'cal.set.err.notFound': 'No source {id}',
    'cal.set.err.board': 'The board’s own calendar stays',
  },
  ru: {
    'cal.problem.type': 'значение не того вида ({value})',
    'cal.problem.unknown': 'календарь не знает такой настройки',
    'cal.problem.required': 'не указано',
    'cal.problem.id': 'не id: строчные латинские буквы, цифры и дефисы ({value})',
    'cal.problem.kind': 'календарь такого не знает ({value})',
    'cal.problem.duplicate': 'у другого источника такой же id ({value})',
    'cal.problem.url': 'доска такой адрес не вызывает: https, или http на этом компьютере ({value})',
    'cal.problem.color': 'не цвет: #rrggbb ({value})',
    'cal.problem.range': 'вне допустимого ({value})',

    'cal.err.off':
      'Календарь выключен: включите его в Настройки → Календарь или "calendar": { "on": true } в config.json',
    'cal.err.window': 'Такой промежуток календарь не показывает: от раньше до, не больше 62 дней',
    'cal.err.noDb': 'База доски не открывается',
    'cal.err.when': 'Не время: {value}',
    'cal.err.endBeforeStart': 'Событие кончается раньше, чем начинается',
    'cal.err.noTitle': 'Событию нужно название',
    'cal.err.join': 'Не веб-адрес для подключения: {value}',
    'cal.err.notFound': 'В календаре доски нет события {id}',
    'cal.err.changed': 'Событие {id} изменилось после чтения (теперь rev {rev}): прочитайте заново',
    'cal.err.bothTimes': 'С целого дня на время или обратно: укажите начало и конец вместе',
    'cal.err.usage': 'Календарь такого не делает',
    'cal.err.noAddress': 'Для {source} ещё нет iCal-адреса: добавьте его в Настройки → Календарь',
    'cal.err.notFetched': 'Доска не загружает {source} сама',
    'cal.err.noEventsInAnswer': 'В ответе нет событий, которые доска может прочитать',
    'cal.err.noSource': 'Нет источника календаря {source}: см. board cal sources',
    'cal.err.readOnly':
      '{source} не принимает записи: только собственный календарь доски или источник с "write" в config.json',
    'cal.err.asked':
      'Календарь провайдера меняется только ради события, о котором попросил владелец: передайте его слова через --asked "…"',
    'cal.err.provider': 'Провайдер отказал: {error}',
    'cal.err.notPush': '{source} не push-источник',
    'cal.sink.title': 'Адрес календаря (iCal)',

    'cal.set.err.usage': 'Настройки → Календарь так не меняют',
    'cal.set.err.address': 'Не iCal-адрес: https://… или webcal://…',
    'cal.set.err.source': 'Источник не сходится: {problems}',
    'cal.set.err.notFound': 'Нет источника {id}',
    'cal.set.err.board': 'Собственный календарь доски остаётся',
  },
}
