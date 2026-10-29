// The board on a server of the owner's (core/server-install.ts): what its install says on the
// server (path A in a terminal, path B in the local board's panel, where its output is streamed),
// what `board update` says, and the panel's own words for path B, in English and Russian;
// strings.ts merges them into the dictionaries. None starts with `server.plain.`, `server.warn.`
// or `server.manual.`: the tunnel's one command carries those, and stays as it was.
import type { Lang } from '../types.ts'

export const INSTALL_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'install.will.theirCaddy': 'Add {domain} to your Caddy and hand it the board.',
    'install.will.user': 'Make the user {user} (no sudo) for herdr, Claude Code and the board.',
    'install.will.userSudo': 'Make the user {user}, with sudo, for herdr, Claude Code and the board.',
    'install.will.sudoOn': 'Give {user} sudo (--sudo).',
    'install.will.sudoOff': 'Take sudo from {user} again (it had it from --sudo before).',
    'install.will.keys': 'The ssh keys of {from} let you log in as {user} too.',
    'install.will.tools':
      'Install Bun {bun}, herdr and Claude Code for {user}, each from its own installer (what is there is kept).',
    'install.will.board': 'Install the board: {from}.',
    'install.will.key': 'Bind prefix+a to the board in herdr for {user}, when no key is bound to it.',
    'install.will.service': 'Run herdr as {user}’s service, started with the server; the board opens in it.',
    'install.source.git': '{ref} ({commit}) from {repo}',
    'install.source.archive': 'a copy of {commit} from your computer',
    'install.source.changes': 'a copy of {commit} from your computer, with its local changes',
    'install.looking': 'agent-board: looking at this server. Nothing changes until you say so.',
    'install.askDomain': 'The board’s domain (e.g. board.example.com): ',
    'install.found': 'Found:',
    'install.plan': 'The plan:',
    'install.notes': 'Good to know:',
    'install.unchanged': 'Nothing has changed on this server yet.',
    'install.ask': 'Go ahead? [y/N] ',
    'install.no': 'Stopped: nothing was changed.',
    'install.noTerminal':
      'This asks before it changes anything, and there is no terminal here to ask on: nothing was changed. Run it in a terminal on the server (an ssh session).',
    'install.stop.os':
      'The board installs on Debian 12 and 13 and Ubuntu 22.04 to 26.04, with systemd, on x86_64 or arm64: not on this server. Nothing was changed.',
    'install.stop.root': 'This needs root. Nothing was changed.',
    'install.stop.domain': 'Which domain is the board to answer on? Give it with --domain board.example.com.',
    'install.stop.userTaken':
      'The user {user} is already on this server and was not made by the board: choose another with --user. Nothing was changed.',
    'install.stop.otherUser':
      'The board is installed here for {other}: give --user {other}, or run its Undo first. Nothing was changed.',
    'install.stop.interrupted':
      'A run of the board’s web server setup did not finish here: run this again with --undo first.',
    'install.step': '- {what}',
    'install.step.user': 'the user {user}',
    'install.step.linger': '{user}’s services start with the server',
    'install.step.sudo': 'sudo for {user}',
    'install.step.keys': 'ssh keys for {user}',
    'install.step.bun': 'Bun {version}',
    'install.step.herdr': 'herdr {version}',
    'install.step.claude': 'Claude Code {version}',
    'install.step.board': 'the board: {from}',
    'install.step.deps': 'the board’s packages',
    'install.step.link': 'the board as herdr’s plugin, its hooks and commands',
    'install.step.config': 'the board’s server mode: https://{domain}',
    'install.step.service': 'herdr’s service',
    'install.step.key': 'the board’s key in herdr: {key}',
    'install.key.kept': 'one was bound already, kept',
    'install.step.listener': 'the board’s login listener',
    'install.web': 'The web server:',
    'install.web.step': '  {mark} {title}',
    'install.failed': 'Stopped: {what} failed. What was done before it stays; run this again to go on.',
    'install.listenerLate':
      'The board has not opened its login listener yet ({socket}); it does once herdr has started it. Look with: systemctl --user status herdr, as {user}.',
    'install.done': 'Done: the board is at https://{domain}',
    'install.link': 'Open this link once to set the board’s login (it works once, for an hour; it is shown only here):',
    'install.linkSet':
      'The board’s login is set: sign in at https://{domain}. A new setup link: board login reset, as {user}.',
    'install.linkFailed': 'No setup link: run board login link as {user} on this server ({why}).',
    'install.after':
      'Next: log in as {user} (ssh {user}@<this server>) and run claude once to sign in to Claude; herdr attaches to the running server.',
    'install.undo.will.service': 'Stop herdr’s service of {user} and its start with the server.',
    'install.undo.will.sudo': 'Take {user}’s sudo away.',
    'install.undo.will.user':
      'Remove the user {user} and its home ({home}): Bun, herdr, Claude Code, the board, everything in it.',
    'install.undo.will.keepUser': 'The user {user} and its home stay (with --remove-user they go too).',
    'install.undo.will.webNone': 'The web server has nothing of the board’s to remove.',
    'install.undo.nothing': 'Nothing of the board’s installer is on this server.',
    'install.undo.done': 'Undone.',
    'install.undo.userKept': 'The user {user} was not made by the board: kept.',
    'update.notServer': 'board update updates a board that server-install.sh installed on a server; this one was not.',
    'update.archive':
      'This board was installed from a copy sent from a computer ({commit}), not from a branch: give one, e.g. board update --ref main.',
    'update.badRef': '--ref takes a branch, a tag or a commit.',
    'update.fetching': 'Fetching {ref} from {repo}…',
    'update.changes':
      'The board’s checkout ({dir}) has changes of its own that the update would overwrite: commit or drop them first. Nothing was changed.',
    'update.same': 'Already at {ref} ({commit}).',
    'update.done': 'Updated to {ref} ({commit}); the board restarts by itself.',
    'update.failed': 'The update stopped: {why}',
    // the local board's panel, path B
    'install.panel.intro':
      'herdr, Claude Code and the board run on the server as a user of their own, and the board answers at its address there, with its own login. The board on this computer stays as it is.',
    'install.panel.look': 'Install the board on this server',
    'install.panel.domain': 'Address of the board on the server',
    'install.panel.domainPlaceholder': 'workbench.example.com',
    'install.panel.domainNote': 'A domain of its own: the tunnel’s address stays the board’s on this computer.',
    'install.panel.needDomain': 'Type the address of the board on the server first.',
    'install.panel.from': 'The board’s code: {from}.',
    'install.panel.noCheckout':
      'This board is not a git checkout, so it has no code of its own to send: install it on the server with its one line (server-install.sh).',
    'install.panel.apply': 'Install',
    'install.panel.running': 'Installing (the run goes on on the server if this window closes):',
    'install.panel.link':
      'The setup link: open it once to set the board’s login there. It is shown only here, once: it is gone when this panel closes.',
    'install.panel.done': 'Installed: https://{domain}',
    'install.panel.failed': 'The install stopped (why is above). What was done stays; Install again to go on.',
    // the card's version of the board on the server (core/server-board.ts)
    'install.panel.version': 'version {commit}',
    'install.panel.versionChanges': 'version {commit} (with local changes)',
    'install.panel.installedAt': 'installed {when}',
    'install.panel.notInstalled': 'not installed',
    'install.panel.versionUnknown': 'what is installed there is not known yet',
    'install.panel.seen': 'As the board saw it at {time}: Look to refresh.',
    'install.panel.refresh': 'Look',
    'install.panel.updateAvailable': 'An update is available: this computer has {version}.',
    'install.panel.update': 'Update',
    'install.panel.again': 'Install again',
    // "Remove the board from this server" (the install's --undo, from the card)
    'install.remove.button': 'Remove the board from this server',
    'install.remove.intro':
      'Takes back what the install did on this server, as its --undo does. The tunnel’s setup on this server stays as it is.',
    'install.remove.tickUser': 'Also remove the user {user} and its home ({home})',
    'install.remove.warnUser':
      'This deletes every file in {home}: the agents’ projects and work, their Claude sign-in and sessions, herdr’s state. It cannot be undone.',
    'install.remove.apply': 'Remove',
    'install.remove.running': 'Removing (the run goes on on the server if this window closes):',
    'install.remove.done': 'Removed: the board is no longer on this server.',
    'install.remove.failed': 'The removal stopped (why is above). Look again to see what is left.',
    'install.err.domainNeeded':
      'The board on the server needs an address of its own (e.g. workbench.example.com): type it above Install the board on this server.',
    'install.err.domain':
      'Address of the board on the server: a host name in lowercase letters, e.g. workbench.example.com, without https://, a path or a port',
    'install.err.sameDomain':
      '{domain} is the tunnel’s address, the board’s on this computer: the board on the server needs a domain of its own (e.g. workbench.example.com).',
  },
  ru: {
    'install.will.theirCaddy': 'Добавить {domain} в ваш Caddy и передать ему доску.',
    'install.will.user': 'Создать пользователя {user} (без sudo) для herdr, Claude Code и доски.',
    'install.will.userSudo': 'Создать пользователя {user}, с sudo, для herdr, Claude Code и доски.',
    'install.will.sudoOn': 'Дать {user} sudo (--sudo).',
    'install.will.sudoOff': 'Забрать у {user} sudo (он получил его раньше с --sudo).',
    'install.will.keys': 'SSH-ключи {from} позволят входить и как {user}.',
    'install.will.tools':
      'Установить для {user} Bun {bun}, herdr и Claude Code, каждый его собственным установщиком (то, что уже есть, остаётся).',
    'install.will.board': 'Установить доску: {from}.',
    'install.will.key': 'Назначить доске клавишу prefix+a в herdr пользователя {user}, если клавиши у неё ещё нет.',
    'install.will.service': 'Запускать herdr службой {user} вместе с сервером; доска открывается в нём.',
    'install.source.git': '{ref} ({commit}) из {repo}',
    'install.source.archive': 'копия {commit} с вашего компьютера',
    'install.source.changes': 'копия {commit} с вашего компьютера, с её локальными изменениями',
    'install.looking': 'agent-board: смотрю на этот сервер. Ничего не меняется, пока вы не скажете.',
    'install.askDomain': 'Домен доски (например, board.example.com): ',
    'install.found': 'Найдено:',
    'install.plan': 'План:',
    'install.notes': 'Полезно знать:',
    'install.unchanged': 'На сервере пока ничего не изменилось.',
    'install.ask': 'Выполнить? [y/N] ',
    'install.no': 'Остановлено: ничего не изменено.',
    'install.noTerminal':
      'Перед изменениями здесь спрашивают, а терминала, чтобы спросить, нет: ничего не изменено. Запустите в терминале на сервере (в сессии ssh).',
    'install.stop.os':
      'Доска ставится на Debian 12 и 13 и Ubuntu с 22.04 по 26.04, с systemd, на x86_64 или arm64: не на этот сервер. Ничего не изменено.',
    'install.stop.root': 'Нужен root. Ничего не изменено.',
    'install.stop.domain': 'На каком домене отвечать доске? Укажите его: --domain board.example.com.',
    'install.stop.userTaken':
      'Пользователь {user} уже есть на сервере, и его создала не доска: выберите другого через --user. Ничего не изменено.',
    'install.stop.otherUser':
      'Доска здесь установлена для {other}: укажите --user {other} или сначала отмените ту установку. Ничего не изменено.',
    'install.stop.interrupted':
      'Запуск настройки веб-сервера доски здесь не завершился: сначала запустите это с --undo.',
    'install.step': '- {what}',
    'install.step.user': 'пользователь {user}',
    'install.step.linger': 'службы {user} запускаются вместе с сервером',
    'install.step.sudo': 'sudo для {user}',
    'install.step.keys': 'SSH-ключи для {user}',
    'install.step.bun': 'Bun {version}',
    'install.step.herdr': 'herdr {version}',
    'install.step.claude': 'Claude Code {version}',
    'install.step.board': 'доска: {from}',
    'install.step.deps': 'пакеты доски',
    'install.step.link': 'доска как плагин herdr, её хуки и команды',
    'install.step.config': 'серверный режим доски: https://{domain}',
    'install.step.service': 'служба herdr',
    'install.step.key': 'клавиша доски в herdr: {key}',
    'install.key.kept': 'уже была назначена, оставлена',
    'install.step.listener': 'вход доски',
    'install.web': 'Веб-сервер:',
    'install.web.step': '  {mark} {title}',
    'install.failed': 'Остановлено: не удалось {what}. Сделанное до этого остаётся; запустите снова, чтобы продолжить.',
    'install.listenerLate':
      'Доска ещё не открыла свой вход ({socket}); она откроет его, когда herdr её запустит. Посмотреть: systemctl --user status herdr от имени {user}.',
    'install.done': 'Готово: доска на https://{domain}',
    'install.link':
      'Откройте эту ссылку один раз, чтобы задать вход в доску (она работает один раз, в течение часа; показана только здесь):',
    'install.linkSet':
      'Вход в доску задан: войдите на https://{domain}. Новая ссылка настройки: board login reset от имени {user}.',
    'install.linkFailed': 'Ссылки настройки нет: запустите board login link от имени {user} на этом сервере ({why}).',
    'install.after':
      'Дальше: войдите как {user} (ssh {user}@<этот сервер>) и один раз запустите claude, чтобы войти в Claude; herdr подключается к запущенному серверу.',
    'install.undo.will.service': 'Остановить службу herdr пользователя {user} и её запуск вместе с сервером.',
    'install.undo.will.sudo': 'Забрать у {user} sudo.',
    'install.undo.will.user':
      'Удалить пользователя {user} и его домашнюю папку ({home}): Bun, herdr, Claude Code, доску, всё в ней.',
    'install.undo.will.keepUser':
      'Пользователь {user} и его домашняя папка остаются (с --remove-user они тоже удаляются).',
    'install.undo.will.webNone': 'В веб-сервере нет ничего от доски.',
    'install.undo.nothing': 'Установщика доски на этом сервере нет.',
    'install.undo.done': 'Отменено.',
    'install.undo.userKept': 'Пользователя {user} создала не доска: он остаётся.',
    'update.notServer':
      'board update обновляет доску, которую server-install.sh установил на сервер; эта установлена не так.',
    'update.archive':
      'Эта доска установлена из копии, присланной с компьютера ({commit}), а не из ветки: укажите ветку, например board update --ref main.',
    'update.badRef': '--ref принимает ветку, тег или коммит.',
    'update.fetching': 'Получаю {ref} из {repo}…',
    'update.changes':
      'В папке доски ({dir}) есть свои изменения, которые обновление затёрло бы: сначала закоммитьте или отбросьте их. Ничего не изменено.',
    'update.same': 'Уже на {ref} ({commit}).',
    'update.done': 'Обновлено до {ref} ({commit}); доска перезапустится сама.',
    'update.failed': 'Обновление остановилось: {why}',
    'install.panel.intro':
      'herdr, Claude Code и доска работают на сервере от своего пользователя, и доска отвечает там по своему адресу, со своим входом. Доска на этом компьютере остаётся как есть.',
    'install.panel.look': 'Установить доску на этот сервер',
    'install.panel.domain': 'Адрес доски на сервере',
    'install.panel.domainPlaceholder': 'workbench.example.com',
    'install.panel.domainNote': 'Свой домен: адрес туннеля остаётся за доской на этом компьютере.',
    'install.panel.needDomain': 'Сначала введите адрес доски на сервере.',
    'install.panel.from': 'Код доски: {from}.',
    'install.panel.noCheckout':
      'Эта доска не git-копия, своего кода для отправки у неё нет: установите её на сервер одной строкой (server-install.sh).',
    'install.panel.apply': 'Установить',
    'install.panel.running': 'Устанавливаю (если закрыть это окно, установка продолжится на сервере):',
    'install.panel.link':
      'Ссылка настройки: откройте её один раз, чтобы задать вход в доску там. Она показана только здесь и один раз: закроете панель — её не будет.',
    'install.panel.done': 'Установлено: https://{domain}',
    'install.panel.failed':
      'Установка остановилась (причина выше). Сделанное остаётся; нажмите «Установить» снова, чтобы продолжить.',
    'install.panel.version': 'версия {commit}',
    'install.panel.versionChanges': 'версия {commit} (с локальными изменениями)',
    'install.panel.installedAt': 'установлена {when}',
    'install.panel.notInstalled': 'не установлена',
    'install.panel.versionUnknown': 'что там установлено, пока неизвестно',
    'install.panel.seen': 'Так доска видела это в {time}: нажмите «Посмотреть», чтобы обновить.',
    'install.panel.refresh': 'Посмотреть',
    'install.panel.updateAvailable': 'Есть обновление: на этом компьютере {version}.',
    'install.panel.update': 'Обновить',
    'install.panel.again': 'Установить заново',
    'install.remove.button': 'Удалить доску с этого сервера',
    'install.remove.intro':
      'Отменяет то, что установка сделала на этом сервере, как её --undo. Настройка туннеля на этом сервере остаётся как есть.',
    'install.remove.tickUser': 'Удалить и пользователя {user} с его домашней папкой ({home})',
    'install.remove.warnUser':
      'Это удалит все файлы в {home}: проекты и работу агентов, их вход в Claude и сессии, состояние herdr. Вернуть их будет нельзя.',
    'install.remove.apply': 'Удалить',
    'install.remove.running': 'Удаляю (если закрыть это окно, удаление продолжится на сервере):',
    'install.remove.done': 'Удалено: доски на этом сервере больше нет.',
    'install.remove.failed': 'Удаление остановилось (причина выше). Посмотрите снова, чтобы увидеть, что осталось.',
    'install.err.domainNeeded':
      'Доске на сервере нужен свой адрес (например, workbench.example.com): введите его над кнопкой «Установить доску на этот сервер».',
    'install.err.domain':
      'Адрес доски на сервере: имя хоста строчными буквами, например workbench.example.com, без https://, пути и порта',
    'install.err.sameDomain':
      '{domain} — адрес туннеля, доски на этом компьютере: доске на сервере нужен свой домен (например, workbench.example.com).',
  },
}
