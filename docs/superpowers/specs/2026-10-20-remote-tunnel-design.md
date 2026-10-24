# agent-board: the board through your own domain (reverse SSH tunnel) — design

Date: 2026-10-20 · Branch: `feature/remote-tunnel`, from `main` @ `6716b17`. Decided with the
owner in conversation; not built yet. Calls made in this document (not the owner's) are numbered
in "Calls" below and marked **(call N)** where they apply; the owner can overturn any of them.

Revised the same day with the owner's answers to two questions from the builder: what can take the
forward's place on the server while the tunnel is down (answer: the forward ends in a Unix socket
that only the tunnel user and Caddy reach, on a server that is the owner's alone), and how far a
remote login reaches (answer: it keeps the terminal; the board's routes refuse the board's own
files through the tunnel).

## Intent

The owner wants the same board, live, from a tablet or another computer, wherever they are,
through a domain of their own on a server of their own. Today the board goes beyond its computer
only over Tailscale (README "Phones" and "In a phone's browser"): the Android app over the tailnet,
or the board in a phone's browser through `tailscale serve`. Both need Tailscale on both ends. The
owner wants no third-party platform in the path: no Tailscale, no Cloudflare. Just an SSH
connection from the PC to the server, and the server's own web server.

So the board on the PC keeps a reverse SSH tunnel to the server open by itself. Caddy on the
server, with a certificate for the domain, passes requests through it. The board asks for a login
on everything that comes that way.

```
tablet / other computer ──HTTPS──> Caddy, https://board.example.com (the owner's server, :443)
                                     │ reverse_proxy unix/<socket>   (a Unix socket, e.g.
                                     │   /var/lib/boardtunnel/board.sock: only the tunnel user
                                     ▼   and Caddy reach its folder)
                                   sshd ══ reverse tunnel, opened from the PC ══╗
                                                                                ▼
PC:  ssh -N -R <socket>:127.0.0.1:<tunnelPort> <user>@<server>
PC:  the board's tunnel listener, 127.0.0.1:<tunnelPort>: a login on every request   (new)
PC:  the web board, 127.0.0.1:<port> (12422): as today, no login, never behind the tunnel
```

Why this shape:

- **The PC opens nothing.** It needs no open port, no public address, no router change. It only
  dials out over SSH, as any client does.
- **The server holds nothing of the board's.** It ends TLS and forwards bytes. No board code, no
  secret and no data live there. It is the owner's alone, and trusted.
- **Only Caddy reaches the tunnel on the server.** The forward ends in a Unix socket in a folder
  only the tunnel user and Caddy can enter, not in a port that any process there could take while
  the tunnel is down.
- **The board already serves remote callers safely.** The phone listener (`src/server/remote.ts`)
  has a listener of its own, "nothing on this computer's screen", an HttpOnly cookie and the PWA.
  The tunnel is one more listener of that kind. A login of the board's own takes the place of
  Tailscale's identity plus pairing.

## Goals

- The board in any browser at `https://<domain>`, with what a phone gets today in remote mode:
  cards, answers, messages, starting sessions, the terminal, install as an app (PWA).
- A login of the board's own on every board route through the domain: a passkey, or password +
  TOTP code.
- A tunnel that looks after itself. It comes back after sleep, a network change and a board
  restart, and it says how it stands.
- Everything managed on the PC: the "Remote access…" panel and `board tunnel`.
- The local web board and the Tailscale remote mode work exactly as today.

## The worst outcome (anti-goal no. 1)

**A request from the internet reaches a board route without a valid login.** Board routes include
reading sessions, typing into one and the terminal. Every choice below puts this first:

- Whether a login is needed depends on **the listener a request arrived on**, never on a header.
  Only the tunnel reaches the tunnel listener.
- No header, setting or state turns the login off there.
- The tunnel never points at the web board's own port.
- A request the tunnel listener cannot place is refused.

This is the boundary that matters. A login keeps the terminal, so through it a login has full
access to the PC (see "What this does not cover" under the tunnel listener). That is why the login
is a passkey or password + TOTP, with a lockout, and a login that is ended stops at once.

## Decided with the owner (2026-10-20)

- **Intent.** See and use the same board from a tablet or another computer, through the owner's
  own domain on the owner's own server. No third-party platforms (no Tailscale, no Cloudflare):
  only a direct SSH tunnel and the server.
- **The tunnel.**
  - The board on the PC keeps the reverse tunnel itself:
    `ssh -N -R <socketPath>:127.0.0.1:<tunnelListenerPort> <user>@<server>`.
  - **The forward ends in a Unix socket on the server, not a TCP port** (OpenSSH's remote
    stream-local forwarding). While the tunnel is down, a port on the server's loopback is free for
    any process there to take, and what the tablet sends to it gives a login: the cookie it
    retries `/api/hello` with, a password, a TOTP code. A login gives the terminal. A socket in a
    folder only the tunnel user and Caddy can reach leaves no such opening.
  - It uses the OpenSSH client: built into Windows, present on Linux and macOS. The Windows client
    can ask for a socket forward: the socket lives on the Linux server, and the client itself
    connects only to TCP on the PC.
  - It brings the tunnel back after sleep or a network change (keepalives,
    `ExitOnForwardFailure`, backoff).
  - It is turned on and off with `board tunnel on|off` and from the panel.
- **The server.**
  - It is the owner's alone: single-tenant and trusted. It ends TLS, so it sees what passes
    anyway.
  - Caddy, with automatic TLS on the domain, reverse-proxies to the tunnel's socket
    (`reverse_proxy unix//path/to/socket`).
  - The socket lives in a folder only the tunnel user and Caddy can reach: the folder belongs to
    the tunnel user, with a group Caddy has, mode `2750`; the socket's mask lets in its owner and
    that group only.
  - A dedicated SSH user for the tunnel: key only, no shell, and only remote socket forwards
    allowed. In sshd, for that user: `AllowStreamLocalForwarding remote`;
    `AllowTcpForwarding remote` with `PermitListen none` (sshd lets a socket forward through only
    where remote forwards are allowed, and `PermitListen none` still refuses every TCP listen);
    `StreamLocalBindUnlink yes` (a dead tunnel's socket is replaced) and a `StreamLocalBindMask`.
    Neither `permitlisten` nor `PermitListen` names a socket's path, so neither keeps the key to
    one socket path; what does, and what is left, is in "The server" below **(call 31)**.
  - **The board sets up the web server on the owner's click** (changed 2026-10-21 by
    `2026-10-21-remote-tunnel-server-setup-design.md`); DNS, the tunnel user, the socket's
    folder, the key and sshd stay by hand. The README gives ready Caddy and sshd snippets, and the
    panel shows them filled in, with Copy.
- **Where a login is needed: decided by the listener, never by headers.**
  - The web board on `127.0.0.1:<port>` stays as it is, with no login.
  - A separate local listener, the tunnel's target, requires a login for every request.
  - Opening the domain on the PC itself also asks for a login, since the request came through the
    server. Accepted.
- **The login lives in the board itself.** It has two methods:
  - passkeys (WebAuthn: Face ID, fingerprint or device PIN) for the owner's own devices;
  - password + TOTP code (an authenticator app) as the fallback.

  Setup (password, TOTP, managing passkeys) is done on the local board. The first passkey on a new
  device can be added on that device after logging in there with password + TOTP.
- **What a remote login can do: the same as a phone in remote mode today, less the board's own
  files.** Cards, answers, messages, starting sessions, the terminal and installing as an app
  (PWA). Nothing that acts on the PC's screen: no opening files, links or windows, no focus.
  - **The terminal stays.** It is a shell on the PC, so through it (and through the sessions a
    login starts) a login has full access to the PC, the board's secrets included. The board says
    so plainly. The login is the boundary that matters, which is why it is protected with passkeys
    or password + TOTP, a lockout, and logins that end at once.
  - **The board's own files are not served through the tunnel.** File previews, quick look,
    listings and anything else that reads by a path refuse the board's state folder, its config
    folder and the tunnel key's folder, for requests that came through the tunnel listener (see
    "The board's own files" below).
- **The panel: "Remote access…" in Settings, next to "Phones…".** It has three parts:
  1. **Tunnel.**
     - Fields: server host, SSH port, user, key, the socket's path on the server (by default
       `/var/lib/boardtunnel/board.sock`), domain.
     - "Generate key": makes a key pair and shows the public key to paste on the server.
     - Status: connected, reconnecting, or error with its text and since when.
     - On/off and "Test connection".
     - Caddy and sshd snippets for these settings, with Copy.
  2. **Login.**
     - Set or change the password.
     - TOTP with a QR code and a code check.
     - Passkeys listed with the device and the date added, each removable.
  3. **Active logins.**
     - Each with its device or browser, when it signed in, when it was last active, and "End".
     - "End all".
     - Recent failed login attempts.
- **One tunnel, not several. One PC per domain.** A hub for several PCs is out of scope, for
  later.

## What the owner sees

1. **Settings → "Remote access…"** on the local web board opens a side panel (the `Panel`
   component, like Phones… and Profiles…) with the three parts above. It is always in the menu on
   the local board, since this is where setup starts. It is never in the menu on a page that came
   through the domain or through Tailscale **(call 14)**.
2. **On the tablet:** `https://<domain>` shows the board's login screen. It offers "Sign in with a
   passkey" first, then "Use password and code". After signing in the board shows, live, as it
   does in a phone's browser today. Share → Add to Home Screen (iOS) or Install app
   (Android/desktop Chrome/Edge) makes it an app.
3. **After a password + code login on a device with no passkey yet**, the page offers "Add a
   passkey for this device".
4. **"Sign out"** in the Settings menu of a page that came through the domain **(call 15)**.
5. **`board tunnel`** prints where the tunnel stands. `board tunnel on|off` turns it on or off.
   `board doctor` checks it while it is on.

## Behaviour

### Settings and where they live

- **config.json gets a `tunnel` object** (field names are a proposal; the builder may rename):
  - `on`;
  - `host`: the server;
  - `sshPort`: 22 by default;
  - `user`;
  - `key`: the path of the private key; empty means the key the board generated;
  - `socket`: the Unix socket's path on the server; `/var/lib/boardtunnel/board.sock` by default
    **(call 31)**;
  - `domain`: a bare host name, such as `board.example.com`;
  - `port`: the local tunnel listener's port; empty means the board's default.

  None of these is secret. Unknown fields are kept, as for all board files.
- **Checked before use** (the same spirit as `launch.claude`'s checks):
  - `host`: a host name or IP, with no leading `-`, no spaces, no `@`;
  - `user`: a plain user name with no leading `-`;
  - ports: integers from 1 to 65535;
  - `socket`: an absolute path of `A–Z a–z 0–9 . _ - /` only, with no empty, `.` or `..` part, at
    most 100 bytes (a socket's path is limited to 108 bytes on Linux, 104 on BSD and macOS). It
    must sit in a folder of its own: not directly in `/`, `/tmp`, `/var/tmp`, `/dev/shm`, `/run`
    or `/var/run`, where anyone could make the name first. A `:` would split ssh's `-R` value;
    the character set leaves it out.
  - `domain`: a lowercase host name with no scheme, path or port.
  - `port` must differ from the web board's port, `remote.port` and the PWA listener's port
    (`remote.pwa.port`, by default the web port plus one).

  A field starting with `-` would turn into an ssh option (e.g. `-oProxyCommand=…`), so these
  checks are a security matter, not cosmetics.
- **Secrets stay in the board's state folder** (`%LOCALAPPDATA%\herdr\plugins\agent-board` and
  its equivalents) **(call 4)**. They are:
  - the SSH private key, and the server's pinned host key;
  - the password hash;
  - the TOTP secret and the last accepted TOTP step;
  - the passkeys' public keys;
  - the login tokens' hashes;
  - failed attempts and the lockout state.

  Files are written through `adapters/json-store.ts` with mode `0o600`, as
  `remote-devices.json` is. File names are the builder's call.
- **What never leaves the state folder:** none of the above goes into the board payload (phones
  and remote pages get the payload), into `web.log`, into a URL or into any API answer. Two things
  are exceptions:
  - the public key, which is not secret;
  - the TOTP secret, sent once to the local page while TOTP is being set up, for the QR code.

### The tunnel on the PC

- **Which ssh.** On Windows: Windows' own client, `%SystemRoot%\System32\OpenSSH\ssh.exe`, found
  by its full path, then `ssh` on PATH. `ssh-keygen` is found the same way. Elsewhere: `ssh` on
  PATH. Why Windows' own first:
  - the board's PATH need not include System32 (see `killTree` in `adapters/process.ts`);
  - Git for Windows' MSYS `ssh` reads paths and permissions differently.

  An environment variable names another binary for tests, as `TAILSCALE_BIN_PATH` does. The panel
  and `board doctor` show which binary is used.
- **What it runs.** It is spawned without a shell, as an argument list. The board builds the
  whole line, and the forward's target is always `127.0.0.1:<tunnelPort>`:

  ```
  ssh -F none -N -T
      -i <key> -o IdentitiesOnly=yes -o BatchMode=yes
      -o ExitOnForwardFailure=yes
      -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes
      -o ConnectTimeout=15
      -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=<state>/…/known_hosts
      -p <sshPort>
      -R <socket>:127.0.0.1:<tunnelPort>
      <user>@<host>
  ```

  - `-F none`: the user's `~/.ssh/config` cannot change the tunnel (ProxyJump, ControlMaster and
    the like).
  - `BatchMode`: ssh never waits on a prompt.
  - `-R <socket>:…`: a forward from a Unix socket on the server (a value that starts with `/`)
    to TCP on the PC. The server makes the socket; the client needs no Unix socket of its own.
  - The numbers are examples; the builder sets them.
  - A path in an `-o` value that holds spaces must be quoted inside the value, by ssh_config's
    rules. Forward slashes are the safe choice on Windows.
- **The server's host key (call 7).** Trust on first use, kept in the board's own `known_hosts` in
  the state folder, never the user's.
  - The first connection pins the key (`accept-new`), and the panel shows its fingerprint.
  - The README tells the owner to compare it with
    `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server.
  - If the key later changes, ssh refuses and the status says so. The panel then offers "Forget
    the server's key".
- **"Generate key".**
  - Makes an Ed25519 key pair with no passphrase in the state folder, with the comment
    `agent-board@<computer>`.
  - Shows the public key and the full `authorized_keys` line (below), each with Copy.
  - If a key exists already, it asks first: the server needs the new public key before the tunnel
    works again.
  - **Windows: set the private key's ACL.** Windows' OpenSSH refuses a key that anyone other than
    the user, SYSTEM or Administrators can read ("UNPROTECTED PRIVATE KEY FILE", "bad
    permissions"). Windows' own ssh-keygen gives the key an ACL of its own, but a key file
    written any other way inherits its folder's, so the board sets it explicitly, after
    ssh-keygen too: icacls removes inheritance and grants full control to the current user, by
    SID from `whoami /user` (a user name can be localized or carry a domain). Elsewhere, mode
    600; ssh-keygen sets it already. The spike checked the recipe on a real Windows machine
    (end of "Risks and things to watch"): after it, `ssh -i <key>` does not complain.
  - **A key the owner points to (`key` set):** used as it is. The board does not change the ACL of
    a file it did not make **(call 8)**. If ssh refuses it, the status shows ssh's message and how
    to fix it. It must have no passphrase.
- **Status.** One of these, each with `since`:
  - `off`;
  - `connecting`;
  - `connected`;
  - `reconnecting`: with the attempt number, the next try and the last error;
  - `error`: ssh's own last lines, trimmed, with a hint for the common cases below.

  "Connected" means the server accepted the forward, not only that ssh runs. How to detect it is
  the builder's call. One option: run ssh with `-v` and read the success line,
  `debug1: remote forward success for: listen <socket>:-2, connect 127.0.0.1:<port>`, matched by
  its start including `listen <socket>:` (with the colon, so `board.sock` does not match
  `board.sock2`). The error text then leaves out the `debug1:` lines and the lines a healthy
  connection prints without that prefix (`Authenticated to …`, the version banner, the first
  connection's known-hosts warning), which are not errors. The exact lines are in "Checked by
  the spike" at the end of "Risks and things to watch". Another: with `ExitOnForwardFailure`, an
  ssh still running a few seconds after authenticating holds the forward, and a probe through the
  domain (below) confirms it.
- **And that the domain reaches this board (call 32).** A forward on the same socket path replaces
  the one before (`StreamLocalBindUnlink`, below), so a forward the server accepted can later be
  taken by another connection with the tunnel's key. While connected, the board fetches its own
  probe through the domain (Test connection's step 3) after each connect and then every few
  minutes.
  - A probe that fails while ssh runs leaves the status `connected`, with a warning: the domain
    did not reach this board, and what came back (a 502, a TLS error, another answer).
  - The board does not restart ssh over it. A failure on the PC's own side (its DNS, say) would
    otherwise drop the tablet's streams every few minutes.
  - The panel, `board tunnel` and `board doctor` show the warning.
- **Coming back.**
  - When ssh exits, the board starts it again with exponential backoff and jitter, e.g. 1 s, 2 s,
    4 s and on, up to 60 s. The backoff resets after a connection that stayed up for a minute.
  - Errors that do not heal by themselves still retry, at the longest interval, and show as
    `error`: the key refused (publickey), a changed host key, a key file refused for its
    permissions, ssh not found, the server refusing the socket forward (its folder, the sshd
    lines).
  - **Sleep:** a timer that sees the clock jump far past its interval (the PC slept) restarts ssh
    at once, without waiting for keepalives.
  - **Network change:** when the set of local addresses changes (`os.networkInterfaces()`,
    polled), ssh restarts at once. `ServerAlive*` is the backstop.
  - The numbers are the builder's.
- **Board restarts and overlap (call 9).** The board restarts when its code changes
  (`src/entrypoints/run.ts`): the old process exits with 75 and a new one starts and retries the
  web port (`serve()` in `src/tui/app.ts`). The tunnel must come back after that, and two boards
  must never fight over it. So:
  - **Owner.** Only the process that holds the web board's port runs the tunnel. It starts the
    tunnel after `startServer` has bound its port, and stops it in `close()`. The new board can
    bind only once the old one let go of the port, so the two never both run ssh.
  - **A stray ssh.** Do not count on the OS to end ssh with the board: on Windows a child can
    outlive its parent, and `run.ts` kills a stuck board directly, not its tree. So:
    - the board records its ssh's pid (with what identifies it) in the state folder;
    - a board that starts the tunnel first ends a recorded ssh that still runs and is really
      ssh with this forward;
    - ssh is always ended with its tree (`killTree`).
  - **A stale socket on the server.** sshd does not remove a forward's socket file when the
    connection ends, and when the old connection died uncleanly (sleep, network loss) its sshd
    still listens on it until its keepalive gives up.
    - With `StreamLocalBindUnlink yes` (the README's sshd block), the new forward removes the old
      socket and makes its own at once. The tunnel comes back without waiting for the server.
    - Without that line, every new forward fails with "remote port forwarding failed for listen
      path …" until someone removes the file. The status says so, with the line to add.
    - `ClientAliveInterval 15` / `ClientAliveCountMax 2` still end a dead connection's sshd within
      about 30 s, though it no longer holds anything up.
  - **Two ssh take the path from each other.** Since a new forward replaces the socket, a second
    ssh with the same line does not fail: it takes the traffic, and the first runs on holding
    nothing. One more reason only one process runs the tunnel (above), and the pid record ends a
    stray one.
  - **Why not run.ts.** The tunnel was not put in `run.ts`, the supervisor that outlives
    restarts: it never reloads its own code, and the board also runs without it
    (`src/entrypoints/server.ts`, `tui.ts` by hand). A short gap in the tunnel at a code change is
    accepted.
- **"Test connection" (call 10, call 33).** A step-by-step check; each step shows ✓ or ✗ with a
  hint:
  1. ssh is found, and the key exists and is not refused for its permissions.
  2. SSH connects, authenticates and the server accepts the socket forward.
     - **While the tunnel is on**, Test runs no ssh of its own: a second forward on the same path
       would take it from the tunnel. It shows the running tunnel's state, and step 3 runs only
       while that is `connected`.
     - **While it is off**, a short-lived ssh with the same line runs until the forward is
       accepted, and stops when step 3 is over. It pins the host key if none is pinned.
  3. **Through the domain:** the board fetches `https://<domain>/…/probe/<nonce>` from the PC.
     - On: the tunnel listener answers only the one nonce it waits for.
     - Off, or with the login not yet set up: the short-lived ssh forwards to a **probe-only
       listener** on 127.0.0.1, on a free port. It answers that one nonce and gives 404 to
       everything else: no page, no login, no board route. It closes when the test ends, or
       after 40 s at most. It is not the tunnel listener of call 13, which still never runs
       before the login is set up.

     This proves DNS, the certificate, Caddy, the socket's path and its permissions end to end,
     and tells nothing to anyone else.

  Hints for the usual failures:
  - "Permission denied (publickey)": the line is not in the keys file
    (`/etc/ssh/authorized_keys/boardtunnel`), the sshd block is not there, or the account is
    locked (an sshd with `UsePAM no` and no `usermod -p '*'` from step 2).
  - "remote port forwarding failed for listen path …": the socket's folder is missing or not the
    tunnel user's to write, `AllowStreamLocalForwarding` is not `remote`, `AllowTcpForwarding` is
    `no` or `local` (it must allow remote forwards, socket ones included), or a stale socket is
    there and `StreamLocalBindUnlink` is not `yes`.
  - "UNPROTECTED PRIVATE KEY FILE": the key's ACL.
  - "Host key verification failed": the server's key changed.
  - A timeout or refusal: host, port or firewall.
  - A 502 from Caddy: Caddy's socket path and the board's differ, or Caddy cannot open the socket
    (the folder's group or setgid bit, `StreamLocalBindMask`).
  - A TLS error: DNS, or Caddy has no certificate yet.

### The server (README and panel snippets; by hand, but for the web server the board can set up on the owner's click)

The README gets a section after "Phones": "Another computer or a tablet, through your own domain".
The panel shows the same snippets with the owner's values filled in, each with Copy. Steps:

1. **DNS.** An A/AAAA record for the domain points to the server.
2. **A user for the tunnel, with no shell and no home, and the socket's folder (call 31):**

   ```sh
   sudo useradd --system --user-group --no-create-home --home-dir /nonexistent \
       --shell /usr/sbin/nologin boardtunnel
   # useradd leaves the account locked; an sshd with UsePAM no refuses a locked one, key or not
   sudo usermod -p '*' boardtunnel
   # the socket's folder: the tunnel user makes the socket; its group is the reader's (step 3)
   sudo install -d -m 2750 -o boardtunnel -g boardtunnel /var/lib/boardtunnel
   # the key's file belongs to root, out of the tunnel user's reach
   sudo install -d -m 755 /etc/ssh/authorized_keys
   # the line below goes into /etc/ssh/authorized_keys/boardtunnel (owner root, mode 644)
   ```

   - The folder is the socket path's own folder; the panel fills in the owner's path.
   - The socket's folder takes the tunnel user's own group, not `caddy` (changed 2026-10-21, the
     server-setup spec's call 2): this step comes before anything knows whether a `caddy` group
     exists. The reader gets the group later: a host Caddy by `chgrp` (step 5), a container by
     `--group-add`. A folder made the old way, with `-g caddy`, works too.
   - The setgid bit (the `2` in `2750`) gives the socket the folder's group, so its reader can
     open it. The mask in the sshd block makes it `srw-rw----`: its owner and that group only.
   - The tunnel user has no home and no file of its own on the server.
   - `usermod -p '*'`: `useradd` leaves `!` as the password, which locks the account. `*` matches
     no password either, but does not lock it. An sshd with `UsePAM yes` (Debian's default) lets
     the key in anyway; one with `UsePAM no` refuses a locked account ("Permission denied
     (publickey)"; see "Checked by the spike").
3. **The key, allowed to forward only** (`/etc/ssh/authorized_keys/boardtunnel`):

   ```
   restrict,port-forwarding ssh-ed25519 AAAA… agent-board@<PC>
   ```

   There is no `permitlisten`: it limits TCP listens only and says nothing about a socket's path.
   The sshd block and the folder's permissions keep the key to the socket (below).
4. **sshd, a second fence for that user (call 11).** In `/etc/ssh/sshd_config`, then
   `sudo sshd -t` and reload sshd (`ssh` on Debian/Ubuntu, `sshd` elsewhere):

   ```
   Match User boardtunnel
       AuthorizedKeysFile /etc/ssh/authorized_keys/boardtunnel
       AuthenticationMethods publickey
       PasswordAuthentication no
       KbdInteractiveAuthentication no
       AllowTcpForwarding remote
       PermitListen none
       AllowStreamLocalForwarding remote
       StreamLocalBindUnlink yes
       StreamLocalBindMask 0117
       X11Forwarding no
       AllowAgentForwarding no
       PermitTunnel no
       PermitTTY no
       ForceCommand /bin/false
       ClientAliveInterval 15
       ClientAliveCountMax 2
   ```

   - `AllowTcpForwarding remote` and `PermitListen none`: no TCP forward either way. sshd lets a
     remote socket forward through only where `AllowTcpForwarding` allows remote forwards, so
     `no` would refuse the board's own forward too (ssh exits 255; see "Checked by the spike").
     `remote` refuses every `-L`, so a stolen key cannot reach anything on the server's network;
     `PermitListen none` refuses every TCP listen (`-R <port>:…`, `-R 0:…`), so it cannot listen
     on a port either. `PermitListen` does not apply to a socket's path.
   - `AllowStreamLocalForwarding remote`: socket forwards from the server to the PC only. No `-L`
     to a socket on the server (Docker's, say).
   - `StreamLocalBindUnlink yes`: a new forward replaces the socket a dead connection left (see
     "Board restarts").
   - `StreamLocalBindMask 0117`: the socket is `srw-rw----`, for its owner and Caddy's group.
   - `AuthorizedKeysFile`: the key lives in root's file, which the tunnel user cannot change.
   - `ForceCommand` and the nologin shell: it runs no command.
   - `ClientAlive*`: a dead connection's sshd ends within about 30 s.
   - These need OpenSSH 7.8 or newer on the server: `PermitListen` came in 7.8, the rest
     earlier, and the block works as written from 7.8 on: `KbdInteractiveAuthentication` is
     allowed in a `Match` block there, while `ChallengeResponseAuthentication` (an alias of it
     since 8.7) is not before 8.7, so the block never uses it.

   **What keeps the tunnel user to that one path (call 31).** No sshd or `authorized_keys` option
   names the paths a socket forward may use: `permitlisten` and `PermitListen` cover TCP only.
   What limits it:
   - **The folder's permissions.** Only the tunnel user (and root) can make a socket in the
     socket's folder. Caddy's group can only open it. No other user on the server can take the
     path, while the tunnel is down or up.
   - **Nowhere else worth taking.** Outside that folder the tunnel user can make a socket only
     where anyone may write (`/tmp`, `/var/tmp`, `/dev/shm`), and nothing connects to it there.
     `StreamLocalBindUnlink` removes only what the user could remove anyway: in those sticky
     folders, its own files.
   - **What is left: the key itself.** Whoever holds the tunnel's key can take the board's path
     (see "Risks").
   - **Not taken: `ChrootDirectory`.** It would hold the user to one folder, but the path ssh
     asks for is then inside the chroot (`/sock/board.sock`) while Caddy's is the real one, and
     the chroot must be root's all the way up. More to get wrong, for nothing against the one
     threat left: a stolen key can use the socket's folder either way.
   - The server is the owner's alone and trusted, so other users there are not the threat.
5. **Caddy** (`/etc/caddy/Caddyfile`, then reload Caddy):

   ```
   board.example.com {
       reverse_proxy unix//var/lib/boardtunnel/board.sock
       header Strict-Transport-Security "max-age=31536000"
   }
   ```

   Caddy from its package runs as `caddy`; it gets the socket's folder by its group (changed
   2026-10-21, the server-setup spec's call 2), `chmod` putting back the setgid bit `chgrp` may
   clear:

   ```sh
   sudo chgrp caddy /var/lib/boardtunnel && sudo chmod 2750 /var/lib/boardtunnel
   ```

   Caddy gets and renews the certificate. It keeps the Host header, sets `X-Forwarded-For` and
   `X-Forwarded-Proto` itself (and ignores what an untrusted client sent), and flushes
   `text/event-stream` answers at once. The board's live updates and the terminal are event
   streams. Do not put `encode` in front of the board unless the streams have been checked to
   still flow.
6. **Firewall.** Only 22, 80 and 443 open. The socket needs no rule: it is a file, not a port.
7. **Another proxy (nginx), for those who use one.** It reaches the socket with
   `proxy_pass http://unix:/var/lib/boardtunnel/board.sock:;`, and the folder's group is then
   nginx's, not Caddy's. It must not buffer the streams and must pass the right headers:
   - `proxy_buffering off;`
   - `proxy_http_version 1.1;`
   - `proxy_set_header Connection "";`
   - `proxy_read_timeout 1h;`
   - `proxy_set_header Host $host;`
   - `proxy_set_header X-Forwarded-For $remote_addr;`
   - `proxy_set_header X-Forwarded-Proto https;`

   The board also sends `X-Accel-Buffering: no` on its event streams through the tunnel
   **(call 12)**. Only Caddy is supported; nginx gets this note only.

### The tunnel listener (new, on the PC)

- **Where.** `Bun.serve` on `127.0.0.1:<tunnelPort>`, never any other address. It uses the same
  options as the other listeners: no idle timeout, not development, no port reuse.
- **When.** It listens while `tunnel.on` is set, the settings check out and the login is set up
  (password and TOTP). Otherwise nothing listens **(call 13)**. It is independent of
  `remote.on` (Tailscale): either can be on without the other. Test connection's probe-only
  listener is not this listener: it serves its one nonce and nothing else, and only for the
  length of a test **(call 33)**.
- **A request, in order:**
  1. `Host` must be the domain (or `<domain>:443`), and `X-Forwarded-Proto` must be `https`.
     Otherwise 403. These checks can only refuse, never let in. They also stop a page in a browser
     on the PC from reaching this listener through `127.0.0.1`.
  2. **Any method but GET or HEAD** must carry `X-Board: 1` and an `Origin` that is present and
     equals `https://<domain>`. Otherwise 403 **(call 5)**. This is stricter than the serve
     listener, which lets a missing Origin by.
  3. **Public, without a login (call 6).** Logging in is impossible otherwise:
     - GET of the page's own files (the page, `app.js`, `theme.js`, styles, icons, manifest,
       `sw.js`). They are served by `staticRoute(WEB, bundle, pwaPage)`, as for the phone's
       browser.
     - `GET /api/hello`, reduced: `{ board, api, auth: 'login', signedIn, language }`, with no
       host name, version or platform before a login.
     - The login routes.
     - The Test connection probe.
  4. **Everything else needs a valid login cookie.** With none, or an invalid or expired one,
     the answer is 401, and the cookie is cleared when one was sent. That covers every `/api/*`
     board route, `/uploads/*`, the event stream and the terminal.
  5. **With a login:**
     - `desktopOnly` (`core/remote.ts`) is refused in both spellings, the raw path and the decoded
       one, exactly as `server/remote.ts` does.
     - The routes only the local board may use are refused (see below).
     - A path under the board's own folders is refused on the routes that read by path (see
       "The board's own files" below).
     - `/api/peers` and pairing give 404 here.
     - Then `dispatch(routes, …)` with
       `guards = { ...guards, origins: ['https://<domain>'] }`.
     - Event streams are wrapped so that they end, with a named event, the moment the login ends.
       This is `endsWhenUnpaired`, generalized.
- **Routes only the local board may use (call 16).** Today `localOnly` in `server/remote.ts`
  covers `/api/remote*`. It grows to cover the new management routes too: login setup, passkey
  list, logins, the tunnel's settings, on/off, Generate key, Test. That holds on all three remote
  listeners: Tailscale, serve and the tunnel. No board route lets a phone or a remote login
  change the login, end other logins, approve a phone or read the tunnel's settings. (The
  terminal is another matter; see "What this does not cover" below.)
- **The board's own files (the owner's decision; the details are call 30).** With a login, the
  routes that read, list or describe a file by a path the request names refuse a path under:
  - the board's state folder (`stateDir()`: the secrets, the logins, the generated SSH key, the
    pinned `known_hosts`);
  - its config folder (`configDir()`: config.json);
  - the folder of the tunnel's key, when `tunnel.key` points outside the state folder.

  One folder inside stays readable: the state folder's `uploads`. It holds only what pages sent,
  and the chat names those files by their path, so a quick look of an attached picture keeps
  working.

  The routes, as they stand today:
  - `/api/fs/raw` (the quick look's bytes), `/api/fs/preview` (a file's start, a folder's
    entries) and `/api/fs/dirs` (the folder picker) answer 403, with a text that says the file is
    the board's own.
  - `/api/fs/stat` describes such a path as missing, so the page shows no link for it.
  - `/api/session/<id>/changes` (the checkout's status and diff) is refused for a card whose
    folder is under them: a session can be started in any folder.
  - The rest read no path the request names. `/uploads/<day>/<name>` reads inside the uploads
    folder only, by a fixed pattern. `/api/upload` writes only there. Helpers and history read a
    session's own records. Starting a session takes a folder, but reads nothing itself. The
    other `/api/fs/*` POSTs answer 404 or "missing" without reading.

  A new route that reads by path takes the same check; the server test below holds every route
  to it.

  How a path is compared:
  - after `resolvePath`, by its real path (`realpath`, so a link or junction into these folders
    counts), or for a missing file its nearest existing parent's, against the folders' own real
    paths;
  - without regard to case on Windows and macOS;
  - on Windows, through the tunnel, a UNC or device path (`\\server\share\…`, `\\?\…`, `\\.\…`)
    and a path with a `:` past the drive letter (an NTFS stream) are refused outright: they can
    name these folders in another spelling (`\\localhost\C$\…`).

  A hard link made elsewhere to one of these files cannot be told from its path. Making one needs
  the terminal, which reaches them anyway (below).

  This holds for requests that came through the tunnel listener. The local web board, and the
  phone listeners over Tailscale, are unchanged.
- **What this does not cover: the terminal.** A login keeps the terminal, by the owner's choice:
  a shell on the PC with the owner's rights. Through it, or through a session it starts (an agent
  runs commands too), a login can read the TOTP secret, the SSH key and the hashes in the state
  folder, edit config.json, or plant a passkey. The fences above (`localOnly`, `desktopOnly`, the
  board's own files) are fences on the board's routes only. **A login is full access to the PC.**
  The login is the boundary that matters, which is why it is protected with passkeys or a
  password and a TOTP code, the lockout, logins that last 30 days at most, and ending them at
  once.
- **The caller's address.** Every request on this listener comes from 127.0.0.1 (the ssh client).
  The caller's real address is only what the proxy put in `X-Forwarded-For`; the board takes the
  rightmost entry. Only Caddy can open the socket on the server, so that entry is Caddy's own. It
  is used to show attempts and logins and to group rate limits. It never decides whether anyone
  gets in.

### Login

"A login" means one signed-in browser on one device, as the owner's "Active logins" puts it.

- **Password.**
  - Set and changed on the local board only. No old password is asked: anyone at the PC can use
    the board anyway.
  - Hashed with `Bun.password` (argon2id) **(call 4)**.
  - At least 12 characters, no other rules **(call 17)**.
  - Changing it ends every login **(call 18)**.
- **TOTP.**
  - RFC 6238: HMAC-SHA1, 6 digits, a 30 s step, a 20-byte random secret in base32.
  - One step either way is accepted for clock drift.
  - A step at or before the last accepted one is refused (no replay). The last step is kept on
    disk.
  - Setup on the local board:
    - the panel shows the `otpauth://totp/…?secret=…&issuer=…` URI as a QR code (`core/qr.ts`,
      which holds up to 213 bytes) and the key as text;
    - the secret is saved only after a correct code is checked;
    - until then it waits in memory for a few minutes, then goes.
  - Setting it up again replaces it after its own check, and ends every login **(call 18)**.
- **Password and code are checked together (call 19).**
  - One answer for any failure ("wrong password or code"), never which one was wrong.
  - The hash check runs even when the code is wrong.
  - Both are compared in constant time.
- **Passkeys (WebAuthn).**
  - Relying party: the domain. Expected origin: `https://<domain>` **(call 3)**.
  - User verification required (Face ID, fingerprint, PIN).
  - A discoverable credential (resident key), so "Sign in with a passkey" needs no name and is
    one tap.
  - Attestation `none`.
  - Algorithms: ES256 (-7) and RS256 (-257); Windows Hello often uses RS256 **(call 20)**.
  - Challenges: random, single-use, short-lived and kept in memory. Their number is capped.
  - The signature counter is checked only when it is not zero. Synced passkeys keep it at zero.
  - A stable random WebAuthn user id lives with the secrets. `excludeCredentials` stops the same
    authenticator from being added twice.
  - **Added on the device itself, through the domain.** A passkey belongs to its site, so the
    local board (`http://127.0.0.1`) cannot create one for the domain. A passkey is added while
    logged in through the domain, and adding it asks for a fresh TOTP code **(call 21)**. This is
    the owner's "first passkey on a new device after logging in there with password + TOTP". It
    also works on the PC itself through the domain (Windows Hello).
    - **What the fresh code guards.** Through the board's routes, a login alone cannot plant a
      lasting passkey: someone who picks up a signed-in tablet cannot add one of their own with
      one tap. It does not stop a determined holder of a login: through the terminal they can
      read the TOTP secret or write the passkeys file (see "What this does not cover").
    - **The code just used to sign in does not count (call 34).** A step at or before the last
      accepted one is refused (no replay), so right after a password + code sign-in the owner
      waits for the next code, up to 30 s. That is fine. The dialog says so ("enter the next
      code; the one you signed in with works once only").
  - **Kept per passkey:**
    - credential id, public key, counter, transports;
    - a device label: from the browser at the time it was added ("Safari on iPad"), optionally
      with the authenticator's name from its AAGUID (the builder's call);
    - when it was added and when it was last used.
  - Listed and removed on the local board. Removing one ends the logins made with it
    **(call 22)**.
  - **Changing the domain** orphans every passkey (they belong to the old site) and every login
    (the cookie belongs to the old host). The panel warns first. On confirm, the passkeys are
    removed and all logins end **(call 23)**.
- **Logins (sessions).**
  - The token is 32 random bytes, base64url, in a cookie: `__Host-board-login` **(call 2)**,
    `Secure; HttpOnly; SameSite=Strict; Path=/`.
  - `Max-Age` is what is left of the login's 30 days. A login lasts 30 days from sign-in, fixed,
    not sliding **(call 1)**.
  - The board keeps only the token's hash (`hashToken`, `services/remote.ts`), with:
    - the method (passkey or password) and the passkey's id;
    - the device label from the User-Agent;
    - the address, from the proxy;
    - when it signed in and when it expires;
    - when it was last active, written at most once a minute, as `verify` does for phones.
  - Expired logins are dropped when the board reads the file.
- **Ending logins.**
  - "End", "End all", removing a passkey, and changing the password, TOTP or domain all end
    logins.
  - An ended login stops at once **(call 1)**. Its next request gets 401, and its open event
    streams (the board's and the terminal's) end with the named event the page already handles
    for phones (`unpaired`; reusing the name is **call 24**). The page goes back to the login
    screen.
  - A remote page can end its own login ("Sign out"), never another one.
- **Lockout and rate limits (call 25).**
  - Failed password + code sign-ins are counted across the board, not per device. After 5 in a
    row, sign-in is locked for 1 minute. Each further failure doubles the wait, up to 1 hour. A
    success clears the count.
  - **Passkey sign-in is never locked out.** No one can guess a passkey, and the owner keeps a
    way in while someone hammers the password.
  - The local panel shows a lockout and can lift it.
  - All the public login routes are rate-limited per address and overall. Over the limit the
    answer is 429 with `Retry-After`.
  - **Passkey sign-in has rate-limit counters of its own (call 35)**, per address and overall,
    apart from password sign-in's (and from the rest: hello, the probe). A password lockout, or
    a full password limit, never slows passkey sign-in, so "never locked out" holds.
  - The numbers are examples; the builder sets them.
- **Failed attempts.**
  - Each is recorded with its time, address, browser label, method and reason (`wrong`,
    `locked`, `limited`).
  - The last ~100 are kept and the panel shows the recent ones.
  - Failed passkey checks are recorded, but do not count toward the lockout.
- **Recovery.** There are no recovery codes and no e-mail reset. The local board is the way back:
  set a new password, set up TOTP again, lift a lockout **(call 26)**.

### The page through the domain

- **The same page as a phone's browser gets.** `pwaPage` marks it `data-remote` and adds the
  manifest, icons and `styles/pwa.css`. `remotePage()` is true, so everything that already reads
  it applies unchanged:
  - no focus, open or show in folder in the menus;
  - the phone's composer and attachment handling;
  - the service worker and theme color (`phone-app.ts`).

  The page is the full board; a tablet or desktop browser gets its usual responsive layout.
- **The service worker (`web/sw.js`) unchanged.** It keeps only the page's own files, never
  `/api` or `/uploads`. While the PC is away, Caddy answers 502 and the worker serves the kept
  page.
- **`RemoteGate` learns a second way in.** `/api/hello` says `auth: 'login'` on the tunnel
  (pairing stays the way in through serve). The gate then shows a **login screen** in place of
  the pairing screen, built from the same `phone-screen` / `phone-card` parts:
  - "Sign in with a passkey" first.
  - "Use password and code":
    - a hidden user name field with `autocomplete="username"`, so password managers work;
    - a code field with `autocomplete="one-time-code"`.
  - One generic error for a failed sign-in, and the wait while locked.
  - The offline and refused screens need texts without Tailscale for the tunnel ("the computer
    may be asleep or the board closed"). The page can keep the last hello's `auth` the way it
    keeps the language.
- **"Add a passkey for this device"** is offered after a password + code login when this browser
  has made none. A local hint in `localStorage` says it made one **(call 27)**; the server cannot
  tell devices apart.
- **iOS:** an app on the home screen keeps its cookies apart from Safari's, so it signs in once on
  its own. With a passkey that is one tap.

### The "Remote access…" panel (local board only)

The panel follows the Phones panel's build: `Panel`, `sheet-body`, two-click destructive buttons
like Unpair, the `Qr` component, toasts for errors. Every change is a POST to a local-only route,
and the panel reads its view from a local-only GET.

- **Tunnel.**
  - The fields, saved on Enter or blur like the Profiles panel's.
  - Key: its path, "Generate key", the public key and the `authorized_keys` line with Copy, and
    the pinned host key's fingerprint with "Forget".
  - Status with since when. On/Off. "Test connection" with its steps.
  - The socket's path on the server, `/var/lib/boardtunnel/board.sock` until changed.
  - Snippets, filled in, each with Copy: the user and folder commands (the folder from the
    socket's path), the keys file's line, the sshd `Match` block, the Caddyfile, and the nginx
    note folded away.
  - On is disabled, with the reason, until the fields check out and the login is set up.
  - A line that says what a login can reach: the board's own files are not served through the
    domain, but the terminal is a shell on this PC.
- **Login.**
  - The password: set or not, with Set / Change (ends all logins; the panel says so first).
  - TOTP: set up or not, with Set up / Set up again (the QR code, the key as text, a code check).
  - Passkeys: label, added, last used, Remove (two clicks).
  - A hint: "Passkeys are added on the device: open https://<domain> there, sign in with password
    and code, then Add a passkey."
  - A lockout, when there is one: until when, with Lift.
- **Active logins.**
  - Each login: device or browser, method, signed in, last active, address, End (two clicks).
  - End all.
  - Recent failed attempts: when, address, browser, reason.
- **Live updates (call 28).** The board payload goes to phones and remote pages too, so it does
  not carry this view. It carries only a small revision number that changes when the view does.
  The panel fetches the local-only view again when the number changes.

### `board tunnel` and `board doctor`

- **`board tunnel`**: on or off, the state with since when, the error or the probe's warning, the
  domain, the socket's path, the ssh binary.
- **`board tunnel on|off`**: sets `tunnel.on` in config.json, as `board remote on|off` sets
  `remote.on`. The running board follows the config change, as the remote listener does with
  `configChanged()`. `on` refuses, with the reason, while the fields do not check out or the
  password or TOTP is not set up **(call 13)**.
- **`board tunnel test`** runs Test connection and prints its steps **(call 29)**.
- **Login setup is not in the CLI.** It needs a screen (QR codes, passkeys); the panel is the
  place.
- **`board doctor`**, while the tunnel is on, checks (the same shape as `phoneChecks`): ssh
  found, the key there and accepted, the fields valid, the login set up, the state, the last
  probe through the domain.

## Reused and new

Reused (as is, or widened a little):

| What | Where | For |
|---|---|---|
| `desktopOnly`, refused in both path spellings | `src/core/remote.ts`, `src/server/remote.ts` | "nothing on this computer's screen" |
| `localOnly` | `src/server/remote.ts` | widened to the new management routes, on all remote listeners |
| `endsWhenUnpaired` + `watch` | `src/server/remote.ts`, `src/services/remote.ts` | ended logins end their streams; generalized to any `watch(id, gone)` |
| `cookieToken`, `tokenCookie`, `clearCookie` | `src/core/pwa.ts` | the login cookie; given a name and an age |
| `pwaPage`, `staticRoute(WEB, bundle, pwaPage)` | `src/core/pwa.ts`, `src/server/routes/static.ts` | the page through the domain, marked remote, installable |
| manifest, icons, `styles/pwa.css`, `sw.js`, `phone-app.ts` | `web/` | the PWA on the domain, the offline shell |
| `remotePage()` and what reads it | `web/src/models/remote-page.ts`, Composer, attachments, menus | remote restrictions on the page |
| `RemoteGate`, `UNPAIRED`, the stream's `unpaired` listener | `web/src/components/remote/`, `web/src/api/useBoard.ts` | the login screen; back to it when a login ends |
| `dispatch`, `GuardState.origins`, X-Board/Origin checks | `src/server/http.ts` | the routes behind the login, with the domain's origin |
| `hashToken`, `updateJson` with `0o600`, `stateDir` | `src/services/remote.ts`, `src/adapters/json-store.ts`, `src/adapters/paths.ts` | login token hashes, secret files |
| `resolvePath`; the fs routes (`/api/fs/raw`, `preview`, `stat`, `dirs`); the `changes` route | `src/adapters/files.ts`, `src/server/routes/fs.ts`, `src/server/routes/session.ts` | given the board's-own-files check on the tunnel listener (call 30) |
| `stateDir`, `configDir`, `uploadsDir` | `src/adapters/paths.ts` | the folders that check refuses, and the one it lets through |
| `Panel`, settings-menu items, `Qr` (private to `PhonesPanel.tsx` today: move it out to share), `qrMatrix` | `web/src/components/`, `web/src/models/settings-menu.ts`, `src/core/qr.ts` | the panel, the TOTP QR code |
| spawn without a shell, `killTree`; finding a binary as `tailscaleBin` does | `src/adapters/process.ts`, `src/adapters/tailscale.ts` | ssh, ssh-keygen, icacls |
| `phoneChecks` shape, the `board remote` command's shape | `src/core/pwa.ts`, `src/entrypoints/cli.ts` | `board doctor`, `board tunnel` |
| `configChanged()` / `sync()` pattern | `src/server/remote.ts` | the tunnel listener and ssh follow config.json |

Not reused: Tailscale's `whois`, owner and `allow`, pairing requests, bearer tokens (the app),
`/api/peers`.

New:

- **core (pure):**
  - the `tunnel` config and its checks;
  - the ssh argument list;
  - the snippets' text (imported by the page too, so no `node:` imports);
  - the backoff schedule, the lockout schedule, the status words;
  - TOTP's math and parsing the WebAuthn data, where they need no I/O;
  - whether a path (already made real) is under one of the board's own folders, and refusing
    UNC, device and stream paths on Windows.

  Web code imports only core modules without `node:` imports, as with `core/profiles.ts`.
- **adapters:** find and run ssh and ssh-keygen; icacls; the secret and login files; the real
  paths of the board's own folders and of a path asked for.
- **services:**
  - the tunnel supervisor: spawn, status, backoff, sleep and network watch, the pid record, the
    periodic probe, Test;
  - access: password, TOTP, passkeys, logins, lockout, rate limits, failed attempts.
- **server:**
  - the tunnel listener;
  - the public login routes (tunnel listener only);
  - the probe, and Test's probe-only listener;
  - the board's-own-files check on the fs routes and `changes` (tunnel listener only);
  - the local-only management routes.
- **web:**
  - the Remote access panel;
  - the login screen in `RemoteGate`;
  - "Sign out" and "Add a passkey";
  - base64url ↔ ArrayBuffer helpers for `navigator.credentials`.
- **Elsewhere:**
  - texts in a new strings file merged in `src/core/i18n/strings.ts`;
  - a new board-owned stylesheet linked from `web/index.html`, as `profiles.css` is;
  - the README section;
  - `board tunnel`;
  - the doctor checks.

## Non-goals

- Setting up DNS, sshd and the tunnel user (changed 2026-10-21: the board sets up the web server
  on the owner's click, `2026-10-21-remote-tunnel-server-setup-design.md`). The README and the
  panel give snippets only.
- Several tunnels; several PCs on one domain; a hub.
- Several users, accounts, roles or user names. One owner.
- The Android app through the domain (it pairs over Tailscale and uses a bearer token).
- Recovery codes, e-mail reset.
- Encrypting the secrets at rest beyond file permissions (call 4). Someone who can read the state
  folder can already drive the board. A remote login cannot read it through the board's routes
  (call 30), only through the terminal.
- Taking the terminal from a remote login, or a sandbox around it. The owner keeps it remotely.
- Changing the Tailscale remote mode, its PWA or its pairing (the board's-own-files check
  included: it is for the tunnel listener only).
- Plain HTTP through the domain; supporting proxies other than Caddy (nginx gets a note).
- Adding a passkey from the local board (WebAuthn does not allow it; see Login).
- The terminal board (`src/tui`) showing the tunnel.

## Anti-goals (failure even if it works)

- Any board route answering through the tunnel without a valid login (anti-goal no. 1).
- The web board on `127.0.0.1:<port>` asking for a login, or acting differently in any way a
  teammate who never turns the tunnel on would notice. The one exception is the new Settings
  item.
- Login decided by a header (Host, `X-Forwarded-For`, Origin), or the tunnel forwarding to the
  web board's own port.
- A secret leaving the PC or its state folder: in the payload, a log, a URL, an API answer, or on
  the server.
- A board route that lets a remote login (or a phone) act on the PC's screen, change the login,
  end other logins, approve phones, or read or change the tunnel's settings.
- A board route that, through the tunnel, reads, previews, lists or describes a file under the
  board's state folder, its config folder or the tunnel key's folder (call 30).
- The two above are guarantees about the board's routes, and only that. **They do not limit the
  terminal.** A login keeps it, by the owner's choice, and through it (or a session it starts) has
  full access to the PC, these files included. That is why the login is the boundary that matters
  (anti-goal no. 1), and why it is a passkey or password + TOTP, with a lockout and logins that
  end at once. Claiming more than this, in the panel, the README or here, is itself a failure.
- The board running anything on the server beyond holding its one forward, except Look (it only
  reads) and a plan the owner applied or undid with a click, over the owner's admin connection
  (changed 2026-10-21, the server-setup spec).
- The forward ending where anything but Caddy can connect to it, or where another user on the
  server can take its place: a TCP port, or a socket in a shared folder.
- Two ssh processes for the tunnel at once (they would take the socket from each other), or a
  stray ssh left running after a restart.
- A third-party service in the path.
- A lockout the owner cannot get out of from the PC, or a password lockout that also stops
  passkey sign-in.

## Constraints

- All earlier conventions hold:
  - Bun (1.4.3 or newer), strict TS, Biome;
  - the layers (core pure; adapters and integrations import only core; services orchestrate;
    server and entrypoints on top; `web/src` the page);
  - unknown JSON fields kept; JSON from disk or network checked by narrowing functions.
- **Runtime dependencies are React and react-dom only today.** A WebAuthn library would be the
  first other one; see "Left to the builder".
- **English and Russian**, every new text in both (the i18n test checks every dictionary).
- **Windows first-class:**
  - ssh by full path;
  - no shell when spawning (ssh, ssh-keygen, icacls, whoami);
  - the key's ACL;
  - quoting in `-o` values;
  - paths with spaces.
- **`test/web/styles.test.ts`:** `app.css`, `menu.css`, `launch.css`, `questions.css`,
  `terminal.css` and `helpers.css` must match upstream rule for rule. New styles go in a sheet
  of the board's own (e.g. `web/styles/access.css`). The login screen may extend `pwa.css`,
  which is the board's own already.
- **The board restarts on code changes** (`run.ts`) and retries a taken port (`tui/app.ts`). The
  tunnel must come back after a restart and never run twice (see "Board restarts and overlap").
- **Tests run in sandboxes only:** never the owner's real state folder, `~/.ssh`, herdr config,
  port 12422 or a real server. ssh and ssh-keygen come from a fake binary named by an environment
  variable.

## Risks and things to watch

- **Windows key ACL.** Windows' ssh will not use a key that other users can read. Windows' own
  ssh-keygen sets the key's ACL itself; a key written any other way (`node:crypto`, another
  ssh-keygen) inherits its folder's, so the board sets it always (the recipe the spike checked,
  below). Check on a real machine, including a state folder whose parent grants other users.
- **Git's ssh instead of Windows' ssh**: different path and permission handling. Use Windows' own
  by full path.
- **Buffered streams.** Caddy is fine as configured. nginx needs `proxy_buffering off`.
  Compression in front of the streams can hold them.
- **Windows' ssh and a socket forward.** The Windows client only asks the server for the forward
  and connects to TCP on the PC, so it needs no Unix socket of its own. The spike (below) found
  that `-R /var/lib/…/board.sock:127.0.0.1:<port>` reaches the server unchanged and that
  `ExitOnForwardFailure` stops ssh (exit 255) when the server refuses it.
- **The socket's permissions.** A wrong group, a missing setgid bit or the default mask give Caddy
  a 502 (Test connection says so). A looser folder lets other users on the server connect around
  Caddy and send any header (they would still need a login) or take the path. Check that
  `ls -l` shows `srw-rw---- boardtunnel caddy` in a `drwxr-s--- boardtunnel caddy` folder.
- **Restart overlap and a stale socket on the server** (see above). Test a code change while a
  tablet has the board open, and a sleep and wake of the PC.
- **Whatever takes the forward's place on the server gets a login.** Whoever answers where Caddy
  forwards gets what the tablet sends: the login cookie (the page retries `/api/hello` with it
  while the PC is away), and on a sign-in the password and the TOTP code. A TOTP code works once,
  but a stand-in can use it at once. A passkey's answer is bound to the origin and the challenge,
  but the cookie it earns is not. A captured cookie is a login until it expires or is ended, and
  a login gives the terminal: a shell on the PC. So this is not harmless. (The first draft said
  nothing captured would be of use; that was wrong.)
  - With a TCP port on the server's loopback, any process on the server could take the port while
    the tunnel was down. Hence the owner's answer: a server that is the owner's alone, and a
    socket in a folder only the tunnel user and Caddy can reach (call 31).
  - What is left: root on the server (trusted, by the owner's decision), and **a stolen tunnel
    key**. With `StreamLocalBindUnlink yes`, a forward made with the key replaces the board's
    socket even while the tunnel is up. The board's periodic probe through the domain then fails
    and the status warns (call 32). The key alone reaches nothing on the PC; a cookie captured
    with it does, through the domain, once the board's tunnel is back.
  - Mitigations: the key's ACL; "Generate key" rotates it (then replace the line on the server);
    "End all" ends every captured login at once; the root-owned keys file and the sshd block keep
    the key to socket forwards from the server, with no TCP forward, no TTY and no command.
- **A login is the PC.** Through the terminal, or a session it starts, a login can read and change
  anything the owner can, the board's own secrets included. The route-level fences (calls 16 and
  30) do not reach there. Treat a login like the owner's own shell: passkeys or password + TOTP,
  the lockout, 30 days at most, End all.
- **Caddy's pooled connections** can give one 502 right after the tunnel comes back. The page's
  normal retries cover it.
- **TOTP needs the PC's clock** within about 30 s.
- **The domain is public.** Scanners will find it, so:
  - hello says nothing before a login;
  - everything else gives 401;
  - the login routes are rate-limited;
  - failed attempts are visible in the panel.

**Checked by the spike (2026-10-20, OpenSSH_for_Windows_9.5p2, Debian 12.15 sshd):** server
OpenSSH_9.2p1 Debian-2+deb12u10 in a container set up as "The server" steps 2–4 stood before the
spike (step 4 then had `AllowTcpForwarding no`; the first point below is why it no longer does);
Windows' own `ssh.exe` spawned from Bun as an argument list (no shell), the line of "The tunnel on
the PC" plus `-v`; `<scratch>` is a folder whose name has a space. A code block below holds whole
lines as printed, one per line; `…` marks what is left out or varies.

- **`AllowTcpForwarding no` refuses the socket forward.** With it, ssh prints, among its `-v`
  lines,

  ```
  debug1: Remote: port forwarding refused
  Error: remote port forwarding failed for listen path /var/lib/boardtunnel/board.sock
  ```

  and exits 255; sshd logs

  ```
  Received request from 172.17.0.1 port … to remote forward to path "/var/lib/boardtunnel/board.sock", but the request was denied.
  ```

  sshd grants a remote socket forward only where `AllowTcpForwarding` allows remote forwards;
  `PermitListen` does not apply to paths. **So step 4 has, in place of `AllowTcpForwarding no`:**

  ```
      AllowTcpForwarding remote
      PermitListen none
  ```

  With these two lines (the rest of the block unchanged) the socket forward works, and the key
  still gets no TCP forward:
  - `-R 127.0.0.1:18080:…` and `-R 0:…`: `Remote: port forwarding refused`, exit 255;
  - `-L` to TCP: sshd `refused local port forward`, the client
    `open failed: administratively prohibited`;
  - `-L` to the board's socket: sshd `refused streamlocal port forward`.

  `PermitListen` needs OpenSSH 7.8 or newer on the server (this one was 9.2p1). Step 4's block,
  its `AllowTcpForwarding` bullet and its version floor, "Decided with the owner" and call 11 say
  the same.
- **Success line**, and the line after it:

  ```
  debug1: remote forward success for: listen /var/lib/boardtunnel/board.sock:-2, connect 127.0.0.1:56072
  debug1: forwarding_success: all expected forwarding replies received
  ```

  In general (`-2` is ssh's port number for a path; the forward's target follows):

  ```
  debug1: remote forward success for: listen <socket>:-2, connect 127.0.0.1:<port>
  ```

  Match it by its start, `debug1: remote forward success for: listen <socket>:`, the colon
  included, so a socket `board.sock` does not match a line for `board.sock2`; never by its end,
  which carries the target's port.
- **Lines without `debug1:` on a good connection.** None is an error; keep them out of error
  texts. The version banner comes first; the warning only on the first connection;
  `Authenticated to …` has no `debug1:` in front:

  ```
  OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2
  Warning: Permanently added '[127.0.0.1]:2222' (ED25519) to the list of known hosts.
  Authenticated to 127.0.0.1 ([127.0.0.1]:2222) using "publickey".
  ```
- **Paths:** `-i <scratch>/key` and `UserKnownHostsFile="<scratch>/known_hosts"` each reached ssh
  as one value; the known_hosts file in the folder with a space holds the server's
  `ssh_host_ed25519_key.pub`: `[127.0.0.1]:2222 ssh-ed25519 AAAA…`.
- **The socket:** `stat -c '%A %U %G'` → `srw-rw---- boardtunnel caddy`; its folder
  `drwxr-s--- boardtunnel caddy`. The setgid bit and `StreamLocalBindMask 0117` are honoured.
- **curl through the socket:** as `caddy` → `hello from the PC`; as `nobody` → exit 7, `curl -v`:
  `Immediate connect fail for /var/lib/boardtunnel/board.sock: Permission denied` (and `ls` of the
  folder: `Permission denied`); as `boardtunnel` → `hello from the PC`.
- **Noise per connection through the tunnel** (per TCP connection Caddy opens, not per request):
  8 lines, all `debug1:`:

  ```
  debug1: client_input_channel_open: ctype forwarded-streamlocal@openssh.com …
  debug1: client_request_forwarded_streamlocal: request: /var/lib/boardtunnel/board.sock
  debug1: connect_next: start for host 127.0.0.1 ([127.0.0.1]:<port>)
  debug1: connect_next: connect host … in progress, fd=4
  debug1: channel 0: new forwarded-streamlocal@openssh.com …
  debug1: confirm forwarded-streamlocal@openssh.com
  debug1: channel 0: connected to 127.0.0.1 port <port>
  debug1: channel 0: free: forwarded-streamlocal, nchannels 1
  ```
- **Stale socket:** after `taskkill /F` (the parent sees exit code 1) the socket file stays on
  the server; the same line started at once prints the success line again, the socket is new
  (`StreamLocalBindUnlink` replaced it) and curl as `caddy` answers.
- **Refused forward** (folder `chown root`): ssh exits by itself (`ExitOnForwardFailure`), exit
  code **255**, after

  ```
  debug1: remote forward failure for: listen /var/lib/boardtunnel/board.sock:-2, connect 127.0.0.1:56072
  Error: remote port forwarding failed for listen path /var/lib/boardtunnel/board.sock
  ```

  sshd logs `unlink(…): Permission denied` and
  `unix_listener: cannot bind to path …: Permission denied`; the client sees neither. A refusal
  by sshd's settings has the same `Error:` line, with `debug1: Remote: port forwarding refused`
  before it (the first point).
- **Locked account:** Debian's default `UsePAM yes` accepts the key although `useradd` left `!`
  as the password. With `UsePAM no`: `boardtunnel@127.0.0.1: Permission denied (publickey).`,
  exit 255, sshd logs `User boardtunnel not allowed because account is locked`. After
  `sudo usermod -p '*' boardtunnel` it connects. So the README needs that line: step 2 has it
  (harmless with PAM).
- **Key ACL, Windows' ssh-keygen:** in a folder granting `BUILTIN\Users:(OI)(CI)(R)`, the key it
  makes is not inherited from the folder: `BUILTIN\Administrators:(F)`,
  `NT AUTHORITY\SYSTEM:(F)`, `<COMPUTER>\<user>:(M)` (the `.pub` also `Everyone:(RX)`).
  `ssh-keygen -y` and ssh accept it.
- **Key ACL, any other writer:** the same bytes written by Bun into that folder inherit
  `BUILTIN\Users:(I)(R)`, `NT AUTHORITY\SYSTEM:(I)(F)`, `BUILTIN\Administrators:(I)(F)`,
  `<COMPUTER>\<user>:(I)(F)`. `ssh-keygen -y -P ""` and ssh both refuse it, exit 255, with:
  - `Bad permissions. Try removing permissions for user: BUILTIN\\Users (S-1-5-32-545) on file <key>.`
  - `WARNING: UNPROTECTED PRIVATE KEY FILE!`
  - `Load key "<key>": bad permissions`

  ssh then ends with `boardtunnel@127.0.0.1: Permission denied (publickey).` (the server accepted
  the public half).
- **`whoami /user /fo csv /nh`:** one line, `"<computer>\<user>","S-1-5-21-…-1001"` and CRLF:
  the name lowercased, the SID the second quoted field.
- **The recipe holds:** `icacls <key> /inheritance:r /grant:r *<SID>:F` leaves
  `<COMPUTER>\<user>:(F)` alone; `ssh-keygen -y` and ssh accept the key (the success line). The
  board still applies it after ssh-keygen: harmless for Windows' own, needed for any other
  ssh-keygen or a key written otherwise.

## Testing

- **Unit:**
  - parsing and checking the `tunnel` config, leading dashes included; the socket's path (not
    absolute, a `:`, a space, `..`, too long, directly in `/tmp` or `/run`);
  - the ssh argument list (Windows and POSIX paths, quoting, `-R <socket>:127.0.0.1:<port>`);
  - the snippets with given values (the folder taken from the socket's path, `unix//…` in the
    Caddyfile);
  - the backoff and lockout schedules;
  - the board's-own-files check: inside and outside each folder, the folder itself, case on
    Windows, `..`, a link or junction into a folder, an 8.3 short name, UNC, `\\?\` and `\\.\`
    paths, an NTFS stream, the `uploads` exception, an owner's key outside the state folder;
  - TOTP against RFC 6238's Appendix B vectors (SHA-1), plus drift and replay; the code used to
    sign in refused for adding a passkey, the next one accepted;
  - the WebAuthn checks against recorded registrations and assertions (ES256 and RS256; wrong
    origin, wrong rpId, wrong challenge, a reused challenge, UV not set, a counter going back);
  - password hashing;
  - the cookie's text;
  - User-Agent labels.
- **Server:**
  - **Every route in the route table answers 401 on the tunnel listener without a login.** Build
    the test from the table itself, so a new route is covered by default.
  - With a login: `desktopOnly` and `localOnly` are refused, both spellings.
  - Host, `X-Forwarded-Proto`, X-Board and Origin checks.
  - Hello says nothing before a login.
  - An ended login gets 401 and its open event stream ends with the named event.
  - Expiry; lockout and rate limits; the probe answers only its nonce.
  - Password sign-in locked out and over its limits: passkey sign-in still answers.
  - With a login, through the tunnel listener: `/api/fs/raw`, `preview` and `dirs` refuse a path
    under the state folder, the config folder and the key's folder; `stat` describes it as
    missing; `changes` is refused for a card whose folder is under them; an upload is still
    served and its quick look still works.
  - **No route gives the board's own files away.** Plant a file with a marker in the sandbox's
    state folder and one in its config folder. Send their paths (as `path`, `paths` and `cwd`,
    in the query and in the body) to every route in the table, through the tunnel listener with a
    login. No answer may hold a marker. Built from the table, as the 401 test is, so a new route
    that reads by path is covered by default.
  - The same requests on the local listener and the phone listeners: answered as today.
  - Test's probe-only listener: its nonce only, 404 for every page and route, closed after the
    test.
  - The local listener: the existing tests stay green and unchanged.
  - The Tailscale and serve listeners refuse the new management routes.
- **Supervisor (with a fake ssh):**
  - connect, exit, backoff, reset;
  - `ExitOnForwardFailure`, then a later success;
  - "remote port forwarding failed for listen path" shown with its hint (the folder, the sshd
    lines, `StreamLocalBindUnlink`);
  - an error that does not heal by itself;
  - a sleep (clock jump) and a network change;
  - a stray recorded ssh ended before the start, and a pid now used by another program left
    alone;
  - off ends the process tree;
  - a restart with an overlap never runs two;
  - the periodic probe: a failure while ssh runs gives the warning and leaves ssh alone;
  - Test while on starts no ssh of its own; Test while off starts one with the probe-only
    listener and ends both.
- **Web:**
  - the panel's markup in each state;
  - the Settings item on the local page only;
  - the login screen (passkey first, the password form, lockout, errors);
  - "Sign out";
  - the RemoteGate states for `auth: 'login'`.
- **Manual run on the owner's machine and server:**
  - set up the server from the README; `ls -l` shows the socket as
    `srw-rw---- boardtunnel caddy`;
  - Generate key, then Test connection with the tunnel off and on, each failure once (wrong key,
    a wrong socket path in Caddy, the default mask that shuts Caddy out, a changed host key);
  - from Windows' own ssh: the socket forward accepted;
  - pull the PC's network for a minute: the tunnel is back as soon as the network is, with no
    wait for the server (the stale socket replaced);
  - on an iPad: password + code, add a passkey (Face ID) with the next code, sign in with it,
    install on the home screen;
  - from the tablet, a quick look of a file in the state folder and of config.json: refused; of
    an attached picture: shown;
  - an Android tablet; another Windows PC with Windows Hello;
  - the domain on the PC itself;
  - sleep and wake the PC; switch networks; change the board's code while a tablet is open;
  - End and End all while the terminal is open on the tablet;
  - a lockout, then lift it on the PC;
  - Phones over Tailscale still working beside it.

## Calls

Made in this document; the owner can overturn any of them.

1. **A login lasts 30 days on a device**, fixed from sign-in, not sliding. Ended logins stop at
   once, open event streams included, as unpairing a phone does today.
2. **The cookie works like the PWA's**: `__Host-`, Secure, HttpOnly, SameSite=Strict. It has its
   own name, `__Host-board-login`, so the two token stores never mix.
3. **WebAuthn relying party = the domain; expected origin = `https://<domain>`.** HTTPS on 443
   by default; another public port becomes possible (changed 2026-10-21, the server-setup spec's
   call 17): `tunnel.publicPort`, set by the setup in its case 4, makes the origin
   `https://<domain>:<port>` for the Host and Origin checks, WebAuthn and the probe; the rpId
   never has the port.
4. **Secrets stay on the PC in the state folder**, never sent to the page or logged. They are
   protected by file permissions, not encrypted. The password is hashed with `Bun.password`
   (argon2id).
5. **Writes need `X-Board: 1` and the domain's origin**, and the Origin must be present on the
   tunnel listener.
6. **What is public on the tunnel listener**: the page's own files, a reduced hello, the login
   routes and the probe. This is how "a login for every request" is read: logging in needs
   these, and they carry no board data.
7. **The server's host key is trusted on first use**, in the board's own `known_hosts`, with its
   fingerprint shown and "Forget".
8. **The board sets the ACL only on a key it generated**, never on a key the owner points to.
9. **The tunnel belongs to the board process that holds the web port.** A pid record ends a
   stray ssh. A stale socket on the server is replaced by the next forward
   (`StreamLocalBindUnlink`). Not in `run.ts`.
10. **Test connection checks end to end through the domain** with a one-time probe (with the
    tunnel off: call 33).
11. **The README's sshd `Match` block is a second fence**, beside the `authorized_keys` options:
    socket forwards from the server only (`AllowStreamLocalForwarding remote`;
    `AllowTcpForwarding remote`, which sshd needs for a remote socket forward and which refuses
    every `-L`; `PermitListen none`, so no TCP port is listened on), `StreamLocalBindUnlink yes`
    and a mask that lets in Caddy's group, the keys in a root-owned file, no TTY, a forced
    command, and `ClientAlive*` to end a dead connection's sshd.
12. **`X-Accel-Buffering: no` on event streams** through the tunnel.
13. **The tunnel listener runs, and `tunnel on` is allowed, only once the password and TOTP are
    set up** and the fields check out. Test connection's probe-only listener (call 33) is not
    the tunnel listener and serves nothing but its nonce.
14. **"Remote access…" is always in Settings on the local board**, never on a remote page.
15. **"Sign out" on a page through the domain.**
16. **`localOnly` covers every new management route**, on the Tailscale, serve and tunnel
    listeners alike.
17. **The password is at least 12 characters**, with no other rules.
18. **Changing the password or setting TOTP up again ends every login.**
19. **Password and code are checked together**, with one answer for any failure.
20. **Passkeys:** user verification required, discoverable, attestation `none`, ES256 and RS256,
    the counter checked when it is not zero.
21. **Adding a passkey asks for a fresh TOTP code**, even while logged in. It is a fence on the
    board's routes: someone at a signed-in browser cannot add a passkey with one tap. It does not
    stop a login holder who uses the terminal, which reaches the TOTP secret and the passkeys
    file; nothing here claims it does.
22. **Removing a passkey ends the logins made with it.**
23. **Changing the domain removes the passkeys and ends all logins**, after a warning.
24. **The stream's `unpaired` event is reused** for an ended login, so `useBoard` needs no change.
25. **Lockout:** 5 failed password + code sign-ins in a row, then waits from 1 minute doubling to
    1 hour, counted across the board. Passkey sign-in is never locked (its rate limits are its
    own: call 35). The local board lifts it. Login routes are rate-limited per address (from the
    proxy) and overall. The numbers are examples.
26. **No recovery codes**: the local board is the recovery.
27. **"Add a passkey" is offered after a password login** when this browser's own hint says it
    has none.
28. **The panel's view is not in the shared payload**; only a revision number is.
29. **`board tunnel test`** exists beside `on|off` and the status.
30. **The board's own files, as the check reads them** (refusing them through the tunnel is the
    owner's decision): the state folder, the config folder, and the folder of a key the owner
    points to outside the state folder; the state folder's `uploads` stays readable; real paths
    compared, without case on Windows and macOS; UNC, device and stream paths refused on
    Windows; `stat` answers "missing"; `changes` refused for a card in those folders; the phone
    listeners unchanged.
31. **The socket's place and fence**: `/var/lib/boardtunnel/board.sock` by default, in a folder
    `boardtunnel:boardtunnel` (its reader gets the group in step 5; `boardtunnel:caddy` until
    2026-10-21), mode `2750`, with `StreamLocalBindMask 0117`; a tunnel user with no home
    and its key in a root-owned file. The path is held by the folder's permissions, not by
    `ChrootDirectory`; a stolen key is what is left.
32. **A periodic probe through the domain while connected**, since a forward on the same path can
    be replaced. A failure is a warning; ssh is not restarted over it.
33. **Test connection with the tunnel off** runs a short-lived ssh to a probe-only listener on a
    free port, which answers its one nonce and closes after the test. With the tunnel on, Test
    runs no ssh of its own.
34. **The code used to sign in does not count for adding a passkey**: the owner waits for the
    next one, up to 30 s, and the dialog says so.
35. **Passkey sign-in has rate-limit counters of its own**, apart from password sign-in's, so a
    password lockout or a full password limit never stops it.

## Left to the builder

- **Libraries.** For WebAuthn: a library (e.g. `@simplewebauthn/server`, the first runtime
  dependency beyond React) or hand-rolled. Hand-rolled with attestation `none` means:
  - decoding CBOR enough for the attestation object;
  - parsing authenticator data;
  - turning a COSE key into a JWK;
  - verifying with WebCrypto.

  Weigh it and test it against recorded vectors either way. TOTP per RFC 6238 is small enough to
  write. Generating the key with `ssh-keygen` or with `node:crypto` plus the OpenSSH key format.
- **File names** in the state folder.
- **The tunnel listener's default port** and the numbers: backoff, keepalives, polling, the
  probe's interval, lockout, rate limits, how many attempts are kept.
- **The module split**, following the layers. In particular: a new listener factory beside
  `createRemoteListener`, sharing the gate pieces (`desktopOnly` in both spellings, `localOnly`,
  the stream wrapper, the public page route), or one listener factory for all three. Prefer
  sharing small pieces over a third mode inside `answer()`. Where the board's-own-files check
  sits (in the tunnel listener's gate, by route, or in the routes, told which listener asked) is
  the builder's too, as long as the server test that plants a marker holds.
- **Route names and payload shapes.** Those named here are proposals.
- **How "connected" is detected** (ssh's `-v` output, or liveness plus the probe).
- **Passkey labels** (User-Agent only, or with AAGUID names) and whether they can be renamed.
- **Layout and styling** of the panel and the login screen, following the Phones and Profiles
  panels and the pairing screen.

## Later (not this work)

- A hub: one domain for several PCs.
- The Android app through the domain.
- A notification on the PC when a new login signs in.
- The board's-own-files check on the phone listeners too (Tailscale, serve), if the owner wants
  it there.
