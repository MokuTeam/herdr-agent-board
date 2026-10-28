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
- **Path B**: in the local board's Remote access panel, a choice beside "Set up the server":
  "Install the board on this server". The same server, login and password, and an address of its
  own ("Address of the board on the server", `tunnel.install.domain`; never the tunnel's, which
  would move the tunnel); Look shows the plan;
  Apply sends the script and the archive over the existing password login and streams its output
  into the panel; the setup link is shown there, once.
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
- **How the local board reaches `agent`**: the builder of that step decides between the password
  each time and a key the install adds, limited to the sync's own command.

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
