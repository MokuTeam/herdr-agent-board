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

    // Task 11: the probe and Test connection

    // Task 12: the tunnel listener

    // Task 13: the board's own files

    // Task 14: Remote access on the local board

    // Task 15: board tunnel

    // Task 16: the panel's Tunnel part

    // Task 17: the panel's Login parts

    // Task 18: signing in through the domain
    'login.title': 'Sign in to the board',
    'login.passkey': 'Sign in with a passkey',
    'login.usePassword': 'Use password and code',
    'login.password': 'Password',
    'login.code': 'Code from the authenticator app',
    'login.signIn': 'Sign in',
    'login.wrong': 'Wrong password or code.',
    'login.locked': 'Too many failed tries: sign-in is locked until {time}.',
    'login.limited': 'Too many tries. Try again in {seconds} s.',
    'login.failed': 'Could not sign in: {why}',
    'login.passkeyWrong': 'The board did not accept this passkey.',
    'login.addTitle': 'Add a passkey for this device',
    'login.addNote': 'Enter the next code: the one you signed in with works once only.',
    'login.nextCode': 'Next code',
    'login.add': 'Add',
    'login.notNow': 'Not now',
    'login.wrongCode': 'That is not the next code.',
    'login.addFailed': 'Could not add the passkey: {why}',
    'login.refused': 'This address does not reach the board.',
    'offline.aboutDomain': 'The computer may be asleep, or the board closed. This page tries again by itself.',
    'set.signOut': 'Sign out',
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

    // Task 11: the probe and Test connection

    // Task 12: the tunnel listener

    // Task 13: the board's own files

    // Task 14: Remote access on the local board

    // Task 15: board tunnel

    // Task 16: the panel's Tunnel part

    // Task 17: the panel's Login parts

    // Task 18: signing in through the domain
    'login.title': 'Вход на доску',
    'login.passkey': 'Войти с ключом доступа',
    'login.usePassword': 'Войти по паролю и коду',
    'login.password': 'Пароль',
    'login.code': 'Код из приложения-аутентификатора',
    'login.signIn': 'Войти',
    'login.wrong': 'Неверный пароль или код.',
    'login.locked': 'Слишком много неудачных попыток: вход закрыт до {time}.',
    'login.limited': 'Слишком много попыток. Попробуйте снова через {seconds} с.',
    'login.failed': 'Не получилось войти: {why}',
    'login.passkeyWrong': 'Доска не приняла этот ключ доступа.',
    'login.addTitle': 'Добавить ключ доступа для этого устройства',
    'login.addNote': 'Введите следующий код: тот, с которым вы вошли, срабатывает только один раз.',
    'login.nextCode': 'Следующий код',
    'login.add': 'Добавить',
    'login.notNow': 'Не сейчас',
    'login.wrongCode': 'Это не следующий код.',
    'login.addFailed': 'Не получилось добавить ключ доступа: {why}',
    'login.refused': 'По этому адресу доска недоступна.',
    'offline.aboutDomain': 'Возможно, компьютер спит или доска закрыта. Страница сама попробует ещё раз.',
    'set.signOut': 'Выйти',
  },
}
