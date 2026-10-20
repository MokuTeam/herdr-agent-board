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
    'tunnel.hint.publickey':
      'The server refused the key: put the authorized_keys line in the keys file on the server, and the sshd Match block in sshd_config.',
    'tunnel.hint.listenPath':
      "The server refused the socket: its folder is missing or not the tunnel user's to write, the sshd Match block lacks AllowStreamLocalForwarding remote or AllowTcpForwarding remote (with PermitListen none), or a stale socket is there and StreamLocalBindUnlink is not yes.",
    'tunnel.hint.keyPermissions':
      'ssh refuses the key file for its access rights (UNPROTECTED PRIVATE KEY FILE): only you may read it. Generate key sets that; for a key of your own, fix its rights yourself.',
    'tunnel.hint.hostKey':
      "The server's key changed since it was pinned. If you changed the server on purpose, Forget the server's key; otherwise find out why first.",
    'tunnel.hint.network': 'No answer from the server: check the host, the SSH port and the firewall.',
    'tunnel.hint.noSsh': 'No OpenSSH client found. On Windows, add the optional feature "OpenSSH Client".',
    'tunnel.hint.passphrase': 'The key has a passphrase: the tunnel needs a key without one.',
    'tunnel.hint.caddy502':
      "Caddy answered 502: its socket path and the board's differ, or Caddy cannot open the socket (the folder's group or setgid bit, StreamLocalBindMask).",
    'tunnel.hint.tls': "No HTTPS answer: check the domain's DNS record, or Caddy has no certificate yet.",
    'tunnel.hint.answer': 'Something else answers on the domain, not this board.',
    'tunnel.hint.notConnected': 'The tunnel is not connected now.',

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
    'access.err.passwordLong': 'Пароль: не больше {max} символов',
    'access.err.noTotp': 'Сначала настройте код: время вышло или его не запрашивали',
    'access.err.code': 'Это не тот код, который сейчас показывает приложение',

    // Task 11: the probe and Test connection
    'tunnel.hint.publickey':
      'Сервер отклонил ключ: добавьте строку authorized_keys в файл ключей на сервере, а блок Match для sshd — в sshd_config.',
    'tunnel.hint.listenPath':
      'Сервер отклонил сокет: его папки нет или пользователь туннеля не может в неё писать, в блоке Match для sshd нет AllowStreamLocalForwarding remote или AllowTcpForwarding remote (с PermitListen none), либо там остался старый сокет, а StreamLocalBindUnlink не yes.',
    'tunnel.hint.keyPermissions':
      'ssh не принимает файл ключа из-за прав доступа (UNPROTECTED PRIVATE KEY FILE): читать его должны только вы. «Создать ключ» выставляет их сам; права своего ключа исправьте сами.',
    'tunnel.hint.hostKey':
      'Ключ сервера изменился с тех пор, как был запомнен. Если вы меняли сервер намеренно, нажмите «Забыть ключ сервера»; иначе сначала выясните почему.',
    'tunnel.hint.network': 'Сервер не отвечает: проверьте хост, порт SSH и брандмауэр.',
    'tunnel.hint.noSsh': 'Клиент OpenSSH не найден. В Windows добавьте дополнительный компонент «Клиент OpenSSH».',
    'tunnel.hint.passphrase': 'У ключа есть парольная фраза: туннелю нужен ключ без неё.',
    'tunnel.hint.caddy502':
      'Caddy ответил 502: путь к сокету у Caddy и у доски разный, или Caddy не может открыть сокет (группа папки или бит setgid, StreamLocalBindMask).',
    'tunnel.hint.tls': 'Нет ответа по HTTPS: проверьте DNS-запись домена, или у Caddy ещё нет сертификата.',
    'tunnel.hint.answer': 'На домене отвечает что-то другое, не эта доска.',
    'tunnel.hint.notConnected': 'Туннель сейчас не подключён.',

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
