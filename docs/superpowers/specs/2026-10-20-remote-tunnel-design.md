# agent-board: the board through your own domain (reverse SSH tunnel) — design

Date: 2026-10-20 · Branch: `feature/remote-tunnel`, from `main` @ `6716b17`. Decided with the
owner in conversation; not built yet. Calls made in this document (not the owner's) are numbered
in "Calls" below and marked **(call N)** where they apply; the owner can overturn any of them.

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
                                     │ reverse_proxy 127.0.0.1:<remotePort>  (server's loopback only)
                                     ▼
                                   sshd ══ reverse tunnel, opened from the PC ══╗
                                                                                ▼
PC:  ssh -N -R 127.0.0.1:<remotePort>:127.0.0.1:<tunnelPort> <user>@<server>
PC:  the board's tunnel listener, 127.0.0.1:<tunnelPort>: a login on every request   (new)
PC:  the web board, 127.0.0.1:<port> (12422): as today, no login, never behind the tunnel
```

Why this shape:

- **The PC opens nothing.** It needs no open port, no public address, no router change. It only
  dials out over SSH, as any client does.
- **The server holds nothing of the board's.** It ends TLS and forwards bytes. No board code, no
  secret and no data live there.
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

## Decided with the owner (2026-10-20)

- **Intent.** See and use the same board from a tablet or another computer, through the owner's
  own domain on the owner's own server. No third-party platforms (no Tailscale, no Cloudflare):
  only a direct SSH tunnel and the server.
- **The tunnel.**
  - The board on the PC keeps the reverse tunnel itself:
    `ssh -N -R 127.0.0.1:<remotePort>:127.0.0.1:<tunnelListenerPort> <user>@<server>`.
  - It uses the OpenSSH client: built into Windows, present on Linux and macOS.
  - It brings the tunnel back after sleep or a network change (keepalives,
    `ExitOnForwardFailure`, backoff).
  - It is turned on and off with `board tunnel on|off` and from the panel.
- **The server.**
  - Caddy, with automatic TLS on the domain, reverse-proxies to the tunnel's port. That port
    listens on the server's 127.0.0.1 only.
  - A dedicated SSH user for the tunnel: key only, no shell, and only that one forward allowed
    (e.g. `restrict,port-forwarding,permitlisten="127.0.0.1:<port>"` in `authorized_keys`).
  - **The board does not set up the server.** The README gives ready Caddy and sshd snippets,
    and the panel shows them filled in, with Copy.
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
- **What a remote login can do: the same as a phone in remote mode today.** Cards, answers,
  messages, starting sessions, the terminal and installing as an app (PWA). Nothing that acts on
  the PC's screen: no opening files, links or windows, no focus.
- **The panel: "Remote access…" in Settings, next to "Phones…".** It has three parts:
  1. **Tunnel.**
     - Fields: server host, SSH port, user, key, remote port, domain.
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
  - `remotePort`: the port on the server's loopback;
  - `domain`: a bare host name, such as `board.example.com`;
  - `port`: the local tunnel listener's port; empty means the board's default.

  None of these is secret. Unknown fields are kept, as for all board files.
- **Checked before use** (the same spirit as `launch.claude`'s checks):
  - `host`: a host name or IP, with no leading `-`, no spaces, no `@`;
  - `user`: a plain user name with no leading `-`;
  - ports: integers from 1 to 65535;
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
      -R 127.0.0.1:<remotePort>:127.0.0.1:<tunnelPort>
      <user>@<host>
  ```

  - `-F none`: the user's `~/.ssh/config` cannot change the tunnel (ProxyJump, ControlMaster and
    the like).
  - `BatchMode`: ssh never waits on a prompt.
  - The numbers are examples; the builder sets them.
  - A path in an `-o` value that holds spaces must be quoted inside the value, by ssh_config's
    rules. Forward slashes are the safe choice on Windows.
- **The server's host key (call 7).** Trust on first use, kept in the board's own `known_hosts` in
  the state folder, never the user's.
  - The first connection pins the key (`accept-new`), and the panel shows its fingerprint.
  - The README tells the owner to compare it with `ssh-keygen -lf
    /etc/ssh/ssh_host_ed25519_key.pub` on the server.
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
    permissions"). A key file inherits its folder's ACL, so the board sets it explicitly: icacls
    removes inheritance and grants full control to the current user, by SID from `whoami /user`
    (a user name can be localized or carry a domain). Elsewhere, mode 600; ssh-keygen sets it
    already. The builder checks this on a real Windows machine: `ssh -i <key>` must not complain.
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
  the builder's call. One option: run ssh with `-v` and read "remote forward success". Another:
  with `ExitOnForwardFailure`, an ssh still running a few seconds after authenticating holds the
  forward, and a probe through the domain (below) confirms it.
- **Coming back.**
  - When ssh exits, the board starts it again with exponential backoff and jitter, e.g. 1 s, 2 s,
    4 s and on, up to 60 s. The backoff resets after a connection that stayed up for a minute.
  - Errors that do not heal by themselves still retry, at the longest interval, and show as
    `error`: the key refused (publickey), a changed host key, a key file refused for its
    permissions, ssh not found.
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
  - **The server still holds the port.** When the old connection died uncleanly (sleep, network
    loss), sshd keeps its forward until its keepalive gives up. The new ssh then fails with
    "remote port forwarding failed" and retries with backoff. The status says the server still
    holds the port from the last connection. The README's sshd block sets
    `ClientAliveInterval 15` / `ClientAliveCountMax 2`, which frees the port within about 30 s.
  - **Why not run.ts.** The tunnel was not put in `run.ts`, the supervisor that outlives
    restarts: it never reloads its own code, and the board also runs without it
    (`src/entrypoints/server.ts`, `tui.ts` by hand). A short gap in the tunnel at a code change is
    accepted.
- **"Test connection" (call 10).** A step-by-step check; each step shows ✓ or ✗ with a hint:
  1. ssh is found, and the key exists and is not refused for its permissions.
  2. SSH connects, authenticates and the server accepts the forward. While the tunnel is
     connected this is shown already. While it is off, a short-lived ssh with the same line runs
     until the forward is accepted, then stops. It pins the host key if none is pinned.
  3. **Through the domain:** the board fetches `https://<domain>/…/probe/<nonce>` from the PC.
     The tunnel listener answers only the one nonce it waits for. This proves DNS, the
     certificate, Caddy and both port numbers end to end, and tells nothing to anyone else.

  Hints for the usual failures:
  - "Permission denied (publickey)": the line is not in `authorized_keys`.
  - "remote port forwarding failed": the port is busy on the server, or `permitlisten` names
    another port.
  - "UNPROTECTED PRIVATE KEY FILE": the key's ACL.
  - "Host key verification failed": the server's key changed.
  - A timeout or refusal: host, port or firewall.
  - A 502 from Caddy: its port and `remotePort` differ.
  - A TLS error: DNS, or Caddy has no certificate yet.

### The server (README and panel snippets; the board never touches the server)

The README gets a section after "Phones": "Another computer or a tablet, through your own domain".
The panel shows the same snippets with the owner's values filled in, each with Copy. Steps:

1. **DNS.** An A/AAAA record for the domain points to the server.
2. **A user for the tunnel, with no shell:**

   ```sh
   sudo useradd --system --create-home --shell /usr/sbin/nologin boardtunnel
   sudo install -d -m 700 -o boardtunnel -g boardtunnel /home/boardtunnel/.ssh
   # the line below goes into /home/boardtunnel/.ssh/authorized_keys (owner boardtunnel, mode 600)
   ```

3. **The key, allowed one forward only** (`authorized_keys`; `permitlisten` needs OpenSSH 7.8 or
   newer on the server):

   ```
   restrict,port-forwarding,permitlisten="127.0.0.1:<remotePort>" ssh-ed25519 AAAA… agent-board@<PC>
   ```

4. **sshd, a second fence for that user (call 11).** In `/etc/ssh/sshd_config`, then
   `sudo sshd -t` and reload sshd (`ssh` on Debian/Ubuntu, `sshd` elsewhere):

   ```
   Match User boardtunnel
       AuthenticationMethods publickey
       PasswordAuthentication no
       KbdInteractiveAuthentication no
       AllowTcpForwarding remote
       PermitListen 127.0.0.1:<remotePort>
       PermitOpen none
       GatewayPorts no
       X11Forwarding no
       AllowAgentForwarding no
       AllowStreamLocalForwarding no
       PermitTTY no
       ForceCommand /bin/false
       ClientAliveInterval 15
       ClientAliveCountMax 2
   ```

   - `AllowTcpForwarding remote` and `PermitOpen none`: a stolen key cannot use `-L` to reach
     anything on the server's network.
   - `ForceCommand` and the nologin shell: it runs no command.
   - `ClientAlive*`: a dead tunnel lets go of the port soon (see "Board restarts").
5. **Caddy** (`/etc/caddy/Caddyfile`, then reload Caddy):

   ```
   board.example.com {
       reverse_proxy 127.0.0.1:<remotePort>
       header Strict-Transport-Security "max-age=31536000"
   }
   ```

   Caddy gets and renews the certificate. It keeps the Host header, sets `X-Forwarded-For` and
   `X-Forwarded-Proto` itself (and ignores what an untrusted client sent), and flushes
   `text/event-stream` answers at once. The board's live updates and the terminal are event
   streams. Do not put `encode` in front of the board unless the streams have been checked to
   still flow.
6. **Firewall.** Only 22, 80 and 443 open. `<remotePort>` needs no rule: it is on loopback.
7. **Another proxy (nginx), for those who use one.** It must not buffer the streams and must pass
   the right headers:
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
  `remote.on` (Tailscale): either can be on without the other.
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
     - `/api/peers` and pairing give 404 here.
     - Then `dispatch(routes, …)` with
       `guards = { ...guards, origins: ['https://<domain>'] }`.
     - Event streams are wrapped so that they end, with a named event, the moment the login ends.
       This is `endsWhenUnpaired`, generalized.
- **Routes only the local board may use (call 16).** Today `localOnly` in `server/remote.ts`
  covers `/api/remote*`. It grows to cover the new management routes too: login setup, passkey
  list, logins, the tunnel's settings, on/off, Generate key, Test. That holds on all three remote
  listeners: Tailscale, serve and the tunnel. A phone or a remote login can never change the
  login, end other logins, approve a phone or read the tunnel's settings.
- **The caller's address.** Every request on this listener comes from 127.0.0.1 (the ssh client).
  The caller's real address is only what the proxy put in `X-Forwarded-For`; the board takes the
  rightmost entry. It is used to show attempts and logins and to group rate limits. It never
  decides whether anyone gets in.

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
    logged in through the domain, and adding it asks for a fresh TOTP code **(call 21)**. A stolen
    login alone cannot plant a lasting one. This is the owner's "first passkey on a new device
    after logging in there with password + TOTP". It also works on the PC itself through the
    domain (Windows Hello).
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
  - Snippets, filled in, each with Copy: the user commands, the `authorized_keys` line, the sshd
    `Match` block, the Caddyfile, and the nginx note folded away.
  - On is disabled, with the reason, until the fields check out and the login is set up.
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

- **`board tunnel`**: on or off, the state with since when, the error, the domain, the ssh binary.
- **`board tunnel on|off`**: sets `tunnel.on` in config.json, as `board remote on|off` sets
  `remote.on`. The running board follows the config change, as the remote listener does with
  `configChanged()`. `on` refuses, with the reason, while the fields do not check out or the
  password or TOTP is not set up **(call 13)**.
- **`board tunnel test`** runs Test connection and prints its steps **(call 29)**.
- **Login setup is not in the CLI.** It needs a screen (QR codes, passkeys); the panel is the
  place.
- **`board doctor`**, while the tunnel is on, checks (the same shape as `phoneChecks`): ssh
  found, the key there and accepted, the fields valid, the login set up, the state.

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
  - TOTP's math and parsing the WebAuthn data, where they need no I/O.

  Web code imports only core modules without `node:` imports, as with `core/profiles.ts`.
- **adapters:** find and run ssh and ssh-keygen; icacls; the secret and login files.
- **services:**
  - the tunnel supervisor: spawn, status, backoff, sleep and network watch, the pid record,
    Test;
  - access: password, TOTP, passkeys, logins, lockout, rate limits, failed attempts.
- **server:**
  - the tunnel listener;
  - the public login routes (tunnel listener only);
  - the probe;
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

- Setting up the server (DNS, Caddy, sshd, the user). The README and the panel give snippets
  only.
- Several tunnels; several PCs on one domain; a hub.
- Several users, accounts, roles or user names. One owner.
- The Android app through the domain (it pairs over Tailscale and uses a bearer token).
- Recovery codes, e-mail reset.
- Encrypting the secrets at rest beyond file permissions (call 4). Someone who can read the state
  folder can already drive the board.
- Changing the Tailscale remote mode, its PWA or its pairing.
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
- A remote login (or a phone) acting on the PC's screen, changing the login, ending other logins,
  approving phones, or reading or changing the tunnel's settings.
- The board running anything on the server beyond holding its one forward.
- Two ssh processes for the tunnel at once, or a stray ssh holding the port after a restart.
- A third-party service in the path.
- A lockout the owner cannot get out of from the PC.

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

- **Windows key ACL.** If the generated key's ACL is not set, Windows' ssh will not use it. Check
  on a real machine, including a state folder whose parent grants other users.
- **Git's ssh instead of Windows' ssh**: different path and permission handling. Use Windows' own
  by full path.
- **Buffered streams.** Caddy is fine as configured. nginx needs `proxy_buffering off`.
  Compression in front of the streams can hold them.
- **Restart overlap and a port held on the server** (see above). Test a code change while a
  tablet has the board open, and a sleep and wake of the PC.
- **A stolen tunnel key.** Someone with it can hold the server's port while the board's tunnel is
  down, and stand in for the board: they could capture a password. A TOTP code cannot be used
  twice, and a passkey's answer is bound to the challenge, so it is no use to them. They cannot
  reach the PC.
  - Mitigations: the key's ACL; "Generate key" rotates it; the sshd block keeps the key to one
    loopback port with no `-L`.
- **Caddy's pooled connections** can give one 502 right after the tunnel comes back. The page's
  normal retries cover it.
- **TOTP needs the PC's clock** within about 30 s.
- **The domain is public.** Scanners will find it, so:
  - hello says nothing before a login;
  - everything else gives 401;
  - the login routes are rate-limited;
  - failed attempts are visible in the panel.

## Testing

- **Unit:**
  - parsing and checking the `tunnel` config, leading dashes included;
  - the ssh argument list (Windows and POSIX paths, quoting);
  - the snippets with given values;
  - the backoff and lockout schedules;
  - TOTP against RFC 6238's Appendix B vectors (SHA-1), plus drift and replay;
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
  - The local listener: the existing tests stay green and unchanged.
  - The Tailscale and serve listeners refuse the new management routes.
- **Supervisor (with a fake ssh):**
  - connect, exit, backoff, reset;
  - `ExitOnForwardFailure`, then a later success;
  - an error that does not heal by itself;
  - a sleep (clock jump) and a network change;
  - a stray recorded ssh ended before the start, and a pid now used by another program left
    alone;
  - off ends the process tree;
  - a restart with an overlap never runs two.
- **Web:**
  - the panel's markup in each state;
  - the Settings item on the local page only;
  - the login screen (passkey first, the password form, lockout, errors);
  - "Sign out";
  - the RemoteGate states for `auth: 'login'`.
- **Manual run on the owner's machine and server:**
  - set up the server from the README;
  - Generate key, then Test connection, each failure once (wrong key, wrong `remotePort` in
    Caddy, a changed host key);
  - on an iPad: password + code, add a passkey (Face ID), sign in with it, install on the home
    screen;
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
   only; another port is the builder's to add if wanted (the origin then has the port, the rpId
   never does).
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
   stray ssh, and a server-held port is retried with backoff. Not in `run.ts`.
10. **Test connection checks end to end through the domain** with a one-time probe.
11. **The README's sshd `Match` block is a second fence**, beside the `authorized_keys` options:
    remote forwards only, `PermitOpen none`, no TTY, a forced command, and `ClientAlive*` to free
    a dead forward.
12. **`X-Accel-Buffering: no` on event streams** through the tunnel.
13. **The tunnel listener runs, and `tunnel on` is allowed, only once the password and TOTP are
    set up** and the fields check out.
14. **"Remote access…" is always in Settings on the local board**, never on a remote page.
15. **"Sign out" on a page through the domain.**
16. **`localOnly` covers every new management route**, on the Tailscale, serve and tunnel
    listeners alike.
17. **The password is at least 12 characters**, with no other rules.
18. **Changing the password or setting TOTP up again ends every login.**
19. **Password and code are checked together**, with one answer for any failure.
20. **Passkeys:** user verification required, discoverable, attestation `none`, ES256 and RS256,
    the counter checked when it is not zero.
21. **Adding a passkey asks for a fresh TOTP code**, even while logged in.
22. **Removing a passkey ends the logins made with it.**
23. **Changing the domain removes the passkeys and ends all logins**, after a warning.
24. **The stream's `unpaired` event is reused** for an ended login, so `useBoard` needs no change.
25. **Lockout:** 5 failed password + code sign-ins in a row, then waits from 1 minute doubling to
    1 hour, counted across the board. Passkey sign-in is never locked. The local board lifts it.
    Login routes are rate-limited per address (from the proxy) and overall. The numbers are
    examples.
26. **No recovery codes**: the local board is the recovery.
27. **"Add a passkey" is offered after a password login** when this browser's own hint says it
    has none.
28. **The panel's view is not in the shared payload**; only a revision number is.
29. **`board tunnel test`** exists beside `on|off` and the status.

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
- **Default ports** (the tunnel listener; a suggested `remotePort`) and the numbers: backoff,
  keepalives, polling, lockout, rate limits, how many attempts are kept.
- **The module split**, following the layers. In particular: a new listener factory beside
  `createRemoteListener`, sharing the gate pieces (`desktopOnly` in both spellings, `localOnly`,
  the stream wrapper, the public page route), or one listener factory for all three. Prefer
  sharing small pieces over a third mode inside `answer()`.
- **Route names and payload shapes.** Those named here are proposals.
- **How "connected" is detected** (ssh's `-v` output, or liveness plus the probe).
- **Passkey labels** (User-Agent only, or with AAGUID names) and whether they can be renamed.
- **Layout and styling** of the panel and the login screen, following the Phones and Profiles
  panels and the pairing screen.

## Later (not this work)

- A hub: one domain for several PCs.
- The Android app through the domain.
- A notification on the PC when a new login signs in.
