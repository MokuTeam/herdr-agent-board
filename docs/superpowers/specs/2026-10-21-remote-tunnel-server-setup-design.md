# agent-board: setting up the web server from the board (remote tunnel, second part) — design

Date: 2026-10-21 · Branch: `rt/setup`, from `feature/remote-tunnel` @ `75c858b`. Lands in the same
pull request as the tunnel (issue #154). An addition to the approved
`2026-10-20-remote-tunnel-design.md`, called "the tunnel spec" below. Decided with the owner in
conversation; not built yet. Calls made in this document (not the owner's) are numbered in
"Calls" at the end and marked **(call N)** where they apply; the owner can overturn any of them.

## Intent

The owner tried the server steps of the tunnel spec. Copying every command from the panel into a
shell on the server, in order, and getting each right, is inconvenient. They want:

1. the tunnel's own user and its key put in place by hand, by copy and paste, as today (that part
   is fine);
2. Test connection;
3. then **one button**, and the board sets up the reverse proxy on the server over SSH: in Docker,
   so that what already runs on the server is not broken, installing Docker when it is missing.

Doing it all by hand stays a full alternative.

The tunnel spec says "the board does not set up the server". This addition changes that for one
part only, the web server in front of the tunnel, and only on the owner's click on a plan the
board showed first. What gives the tunnel its rights on the server (the user, the socket's folder,
the key, sshd's fence) stays in the owner's hands.

## Decided with the owner (2026-10-21)

- **By hand, copied from the panel:** create the tunnel user and the socket's folder, put the
  board's key. Then "Test connection".
- **"Set up the server" button.** The board connects over SSH with an **admin account**: a user
  with sudo the owner already uses. The tunnel user is powerless on purpose and stays so. The
  admin connection is used only for the setup. Nothing is stored but what Undo needs; no password
  is stored.
- **Look first, over SSH:** what listens on 80 and 443 (`ss -ltnp` with sudo, Docker's port
  bindings), whether Docker is installed, the distribution. Then one of these cases:
  1. **Nothing on 80/443:** install Docker if missing; run the board's own Caddy in a container
     (its own config and certificate volume, the socket's folder bind-mounted) on 80/443. A clean
     address.
  2. **Caddy as a host service:** find its config from systemd; put the board's site block in a
     file of its own and add exactly one `import` line to the owner's Caddyfile (backup first);
     `caddy validate` before `systemctl reload caddy`; roll back by itself on failure. No
     container.
  3. **Caddy in Docker:** find the container holding 443 and the host file mounted as its
     Caddyfile; add the board's block between markers `# >>> agent-board` / `# <<< agent-board`
     (backup first); a small helper container of the board's makes the tunnel's socket reachable
     from their container; validate inside their container, reload, roll back on failure.
  4. **Something else on 443** (nginx, Apache), or a config that cannot be found without doubt:
     the board's own Caddy container on another port (e.g. 8443, `https://<domain>:8443`),
     touching nothing of theirs. An nginx include may be an optional case if cheap.
  5. **"Do it myself":** for the case found, exactly the commands the board would run, in order,
     with the owner's values, each with Copy and a short explanation; then Test connection checks.
- **Nothing changes on the server without a click.** The board first shows the plan: what it
  found, which files and containers it adds or changes, the backups, what it reloads. Then
  "Apply" or "Do it myself". **"Undo"** removes exactly what the board added and puts back the
  lines it changed.
- **A proof the owner asked for:** two Caddy (or nginx) in different containers run at the same
  time and both fully serve requests, in the case-3 and case-4 shapes (their proxy on 443 with
  the board's behind it; the board's on 8443). With real containers: Docker Desktop on the owner's
  PC. Tests never touch the owner's real server.
- **All of it lands in the remote-tunnel pull request.**
- **Which servers (owner, the same day).** The owner's server runs Debian 13. The automation is
  written and tested for **Debian and Ubuntu together from the start**, not one after the other:
  the spike and the integration tests run on **Debian 13 and Ubuntu 26.04 LTS** side by side, and
  the integration tests also on **Ubuntu 24.04** (classic sudo). Ubuntu 25.10 and 26.04 ship
  `sudo-rs` and the Rust coreutils (uutils) by default, so sudo's lines are matched for both sudo
  and sudo-rs, and the server's scripts use only POSIX forms, or flags that GNU and Rust coreutils
  both have (no `tail -f --pid`); where a tool may differ, the script detects it. Every part that
  reads or runs on the server (Look's parsers, sudo's lines, the Docker install) covers both
  distributions, with fixtures from both. Debian 12 and Ubuntu 22.04 stay supported through the
  same code paths (an integration image for each if cheap). Supported in all: Debian 12, 13;
  Ubuntu 22.04, 24.04, 25.10, 26.04. **Any other OS: "Do it myself"**, with the commands.
- **Tests on the owner's PC:** Docker Desktop runs the spike's and the integration tests'
  containers; the controller starts it.

## What this changes in the tunnel spec

The builder edits these lines of `2026-10-20-remote-tunnel-design.md` in the same pull request:

- "Decided with the owner", **The server**: "The board does not set up the server" becomes: the
  board sets up the web server on the owner's click (this document); DNS, the tunnel user, the
  socket's folder, the key and sshd stay by hand.
- **Non-goals**: "Setting up the server (DNS, Caddy, sshd, the user)" becomes "Setting up DNS,
  sshd and the tunnel user".
- **Anti-goals**: "The board running anything on the server beyond holding its one forward"
  becomes "…beyond holding its one forward, except Look (it only reads) and a plan the owner
  applied or undid with a click, over the owner's admin connection".
- **The server, step 2**: the socket's folder takes the tunnel user's own group, not `caddy`
  **(call 2)**; the Caddy step gets the `chgrp` line for a host Caddy.
- **The tunnel spec's call 3** ("HTTPS on 443 only"): another public port becomes possible, set
  by the setup in case 4 **(call 17)**.
- The README's "The board never touches the server", and the header comments of
  `src/core/tunnel-snippets.ts` and `web/src/components/access/Snippets.tsx`, which say the same.

## Goals

- From a server with the tunnel user in place and Test connection passing to
  `https://<domain>` serving the board: one Look, one plan, one Apply.
- The owner's sites, their Caddy and their containers answer exactly as before, during and after.
- A plan that says, before anything changes, every file, line, container, volume, image, package
  and reload it involves, and how each is undone.
- Undo that leaves the server as it was before Apply, but for what the owner changed since.
- "Do it myself": the same plan as commands, for any case, also without Look.
- Windows first-class on the PC side: Windows' own OpenSSH, no shell, no prompt.

## Non-goals

- DNS records; the tunnel user, the socket's folder, the keys file, sshd (by hand, **call 1**).
- Firewalls: the host's (ufw, nftables) and the provider's. The plan says which ports must be open.
- nginx, Apache or Traefik as the board's proxy. Case 4's nginx variant only forwards the
  certificate checks for the board's domain (call 16).
- Certificates by DNS challenge (DNS-01). Getting a certificate needs port 80 or 443 reachable
  for the board's Caddy, or case 4's nginx variant.
- Caddy run from a JSON config or through its admin API only; Caddy 1.
- Podman, rootless Docker, Docker with user namespaces, SELinux in enforcing mode, servers without
  systemd for the cases that need it (call 25). These get "Do it myself".
- Keeping Docker or Caddy up to date. The board's containers move to the board's pinned images
  when the owner applies again.
- Two boards' setups on one server (call 30). One tunnel, one PC per domain, as in the tunnel spec;
  a setup is one tunnel's, named by its tunnel user and socket.
- A `board` command for the setup (call 29).
- Watching the server afterwards, beyond the tunnel's probe through the domain.

## Anti-goals (failure even if it works)

1. **Breaking the owner's existing sites or their Caddy.** A site that answered before Apply
   answers otherwise after it; their Caddy or any of their containers restarted, recreated or
   reconfigured beyond the one `import` line (case 2) or the one marked block (case 3); their
   compose files, their nginx's own files, their units edited. A reload is the most the board
   does to their Caddy.
2. **Leaving the server half-configured.** An Apply that stops midway (an error, a lost
   connection, the PC asleep) and leaves the server neither as it was nor as planned, or with
   pieces the record does not name; an Undo that leaves pieces.
3. **Storing admin secrets.** The sudo password on disk anywhere (PC or server), in a log, the
   payload, a URL, an API answer or a process list; an admin key made, copied or kept by the board.
4. Anything changing on the server without the owner's click on a plan that listed it. Look
   writes nothing.
5. Weakening the tunnel's fences: the board editing sshd_config, giving the tunnel user any right,
   a socket folder looser than `2750`, or a socket group with members other than its reader.
6. Undo removing anything the board did not add: their lines, their containers, a Docker the
   owner uses.
7. The local web board, or a setup that never uses this, noticing any change.

## Nobody else notices

Nothing here runs unless the owner clicks Look, Apply or Undo in the Remote access panel, on the
local board. No hook, payload field (beyond `accessRev` moving while a run reports progress) or
startup path changes. With `tunnel.publicPort` unset (call 17), the tunnel listener's Host and
Origin checks, WebAuthn's expected origin and the probe's URL are byte for byte today's; the
tunnel's tests stay unchanged and pass.

## The flow, as the owner sees it

The Tunnel part of the panel keeps its fields, key, status and Test connection. Its "Snippets"
become **"On the server"**, in three steps.

### Step 1: by hand, once

The existing snippets, filled in: the user and the socket's folder, the keys file's line, sshd's
`Match` block with `sshd -t` and the reload. Each keeps its Copy. **One more block, "All of step 1
in one paste" (call 3):** the same commands in one script that is safe to paste twice. It writes
the keys file with the board's public key (`tee`), and appends the `Match` block only when
`Match User <user>` is not already in sshd_config, then `sshd -t` and the reload.

sshd stays by hand **(call 1)**. A mistake in sshd_config can lock the admin out of their own
server, and the `Match` block is the tunnel's fence; the owner sees and pastes it. Look reads it
back (below) and says when it differs from the panel's.

The socket's folder no longer depends on Caddy **(call 2)**. Step 1 runs before Look, so it cannot
know whether a `caddy` group exists, and on a server without a host Caddy (cases 1, 3, 4)
`install -g caddy` fails. The folder takes the tunnel user's own group:

```sh
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin boardtunnel
# useradd leaves the account locked; an sshd with UsePAM no refuses a locked one, key or not
sudo usermod -p '*' boardtunnel
# the socket's folder: the tunnel user makes the socket; its group is the reader's (step 3)
sudo install -d -m 2750 -o boardtunnel -g boardtunnel /var/lib/boardtunnel
# the key's file belongs to root, out of the tunnel user's reach
sudo install -d -m 755 /etc/ssh/authorized_keys
```

Until step 3 only root and the tunnel user can open the socket. Step 3 gives the reader access:
a host Caddy through the folder's group (`chgrp`), a container of the board's through
`--group-add` (see "The socket's permissions"). A folder made the old way (`-g caddy`) works too.

### Step 2: Test connection

As in the tunnel spec. Before step 3, steps 1 and 2 (ssh and the key; the server takes the
socket) pass and the domain step fails: nothing serves the domain yet. Its hint gets one line
while no setup is recorded **(call 4)**: "If the web server is not set up yet, this step fails
until it is: Set up the server below." Test connection also pins the server's host key, which the
admin connection then requires (call 6).

### Step 3: the web server

```
On the server
  1  By hand, once                                    [All of step 1 in one paste ▸] [Copy]
     ▸ The tunnel's user and its folder   ▸ The key's line   ▸ sshd, a second fence
  2  Test connection                                   ✓ ssh  ✓ the socket  ✗ the domain (not yet)
  3  The web server
     Admin user [ubuntu        ]   Admin key [ssh agent and ~/.ssh keys      ]
     [Look at the server]                                    or  [Do it myself]
     ┌ sudo asks for ubuntu's password  [••••••••••]  [Continue]
     │ kept by this panel while it is open; never saved
     What the board found
       Ubuntu 24.04 · Docker 27.3 · 443 and 80: Caddy in Docker ("web-caddy-1", compose "web")
       The tunnel's fence: as the panel's ✓   The socket's folder: drwxr-s--- boardtunnel boardtunnel ✓
       → Caddy in Docker: your Caddy gets a site for board.example.com; a helper of the board's
         hands it the tunnel. Address: https://board.example.com
     The plan (nothing changes until Apply)
       1  Pull alpine/socat:<version> (an image)
       2  Start the helper "agent-board-socket" on your network "web_default" (no port on the host)
       3  Back up /srv/web/Caddyfile → /etc/agent-board/backups/20261021-1004/
       4  Add the block "# >>> agent-board … # <<< agent-board" at the end of /srv/web/Caddyfile
       5  Check it in your Caddy ("caddy validate" inside "web-caddy-1")
       6  Reload your Caddy (a reload: no restart; your sites stay up)
       7  Check that your 4 sites answer as before
       8  Test connection through https://board.example.com
       Undo removes 2 and 4; your Caddy is reloaded again.
     [Apply]  [Do it myself]  [Cancel]
```

The layout is the builder's; what it says is not. Everything in it is filled in from Look.

**Look at the server.** Needs the admin user, a pinned host key (Test connection) and, if sudo
asks for one, the password. It reads; it changes nothing (call 9). Then it shows:

- what it found: the distribution, Docker (version, or none), who holds 80 and who holds 443, the
  config it would touch (path, how it is mounted), what Look checked of step 1 (sshd's effective
  settings for the tunnel user, the folder's mode, owner and group), and warnings (the domain's
  DNS record points elsewhere; the server forwards traffic for others and Docker would change
  that, call 27);
- the case it chose and why, in one line, and the address the board will have;
- the plan.

**The plan.** Numbered steps. Each says what it does in one line and lists what it touches: files
added, lines added and where, backups, containers, volumes, images, packages, group changes,
reloads. Then one line on what Undo will remove. A plan that installs Docker has a tick, "Install
Docker from Docker's own repository", and Apply stays off until it is ticked (call 19). A case
the board does not do by itself shows why, and "Do it myself" in place of Apply.

**Apply.** The steps run on the server as one script that does not depend on the connection
(call 10). The panel shows each step as it goes: waiting, running (with time), ✓ or ✗, and its
output under a fold. On a failure it shows:

- the step and the lines that matter;
- a hint (table below);
- what was rolled back, each item with ✓, and the checks that prove it (their Caddyfile's hash is
  the one from before; their Caddy was not reloaded, or was reloaded back);
- "Look again" and "Do it myself".

After the last step the board runs Test connection, waiting up to 2 minutes for the certificate
(call 24). Then the step shows "Set up on 21 Oct, 10:04: Caddy in Docker" with **Undo**.

**Do it myself.** The same plan, as commands (case 5 below).

**Undo.** Look again first (the server's record and what stands now), then an Undo plan in the
same form: what will be removed or put back, and what stays (the parts made by hand, call 32;
Docker, call 20). Undo is a two-click button, as Unpair is.

### Hints

| What happened | What the panel says |
|---|---|
| admin: `Permission denied (publickey)` | The server refused the admin key: add it to `<admin>`'s `~/.ssh/authorized_keys` (`ssh-copy-id`), or load it into the ssh agent if it has a passphrase. |
| admin: `Too many authentication failures` | The agent offered too many keys: choose the admin key's file. |
| no pinned host key | Run Test connection first: it pins the server's key. |
| `Host key verification failed` | The server's key changed since it was pinned (as for the tunnel). |
| sudo or sudo-rs: a password is required | Type `<admin>`'s sudo password. |
| wrong sudo password | The password was refused. The board tries once per click: some servers lock sudo after a few failures. |
| `sudo: … must have a tty` | The server's sudoers has `requiretty`: remove it for `<admin>`, or Do it myself. |
| not in sudoers | `<admin>` cannot use sudo: use an admin who can, or root. |
| apt's lock held for 5 minutes | Another package manager (often unattended-upgrades) is running. Try again later. |
| `toomanyrequests` on a pull | Docker Hub's pull limit. Try again later. |
| 80/443 taken, holder changed or their config changed since Look | The server changed since Look: Look again (call 11). |
| `caddy validate` failed | Your Caddy refused the config with the board's block (the line it names). Nothing was reloaded; your file is as it was. A site without braces as the last block is a usual cause. |
| reload failed | Your Caddy kept its running config; the file was put back and reloaded. |
| a site answers differently | `<host>` answered 200 before and 502 after: everything was rolled back (call 21). |
| the domain's step: TLS | The certificate is not there yet: the domain's DNS record, or ports 80/443 (or 8443) closed at your provider. The web server keeps trying. |
| the domain's step: 502 | The proxy cannot open the socket: the folder's group (see Look's findings). |
| connection lost during Apply | The server finishes or rolls back by itself. Look again in a minute. |

## The admin connection

### Who, and which key (call 5)

- **Admin user**: a field, checked like `tunnel.user` (a plain user name, no leading `-`). `root`
  works and needs no sudo.
- **Admin key**: empty means what ssh does by default: the ssh agent (on Windows the "OpenSSH
  Authentication Agent" service, when it runs) and the usual files (`~/.ssh/id_ed25519`, …). Or a
  key file the owner names, checked like `tunnel.key`. The board never asks for a key's
  passphrase: a key with one must be in the agent. SSH password login is not supported.
- Both are kept in config.json, `tunnel.admin: { user, key }`. Neither is secret. They are what
  Undo needs to connect later.
- The board never makes, copies or keeps an admin key. The tunnel's own key is never used for
  this: it can run no command anyway.

### The ssh line

The same ssh binary as the tunnel (Windows' own by full path first), spawned without a shell:

```
ssh -F none -T
    [-i <admin key> -o IdentitiesOnly=yes]
    -o BatchMode=yes
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="<state>/tunnel/known_hosts"
    -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
    -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes
    -p <sshPort>
    <admin>@<host>
    <remote command>
```

- The tunnel's host and SSH port; the tunnel's pinned key, strictly: an unpinned or changed key
  is refused, never pinned here **(call 6)**.
- `-F none`, `BatchMode`: no user config, no prompt, as for the tunnel. Paths through
  `sshPathArg` (forward slashes, `%` doubled, quoted).
- stdin is a pipe (for the sudo password only), stdout and stderr are read line by line. The
  existing `spawnSsh` ignores stdin and stdout; the adapter gets a second function for this.

### sudo (call 7)

Look starts with a check that needs no sudo, as the admin: `id -u`, then `sudo -n true`. Its two
rounds (below) then run as root.

- **uid 0**: no sudo.
- **`sudo -n` works** (NOPASSWD): every run uses `sudo -n`; nothing goes on stdin.
- **"a password is required"**: the panel asks for the password. It is typed once and kept by the
  page (the panel's state) while the panel is open, and sent with each Look, Apply or Undo. The
  board keeps it only for the length of that one request: it writes it to ssh's stdin, followed by
  a newline, closes stdin and drops it. `sudo -S -p ''` reads it there. Never on disk, in config,
  in `web.log`, in the payload, a URL, an answer, or a command line on the PC or the server. The
  panel's state goes when it closes (the body is drawn anew, as for the TOTP secret today). A
  password with a newline is refused.
- **Once per click.** A wrong password is not retried: sudo counts failures and some servers
  (`pam_faillock`) lock the account after three.
- **`requiretty`, not in sudoers, no sudo**: stop with the hint; "Do it myself" stays.
- **sudo and sudo-rs** (Ubuntu 25.10's and 26.04's default) both. Look names which one runs
  (`sudo --version`'s first line). `-n`, `-S`, `-p ''` and `--` are used as both take them; each
  one's own lines (a password required, a wrong password, not in sudoers, `requiretty`) are
  matched, as the spike recorded them on Debian 13 (sudo) and Ubuntu 26.04 (sudo-rs).

Why typed and passed on stdin: a key or agent proves who connects, but most admins' sudo asks for a
password, and the owner wants nothing stored. `sudo -S` is sudo's own way to read a password from
a pipe; with `-p ''` it prints no prompt. An askpass helper would need the password in a file on
the server; `ssh -tt` would echo it through a terminal into the log.

### How a script runs on the server (calls 8, 10)

**The remote command is fixed text plus the script in base64.** stdin carries the password and
nothing else:

```
sudo -S -p '' -- sh -c 'eval "$(echo <base64 of the script> | base64 -d)"'
```

(`sudo -n --` without a password; `sh -c …` alone for root.) So:

- no owner value and no quoting reaches the admin's login shell (bash, zsh or fish read the single
  quotes the same); base64 has no quote;
- the script never shares stdin with the password: its first line is `exec </dev/null`, so even
  if sudo did not read the password (a cached timestamp), no command can read it;
- the script is in the command line, which root can see in the server's process list: it holds
  no secret, so that is fine. It fits easily in Windows' and Linux's limits (a few KB).

**The same text serves the board and "Do it myself".** Each step's commands are written for an
admin with sudo, `sudo` in front of what needs root, as the owner would paste them. The board's
script runs as root and defines `sudo() { "$@"; }` first, so the same lines run unchanged. Running
a command as another user is `sudo runuser -u caddy -- …`, which works both ways.

**Look runs in the foreground** and writes nothing (call 9).

**Apply and Undo run detached** (call 10). The decoded script:

1. writes the run's script to `/etc/agent-board/runs/<id>.sh` (root, `0600`);
2. starts it with `setsid`, stdin `/dev/null`, output to `runs/<id>.log`; the run itself takes
   the lock first (`flock -n` on `/etc/agent-board/lock`, held for its whole length; held by
   another: "another run is going on") and writes `runs/<id>.exit` when it ends;
3. follows the log until that file is there, then prints the exit status. The follower is POSIX:
   once a second it prints the log's new complete lines (`wc -l`, `sed -n '<from>,<to>p'`), not
   `tail -f --pid`, which Rust coreutils may not take.

A run prints `@@step <n> start|ok|fail`, `@@undo <n> ok|fail`, `@@result applied|rolled-back|
rollback-failed`; the board turns these into the panel's progress, and the lines between them
into each step's output. If the connection drops (the PC sleeps, Wi-Fi goes), the run goes on,
finishes or rolls back by itself, and writes its result into the record; the next Look reads it.
Every step has a timeout of its own, and a run 20 minutes at most. The last five runs' scripts and
logs are kept; a newer run removes older ones.

Why detached: a step-by-step ssh per step is simpler, but the server would then be left between
two steps whenever the PC loses its connection: anti-goal no. 2.

### Output and logs (call 29)

The output of a run is kept in the board's memory for the panel (the last 200 lines per step) and
is not written to `web.log`. `web.log` gets one line per step: its name, ✓ or ✗, how long. Any
output line that holds the password (it never should) is replaced before it is kept.

## Look: what the board reads

**Read-only (call 9).** Look writes nothing on the server, not even a temporary file. It never
runs `caddy validate` (it can write to Caddy's storage) and pulls, starts or stops nothing.
`caddy adapt` (it only prints) runs on the host, or with `docker exec` inside their container. What
sudo and sshd log about a login is theirs.

**Two rounds.** The first reads what is there; the board then knows which config to read; the
second reads that config's facts. Each is a fixed script from `src/core`; the second takes values
from the first (paths, a container's id, a unit's name), narrowed (an id is 64 hex characters, a
path has no newline) and quoted.

**Round one:**

| Section | Command (the gist) | For |
|---|---|---|
| `os` | `/etc/os-release`; `uname -m` | the distribution (supported or "Do it myself"), the Docker install |
| `ports` | `ss -H -ltnp` for 80, 443, 8443, 8480; for each pid its `/proc/<pid>/cgroup` | who holds each port: a unit (`…/caddy.service`), a container (`docker-<id>.scope`, `/docker/<id>`), `docker-proxy` |
| `docker` | `docker version`, `docker info` (security options), `docker ps`, `docker inspect` of the containers on those ports or on the host network | Docker or not, Podman, rootless, user namespaces; port bindings (with `userland-proxy` off nothing shows in `ss`), networks, mounts, command line, image, labels |
| `systemd` | `systemctl show caddy.service nginx.service -p ExecStart,ExecReload,User,Group,ActiveState,WorkingDirectory` | case 2, case 4's nginx |
| `fence` | `sshd -T -C user=<tunnel user>,host=localhost,addr=127.0.0.1`, only the lines the `Match` block sets | step 1 as the panel has it |
| `folder` | `stat` of the socket's folder and of the socket | mode, owner, group, gid |
| `record` | `/etc/agent-board/setup.json` | an earlier setup, a run that did not finish |
| `host` | `getenforce`; `ip_forward`; `lxd`, `libvirtd`, `wg` present; `curl`/`wget`, `flock`, `setsid`, `runuser`, `timeout`; `sudo --version` (sudo or sudo-rs); `ls --version` (GNU or Rust coreutils, shown only) | the limits (call 25), the Docker warning (call 27), the smoke check (call 21) |
| `dns` | `getent ahosts <domain>`; `ip -o addr` | a warning when the domain points elsewhere (on a provider with 1:1 NAT the public address is not on the interface, so only a warning) |

**Round two**, for the holder of 443 (and of 80 when case 4 needs it):

- **Caddy as a service:** its config path and adapter from `ExecStart`'s argv (`--config`,
  `--adapter`, relative to `WorkingDirectory`); `caddy version`; `caddy adapt` of that config,
  from which the script keeps only: the host names in it, whether the admin endpoint is off,
  whether automatic HTTPS is off; the config's `sha256`; whether the file ends with a newline.
- **Caddy in a container:** its config path from its command line (the official image's
  `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile`); the mount behind that path (a
  file bind mount, a folder bind mount, or a volume) and so the host path; `docker exec <id> caddy
  version` and `caddy adapt` (the same few facts); its networks (name, driver, user-defined or
  not) or host networking; the config's `sha256`; compose's labels (project, working folder).
- **nginx on the host:** `nginx -T`, keeping only `include`, `listen` and `server_name` lines, to
  see that `conf.d/*.conf` is included in `http {}` and how 80 is listened on.

Look sends back only what the plan needs (call 9). Their config's text never leaves the server: a
config can hold a DNS provider's token or a password hash.

### Choosing the case

By the holder of 443, then of 80. "Other" is anything that is not Caddy: nginx, Apache, Traefik,
HAProxy, an unknown program, a container that does not run Caddy.

| 443 | 80 | Case | The board's address |
|---|---|---|---|
| free | free | **1**: the board's Caddy on 80 and 443 | `https://<domain>` |
| free | other | **1b**: the board's Caddy on 443 alone (call 12) | `https://<domain>` |
| Caddy, systemd unit, a Caddyfile | any | **2** | `https://<domain>` |
| Caddy in a container on a user-defined network, Caddyfile on a mount | any | **3a** | `https://<domain>` |
| Caddy in a container on the host network, Caddyfile on a mount | any | **3b** | `https://<domain>` |
| other | free | **4a**: the board's Caddy on 8443, and on 80 for the certificate | `https://<domain>:8443` |
| other | nginx, systemd unit, `conf.d` included | **4b**: as 4a, nginx forwards only the certificate checks | `https://<domain>:8443` |
| the board's own `agent-board-caddy` | | already set up: compare with the record | as recorded |
| anything else | | **Do it myself** | |

"Anything else", each with its reason in the panel:

- Caddy found, but: its config is JSON or `--resume`, its admin endpoint is off (no reload without
  a restart), automatic HTTPS is off, its Caddyfile is baked into its image, two configs could be
  meant, or it is Caddy 1 (call 15). These fall back to case 4 when 80 allows (4a, 4b), else
  "Do it myself".
- Caddy in a container only on Docker's default bridge (3c) or on macvlan (call 13).
- The domain already in their config (call 26).
- 443 or 80 held by two different programs (IPv4 and IPv6, say).
- The limits of call 25: a distribution outside the supported list (Debian 12, 13; Ubuntu 22.04,
  24.04, 25.10, 26.04); SELinux enforcing; Podman; rootless Docker; Docker with user namespaces;
  `requiretty`; no systemd where the case needs it.
- A record of another tunnel's setup on this server: another tunnel user or socket (call 30).

## The cases

The values below are the defaults: tunnel user `boardtunnel`, socket
`/var/lib/boardtunnel/board.sock`, domain `board.example.com`. `<gid>` is the socket folder's group
id, read by Look. Images are pinned by tag and digest (the builder takes the current Caddy 2
release and the current `alpine/socat`).

### Case 1 and 1b: nothing (or not Caddy) on the ports

**Plan:**

1. Install Docker if missing (see "Installing Docker"; needs the tick).
2. Pull `caddy:2.x.y@sha256:…`.
3. Write `/etc/agent-board/caddy/Caddyfile`:

   ```
   board.example.com {
   	reverse_proxy unix//var/lib/boardtunnel/board.sock
   	header Strict-Transport-Security "max-age=31536000"
   }
   ```

   Case 1b (80 is someone else's) adds what keeps the certificate check on 443 (TLS-ALPN) and
   off 80 **(call 12)**:

   ```
   {
   	auto_https disable_redirects
   }
   board.example.com {
   	tls {
   		issuer acme {
   			disable_http_challenge
   		}
   	}
   	reverse_proxy unix//var/lib/boardtunnel/board.sock
   	header Strict-Transport-Security "max-age=31536000"
   }
   ```

4. Run the board's Caddy **(call 18)**:

   ```sh
   sudo docker run -d --name agent-board-caddy --restart unless-stopped \
       --label agent-board.role=caddy --label agent-board.setup=<run id> \
       -p 80:80 -p 443:443 \
       --group-add <gid> \
       --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges \
       -v /etc/agent-board/caddy:/etc/caddy:ro \
       -v /var/lib/boardtunnel:/var/lib/boardtunnel:ro \
       -v agent-board-caddy-data:/data -v agent-board-caddy-config:/config \
       caddy:2.x.y@sha256:…
   ```

   (1b: no `-p 80:80`.) The volumes carry `--label agent-board.role=caddy` as well (made first
   with `docker volume create`).
5. Check it runs and holds its ports (`docker inspect`, `ss`).
6. Test connection through `https://board.example.com`.

- **The folder, not the socket, is mounted.** `StreamLocalBindUnlink` gives each new tunnel a new
  socket file (a new inode). A container with the old file mounted would keep the dead socket.
- **Read-only mounts.** Opening a Unix socket needs write permission on the socket, which a
  read-only mount does not take away (the spike checks it, as `docker.sock:ro` is known to).
- **Root without its powers.** Caddy runs as root in its container (the official image's default,
  so `/data` is its own), but with `--cap-drop ALL` root has no `CAP_DAC_OVERRIDE`: it opens the
  socket only through the group `--group-add <gid>` gives it. `NET_BIND_SERVICE` is kept for 80
  and 443 (Docker lets containers bind low ports anyway; it costs nothing).
- **Docker publishes 80 and 443 past the host's firewall** (Docker's own iptables rules come
  before ufw's). They must be open anyway; the plan says so.
- The config folder mounted, not the file: rewriting the file (Apply again, a domain change)
  reaches the container without a new mount.

**Rollback** (any step failing): remove the container, the volumes, `/etc/agent-board/caddy`, the
images pulled by this run; Docker stays if its install step finished (call 20).

### Case 2: Caddy as a host service

Found from `ss` (a `caddy` process on 443 whose cgroup is `caddy.service`) and `systemctl show
caddy.service`. Debian's and Ubuntu's package runs `caddy run --environ --config
/etc/caddy/Caddyfile` as `caddy:caddy`, with `ExecReload` = `caddy reload … --force`.

**Plan:**

1. Write `/etc/caddy/agent-board/board.caddy` (root, `644`):

   ```
   # agent-board: the board through its tunnel. Added by "Set up the server"; its Undo removes it.
   board.example.com {
   	reverse_proxy unix//var/lib/boardtunnel/board.sock
   	header Strict-Transport-Security "max-age=31536000"
   }
   ```

2. The socket's folder to Caddy's group: `sudo chgrp caddy /var/lib/boardtunnel` (and the socket
   now there, which the next tunnel replaces anyway), then `sudo chmod 2750` (the setgid bit
   stays; the `chmod` makes sure). Skipped when the group is Caddy's already, or when Caddy runs
   as root. The old group goes into the record.
3. Back up their Caddyfile to `/etc/agent-board/backups/<run id>/`.
4. Make the candidate **beside** their file, `/etc/caddy/.Caddyfile.agent-board`, so a relative
   `import` in it resolves as it does for the real one: their text, a newline if it lacks one,
   and one line:

   ```
   import /etc/caddy/agent-board/board.caddy # agent-board
   ```

   One line, as the owner asked (call 14): its comment is its marker. A Caddyfile comment starts
   at a `#` that follows a space.
5. Check the candidate: `caddy adapt` of the old file and of the candidate, and the candidate's
   host names must be the old ones plus the domain, no more, no fewer **(call 21)**; then
   `sudo runuser -u caddy -- caddy validate --config /etc/caddy/.Caddyfile.agent-board --adapter
   caddyfile` (as Caddy's user, so it touches only Caddy's own storage).
6. Their Caddyfile's `sha256` is still the one Look read (call 11). Write the candidate over it in
   place (`cat`, same file), remove the candidate.
7. Before the reload: each of their exact host names (up to 20) is fetched at Caddy's address
   with `curl --resolve <host>:443:<addr>` (or `wget`), and its status kept (call 21).
8. `sudo systemctl reload caddy`; then `systemctl is-active caddy`.
9. The same fetches: every status as before (one retry after 2 s).
10. Test connection.

**Rollback:** the backup written back in place, `board.caddy` removed, the folder's group put
back, and when the reload had run, `systemctl reload caddy` again and the fetches again. A reload
that fails leaves Caddy on its running config (Caddy refuses a config it cannot load), so the
file is put back to match it.

Their Caddy gets the domain's certificate itself, with its own settings (its e-mail, its CA).

### Case 3: Caddy in Docker

Their Caddy cannot see the host's socket: their container has no such mount, and adding one means
recreating their container (anti-goal no. 1). A helper container of the board's makes the socket
reachable for it.

**The helper (call 13).** `socat`, a byte pipe from TCP to the socket: it changes nothing in what
passes. Their Caddy sets `X-Forwarded-For`, `X-Forwarded-Proto` and keeps Host; the board reads
them as it does behind any Caddy (the rightmost `X-Forwarded-For` entry is their Caddy's view of
the caller). A second Caddy as the helper would replace those headers with its own view (an
`http` request from their Caddy's address) unless told to trust it, and the board would then
refuse every request (`X-Forwarded-Proto` must be `https`) or see every caller at one address.

```sh
sudo docker run -d --name agent-board-socket --restart unless-stopped \
    --label agent-board.role=socket --label agent-board.setup=<run id> \
    --network web_default --network-alias agent-board-socket \
    --user 65534:<gid> --read-only \
    --cap-drop ALL --security-opt no-new-privileges \
    -v /var/lib/boardtunnel:/var/lib/boardtunnel:ro \
    alpine/socat:<version>@sha256:… \
    TCP-LISTEN:8080,fork,reuseaddr UNIX-CONNECT:/var/lib/boardtunnel/board.sock
```

**How their Caddy reaches it: the designs weighed.**

| Design | Their container | Who else can connect | Survives their changes | Taken |
|---|---|---|---|---|
| **Join their network** (3a): the helper on the user-defined network their Caddy is on, no host port | untouched | other containers on that network; root | yes: a compose network stays across `up`; but `docker compose down` cannot remove it while the helper is on it, and says so | **yes**, for user-defined networks |
| **Our network, theirs connected** (`docker network connect`) | changed at runtime | only the two | no: their next `up -d` recreates their Caddy without it, and the board stops working silently | no |
| **Host's gateway address** (helper on the host, listening on the bridge's gateway, `172.17.0.1:<port>`) | untouched | any process on the host; their containers | yes | no: the host firewall (ufw's default) often drops containers' traffic to the host; a host port is free while the helper is down |
| **127.0.0.1 on the host** | untouched | any process on the host | yes | only when their Caddy uses the host network (3b): nothing else reaches the host's loopback |
| **Mount the socket's folder into their container** | recreated, compose file edited | only their Caddy | yes | no for Apply: a restart of their Caddy and an edit of their files. "Do it myself" shows it as the cleanest choice for those who accept that |

- **3a, a user-defined network.** The helper joins it as above; their block proxies to
  `agent-board-socket:8080`. With several, the first user-defined network by name **(call 33)**.
  The panel says, before Apply: "While the board's helper is on your network, `docker compose
  down` cannot remove that network and says so; your containers stop as usual; `up` works."
- **3b, the host network.** Their Caddy shares the host's network: the helper runs with
  `--network host`, listening on `TCP-LISTEN:<port>,bind=127.0.0.1` (default 8481), and their
  block proxies to `127.0.0.1:8481`.
- **3c, only Docker's default bridge (or macvlan):** no name to reach the helper by, and the
  gateway design above fails on many hosts. Not done by Apply; "Do it myself" shows the gateway
  and the mount designs with their caveats.

**This is the one place the socket becomes a TCP port again.** The tunnel spec's anti-goals ask
that only Caddy reach the forward and that nothing on the server can take its place. Case 3 is the
owner's choice and keeps what it can: the helper holds the port all the time (up or down, the
tunnel makes no difference to it); in 3a the port lives in the helper's own network namespace,
not on any of the host's addresses, so no process on the host can take it; in 3b it is on the
host's loopback, free while the helper is down. What can connect around their Caddy (their other
containers on that network in 3a, any host process in 3b, root) still meets the board's login on
every board route; it can send its own `X-Forwarded-*`, which the board uses only to show
addresses and group rate limits. The plan says so in one line, and the README too.

**Plan (3a):**

1. Pull the helper's image.
2. Start the helper (above).
3. Their container reaches the helper: from inside it (`docker exec`, with busybox's `nc` or
   `wget`, which the official image has), the name `agent-board-socket` resolves and port 8080
   takes a connection. Skipped, and said, when their image has neither. The whole path, through
   the tunnel to the board, is the last step's Test connection: the tunnel may be off during
   Apply, and Test connection already knows how to check it either way.
4. Back up their Caddyfile (its host path, from the mount).
5. Their Caddyfile's `sha256` is still Look's (call 11).
6. The candidate, with at the end:

   ```
   # >>> agent-board: the board through its tunnel. Added by "Set up the server"; its Undo removes it.
   board.example.com {
   	reverse_proxy agent-board-socket:8080
   	header Strict-Transport-Security "max-age=31536000"
   }
   # <<< agent-board
   ```

   - **Folder mount or volume:** the candidate is written beside it (`.Caddyfile.agent-board`),
     is seen inside their container at the same relative place, and is checked there: `caddy
     adapt` (host names, as in case 2) and `docker exec <their caddy> caddy validate --config
     <inside path of the candidate> --adapter caddyfile`. Then it is written over their file
     **in place** and removed.
   - **File mount:** a file bind mount holds the file's inode, so a new file moved over it would
     never reach their container (and `sed -i` does just that). The board writes in place
     (`cat candidate > Caddyfile`) and checks inside right away; on a failure it writes the
     backup back at once. Their Caddy has not been reloaded at that point, so it never runs the
     failed text. **(call 14)**
7. Fetch their hosts (as case 2, against the address their container publishes 443 on).
8. `docker exec <their caddy> caddy reload --config <path> --adapter caddyfile`: a reload through
   their Caddy's own admin endpoint inside the container; no restart, no recreate (call 15).
9. The fetches again.
10. Test connection.

3b: the same, the helper with host networking and `reverse_proxy 127.0.0.1:8481`.

**Rollback:** their file written back from the backup in place, a reload when one had run, the
fetches again, the helper removed. The certificate their Caddy got for the domain stays in its
storage until it expires: harmless, and not the board's to delete.

### Case 4: something else on 443

The board's Caddy in its own container on 8443; their proxy untouched. The address becomes
`https://<domain>:8443` (call 17), and the provider's firewall must let 8443 in.

**The certificate (call 16).** Let's Encrypt (and any ACME CA) checks a domain on port 80 (HTTP-01)
or on port 443 (TLS-ALPN-01), never on another port. With 443 someone else's, the board's Caddy
needs port 80:

- **4a: 80 is free.** The board's Caddy also takes 80, for the certificate's check (and a
  redirect to 8443):

  ```
  {
  	https_port 8443
  }
  board.example.com:8443 {
  	tls {
  		issuer acme {
  			disable_tlsalpn_challenge
  		}
  	}
  	reverse_proxy unix//var/lib/boardtunnel/board.sock
  	header Strict-Transport-Security "max-age=31536000"
  }
  ```

  `-p 80:80 -p 8443:8443`, otherwise as case 1. Touches nothing of theirs.
- **4b: 80 is a host nginx's that includes `conf.d/*.conf`.** The board's Caddy listens for the
  check on the host's loopback only (`-p 127.0.0.1:8480:80`, `-p 8443:8443`), and a new file of
  the board's in nginx's `conf.d` sends only the check's path, only for the board's domain, there:

  ```
  # agent-board: certificate checks for board.example.com go to the board's own Caddy. Its Undo removes this file.
  server {
      listen 80;
      listen [::]:80;
      server_name board.example.com;
      location /.well-known/acme-challenge/ {
          proxy_pass http://127.0.0.1:8480;
          proxy_set_header Host $host;
      }
      location / {
          return 301 https://$host:8443$request_uri;
      }
  }
  ```

  A new file in a folder nginx already includes; none of their files changes. `nginx -t`, then
  `systemctl reload nginx`; their hosts fetched before and after on 80 and 443 (call 21); then a
  check that the path reaches the board's Caddy through nginx: the board's Caddyfile in 4b also
  has `http://board.example.com { respond /.well-known/acme-challenge/agent-board-check
  "agent-board" }`, and the run fetches that path through nginx with the domain as Host. The
  file's `listen` lines copy the addresses of their own port-80 `listen` lines (from Look),
  without `default_server`: nginx bound to a given address on 80 never considers a `*:80` server,
  and `[::]:80` fails where IPv6 is off. Should the check still fail, everything rolls back.
- **4c: anything else on 80** (Apache, Traefik, nginx in Docker, unknown): no certificate is
  possible without touching it. Not done by Apply. "Do it myself" says what is needed: their
  server forwarding `/.well-known/acme-challenge/` for the domain to the board's Caddy (as 4b),
  or a certificate by DNS (not covered).

Why not let nginx serve the board on 443 (a clean address): nginx gets no certificate by itself;
it would need certbot and a renewal hook on top, and an edit of their nginx's site. The ACME-only
file is the smallest change that gives the board a real certificate. A self-signed or internal
certificate is no way out: browsers refuse passkeys (WebAuthn) and the service worker on a page
with a certificate error.

**Rollback:** as case 1, plus the nginx file removed and nginx reloaded (4b).

### Case 5: Do it myself

The same plan, as the owner would run it, with no framework around it **(call 8)**:

- each step: its title, one line on why, its commands (`sudo` in front of what needs root) with
  Copy, what to check after (the check the board would run, as a command), and how to undo it;
- the backups as commands (`sudo cp -p …`), the in-place writes as `sudo tee`, the reload, the
  fetches;
- at the end, "Test connection".

**Without Look (call 28).** "Do it myself" is there before any Look, for an owner who does not
want to give the board an admin connection. The owner picks the case ("Nothing on 80 and 443",
"Caddy as a service", "Caddy in Docker", "nginx or something else"); what Look would have filled in
(their Caddyfile's path, their container, its network, the folder's gid) stays as `<placeholder>`,
each with the command that finds it (`systemctl show caddy -p ExecStart`, `docker ps`,
`docker inspect …`, `stat -c %g /var/lib/boardtunnel`). The tunnel spec's Caddy and nginx snippets
move here.

## Installing Docker (call 19)

**Only on Debian (12, 13) and Ubuntu (22.04, 24.04, 25.10, 26.04), from Docker's own apt
repository, by the steps Docker documents**, one code path for both, tested on Debian 13, Ubuntu
26.04 and 24.04. The board knows the codenames Docker's repository serves (`bookworm`, `trixie`,
`jammy`, `noble`, `questing`, `resolute`; the spike checks each is there); another codename is
"Do it myself". In the plan, with its tick:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/<debian|ubuntu>/gpg -o /etc/apt/keyrings/docker.asc
# the key must be Docker's: 9DC8 5822 9FC7 DD38 854A  E2D8 8D81 803C 0EBF CD88
gpg --show-keys --with-fingerprint /etc/apt/keyrings/docker.asc | grep -q '9DC8 5822 9FC7 DD38 854A  E2D8 8D81 803C 0EBF CD88'
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/<debian|ubuntu> $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io
```

(The board's run waits up to 5 minutes for apt's lock, which unattended-upgrades often holds; how
the fingerprint is checked where `gpg` is missing is the builder's.)

Why this one:

- **Not the convenience script** (`get.docker.com`). Docker itself says it is not for
  production. It is a remote script run as root that the plan cannot show; it may change more than
  it says.
- **Not the distribution's packages** (`docker.io`). They differ by distribution (Fedora's
  `moby-engine`, nothing on RHEL), lag behind, and conflict with Docker's own packages, which most
  guides the owner may follow later install. One method for the supported distributions is also
  one to test.
- **Docker's repository** is what Docker documents for servers, current, and its steps are plain
  commands the plan shows as they are. Its cost: a third-party apt source and key on the server.
  The plan lists both, and so does Undo.

Before installing, Look checks for packages that conflict (`docker.io`, `podman-docker`,
`containerd`, `runc`): if one is there, no install; "Do it myself". Docker sets firewall rules of
its own and may set the kernel's forwarding policy to drop: on a server that forwards traffic for
others (LXD, libvirt, a WireGuard gateway) that can cut them off. Look checks for those and the
plan warns, next to the tick (call 27).

Other distributions, with Docker or without: "Do it myself", with the commands for the case Look
found (owner, 2026-10-21).

**Undo and Docker (call 20).** Undo does not remove Docker by default. It offers to, as a separate
tick, only when the record says the board installed it and Docker holds no container, volume or
image but the board's. A failed Apply keeps a Docker install that finished: Docker alone changes
nothing the owner's sites see, and the next Apply needs it.

## What the board owns on the server

Everything the board adds is named here, so Undo can be exact. Names and labels are the
builder's to spell; their set is not.

| What | Where | Case |
|---|---|---|
| the record | `/etc/agent-board/setup.json` (root, `644`; no secret) | all |
| backups of their files | `/etc/agent-board/backups/<run id>/…` (root, `600`) | 2, 3 |
| runs' scripts and logs, the lock | `/etc/agent-board/runs/<run id>.sh`, `.log` (root, `600`); `/etc/agent-board/lock` | all |
| the board's Caddyfile | `/etc/agent-board/caddy/Caddyfile` (root, `644`) | 1, 1b, 4a, 4b |
| the board's site for their Caddy | `/etc/caddy/agent-board/board.caddy` and its folder | 2 |
| one line in their Caddyfile | `import /etc/caddy/agent-board/board.caddy # agent-board`, at the end | 2 |
| one block in their Caddyfile | from `# >>> agent-board…` to `# <<< agent-board`, at the end | 3a, 3b |
| the nginx file | `/etc/nginx/conf.d/agent-board.conf` | 4b |
| the socket folder's group | `/var/lib/boardtunnel`: from (recorded) → Caddy's | 2 |
| containers | `agent-board-caddy` (1, 1b, 4a, 4b), `agent-board-socket` (3a, 3b); labels `agent-board.role`, `agent-board.setup=<run id>` | |
| volumes | `agent-board-caddy-data`, `agent-board-caddy-config`, labelled | 1, 1b, 4a, 4b |
| images | `caddy:2.x.y@sha256:…`, `alpine/socat:<v>@sha256:…`, each with whether it was there before | |
| Docker | the packages, `/etc/apt/sources.list.d/docker.list`, `/etc/apt/keyrings/docker.asc`, when installed by the board | 1, 1b, 4 |

**The record (call 23)** lives on the server, so Undo works from a reinstalled board or another
PC with the same settings. It names: the run's id and time; the state (`running`, `applied`,
`rolled-back`, `rollback-failed`); the case; **the pair** (the tunnel user and the socket path),
the domain, the public port and the address; and each item above with what Undo needs (a file's
`sha256` as written; a line or block and its file; a backup's path; a group's old value; an image's
"there before"). config.json keeps a summary for the panel, `tunnel.setup: { case, address, at }`.

**Whose setup it is (call 30).** The pair identifies "this board's" setup: a record whose tunnel
user and socket are the panel's is this board's, whatever its domain. Look then plans:

- same pair, same domain and public port: already set up; Apply checks each item and says
  "nothing to change" (or repairs what is missing);
- same pair, another domain or public port: an **update** (below), not a stop;
- another pair: a stop, "Another board's setup is on this server (tunnel user `<u>`, socket `<s>`,
  `<domain>`): Undo it from that board, or with those settings here", with "Do it myself" (the
  Undo's commands from that record).

**Undo from a reinstalled board or another PC.** Nothing on the PC is needed but the same tunnel
user and socket in the panel, the admin user (typed again), and the server's key pinned by Test
connection. Undo's Look reads `/etc/agent-board/setup.json`, finds the pair is the panel's, and
plans from the record; a missing `tunnel.setup` in config.json is filled in from it.

**What Undo does (call 22).**

- A line or block of the board's is removed **from the file as it is now**, in place: the exact
  line (case 2), or everything between the markers (case 3). The backup is not written back:
  the owner may have edited their file since, and a backup would undo that too. The backup is
  only for an Apply's own rollback, when nothing else touched the file in between.
- Then: their Caddy validated and reloaded; their hosts fetched before and after, as for Apply.
- A file of the board's whose `sha256` is no longer the one written (the owner edited it): the
  Undo plan says so and asks before removing it.
- Containers and volumes go by name **and** label; one with the name but not the label is not
  the board's and stays.
- Images go only when the record says the board pulled them, and nothing uses them.
- The folder's group goes back.
- Last, `/etc/agent-board` goes, backups included.
- What the owner made by hand stays (call 32): the tunnel user, the folder, the keys file, the
  `Match` block. The Undo plan ends with the commands to remove those, to copy if wanted.

## Validation and rollback, per case

| Case | Checked before anything of theirs changes | Applied by | Checked after | Rolled back by |
|---|---|---|---|---|
| 1, 1b | ports still free (call 11); image pulled | `docker run` | container running, ports held; Test connection | container, volumes, files, images removed |
| 2 | file's hash = Look's; candidate beside it: `caddy adapt` host set = old + domain; `caddy validate` as `caddy` | in-place write; `systemctl reload caddy` | `is-active`; their hosts' statuses as before | backup written back in place; our file removed; group back; reload; statuses again |
| 3a, 3b | hash = Look's; the helper answers the probe from their container (when it has `wget`); candidate validated inside (folder mount) | in-place write; `caddy reload` inside their container | their hosts' statuses as before | backup in place; reload; helper removed |
| 3, file mount | hash = Look's; probe | in-place write, then validated inside at once | as above | backup in place at once (no reload has run), helper removed |
| 4a | 80 free, 443 not ours, 8443 free | `docker run` | container, ports; Test connection | as 1 |
| 4b | as 4a; `nginx -t` with the new file | new file; `systemctl reload nginx` | their hosts on 80 and 443 as before; the check path reaches our Caddy | file removed, nginx reloaded; as 1 |

**"Their sites still answer" (call 21)** is three checks, each cheap and each able to stop the run:

- the config validates (`caddy validate`, `nginx -t`);
- the host names their proxy serves are the same before and after, plus the board's domain
  (`caddy adapt`; for nginx the `server_name` lines);
- each of their exact host names, up to 20, answers with the same HTTP status before and after
  the reload, fetched on the server at their proxy's own address with SNI (`curl --resolve`, or
  `wget`). One retry after 2 s rules out a blip; a host that did not answer before is left out.
  Without `curl` and `wget` the plan says this check is skipped.

A mismatch rolls back. A false alarm (an upstream that flips its status) costs a rollback; that is
the right side to err on.

**Test connection's domain step** after Apply is not a rollback reason (call 24). A missing
certificate usually means DNS or a provider's firewall; their sites were checked already. The
result says what failed and Caddy keeps trying for the certificate.

## The socket's permissions, per case

From the tunnel spec's spike: the folder is `drwxr-s---` (setgid), the socket takes the folder's
group, and `StreamLocalBindMask 0117` makes it `srw-rw----`: its owner and that group only. A
user outside the group cannot even list the folder (`Permission denied`). Each new tunnel makes a
new socket file (`StreamLocalBindUnlink`).

| Case | Who opens the socket | As | The folder's group | How |
|---|---|---|---|---|
| 1, 1b, 4a, 4b | `agent-board-caddy` | root without `CAP_DAC_OVERRIDE`, plus gid `<gid>` | unchanged (step 1's: the tunnel user's own) | `--group-add <gid>`; the folder mounted read-only |
| 2 | their Caddy service | `caddy`, group `caddy` | Caddy's (Apply's `chgrp`; Undo puts it back) | the group; nothing else |
| 2, Caddy running as root | their Caddy | root | unchanged | root's own rights; the plan says so |
| 3a, 3b | `agent-board-socket` | uid 65534 (nobody), gid `<gid>` | unchanged | `--user 65534:<gid>`; read-only mount |

- The folder's group never gets a member it should not have. If Look finds the folder's group has
  members other than its reader (a shared group like `users`), it warns and the plan offers the
  tunnel user's own group.
- The folder stays `2750`: the group can open the socket but cannot make, remove or replace a file
  there. Only the tunnel user (and root) can.
- A folder made the old way, with `caddy`'s group: case 2 needs no change; the containers get
  `caddy`'s gid.
- Docker with user namespaces maps group ids, so `--group-add <gid>` would not be the host's gid:
  not done by Apply (call 25).

## Apply twice, changes, and interrupted runs

- **Every step checks before it acts** (call 10): a line or block that is there already, a
  container with the right label and the same settings (a hash of them in a label), a volume, an
  image, a group already Caddy's: left as they are. So Apply twice (the record's pair, domain and
  public port all the panel's, call 30) changes nothing the second time and says "nothing to
  change".
- **A changed domain or public port** after a setup (the record's pair is the panel's, call 30):
  Look plans an update. The board's own files and blocks are rewritten, its containers recreated
  when their settings changed; their Caddy reloaded once.
- **A changed tunnel user or socket** makes another pair: the record is no longer this board's
  and Look stops, as for another board's (call 30). To move the setup: put the old pair back in
  the panel, Undo, then set the new pair and Apply.
- **A run that did not finish** (the server rebooted mid-run: the record says `running` and no lock
  is held): Look says so; the plan first undoes what the record names, then applies.
- **`rollback-failed`**: the panel shows exactly which items are left, each with its command;
  "Do it myself" shows the rest of the Undo.
- **Apply after the server changed since Look (call 11):** the plan carries what it relies on (who
  holds 443 and 80, their config's hash, their container's id). The run checks them first and stops
  before changing anything if one differs: "Look again".
- **The Caddy versions**: the board's containers move to the board's pinned image when the owner
  applies again with a newer board.

## Changes elsewhere in the board

- **`tunnel.publicPort` (call 17).** Default 443. Any other port changes, together: the tunnel
  listener's Host check (`<domain>:<port>`), the Origin it requires and WebAuthn's expected origin
  (`https://<domain>:<port>`), the probe's URL, the panel's and the README's address. The relying
  party stays the domain, so passkeys survive a port change; cookies do not depend on the port, so
  logins do too; no `domainChanged`. Set by Apply in case 4 (8443) and back to 443 by its Undo;
  also a field in the panel. Checked as the other ports are.
- **config.json `tunnel.admin`** `{ user, key }` and **`tunnel.setup`** `{ case, address, at }`.
  None is secret. Unknown fields kept.
- **`POST /api/access` ops** (local-only already, as the whole route is): `server-admin` (the two
  fields), `server-look` `{ password? }`, `server-apply` `{ plan, docker?, password? }` (the plan's
  id from the last Look, kept by the board), `server-undo-look`, `server-undo` `{ plan,
  removeDocker?, password? }`. A refused op's answer never echoes its body.
- **`AccessView` gains `server`**: the admin fields, what sudo needs, the phase (idle, looking,
  plan, applying, undoing, done, failed), what Look found (as the panel shows it), the plan, a run's
  progress and output, the record's summary. Never the password. `accessRev` moves as a run
  reports.
- **Snippets** (`src/core/tunnel-snippets.ts`): the folder's group (call 2), the one-paste block
  (call 3), and the per-case texts of this document, all from one place, which the plan builder and
  "Do it myself" share.
- **README**: "On the server" becomes the three steps; the per-case details for "Do it myself";
  the case-3 trade-off in one paragraph; the new fields in Settings.
- **The tunnel spec**: the lines in "What this changes in the tunnel spec".

## Constraints

- **The server**: Debian 12, 13 or Ubuntu 22.04, 24.04, 25.10, 26.04; POSIX `sh`, `ss`
  (iproute2), `flock`, `setsid`, `runuser` (util-linux), `getent`, coreutils GNU or Rust (only
  flags both take: `base64 -d`, `sha256sum`, `stat -c`, `install`, `timeout`; no `tail -f
  --pid`); sudo, sudo-rs or root. Case 2 needs systemd. Docker 20.10 or newer when it is there.
  Their Caddy 2. Any other OS, and what call 25 names, goes to "Do it myself".
- **Look is read-only** (call 9); Apply and Undo change only what their plan lists.
- **Idempotent**: Apply twice is safe; Undo twice is safe (the second finds nothing).
- **The PC**: Windows' own OpenSSH by full path, no shell, no prompt, stdin a pipe, paths with
  spaces, `%` and other alphabets through `sshPathArg`; the remote command is fixed text plus base64.
- **The board's layers**: the plan, the scripts, the parsers and the per-case texts are pure
  (`src/core`), so the page renders "Do it myself" from the same functions. Web code imports only
  core modules without `node:` imports.
- **Texts** in English and Russian (the i18n test checks every dictionary). The commands and the
  server's files are English only.
- **Tests never touch the owner's server**, nor port 12422, nor the owner's state folder. The
  integration tests run against containers on Docker Desktop and are off unless asked for.

## Risks and things to watch

- **Their Caddyfile's last block has no braces** (a single site, written bare). Anything appended
  then belongs to that site. `caddy validate` (or the host-set check) catches it and nothing is
  reloaded; the hint names the cause.
- **A file bind mount and a new file** (call 14). Anything that writes a new file and renames it
  (`sed -i`, an editor's safe save, `mv`) leaves their container on the old one. The board writes
  in place; the spike proves the container sees it.
- **`docker compose down` with the helper on their network** (3a): the network stays, compose says
  so. Disclosed in the plan; the spike records exactly what compose prints and its exit code.
- **Docker Hub's pull limits** for anonymous pulls. Two small images; the hint says to try later.
- **IPv6 callers through Docker's userland proxy** reach the board's Caddy (cases 1, 4) from the
  bridge's address, not their own: the board shows that address and groups their rate limits.
  Logins are unaffected.
- **HSTS on 8443** applies to the domain on every port; harmless while nothing else serves the
  domain over HTTP (4b's file redirects to 8443).
- **Certificates and their limits.** A domain whose DNS record is wrong makes the CA's checks fail
  again and again; Let's Encrypt allows a few failures an hour. Look's DNS warning comes first; the
  integration tests use Pebble, never Let's Encrypt (call 31).
- **sudo variants**: `requiretty`, `pam_faillock`, `sudo-rs`, a lecture on first use. Covered by
  the hints and the spike, with each one's lines recorded on Debian 13 and Ubuntu 26.04.
- **Rust coreutils** (Ubuntu 25.10, 26.04) differ from GNU's in some flags. The scripts keep to
  POSIX forms and the flags the spike found in both; the integration tests run every script on
  Debian 13 and Ubuntu 26.04.
- **Windows' ssh and a pipe on stdin**: older Windows builds of OpenSSH did not pass a closed stdin
  on. The spike checks 9.5p2 with sudo reading the password.
- **Two people press Apply** (two tabs, two boards): the server's lock lets one run.
- **The case-3 TCP hop** weakens one of the tunnel spec's fences, as described in case 3; the
  owner chose it with this said.
- **The owner's sites behind a CDN or with client certificates** may answer the fetches from the
  server differently than from the internet; the fetches compare before with after on the server,
  so they stay comparable.

**Checked by the spike (2026-10-21, Debian 13 sudo 1.9.16p2, Ubuntu 26.04 sudo-rs 0.2.13,
OpenSSH_for_Windows_9.5p2, Docker 29.9.2):** the test servers of `test/integration/server/` side
by side in Docker Desktop 29.7.2: Debian 13.7 (OpenSSH_10.0p2 Debian-7+deb13u4, GNU coreutils 9.7,
systemd 257) and Ubuntu 26.04.1 (OpenSSH_10.2p1 Ubuntu-2ubuntu3.8, uutils coreutils 0.10.0,
systemd 259, sshd by socket activation), each with Docker CE 29.9.2 and Compose v5.6.1 inside;
Windows' own `ssh.exe` spawned from Bun as an argument list; Pebble and challtestsrv on a Docker
network. A code block holds whole lines as printed; `<…>` marks what varies. Each point held on
both servers unless it names one. Look's outputs from every scenario on both are the fixtures in
`test/fixtures/server-look/`.

- **Look writes nothing** (both rounds through the admin line, every scenario on both servers,
  then `find / -xdev -newer <marker>` outside `/proc`, `/sys`, `/run`, `/dev`): what changed is
  the login's and sudo's own (`/home/admin/.sudo_as_admin_successful` on Debian 13,
  `/home/admin/.cache/motd.legal-displayed` on Ubuntu 26.04, the journal) and, where round two
  runs `docker exec`, `/tmp`'s time (Docker's runtime passes the exec through a file there). **Caddy
  2.6.2 makes `$HOME/.step`** (an empty folder; its smallstep part) on any run, `caddy version`
  included; Look runs Caddy with `STEPPATH=/`, a folder that exists, and then nothing is made.
  Caddy 2.11.7 makes nothing either way. Apply's own `caddy adapt` as root (case 2) needs the
  same, or it leaves `/root/.step` behind that no record names.
- **Step 1** (`test/integration/server/step1.sh`, the one paste) run twice: no error the second
  time. The folder is `drwxr-s--- boardtunnel boardtunnel` (`2750`), the account `boardtunnel:*`; a
  Windows `ssh -R` makes the socket `srw-rw---- boardtunnel boardtunnel`. `sshd -t` passes, and
  `sshd -T -C user=boardtunnel,host=localhost,addr=127.0.0.1` prints the `Match` block's 16
  settings with the keys lowercased and the values exactly as `sshdBlock` writes them
  (`allowtcpforwarding remote`, `permitlisten none`, `streamlocalbindmask 0117`,
  `forcecommand /bin/false`, …).
- **The reload line changes (Task 21).** On Ubuntu 26.04 `ssh.socket` is enabled and `ssh.service`
  runs only once someone has connected. While it runs (an admin pasting over SSH) `systemctl
  reload ssh` and `systemctl reload sshd` both work, on both. When it does not (step 1 from a
  console), both print `ssh.service is not active, cannot reload.` and exit 1, which ends the
  `set -e` paste. `systemctl try-reload-or-restart ssh` exits 0 either way: it reloads a running
  sshd and leaves a socket-activated one to read the new config at the next connection; for a
  unit that does not exist it prints `Failed to reload-or-try-restart <unit>: Unit <unit> not
  found.` and exits 5. So the paste ends with
  `{ sudo systemctl try-reload-or-restart ssh 2>/dev/null || sudo systemctl try-reload-or-restart sshd; }`
  (step1.sh has it).
- **The socket from containers** (`alpine/socat`, the folder mounted `:ro`): root with
  `--cap-drop ALL --group-add <gid>` opens it; without `--group-add`:

  ```
  <time> socat[1] E connect(, AF=1 "/var/lib/boardtunnel/board.sock", 33): Permission denied
  ```

  `--user 65534:<gid> --read-only --cap-drop ALL --security-opt no-new-privileges` opens it,
  `--user 65534:65534` gets the same `Permission denied`; root with Docker's default capabilities
  opens it without the group (`CAP_DAC_OVERRIDE`), which is why the board's containers drop them
  all. After the tunnel reconnects the socket is a new file (a new birth time; the filesystem
  reused the inode number), and a running helper with the folder mounted opens it unchanged.
- **The folder to Caddy's group:** `chgrp caddy` on the folder and the socket, then `chmod 2750`:
  `drwxr-s--- 2750 caddy`, the setgid bit kept; the socket `srw-rw---- … caddy`.
- **Host Caddy** (2.6.2 from the package on both; `ExecStart` `/usr/bin/caddy run --environ
  --config /etc/caddy/Caddyfile`, `ExecReload` `/usr/bin/caddy reload --config
  /etc/caddy/Caddyfile --force`, `User=caddy`, `Group=caddy`, `WorkingDirectory=` empty): the
  candidate ending in `import /etc/caddy/agent-board/board.caddy # agent-board` passes `caddy adapt`
  (the host set: theirs plus `board.example.com`) and `runuser -u caddy -- caddy validate`
  (`Valid configuration`); after `systemctl reload caddy` (exit 0, still active) it serves the
  board through the socket with `X-Forwarded-Proto: https`, and their two sites as before. Appended
  after a brace-less last site, `caddy adapt` and `caddy validate` both refuse it (exit 1):

  ```
  Error: /etc/caddy/agent-board/board.caddy:2: unrecognized directive: board.example.com
  Did you mean to define a second site? If so, you must use curly braces around each site to separate their configurations.
  ```

  A reload of a broken file prints `Job for caddy.service failed.` and exits 1; Caddy stays active
  on its running config and the sites answer. The reductions, on 2.6.2 and 2.11.7 alike:
  `caddy adapt … | grep -oE '"host":\[[^]]*\]|"admin":\{"disabled":true|"automatic_https":\{"disable":true'`
  prints `"host":["a.example.com"]` per site (`"host":["x.example.com","y.example.com"]` for one
  site with two names), `"admin":{"disabled":true` for `admin off`,
  `"automatic_https":{"disable":true` for `auto_https off`, nothing else.
- **Caddy in Docker** (compose, official image 2.11.7): `cat new > Caddyfile` reaches the
  file-mounted container (the same inode inside and out); `mv new Caddyfile` does not (the
  container keeps the old inode until it is recreated). `docker exec <id> caddy validate` and
  `docker exec <id> caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile` exit 0, the
  container the same. The helper with the design's flags on `web_default`: their container
  reaches `http://agent-board-socket:8080/` (busybox `wget` and `nc` are in the official image),
  their Caddy proxies the marked block's site there, and the board gets `Host:
  board.example.com`, `X-Forwarded-Proto: https`, and as `X-Forwarded-For` the network's gateway
  (`172.19.0.1`) for a request from the server itself through Docker's proxy. `docker compose
  down` with the helper on the network exits 0 and prints:

  ```
   Container web-caddy-1 Stopping 
   Container web-caddy-1 Stopped 
   Container web-caddy-1 Removing 
   Container web-caddy-1 Removed 
   Network web_default Removing 
   Network web_default Resource is still in use 
  ```

  The network and the helper stay; `docker compose up -d` puts their Caddy back on it, and it
  reaches the helper again.
- **Who holds a port.** A host-network container's process is in
  `…/system.slice/docker-<id>.scope` (systemd's cgroup driver, Docker's default on both), `<id>`
  its full id. With Docker's userland proxy (the default) `ss -H -ltnp` shows `docker-proxy` (in
  `docker.service`) on `0.0.0.0:<port>` and `[::]:<port>`. **With `"userland-proxy": false`,
  `dockerd` itself holds each published port (IPv4 only): not nothing, as "Look" says.** Look
  maps `docker-proxy` and `dockerd` alike to the container through its port bindings. In the test
  servers, being containers, every cgroup path starts with `/docker/<server's id>/`; Look reads the
  deepest part.
- **Certificates through Pebble** (the board's flags, `acme_ca https://pebble:14000/dir`,
  `acme_ca_root` mounted read-only): case 1 gets `certificate obtained successfully` by `http-01`;
  1b (`disable_http_challenge`, only 443 published, 80 held by python3) by `tls-alpn-01`; 4b
  (`-p 127.0.0.1:8480:80 -p 8443:8443`, the design's `conf.d/agent-board.conf`, `nginx -t` and
  the reload clean) by `http-01` through nginx, whose check path answers `agent-board` and other
  paths `301 https://board.example.com:8443/x`, their site on 80 and 443 as before. The issuer is
  `CN=Pebble Intermediate CA <…>`. Containers inside a test server do not resolve the outer Docker
  network's names (inner Docker replaces the server's `127.0.0.11` resolver with public DNS): the
  spike gave the board's Caddy `--add-host pebble:<ip>`, and Task 25's harness needs the same or
  another way. challtestsrv's `add-a` adds to its earlier answer: `clear-a` first.
- **Two proxies at once:** their Caddy on 443 with the marked block and the helper served their two
  sites and the board side by side; their nginx on 443 and the board's Caddy on 8443 (Pebble's
  certificate) answered interleaved requests at once, the board with `Host: board.example.com:8443`.
- **sudo over the admin line** (`ssh -F none -T … -o BatchMode=yes -o StrictHostKeyChecking=yes`,
  the remote command `sudo -S -p '' -- sh -c 'eval "$(echo <b64> | base64 -d)"'`): a script
  printing ``it's $ ` % Ж "q"`` arrives and prints it unchanged; the password on stdin, stdin then
  closed (Windows' ssh passes the close on), is read; `sudo -n --` (NOPASSWD) and `sh -c` (root)
  work. stderr, exit 1 each, Debian 13's sudo | Ubuntu 26.04's sudo-rs (which names itself `sudo`,
  as it runs as `sudo`):
  - `sudo -n` without NOPASSWD: `sudo: a password is required` |
    `sudo: interactive authentication is required`;
  - a wrong password: `Sorry, try again.`, an empty line, `sudo: no password was provided`,
    `sudo: 1 incorrect password attempt` | an empty line, `sudo: Authentication failed, try
    again.`, an empty line, `sudo: Authentication required but not attempted`;
  - nothing on stdin: an empty line, `sudo: no password was provided`, `sudo: a password is
    required` | an empty line, `sudo: Authentication required but not attempted`;
  - not in sudoers, with its right password: `nosudo is not in the sudoers file.` |
    `sudo: I'm sorry nosudo. I'm afraid I can't do that`; with `sudo -n`: `sudo: a password is
    required` | `sudo: I'm sorry nosudo. I'm afraid I can't do that`;
  - `Defaults requiretty`: `sudo: sorry, you must have a tty to run sudo` (with a password, `-n`
    and NOPASSWD alike) | sudo-rs runs anyway (exit 0) after printing
    `/etc/sudoers.d/<file>:1:10: unknown setting: 'requiretty'`, `Defaults requiretty` and
    `         ^~~~~~~~~~`: **`requiretty` stops classic sudo only**;
  - the right password: nothing | an empty line;
  - `sudo --version`'s first line: `Sudo version 1.9.16p2` | `sudo-rs 0.2.13-0ubuntu1.2`;
  - three wrong passwords in three connections, then the right one: accepted on both (these
    images have no `pam_faillock`); no lecture on first use on either.

  Windows' ssh to a changed host key prints the `@@@…` banner, `WARNING: REMOTE HOST
  IDENTIFICATION HAS CHANGED!`, …, `Host key verification failed.` and exits 255.
- **coreutils:** on Ubuntu 26.04 (uutils 0.10.0) `stat -c '%a %U %G %g'` (`2750 nopw nopw 1002`)
  and its error (`stat: cannot statx '<path>': No such file or directory`), `base64 -d` (also of
  one long line), `sha256sum` of a file and of stdin (`<hash>  -`), `install -d -m 2750 -o -g`,
  `timeout -k 1 1` (124; 137 when the command ignores TERM), `wc -l` (of stdin: the number
  alone), `tail -c 1 | wc -l` (1, 0, 0: a final newline, none, an empty file), `comm -12/-23/-13`,
  `sort -u`, `cut -d ' ' -f 1`, `head -n 1` print what GNU's do on Debian 13; `sed` is GNU sed 4.9
  on both. `tail -f --pid=<pid>` ends with the pid on both (uutils 0.10.0 takes it); the scripts do
  without it all the same. `ls --version`: `ls (GNU coreutils) 9.7` | `ls (uutils coreutils)
  0.10.0`.
- **Docker's repository:** `https://download.docker.com/linux/<distro>/dists/<codename>/Release`
  answers 200 for `debian` `bookworm`, `trixie` and `ubuntu` `jammy`, `noble`, `questing`,
  `resolute` (`debian/dists/sid`: 404). The design's commands on the `nodocker` servers install
  Docker 29.9.2, active right after; `docker.io`, `containerd` and `runc` stay `not-installed`
  (`containerd.io` is not `containerd`), so Look's conflict check stays empty after the board's
  own install. **Neither server has `gpg`** (Debian 13 has `sqv`, Ubuntu 26.04 `gpgv`): the
  design's fingerprint line exits 1 there. Without gpg, the key's v4 fingerprint is the SHA-1 of
  its first packet (`99 02 0d`: 3 + 525 bytes):
  `sed -e '/^-----/d' -e '/^=/d' -e '/:/d' -e '/^$/d' /etc/apt/keyrings/docker.asc | base64 -d | head -c 528 | sha1sum`
  prints `9dc858229fc7dd38854ae2d88d81803c0ebfcd88  -` on both (GNU and uutils); the file's sha256
  is `1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570`. With `gnupg` installed,
  `gpg --show-keys --with-fingerprint` prints `      9DC8 5822 9FC7 DD38 854A  E2D8 8D81 803C 0EBF
  CD88` under `pub   rsa4096 2017-02-22 [SCEA]`, and the design's grep matches.
- **The pins** (`docker buildx imagetools inspect`):
  `caddy:2.11.7@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af` (what
  `caddy:2` points at today) and
  `alpine/socat:1.8.1.3@sha256:22d77becaeeea8ef56b8c4bb2312323acafe85354be6a85714ff5050e3537842`
  (socat 1.8.1.3); `alpine/socat` does the job as designed.
- **Podman, user namespaces, rootless** (Look's outputs in `test/fixtures/server-look/hand/`): with
  `podman-docker` (Podman 5.4.2) `docker --version` prints `Emulate Docker CLI using podman. Create
  /etc/containers/nodocker to quiet msg.` and `podman version 5.4.2`, `docker version --format
  '{{.Server.Version}}'` prints `5.4.2` and `SecurityOptions` nothing; `podman-docker` is an
  installed conflict. `"userns-remap": "default"` adds `name=userns` to `SecurityOptions`.
  Rootless Docker was not installed: its fixture is written by hand. A rootless daemon is not the
  one root's `docker` talks to, so besides `name=rootless` in `SecurityOptions` Look also counts a
  daemon socket under `/run/user/<uid>/` with no system daemon as rootless.
- **The test images:** the distributions' images ship `/usr/sbin/policy-rc.d` (`exit 101`), which
  keeps an installed service from starting (`invoke-rc.d: policy-rc.d denied execution of
  start.`); the test images remove it, as a server has none. Ubuntu 26.04's image installs
  `sudo-rs` by name (`sudo` without its recommends is classic sudo 1.9.17p2), so `sudo` is sudo-rs
  as on a fresh server. Ubuntu 24.04's image (sudo 1.9.15p5, GNU coreutils 9.4) builds and takes
  the admin line with a password the same way; its scenarios are Task 25's.

**Checked by the integration tests (2026-10-21, `test/integration/`, Docker Desktop 29.7.2,
OpenSSH_for_Windows_9.5p2):** the test servers of `test/integration/server/` (now with
`libpam-systemd`, so that an SSH login is a logind session, as on a server): Debian 13 (sudo
1.9.16p2, OpenSSH 10.0p2), Ubuntu 26.04.1 (sudo-rs 0.2.13, OpenSSH 10.2p1), Ubuntu 24.04.5 (sudo
1.9.15p5, OpenSSH 9.6p1), Debian 12 (sudo 1.9.13p3, OpenSSH 9.2p1) and Ubuntu 22.04.5 (sudo 1.9.9,
OpenSSH 8.9p1), each with Docker CE 29.9.2 on containerd's image store
(`io.containerd.snapshotter.v1`), a fresh server per scenario. A sandboxed board does what the
panel does, through `POST /api/access` and Windows' own `ssh.exe`: Generate key, step 1 as the one
paste (twice), Test connection (it pins the server's key), Look, Apply, Look and Apply again,
Undo's Look and Undo. The admin is `admin` with the sentinel ``S3cr3t%$'"`Ж`` as its sudo password,
`nopw` (NOPASSWD) on `bare` and root on `dummy80`. Each distribution has its own Pebble, challenge
DNS and client container; the board's Caddy names Pebble through `BOARD_SETUP_ACME_CA*`, their
Caddy (cases 2, 3) through its own `acme_ca`; the board's probe reaches `https://board.example.com`
from the PC through a CONNECT proxy, trusting Pebble's root. The domain is then fetched from the
client through the tunnel's own ssh line (`sshArgs`) to a stand-in board, its certificate checked
against Pebble's root; a watcher in the client fetches their sites twice a second from before Apply
to the end of Undo. Every row below held on both Debian 13 and Ubuntu 26.04 unless it names others.

- **bare** (case 1; Debian 12, 13, Ubuntu 22.04, 24.04, 26.04): Look 1; Apply applied, Test
  connection's domain ✓; the domain → the stand-in with `Host: board.example.com`,
  `X-Forwarded-Proto: https`, the client's own address rightmost in `X-Forwarded-For` (Docker's
  DNAT keeps it), a certificate from Pebble; Apply again "nothing to change" (their files' hashes
  and every container's id the same); Undo: nothing of the board's left (containers, volumes,
  `/etc/agent-board`, lines), the folder's group `boardtunnel`, the board's image gone (`docker
  image inspect` and `docker image rm caddy:2.11.7@sha256:…` by tag and digest work on
  containerd's store, where the pull shows as `caddy <none> sha256:685ae3d7…`), Docker kept.
- **nodocker** (case 1 with Docker's install; all five): the Docker tick; Docker CE from Docker's
  repository, the key checked without gpg; then as `bare`; Undo keeps Docker.
- **dummy80** (1b, root): certificate by TLS-ALPN, python3's site on 80 answering throughout.
- **caddy-unit** (2; Debian 12, 13, Ubuntu 24.04, 26.04; Ubuntu 22.04 has no caddy package): their
  Caddy 2.6.2 from the package; its file's hash back exactly after Undo, the folder's group back,
  their two sites answering throughout. Their 2.6.2 cannot read Pebble's Retry-After (an HTTP date)
  when Pebble's finalize answers "processing", and tries again a minute later: now and then after
  the board's 2 minutes of Test (the test then waits longer from the client); a CA's seconds it
  reads, and Caddy 2.11.7 reads both.
- **compose-folder**, **compose-file** (3a, `/srv/my web`, network `web_default`): the helper on
  their network; their Caddy reloaded inside its container, the same container id after; Undo's
  hashes as before. (Their Caddy on a user network asks Docker's embedded DNS, which passes no
  single-label name on: the tests give it the CA's address with `extra_hosts`.)
- **caddy-host** (3b): the helper on the host's 127.0.0.1:8481.
- **nginx-443** (4a) and **nginx-80-443** (4b): `https://board.example.com:8443`,
  `tunnel.publicPort` 8443 after Apply and gone after Undo; 4b's certificate by HTTP-01 through
  their nginx; their `conf.d` at mode 750 keeps it (Apply's `install -d` now runs only when the
  folder is missing).
- **caddy-bridge** (3c), **apache** (4c), Podman, rootless Docker, SELinux (faked where Look reads
  them: Docker's `--version` and security options, `getenforce`): Look's `Manual` reason (`bridge`,
  `other80`, `podman`, `rootless`, `selinux`), no plan, their sites answering.
- **The sudo password**: in no file under `/etc/agent-board` or `/var/log` on any server (`grep
  -r`, after Apply and after Undo) and none under the board's sandbox. A wrong one: 409
  `wrongPassword`, one `pam_unix(sudo:auth): authentication failure` in the journal, sudo's lines
  as the error (`Sorry, try again.` …; sudo-rs `sudo: Authentication failed, try again.` …). With
  the admin's logins in `ru_RU.UTF-8` (Debian 13; sudo itself says `Попробуйте ещё раз.`) the hint
  is the same: the board runs sudo with `LC_ALL=C`.
- **Failures on case 2**: their file changed between Look and Apply → `changed`, nothing done or
  recorded; a brace-less last site → rolled back at `validate` (`unrecognized directive:
  board.example.com`), no reload (systemd logged none), hash as before; their reload failing
  (`ExecReload=/bin/false`) → rolled back at `reload`, their Caddy active on its old config; a site
  answering otherwise after the reload (`b.example.com` 404) → rolled back, reloaded back, hash as
  before; TERM during the reload → the step ends, then everything rolls back, their file valid
  (`caddy validate`) and as before; KILL after the write → the record says `running`, Look offers
  its Undo (`interrupted`), Undo puts their file back byte for byte and the folder's group back; the
  board's ssh killed mid-run (Windows side) → the board says `lost`, the run ends on the server by
  itself (`applied`), the next Look reads it ("nothing to change").
- **logind's `KillUserProcesses=yes`** (the connection cut on the server's side during an 8 s
  reload; the run is in the admin's `session-*.scope`): Debian 13 (systemd 257) ends the step's
  processes, and the run rolls back (`rolled-back`); Ubuntu 26.04 (systemd 259) kills the run
  outright, its record left `running`; the next Look offers its Undo, which puts their file back.
  Cut before the follower has printed a line, the board shows ssh's own `Connection to … closed by
  remote host.` with no hint (the `lost` hint needs a line from the run first).
- **Case 3a, a single-file mount, a brace-less last site**: written in place, refused by `caddy
  validate` inside their container, put back at once (hash as before), their Caddy never reloaded
  (no `load complete` in its log), the same container.
- **Step 1 from a console on Ubuntu 24.04**: until someone has logged in over SSH, its
  socket-activated sshd has no `/run/sshd`, and `sudo sshd -t` stops the paste with `Missing
  privilege separation directory: /run/sshd` (the README says to paste it over SSH).
- **What the board fixed on the way** (each with a unit test): its containers were started with
  `docker run run …` (`caddyRunArgs`/`socatRunArgs` are the argv after `docker`); Apply again
  recorded an image the board had pulled as "there before" and dropped the folder's group from the
  record (Undo then kept the image and Caddy's group); `install -d -m 755` changed the mode of
  their `conf.d`.

**The two-proxies proof (2026-10-21, `test/integration/two-proxies.test.ts`):** plain containers on
Docker Desktop with `CADDY_IMAGE`, `SOCAT_IMAGE`, `caddyRunArgs`, `socatRunArgs`, `markedBlock` and
`boardCaddyfile` as the board has them (ports on 127.0.0.1 of the PC, the socket's folder a volume
at `2750`, group 999; `local_certs` added, 4b's ACME issuer as `tls internal`); the tunnel's end a
socat container making the socket `srw-rw---- 999 999` (backlog 128, as sshd's) on to the stand-in
board on the PC.

- **A, 3a** (their Caddy on a user network, the marked block, the helper): `board.test` → the
  stand-in with `Host: board.test`, `X-Forwarded-Proto: https`, `X-Forwarded-For` the caller as
  their Caddy saw it; an event stream's first event after 2 ms, 60 ticks in 30 s, the longest gap
  502 ms; 200 requests at once, interleaved with their site's, all right; `caddy reload` in their
  container during a board stream: their site answered every fetch (100 ms apart), the stream went
  on ticking; the tunnel down → the board 502, their site 200; up on a new socket file → the board
  answers, neither proxy restarted.
- **B, 4** (their nginx on 443 and 80, the board's Caddy on 8443): the same, with `Host:
  board.test:8443`; their nginx restarted during a board stream: their site down for 9 fetches
  (about 1 s), the board's stream untouched (longest gap 506 ms).
- **C, 1** (the board's Caddy alone on 443): the same for the board.
- With socat's own listen backlog (5) as the tunnel's end, 200 requests at once gave the board's
  Caddy 502s; sshd listens with 128 and the proof uses that.

## Testing

### Unit (pure, fast)

- **Look's parsers**, section by section, against outputs recorded from the integration images
  (Debian 13 and Ubuntu 26.04 for every section, Ubuntu 24.04 where its output differs), kept as
  fixtures: `ss` with `docker-proxy`
  and without (userland proxy off), cgroup lines of both cgroup drivers, `systemctl show`'s
  `argv[]`, `docker inspect` (file, folder and volume mounts; user-defined, default and host
  networks; compose labels), `sshd -T`, `stat`, the record; Podman's and rootless Docker's
  `docker info`; a garbled or cut output gives "Look could not read the server", never a case.
- **Choosing the case**: every row of the table and every "anything else" reason.
- **The plan**: for each case, the steps, their commands with the owner's values, what each
  touches, the Undo plan from a record (including an edited file of ours, a container with our
  name but not our label, an image that was there before), the update plan after a domain change.
- **Quoting**: values with spaces, quotes, `$`, backticks, `%`, newlines (refused), other
  alphabets, through the shell quoting function; a container id that is not 64 hex characters
  refused.
- **The scripts**: the board's run script (with `sudo() { "$@"; }`, the lock, the markers, the
  rollback order) and "Do it myself"'s text, both from one plan: the commands are the same lines.
- **The remote command**: fixed text plus base64; the script decoded from it is the plan's; the
  password is never in the argument list.
- **The Caddyfile and nginx texts** per case; the host-set check from `caddy adapt` JSON.

### Service and adapter (fake ssh)

The fake ssh of `test/support` grows a server: it answers the remote command by the script it
decodes, from fixtures, and records stdin.

- sudo: root sends nothing; NOPASSWD uses `-n` and sends nothing; a password goes on stdin only,
  once, and is in no log line, no view, no payload, no answer, no error text; a wrong password
  stops after one attempt with its hint.
- Progress from the `@@` markers; a run's output kept per step; a lost connection mid-run gives
  "the server finishes by itself; Look again", and the next Look reads the result.
- One run at a time; a plan from before a board restart is refused (Look again).
- Apply when the server changed since Look stops before any change.
- `tunnel.publicPort`: the tunnel listener, WebAuthn and the probe with 8443; and with it unset,
  every existing tunnel test unchanged.

### Web

The panel in each state: nothing set; the password asked; Look's findings per case (including the
"anything else" reasons and the warnings); the plan, with the Docker tick and Apply off until it
is ticked; a run in progress; a failure with its rollback list; done, with Undo; the Undo plan;
"Do it myself" with and without Look; the 8443 address.

### Integration: a test server in Docker Desktop (call 31)

Off unless `BOARD_SERVER_IT=1`; minutes long; never in the default `bun test`.

- **The images** (`test/integration/server/`), one Dockerfile per distribution, run side by side:
  **Debian 13** (sudo, GNU coreutils), **Ubuntu 26.04** (sudo-rs, Rust coreutils) and **Ubuntu
  24.04** (classic sudo); Debian 12 and Ubuntu 22.04 if cheap. Each: systemd as PID 1, sshd, sudo,
  `ca-certificates`, Docker inside it (Docker in Docker, privileged) or none for the install path,
  an admin user with a key in three variants (sudo with a password, NOPASSWD, root), and step 1
  done as the panel's paste. Every scenario runs on Debian 13 and Ubuntu 26.04; Ubuntu 24.04 runs
  the install path, case 1 and case 2.
- **Certificates without the internet's CA**: Pebble (Let's Encrypt's test CA) and its challenge
  DNS server in the same Docker network; the board's plan names Pebble's directory only through a
  test-only `BOARD_SETUP_ACME_CA` (as `BOARD_TUNNEL_PROBE_ORIGIN` does for the probe). So 1's,
  1b's (TLS-ALPN only), 4a's and 4b's (HTTP-01 through nginx) certificate paths are proven.
- **The tunnel**: the real Windows ssh from the test, `-R` to a stand-in board on the PC (a Bun
  server that answers the probe, echoes the Host and `X-Forwarded-*` it got, and streams an event
  every 500 ms).
- **Scenarios**, each prepared inside the server before the test: nothing on the ports; a dummy
  program on 80 (1b); Caddy from its package with two sites (2); Caddy in compose on a user network
  with a folder mount and with a file mount (3a); Caddy with host networking (3b); Caddy on the
  default bridge (3c: "Do it myself"); nginx on 443 alone (4a); nginx on 80 and 443 (4b); Apache on
  80 and 443 (4c); SELinux, Podman and rootless faked by their `docker info` (refused).
- **Each scenario**: Look gives the case; Apply works; their sites answer as before (the test's own
  fetches, not only the board's); the domain reaches the stand-in with `X-Forwarded-Proto: https`
  and the caller's address; Apply again changes nothing (files' hashes, containers' ids); Undo
  leaves their files' hashes as before Apply and none of the board's things behind.
- **Failures**: a broken line put into their config before Apply (validate fails, nothing changes,
  their file's hash unchanged); the ssh connection cut mid-Apply (the run finishes or rolls back;
  Look reads the result); a reload made to fail (rollback, their Caddy on its old config); a host
  made to answer differently after the reload (rollback); their file changed between Look and
  Apply (stopped before any change).

### The two-proxies proof (the owner's requirement)

Plain containers on Docker Desktop, no server image: `test/integration/two-proxies.test.ts`, off
unless `BOARD_DOCKER_IT=1`, with the exact images, flags and texts the board's plan uses (taken
from the core functions, so the proof proves what ships). Results recorded at the end of this
document as a "Checked by" block, as the tunnel spec's spike did.

- **The stand-in board** behind the socket: a container listening on a Unix socket in a shared
  folder with the tunnel's mode and group (`srw-rw----`), answering with the Host and
  `X-Forwarded-*` it got, and an event stream that ticks every 500 ms.
- **Topology A (case 3a)**: "their" Caddy (official image) on a user network, publishing 443 and
  80 on loopback ports, serving `site.test` (a fixed page) and, through the marked block,
  `board.test` to `agent-board-socket:8080`; the helper on that network with the board's flags.
- **Topology B (case 4)**: "their" nginx container publishing 443 and 80, serving `site.test`; the
  board's Caddy container on 8443 with the board's flags, serving `board.test:8443` to the socket.
- **Also Topology C (case 1)**: the board's Caddy alone on 443.
- Certificates: the proof is about serving, not getting certificates, so the board's Caddyfile
  gets one addition, Caddy's `local_certs` global option, and "their" proxies serve `tls internal`
  or a self-signed certificate; the test trusts those roots. Pebble belongs to the integration
  tests above.
- **For each topology, both at the same time:**
  1. `site.test` answers its page; `board.test` answers the stand-in, with `Host: board.test`,
     `X-Forwarded-Proto: https` and the test's address as the rightmost `X-Forwarded-For`;
  2. an event stream through the proxies delivers its first event within 1 s and keeps ticking
     for 30 s (nothing buffers it);
  3. 200 requests to both hosts, interleaved and concurrent, all answered correctly;
  4. their proxy reloaded (A) or restarted (B) while a board stream is open: their site keeps
     answering; the board's stream in B is untouched;
  5. the stand-in stopped (the tunnel down): `board.test` gives 502, `site.test` is unaffected;
     the stand-in started again with a new socket file: `board.test` answers again with no change
     to either proxy (the folder, not the file, is mounted).

### Manual (the owner)

On a throwaway VPS first (not the owner's real server): Debian 13 fresh (case 1 with the Docker
install), then with Caddy from its package (2), then compose Caddy (3a); an Ubuntu 26.04 VPS the
same if at hand. Then, if the owner wants,
the real server: Look only, the plan read together, then Apply.

## Tasks

Written out in the plan, `docs/superpowers/plans/2026-10-20-remote-tunnel.md`, "Part 2: Setting up
the server from the board", as Tasks 20–25 with that part's own constraints (the owner asked for
fewer, bigger tasks, at least two at a time, each verified by its own test files only). Before
Task 20, a comment on issue #154 says that this addition is being built, and by whom (AGENTS.md,
"An issue first").

- **20** Spike on Debian 13 and Ubuntu 26.04 side by side, and Look's scripts and parsers, with
  fixtures from both.
- **21** `tunnel.publicPort`, and step 1 without Caddy's group, in one paste; the tunnel spec's
  lines.
- **22** Apply and Undo for every case (core): the texts, the case, the plan, the record and its
  owner (the pair), Undo, update, the run script, the follower and "Do it myself".
- **23** The admin connection (sudo and sudo-rs), and Look, Apply and Undo through it (service,
  ops, config.json).
- **24** The panel's "On the server".
- **25** The test servers end to end (Debian 13 and Ubuntu 26.04 side by side, Ubuntu 24.04), the
  two-proxies proof, the README.
- Waves: 20, 21, 22 → 23, 24 → 25.

## Calls

Made in this document; the owner can overturn any of them.

1. **sshd and the tunnel user stay by hand.** The board never edits sshd_config. Look reads back
   the tunnel user's effective sshd settings (`sshd -T`) and the folder, and says when they differ
   from the panel's.
2. **The socket's folder takes the tunnel user's own group** in step 1 (`useradd --user-group`,
   `install -g boardtunnel`), since step 1 comes before Look and `caddy` may not exist. Apply gives
   a host Caddy its group by `chgrp`; containers get it by `--group-add`. Changes the tunnel spec's
   step 2 and the README.
3. **Step 1 also as one paste**, safe to paste twice, beside the separate snippets.
4. **Test connection's domain step**, while nothing is recorded as set up, adds that it fails until
   step 3 is done.
5. **The admin key**: the agent and the usual key files by default, or a file the owner names; a
   passphrase is never asked (put the key in the agent); no SSH password login. `tunnel.admin {
   user, key }` kept in config.json.
6. **The admin connection uses the tunnel's pinned host key strictly**, on the tunnel's host and
   port: Look needs Test connection first.
7. **sudo**: none for root; `sudo -n` for NOPASSWD; otherwise the password typed in the panel,
   kept by the page while the panel is open, sent with each Look, Apply or Undo, written once to
   ssh's stdin for `sudo -S -p ''`; one attempt per click; `requiretty` and no sudo go to "Do it
   myself". The same for sudo and sudo-rs, each one's lines matched.
8. **The script travels base64 in a fixed remote command**; stdin carries only the password; the
   script starts with `exec </dev/null`; `sudo` is a function that runs its arguments in the
   board's root script, so the same lines serve the board and "Do it myself".
9. **Look is read-only**: two rounds, no file written, `caddy adapt` but never `caddy validate`,
   `docker exec … caddy adapt` in their container allowed; it brings back only what the plan needs,
   never their config's text.
10. **Apply and Undo run on the server as one detached script**, under a lock, with their own
    rollback, each step checking before it acts; the board follows the log; a lost connection
    neither stops nor half-finishes a run.
11. **A run stops before any change when the server changed since Look** (the holders of 80 and
    443, their config's hash, their container's id).
12. **Case 1b**: 443 free and 80 someone else's: the board's Caddy on 443 alone, certificate by
    TLS-ALPN only.
13. **Case 3's helper is `socat`** (`alpine/socat`, pinned by digest), which leaves their Caddy's
    headers as they are. It joins their Caddy's user-defined network with no host port (3a); for a
    Caddy on the host network it listens on the host's loopback (3b); Caddy on the default bridge or
    macvlan (3c) is "Do it myself".
14. **Their Caddyfile is written in place** (the same file), so a file bind mount sees it; the
    candidate is checked beside it where it can be, else in place before any reload and put back at
    once on failure. Case 2's change is one `import` line whose comment is its marker; case 3's is
    the marked block.
15. **Their Caddy is reloaded, never restarted or recreated.** A Caddy with its admin endpoint off,
    run from JSON or `--resume`, with automatic HTTPS off, or Caddy 1, is not done by Apply.
16. **Case 4's certificate needs port 80**: 4a (80 free) the board's Caddy takes 80 for the check;
    4b (a host nginx on 80 that includes `conf.d`) a new file of the board's there forwards only the
    check's path for the domain; anything else on 80 is "Do it myself". No DNS challenge, no
    self-signed certificate.
17. **`tunnel.publicPort`**, 443 by default: the address `https://<domain>:<port>` reaches the Host
    and Origin checks, WebAuthn's expected origin and the probe; passkeys and logins survive a
    port change. Case 4 sets 8443.
18. **The board's containers**: `--cap-drop ALL` (Caddy keeps `NET_BIND_SERVICE`),
    `no-new-privileges`, the socket's folder (not the socket) mounted read-only, `--group-add
    <gid>`, `--restart unless-stopped`, labels; the helper as `nobody`, read-only.
19. **Docker's own apt repository by its documented steps**, on Debian 12/13 and Ubuntu
    22.04/24.04/25.10/26.04 only (owner), the key's fingerprint checked, with its own tick in the
    plan; never the convenience script, not the distribution's packages.
20. **Undo keeps Docker** unless the owner ticks its removal, offered only when the board installed
    it and nothing else uses it; a failed Apply keeps a finished Docker install.
21. **"Their sites still answer"**: the config validates, the served host names are the old ones
    plus the domain, and up to 20 of their hosts answer with the same status before and after the
    reload (one retry; `curl` or `wget`, skipped and said without them); a mismatch rolls back.
22. **Undo removes the board's line or block from the file as it is now**; the backup is only for
    an Apply's own rollback.
23. **The record lives on the server** (`/etc/agent-board/setup.json`) and is what Undo follows;
    config.json keeps a summary.
24. **Apply ends with Test connection**, up to 2 minutes for the certificate; a failure there is
    reported, not rolled back.
25. **Where Apply stops and "Do it myself" takes over**: any OS outside the supported list (owner);
    SELinux enforcing; Podman; rootless Docker; Docker with user namespaces; `requiretty`; no
    systemd for case 2; conflicting Docker packages. `sudo-rs` is supported (owner).
26. **A domain their proxy already serves** stops Look's plan, with the reason.
27. **A plan that installs Docker warns** when the server forwards traffic for others (LXD,
    libvirt, WireGuard, forwarding on).
28. **"Do it myself" works without Look**: the owner picks the case, and what Look would fill in
    stays as placeholders, each with the command that finds it.
29. **A run's output goes to the panel only**; `web.log` gets one line per step. No `board`
    command for the setup.
30. **One setup per server, named by its pair**: the record's tunnel user and socket path identify
    "this board's" setup. The same pair with another domain or public port is an update; another
    pair stops Look's plan and says another board's setup is there. Undo from a reinstalled board
    or another PC finds its record by the pair.
31. **The integration tests use Pebble** through a test-only `BOARD_SETUP_ACME_CA`; the board's
    real plan never names a CA.
32. **Undo leaves what the owner made by hand** (the tunnel user, the folder, the keys file, the
    `Match` block) and shows the commands to remove it.
33. **Case 3a joins their Caddy's first user-defined network by name**, and the plan says that
    `docker compose down` cannot remove that network while the helper is on it.

## Left to the builder

- **Names**: of the containers, volumes, labels, files under `/etc/agent-board`, ops, view fields,
  modules. Their set, and that each is named in the record, is not.
- **The pinned images**: the current Caddy 2 release and `alpine/socat`, by digest; or a helper
  image built on the server from the pinned official `alpine` with `socat`, if the spike finds
  `alpine/socat` unsuitable.
- **Numbers**: timeouts per step, the run's limit, apt's lock wait, how many hosts are fetched, how
  long the final Test waits, the ports 8480 and 8481, how many runs are kept.
- **Publishing UDP 443** for HTTP/3 in cases 1 and 1b.
- **How `caddy adapt` and `validate` get the service's environment** (`EnvironmentFile`, `--environ`)
  in case 2; when they cannot, case 2 is not done by Apply.
- **How Docker's key fingerprint is checked** where `gpg` is missing.
- **The panel's layout**, following the Remote access panel's.

## Later (not this work)

- Traefik in Docker: the board's helper with Traefik's labels would need no file edit at all.
- nginx as the board's proxy with its own certificate (certbot), for a clean address in case 4.
- Certificates by DNS challenge.
- Podman, rootless Docker, SELinux.
- A `board tunnel server` command.
