// The texts of the board on its own server (core/on-server.ts): the setup page of its first login
// (server/setup-page.ts) and `board doctor`'s checks, in English and Russian; strings.ts merges
// them into the dictionaries.
import type { Lang } from '../types.ts'

export const FIRST_LOGIN_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    // the setup page
    'firstLogin.title': "Set up the board's login",
    'firstLogin.checking': 'Checking the link…',
    'firstLogin.noCode': 'This page needs the link with its code, as `board login link` prints it on the server.',
    'firstLogin.link':
      'This link was used already, has expired, or is not right. On the server, `board login link` prints a new one.',
    'firstLogin.scan':
      'Scan this code with an authenticator app, or type the key into it. Then choose a password and enter the code the app shows.',
    'firstLogin.key': 'Key',
    'firstLogin.password': 'Password (12 characters or more)',
    'firstLogin.code': 'Code from the app',
    'firstLogin.submit': 'Set the login',
    'firstLogin.expired': 'This setup took too long. On the server, `board login link` prints a new link.',
    'firstLogin.limited': 'Too many tries: wait a minute, then try again.',
    'firstLogin.failed': 'The board did not answer. Try again.',
    'firstLogin.done':
      'The login is set. Sign in with the password and the next code the app shows; the board then offers a passkey for this device.',
    'firstLogin.signIn': 'Sign in',

    // board doctor
    'onServer.check.fields': 'Server mode',
    'onServer.check.fieldsBad': 'Server mode: the settings in config.json do not check out',
    'onServer.check.listener': 'The login listener answers on its socket',
    'onServer.check.noListener': 'Nothing answers on {socket}',
    'onServer.check.noListenerFix': 'The board makes it while it runs: is herdr running, with the board in it?',
    'onServer.check.login': 'The login is set',
    'onServer.check.noLogin': 'No login yet',
    'onServer.check.noLoginFix': 'Open the setup link; this prints a new one:',
  },
  ru: {
    'firstLogin.title': 'Настройка входа на доску',
    'firstLogin.checking': 'Проверяю ссылку…',
    'firstLogin.noCode': 'Этой странице нужна ссылка с кодом, какую печатает `board login link` на сервере.',
    'firstLogin.link':
      'Эта ссылка уже использована, устарела или неверна. Новую печатает `board login link` на сервере.',
    'firstLogin.scan':
      'Отсканируйте этот код приложением-аутентификатором или введите в него ключ. Затем выберите пароль и введите код из приложения.',
    'firstLogin.key': 'Ключ',
    'firstLogin.password': 'Пароль (от 12 символов)',
    'firstLogin.code': 'Код из приложения',
    'firstLogin.submit': 'Настроить вход',
    'firstLogin.expired':
      'Настройка заняла слишком много времени. Новую ссылку печатает `board login link` на сервере.',
    'firstLogin.limited': 'Слишком много попыток: подождите минуту и попробуйте снова.',
    'firstLogin.failed': 'Доска не ответила. Попробуйте снова.',
    'firstLogin.done':
      'Вход настроен. Войдите с паролем и следующим кодом из приложения; затем доска предложит ключ доступа для этого устройства.',
    'firstLogin.signIn': 'Войти',

    'onServer.check.fields': 'Режим сервера',
    'onServer.check.fieldsBad': 'Режим сервера: настройки в config.json не годятся',
    'onServer.check.listener': 'Слушатель входа отвечает на своём сокете',
    'onServer.check.noListener': 'На {socket} никто не отвечает',
    'onServer.check.noListenerFix': 'Доска создаёт его, пока работает: запущен ли herdr и доска в нём?',
    'onServer.check.login': 'Вход настроен',
    'onServer.check.noLogin': 'Входа ещё нет',
    'onServer.check.noLoginFix': 'Откройте ссылку настройки; новую печатает:',
  },
}
