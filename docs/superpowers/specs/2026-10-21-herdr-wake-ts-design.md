# agent-board: herdr-wake in the board, on Bun — design

Date: 2026-10-21 · Branch: `feature/herdr-wake-ts`, on `main` @ `6ae35a5` (after #144 and #148).
Issue: #119 (taken by the owner, migoni). Bugs found on the way: #150, #151. Decided with the owner
in chat; the builder's own calls are marked "(call N)" and listed at the end, the owner can
overturn any of them.

## Intent

herdr-wake puts idle Claude sessions to sleep and wakes them when there is work for them. The
board leans on it for "Put to sleep", "Wake", "Restart", `board sleep`, `board restart`, sleeping
sessions on the board and reminders that wake a session. Today it is a plugin of its own in
`herdr-wake/`, on Node.js 20. A computer set up for the board alone has no Node, and then none of
that works. It also knows only `~/.claude`, so for a session in another Claude profile, sleep and
restart never work (#150), and its own wakes fail after a restart of herdr (#151).

The owner wants it in the board: one runtime (Bun), one install, one config, nothing extra to run.
It starts by itself with the board, a switch on the board turns it on and off, and the board shows
whether it runs. It works for every profile.

## The worst outcome (anti-goal no. 1): nothing starts

After a restart of the computer the owner found nothing working: the board's pane came back as a
bare shell (fixed by #144), and the Work profile's sessions did not resume (fixed by #148). Adding
a second process to the board's start must never bring that back. Concretely, a failure for this
design is any of:

- the board does not open, or opens late, because wake failed, hung, or is missing;
- a session does not come back after a restart because of wake;
- wake keeps crashing in a loop, or silently is not there, and nothing says so.

Every choice below puts this first. Wake may fail; the board and the sessions do not fail with it.

## What herdr-wake is today (the facts this design starts from)

- **Process.** One long-lived `node src/router.mjs` in a plugin pane `router`, in a tab of its own
  workspace `tg-router` (`herdr-wake/herdr-plugin.toml`, `start.mjs`). Port `127.0.0.1:12421` is
  both its API and its single-instance lock: on EADDRINUSE it exits 0 (`router.mjs:499-504`).
- **Start.** A `[[startup]]` entry runs `start.mjs`: if `/status` answers, nothing; else it finds or
  makes `tg-router`, opens a new router tab and closes the old ones, so a pane herdr restored as a
  bare shell is replaced. If `herdr api snapshot` fails there is no retry.
- **Sessions seen.** Every 15 s it records each pane's last Claude session in `sessions.json` in its
  state folder. The write is not atomic (`router.mjs:69`); a broken file reads as `{}`, and every
  sleeping session is lost. A session the user `/exit`s counts as asleep too.
- **Reaper** (off by default). Once a minute it puts to sleep a session idle for `idleMinutes`, by
  Claude's registry and by herdr, not focused, no draft, not excluded, and with no
  `CronCreate`/`ScheduleWakeup` in the last 7 days (it reads the whole transcript, synchronously).
  Sleep is `/exit`, then the pane is renamed `💤 <name>` and `wakeCommand` is typed at the prompt.
- **Wake.** Clears the prompt line (Esc on Windows, Ctrl+U elsewhere, by the router's OS, not the
  pane's shell), `pane run "cd '<dir>'; <wakeCommand>"`, waits up to 120 s, answers the
  development-channels warning, leaves the folder-trust question to the user.
- **API.** `GET /status`, `/sleeping`, `/awake`; `POST /wake {target}`, `/sleep {target}`; a target
  is a name, a pane id or a session id. The board calls `/sleeping` (every 5 s, 2 s timeout),
  `/wake` (180 s), `/sleep` (60 s) and `/status` for `board doctor`
  (`src/integrations/herdr-wake.ts`, `services/actions.ts`, `adapters/setup-facts.ts`).
- **Telegram router** (optional). Long-polls tg-mcp's `/router/wait` (tg-mcp with `ROUTER=1`),
  picks the pane, wakes it if needed, types `[telegram …]`, acks. On when a url and token are
  found, in its config or in the `telegram` MCP server of `~/.claude.json`.
- **Claude Code hooks**, in `~/.claude/settings.json` only, run with `node`: PreToolUse
  `SendMessage` wakes the recipient; PostToolUse `ListAgents` adds the sleeping sessions and how
  long each running one has been idle; SessionStart reports a launcher `wakeCommand` to herdr.
- **claude-tg.** A sh and a `.cmd` in `~/.local/bin`; the Telegram key comes from
  `node claude-tg-key.mjs` and silently becomes the folder without Node.
- **Config.** `config.json` in `herdr plugin config-dir herdr-wake`; read once, a change needs a
  router restart.
- **Tests.** 34 on `node:test` (config, launcher, reaper, route, screen). The router itself (sleep,
  wake, API, poll) has none. Outside `bun test` and `bun run check`.
- **Profiles.** Nothing in `herdr-wake/` knows `CLAUDE_CONFIG_DIR`: registry and transcripts come
  from `~/.claude` only (`claude.mjs:8`). Hence #150 and #151.
- **Already in the board.** `adapters/herdr.ts` (herdr.mjs), `core/dialogs/*` (screen.mjs),
  `adapters/claude-home.ts` and `profile-homes.ts`, per profile (claude.mjs), `entrypoints/install.ts`
  and `hook.ts`, into every shown profile (install-hooks.mjs, hook.mjs), `core/resume.ts` and
  `board resume` (resumeArgs), `entrypoints/open.ts` with `core/board-pane.ts` (start.mjs),
  `entrypoints/run.ts` with `core/crash-policy.ts` (a supervisor).

What the board does when herdr-wake is down: sleeping cards vanish (`sleepers()` gives `[]`),
"Put to sleep", `board sleep` and `board restart` refuse, and a reminder for a sleeping session
waits `scheduleWaitMin` and counts as missed; a cron reminder is dropped after three such runs
(`scheduler.ts`). When it hangs, every board refresh waits up to 2 s for `/sleeping`.

## Goals

- **One runtime.** Wake runs on Bun from the board's `src/`, under the board's conventions. No Node.
- **Everything it does today keeps working** (the table under "Every function, where it goes").
- **No extra commands.** Turned on once, it starts by itself with the board, after every restart.
- **One switch, with sub-switches, and its state in sight:** on/off for everything, the reaper,
  the Telegram router; running, crashed or off on the board.
- **Every Claude profile:** sleep, wake, restart, the reaper and the hooks work in each (#150, #151).
- **It cannot stop the board** from starting or serving, nor sessions from coming back.
- **A smooth move** from the old plugin, once, with what changes said.

## Non-goals

- Changing what wake decides: the reaper's rules, the Telegram routing order, the API's paths and
  answers. This is a port; profiles are the only change in behaviour.
- Wake inside the board's process (rejected in the analysis: a crash or a long transcript read
  takes the board with it, the board runs only while its pane is open, and `run.ts` restarts it on
  every code change).
- Wake as a separate plugin on Bun (rejected: two installs and configs, and `herdr plugin install
  …/herdr-wake` installs the subfolder only, so the board's adapters could not be shared).
- Sleep and wake for pi or Codex sessions. Wake acts on Claude panes only, as today.
- Changing tg-mcp. Its README (Eithery-rc/tg-mcp#10) is updated by its author.
- Deleting `herdr-wake/` in this work. It stays one release, marked deprecated; removal is an
  issue of its own.

## Anti-goals (failure even if it works)

1. **Nothing starts** (above).
2. **A session put to sleep that cannot be woken in its own profile**, or woken in another one.
   Sleep is a door that must open again from the same side.
3. **Two wakes at once**, old and new, acting on the same panes.
4. **The sleeping list lost** (a half-written file, a crash): sleeping sessions turn into anonymous
   shells.
5. **Reminders dropped** because wake was down for a while.
6. **Any change a teammate without wake notices:** a new pane, workspace, process, hook or herdr
   call. AGENTS.md, "Everyone's setup, not yours".
7. **A slower prompt:** nothing is added to the hooks that run on every prompt.

## Constraints

- AGENTS.md: an issue first; each PR's new tests fail on `main` and pass with the change; the
  setups it must not touch are covered too; `bun test` and `bun run check` as on `main`; the PR
  says whom it touches, whom not, and what was compared (Claude session ids, `pane-<id>` keys,
  Windows paths, names with spaces, other alphabets, `%`).
- The board's conventions: strict TS; `src/core` pure (no I/O), `src/adapters` and
  `src/integrations` do the I/O and import only core, `src/services` orchestrate, `src/entrypoints`
  run; Biome; `bun test`; English and Russian texts; unknown JSON fields kept; JSON from disk or
  network narrowed by guards; no shell when spawning; loopback only.
- Windows, macOS and Linux. herdr 0.9.2 or newer (the manifest's `min_herdr_version`); `--env`
  needs 0.9.5, which wake does not use.
- Tests in sandboxes and fakes (`test/support/fake-herdr.ts`, `sandbox.ts`): never the owner's
  herdr, `~/.claude*`, `%APPDATA%\herdr`, or ports 12421 and 12422.

## Decided by the owner (2026-10-21)

1. **Ported to TypeScript on Bun, inside this repository's `src/`**, under the board's conventions,
   so the board needs one runtime. Every function it has today keeps working: the reaper, wake and
   restart, sleeping sessions on the board, the local API the board calls, the Claude Code hooks
   (ListAgents, SendMessage, SessionStart), the Telegram router through tg-mcp (optional), the
   claude-tg launcher, reminders that wake a session.
2. **Convenience first: no extra commands.** It starts by itself with the board. A setting on the
   board (Settings, and config.json) turns it on and off, with sub-switches (everything / reaper /
   Telegram router), and its state is in sight (running / crashed / off).
3. **One plugin, two processes.** Wake runs in a pane of its own under a supervisor of its own,
   not inside the board's process. The board talks to it over the same local API as today. Its
   failure or hang never stops the board from starting or serving.
4. **It never again ends in "nothing starts".** The safeguards below are part of the design, not
   options.
5. **Profiles:** hooks in every profile the board installs into; the session registry read in every
   profile; waking a session of any profile works.
6. **Migration:** with the old plugin installed, the new wake does not start. Once, it takes over
   the old config and sleeping list, removes the old hooks and the leftover `tg-router` workspace,
   and says what it did.
7. **Windows, macOS and Linux;** every existing setup unchanged except where this feature is
   turned on.

## How it runs

```
herdr start
  ├─ [[startup]] bun src/entrypoints/open.ts --background      the board, as today (#144)
  └─ [[startup]] bun <wake start>                             new, separate, never awaited by the board
        reads config.json → off: exit 0 (no herdr call)
        old herdr-wake installed → exit 0, status "held"
        /status answers → exit 0
        its pane restored as a bare shell → close that tab
        open plugin pane "wake" in workspace "Wake" → exit 0 (always 0, within a deadline)

pane "wake":  <wake supervisor>  ── spawns ──>  <wake process>
                restarts it after a crash        port 127.0.0.1:12421 (API + single-instance lock)
                (2 s, 10 s, 30 s; stops after    sessions seen, reaper, sleep, wake,
                 5 crashes in 10 min, shows      Telegram router, per profile
                 the error)                       wake = pane run "board resume <id> --profile <id>"
                health check on its API

board process ── HTTP 127.0.0.1:12421 ──> wake process   (same paths and answers as today)
```

- **Config:** a `wake` section in the board's config.json (call 1):

  ```json
  "wake": {
    "enabled": false,
    "reaper": { "enabled": false, "idleMinutes": 60, "exclude": [], "maxPerRound": 3 },
    "telegram": "auto",
    "port": 12421
  }
  ```

  `telegram` is `auto` (on when a tg-mcp url and token are found, as today) or `off`. The old
  plugin's other keys keep their names and defaults (`url`, `authorization`, `server`,
  `wakeTimeoutSec`, `pollTimeoutSec`, `listSleepingDays`), plus `workspace` (default `Wake`).
  `wakeCommand` goes: every wake is `board resume` (below). `"wake": false` is the same as
  `enabled: false`. A config.json that does not parse counts as off for wake (call 2).
- **Off by default** (call 3). A board without a `wake` section, or with it off, starts no process,
  opens no pane or workspace, installs no hook and makes no new herdr call: every setup that has
  not turned it on stays as it is. Turning it on is one switch in Settings.
- **Which URL the board uses** (call 4): with wake on, `http://127.0.0.1:<wake.port>`; with it off,
  `wakeUrl` exactly as today, so a setup running the old plugin keeps working untouched.
- **Live settings.** The wake process follows config.json (`liveConfig`): off closes its API and
  ends it with 0, and the supervisor does not start it again; the reaper and Telegram switches
  start or stop their loops without a restart (today they need one).
- **Its own workspace, `Wake`** (call 5), not the board's: the board's start creates its own
  workspace at the same moment, and two starts racing to create one workspace could make two. It
  also works with every `placement`. The `tg-router` workspace is not reused (decision 6).
- **API:** the same paths and the same answers as today, so `src/integrations/herdr-wake.ts` and
  every caller stay as they are. The PR that adds it compares the answers with the old router's on
  the same fake herdr.

## Safeguards against "nothing starts"

1. **The board's start never waits for wake.** Wake starts from a `[[startup]]` entry of its own;
   `open.ts` is not changed and does not know wake exists. A test opens the board with wake's start
   failing, hanging and missing. (If herdr's startup entries turn out not to be independent, see
   the open question.)
2. **A start that cannot hurt.** Wake's start reads config.json before anything else and exits 0
   when wake is off. It always exits 0, within a deadline, errors going to `wake.log`. It retries
   `herdr api snapshot` a few times within that deadline (today's start.mjs gives up at once).
3. **A second way in** (call 6). When wake is on and does not answer, the board process starts it
   once, detached and not awaited, after its own start is done; also at once when the switch is
   turned on (Settings or config.json by hand). So one failed startup entry is not the end of it.
4. **A supervisor with backoff.** The wake pane runs a supervisor that starts the wake process and
   starts it again after a crash: after 2 s, 10 s, 30 s, the policy of `core/crash-policy.ts`. After
   5 crashes in 10 minutes it stops, keeps the last error on screen and in its status file, and the
   board shows "Crashed" with that error. No endless loop.
5. **A hang counts as a crash** (call 7). The supervisor asks the wake process's API now and then;
   no answer several times in a row and it ends the process, which counts as a crash.
6. **A pane restored as a bare shell is replaced**, as #144 does for the board: wake records its pane
   and the supervisor's process (as `board.json` does); a recorded pane whose process is gone is
   closed (its whole tab, as other plugins add panes to every tab) and a new one is opened. Tabs in
   the `Wake` workspace with nothing but shells or sidebar panes are closed too; a tab with an agent
   in it never is (call 8).
7. **One instance, held by its port.** A second wake process finds the port taken and, when what
   answers there is a wake, exits 0 quietly. A port held by another program is an error the status
   shows.
8. **Not while the old plugin is installed.** Wake's start asks `herdr plugin list` once (not in any
   hook) and does not start while `herdr-wake` is installed; the board shows why.
9. **Wakes only through `board resume <id> --profile <id>`** (#148): `board resume` sets the
   session's profile itself, whatever the pane's shell has.
10. **Never put to sleep a session it cannot wake** (call 9). A session is put to sleep, by the
    reaper or on request, only when all hold: `board` is found on PATH (as the resume reporter
    checks, `adapters/resume-report.ts`); the session's profile folder is known (its card, a listed
    profile, or the default one); its transcript is in that folder. Otherwise it is refused with
    the reason, and the reaper leaves it up.
11. **Atomic writes of its session file:** a temporary file, then a rename, as
    `adapters/json-store.ts` does. One writer, the wake process.
12. **A kill switch in config.json:** `"wake": false` (or `enabled: false`), read first by wake's
    start, the wake process and the hooks, before any herdr call.
13. **The board is never held up by a wake that hangs** (call 10). With wake on, `sleepers()` gives
    the last list it has at once and asks again in the background, so a refresh never waits on
    wake. With wake off, the old path (`wakeUrl`) is as today.
14. **Sleeping sessions and reminders survive wake being down** (call 11). With wake on but not
    answering, the board lists sleeping sessions from wake's session file (read only, with the panes
    herdr shows as shells), so their cards stay, and the scheduler counts a reminder for one as
    waiting, not as gone: no cron reminder is dropped because wake was down. With wake off, as today.
15. **Sessions come back without wake.** herdr resumes running sessions after a restart by itself,
    in their profile through `board resume` (#148); wake is not on that path and must not become
    part of it.

## What the owner sees

**Settings → "Sleep and wake…"** (call 12), a panel like Phones… and Profiles…:

- **Sleep and wake: On / Off.** Everything. On starts it at once; off stops it, closes its pane and
  the `Wake` workspace when nothing else is in it (call 13).
- **Its state, one line:**
  - *Off.*
  - *Starting…*
  - *Running* since 09:12, 4 sessions asleep.
  - *Crashed:* stopped after 5 crashes in 10 minutes, the last error's first line; "Start again"
    (closes its pane and opens a new one, the path a stale pane takes, so the supervisor needs no
    control channel; call 14) and "Log" (`wake.log`).
  - *Not running* (on, but nothing answers and no crash was recorded: its pane was closed by hand,
    say), with "Start".
  - *The separate herdr-wake plugin does this now*, with "Switch over…" (Migration).
  - *Port 12421 is taken by another program.*

  The owner asked for running, crashed and off; the other three are for the cases that are neither
  (call 15).
- **Put idle sessions to sleep: On / Off**, after [60] minutes, and the sessions never to put to
  sleep (names, workspaces or `/regex/`).
- **Telegram messages (tg-mcp): Auto / Off**, with what it found: "connected to <host>", "no tg-mcp
  set up" (no url and token in `~/.claude.json` or the config), or the last poll error.
- Everything there is also in config.json's `wake` section; an edit by hand takes effect the same
  way.

**Elsewhere:**

- **Toolbar:** nothing while wake is off or running. On but not running for more than a minute: a
  quiet "Wake stopped" note, like "Setup incomplete", that opens the panel (call 16).
- **Cards:** sleeping sessions as today. A Work session now has "Put to sleep", "Wake" and
  "Restart" that work.
- **`board doctor`:** the `wake` line says on, off, running, crashed (with the error), held by the
  old plugin, or not answering, and how to fix it. "Needs Node.js 20" and the three herdr-wake
  commands go.
- **herdr:** a `Wake` workspace with one tab, the wake pane (its log on screen). Actions
  `agent-board.sleep` and `agent-board.wake` for the focused pane, as `herdr-wake.sleep` and
  `herdr-wake.wake` were.

**After a restart of the computer, with wake on:**

1. herdr starts and restores its workspaces. The board opens (#144), whatever wake does.
2. Wake's start finds its restored pane a bare shell, closes that tab and opens a new wake pane. A
   few seconds later it answers.
3. herdr resumes the sessions that were running, in their profiles (#148). Wake plays no part.
4. Sleeping sessions' panes come back as shells. Wake still lists them (its session file, by pane
   id), and wakes each on demand in its own profile.
5. If wake cannot start: the panel and `board doctor` say why, sleeping sessions stay on the board,
   and everything else works.

## Profiles

- **Registry and transcripts per profile.** The wake process reads running sessions from every
  profile folder the board reads (`deps.homes.liveSessions`, as `services/board.ts collect` does:
  the board's own folder and every listed profile, hidden ones too). The check for scheduled jobs
  reads the transcript in the session's own folder. This fixes #150 for the new wake: `/sleep`, the
  reaper and `/wake`'s wait for the session work in every profile.
- **Wake through `board resume <id> --profile <id>`.** `--profile` when the profile is known and its
  id a plain word (as `core/resume.ts` reports it); `board resume` takes the folder from the card
  first anyway. This fixes #151 for every wake: Telegram, SendMessage, the action, the board's own.
- **`board resume` goes to the session's folder itself** (call 17): from its card, when it differs
  from the current one and exists. Wake then types one line that every shell runs, without today's
  `cd '<dir>'; ` (which cmd does not have) and without quoting a path. In a pane herdr restored the
  folder is already the session's, so the #148 path does not change.
- **Clearing the prompt line** by the pane's shell (herdr's process info), not by wake's OS: Esc for
  PowerShell and cmd, Ctrl+U for bash, zsh, fish and sh; an unknown shell as today (call 18).
- **The board's own wake guard** (call 19). Today the board refuses to wake a session where the
  pane's shell may lack its profile (`mayWake`), because herdr-wake resumes in the shell's env.
  With the new wake on, every wake sets the profile itself, so the guard becomes the "can wake"
  rule of safeguard 10. With wake off (the old plugin, or none), the guard stays as it is.
- **Hooks in every profile.** The ListAgents and SendMessage hooks are written into every shown
  profile's settings.json, as the board's install writes its own (`entrypoints/install.ts`), each
  with its backup; a profile shown later gets them with the board's (Install in the Profiles
  panel). Only while wake is on (call 20): turning it on writes them, Install writes them while it
  is on, and they read config.json first and do nothing (no HTTP call) once it is off. They run
  with the Bun the install ran, as the board's hooks do. They are not added to the board's
  SessionStart / UserPromptSubmit hook: nothing new runs on every prompt.
- **SessionStart, one report** (call 21). Today the board reports `board resume` to herdr for a
  session outside `~/.claude` (#148), and herdr-wake's own hook reports its `wakeCommand` for every
  session when that is a launcher (claude-tg). Merged: outside `~/.claude`, as today; in
  `~/.claude`, only while wake is on and `launch.claude`'s program is not `claude`, which keeps what
  herdr-wake's hook did for claude-tg. Every other session: nothing, as today. `herdrWakeResumes`
  stays for setups that still run the old plugin.
- **Telegram's tg-mcp url and token** from the `wake` section, else the `telegram` MCP server in
  `~/.claude.json`, as today; other profiles' `.claude.json` are not read (call 22).

## Every function, where it goes

| Today (herdr-wake) | In the board |
| --- | --- |
| Reaper (`reapPlan`, `reapRound`) | the wake process; registry and transcripts per profile; the "can wake" rule; on/off live |
| A user's `/exit` counts as sleep (`exitedPanes`) | the same |
| `POST /sleep`, `POST /wake`, `GET /sleeping`, `/awake`, `/status` | the same paths and answers; per profile; wake through `board resume` |
| `sessions.json` | wake's session file in the board's state folder, written atomically; read by the board only when wake does not answer |
| Router pane, `start.mjs`, startup entry | wake pane, wake start and supervisor in the board's manifest |
| Sleeping cards, Put to sleep, Wake, Restart, `board sleep`, `board restart`, reminders that wake | unchanged callers, through the same API; Work sessions now included |
| PreToolUse SendMessage, PostToolUse ListAgents hooks | a board hook entrypoint, every shown profile, while wake is on |
| SessionStart hook (launcher `wakeCommand`) | merged into the board's resume report (call 21) |
| Telegram router (`route.mjs`, `topics.mjs`, poll, ack) | a module of the wake process; Auto/Off, live |
| claude-tg, `claude-tg-key.mjs` | the same launchers, the key from `board tg-key`, no Node (call 23) |
| Actions `herdr-wake.sleep`, `.wake` | `agent-board.sleep`, `.wake` |
| `--deliver`, `--reap-dry` | the same, on the wake entrypoint |
| Development-channels confirm, trust question | the board's `core/dialogs` |
| `router.log` | `wake.log` in the board's state folder, rotated at 2 MB |
| `config.json` of herdr-wake | the `wake` section of the board's config.json |

## Migration from the separate herdr-wake plugin

**While the old plugin is installed** nothing changes: the board talks to it at `wakeUrl` as today,
the new wake does not start (safeguard 8), and the panel says "The separate herdr-wake plugin does
this now" with "Switch over…".

**"Switch over…"** (call 24) asks once, listing what it will do, then:

1. takes over the old config into the `wake` section, once (reaper, exclude, Telegram url, token
   and server, port, timeouts); the old file is left where it is;
2. takes over the old sleeping list into wake's session file, once, so no sleeping session is lost;
3. compares the old `wakeCommand`'s program with `launch.claude`'s and, when they differ
   (`claude-tg --resume {session}` against `claude`), says so and how to set `launch.claude`; it does
   not change `launch.claude` (call 25);
4. uninstalls the old plugin (`herdr plugin uninstall herdr-wake`), after steps 1 and 2, in case
   that removes its folders;
5. removes the old hooks from every profile's settings.json (the entries
   `install-hooks.mjs` recognises), each with a backup, and writes the new ones;
6. closes the `tg-router` workspace, when nothing but shells and sidebar panes is in it;
7. turns wake on and starts it;
8. names herdr key bindings that call `herdr-wake.sleep` or `herdr-wake.wake` (in herdr's
   config.toml, read as `board doctor` reads the key) with their new names; it does not rewrite
   config.toml (call 26).

The panel then shows what was taken over ("reaper on, 60 min, 2 excluded; Telegram; 4 sleeping
sessions") and "Running".

**Uninstalled by hand.** When the owner removes the old plugin themselves and turns wake on, the same
takeover runs once at wake's first start (a marker in the state folder), with the same steps but
the uninstall, from whatever herdr left of the old plugin's config and state folders.

**Left as they were:** claude-tg launchers someone else wrote (the install replaces only files that
start with the `herdr-wake:` comment); the old plugin's config and state folders. `herdr-wake/` stays
in the repository one release, its README pointing to the board.

## Everyone's setup

| Setup | What changes |
| --- | --- |
| Board only, no herdr-wake (most teammates) | Nothing until wake is turned on: no process, pane, workspace, hook or herdr call. A new Settings item; the doctor's `wake` line loses "needs Node.js 20". |
| The old herdr-wake plugin | Nothing until "Switch over…" or its removal; `wakeUrl`, the board's guard and its hooks as today. |
| One Claude profile, wake on | As herdr-wake today, without Node. |
| Several profiles, wake on | Sleep, wake, restart and the hooks work in every profile (#150, #151). |
| pi, Codex, Claude Code through pi's bridge | Their panes are not Claude panes to wake: never put to sleep or woken; their `pane-<id>` keys never reach `board resume`. |
| Windows, macOS, Linux | Bun on all three; hooks and launchers without Node; the prompt cleared by the pane's shell. |
| `wakeUrl` set to another address | Used as today while wake is off; with wake on, the board uses `wake.port` and the doctor says `wakeUrl` is not used. |
| MokuPilot, notifications, `HERDR_BOARD_CARDS_DIR` previews | Not touched. |

## Testing

- **Ported tests** (34) on `bun test`, unchanged in what they check.
- **New, for what had none:** sleep, wake, the API, the poll, on `test/support/fake-herdr.ts` and a
  sandbox; API answers compared with the old router's on the same fake herdr.
- **Profiles:** sleep and wake of a session in `~/.claude-work`, in a profile with a Windows path,
  with spaces, other alphabets and `%` in folder and name; `board resume` typed with the right
  `--profile`; a session whose profile is unknown, or with no `board` on PATH, is not put to sleep.
- **"Nothing starts":** the board opens when wake's start fails, hangs, or is missing; wake's start
  exits 0 within its deadline when herdr does not answer; a restored bare-shell wake pane is
  replaced; 5 crashes in 10 minutes stop the supervisor with the error in its status; a hung API is
  ended; a second instance exits 0; the old plugin installed holds it; `"wake": false` makes no
  herdr call.
- **Untouched setups:** with wake off, the board makes exactly today's calls (the old `wakeUrl`
  path, no new herdr call, no new hook in settings.json); the hook that runs on every prompt is
  byte-for-byte the same; the manifest's board entries unchanged.
- **Manual run on the owner's machine:** a Work and a Default session asleep, the computer
  restarted, both woken in their profiles; Telegram to a sleeping Work session; ListAgents and
  SendMessage from a Work session; wake's pane closed by hand; "Switch over…" from an installed old
  plugin.

## The open question: does herdr run several `[[startup]]` entries independently?

The manifest has one startup entry today. Safeguard 1 assumes herdr runs a second one without the
first waiting for it. Nobody has checked: herdr may run them in parallel or one after another, may
wait for each to end, may stop at the first that fails, and the order may not be the manifest's.

**How the builder finds out**, first thing in the lifecycle PR, before code depends on it:

1. Read herdr's plugin documentation and source on startup hooks, for 0.9.2 (the manifest's
   minimum) and 0.9.5.
2. Try it: a throwaway plugin (`herdr plugin link`) with four startup entries: A writes the time to
   a file and exits 0; B sleeps two minutes; C exits 1 at once; D writes the time to another file.
   Restart herdr and read the times; again with B and C first. On a herdr that may be restarted:
   a test machine, or the owner's with their OK.
3. Write the answer into #119 and the PR.

**What to do with each answer:**

- *Independent* (in parallel, or in order without waiting): as designed.
- *In order, each awaited:* the board's entry stays first. Wake's start has its deadline and always
  exits 0, so nothing waits on it long; the board never waits on it at all.
- *Stops at the first failure:* wake's start never fails (it exits 0). The board's start failing
  would leave wake unstarted; safeguard 3 starts it from the board process later.
- *Only one entry runs, or the order cannot be relied on:* one startup entry, the board's.
  `open.ts --background` spawns wake's start detached as its first act, only when wake is on (it
  reads config.json first already), not awaited, its output not kept. The board's start then does
  one spawn more with wake on and nothing more with it off. This touches `open.ts`, so it is tested
  against #144's cases.

## Proposed PRs

Each starts from an issue under #119, has tests that fail on `main` and pass with it, shows the
setups it must not touch are unchanged, and says whom it touches. In this order:

1. **Pure parts into `src/core/wake/`:** reaper plan, routing, topic keys, prompt format, config
   resolution, the "can wake" rule; the 34 tests on `bun test`. Nothing runs yet. Touches no setup.
2. **The wake process:** sessions seen (atomic file), sleep, wake through `board resume`, registry
   per profile, the API with today's paths and answers; `board resume` going to the session's
   folder (call 17). Run by hand only. Fixes #150 and #151 for the new wake. Touches `board resume`:
   compared on restored panes of every profile.
3. **Lifecycle:** the manifest's wake pane, startup entry and actions; wake start, supervisor,
   health check, stale pane, one instance, old-plugin hold, kill switch. Starts with the open
   question. Test: the board opens whatever wake does. Off by default: touches no setup.
4. **The board side:** the `wake` section, Settings → "Sleep and wake…" with its state, the toolbar
   note, English and Russian, the URL from the section, the non-blocking `sleepers()` and the file
   fallback, the scheduler's "waiting", the guard switch (call 19), `board doctor` without Node.
   Test: with wake off, the board's calls are today's.
5. **Hooks:** ListAgents and SendMessage in a board hook entrypoint, in every shown profile while
   wake is on; the merged SessionStart report. Test: the every-prompt hook unchanged; no hook
   written with wake off.
6. **Telegram router and claude-tg:** the poll module, Auto/Off, `board tg-key`, the launchers
   without Node.
7. **Migration and docs:** "Switch over…" and the takeover at first start, the old hooks out,
   `tg-router` closed, key bindings named; README (Setup step 4, Claude profiles "Waking stays in
   the profile", Restart, Several to sleep, Settings, Development); `herdr-wake/` marked
   deprecated. Last, so nobody switches before every function they use is in (call 27).

If the port takes long, #150 can get a small fix in `herdr-wake/src` first (registry from every
profile folder), and #151 has its workaround (`"wakeCommand": "board resume {session}"`).

## Calls made in this design (the owner can overturn them)

1. The settings are a `wake` section in the board's config.json, with the old keys' names.
2. A config.json that does not parse counts as wake off.
3. Wake is off by default; turning it on is one switch.
4. With wake on the board uses `wake.port`; with it off, `wakeUrl` as today.
5. Its pane lives in a workspace of its own, `Wake`, not in the board's.
6. The board process starts wake once when it is on and not answering, and when it is turned on.
7. A wake process whose API stops answering is ended by its supervisor, as a crash.
8. Wake's start closes tabs in `Wake` with only shells or sidebar panes; never one with an agent.
9. "Can wake" = `board` on PATH, the profile folder known, the transcript there; nothing else is
   put to sleep.
10. `sleepers()` does not wait on the new wake (the old path keeps its 2 s wait).
11. With wake on but down, sleeping sessions come from its file and reminders wait instead of
    counting as gone (the old path unchanged).
12. The switch lives in Settings → "Sleep and wake…", a panel like Phones….
13. Turning wake off closes its pane, and its workspace when nothing else is there.
14. "Start again" closes and reopens the pane; no control channel to the supervisor.
15. Three states beyond the owner's three: not running, held by the old plugin, port taken.
16. A toolbar note only when wake is on and not running for over a minute.
17. `board resume` goes to the session's folder itself, so wake types no `cd`.
18. The prompt line is cleared by the pane's shell, not by the OS.
19. With the new wake on, the board's wake guard becomes the "can wake" rule.
20. The ListAgents and SendMessage hooks are written only while wake is on, and are inert when off.
21. One SessionStart report: as today, plus `board resume` in `~/.claude` when wake is on and
    `launch.claude` is a launcher.
22. tg-mcp's url and token from `~/.claude.json` only, as today, or the `wake` section.
23. claude-tg is refreshed by the install only where a herdr-wake one is already there; a new one
    from the panel once Telegram is set up.
24. "Switch over…" does the whole move on one confirmed click, the old plugin's uninstall included.
25. A different launcher in the old `wakeCommand` is reported, `launch.claude` not changed.
26. Key bindings to the old actions are named with their new names, config.toml not rewritten.
27. Migration is the last PR.

## Left to the builder

- Module split and file names (for example `src/core/wake/*`, `src/services/wake/*`,
  `src/entrypoints/wake.ts`, `wake-run.ts`, `wake-start.ts`, `wake-hook.ts`), and whether the
  supervisor shares code with `run.ts`.
- The port (12421 recommended, so tg-mcp setups and old hooks keep pointing right), the start
  deadline, the health check's interval and misses, and the crash backoff (reuse `crash-policy.ts`
  unless there is a reason not to).
- Whether a code change restarts the wake process at once, as `run.ts` does for the board, or once
  no wake, sleep or delivery is under way.
- The status file's shape, and how the board reads it with the API.
- How the reaper reads transcripts without blocking (cached by mtime, as today, or async).
- The panel's layout and words (follow Phones… and Profiles…), and the terminal board's line.
- What the takeover does with an old config key it does not know (kept in the section, as unknown
  fields are).
