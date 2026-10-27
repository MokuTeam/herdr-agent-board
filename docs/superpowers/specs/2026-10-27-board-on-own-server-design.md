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

- Copying the Claude profiles (the next step).
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
  "Install the board on this server". The same address, login and password; Look shows the plan;
  Apply sends the script and the archive over the existing password login and streams its output
  into the panel; the setup link is shown there, once.
- **Working with herdr directly**: `ssh agent@server`, then `herdr` attaches to the running
  server, as on any machine.

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

## Left to the builder

- herdr's and Claude Code's official Linux installers, and how the script pins their versions.
- How the server mode is named in config.json and recognised, and how `board doctor` reports it.
- The setup page's look (the board's own sign-in page's style).
- Whether Undo removes Bun, herdr and Claude Code, or only the board's parts.
