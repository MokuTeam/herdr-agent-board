// The texts of the remote mode (core/remote.ts: the board from a phone over Tailscale), in English
// and Russian; strings.ts merges them into the dictionaries.
import type { Lang } from '../types.ts'

export const REMOTE_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'set.phones': 'Phones…',
    'phones.title': 'Phones',
    'phones.about':
      'Phones on your Tailscale network that may use this board. Only your own Tailscale user (and the logins remote.allow lists) can ask to pair.',
    'phones.url': 'The board for phones: {url}',
    'phones.starting': 'Starting on the Tailscale address…',
    'phones.error': 'Phones cannot reach the board: {why}',
    'phones.asks': '{name} on {device} asks to use this board',
    'phones.asksFrom': '{login}, {os}',
    'phones.approve': 'Approve',
    'phones.deny': 'Deny',
    'phones.paired': 'Paired',
    'phones.none': 'No phone is paired yet. In the app, add this computer by its Tailscale name.',
    'phones.seen': 'last seen {when}',
    'phones.never': 'not seen yet',
    'phones.revoke': 'Unpair',
    'phones.revokeSure': 'Unpair? Click again',
    'phones.off': 'Turn off phones',
  },
  ru: {
    'set.phones': 'Телефоны…',
    'phones.title': 'Телефоны',
    'phones.about':
      'Телефоны в вашей сети Tailscale, которым можно пользоваться этой доской. Попросить о связи может только ваш пользователь Tailscale (и те, кого перечисляет remote.allow).',
    'phones.url': 'Доска для телефонов: {url}',
    'phones.starting': 'Запускается на адресе Tailscale…',
    'phones.error': 'Телефоны не достанут доску: {why}',
    'phones.asks': '{name} на {device} просит доступ к доске',
    'phones.asksFrom': '{login}, {os}',
    'phones.approve': 'Разрешить',
    'phones.deny': 'Отклонить',
    'phones.paired': 'Связаны',
    'phones.none': 'Пока ни одного телефона. В приложении добавьте этот компьютер по имени в Tailscale.',
    'phones.seen': 'был на связи {when}',
    'phones.never': 'ещё не был на связи',
    'phones.revoke': 'Отвязать',
    'phones.revokeSure': 'Отвязать? Нажмите ещё раз',
    'phones.off': 'Выключить телефоны',
  },
}
