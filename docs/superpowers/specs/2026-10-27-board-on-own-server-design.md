# agent-board on your own server: herdr, Claude Code and the board on a host, reached through Caddy — design

Date: 2026-10-27 · Branch: `idea/experiment` (local only; no issue, no pull request yet: the owner's
idea, not announced). Builds on the remote tunnel (PR #168, merged): its login of the board's own,
its server setup (Look, the cases, Apply, Undo, the one command) and its password login over ssh.
Calls made in this document, not the owner's, are numbered in "Calls" and marked **(call N)**.

## Intent

Today the board runs on the owner's PC, and a tunnel makes it reachable at `https://<domain>`. The
owner wants a second way: the whole thing on a server of theirs, so the agents keep working when
the PC is off, and the board is still reached through a domain:

- herdr and Claude Code run **directly on the host** (not in a container), with the board as
  herdr's plugin, exactly as on a PC;
- the board's web is reached from outside through **Caddy**, with the board's own login;
- it is **part of the product**: anyone can deploy it this way, and it will grow. The next step,
  not in this design, is copying the local Claude profiles to the server safely (settings, hooks,
  skills, CLAUDE.md, never credentials), so the owner only signs in to Claude there.

The owner first thought of the web board in Docker for convenience. It is not: the web board drives
herdr (its socket), reads `~/.claude`, the projects and their git, and Claude's hooks call `board` on
the host. A container would need all of that mounted, which isolates nothing and adds moving parts.
Convenience comes from a one-command install and a service instead.

## Decided with the owner (2026-10-27)

- **Part of the product**, not a personal script.
- **No Docker for the board.** herdr, Claude Code, Bun and the board on the host.
- **A user of its own**: `agent` by default, not root, no sudo unless asked for with a flag.
  Claude Code as root is dangerous, and it refuses `--dangerously-skip-permissions` as root.
- **Two ways to install, one script**:
  - **A.** On the server: `curl -fsSL https://raw.githubusercontent.com/MokuTeam/herdr-agent-board/<ref>/<script> | sh`.
    Any pushed branch works (the repo is public); `--ref <branch>` installs the board from it.
  - **B.** A button in the local board ("Install the board on this server"), over the admin
    password login it already has. It sends the same script, and the board's code from the local
    checkout (`git archive`), so a local branch is tried on a server with no commit or push.
- **The first login: a one-time link.** The installer prints `https://<domain>/setup#code=<code>`.
  The code is random (128 bits or more), single-use, valid for 1 hour, stored on the server only as
  a hash, and travels in the fragment (never sent to the server, never in Caddy's log or a Referer).
  At that page the owner sets the password and the code (TOTP), and may add a passkey. Once the
  login is set, `/setup` is closed for good. A new link only comes from `board login reset` in an
  ssh session on the server. Until the login is set, every other route answers 401.
- **The owner's domain**: `workbench.migontech.online`, beside the tunnel's
  `board.migontech.online`. The local board and its tunnel keep working; the two boards are
  independent. The owner adds the DNS record; the board checks it and warns, as the tunnel's Look does.
- **Updates**: one command on the server (`board update`).
- **Claude's sign-in** on the server is the owner's own (`claude login` as `agent`, over ssh).

## Goals

- An empty Debian 12/13 or Ubuntu 22.04/24.04/26.04 server to `https://<domain>` serving the
  board with its login: one command (or one button), then the setup link.
- The server's existing sites are never broken: the tunnel's server setup guarantees all hold.
- After a reboot everything is back with nothing typed: herdr, the board, its listener.
- The board on a server behaves like the board on a PC: cards, sessions, new sessions, the
  terminal, wake, schedules.

## Non-goals

- Building the profile sync now: it is the next step, sketched below so this step leaves room for it.
- Docker for the board, macOS or Windows servers, several boards on one server.
- The projects' own git credentials on the server; the owner sets those up.
- Firewalls; DNS records (checked, not made).

## Anti-goals

1. **The board reachable without its login.** The web board's own port (127.0.0.1:12422, no
   login) never leaves loopback. Anything the domain reaches goes through the login listener.
2. **Root for the agents.** herdr and Claude Code never run as root.
3. **The setup code seen anywhere but the installer's own output**: not in a log, not in Caddy's
   access log, not in shell history, not in a file in plain text.
4. **Breaking the server's sites or the owner's ssh**, as the tunnel's setup spec has it.
5. **A PC board changing**: a board with no server mode set goes down exactly the code it went
   down before.

## How it fits together

- **The listener without ssh** (call 1). The tunnel's login listener today starts only with the
  tunnel on. A server mode starts it alone and has it listen on a **Unix socket** in the board's
  socket folder (`2750`, the web server's group), the same path the tunnel's ssh makes on the
  server. So Caddy's side is unchanged: the tunnel's cases 1–4 (the board's Caddy, their Caddy
  as a service, their Caddy in Docker on a network or the host's, nginx with 8443) put the domain
  in front of that socket exactly as they do for the tunnel. No ssh, no reverse forward. The
  builder may pick loopback TCP instead if the socket does not fit, and says why.
- **The install script** (call 2), run as root (or re-run with sudo, as the one command does):
  1. checks the OS and what it needs (curl or wget, git, gzip, unzip as Bun needs);
  2. makes the `agent` user (refused, as the tunnel user is, when a person's account has that
     name), its home, and lingering (`loginctl enable-linger agent`) so its services run with no
     login;
  3. as `agent`: Bun, herdr, Claude Code, each from its own official installer, and the board
     from the ref (git clone, or the archive path B sent), then `herdr plugin link` and the
     board's `install` action (its hooks and the `board` command);
  4. a **systemd user service** for `agent` that starts `herdr server`; herdr's startup hooks
     then open the board and wake, as on a PC;
  5. the board's server mode in its config: the domain, the socket;
  6. the web server: the one command's Look, plain plan, `[y/N]`, Apply with rollback, record and
     Undo, with the server mode's socket as the target and no tunnel user;
  7. the setup link, printed once.
  Safe to run again: what is there is kept; it then acts as an update.
- **Undo**: one command, as the one command's Undo, plus the service, and (only when asked for)
  the `agent` user and its home.
- **`board update`** (as `agent`): fetches the ref the board came from, installs, and lets the
  board restart itself (run.ts restarts the board when its code changes).
- **Path B**: in the local board's Remote access panel, on its Server tab, a card of its own
  beside the tunnel's ("The board on the server"): "Install the board on this server". The same
  server, login and password (the Server tab's login, once at its top), and an address of its
  own ("Address of the board on the server", `tunnel.install.domain`; never the tunnel's, which
  would move the tunnel); Look shows the plan;
  Apply sends the script and the archive over the existing password login and streams its output
  into the panel; the setup link is shown there, once.
- **The version on the server, on the card** (core/server-board.ts): the install's Look, and a
  Look of its own on the card (the probe, then one round as root that only reads root's
  `install.json`, the user it names, its sudo and herdr's service), read the version the server
  has: "version <short commit> (with local changes), installed <when>", or "not installed", or "not
  known yet" before the board looked at that server since it started (kept in its memory only;
  never the repository, whose URL may carry a token). The Server tab looks again by itself when it
  opens while the board remembers the password; without one, the card says when it saw it and to
  Look. When the local checkout's commit or its local-changes state differs, "An update is
  available" and the main button reads Update (Install again when the same).
- **Remove the board from this server**, on the card once it is installed: its own Look (the
  install's `--undo` plan in its own words, `undoWill`, shared with the script; the web server's
  part the server mode's record alone, never the tunnel's), a tick "also remove the user agent and
  its home" off by default with what it deletes said once ticked (offered only for the installer's
  user), then Remove: the pack sent as the install's, its bootstrap's `--undo [--remove-user] --yes`
  over the same login, its output streamed into the card. Refused while anything runs.
- **Working with herdr directly**: `ssh agent@server`, then `herdr` attaches to the running
  server, as on any machine.

## Beside the tunnel on one server (built after "Next step" was written)

The owner's server has the PC board's tunnel set up already (case 3a). The two setups live side by
side, independent (`core/server-texts.ts` Names):

- **Each its own names.** The tunnel's are what they were (`/etc/agent-board`, its site file,
  `# >>> agent-board`, `agent-board-socket`, 8481). The server mode's: `/etc/agent-board-server`
  (record, lock, runs, backups, its own Caddy's config, and the installer's `install.json`),
  `/etc/caddy/agent-board-server/board.caddy` and its import line, `# >>> server agent-board`
  (no marker starts as the other's: a block is found by the start of its first line), nginx's
  `agent-board-server.conf`, `agent-board-server-{caddy,socket}` with the roles `server-caddy` and
  `server-socket`, 8482 for its 3b helper (its own Look watches it), its own candidate file.
- **The other's parts are theirs.** A container of the other board's is neither ours nor free: its
  site in their Caddyfile is one of their sites (fetched before and after a reload, kept
  answering); its helper another container. Each Undo takes its own parts only; Docker is not
  offered for removal while the other's containers are in it. The tunnel's flow on a server
  without the server mode is byte for byte what it was (its Look, plans, runs, Undo and plain
  words, compared on every fixture and support case); the one command's awk agrees.
- **Cases 2, 3a, 3b** live side by side in both orders. **Cases 1, 1b, 4a, 4b** (the board's own
  Caddy) do not: one host's 80 and 443 hold one Caddy. Where the other setup's own Caddy holds a
  port the case needs, Look says so (`otherBoard`) and changes nothing. Sharing that Caddy (one
  Caddyfile with both sites, Undo of either rebuilding it for the other, the one command's awk
  too) is left for the owner to decide.

## Next step: syncing the Claude profiles (sketch, decided with the owner)

Not built in this step. Written down so the server mode leaves room for it.

- **Manual and both ways.** The owner starts each sync and picks its direction: PC → server, or
  server → PC. Nothing syncs on its own.
- **A preview first.** It lists every file that would be added, changed or deleted. It also lists
  what was held back (secrets), what was rewritten (paths), what can't go (Windows-only hooks, local
  MCP programs), and the conflicts. The owner confirms, then it applies.
- **Everything, at every level**, of each profile folder (`~/.claude`, `~/.claude-work`, …), except:
  - **secrets, never in either direction:** `.credentials.json`, the OAuth part of `.claude.json`,
    keys and tokens in `env`, MCP headers and env, and hooks. Every file is scanned for secret
    patterns, and what is found is cut out and shown. Each side keeps its own secrets: files such as
    `.claude.json` and `settings.json` are merged by key, never replaced whole;
  - **what belongs to one machine only:** `cache`, `shell-snapshots`, `session-env`, `sessions`,
    `ide`, `daemon*`, locks, `telemetry`, `debug`, `backups`, and the plugins' own files (the target
    installs the same plugins from their marketplaces).
- **Paths are rewritten both ways.** `projects/<encoded path>` folders are named after the project's
  absolute path (`C:\migo\x` → `C--migo-x`).
  - A local project is paired with its clone on the server by git remote, and its folder is renamed
    for the target's path.
  - Inside, the memory and the sessions go across, with the paths (`cwd`) in the transcripts
    rewritten.
  - `history.jsonl` and `.claude.json`'s project entries follow the same pairs.
  - An unpaired project is listed, and the owner gives its path or leaves it out.
- **The board's own hooks never go across**: each side's installer writes its own. Other hooks with
  Windows paths stay behind and are listed.
- **Conflicts.** Each side keeps the hashes of the last sync.
  - A file changed on both sides since then is a conflict. The preview shows both, and the owner
    picks per file; the default is to keep the target's.
  - Deletions are shown and apply only when ticked.
- **Size.** About 1.7 GB the first time for the owner's two profiles (mostly `projects`), packed,
  over ssh. Afterwards only what changed.
- **How the local board reaches `agent`**: the builder of that step decides between the admin's
  password and a key the install adds, limited to the sync's own command.

### As built (after the sketch above)

- **The password remembered 30 minutes.** The sync logs in as the server setup does (the admin's
  login, the server's key pinned by its Look, the password typed in the panel's Server tab, sudo's
  alone first). The owner changed "asked every time" to "remembered 30 minutes in the local board's
  memory": once a login with them went through, the local board keeps the admin's password (and
  sudo's, when it is its own) in its process memory only, never on disk, in config.json, web.log,
  a payload, an answer or the browser's storage, for 30 minutes since its last use, each use
  counting again (`services/held-passwords.ts`). Every server action (Look, Apply, Undo, Install,
  the sync's preview and apply, the folder listing) that carries none gets it; one the server
  refuses is dropped, never held; "Forget the password" and a restart of the board drop it too.
  The panel shows "Password remembered until HH:MM" next to the field (the view's
  `server.passwordHeld`, until when only) and asks nothing while it holds one. Over the tunnel or
  Tailscale `/api/access` stays refused, so only the local board's page reaches it. root reads the board's user and home from the install's record and runs
  the sync program (`entrypoints/profile-sync.ts`) as that user with `setsid -w runuser`: every
  file on the server's side is written by `agent`. A key limited to the sync would need the install
  to manage a second key in `agent`'s authorized_keys and a forced command parsing its arguments;
  left out.
- **Where the hashes live.** Each side, in the board's state folder: `profile-sync/<other side>.json`
  (each file's hash after the last sync, by profile), and `profile-sync/hashes.json` (hashes kept by
  size and time, so an unchanged file is not read again). The target records as it writes; the
  source once everything has arrived, so a sync cut short is sent again, not met as conflicts.
- **The transport.** One ssh per step (probe, sudo's check, scan; then apply, or pack and record),
  frames packed with gzip both ways on ssh's stdin and stdout.
- **Merged files** are `.claude.json`, `settings.json` and `history.jsonl`; they never conflict (each
  side keeps its own part). The board's own hooks and status line, herdr's hook and the board's
  skill for the agents (`skills/herdr-agents`) are each side's install's. A profile made on the
  server gets the board's hooks by its install action; the owner then signs in there (`/login`).
- **Limits.** A hook or MCP server removed on one side stays on the other (merges only add); a
  worktree is paired only by the path the owner gives; secrets are found by their known shapes
  (tokens, keys, JWTs, a URL's password, `--token x`), not every password a text may hold.
- **After the review (sync v2).** What changes how the target runs goes only in the groups the
  owner ticks, each apart, unticked by default, both ways (stricter words for server → PC): env,
  hooks (and `hooks/` scripts), the status line (and a top-level `statusline*` script), MCP servers,
  other programs (helper commands, plugins). The preview lists every key a merge adds or changes,
  each in its group. `*_BASE_URL`, `*PROXY*`, `NODE_OPTIONS` and `*_HEADERS` never go; a key of
  settings.json or .claude.json holding a secret stays (listed), never carried cut. Session and
  edit history (transcripts and what sits beside them, file-history, paste-cache, history.jsonl;
  not memory) has its own tick, its default `DEFAULT_SYNC_HISTORY` (off until the owner decides).
  `channels`, `local` are one machine's; `.env*`, `*.pem`, `*.key`, `id_*`, `settings*.json` but
  settings.json are secret files. Secrets are looked for in JSON's decoded strings, line by line;
  text not UTF-8 goes byte for byte (a BOM, UTF-16 kept); a file not text with a secret stays. A
  file a secret was cut from goes only where the target has none (else listed). Each file goes
  with the target's hash at Look: one changed since, or with a name differing only in case on
  Windows or macOS, is left as it is and listed. A merged file that is not a JSON object there is
  left as it is; a `.bak-profile-sync` copy is kept before its first merge, and it is merged again
  if a Claude session wrote it meanwhile (the preview asks for idle sessions). Modes are the
  target's own, or 0600 (0700 with the source's execute bit). Remotes cross as keys only. What a
  run cut short wrote is recorded. sudo runs with `-k`, so a cached ticket never lets the
  password line reach the program.
- **Path rules (after the owner's first preview: 32 projects, none paired).** "This PC folder is
  that server folder" (`core/profile-sync/rules.ts`), kept in the local board's config.json per
  server (`tunnel.syncPaths[<host>]`, not secret). A project under a rule's folder lands at the
  same place below the other one, both ways (`\` ↔ `/`, Windows' case ignored), the longest folder
  first; the owner's own path (or "leave out") wins over a clone by git remote, which wins over
  the same path, which wins over a rule; a worktree and a folder not there (on the server: one the
  sync placed whose project is not put there yet) go by a rule only. A rule
  is suggested from the projects without a place: their deepest common folder (never a drive or
  `/` alone, nor a folder above the home) to its name in the target's home (`C:\migo` →
  `/home/agent/migo`; one in the home to the same place in the other home); with none, one per top
  folder. The preview groups the projects by how they land and marks a target folder not there
  yet (asked of the server by the program's `exists`, looked at here for a sync to this PC). The
  folders are picked, not typed: the server's listed and made by the program's `dirs` and `mkdir`
  as the board's user (sync-dirs, sync-mkdir on /api/access, local only), this PC's by
  `/api/fs/dirs`. No git clone is made. Moves for `cwd`, history.jsonl and .claude.json come from
  the pairs only, as before: a left-out project's lines stay out.

## Later: each agent's own browser, watched and taken over from the board (decided with the owner)

Not built in this step. On the server only.

- **A desktop of its own per agent.** Each session gets its own virtual display, a real Chrome on
  it (headed, not headless, so pages look as they do for people), and that Chrome's own DevTools
  port. Its chrome-devtools MCP reaches only that port. The agent opens pages, clicks, takes
  screenshots, and reads the console and the network, without touching another agent's browser.
- **Many displays under one user.** Each display is an X server of its own (Xvnc, which also serves
  it over VNC), so windows never mix. Every agent runs as `agent`, so this keeps agents from
  getting in each other's way by accident; it is not a wall against one that tries.
- **On demand.** The display and Chrome start the first time the agent needs a browser, and stop
  when the session sleeps or ends. Each takes about 300–500 MB, so the server's memory limits how
  many are open at once.
- **Watched from the board: the whole desktop (A).** A "Browser" view on the session's card, over
  VNC in the page, through the board's login. It shows Chrome's tabs and address bar, system
  dialogs, file pickers and anything else on that display.
- **Taken over.** The owner can click and type there: sign in, a password or key, a captcha, 2FA.
  Then they hand control back. While the owner has control, the agent's browser actions wait.
  The page warns that the agent can see what is typed into its own browser.
- **The agent asks for it.** "Sign in to X for me" puts the card under "needs you", with "Open its
  browser" on it.
- **In the web board, without more buttons** (the owner: buttons keep piling up):
  - **On the card:** a small "browser running" mark, only on cards whose agent has one up. A click
    opens the session with its browser shown. Other cards look as they do now.
  - **Where it shows:** a "Browser" fold in the session panel, beside the thread, so what the
    agent writes and what it does are seen together. The panel docks or floats as today.
  - **Full size:** one click expands the desktop over the board's whole work area. Esc or × brings
    it back, and another × closes it.
  - **Closing the view only stops the picture.** No VNC stream, no traffic. The agent's browser
    keeps running.
- **Named browser profiles (B), for logins that last.**
  - The agent opens a profile by name (`github`, `client-x`). A new name makes a new profile.
  - The owner signs in once, and the login stays for every later session that opens that profile.
  - A session that names none gets a profile that lives and dies with the session.
  - Chrome lets one browser hold a profile at a time. A second agent asking for a busy profile gets
    a copy of it, which is thrown away afterwards and never merged back.
  - Profiles are keys to sites: they stay on the server and never go into the profile sync.

### As built: the server side (after the section above)

- **Where it lives.** `core/desktop.ts` (pure), `services/desktop.ts` (the desktops, in the board's
  process), `services/cdp-pipe.ts` and `entrypoints/cdp-pipe.ts` (Chrome's DevTools pipe and its
  holder), `server/routes/desktop.ts`, `services/browser-mcp.ts` (the wrapper),
  `adapters/desktop-files.ts` (the install's part). Server mode only: on a PC the board makes no
  desktop, adds no route and serves no WebSocket.
- **A desktop per session's pane**, on demand: a slot `n` is display `:100+n` (the lowest no
  desktop uses whose X lock is free, a lock whose server is dead cleared with its socket; 32 at
  most). Xvnc (TigerVNC)
  with VNC on a Unix socket only (`-rfbunixpath`, 0600; `-rfbport -1`, or it also takes 5900 + the
  display on every address; `-SecurityTypes None`: the
  socket is `agent`'s alone and the board's login is in front of it) and X for a cookie of its own
  (`-auth`, an Xauthority file the board writes; `-nolisten tcp`). Google Chrome headed on it, its
  window the whole screen (1440×900, no window manager), `--user-data-dir` of its own and its
  DevTools on a pipe (`--remote-debugging-pipe`, fds 3 and 4: no TCP port). Its holder
  (`bun entrypoints/cdp-pipe.ts <socket> <chrome> …`) runs it with the pipe and, once Chrome
  answers there, serves it on `sessions/<display>/cdp.sock` (0600 in the 0700 folder) to one client
  at a time: its own ids on the pipe (an answer for a client gone never reaches the next), and
  what a client set undone when it goes (auto-attach, which would hold every new page waiting for
  a debugger; discovery; its sessions). Xvnc and the holder in sessions of their own (`setsid`), so
  a restart of the board leaves them running (Chrome ends when its pipe closes, so the holder holds
  it); each is in `desktops.json` from the moment it is spawned, and the next board takes over what
  was up (pids checked against their command lines), ends what was still starting, and gives
  control back to the agent. Stopped when no session is awake in the pane for 2 minutes on end
  (asleep or ended: a restart's sleep and a refresh that misses the pane keep it), or at once when
  another session is in the pane (`/clear`). A named profile's copy is made without holding up the
  board, caches, service workers' folders and locks left out.
- **Where things are**: the board's state folder, `desktop/`: `sessions/<display>/` (the sockets,
  the cookie, the logs, the session's own profile, a busy profile's copy: gone with the desktop),
  `profiles/<name>/` (named profiles, kept), `mcp/` (chrome-devtools-mcp), `desktops.json`. The
  profile sync reads Claude's profile folders only, so the profiles never cross; the board's MCP
  server in `.claude.json` is never sent and never overwritten (each side's install's).
- **The wrapper** `board browser-mcp` (the MCP server `board-browser`, user scope, in every shown
  profile's `.claude.json`): its session is `HERDR_PANE_ID`, else its Claude's own environment. It
  runs chrome-devtools-mcp 1.11.0 (pinned, `--no-page-id-routing`, no usage statistics) with
  `--config <file>`: `wsEndpoint` the board's `GET /api/browser/cdp?pane=<pane>` (a WebSocket the
  board bridges to the holder's socket, one CDP message a text frame) and `wsHeaders` the board's
  local key, in a file of its own (`desktop/run/`, 0700; the file 0600, gone when it ends), never
  on a command line, which every account reads. Before each tool call it asks the board who has
  the browser; while the owner has it, or the board does not answer, the call waits (10 minutes,
  then "the owner has the browser" or "the board does not answer"); a JSON-RPC batch with a call
  in it waits as a whole. Then it asks the board to start the desktop, so what keeps it from
  starting is the call's answer. Its own tools: `browser_profile` and `browser_ask_owner`; the same
  as `board browser profile [<name>]` and `board browser ask <text>`. A profile switch is refused
  while the owner has the browser.
- **The interface** with the web page: the card's `desktop: { running, profile, control, asks }`;
  `GET /api/desktop/<key>/vnc?t=<file token>` (a WebSocket, raw RFB both ways, per-message
  deflate; the login, the token and the Origin; 404 without a desktop); `POST
  /api/desktop/<key>/control` `{ to }` → `{ ok: true, control }`, 409 for `owner` while no view is
  connected (the page's Take control waits for its view too). A view's keys, mouse, clipboard and
  resize reach Xvnc only while the owner has the browser: the board reads each viewer's RFB
  messages and drops the others' (bytes it cannot read close the viewer). The last view closing
  while the owner has the browser hands it back, and so does none being connected for 30 s.
  `asks` holds while the card still asks what `board browser ask` wrote (its `askSince`); handed
  back, that ask clears, a later `board ask` stays. The agent's calls (`/api/browser/start|call|
  profile|ask|cdp`) take the board's local key on every listener, so none comes through the domain.
- **The install**, as root: `tigervnc-standalone-server`, `fonts-noto-core`, `fonts-noto-cjk`,
  `fonts-noto-color-emoji`, `fonts-liberation`, and Google Chrome stable from Google's .deb on
  x86_64 (Debian's `chromium` on arm64 Debian). What it added is in `install.json`; Undo purges it
  only with `--remove-user`, as the user's Bun and herdr go only then. As `agent`: the MCP server
  in the profiles and chrome-devtools-mcp, by the install action in server mode (and the server
  mode's own step, which runs after it on a first install); Undo takes them out.
- **Ubuntu on arm64**, whose own Chromium is a snap: the board's own Chromium, Chrome for
  Testing's arm64 build put in place by Playwright's CLI at a pinned version
  (`bun x --bun playwright-core@1.64.1 install --no-shell chromium`, `PLAYWRIGHT_BROWSERS_PATH`
  `desktop/chromium/`), as `agent` by the install action, beside chrome-devtools-mcp; a new pin
  replaces the revision on the next install or `board update`, older ones are removed. No apt
  updates: it moves only with the pin. Its libraries (Playwright's `install-deps` list for
  Chromium, 22.04's names or 24.04's t64 ones; not Xvfb, the fonts are the desktops' own) as root
  with apt, in `install.json` as `desktopLibs`; Undo with `--remove-user` marks them as
  installed for another package's sake (`apt-mark auto`), so `apt autoremove` takes them once
  nothing needs them, and never purges them (a purge would take what came to need them since).
  The server mode off takes the Chromium's folder out. The desktops and doctor take it first where
  it is, on arm64 only (a snap's `chromium-browser` wrapper on the PATH is not used); on x86_64
  and Debian nothing of it is read.
- **Limits.** One agent's browser is not a wall against another agent of `agent`'s (each reads the
  local key). A profile switch restarts Chrome (open pages close). No window manager: a dialog
  opens where Chrome puts it.

## Testing

- **Unit**: the server mode's listener (on the socket, login required, 12422 untouched), the setup
  link (one use, expiry, hash only, refused once a login exists, the code never logged), the
  script's pieces that the board builds (as the one command's).
- **Integration** (the tunnel's Docker harness, `BOARD_SERVER_IT=1`): on **Debian 13** while
  working; on Debian 12/13 and Ubuntu 22.04/24.04/26.04 once at the end. An empty server through
  path A from the working copy, the setup link, a login, a card and a new session through the
  domain; a server with their Caddy in Docker and sites (case 3a) kept answering; a reboot of the
  container brings it all back; the script run twice; Undo; path B from a local board.
- **Manual (the owner)**: `workbench.migontech.online` on their Debian 13 server.

## Calls

1. **The listener on a Unix socket in server mode**, so the tunnel's Caddy cases are reused as they
   are. The builder may choose loopback TCP if it fits better, and says why.
2. **One script for both paths**, the one command's machinery extended, not a second installer.
3. **herdr as a systemd user service with lingering**, not a system service running as `agent`:
   herdr's own state and sockets stay where they are for that user.
4. **sudo for `agent`** only with the install flag (`--sudo`); the default is none.
5. **The board's code for path B** is the local checkout as it is: its tracked files with
   uncommitted changes included, so a change is tried with no commit. The panel says which commit it
   is based on and that it has local changes; `board update` on that server then asks for a ref.

6. **The socket**: the board, running as `agent`, makes it in a folder owned by `agent` with the web
   server's group (`2750`), as the tunnel's folder is with the tunnel user. Look finds the group
   (caddy, www-data, a Docker Caddy's gid) as it does today. Case 3a's helper reaches the socket as
   it reaches the tunnel's. Loopback TCP is a fallback for the whole mode, not per case.
7. **One server setup with a target**: the tunnel's setup code takes a target (the socket path, a
   tunnel user or none) instead of assuming the tunnel. The tunnel's own flow stays byte for byte as
   it is, and its tests prove it (anti-goal 5).
8. **The setup code's hash** lives in the board's state folder beside its login files. "Login set"
   is the existing access store's ready check. The page shows a QR code for the TOTP code; a passkey
   is optional there. `board login reset` clears the password, the TOTP code and the passkeys, ends
   every login, and prints a new link. Whoever has a shell as `agent` owns the board anyway.
9. **The link in path B** reaches the local board only in the run's output in memory. It is never in
   `web.log`, config, the card, the event history or a stored answer, and it is gone when the panel
   closes.
10. **Where the code came from** is written on the server: a ref, or "archive of <commit>, local
    changes". `board update` follows a ref. After an archive install it refuses and says to give a
    ref (`board update --ref main`). Path A with no `--ref` installs `main`.
11. **Flags**: `--domain` (required; asked on a terminal when missing), `--ref`, `--user` (default
    `agent`), `--sudo`. DNS not pointing at the server: a warning, as the tunnel's Look gives, and
    the run goes on (Caddy keeps retrying the certificate).
12. **Running again**: a new link is printed only while no login is set. The `agent` user the
    installer made carries a mark (a comment, as the tunnel user); any other `agent` is refused.
13. **systemd**: `herdr server` in a user service with `Restart=on-failure`; the board lives in
    herdr's pane as on a PC, and run.ts restarts it when its code changes, which is how
    `board update` lands. The script reaches `agent`'s user manager with `runuser` and that user's
    `XDG_RUNTIME_DIR`; the builder checks it on both distributions.
14. **Undo** stops and removes the service and disables lingering. It takes back the web server
    exactly as the tunnel's Undo does, from root's record in `/etc/agent-board`. The `agent` user
    and its home go only when asked for.
15. **Support**: the tunnel's list. Debian 13 and Ubuntu 26.04 must work. An official installer
    (herdr, Claude Code) that fails on another one is a documented gap, not a blocker.
16. **Server mode hides what only a PC has**: the tunnel panel, desktop notifications, MokuPilot
    and the "open on this PC" actions.

## Left to the builder

- herdr's and Claude Code's official Linux installers, and how the script pins their versions.
- How the server mode is named in config.json and recognised, and how `board doctor` reports it.
- The setup page's look (the board's own sign-in page's style).
- Whether Undo removes Bun, herdr and Claude Code, or only the board's parts.
