# Team quickstart (the peer network MVP, #231)

English first, Russian below ([по-русски](#быстрый-старт-команды)).

Boards of people you trust talk through one small hub. One person runs the hub (the admin); each
member joins it with a one-time invite. What the MVP is and is not: the
[Team section of the README](../README.md#team).

## The hub's admin (a Linux VPS in your tailnet)

1. Find the machine's tailnet address: `tailscale ip -4` (something like `100.64.0.7`). The hub
   listens only on loopback or a tailnet address unless you pass `--allow-public`.
2. Get the repository and its dependencies: `git clone` it, `bun install` in the folder, and check out
   the branch or main that has the Team feature.
3. Install the unit. Copy `hub/hab-hub.service` to `~/.config/systemd/user/hab-hub.service`, edit
   `ExecStart`: the path to `bun`, the path to the repository, and `--listen <tailnet ip>:7443`.
   `--dir` is where `hub.db` and the admin socket live (`~/.local/state/hab-hub`).

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now hab-hub
   loginctl enable-linger "$USER"      # so it keeps running when you log out
   systemctl --user status hab-hub     # active (running)
   ```
4. One invite per person, with a note of whose it is:

   ```sh
   bun hub/src/cli.ts invite create --note anna
   ```

   It prints a code `hab-xxxx-…`, shown once, valid for one use and 24 hours (`--ttl` changes it).
   Send each code to that person **privately** (a direct message), never in an issue, a shared
   channel or a group chat: whoever uses it first becomes that member.
5. Look: `bun hub/src/cli.ts peers`, `invite list`.
6. Remove someone: `bun hub/src/cli.ts revoke <name>`. They are cut off at once and the others
   see them leave. An invite not yet used: `invite revoke <id>`.

The hub keeps message text only while it waits for the recipient (see "What it keeps" in
[hub/README.md](../hub/README.md)).

## Each member (Linux, macOS, Windows)

1. Update the board to the branch or main that has the Team feature:

   ```sh
   cd <your clone of herdr-agent-board>   # or the folder herdr linked
   git pull && bun install
   herdr plugin action invoke agent-board.install
   ```

   The open board restarts by itself when its code changes; if it does not, close it and open it
   again (`herdr plugin action invoke agent-board.open`). `board restart` is not for this: it
   restarts a Claude session. A board installed with `herdr plugin install` updates with
   `herdr plugin update`; to try a branch, clone the repository, check the branch out, then
   `herdr plugin unlink agent-board` and `herdr plugin link <the clone>` before the commands above.
   On Windows use PowerShell with the same commands. The `board` command is the one the install
   put into `~/.local/bin` (a `.cmd` on Windows).
2. Join, with the code the admin sent you and the hub's tailnet address (you must be in the same
   tailnet; the address may be written with or without `/v1`):

   ```sh
   board team join hab-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx --hub ws://100.64.0.7:7443 --name Anna
   ```

   The name is what the others see (up to 40 characters, no control characters). A bad or used
   invite changes nothing.
3. Check: `board team roster`. It lists who is online (`●`) and who is not (`○`).
4. In the board: Settings → Team…. Pick a person; a green dot means they are online.
5. First message: type a question under the thread and press Send. It shows queued, delivered,
   then received once their board has signed for it.
6. Ask your agent to draft one: tell it `board team draft Roman "is the build green?"`. The
   draft appears in Roman's thread, marked "draft from an agent". Nothing leaves your computer until
   you press Send; Discard drops it. Roman sees "via Anna's agent".

   Note: until #224 an agent on the same machine can send on its own: it can create a draft and send
   it, or call `/api/team/send` directly, and then the message carries no agent mark. The "via agent"
   mark only says the draft came from `board team draft`; it does not say that a person approved it.

## When something does not work

- **No green dot / "Could not use …" / "Connecting…" for long.** Is Tailscale up on your machine
  (`tailscale status`) and on the hub's? Is the hub running (`systemctl --user status hab-hub` on
  the VPS)? Is the address the tailnet one with port `7443`, and the same as the admin gave? `board team
  roster` first line shows the address the board uses.
- **The invite is refused** (`invite_invalid`, "the hub refused"). An invite works once and for 24
  hours; it was used or has expired. Ask the admin for a new one. `name_taken`: someone has that
  name, choose another.
- **A message stays "queued at the hub".** The person's board is offline. It is delivered when it
  comes back, and expires after 24 hours if it does not (then it shows "expired, not delivered").
- **"The hub does not know this board" (`unknown_peer`).** This board's key is not a member: it
  never joined, or the hub's database was started over. Join again with a new invite.
- **"The key of <name> changed".** The same name now comes with another key. It may be a new
  computer or someone else. Check with the person (the fingerprints are in the panel), then press
  Trust; until then what comes from the new key is held back and you cannot send to it.
- **Removed from the team.** The admin revoked you; join again only with a new invite.

## What the MVP does not do

Offers and replies, statuses, end-to-end encryption, quotas, and the line between what a human and
an agent may do (#224: an agent on your computer can still call the board's local API to send as
you). See [What the MVP does not do](../README.md#team) in the README.

---

# Быстрый старт команды

Доски людей, которым вы доверяете, общаются через один небольшой хаб. Хаб запускает один человек
(админ); каждый участник вступает по одноразовому приглашению. Что MVP умеет и чего нет: раздел
[Team в README](../README.md#team).

## Админ хаба (Linux VPS в вашем tailnet)

1. Узнайте tailnet-адрес машины: `tailscale ip -4` (вроде `100.64.0.7`). Хаб слушает только
   loopback или tailnet, если не указать `--allow-public`.
2. Склонируйте репозиторий, выполните `bun install` и переключитесь на ветку или main, где есть Team.
3. Поставьте юнит. Скопируйте `hub/hab-hub.service` в `~/.config/systemd/user/hab-hub.service` и
   поправьте `ExecStart`: путь к `bun`, путь к репозиторию и `--listen <tailnet ip>:7443`. `--dir` —
   где лежат `hub.db` и сокет админа (`~/.local/state/hab-hub`).

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now hab-hub
   loginctl enable-linger "$USER"      # чтобы работал и после выхода из системы
   systemctl --user status hab-hub     # active (running)
   ```
4. По одному приглашению на человека, с пометкой, чьё оно:

   ```sh
   bun hub/src/cli.ts invite create --note anna
   ```

   Код `hab-xxxx-…` показывается один раз, годен на одно использование и 24 часа (`--ttl` меняет
   срок). Отправляйте каждый код этому человеку **лично** (в личные сообщения), никогда не в issue,
   общий канал или групповой чат: кто использует код первым, тот и станет участником.
5. Посмотреть: `bun hub/src/cli.ts peers`, `invite list`.
6. Убрать участника: `bun hub/src/cli.ts revoke <имя>`: его отключают сразу, остальные видят, что он
   ушёл. Неиспользованное приглашение: `invite revoke <id>`.

Хаб хранит текст сообщения, только пока оно ждёт получателя (см. «What it keeps» в
[hub/README.md](../hub/README.md)).

## Каждый участник (Linux, macOS, Windows)

1. Обновите доску до ветки или main, где есть Team:

   ```sh
   cd <ваш клон herdr-agent-board>   # или папка, которую подключил herdr
   git pull && bun install
   herdr plugin action invoke agent-board.install
   ```

   Открытая доска перезапускается сама, когда меняется её код; если нет — закройте её и откройте
   снова (`herdr plugin action invoke agent-board.open`). `board restart` для этого не подходит: он
   перезапускает сессию Claude. Доска, поставленная через `herdr plugin install`, обновляется
   `herdr plugin update`; чтобы попробовать ветку, склонируйте репозиторий, перейдите на ветку,
   затем `herdr plugin unlink agent-board` и `herdr plugin link <клон>` перед командами выше.
   В Windows те же команды в PowerShell. Команда `board` — та, что установка положила в
   `~/.local/bin` (в Windows это `.cmd`).
2. Вступите с кодом от админа и tailnet-адресом хаба (вы должны быть в том же tailnet; адрес можно
   писать с `/v1` и без):

   ```sh
   board team join hab-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx --hub ws://100.64.0.7:7443 --name Anna
   ```

   Имя видят остальные (до 40 символов, без управляющих). Неверное или использованное приглашение
   ничего не меняет.
3. Проверьте: `board team roster`. Он показывает, кто в сети (`●`) и кто нет (`○`).
4. В доске: Settings → «Команда…». Выберите человека; зелёная точка значит, что он в сети.
5. Первое сообщение: напишите вопрос под перепиской и нажмите «Отправить». Статус: ждёт в хабе,
   доставлено, получено (когда их доска подписала получение).
6. Попросите агента сделать черновик: `board team draft Roman "сборка зелёная?"`. Черновик появится в
   переписке с Roman с пометкой «черновик от агента». Пока вы не нажмёте «Отправить», ничего не
   уходит с вашего компьютера; «Удалить» убирает его. Roman увидит «через агента Anna».

   Важно: пока не сделан #224, агент на том же компьютере может отправить сообщение сам: создать
   черновик и отправить его или вызвать `/api/team/send` напрямую — тогда у сообщения нет пометки
   агента. Пометка «через агента» говорит только, что черновик пришёл из `board team draft`; она не
   значит, что человек его одобрил.

## Если что-то не работает

- **Нет зелёной точки / «Не удалось работать с …» / долго «Подключаемся…».** Работает ли Tailscale
  у вас (`tailscale status`) и на хабе? Запущен ли хаб (`systemctl --user status hab-hub` на VPS)?
  Адрес — tailnet-овый, порт `7443`, такой же, как дал админ? Первая строка `board team roster`
  показывает адрес, который использует доска.
- **Приглашение отклонено** (`invite_invalid`). Оно работает один раз и 24 часа: уже использовано
  или истекло. Попросите у админа новое. `name_taken`: имя занято, выберите другое.
- **Сообщение «ждёт в хабе».** Доска получателя не в сети. Оно дойдёт, когда та вернётся, а через
  24 часа истечёт («истекло, не доставлено»).
- **«Хаб не знает эту доску» (`unknown_peer`).** Ключ этой доски не участник: она не вступала или
  база хаба начата заново. Вступите снова по новому приглашению.
- **«Ключ <имя> изменился».** То же имя пришло с другим ключом: возможно, новый компьютер, а
  возможно, другой человек. Сверьтесь с человеком (отпечатки в панели) и нажмите «Доверять»; пока
  этого нет, всё от нового ключа удержано, и отправить ему нельзя.
- **«Эту доску убрали из команды».** Админ отозвал доступ; вступить снова можно только по новому
  приглашению.

## Чего MVP не умеет

Офферов и ответов, статусов, сквозного шифрования, квот и границы между тем, что может человек и
что агент (#224: агент на вашем компьютере всё ещё может сам вызвать локальный API доски и отправить
от вашего имени). См. «What the MVP does not do» в [README](../README.md#team).
