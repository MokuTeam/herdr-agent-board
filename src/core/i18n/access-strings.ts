// The texts of remote access through the owner's own domain (core/tunnel.ts: the reverse SSH
// tunnel; the board's own login on top of it), in English and Russian; strings.ts merges them into
// the dictionaries.
import type { Lang } from '../types.ts'

export const ACCESS_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    // the tunnel's settings, by name
    'tunnel.field.host': 'Server',
    'tunnel.field.sshPort': 'SSH port',
    'tunnel.field.user': 'User',
    'tunnel.field.key': 'Key',
    'tunnel.field.socket': 'Socket on the server',
    'tunnel.field.domain': 'Domain',
    'tunnel.field.port': 'Local port',
    // what their checks say
    'tunnel.err.required': '{field}: needed',
    'tunnel.err.host': 'The server is a host name or an address, without spaces, @ or a leading dash',
    'tunnel.err.user': 'The user is a plain user name, without a leading dash',
    'tunnel.err.port': '{field} is a whole number from 1 to 65535',
    'tunnel.err.portTaken': "Port {port} is the board's already (the web board, phones, or the phone's browser)",
    'tunnel.err.socket':
      'The socket is an absolute path of letters, digits and . _ - / only, with no empty, . or .. part',
    'tunnel.err.socketLong': "The socket's path is longer than 100 bytes",
    'tunnel.err.socketShared':
      'The socket needs a folder of its own, not {folder}, where anyone could take its name first',
    'tunnel.err.domain':
      'The domain is a lowercase host name such as board.example.com, without https://, a path or a port',
    'tunnel.err.key': 'The key\'s path cannot start with a dash or hold " or ${',

    // Task 4: the login's rules
    'access.err.password': 'A password has at least 12 characters',

    // Task 7: the login service
    'access.err.passwordLong': 'A password has at most {max} characters',
    'access.err.noTotp': 'Set up the code first: it expired, or was never asked for',
    'access.err.code': 'That code is not the one the app shows now',

    // Task 11: the probe and Test connection

    // Task 12: the tunnel listener

    // Task 13: the board's own files

    // Task 14: Remote access on the local board

    // Task 15: board tunnel

    // Task 16: the panel's Tunnel part

    // Task 17: the panel's Login parts

    // Task 18: signing in through the domain
  },
  ru: {
    'tunnel.field.host': 'Сервер',
    'tunnel.field.sshPort': 'Порт SSH',
    'tunnel.field.user': 'Пользователь',
    'tunnel.field.key': 'Ключ',
    'tunnel.field.socket': 'Сокет на сервере',
    'tunnel.field.domain': 'Домен',
    'tunnel.field.port': 'Локальный порт',
    'tunnel.err.required': '{field}: нужно указать',
    'tunnel.err.host': 'Сервер: имя хоста или адрес, без пробелов, @ и дефиса в начале',
    'tunnel.err.user': 'Пользователь: обычное имя пользователя, без дефиса в начале',
    'tunnel.err.port': '{field}: целое число от 1 до 65535',
    'tunnel.err.portTaken': 'Порт {port} уже занят доской (веб-доска, телефоны или браузер телефона)',
    'tunnel.err.socket': 'Сокет: абсолютный путь только из латинских букв, цифр и . _ - /, без пустых частей, . и ..',
    'tunnel.err.socketLong': 'Путь сокета длиннее 100 байт',
    'tunnel.err.socketShared': 'Сокету нужна своя папка, не {folder}: там кто угодно может первым занять его имя',
    'tunnel.err.domain': 'Домен: имя хоста строчными буквами, например board.example.com, без https://, пути и порта',
    'tunnel.err.key': 'Путь к ключу не может начинаться с дефиса или содержать " или ${',

    // Task 4: the login's rules
    'access.err.password': 'Пароль: не меньше 12 символов',

    // Task 7: the login service
    'access.err.passwordLong': 'Пароль: не больше {max} символов',
    'access.err.noTotp': 'Сначала настройте код: время вышло или его не запрашивали',
    'access.err.code': 'Это не тот код, который сейчас показывает приложение',

    // Task 11: the probe and Test connection

    // Task 12: the tunnel listener

    // Task 13: the board's own files

    // Task 14: Remote access on the local board

    // Task 15: board tunnel

    // Task 16: the panel's Tunnel part

    // Task 17: the panel's Login parts

    // Task 18: signing in through the domain
  },
}
