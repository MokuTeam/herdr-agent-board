# agent-board: the Board through Your Own Domain (Reverse SSH Tunnel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board, live, in any browser at `https://<domain>`, through a reverse SSH tunnel the board keeps open itself to a Unix socket on the owner's server, behind a login of the board's own (a passkey, or password + TOTP code); everything set up from a "Remote access…" panel on the local board and from `board tunnel`.

**Architecture:** Pure rules in `src/core` (the `tunnel` settings and their checks, the ssh line, the server snippets, TOTP, the login's rules, WebAuthn parsing and signatures, the board's-own-files check). Adapters find and run ssh and ssh-keygen, keep the secret files (mode `0o600`) and resolve real paths. Two services: the login (`services/access.ts`: password, TOTP, passkeys, logins, lockout, rate limits, attempts) and the tunnel supervisor (`services/tunnel.ts`: ssh, status, backoff, sleep and network watch, the pid record, the probe through the domain, Test connection). The server gets a third remote listener, the tunnel listener on `127.0.0.1:<tunnelPort>` (`server/tunnel.ts`), whose gate asks a login of every board route, plus local-only management routes (`/api/access`). The page gets the Remote access panel, a login screen in `RemoteGate`, "Sign out" and "Add a passkey".

**Tech Stack:** Bun 1.4.3, strict TypeScript, React 19 + react-dom, Biome; the OpenSSH client (Windows' own `ssh.exe`, or `ssh` on PATH); WebCrypto / `node:crypto`; no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-20-remote-tunnel-design.md` (approved by the owner; its numbered "Calls" are part of it). Earlier plans for the conventions: `docs/superpowers/plans/2026-10-18-multi-profile.md`, `docs/superpowers/plans/2026-10-19-profile-start-command.md`. Phase-1 conventions (read them, never edit them): `C:/migo/development/projects/external/mokuhub/herdr-agent-board/.superpowers/sdd/2026-10-16-ts-bun-react-rework/conventions.md`.

## Global Constraints

- **Worktree:** the one holding branch `feature/remote-tunnel` (today `C:/migo/development/projects/external/mokuhub/herdr-agent-board/.claude/worktrees/agent-a284b729671f0f540`). Work only there; never touch the main checkout one level up (herdr runs the owner's live board from it). Commit locally, never push. Never touch `.superpowers/`.
- **Conventions** bind every task: Bun and strict TS (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), `.ts`/`.tsx` import extensions, no `any`, Biome; layers: core pure (no I/O; computation with `node:crypto` is allowed, as `core/dialogs/questions.ts` does), adapters import only core and adapters, services orchestrate, server/tui/entrypoints wire, `web/src` the page; JSON from disk or network narrowed before use; unknown JSON fields kept on write; Windows first-class: no shell when spawning, programs in System32 by full path (`%SystemRoot%\System32\…`), paths built with `node:path`.
- **Web-safe core:** `src/core/tunnel.ts`, `src/core/tunnel-snippets.ts` and `src/core/access.ts` have no `node:` import (the page imports them). Web code never imports `src/core/totp.ts`, `src/core/webauthn.ts` or `src/core/own-files.ts`.
- **Toolchain (Git Bash):** `export PATH="$HOME/.bun/bin:$PATH"`, then `bun test <file>`, `bun test`, `bun run check`. Write files with the Write/Edit tools, never heredocs (they strip backslashes).
- **Green means:** `bun test` passes everything but the one failure already on `main`, `the skill install copies is upstream’s, word for word, but for what \`board sleep\` added` (`test/entrypoints/install.test.ts`); the 2 symlink tests may skip. `bun run check` clean. Every task ends green. A task that sees another failure stops and reports it.
- **Sandboxes only:** temp folders, `isolatedHome()`, `sandbox()` and the fakes in `test/support`. Never run the real `ssh`, `ssh-keygen` or a real server; never read or write the owner's state folder, `~/.ssh`, `%APPDATA%\herdr`, `%LOCALAPPDATA%\herdr`; never port 12422. From Task 9 on, `sandbox()` points `BOARD_SSH_BIN_PATH` and `BOARD_SSH_KEYGEN_BIN_PATH` at files that do not exist, so a test that forgets the fake reaches nothing. `whoami.exe` and `icacls.exe` may run for real on sandbox files.
- **Environment variables** (read where the binary is looked up, like `TAILSCALE_BIN_PATH`): `BOARD_SSH_BIN_PATH`, `BOARD_SSH_KEYGEN_BIN_PATH` (another ssh / ssh-keygen), `BOARD_TUNNEL_PROBE_ORIGIN` (another origin than `https://<domain>` for the probe; tests only).
- **Anti-goal no. 1:** a request from the internet reaches a board route without a valid login. Whether a login is needed depends on the listener a request came to, never on a header; no header, setting or state turns the login off on the tunnel listener; the tunnel never points at the web board's port; a request the tunnel listener cannot place is refused.
- **Nobody else notices:** the web board on `127.0.0.1:<port>` and the Tailscale listeners (tailnet, serve) behave exactly as today, except: the "Remote access…" Settings item on the local page (its panel is mounted only once opened), `localOnly` also covering `/api/access`, and a new payload field `accessRev`.
- **Secrets never leave the state folder:** not in the payload, `web.log`, a URL, or any API answer. Exceptions: the public key, and the TOTP secret sent once to the local page during TOTP setup. Files through `adapters/json-store.ts` with `mode: 0o600`.
- **Texts:** every new key in English and Russian in `src/core/i18n/access-strings.ts` (Task 2 creates it; `strings.ts` merges it as it does `REMOTE_STRINGS`); `missingKeys` stays `[]`. Where a task gives only the English, write the Russian in the tone of `remote-strings.ts`. Texts marked **exact** are copied as given. CLI output stays English, as `board remote`'s is.
- **CSS:** the six upstream sheets (`app.css`, `menu.css`, `launch.css`, `questions.css`, `terminal.css`, `helpers.css`) are never touched (`test/web/styles.test.ts`). New rules go in `web/styles/access.css` (Task 16 creates it, linked from `web/index.html` after `segments.css`); the login screen's go in `web/styles/pwa.css`. Rules select by class only.
- **The spike decides:** where Task 1's results (appended to the spec's "Risks and things to watch") differ from this plan (the exact success line, the ACL recipe, a README fallback), follow the spike.
- **Commit messages:** the plain English sentence the task gives; no prefix, no trailer, no `Co-Authored-By`, and the work attributed to no one but the repo's git user, anywhere (code, comments, docs, commits). No new file name takes the prefix the owner's global gitignore hides (the conventions file names it).

## Review Focus

1. **A board route spelled another way through the tunnel** (`/api/%61ccess`, `/api/open%2Durl`, `/api/fs/%70review`, `/api/remote%2Fx`): refused exactly as the plain spelling (403 local, 403 desktop, the own-files 403). → Task 12 (gate), Task 13 (own files).
2. **config.json edited by hand with values that would reach ssh as options** (`"host": "-oProxyCommand=calc"`, `"user": "-l"`, `"socket": "/tmp/board.sock"`, `"socket": "/a:b"`): no ssh is ever spawned, the tunnel listener does not listen, `board tunnel on` refuses with the reason, `board doctor` names the field. → Task 2 (checks), Task 14 (no spawn), Task 15 (CLI, doctor).
3. **The state folder under a user name with a space, `%` or Cyrillic** (`C:\Users\Иван Петров\…`, `C:\Users\a b%c\…`): `-i` and `UserKnownHostsFile` reach ssh as one value each, `%` doubled, forward slashes. → Task 2 (args), Task 9 (spawn with such a path).
4. **The PC sleeps, the network changes, or the board restarts while a tablet is open:** ssh restarts at once, never two at a time, a stray ssh from a killed board is ended and a pid now used by another program is left alone. → Task 10 (supervisor), Task 14 (two boards in a row).
5. **A login that ended or expired, whose cookie the page keeps sending** (it retries `/api/hello` while the PC is away): hello says `signedIn: false` and clears the cookie, every other route 401s and clears it, open event streams end with `unpaired`. → Task 7 (expiry), Task 12 (cookie, streams).

## Decisions where the spec is silent (the owner can overturn them)

- **WebAuthn is hand-rolled** (no dependency): a CBOR subset, authenticator data, COSE → JWK, signatures with `node:crypto` (`dsaEncoding: 'der'` for ES256). Any attestation `fmt` is accepted and its statement ignored (the board asks for `none` and trusts no attestation). "Recorded" vectors come from a software authenticator in `test/support` with its own CBOR encoder and signer; the owner's devices are the manual check.
- **"Connected"** is ssh's `-v` line `remote forward success for: listen <socket>`; only non-`debug` lines are kept for error texts.
- **Numbers:** tunnel listener port = web port + 2; backoff 1 s doubling to 60 s, ±20 % jitter, reset after 60 s up; lasting errors retry every 60 s; sleep tick 5 s, a gap over 30 s counts as sleep; network poll 10 s; probe 3 s after connecting, then every 5 min; Test waits 25 s for the forward, the probe-only listener closes after 30 s; lockout from the 5th failure in a row, 1 min doubling to 1 h; rate limits per address / overall per minute: password 10 / 30, passkey 20 / 60, hello and probe 120 / 600; 100 attempts kept, 20 shown; a pending TOTP secret lives 10 min; a passkey challenge 2 min, at most 50 at once.
- **Files** in the state folder: `access.json` (password hash, TOTP secret and last step, WebAuthn user id, lockout), `access-passkeys.json`, `access-logins.json`, `access-attempts.json`; `tunnel/id_ed25519` and `.pub`, `tunnel/known_hosts`, `tunnel/ssh-pid.json`.
- **Routes:** local only (refused on every remote listener): `GET /api/access`, `POST /api/access` `{ op, … }`. Tunnel listener only: public `POST /api/login/password`, `POST /api/login/passkey/options`, `POST /api/login/passkey`, `GET /api/probe/<nonce>`; behind the login `POST /api/logout`, `POST /api/login/passkey/add/options`, `POST /api/login/passkey/add`.
- **ssh runs only while the tunnel listener listens** (on, the settings check out, password and TOTP set up): a forward to nothing would only give the tablet 502s.
- **The own-files check sits in the routes**, through `GuardState.ownFiles` that only the tunnel listener sets; the marker test from the route table is the backstop.
- **A tunnel field the panel sends that fails its own check is refused** (409, config.json unchanged); hand edits are checked before use. Changing the domain while passkeys or logins exist needs `confirm: true`.
- **ssh dies with the board:** `run.ts` restarts the board by `process.exit(75)` without closing the server, so the supervisor also kills its ssh synchronously in a `process.on('exit')` handler. A recorded ssh is recognised by its command line holding the forward `<socket>:127.0.0.1:<port>` (PowerShell `Get-CimInstance Win32_Process` on Windows, `/proc/<pid>/cmdline` on Linux, `ps -o command=` on macOS).
- **Paths in the ssh line:** forward slashes on Windows, `%` doubled (ssh expands `%` tokens in both `-i` and `UserKnownHostsFile`; checked while planning with `ssh -G`), `UserKnownHostsFile` in double quotes; a key path with `"` or `${` is refused.
- **Labels** come from the User-Agent only ("Safari on iPad"; iPadOS Safari says it is a Mac and is labelled so), not renamable. **"Add a passkey"** is offered on the login screen right after a password sign-in. **"Sign out"** is a Settings item on a page whose last hello said `auth: 'login'`.

---

## File map

| Area | Files |
|---|---|
| Spike | Modify `docs/superpowers/specs/2026-10-20-remote-tunnel-design.md` (results) |
| Tunnel rules | Create `src/core/tunnel.ts`, `src/core/tunnel-snippets.ts`, `src/core/i18n/access-strings.ts`; modify `src/core/i18n/strings.ts` |
| Login rules | Create `src/core/totp.ts`, `src/core/access.ts`, `src/core/webauthn.ts`, `test/support/soft-authenticator.ts` |
| Own files | Create `src/core/own-files.ts`, `src/adapters/own-files.ts` |
| Login service | Create `src/adapters/access-store.ts`, `src/services/access.ts` |
| ssh | Create `src/adapters/ssh.ts`, `src/adapters/probe.ts`, `test/support/fake-ssh.ts`, `test/support/fake-ssh-bin.ts`; modify `src/adapters/process.ts`, `test/support/fake-herdr-bin.ts`, `test/support/sandbox.ts` |
| Supervisor | Create `src/services/tunnel.ts`, `src/server/tunnel-probe.ts` |
| Server | Create `src/server/tunnel.ts`, `src/server/streams.ts`, `src/server/routes/access.ts`, `src/services/remote-access.ts`, `test/support/tunnel-board.ts`; modify `src/core/remote.ts`, `src/server/remote.ts`, `src/server/http.ts`, `src/server/routes/fs.ts`, `src/server/routes/session.ts`, `src/server/app.ts`, `src/server/board-state.ts`, `src/core/payload.ts`, `src/adapters/config-file.ts`, `test/support/runner.ts` |
| CLI | Create `src/services/tunnel-facts.ts`; modify `src/entrypoints/cli.ts` |
| Web | Create `web/src/components/Qr.tsx`, `web/src/components/access/{AccessPanel,TunnelSection,Snippets,LoginSection,LoginsSection}.tsx`, `web/src/components/remote/LoginScreen.tsx`, `web/src/models/{access,passkey,login}.ts`, `web/src/hooks/useAccess.ts`, `web/styles/access.css`; modify `PhonesPanel.tsx`, `Panel.tsx`, `settings-menu.ts`, `useSettingsMenu.ts`, `SidePanels.tsx`, `App.tsx`, `RemoteGate.tsx`, `remote-page.ts`, `web/src/api/client.ts`, `web/index.html`, `web/styles/pwa.css` |
| Docs | `README.md` |

---

### Task 1: Spike: Windows' ssh with a remote socket forward, and the socket's owner and mode on a Linux sshd

**Spec:** "Risks and things to watch" (Windows' ssh and a socket forward; the socket's permissions; Windows key ACL), "The server" (steps 2–4), "The tunnel on the PC".

The two unverified risks, checked before any code depends on them. Tasks 2–8 do not depend on this one; Tasks 9, 10 and 19 read its results.

**Already checked while planning** (OpenSSH_for_Windows_9.5p2, `C:\Windows\System32\OpenSSH\ssh.exe`): `ssh -G -F none -R /var/lib/boardtunnel/board.sock:127.0.0.1:12424 boardtunnel@example.com` prints `remoteforward /var/lib/boardtunnel/board.sock [127.0.0.1]:12424` (the client parses the socket forward unchanged); `-o 'UserKnownHostsFile="C:/a%%b/kh"'` prints `C:/a%b/kh` while a single `%d` is expanded, so `%` must be doubled.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-20-remote-tunnel-design.md` (append a block to "Risks and things to watch")
- Scratch: a new folder under the session's temp/scratch folder, outside the repo. Nothing else in the repo changes.

**Interfaces:** Produces facts only: the exact success line, the socket's `ls -l`, the exit code and line on a refused forward, and the Windows ACL recipe, written into the spec.

- [ ] **Step 1: Docker or not.** Run `docker info`. If it fails, do not start Docker Desktop yourself: do Steps 6 and 7 (Windows only), write what you could check into the spec as in Step 8, mark the server half "waits for the owner's manual run", commit, and report NEEDS_CONTEXT so the owner can start Docker and the spike can finish.
- [ ] **Step 2: A Linux sshd as the README will set it up.** In a container (`debian:bookworm-slim`, port 22 published on `127.0.0.1:2222`), install `openssh-server` and `curl`, then as root:
  - a `caddy` system group and user standing in for Caddy (`groupadd --system caddy && useradd --system -g caddy caddy`);
  - the tunnel user and folders exactly as the spec's step 2 (`useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin boardtunnel`, `install -d -m 2750 -o boardtunnel -g caddy /var/lib/boardtunnel`, `install -d -m 755 /etc/ssh/authorized_keys`);
  - the spec's step 4 `Match User boardtunnel` block appended to `/etc/ssh/sshd_config`, `mkdir -p /run/sshd`, `sshd -t`, start `/usr/sbin/sshd`.
- [ ] **Step 3: A key and the forward from Windows' own ssh.** With `C:\Windows\System32\OpenSSH\ssh-keygen.exe -q -t ed25519 -N "" -C spike -f <scratch>\key`, put `restrict,port-forwarding <key.pub>` into `/etc/ssh/authorized_keys/boardtunnel` (root, 644). Start a Bun HTTP server on `127.0.0.1:<free port>` that answers `hello from the PC`. Run, with `<scratch>` in a folder whose name has a space:
  ```
  C:\Windows\System32\OpenSSH\ssh.exe -F none -N -T -v -i <scratch>/key -o IdentitiesOnly=yes -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=\"<scratch with space>/known_hosts\"" -p 2222 -R /var/lib/boardtunnel/board.sock:127.0.0.1:<port> boardtunnel@127.0.0.1
  ```
  Expected:
  - stderr has `debug1: remote forward success for: listen /var/lib/boardtunnel/board.sock` (copy the whole line as it is);
  - `docker exec … stat -c '%A %U %G' /var/lib/boardtunnel/board.sock` → `srw-rw---- boardtunnel caddy`, and the folder `drwxr-s--- boardtunnel caddy`;
  - `docker exec -u caddy … curl -s --unix-socket /var/lib/boardtunnel/board.sock http://x/` → `hello from the PC`; the same as `-u nobody` → permission denied;
  - the known_hosts file in the folder with a space holds the server's key.
- [ ] **Step 4: The stale socket.** `taskkill /F` the ssh, start the same line again at once: the success line again (StreamLocalBindUnlink replaced the old socket). Note what `-v` prints for each request through the tunnel (the noise the board will read).
- [ ] **Step 5: A refused forward.** `chown root /var/lib/boardtunnel`, run the line again: expected ssh exits by itself (ExitOnForwardFailure) with `Error: remote port forwarding failed for listen path /var/lib/boardtunnel/board.sock`; note the exit code. Put the owner back.
- [ ] **Step 6: The key's ACL on Windows.** Make a folder that grants `BUILTIN\Users` read to its children (`icacls <dir> /grant *S-1-5-32-545:(OI)(CI)R`), make a key there with ssh-keygen, run `ssh-keygen -y -P "" -f <key>` and the ssh line: expected "UNPROTECTED PRIVATE KEY FILE" or "Bad permissions" from both. Then the board's recipe: `whoami /user /fo csv /nh` (note the output's form), `icacls <key> /inheritance:r /grant:r *<SID>:F`: both now accept the key. Copy `icacls <key>` before and after.
- [ ] **Step 7: If something fails** (do not code around it; record and report):
  - no success line, but the forward works → record what `-v` does print on success; Task 10 matches that instead;
  - Windows' ssh does not take the `-R /path:…` form → try `-o "RemoteForward /var/lib/boardtunnel/board.sock 127.0.0.1:<port>"`; if neither works, BLOCKED: the design's core choice needs the owner;
  - sshd says the account is locked (`useradd` leaves `!` as the password; sshd with `UsePAM no` refuses it) → record it; Task 19's README adds `sudo usermod -p '*' boardtunnel`;
  - the socket's group is not `caddy` (setgid not honoured) → record it; the README fallback is `sudo usermod -aG boardtunnel caddy` with the folder `boardtunnel:boardtunnel`;
  - the mode is not `srw-rw----` → record `StreamLocalBindMask` as tried, BLOCKED;
  - ssh does not exit on a refused forward → record it; Task 10 ends ssh itself on the "failed for listen path" line;
  - the ACL recipe does not satisfy ssh → BLOCKED with both `icacls` outputs.
- [ ] **Step 8: Write the results** into the spec, at the end of "Risks and things to watch", as a block headed `**Checked by the spike (<date>, OpenSSH_for_Windows_<version>, Debian <version> sshd):**`, one line per check: the success line verbatim, the `stat` output, curl as caddy and as nobody, the stale-socket restart, the refused-forward exit code and line, the ACL before/after and the recipe, the `whoami` form, anything from Step 7. Remove the container (`docker rm -f`) and the scratch folder.
- [ ] **Step 9: Commit**
  ```bash
  git add docs/superpowers/specs/2026-10-20-remote-tunnel-design.md
  git commit -m "Record what a trial tunnel from Windows' ssh to a Linux sshd showed about the socket forward, its socket and the key's access rights"
  ```

---

### Task 2: The tunnel's settings, their checks and the ssh line (core)

**Spec:** "Settings and where they live" (the `tunnel` object, "Checked before use"), "The tunnel on the PC" ("What it runs"), "Coming back" (backoff, lasting errors), "Status", "Hints for the usual failures".

**Files:**
- Create: `src/core/tunnel.ts`, `src/core/i18n/access-strings.ts`
- Modify: `src/core/i18n/strings.ts` (merge `ACCESS_STRINGS` after `ASIDE_STRINGS`, as the others are merged)
- Test: `test/core/tunnel.test.ts`

**Interfaces:**
- Consumes: `t` (`src/core/lang.ts`).
- Produces (`src/core/tunnel.ts`, no `node:` import):
  ```ts
  export const TUNNEL_SOCKET = '/var/lib/boardtunnel/board.sock'
  export interface TunnelConfig { on: boolean; host: string; sshPort: number; user: string; key: string; socket: string; domain: string; port: number | null }
  /** config.json's `tunnel`: strings trimmed, a wrong type gives the default; nothing is checked here. */
  export function tunnelConfig(value: unknown): TunnelConfig
  export type TunnelField = 'host' | 'sshPort' | 'user' | 'key' | 'socket' | 'domain' | 'port'
  export interface TunnelProblem { field: TunnelField; message: string }
  /** The board's other ports: the web board, the remote listener's (`remote.port`), the phone's browser's (`remote.pwa.port ?? web + 1`). */
  export interface Ports { web: number; remote: number | null; pwa: number }
  /** From config.json's `remote` (remoteConfig, pwaPort) and the web port. */
  export function boardPorts(remote: unknown, webPort: number): Ports
  export const tunnelPort = (conf: TunnelConfig, webPort: number): number => conf.port ?? webPort + 2
  /** One field's own check: null when it is fine (an empty host, user or domain is fine here: tunnelProblems says it is missing). */
  export function fieldProblem(field: TunnelField, value: unknown, ports?: Ports): string | null
  /** Every field's check, in TunnelField order; empty host, user and domain are named as missing. */
  export function tunnelProblems(conf: TunnelConfig, ports: Ports): TunnelProblem[]
  /** A path as ssh reads it: forward slashes on win32, `%` doubled. */
  export function sshPathArg(path: string, platform?: string): string
  export interface SshLine { conf: TunnelConfig; key: string; knownHosts: string; target: number; platform?: string }
  export function sshArgs(l: SshLine): string[]
  export const forwardSpec = (socket: string, target: number): string => `${socket}:127.0.0.1:${target}`
  export type TunnelHint = 'publickey' | 'listenPath' | 'keyPermissions' | 'hostKey' | 'network' | 'noSsh' | 'passphrase'
  export function sshHint(lines: readonly string[]): TunnelHint | null
  /** Errors that do not heal by themselves: shown as `error`, retried every 60 s. */
  export function isLasting(hint: TunnelHint | null): boolean
  /** ssh -v saying the server took the forward of `socket`. */
  export function forwardAccepted(line: string, socket: string): boolean
  export function backoffMs(attempt: number, random?: () => number): number
  export type TunnelState = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'error'
  export interface ProbeNote { ok: boolean; at: number; detail: string }
  export interface TunnelStatus { state: TunnelState; since: number; attempt?: number; nextAt?: number; error?: string; hint?: TunnelHint | null; probe?: ProbeNote | null }
  export type ProbeResult = { ok: true } | { ok: false; kind: 'status' | 'tls' | 'network' | 'answer'; detail: string; status?: number }
  export type StepHint = TunnelHint | 'caddy502' | 'tls' | 'answer' | 'notConnected'
  export interface TestStep { id: 'ssh' | 'forward' | 'domain'; ok: boolean | null; detail: string; hint: StepHint | null }
  ```
- Produces (`src/core/i18n/access-strings.ts`): `export const ACCESS_STRINGS: Record<Lang, Record<string, string | string[]>>`.

**Rules the code must follow:**
- **Checks** (the spec's list):
  - `host`: `^[A-Za-z0-9.-]+$` (a name or IPv4) or `^[0-9A-Fa-f:]+$` with a `:` (IPv6); never a leading `-`.
  - `user`: `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$`.
  - `sshPort`, `port`: integers 1–65535 (`port` may be null). `port` also differs from `ports.web`, `ports.remote` and `ports.pwa`.
  - `socket`: `^/` then parts of `[A-Za-z0-9._-]+` joined by `/`, no part `.` or `..`, no empty part; at most 100 bytes; its folder is not `/`, `/tmp`, `/var/tmp`, `/dev/shm`, `/run` or `/var/run`.
  - `domain`: lowercase labels `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?` joined by dots, at least two labels, at most 253 characters.
  - `key`: `''`, or a path that does not start with `-` and holds no `"`, no `${` and no control character.
- **Texts** (keys in `access-strings.ts`; English exact, Russian yours):

  | key | en |
  |---|---|
  | `tunnel.field.host` | `Server` |
  | `tunnel.field.sshPort` | `SSH port` |
  | `tunnel.field.user` | `User` |
  | `tunnel.field.key` | `Key` |
  | `tunnel.field.socket` | `Socket on the server` |
  | `tunnel.field.domain` | `Domain` |
  | `tunnel.field.port` | `Local port` |
  | `tunnel.err.required` | `{field}: needed` |
  | `tunnel.err.host` | `The server is a host name or an address, without spaces, @ or a leading dash` |
  | `tunnel.err.user` | `The user is a plain user name, without a leading dash` |
  | `tunnel.err.port` | `{field} is a whole number from 1 to 65535` |
  | `tunnel.err.portTaken` | `Port {port} is the board's already (the web board, phones, or the phone's browser)` |
  | `tunnel.err.socket` | `The socket is an absolute path of letters, digits and . _ - / only, with no empty, . or .. part` |
  | `tunnel.err.socketLong` | `The socket's path is longer than 100 bytes` |
  | `tunnel.err.socketShared` | `The socket needs a folder of its own, not {folder}, where anyone could take its name first` |
  | `tunnel.err.domain` | `The domain is a lowercase host name such as board.example.com, without https://, a path or a port` |
  | `tunnel.err.key` | `The key's path cannot start with a dash or hold " or ${` |

  `{field}` is the field's `tunnel.field.*` text.
- **`sshArgs`**, in this order: `-F none -N -T -v`, `-i <sshPathArg(key)>`, `-o IdentitiesOnly=yes`, `-o BatchMode=yes`, `-o ExitOnForwardFailure=yes`, `-o ServerAliveInterval=15`, `-o ServerAliveCountMax=3`, `-o TCPKeepAlive=yes`, `-o ConnectTimeout=15`, `-o StrictHostKeyChecking=accept-new`, `-o UserKnownHostsFile="<sshPathArg(knownHosts)>"`, `-p <sshPort>`, `-R <forwardSpec(socket, target)>`, `<user>@<host>`. Each `-o` value is one argument.
- **`sshHint`** reads the lines (newest last), first match wins: `/Permission denied \(publickey/` → `publickey`; `/remote port forwarding failed for listen path/` → `listenPath`; `/UNPROTECTED PRIVATE KEY FILE|Bad permissions|are too open/` → `keyPermissions`; `/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/` → `hostKey`; `/passphrase/i` → `passphrase`; `/Connection timed out|Connection refused|Could not resolve hostname|Operation timed out|No route to host|Network is unreachable/` → `network`. Lasting: everything but `network` and null.
- **`forwardAccepted`**: the line contains `remote forward success for: listen ${socket}` (Task 1's line if it differs).
- **`backoffMs(n, random = Math.random)`** = `Math.min(60_000, Math.round(1000 * 2 ** (n - 1) * (0.8 + 0.4 * random())))`.

- [ ] **Step 1: Write the failing test** `test/core/tunnel.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { useLanguage } from '../../src/core/lang.ts'
import {
  backoffMs, boardPorts, fieldProblem, forwardAccepted, isLasting, sshArgs, sshHint, sshPathArg, TUNNEL_SOCKET,
  tunnelConfig, tunnelPort, tunnelProblems,
} from '../../src/core/tunnel.ts'

const PORTS = { web: 12422, remote: null, pwa: 12423 }
const GOOD = tunnelConfig({ on: true, host: 'ssh.example.com', user: 'boardtunnel', domain: 'board.example.com' })

describe('the tunnel’s settings', () => {
  test('read from config.json with their defaults, never checked there', () => {
    expect(tunnelConfig(undefined)).toEqual({ on: false, host: '', sshPort: 22, user: '', key: '', socket: TUNNEL_SOCKET, domain: '', port: null })
    expect(
      tunnelConfig({ on: true, host: ' ssh.example.com ', sshPort: 2222, user: 'boardtunnel', key: 'C:\\keys\\k', socket: '/srv/b/b.sock', domain: 'board.example.com', port: 12500, extra: 1 }),
    ).toEqual({ on: true, host: 'ssh.example.com', sshPort: 2222, user: 'boardtunnel', key: 'C:\\keys\\k', socket: '/srv/b/b.sock', domain: 'board.example.com', port: 12500 })
    expect(tunnelConfig({ on: 'yes', sshPort: '22', port: 0, host: 3 })).toEqual(tunnelConfig(undefined))
    expect([tunnelPort(GOOD, 12422), tunnelPort({ ...GOOD, port: 12500 }, 12422)]).toEqual([12424, 12500])
  })
  test('what would turn into an ssh option, or split the forward, is refused', () => {
    useLanguage('en')
    for (const v of ['ssh.example.com', '203.0.113.5', '2001:db8::1']) expect(fieldProblem('host', v)).toBeNull()
    for (const v of ['-oProxyCommand=calc', 'a b', 'me@ssh.example.com', 'ssh.example.com\n'])
      expect(fieldProblem('host', v)).toBe('The server is a host name or an address, without spaces, @ or a leading dash')
    for (const v of ['boardtunnel', 'board_tunnel', 'b.t-1']) expect(fieldProblem('user', v)).toBeNull()
    for (const v of ['-l', 'a b', 'root@x', 'x:y']) expect(fieldProblem('user', v)).toBe('The user is a plain user name, without a leading dash')
    for (const v of [1, 22, 65535]) expect(fieldProblem('sshPort', v)).toBeNull()
    for (const v of [0, 65536, 1.5, '22', -1]) expect(fieldProblem('sshPort', v)).toBe('SSH port is a whole number from 1 to 65535')
    for (const v of ['', 'C:\\Users\\Иван Петров\\keys\\id', '/home/me/.ssh/board']) expect(fieldProblem('key', v)).toBeNull()
    for (const v of ['-oX', 'C:\\a"b', '/home/${USER}/k']) expect(fieldProblem('key', v)).toBe('The key\'s path cannot start with a dash or hold " or ${')
  })
  test('the socket: absolute, plain characters, in a folder of its own, at most 100 bytes', () => {
    useLanguage('en')
    const exactly100 = `/srv/${'b'.repeat(90)}/x.sock`
    expect(exactly100.length).toBe(100)
    for (const v of [TUNNEL_SOCKET, '/srv/board/b.sock', exactly100]) expect(fieldProblem('socket', v)).toBeNull()
    for (const v of ['var/lib/x.sock', '/var/lib/a:b.sock', '/var/lib/a b.sock', '/var/lib/../x.sock', '/var/lib/./x.sock', '/var//x.sock', '/var/lib/x.sock/'])
      expect([v, fieldProblem('socket', v)]).toEqual([v, 'The socket is an absolute path of letters, digits and . _ - / only, with no empty, . or .. part'])
    expect(fieldProblem('socket', `/srv/${'b'.repeat(91)}/x.sock`)).toBe("The socket's path is longer than 100 bytes")
    for (const [v, folder] of [['/tmp/board.sock', '/tmp'], ['/run/board.sock', '/run'], ['/board.sock', '/'], ['/var/tmp/x.sock', '/var/tmp'], ['/dev/shm/x.sock', '/dev/shm'], ['/var/run/x.sock', '/var/run']])
      expect(fieldProblem('socket', v)).toBe(`The socket needs a folder of its own, not ${folder}, where anyone could take its name first`)
  })
  test('the domain is a lowercase host name; the listener’s port is none of the board’s others', () => {
    useLanguage('en')
    expect(fieldProblem('domain', 'board.example.com')).toBeNull()
    for (const v of ['Board.example.com', 'https://board.example.com', 'board.example.com:443', 'board.example.com/x', 'localhost', 'board..example.com'])
      expect(fieldProblem('domain', v)).toBe('The domain is a lowercase host name such as board.example.com, without https://, a path or a port')
    expect(fieldProblem('port', null, PORTS)).toBeNull()
    expect(fieldProblem('port', 12500, PORTS)).toBeNull()
    for (const p of [12422, 12423]) expect(fieldProblem('port', p, PORTS)).toBe(`Port ${p} is the board's already (the web board, phones, or the phone's browser)`)
    expect(fieldProblem('port', 13000, { ...PORTS, remote: 13000 })).not.toBeNull()
    expect(boardPorts(undefined, 12422)).toEqual(PORTS)
    expect(boardPorts({ on: true, port: 13000, pwa: { on: true, port: 13001 } }, 12422)).toEqual({ web: 12422, remote: 13000, pwa: 13001 })
  })
  test('missing fields are named, a good config has none, and the messages follow the language', () => {
    useLanguage('en')
    expect(tunnelProblems(tunnelConfig({}), PORTS)).toEqual([
      { field: 'host', message: 'Server: needed' },
      { field: 'user', message: 'User: needed' },
      { field: 'domain', message: 'Domain: needed' },
    ])
    expect(tunnelProblems(GOOD, PORTS)).toEqual([])
    expect(tunnelProblems({ ...GOOD, host: '-x', port: 12422 }, PORTS).map(p => p.field)).toEqual(['host', 'port'])
    useLanguage('ru')
    expect(tunnelProblems(tunnelConfig({}), PORTS)[0]?.message).not.toBe('Server: needed')
    useLanguage('en')
  })
})

describe('the ssh line', () => {
  test('POSIX: the whole line, the forward always to 127.0.0.1', () => {
    const dir = '/home/me/.local/state/herdr/plugins/agent-board/tunnel'
    expect(sshArgs({ conf: GOOD, key: `${dir}/id_ed25519`, knownHosts: `${dir}/known_hosts`, target: 12424, platform: 'linux' })).toEqual([
      '-F', 'none', '-N', '-T', '-v',
      '-i', `${dir}/id_ed25519`,
      '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'TCPKeepAlive=yes', '-o', 'ConnectTimeout=15',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile="${dir}/known_hosts"`,
      '-p', '22',
      '-R', '/var/lib/boardtunnel/board.sock:127.0.0.1:12424',
      'boardtunnel@ssh.example.com',
    ])
  })
  test('Windows: forward slashes, one value each for a path with spaces or Cyrillic, % doubled', () => {
    const args = sshArgs({
      conf: { ...GOOD, sshPort: 2222 },
      key: 'C:\\Users\\Иван Петров\\AppData\\Local\\herdr\\plugins\\agent-board\\tunnel\\id_ed25519',
      knownHosts: 'C:\\Users\\a b%c\\known_hosts',
      target: 12424,
      platform: 'win32',
    })
    expect(args[args.indexOf('-i') + 1]).toBe('C:/Users/Иван Петров/AppData/Local/herdr/plugins/agent-board/tunnel/id_ed25519')
    expect(args).toContain('UserKnownHostsFile="C:/Users/a b%%c/known_hosts"')
    expect(args.slice(-5)).toEqual(['-p', '2222', '-R', '/var/lib/boardtunnel/board.sock:127.0.0.1:12424', 'boardtunnel@ssh.example.com'])
    expect(sshPathArg('C:\\x%y\\k', 'win32')).toBe('C:/x%%y/k')
    expect(sshPathArg('/a\\b%c', 'linux')).toBe('/a\\b%%c')
  })
  test('what ssh says: the hint, whether it heals, whether the forward was taken', () => {
    expect(sshHint(['boardtunnel@ssh.example.com: Permission denied (publickey).'])).toBe('publickey')
    expect(sshHint(['Error: remote port forwarding failed for listen path /var/lib/boardtunnel/board.sock'])).toBe('listenPath')
    expect(sshHint(["Permissions for 'C:/k' are too open.", 'UNPROTECTED PRIVATE KEY FILE!'])).toBe('keyPermissions')
    expect(sshHint(['Bad permissions. Try removing permissions for user: BUILTIN\\Users (S-1-5-32-545) on file C:/k.'])).toBe('keyPermissions')
    expect(sshHint(['Host key verification failed.'])).toBe('hostKey')
    expect(sshHint(['Load key "C:/k": incorrect passphrase supplied to decrypt private key'])).toBe('passphrase')
    expect(sshHint(['ssh: connect to host ssh.example.com port 22: Connection timed out'])).toBe('network')
    expect(sshHint(['ssh: Could not resolve hostname nowhere: Name or service not known'])).toBe('network')
    expect(sshHint(['something else'])).toBeNull()
    for (const h of ['publickey', 'listenPath', 'keyPermissions', 'hostKey', 'noSsh', 'passphrase'] as const) expect(isLasting(h)).toBe(true)
    expect([isLasting('network'), isLasting(null)]).toEqual([false, false])
    const ok = 'debug1: remote forward success for: listen /var/lib/boardtunnel/board.sock:-2, connect 127.0.0.1:12424'
    expect(forwardAccepted(ok, TUNNEL_SOCKET)).toBe(true)
    expect(forwardAccepted(ok, '/srv/other.sock')).toBe(false)
    expect(forwardAccepted('debug1: remote forward failure for: listen /var/lib/boardtunnel/board.sock:-2', TUNNEL_SOCKET)).toBe(false)
  })
  test('backoff: 1 s doubling to 60 s, ±20 %', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(n => backoffMs(n, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
    expect([backoffMs(1, () => 0), backoffMs(1, () => 1), backoffMs(7, () => 1)]).toEqual([800, 1200, 60000])
  })
  test('the page can import it: no node: import', () => {
    expect(readFileSync('src/core/tunnel.ts', 'utf8')).not.toMatch(/from 'node:/)
  })
})
```
- [ ] **Step 2: Run** `bun test test/core/tunnel.test.ts`. Expected: FAIL (cannot find `src/core/tunnel.ts`).
- [ ] **Step 3: Implement** `src/core/tunnel.ts` and `access-strings.ts` with the keys above, merged in `strings.ts`.
- [ ] **Step 4: Run** the same file, then `bun test test/core/i18n.test.ts`. Expected: PASS. Then `bun test` and `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/core/tunnel.ts src/core/i18n/access-strings.ts src/core/i18n/strings.ts test/core/tunnel.test.ts
git commit -m "Check the tunnel's settings before use and build its ssh line from them"
```

---

### Task 3: The server's snippets, filled in (core)

**Spec:** "The server" (steps 2–7, word for word), "The panel" ("Snippets, filled in").

**Files:**
- Create: `src/core/tunnel-snippets.ts` (no `node:` import: the panel imports it)
- Test: `test/core/tunnel-snippets.test.ts`

**Interfaces:**
- Consumes: `TUNNEL_SOCKET` (Task 2).
- Produces:
  ```ts
  export const socketFolder = (socket: string): string  // '/var/lib/boardtunnel'
  export const keysFile = (user: string): string => `/etc/ssh/authorized_keys/${user}`
  export function serverCommands(user: string, socket: string, group?: string): string   // group default 'caddy'
  export function keysLine(publicKey: string): string                                     // 'restrict,port-forwarding ' + the key trimmed
  export function sshdBlock(user: string): string
  export function caddyfile(domain: string, socket: string): string
  export function nginxNote(socket: string): string
  ```
- If Task 1 recorded that sshd refuses the new account as locked, `serverCommands` adds, right after the `useradd` lines, `# a locked account is refused by sshd without PAM: no password, but not locked` and `sudo usermod -p '*' <user>`; its test then expects them.

- [ ] **Step 1: Write the failing test** with the exact texts for `user = 'boardtunnel'`, `socket = TUNNEL_SOCKET`, `domain = 'board.example.com'`:
  - `serverCommands` is these five lines, `\n`-joined, no trailing newline:
    ```
    sudo useradd --system --no-create-home --home-dir /nonexistent \
        --shell /usr/sbin/nologin boardtunnel
    # the socket's folder: the tunnel user makes the socket, Caddy's group opens it, no one else
    sudo install -d -m 2750 -o boardtunnel -g caddy /var/lib/boardtunnel
    # the key's file belongs to root, out of the tunnel user's reach
    sudo install -d -m 755 /etc/ssh/authorized_keys
    ```
    and with `('tun', '/srv/b/x.sock', 'www-data')` the user, group and folder change accordingly (`-o tun -g www-data /srv/b`).
  - `sshdBlock('boardtunnel')` is the spec's block from `Match User boardtunnel` to `ClientAliveCountMax 2`, each setting indented four spaces, `AuthorizedKeysFile /etc/ssh/authorized_keys/boardtunnel`.
  - `caddyfile` is exactly:
    ```
    board.example.com {
        reverse_proxy unix//var/lib/boardtunnel/board.sock
        header Strict-Transport-Security "max-age=31536000"
    }
    ```
  - `nginxNote` is a `location / { … }` block with, in order, `proxy_pass http://unix:/var/lib/boardtunnel/board.sock:;`, `proxy_http_version 1.1;`, `proxy_set_header Connection "";`, `proxy_buffering off;`, `proxy_read_timeout 1h;`, `proxy_set_header Host $host;`, `proxy_set_header X-Forwarded-For $remote_addr;`, `proxy_set_header X-Forwarded-Proto https;`.
  - `keysLine(' ssh-ed25519 AAAA agent-board@PC \n')` → `restrict,port-forwarding ssh-ed25519 AAAA agent-board@PC`; `socketFolder('/srv/b/x.sock')` → `/srv/b`; `keysFile('tun')` → `/etc/ssh/authorized_keys/tun`.
  - The file has no `from 'node:` import.
- [ ] **Step 2: Run** `bun test test/core/tunnel-snippets.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the functions.
- [ ] **Step 4: Run** it: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/core/tunnel-snippets.ts test/core/tunnel-snippets.test.ts
git commit -m "Write the server's user, sshd, Caddy and nginx snippets for given tunnel settings"
```

---

### Task 4: TOTP and the login's pure rules (core)

**Spec:** "Login" (Password, TOTP, "checked together", "Logins (sessions)", "Lockout and rate limits", "Failed attempts"), "The caller's address", Calls 1, 2, 17, 19, 25, 35.

**Files:**
- Create: `src/core/totp.ts` (may use `node:crypto`), `src/core/access.ts` (no `node:` import)
- Modify: `src/core/i18n/access-strings.ts`
- Test: `test/core/totp.test.ts`, `test/core/access.test.ts`

**Interfaces:**
- Produces (`src/core/totp.ts`):
  ```ts
  export const TOTP_STEP_MS = 30_000
  export function base32(bytes: Uint8Array): string             // RFC 4648 alphabet, no padding
  export function base32Bytes(text: string): Uint8Array | null  // case and spaces ignored; null on another character
  export const totpStep = (nowMs: number): number => Math.floor(nowMs / TOTP_STEP_MS)
  export function totpCode(secret: Uint8Array, step: number, digits?: number): string  // HMAC-SHA1 (RFC 6238), zero-padded; digits default 6
  /** The step a code is for: now's, one before or one after, and later than lastStep; compared in constant time. null otherwise. */
  export function totpMatch(secret: Uint8Array, code: unknown, nowMs: number, lastStep: number): number | null
  /** otpauth://totp/<label>?secret=…&issuer=Agent%20board&algorithm=SHA1&digits=6&period=30, label `Agent board:<domain>`, or `Agent board` when that would pass 213 bytes (core/qr.ts's limit). */
  export function totpUri(secretB32: string, domain: string): string
  ```
- Produces (`src/core/access.ts`):
  ```ts
  export const LOGIN_MS = 30 * 24 * 3600_000
  export const LOGIN_COOKIE = '__Host-board-login'
  export const loginCookie = (token: string, maxAgeS: number): string
  export const clearLoginCookie = (): string
  export function loginToken(cookieHeader: string | null): string | null   // the 43-character base64url token of LOGIN_COOKIE only
  export const PASSWORD_MIN = 12
  export function passwordProblem(password: unknown): string | null
  export function lockWaitMs(failures: number): number
  export interface RateRule { perAddress: number; overall: number; windowMs: number }
  export const RATES: { password: RateRule; passkey: RateRule; open: RateRule }
  export class RateLimiter { constructor(rule: RateRule); take(address: string, now: number): { ok: true } | { ok: false; retryAfterS: number } }
  export function deviceLabel(userAgent: string | null): string
  export function forwardedAddress(header: string | null): string          // X-Forwarded-For's rightmost address, '' for none
  export type LoginMethod = 'password' | 'passkey'
  export interface Login { id: string; tokenHash: string; method: LoginMethod; passkeyId?: string; label: string; address: string; signedInAt: number; expiresAt: number; seenAt: number | null }
  export type PublicLogin = Omit<Login, 'tokenHash'>
  export interface Passkey { id: string; jwk: JsonWebKey; alg: -7 | -257; counter: number; transports: string[]; label: string; addedAt: number; usedAt: number | null }
  export type PublicPasskey = Pick<Passkey, 'id' | 'label' | 'addedAt' | 'usedAt'>
  export type AttemptReason = 'wrong' | 'locked' | 'limited'
  export interface Attempt { at: number; address: string; label: string; method: LoginMethod; reason: AttemptReason }
  export interface AccessView {
    tunnel: {
      settings: TunnelConfig; problems: TunnelProblem[]
      /** Why On is refused now; null when it may be turned on. */
      blocked: string | null
      listenPort: number; status: TunnelStatus; ssh: string | null
      key: { path: string; generated: boolean; exists: boolean; publicKey: string | null; error: string | null }
      /** The pinned server key: 'SHA256:… (ED25519)', or null. */
      hostKey: string | null
    }
    login: { password: boolean; totp: boolean; passkeys: PublicPasskey[]; lockout: { until: number } | null }
    logins: PublicLogin[]
    attempts: Attempt[]
  }
  ```
  (`TunnelConfig`, `TunnelProblem`, `TunnelStatus` imported as types from `./tunnel.ts`.)

**Rules:**
- Cookie text: `__Host-board-login=<token>; Path=/; Max-Age=<maxAgeS>; Secure; HttpOnly; SameSite=Strict`; clearing: `__Host-board-login=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`.
- `lockWaitMs(n)`: 0 below 5; `min(3_600_000, 60_000 * 2 ** (n - 5))` from 5.
- `RATES`: password `{ perAddress: 10, overall: 30, windowMs: 60_000 }`, passkey `{ 20, 60, 60_000 }`, open `{ 120, 600, 60_000 }`. `take` refuses without recording; `retryAfterS = max(1, ceil((oldest + windowMs - now) / 1000))` of the window that is full.
- `deviceLabel`: browser by `/Edg(A|iOS)?\//` Edge, `/Firefox\/|FxiOS\//` Firefox, `/SamsungBrowser\//` Samsung Internet, `/Chrome\/|CriOS\//` Chrome, `/Safari\//` Safari; system by `/iPhone/` iPhone, `/iPad/` iPad, `/Android/` Android, `/Windows/` Windows, `/Mac OS X|Macintosh/` Mac, `/CrOS/` ChromeOS, `/Linux/` Linux. `"<browser> on <system>"`, else whichever is known, else `A browser`. Not translated: it is stored.
- `forwardedAddress`: the last comma-separated entry, trimmed, `::ffff:` removed, kept only when it is an IPv4 or IPv6 address.
- New key: `access.err.password` en `A password has at least 12 characters`.

- [ ] **Step 1: Write the failing tests.**
  `test/core/totp.test.ts`:
```ts
import { expect, test } from 'bun:test'
import { qrMatrix } from '../../src/core/qr.ts'
import { base32, base32Bytes, totpCode, totpMatch, totpStep, totpUri } from '../../src/core/totp.ts'

const RFC = new TextEncoder().encode('12345678901234567890')
const B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

test('RFC 6238 Appendix B, SHA-1, 8 digits; 6 digits are their last six', () => {
  const vectors: [number, string][] = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ]
  for (const [s, code] of vectors) {
    expect(totpCode(RFC, totpStep(s * 1000), 8)).toBe(code)
    expect(totpCode(RFC, totpStep(s * 1000))).toBe(code.slice(2))
  }
})
test('base32 both ways', () => {
  expect(base32(RFC)).toBe(B32)
  expect(base32Bytes(` ${B32.toLowerCase().slice(0, 16)} ${B32.slice(16)}`)).toEqual(RFC)
  expect(base32Bytes('GEZ1')).toBeNull()
})
test('one step of drift either way, never a step already used', () => {
  const now = 1111111111_000
  const step = totpStep(now)
  const code = (s: number) => totpCode(RFC, s)
  for (const s of [step - 1, step, step + 1]) expect(totpMatch(RFC, code(s), now, 0)).toBe(s)
  for (const s of [step - 2, step + 2]) expect(totpMatch(RFC, code(s), now, 0)).toBeNull()
  expect(totpMatch(RFC, code(step), now, step)).toBeNull()
  expect(totpMatch(RFC, code(step + 1), now, step)).toBe(step + 1)
  expect(totpMatch(RFC, ` ${code(step).slice(0, 3)} ${code(step).slice(3)} `, now, 0)).toBe(step)
  for (const bad of ['abcdef', '12345', 123456, null, '1234567']) expect(totpMatch(RFC, bad, now, 0)).toBeNull()
})
test('the URI fits a QR code, the domain in its label while it fits', () => {
  const uri = totpUri(B32, 'board.example.com')
  expect(uri).toBe(`otpauth://totp/Agent%20board%3Aboard.example.com?secret=${B32}&issuer=Agent%20board&algorithm=SHA1&digits=6&period=30`)
  const long = totpUri(B32, `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example.com`)
  expect(long).toBe(`otpauth://totp/Agent%20board?secret=${B32}&issuer=Agent%20board&algorithm=SHA1&digits=6&period=30`)
  for (const u of [uri, long]) expect(() => qrMatrix(u)).not.toThrow()
})
```
  `test/core/access.test.ts`: the cookie texts exactly (a 43-character token, `Max-Age=2592000`); `loginToken('a=1; __Host-board-login=<tok>; __Host-board=x')` → the token, a 42-character one → null, only `__Host-board=<43 chars>` → null; `passwordProblem('x'.repeat(11))` → `'A password has at least 12 characters'`, 12 → null, `42` → the message; `lockWaitMs` of `[0, 4, 5, 6, 7, 10, 11, 20]` → `[0, 0, 60000, 120000, 240000, 1920000, 3600000, 3600000]`; `RateLimiter({ perAddress: 2, overall: 3, windowMs: 60000 })`: `a@0` ok, `a@1` ok, `a@2` → `{ ok: false, retryAfterS: 60 }`, `b@3` ok, `c@4` → `{ ok: false, retryAfterS: 60 }`, `a@60001` ok; `deviceLabel` for these User-Agents:
  - `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1` → `Safari on iPhone`
  - `Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1` → `Safari on iPad`
  - `Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36` → `Chrome on Android`
  - `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0` → `Edge on Windows`
  - `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15` → `Safari on Mac`
  - `Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0` → `Firefox on Linux`
  - `''`, `null`, `curl/8.0` → `A browser`

  `forwardedAddress`: `'203.0.113.9'` → same; `'198.51.100.1, 203.0.113.9'` → `'203.0.113.9'`; `'::ffff:203.0.113.9'` → `'203.0.113.9'`; `'2001:db8::5'` → same; `''`, `null`, `'evil'` → `''`. And `src/core/access.ts` has no `from 'node:`.
- [ ] **Step 2: Run** `bun test test/core/totp.test.ts test/core/access.test.ts`. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement** both modules and the key.
- [ ] **Step 4: Run** them: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/core/totp.ts src/core/access.ts src/core/i18n/access-strings.ts test/core/totp.test.ts test/core/access.test.ts
git commit -m "Add TOTP codes and the login's rules: its cookie, lockout waits, rate limits and device labels"
```

---

### Task 5: Passkeys' data and signatures (core), with a software authenticator for the tests

**Spec:** "Passkeys (WebAuthn)" (relying party, UV, discoverable, attestation `none`, ES256 and RS256, the counter), "Left to the builder" (Libraries), "Testing" (the WebAuthn checks), Calls 3, 20.

**Files:**
- Create: `src/core/webauthn.ts` (may use `node:crypto`), `test/support/soft-authenticator.ts`
- Test: `test/core/webauthn.test.ts`

**Interfaces:**
- Produces (`src/core/webauthn.ts`):
  ```ts
  export type Alg = -7 | -257
  export const b64url: { encode(bytes: Uint8Array): string; decode(text: string): Uint8Array | null }
  /** The CBOR the board reads: maps (as Map), arrays, byte and text strings, unsigned and negative integers, true, false, null. Throws on anything else and on trailing bytes. */
  export function decodeCbor(bytes: Uint8Array): unknown
  export interface AuthData { rpIdHash: Uint8Array; up: boolean; uv: boolean; counter: number; credential: { aaguid: string; id: Uint8Array; key: Map<unknown, unknown> } | null }
  export function parseAuthData(bytes: Uint8Array): AuthData
  /** EC2 P-256 (kty 2, crv 1, -2 x, -3 y) with alg -7, or RSA (kty 3, -1 n, -2 e) with alg -257; null for anything else. */
  export function coseKey(key: Map<unknown, unknown>): { alg: Alg; jwk: JsonWebKey } | null
  export interface Expect { challenge: string; origin: string; rpId: string }
  export type WhyNot = 'shape' | 'type' | 'challenge' | 'origin' | 'rpId' | 'presence' | 'verification' | 'algorithm' | 'signature' | 'counter' | 'user'
  export type Checked<T> = ({ ok: true } & T) | { ok: false; why: WhyNot }
  export function verifyRegistration(r: { clientDataJSON: string; attestationObject: string }, e: Expect):
    Checked<{ credential: { id: string; jwk: JsonWebKey; alg: Alg; counter: number; aaguid: string } }>
  export function verifyAssertion(
    a: { id: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null },
    e: Expect,
    stored: { jwk: JsonWebKey; alg: Alg; counter: number; userId: string },
  ): Checked<{ counter: number }>
  ```
  (All inputs are base64url, as the page sends them.)
- Produces (`test/support/soft-authenticator.ts`): its own minimal CBOR encoder and signer, independent of `src/core/webauthn.ts`:
  ```ts
  export interface SoftAuthenticator {
    id: string   // base64url credential id
    register(o: { challenge: string; origin: string; rpId: string; uv?: boolean; up?: boolean; type?: string; counter?: number }):
      { id: string; rawId: string; response: { clientDataJSON: string; attestationObject: string } }
    assert(o: { challenge: string; origin: string; rpId: string; uv?: boolean; up?: boolean; counter?: number; userHandle?: string; type?: string }):
      { id: string; rawId: string; response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null } }
  }
  export function softAuthenticator(alg: -7 | -257 | -8): Promise<SoftAuthenticator>   // -8: an Ed25519 key, for the 'algorithm' refusal
  ```
  ES256 signatures DER-encoded (WebCrypto signs raw r‖s: convert), attestation `fmt: 'none'`, `attStmt: {}`, flags UP 0x01, UV 0x04, AT 0x40, aaguid of zeros.

**Rules:** `clientDataJSON.type` is `webauthn.create` (registration) or `webauthn.get`; `challenge` and `origin` equal the expected ones; `rpIdHash` is SHA-256 of `rpId`; UP and UV set; registration has a credential with an allowed algorithm; any `fmt` is accepted and `attStmt` ignored. The signature is over `authData ‖ SHA-256(clientDataJSON)`, ES256 with `dsaEncoding: 'der'`, RS256 PKCS#1 v1.5 SHA-256. Counter: when the stored or the new one is not 0, the new one must be greater. `userHandle`, when given, must equal `stored.userId`.

- [ ] **Step 1: Write the failing test** `test/core/webauthn.test.ts`, for ES256 and RS256 each (`describe.each([-7, -257])`), with `E = { challenge: 'Y2hhbGxlbmdl', origin: 'https://board.example.com', rpId: 'board.example.com' }`:
  - a registration verifies; its `credential.id` is the authenticator's id; `alg` its own; an assertion with that credential verifies and gives its counter;
  - registration refused: another origin → `origin`; another rpId → `rpId`; another challenge → `challenge`; `type: 'webauthn.get'` → `type`; `uv: false` → `verification`; `up: false` → `presence`;
  - assertion refused the same ways, plus a flipped signature byte → `signature`, `userHandle` of another user → `user`, stored counter 5 and new 3 → `counter`; stored 0 and new 0 → ok; stored 0 and new 7 → ok, `counter: 7`;
  - an Ed25519 authenticator's registration → `algorithm`;
  - `decodeCbor` reads a map with negative keys, nested arrays and byte strings; throws on trailing bytes; `b64url` round-trips bytes `[0xfb, 0xff, 0x00]` to `-_8A` and back, with no padding, and `decode('***')` is null.
- [ ] **Step 2: Run** `bun test test/core/webauthn.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/core/webauthn.ts` and the software authenticator.
- [ ] **Step 4: Run** it: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/core/webauthn.ts test/support/soft-authenticator.ts test/core/webauthn.test.ts
git commit -m "Read and verify passkey registrations and sign-ins (ES256, RS256) without a library"
```

---

### Task 6: The board's own files (core and adapter)

**Spec:** "The board's own files" (which folders, the `uploads` exception, "How a path is compared"), Call 30, "Testing" (the board's-own-files check).

**Files:**
- Create: `src/core/own-files.ts`, `src/adapters/own-files.ts`
- Test: `test/core/own-files.test.ts`, `test/adapters/own-files.test.ts`

**Interfaces:**
- Consumes: `stateDir`, `configDir`, `uploadsDir` (`adapters/paths.ts`); `tunnelConfig` (Task 2).
- Produces:
  ```ts
  // core/own-files.ts
  export interface OwnFolders { refused: string[]; allowed: string[] }   // real paths
  /** Windows: a UNC or device path (\\x\y, //x/y, \\?\…, \\.\…), or a ':' past the drive letter (an NTFS stream). */
  export function oddWindowsPath(path: string): boolean
  /** `path` is `folder` or inside it: whole segments only, case ignored on win32 and darwin, both separators on win32. */
  export function underFolder(path: string, folder: string, platform: string): boolean
  /** Under an allowed folder: no; under a refused one: yes. */
  export function isOwnFile(realPath: string, folders: OwnFolders, platform: string): boolean
  // adapters/own-files.ts
  /** refused: real stateDir(), configDir(), and the key's folder when tunnel.key is set and outside stateDir(); allowed: real uploadsDir(). A folder not made yet counts by its resolved path. */
  export function ownFolders(cfg: Config): OwnFolders
  /** realpathSync.native of the path, or of its nearest existing parent with the rest joined back. */
  export function realOrNearest(path: string): string
  export function ownFileCheck(cfg: Config, platform?: string): (target: string) => boolean
  ```

**Rules:** `ownFileCheck` returns true for `oddWindowsPath` on win32 before anything else; otherwise `isOwnFile(realOrNearest(target), ownFolders(cfg), platform)`. Folders are read at each call (the config can change). If the 8.3 test below shows `realpathSync.native` keeps a short name, add a second comparison: the `(dev, ino)` of each existing ancestor of the target against each folder's (`statSync(…, { bigint: true })`), and say so in the report.

- [ ] **Step 1: Write the failing tests.**
  `test/core/own-files.test.ts` (literal paths, both platforms): `C:\s\agent-board\access.json` under `C:\s\agent-board` on win32, also as `c:/S/AGENT-BOARD/access.json`; not on linux for `/S/x` vs `/s`; the folder itself counts; `C:\s\agent-board-2\x` and `/s/agent-board2/x` do not (whole segments); `isOwnFile` refuses under state, allows under `uploads` inside it; `oddWindowsPath` true for `\\localhost\C$\x`, `//localhost/C$/x`, `\\?\C:\x`, `\\.\C:\x`, `C:\a\b.txt:secret`, `C:\a\b.txt::$DATA`; false for `C:\a\b.txt`, `C:/a/b`.
  `test/adapters/own-files.test.ts` (`isolatedHome()`, folders made under it):
  - `<state>/access.json`, `<state>` itself, `<config>/config.json`, a missing `<state>/nope/x.txt` → own; `<state>/uploads/2026-10-20/a.png` → not; `<state>/uploads/../access.json` (resolved) → own;
  - a folder `<home>/x` (not own); the key's folder: with `tunnel.key = <home>/keys/k`, `<home>/keys/other` → own; with the key inside the state folder, nothing more is refused;
  - a link into the state folder: `symlinkSync(<state>, <home>/link, 'junction')` on Windows (no admin needed), a symlink elsewhere (`test.skipIf(!canSymlink)` from `test/support/fs.ts` off Windows) → `<home>/link/access.json` own;
  - Windows only (`test.skipIf(process.platform !== 'win32')`): the state path in other case → own; its 8.3 short name (from `cmd.exe /d /c for %I in ("<path>") do @echo %~sI`, run without a shell by spawning `cmd.exe` with that argument list) → own, skipped when the volume gives no short name; `\\localhost\C$\…` of the state folder → own.
- [ ] **Step 2: Run** `bun test test/core/own-files.test.ts test/adapters/own-files.test.ts`. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement** both.
- [ ] **Step 4: Run** them: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/core/own-files.ts src/adapters/own-files.ts test/core/own-files.test.ts test/adapters/own-files.test.ts
git commit -m "Tell whether a path is one of the board's own files, by its real path, whatever its spelling"
```

---

### Task 7: The login service: password, TOTP, logins, lockout, rate limits and failed attempts

**Spec:** "Login" (all of it but Passkeys), "Settings and where they live" (secrets, `0o600`, what never leaves), "Recovery", Calls 1, 4, 17, 18, 19, 25, 26.

**Files:**
- Create: `src/adapters/access-store.ts`, `src/services/access.ts`
- Modify: `src/core/i18n/access-strings.ts`
- Test: `test/adapters/access-store.test.ts`, `test/services/access.test.ts`

**Interfaces:**
- Consumes: Task 4 (`totpMatch`, `totpUri`, `base32`, `base32Bytes`, `loginCookie`, `passwordProblem`, `lockWaitMs`, `RATES`, `RateLimiter`, `Login`, `Attempt`, …); `hashToken` (`services/remote.ts`); `isRecord`, `readJson`, `updateJson` (`adapters/json-store.ts`); `stateDir`.
- Produces:
  ```ts
  // adapters/access-store.ts — every write: mkdirSync(stateDir()), updateJson(…, { mode: 0o600 }), unknown fields kept
  export const accessFile = (): string => join(stateDir(), 'access.json')   // also passkeysFile, loginsFile, attemptsFile
  export interface AccessSecrets { passwordHash: string | null; totp: { secret: string; lastStep: number } | null; userId: string | null; lockout: { failures: number; until: number | null } }
  export function readSecrets(): AccessSecrets
  export function updateSecrets(change: (s: AccessSecrets) => AccessSecrets): AccessSecrets
  export function readLogins(): Login[]
  export function updateLogins(change: (list: Login[]) => Login[]): Login[]
  export function readPasskeys(): Passkey[]
  export function updatePasskeys(change: (list: Passkey[]) => Passkey[]): Passkey[]
  export function readAttempts(): Attempt[]
  export function addAttempt(a: Attempt): void          // keeps the 100 newest
  /** Password and TOTP are set up (what `board tunnel on` asks). */
  export function accessReady(): boolean
  // services/access.ts
  export interface Who { address: string; userAgent: string | null }
  export type SignIn =
    | { ok: true; token: string; maxAgeS: number; login: PublicLogin }
    | { ok: false; status: 401 | 423 | 429; error: 'wrong' | 'locked' | 'limited'; retryAfterS?: number; until?: number }
  export interface Access {
    ready(): boolean
    setPassword(password: unknown): Promise<EditResult>
    beginTotp(domain: string): { secret: string; uri: string }
    confirmTotp(code: unknown): EditResult
    signInPassword(body: { password?: unknown; code?: unknown }, who: Who): Promise<SignIn>
    verify(token: string): Login | null
    end(id: string): boolean
    endAll(): void
    endToken(token: string): boolean
    watch(id: string, gone: () => void): () => void
    liftLockout(): void
    rate(kind: 'open' | 'password' | 'passkey', address: string): { ok: true } | { ok: false; retryAfterS: number }
    view(): AccessView['login'] & Pick<AccessView, 'logins' | 'attempts'>
  }
  export function createAccess(o: { onChange: () => void; now?: () => number; random?: (n: number) => Uint8Array }): Access
  ```
  (`EditResult` from `adapters/config-file.ts`.)

**Rules:**
- `setPassword`: `passwordProblem` first; `Bun.password.hash` (argon2id); ends every login.
- `beginTotp`: 20 random bytes, kept in memory 10 min (a new begin replaces it); returns `base32` and `totpUri`. `confirmTotp`: no pending one → `{ ok: false, error: t('access.err.noTotp') }`; a wrong code → `t('access.err.code')`, nothing saved; right → saved with `lastStep` the matched step, pending dropped, every login ended.
- `signInPassword`, in order: `rate('password', who.address)` refused → 429 `limited` (attempt recorded); locked (`lockout.until > now`) → 423 `locked` with `until` (attempt recorded); then **both** the hash check (always run, also when the code is wrong) and `totpMatch`; success needs both: `lastStep` saved, lockout cleared, a login made; otherwise `failures + 1`, `until = now + lockWaitMs(failures)` when that is not 0, 401 `wrong` (attempt recorded). The failed code's step is not used up.
- A login: token 32 random bytes base64url; the file keeps `hashToken(token)` only; `expiresAt = signedInAt + LOGIN_MS`; `maxAgeS = round((expiresAt - now) / 1000)`; `label = deviceLabel(userAgent)`; `address = who.address`.
- `verify`: expired ones are dropped from the file when it is read; `seenAt` written at most once a minute.
- `end`, `endAll`, `endToken` (sign out), `setPassword`, `confirmTotp` call the watchers of each ended login (as `createRemote` does) and `onChange`.
- `view()`: no hash, no secret, no token hash; attempts newest first, 20 of them.
- Every change calls `onChange`.
- New keys: `access.err.noTotp` en `Set up the code first: it expired, or was never asked for`; `access.err.code` en `That code is not the one the app shows now`.

- [ ] **Step 1: Write the failing tests.**
  `test/adapters/access-store.test.ts` (`isolatedHome()`): written files are `0o600` (POSIX only, `statSync().mode & 0o777`); a hand-added field in `access.json` survives `updateSecrets`; a broken file reads as the defaults; `addAttempt` keeps 100; `accessReady()` false until both a hash and a TOTP are there.
  `test/services/access.test.ts` (`isolatedHome()`, `now` a variable the test moves, the RFC secret through a `random` that returns it for the TOTP):
  - not ready until both; a 11-character password → `{ ok: false, error: 'A password has at least 12 characters' }`; the stored hash starts `$argon2id$`; neither the password nor the base32 secret appears in `readFileSync` of any of the four files, nor in `JSON.stringify(access.view())`;
  - TOTP: wrong code → error, `readSecrets().totp` null; right code → saved; a begin 10 min + 1 ms old → `noTotp`;
  - sign in: a 43-character token; the logins file holds `hashToken(token)` and not the token; `maxAgeS` 2592000; label from the User-Agent; address from `who`;
  - wrong password with the right code, and right password with a wrong code: the same `{ ok: false, status: 401, error: 'wrong' }`; afterwards the right pair with that same code works (the failed attempt used no step); the same code again → `wrong` (replay);
  - 30 days + 1 ms later `verify` → null and the login is gone from the file; `seenAt` written once within a minute, again after it;
  - lockout: 4 failures → 401; the 5th → 401 and locked for 60 s; next → 423 with `until`, recorded `locked`; 61 s later one more failure → locked 120 s; a success clears it; `liftLockout` clears it; the wait never passes 1 h;
  - rate: 10 password sign-ins from one address within a minute, the 11th → 429 `limited` with `retryAfterS`, recorded `limited`; another address goes on; `rate('passkey', …)` is unaffected;
  - `end`, `endAll`, `endToken`, a new password and a new TOTP each end logins: `verify` null and a `watch` callback called once;
  - `onChange` is called on every change.
- [ ] **Step 2: Run** `bun test test/adapters/access-store.test.ts test/services/access.test.ts`. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement** the store, the service and the keys.
- [ ] **Step 4: Run** them: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/adapters/access-store.ts src/services/access.ts src/core/i18n/access-strings.ts test/adapters/access-store.test.ts test/services/access.test.ts
git commit -m "Keep the board's login: a password and a TOTP code checked together, 30-day logins, a lockout and rate limits"
```

---

### Task 8: Passkeys in the login service

**Spec:** "Passkeys (WebAuthn)" (all of it), "Lockout and rate limits" (passkey sign-in never locked, its own counters), "Changing the domain", Calls 20–23, 34, 35.

**Files:**
- Modify: `src/services/access.ts`
- Test: `test/services/access-passkeys.test.ts`

**Interfaces:**
- Consumes: Task 5 (`verifyRegistration`, `verifyAssertion`, `b64url`), Task 7 (`Access`, store), `softAuthenticator` (test).
- Produces (added to `Access`):
  ```ts
  passkeyLoginOptions(rpId: string): { challenge: string; rpId: string; timeout: number; userVerification: 'required' }
  /** Never locked out; any failure is 401 'wrong'. Rate: rate('passkey', …). */
  signInPasskey(body: unknown, expect: { origin: string; rpId: string }, who: Who): Promise<SignIn>
  /** A fresh TOTP code (later than the last used step), for the login asking. */
  passkeyAddOptions(loginId: string, code: unknown, rp: { id: string }): { ok: true; options: CreationOptions } | { ok: false; status: 403; error: 'code' }
  addPasskey(loginId: string, body: unknown, expect: { origin: string; rpId: string }, userAgent: string | null): { ok: true; id: string } | { ok: false; error: string }
  removePasskey(id: string): boolean        // ends the logins made with it
  domainChanged(): void                      // removes every passkey, ends every login
  hasPasskeysOrLogins(): boolean
  export interface CreationOptions {
    challenge: string; rp: { id: string; name: 'Agent board' }; user: { id: string; name: 'owner'; displayName: 'Agent board' }
    pubKeyCredParams: { type: 'public-key'; alg: -7 | -257 }[]
    authenticatorSelection: { residentKey: 'required'; requireResidentKey: true; userVerification: 'required' }
    attestation: 'none'; excludeCredentials: { type: 'public-key'; id: string }[]; timeout: number
  }
  ```

**Rules:** challenges: 32 random bytes base64url, single use, 2 min, at most 50 (the oldest dropped), each `{ kind: 'login' }` or `{ kind: 'add'; loginId }`; an add challenge works only for its login. The WebAuthn user id: 16 random bytes, made once, kept in `access.json`. A passkey sign-in: the credential by id, `verifyAssertion`, then `counter` and `usedAt` saved; a failure is an attempt with method `passkey`, reason `wrong`, and does not count toward the lockout. `pubKeyCredParams` order: -7, -257. `timeout` 120000. A passkey's label: `deviceLabel(userAgent)`. A passkey sign-in's login has `method: 'passkey'` and `passkeyId`.

- [ ] **Step 1: Write the failing test** `test/services/access-passkeys.test.ts` (`isolatedHome()`, ES256 soft authenticator, `RP = { origin: 'https://board.example.com', rpId: 'board.example.com' }`, a moving `now`):
  - the code a password sign-in used → `passkeyAddOptions` 403 `code`; the next step's code (now + 30 s) → options with `excludeCredentials` empty; `addPasskey` with the authenticator's registration of that challenge → ok; listed in `view().passkeys` with label, `addedAt`, `usedAt: null`; a second add's options exclude it;
  - `passkeyLoginOptions` → `signInPasskey` with the authenticator's assertion → ok, `method: 'passkey'`, `passkeyId`; `usedAt` and the counter saved;
  - the same challenge again → 401; a challenge 2 min + 1 ms old → 401; an add challenge used to sign in → 401; one login's add challenge used by another login → refused; the 51st challenge drops the first;
  - an assertion with a lower counter → 401; a wrong origin → 401;
  - password locked out (5 failures) and its rate full: `signInPasskey` still ok; a failed passkey sign-in is recorded (`method: 'passkey'`, `wrong`) and the lockout's failure count is unchanged;
  - `removePasskey` ends the logins made with it and not a password login; `domainChanged` removes every passkey and ends every login; `hasPasskeysOrLogins` follows;
  - the user id is the same across two `createAccess` calls (it is in `access.json`).
- [ ] **Step 2: Run** `bun test test/services/access-passkeys.test.ts`. Expected: FAIL (`passkeyLoginOptions` is not a function).
- [ ] **Step 3: Implement** the passkey methods.
- [ ] **Step 4: Run** it, and `test/services/access.test.ts`: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/services/access.ts test/services/access-passkeys.test.ts
git commit -m "Sign in with a passkey, add one on the device with a fresh code, and end its logins when it is removed"
```

---

### Task 9: ssh on this computer: the binary, the key, the server's key and the pid record (adapters), with a fake ssh

**Spec:** "Which ssh", "What it runs" (no shell), "Generate key" (Ed25519, comment, Windows ACL by SID), "The server's host key", "Board restarts and overlap" (pid record, stray ssh, `killTree`), "Constraints" (fake binaries), Calls 7, 8, 9. Read Task 1's results in the spec first.

**Files:**
- Create: `src/adapters/ssh.ts`, `test/support/fake-ssh.ts`, `test/support/fake-ssh-bin.ts`
- Modify: `src/adapters/process.ts` (export `killTreePid`; `killTree` uses it), `test/support/fake-herdr-bin.ts` (export `compileFake(source: string, name: string): Promise<string>`; `fakeHerdrBin` uses it), `test/support/sandbox.ts` (env `BOARD_SSH_BIN_PATH: join(dir, 'no-ssh.exe')`, `BOARD_SSH_KEYGEN_BIN_PATH: join(dir, 'no-ssh-keygen.exe')`)
- Test: `test/adapters/ssh.test.ts`

**Interfaces:**
- Consumes: `TunnelConfig`, `TunnelHint`, `sshHint` (Task 2); `stateDir`; `readJson`, `updateJson`.
- Produces:
  ```ts
  // adapters/process.ts
  export function killTreePid(pid: number): void     // taskkill /T /F /PID by full path on win32; process.kill(-pid), else pid, on POSIX
  // adapters/ssh.ts
  export interface BinOptions { env?: Record<string, string | undefined>; platform?: string; exists?: (p: string) => boolean; onPath?: (name: string) => string | null }
  export function sshBin(o?: BinOptions): string | null        // BOARD_SSH_BIN_PATH; win32: %SystemRoot%\System32\OpenSSH\ssh.exe when it exists, then PATH; else PATH
  export function sshKeygenBin(o?: BinOptions): string | null  // the same with BOARD_SSH_KEYGEN_BIN_PATH and ssh-keygen
  export const tunnelDir = (): string => join(stateDir(), 'tunnel')
  export const generatedKey = (): string => join(tunnelDir(), 'id_ed25519')
  export const knownHostsFile = (): string => join(tunnelDir(), 'known_hosts')
  export const sshPidFile = (): string => join(tunnelDir(), 'ssh-pid.json')
  export const keyPath = (conf: TunnelConfig): string => conf.key || generatedKey()
  export async function generateKey(comment: string): Promise<{ ok: true; publicKey: string } | { ok: false; error: string }>
  export async function protectKey(file: string): Promise<{ ok: true } | { ok: false; error: string }>
  export async function publicKeyOf(key: string): Promise<{ ok: true; publicKey: string } | { ok: false; error: string; hint: TunnelHint | null }>
  export async function hostKeyFingerprint(): Promise<string | null>   // 'SHA256:… (ED25519)'
  export function forgetHostKey(): void
  export interface SshChild { pid: number; onLine(fn: (line: string) => void): void; exited: Promise<{ code: number | null; error: string | null }>; kill(): void; killNow(): void }
  export function spawnSsh(bin: string, args: string[]): SshChild
  export interface PidRecord { pid: number; forward: string; at: number }
  export function readPidRecord(): PidRecord | null
  export function writePidRecord(r: PidRecord | null): void
  export async function commandLineOf(pid: number): Promise<string | null>
  /** Ends a recorded ssh that still runs with this forward (its tree); true when it did. */
  export async function endStraySsh(r: PidRecord): Promise<boolean>
  ```
- Produces (`test/support/fake-ssh-bin.ts`): `fakeSshBin(): Promise<string>` (compiled once per source hash, as the fake herdr is). One executable serves as both ssh and ssh-keygen.

**Rules:**
- `generateKey`: `mkdirSync(tunnelDir())`, removes the old pair, runs `ssh-keygen -q -t ed25519 -N "" -C <comment> -f <generatedKey()>` (an empty `-N` argument, no shell); on win32 then `protectKey`; returns the `.pub` text trimmed. `protectKey` runs on the key the board generated only: a key the owner points to (`tunnel.key`) is used as it is, its rights never changed (Call 8).
- `protectKey` (win32 only; elsewhere `{ ok: true }`): `%SystemRoot%\System32\whoami.exe /user /fo csv /nh` → the SID (the second CSV field), then `%SystemRoot%\System32\icacls.exe <file> /inheritance:r /grant:r *<SID>:F`. Task 1's recipe wins if it differs.
- `publicKeyOf`: `ssh-keygen -y -P "" -f <key>`; on failure the error is its stderr trimmed and `hint = sshHint(lines)`.
- `hostKeyFingerprint`: `ssh-keygen -l -f <knownHostsFile()>`, the first line's `SHA256:…` and its `(TYPE)`; null without the file or on failure.
- `spawnSsh`: `spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })`; stderr split into lines; `kill()` = `killTreePid(pid)`; `killNow()` = synchronous `process.kill(pid)` (for an exit handler); a spawn error resolves `exited` with `error` (`ENOENT`…).
- `commandLineOf`: win32 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=<pid>').CommandLine"` (the pid is a number), linux `/proc/<pid>/cmdline` with NULs as spaces, darwin `/bin/ps -p <pid> -o command=`; null when the process is gone.
- `endStraySsh`: kills only when `commandLineOf(r.pid)` contains `r.forward`.
- **The fake** (`test/support/fake-ssh.ts`): appends its argv as a JSON line to `FAKE_SSH_LOG`; reads `FAKE_SSH_STATE` (a JSON file; missing means `{}`):
  - ssh-keygen shapes: with `-t` it writes `-f`'s pair (private `-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n`, public `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEKEY <the -C comment>\n`); with `-y` it prints the `.pub` next to `-f`, or for `keygen: 'unprotected'` prints `Permissions for '<f>' are too open.` and `UNPROTECTED PRIVATE KEY FILE!` to stderr and exits 1, for `keygen: 'passphrase'` `Load key "<f>": incorrect passphrase supplied to decrypt private key`, exit 1; with `-l` it prints `256 SHA256:FAKEfingerprint ssh.example.com (ED25519)` when `-f` exists, else exits 1;
  - ssh shape (has `-R`): with `StrictHostKeyChecking=accept-new` it appends `ssh.example.com ssh-ed25519 AAAAFAKEHOST` to the quoted `UserKnownHostsFile` when absent; then by `ssh.mode` (or `ssh.seq`, one mode per call in turn, the last repeating, counted in a file beside the state): `forward` prints `debug1: Authenticated to ssh.example.com ([203.0.113.5]:22) using "publickey".` and `debug1: remote forward success for: listen <socket>:-2, connect 127.0.0.1:<port>` (Task 1's line if it differs) and stays up until killed or `ssh.exitAfterMs`; `refuse` prints `Error: remote port forwarding failed for listen path <socket>`, exits 255; `publickey` prints `boardtunnel@ssh.example.com: Permission denied (publickey).`, exits 255; `hostkey` prints `Host key verification failed.`, exits 255; `hang` stays up silent. No state: `forward`.

- [ ] **Step 1: Write the failing test** `test/adapters/ssh.test.ts`:
  - `sshBin`: the env path first; on win32 the System32 path when `exists` says so, else `onPath('ssh')`; null when nothing; the same for `sshKeygenBin`;
  - with `isolatedHome()` and `process.env.BOARD_SSH_KEYGEN_BIN_PATH = await fakeSshBin()` (restored after): `generateKey('agent-board@PC')` → both files, the public key ends with `agent-board@PC`; again → replaced (no prompt); `publicKeyOf(generatedKey())` → the public key; with `keygen: 'unprotected'` → `{ ok: false, hint: 'keyPermissions' }`; `hostKeyFingerprint()` null, then with a `known_hosts` → `SHA256:FAKEfingerprint (ED25519)`; `forgetHostKey()` → null again;
  - Windows only: after `generateKey`, `icacls <key>` (real) lists the current user and none of `BUILTIN\Users`, `Everyone`, `Authenticated Users`; `protectKey` on a file in a folder granting `*S-1-5-32-545:(OI)(CI)R` (made with real `icacls`) → the same;
  - `spawnSsh(fake, sshArgs(...))` with a key path in a folder named `a b%c Иван` → the fake's log line holds `-i` and `UserKnownHostsFile` as single arguments; lines include the success line; `kill()` → `exited` resolves;
  - `endStraySsh`: a running fake ssh with `-R <socket>:127.0.0.1:12999` → true and gone; a running `bun -e "setInterval(() => {}, 1000)"` recorded with the same forward → false and still alive (then killed by the test); a pid that is not running → false;
  - `readPidRecord`/`writePidRecord` round-trip; `writePidRecord(null)` removes the file.
- [ ] **Step 2: Run** `bun test test/adapters/ssh.test.ts`. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement** `killTreePid`, `compileFake`, the sandbox env defaults, the fake and `src/adapters/ssh.ts`.
- [ ] **Step 4: Run** it, then `bun test test/adapters/process.test.ts test/support/sandbox.test.ts`: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/adapters/ssh.ts src/adapters/process.ts test/support/fake-ssh.ts test/support/fake-ssh-bin.ts test/support/fake-herdr-bin.ts test/support/sandbox.ts test/adapters/ssh.test.ts
git commit -m "Find Windows' own ssh, make the tunnel's key only its owner can read, pin the server's key and end a stray ssh"
```

---

### Task 10: The tunnel supervisor: ssh kept up, its status, backoff, sleep, network changes and the pid record

**Spec:** "Status", "Coming back" (backoff, lasting errors, sleep, network change), "Board restarts and overlap" (one owner, a stray ssh, never two), Call 9; Task 1's results (the success line; whether ssh exits on a refused forward).

**Files:**
- Create: `src/services/tunnel.ts`
- Test: `test/services/tunnel.test.ts`

**Interfaces:**
- Consumes: Task 2 (`forwardAccepted`, `sshHint`, `isLasting`, `backoffMs`, `TunnelStatus`, `TunnelConfig`); Task 9 (`SshChild`, `PidRecord`).
- Produces:
  ```ts
  export interface TunnelPlan { conf: TunnelConfig; bin: string; args: string[]; forward: string }
  export interface Clock { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void; setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void }
  export const realClock: Clock
  export interface SupervisorDeps {
    /** What to run now; null: no tunnel (off, a problem, no login set up, the listener not listening). */
    plan(): TunnelPlan | null
    spawn(bin: string, args: string[]): SshChild
    stray: { read(): PidRecord | null; write(r: PidRecord | null): void; end(r: PidRecord): Promise<boolean> }
    clock: Clock
    /** A signature of this computer's addresses (os.networkInterfaces(), non-internal, sorted). */
    network(): string
    random?: () => number
    onChange(): void
    log(text: string): void
  }
  export interface Supervisor {
    sync(): Promise<void>
    status(): TunnelStatus
    /** ssh runs (held by the supervisor). */
    running(): boolean
    /** For an exit handler: the current ssh ended synchronously. */
    killNow(): void
    close(): Promise<void>
  }
  export function createSupervisor(d: SupervisorDeps): Supervisor
  export function networkSignature(): string   // the production network()
  ```

**Rules:**
- `sync()` runs one at a time (as `server/remote.ts` does). Plan null → kill (tree), wait for the exit, clear the record, state `off`. A plan while nothing runs → the record first: one there is passed to `stray.end` (awaited) and cleared; then spawn, write `{ pid, forward, at }`, state `connecting`. A plan whose `args` differ from the running one → kill, wait for the exit, spawn at once (attempt 1).
- A line where `forwardAccepted` → `connected` (since now). Lines not starting with `debug` go into a ring of the last 20.
- An exit not asked for: `hint = sshHint(ring)` (`noSsh` for a spawn error); up ≥ 60 s → attempt back to 1. Lasting → `error` with `error` (the ring's last lines joined by `\n`, at most 400 characters), `hint`, `nextAt = now + 60_000`. Otherwise `reconnecting` with `attempt`, `nextAt = now + backoffMs(attempt, random)`, `error`, `hint`; then attempt + 1. If Task 1 found that ssh does not exit on a refused forward: a `listenPath` line ends ssh at once.
- A tick every 5 s: more than 30 s since the last → ssh restarted at once. A network poll every 10 s: another signature → ssh restarted at once. Both only while a plan is set.
- Never two: a new ssh is spawned only after the previous one's `exited` resolved.
- `onChange` on every status change.

- [ ] **Step 1: Write the failing test** `test/services/tunnel.test.ts` with a fake clock (`advance(ms)` runs due timers in order), a fake `SshChild` (`line(text)`, `exit(code)`, records `kill` calls; `exited` resolves on `exit` or after `kill`), a spawn that records `(bin, args)`, an in-memory record and `random: () => 0.5`:
  - connect: one spawn with the plan's args; `connecting`; the success line → `connected`, `since` now; the record is `{ pid, forward, at }`;
  - exits: waits of 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000 between spawns, `reconnecting` with `attempt` and `nextAt` each time;
  - up 61 s, then an exit → the next wait is 1000 again;
  - `Error: remote port forwarding failed for listen path /var/lib/boardtunnel/board.sock` then exit 255 → `error`, hint `listenPath`, `nextAt = now + 60000`; 60 s later a spawn that succeeds → `connected`;
  - `Permission denied (publickey).` → `error`, `publickey`, retried every 60 s; a spawn error `ENOENT` → `error`, `noSsh`;
  - sleep: connected, then the clock jumps 10 min without ticks → at the next tick the child is killed and a new one spawned without waiting;
  - network: `network()` returns another signature → at the next poll a restart;
  - a stray: the record holds `{ pid: 4242, forward }` → `stray.end` called with it before the first spawn; `end` resolving false (another program) → spawn anyway, record overwritten;
  - off: the plan becomes null and `sync()` → `kill` called, `off`, record null; `killNow()` calls the child's `killNow`;
  - never two: two `sync()` at once → one spawn; a changed plan → the second spawn only after the first child's `exited`.
- [ ] **Step 2: Run** `bun test test/services/tunnel.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/services/tunnel.ts`.
- [ ] **Step 4: Run** it: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/services/tunnel.ts test/services/tunnel.test.ts
git commit -m "Keep the tunnel's ssh up: say how it stands, back off, restart after sleep or a network change, and end a stray one"
```

---

### Task 11: Through the domain: the probe and Test connection

**Spec:** "And that the domain reaches this board" (Call 32), "Test connection" (Calls 10, 33, the hints), "Constraints" (sandboxes).

**Files:**
- Create: `src/adapters/probe.ts`, `src/server/tunnel-probe.ts`
- Modify: `src/services/tunnel.ts`, `src/core/i18n/access-strings.ts`
- Test: `test/services/tunnel-test.test.ts`, `test/server/tunnel-probe.test.ts`, `test/adapters/probe.test.ts`

**Interfaces:**
- Consumes: Task 10's supervisor and deps; `ProbeResult`, `TestStep`, `StepHint` (Task 2).
- Produces:
  ```ts
  // services/tunnel.ts
  export interface Probes { issue(): string; answers(nonce: string): boolean }   // 16 random bytes hex; a nonce lives 60 s
  export function createProbes(now?: () => number): Probes
  // SupervisorDeps gains:
  //   probes: Probes
  //   probe(nonce: string): Promise<ProbeResult>                 // through the domain
  //   testPlan(target: number): TunnelPlan | null                 // the same line, forwarded to `target`
  //   checkKey(): Promise<{ ok: true } | { ok: false; error: string; hint: TunnelHint | null }>
  //   sshFound(): string | null
  //   openProbeListener(nonce: string): Promise<{ port: number; close(): void }>
  // Supervisor gains:
  //   test(): Promise<TestStep[]>
  // adapters/probe.ts
  export const probeOrigin = (domain: string, env?: Record<string, string | undefined>): string  // BOARD_TUNNEL_PROBE_ORIGIN or https://<domain>
  export async function fetchProbe(origin: string, nonce: string, timeoutMs?: number): Promise<ProbeResult>
  // server/tunnel-probe.ts
  export function openProbeListener(nonce: string, o?: { closeAfterMs?: number }): Promise<{ port: number; close(): void }>
  ```

**Rules:**
- **The probe route's answer** (here and on the tunnel listener in Task 12): `GET /api/probe/<nonce>` → 200 `{ "board": "agent-board", "probe": "<nonce>" }`. `fetchProbe`: `GET <origin>/api/probe/<nonce>`, `redirect: 'manual'`, timeout 10 s; that body → `{ ok: true }`; another status → `{ ok: false, kind: 'status', status, detail: String(status) }`; 200 with another body → `answer`; an error whose message or code names a certificate, SSL or TLS → `tls`; any other error → `network`.
- **The probe-only listener:** `Bun.serve` on `127.0.0.1`, port 0, the same options as the other listeners (no idle timeout, not development, no port reuse); only `GET /api/probe/<its nonce>` answers; everything else 404 `{ error: 'not found' }`; closes after `closeAfterMs` (30 000) or `close()`.
- **Periodic probe:** 3 s after `connected`, then every 5 min while connected: `probe(probes.issue())` → `status.probe = { ok, at, detail }`; ssh is never restarted over it.
- **`test()`** (one at a time: a second call gets the running one's promise):
  1. `ssh`: `sshFound()` null → ✗ hint `noSsh`; `checkKey()` fails → ✗ with its error and hint; else ✓ with the binary's path. On ✗ the other two are `ok: null`.
  2. `forward`: while the supervisor holds an ssh: ✓ when `connected`, else ✗ with the status's error and hint, and `domain` is null with hint `notConnected`. While it holds none: a nonce, `openProbeListener(nonce)`, `testPlan(port)` (null → ✗ `the settings do not check out`, the listener closed), `spawn` of its line; the success line → ✓; an exit → ✗ with `sshHint`; 25 s → ✗ `timed out`, hint `network`. `killNow()` also ends a running Test's ssh.
  3. `domain`: `probe(nonce)` (for the running tunnel a nonce from `probes.issue()`): ok → ✓; status 502 → ✗ hint `caddy502`; `tls` → hint `tls`; `answer` → hint `answer`; `network` → hint `network`.
  Afterwards the test's ssh is killed and the listener closed, whatever happened.
- **Hint texts** (keys `tunnel.hint.<hint>`, English exact):

  | hint | en |
  |---|---|
  | `publickey` | `The server refused the key: put the authorized_keys line in the keys file on the server, and the sshd Match block in sshd_config.` |
  | `listenPath` | `The server refused the socket: its folder is missing or not the tunnel user's to write, AllowStreamLocalForwarding is not remote, or a stale socket is there and StreamLocalBindUnlink is not yes.` |
  | `keyPermissions` | `ssh refuses the key file for its access rights (UNPROTECTED PRIVATE KEY FILE): only you may read it. Generate key sets that; for a key of your own, fix its rights yourself.` |
  | `hostKey` | `The server's key changed since it was pinned. If you changed the server on purpose, Forget the server's key; otherwise find out why first.` |
  | `network` | `No answer from the server: check the host, the SSH port and the firewall.` |
  | `noSsh` | `No OpenSSH client found. On Windows, add the optional feature "OpenSSH Client".` |
  | `passphrase` | `The key has a passphrase: the tunnel needs a key without one.` |
  | `caddy502` | `Caddy answered 502: its socket path and the board's differ, or Caddy cannot open the socket (the folder's group or setgid bit, StreamLocalBindMask).` |
  | `tls` | `No HTTPS answer: check the domain's DNS record, or Caddy has no certificate yet.` |
  | `answer` | `Something else answers on the domain, not this board.` |
  | `notConnected` | `The tunnel is not connected now.` |

- [ ] **Step 1: Write the failing tests.**
  `test/services/tunnel-test.test.ts` (Task 10's fakes plus fake `probe`, `checkKey`, `sshFound`, `openProbeListener` recording opens and closes):
  - periodic: connected → after 3 s `probe` called with a nonce `probes.answers()` accepts; a `{ ok: false, kind: 'status', status: 502, detail: '502' }` → `status().probe` `{ ok: false, … }`, state still `connected`, spawn count unchanged; 5 min later probed again;
  - Test while on and connected: no spawn, no listener; three ✓;
  - Test while on and `reconnecting`: `forward` ✗ with the status's hint, `domain` `{ ok: null, hint: 'notConnected' }`;
  - Test while off: a listener opened, one spawn with `testPlan(port)`'s args; the success line → probe → three ✓; then the test's child killed and the listener closed;
  - Test while off, ssh exits on `listenPath` → `forward` ✗ `listenPath`, `domain` null, child gone, listener closed; ssh silent for 25 s → `forward` ✗ `timed out`, killed;
  - `sshFound()` null → `ssh` ✗ `noSsh`, the rest null, nothing spawned; `checkKey` `keyPermissions` → the same with that hint;
  - a 502 → `domain` ✗ `caddy502`; `tls` → `tls`;
  - two `test()` calls at once → one run.
  `test/server/tunnel-probe.test.ts`: the listener answers its nonce with the body above; another nonce, `/`, `/api/board`, `/api/hello` and a POST → 404; `closeAfterMs: 200` → after 300 ms the port refuses connections.
  `test/adapters/probe.test.ts` (a local `Bun.serve`): the right body → ok; 502 → `{ ok: false, kind: 'status', status: 502 }`; another body → `answer`; a closed port → `network`; `probeOrigin('board.example.com', {})` → `https://board.example.com`, with `BOARD_TUNNEL_PROBE_ORIGIN` → that value.
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement** the probes, the periodic probe, `test()`, `fetchProbe`, the probe-only listener and the hint texts.
- [ ] **Step 4: Run** them and `test/services/tunnel.test.ts`: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/services/tunnel.ts src/adapters/probe.ts src/server/tunnel-probe.ts src/core/i18n/access-strings.ts test/services/tunnel-test.test.ts test/server/tunnel-probe.test.ts test/adapters/probe.test.ts
git commit -m "Check that the domain reaches this board, now and then and step by step in Test connection"
```

---

### Task 12: The tunnel listener and the login routes (server)

**Spec:** "The worst outcome", "Where a login is needed", "The tunnel listener" (Where, When, "A request, in order", "Routes only the local board may use", "The caller's address"), "Logins (sessions)", "Ending logins", "The page through the domain" (pwaPage, `auth: 'login'`), Calls 2, 5, 6, 12, 13, 16, 24.

**Files:**
- Create: `src/server/tunnel.ts`, `src/server/streams.ts`, `test/support/tunnel-board.ts`
- Modify: `src/core/remote.ts` (`localOnly`), `src/server/remote.ts` (uses `localOnly` and `endsWhenGone`), `src/server/app.ts` (the access service, probes, the tunnel listener; `BoardServer.routes`), `test/support/runner.ts` (`TEST_ROUTE_TABLE`), `src/core/i18n/access-strings.ts`
- Test: `test/server/tunnel.test.ts`, `test/core/remote.test.ts`

**Interfaces:**
- Consumes: Tasks 2 (`tunnelConfig`, `tunnelProblems`, `boardPorts`, `tunnelPort`), 4, 7, 8, 11 (`createProbes`, the probe's answer); `staticRoute(WEB, bundle, pwaPage)`; `dispatch`, `GuardState`, `json`, `readBody`; `desktopOnly`, `REMOTE_API`.
- Produces:
  ```ts
  // core/remote.ts
  /** For the board on this computer only: the remote mode's and Remote access's management. */
  export const localOnly = (path: string): boolean => /^\/api\/(remote|access)(\/|$)/.test(path)
  // server/streams.ts
  /** `res` as it is, unless it is an event stream: then one that ends after an `unpaired` event once `watch` says so; `headers` added to it. */
  export function endsWhenGone(res: Response, watch: (gone: () => void) => () => void, headers?: Record<string, string>): Response
  // server/tunnel.ts
  export interface TunnelListenerOptions { cfg: Config; webPort: number; routes: Route[]; guards: GuardState; page: Route; access: Access; probes: Probes; log: (text: string) => void; onChange: () => void }
  export interface TunnelListener {
    /** Listens on 127.0.0.1:<tunnelPort> while tunnel.on, no tunnelProblems and access.ready(); else nothing listens. */
    sync(): Promise<void>
    configChanged(): void
    /** The port it listens on, or null. */
    listening(): number | null
    close(): Promise<void>
  }
  export function createTunnelListener(o: TunnelListenerOptions): TunnelListener
  // server/app.ts
  interface BoardServer { /* today's */ routes: readonly Route[] }
  // test/support/tunnel-board.ts
  export const DOMAIN = 'board.example.com', ORIGIN = 'https://board.example.com', PASSWORD = 'correct horse battery', SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  /** access.json's WebAuthn user id (base64url), for a passkey's userHandle. */
  export const USER_ID = 'dGVzdC11c2VyLWlkLTAx'
  /** Writes access.json (an argon2id hash of PASSWORD, SECRET_B32 with lastStep 0, USER_ID), and the logins (hashToken of each token, 30 days unless given) and passkeys asked for, mode 0o600. */
  export async function seedAccess(box: Sandbox, o?: { logins?: { token: string; expiresAt?: number; method?: LoginMethod }[]; passkeys?: Passkey[]; lockout?: { failures: number; until: number | null } }): Promise<void>
  export async function startTunnelBoard(box: Sandbox, cfg?: Record<string, unknown>, extra?: Record<string, string>): Promise<{ url: string; tunnel: string; tunnelPort: number; proc: Child }>
  /** Requests as Caddy forwards them: Host DOMAIN, X-Forwarded-Proto https, X-Forwarded-For 203.0.113.9; POSTs with X-Board and ORIGIN. */
  export function viaCaddy(tunnel: string, cookie?: string): { get(path: string, headers?: Record<string, string>): Promise<Response>; post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response> }
  ```
- Runner: with `TEST_ROUTE_TABLE=1` the `server` mode also sends `{ routes: server.routes.map(r => ({ method: r.method, path: typeof r.path === 'string' ? r.path : r.path.source })) }` before `{ ready: true }`.

**A request on the tunnel listener, in order:**
1. `Host` (lowercase) is `<domain>` or `<domain>:443`, else 403 `{ error: 'host' }`; `X-Forwarded-Proto` is `https`, else 403 `{ error: 'https' }`.
2. Not GET or HEAD: `X-Board: 1` and an `Origin` that is present and equals `https://<domain>`, else 403 `{ error: 'origin' }`.
3. `address = forwardedAddress(X-Forwarded-For)`; public (no login):
   - `GET /api/hello` (`rate('open')`): `{ board: 'agent-board', api: REMOTE_API, auth: 'login', signedIn, language: cfg.language ?? null }`, nothing more; a cookie sent that is no valid login gets `clearLoginCookie()`;
   - `GET /api/probe/<nonce>` (`rate('open')`): the probe's answer when `probes.answers(nonce)`, else 404;
   - `POST /api/login/password` → `access.signInPassword(body, who)`; `POST /api/login/passkey/options` (`rate('passkey')`) → `passkeyLoginOptions(domain)`; `POST /api/login/passkey` → `signInPasskey(body, { origin, rpId: domain }, who)`. Success: 200 `{ ok: true, method }` with `Set-Cookie: loginCookie(token, maxAgeS)`; failure: its status with `{ ok: false, error }` (`until` for 423, `Retry-After` header for 429);
   - GET of anything not under `/api/` or `/uploads/`: the page route (`o.page`), as the serve listener does.
4. `access.verify(loginToken(Cookie))`: none → 401 `{ error: 'login' }`, with `clearLoginCookie()` when a cookie was sent.
5. With a login: the decoded path (400 when it does not decode); `desktopOnly` of the raw or decoded path → 403 `{ error: 'desktop' }`; `/api/peers` or `/api/remote/pair…` → 404; `localOnly` raw or decoded → 403 `{ error: 'local' }`; the tunnel's own routes behind the login: `POST /api/logout` (`endToken`, 200 `{ ok: true }` with `clearLoginCookie()`), `POST /api/login/passkey/add/options` (`passkeyAddOptions(login.id, body.code, { id: domain })`: 200 with the options, or 403 `{ ok: false, error: 'code' }`), `POST /api/login/passkey/add` (`addPasskey(login.id, body, { origin, rpId: domain }, userAgent)`: 200 `{ ok: true, id }`, or 400 `{ ok: false, error }`); then `dispatch(o.routes, req, url, path, { ...o.guards, origins: ['https://<domain>'] })` wrapped in `endsWhenGone(res, gone => access.watch(login.id, gone), { 'x-accel-buffering': 'no' })`.
- Errors inside: logged as `tunnel <method> <path>: <message>` (the path only, never a query), 500.

**Wiring (`app.ts`):** `const access = createAccess({ onChange: () => { board.publish(); void tunnel.sync() } })`, `const probes = createProbes()`, `const tunnel = createTunnelListener({ cfg, webPort: port, routes, guards, page, access, probes, log, onChange: () => board.publish() })` with `page` the same `staticRoute(WEB, bundle, pwaPage)` the remote listener gets; `void tunnel.sync()` after the web server listens; `refresh()` also calls `tunnel.configChanged()`; `close()` awaits `tunnel.close()`. `remote.ts`'s `localOnly` goes (it uses core's); `endsWhenUnpaired` becomes `endsWhenGone(res, gone => o.remote.watch(device.id, gone))`.

- [ ] **Step 1: Write the failing tests.**
  `test/core/remote.test.ts`: `localOnly` true for `/api/remote`, `/api/remote/x`, `/api/access`, `/api/access/x`; false for `/api/accessories`, `/api/remotes`, `/api/probe/x`, `/api/login/password`.
  `test/server/tunnel.test.ts` (each `describe` its own board through `startTunnelBoard` after `seedAccess`, with `TEST_ROUTE_TABLE: '1'` in `extra`; the test's own sign-in computes the code with `totpCode(base32Bytes(SECRET_B32), totpStep(Date.now()))`; other logins are seeded with known tokens, so no test waits for a TOTP step). `caddy = viaCaddy(tunnel)` has no cookie; `SAMPLES: Record<string, string>` maps each RegExp route's `source` to one raw path it matches (`/api/session/s1/changes`, `/uploads/2026-10-20/a.png`, …):
```ts
test('every route in the table answers 401 without a login: the page and hello aside', async () => {
  const table = proc.messages.find(m => (m as { routes?: unknown }).routes) as { routes: { method: string; path: string }[] }
  // One raw path per RegExp route, by its source; a new route without one fails here first.
  const missing = table.routes.filter(r => r.path.startsWith('^') && r.path !== '^' && !(r.path in SAMPLES))
  expect(missing).toEqual([])
  for (const r of table.routes) {
    const raw = r.path.startsWith('^') ? (r.path === '^' ? '/' : (SAMPLES[r.path] as string)) : r.path
    if (r.path.startsWith('^')) expect([raw, new RegExp(r.path).test(raw)]).toEqual([raw, true])
    for (const method of r.method === 'ANY' ? ['GET', 'POST'] : [r.method]) {
      const res = method === 'GET' ? await caddy.get(raw) : await caddy.post(raw, {})
      const open = method === 'GET' && (raw === '/' || raw === '/api/hello')
      expect([method, raw, res.status]).toEqual([method, raw, open ? 200 : 401])
    }
  }
})
```
  and, in that board and others:
  - Host `127.0.0.1:<port>` → 403 `host`; `X-Forwarded-Proto: http` → 403 `https`; Host `board.example.com:443` → 200; a POST without `Origin`, with `Origin: https://evil.example`, or without `X-Board` → 403 `origin`;
  - hello before a login: `Object.keys(body)` is exactly `['board', 'api', 'auth', 'signedIn', 'language']`, `auth: 'login'`, `signedIn: false`; with the seeded login's cookie `signedIn: true`;
  - the probe without a login: `GET /api/probe/<any nonce>` → 404 (no probe was issued; the answered case is Task 14's);
  - the page files without a login: `/`, `/app.js`, `/theme.js`, `/styles/pwa.css`, `/manifest.webmanifest`, `/sw.js`, `/icon.svg` → 200; the page has `<html data-remote`;
  - sign in with `PASSWORD` and the code → 200, `Set-Cookie` matches `/^__Host-board-login=[\w-]{43}; Path=\/; Max-Age=259200\d; Secure; HttpOnly; SameSite=Strict$/`; with it `/api/board` → 200;
  - with a login: `/api/open-url` and `/api/open%2Durl` → 403 `desktop`; `/api/access`, `/api/%61ccess`, `/api/remote`, `/api/remote%2Fx` → 403 `local`; `/api/peers`, `POST /api/remote/pair` → 404; `POST /api/session/s1/permit` with the domain's Origin gets past the origin guard (no 403 `origin`);
  - sign out: an open `/api/events` (its `x-accel-buffering` is `no`) ends with `event: unpaired`; the next request → 401 with a clearing `Set-Cookie`; hello → `signedIn: false` with a clearing `Set-Cookie`;
  - a seeded login whose `expiresAt` is past → 401 and a clearing cookie;
  - a seeded ES256 passkey (`softAuthenticator`, its registration verified in the test with `verifyRegistration` and written by `seedAccess`): options → assertion → 200 with a cookie;
  - `POST /api/login/passkey/add/options` with a wrong code → 403 `{ ok: false, error: 'code' }`;
  - lockout and rates (a board of its own): 11 wrong sign-ins from `203.0.113.9` → statuses `[401 ×5, 423 ×5, 429]`, the 429 with `Retry-After`; from `203.0.113.10` → 423 (the lockout is the board's), not 429; passkey options from `203.0.113.9` → 200, and the seeded passkey signs in;
  - not listening: `tunnel.on` with no access seeded → the tunnel port refuses connections; `tunnel.on: false` → refuses; a bad field (`host: '-oX'`) → refuses;
  - the web board unchanged: `GET <url>/api/hello` answers the full hello (has `version`, `host`, `platform`), `GET <url>/api/board` asks no login.
- [ ] **Step 2: Run** `bun test test/server/tunnel.test.ts test/core/remote.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `localOnly`, `endsWhenGone`, the tunnel listener, the wiring, the runner's table and the support file.
- [ ] **Step 4: Run** them and `bun test test/server/remote.test.ts test/server/pwa.test.ts test/server/routes.test.ts`: PASS, the last three unchanged. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/core/remote.ts src/server/remote.ts src/server/streams.ts src/server/tunnel.ts src/server/app.ts src/core/i18n/access-strings.ts test/support/runner.ts test/support/tunnel-board.ts test/server/tunnel.test.ts test/core/remote.test.ts
git commit -m "Listen for the tunnel on 127.0.0.1 and ask a login of every board route that comes that way"
```

---

### Task 13: The board's own files are not served through the tunnel

**Spec:** "The board's own files" (the routes as they stand, the uploads exception, "A new route that reads by path takes the same check"), "Testing" (the planted marker, from the table), Call 30.

**Files:**
- Modify: `src/server/http.ts` (`GuardState.ownFiles`, `RouteContext.ownFile`), `src/server/routes/fs.ts`, `src/server/routes/session.ts` (the `changes` route), `src/server/tunnel.ts` (its guards get `ownFiles`), `src/server/app.ts` (`ownFileCheck(cfg)` to the tunnel listener), `src/core/i18n/access-strings.ts`
- Test: `test/server/tunnel-files.test.ts`

**Interfaces:**
- Consumes: `ownFileCheck` (Task 6); Task 12's listener and `test/support/tunnel-board.ts`.
- Produces:
  ```ts
  // server/http.ts
  interface GuardState { /* today's */ ownFiles?: (target: string) => boolean }   // set by the tunnel listener only
  interface RouteContext { /* today's */ ownFile(target: string): boolean }       // !!state.ownFiles?.(target)
  // TunnelListenerOptions gains: ownFiles: (target: string) => boolean
  ```

**Rules:**
- `/api/fs/raw`, `/api/fs/preview`, `/api/fs/dirs`: the resolved target (for `dirs`, `resolvePath(body.path)` when it is not blank) is own → 403 `{ error: t('err.fs.own') }`.
- `/api/fs/stat`: an own item → `{ raw, line, path: target, name: basename(target), exists: false }`.
- `/api/session/<id>/changes`: `ctx.ownFile(item.cwd)` → 403 `{ error: t('err.fs.own') }`.
- New key `err.fs.own` (**exact**): en `This file is the board’s own: it is not shown through the domain`, ru `Это собственный файл доски: через домен он не показывается`.

- [ ] **Step 1: Write the failing test** `test/server/tunnel-files.test.ts`. One board through `startTunnelBoard` with a seeded login; the fake herdr has a pane `s1` whose `cwd` is the sandbox's state folder and `s2` in `box.dir`; marker files hold `MARKER-<random>`: `<state>/marker.txt`, `<state>/marker.png` (the marker as its bytes), `<config>/marker.txt`, and `<home>/keys/marker.txt` with `tunnel.key = <home>/keys/k`.
  - Through the tunnel with the login: `POST /api/fs/preview` of each marker, also `{ path: 'marker.txt', cwd: <state> }` and `/api/fs/%70review` → 403 with the exact text; `GET /api/fs/raw?path=<state>/marker.png&t=<fsToken from /api/board>` → 403; `POST /api/fs/dirs { path: <state> }` → 403; `POST /api/fs/stat { paths: [<state>/marker.txt] }` → `exists: false`; `GET /api/session/s1/changes` → 403, `s2`'s → 200;
  - an upload stays readable: `POST /api/upload` of a PNG, then `GET <its url>` → 200, `/api/fs/raw?path=<its path>` → 200, `/api/fs/preview` of it → 200;
  - **no route gives the board's own files away:** from the route table (Task 12's `TEST_ROUTE_TABLE`, the same `SAMPLES`), every route and method gets its sample path with the query `?path=<m>&paths=<m>&cwd=<state>&t=<fsToken>` and, for POSTs, the body `{ path: <m>, paths: [<m>], cwd: <state>, url: <m> }`, once per marker; event streams are read for at most 1 s; no answer's text contains a marker;
  - the same `preview` and `raw` on the local web board → 200 with the marker (the check is the tunnel's only).
- [ ] **Step 2: Run** `bun test test/server/tunnel-files.test.ts`. Expected: FAIL (the previews answer 200).
- [ ] **Step 3: Implement** the guard field, the context function, the route checks, the wiring and the key.
- [ ] **Step 4: Run** it and `bun test test/server/files-routes.test.ts test/server/folder-picker.test.ts test/server/raw-range.test.ts test/server/tunnel.test.ts`: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/server/http.ts src/server/routes/fs.ts src/server/routes/session.ts src/server/tunnel.ts src/server/app.ts src/core/i18n/access-strings.ts test/server/tunnel-files.test.ts
git commit -m "Refuse the board's own state, config and key folders to every route that reads by path through the tunnel"
```

---

### Task 14: Remote access on the local board: `/api/access`, the tunnel's ssh, and the payload's revision

**Spec:** "The panel" (every change a POST to a local-only route, the view from a local-only GET), "Board restarts and overlap" (the owner, the stray ssh, never two), "Generate key", "The server's host key", "Changing the domain", "Live updates" (Call 28), "Routes only the local board may use" (Call 16), Calls 7, 9, 13, 23.

**Files:**
- Create: `src/services/remote-access.ts`, `src/server/routes/access.ts`
- Modify: `src/server/app.ts` (the supervisor, its exit handler, the routes, `accessRev`), `src/adapters/config-file.ts` (`editTunnel`, `setTunnelOn`), `src/core/payload.ts`, `src/server/board-state.ts`, `web/src/api/client.ts`, `test/support/fake-ssh.ts` (a Caddy stand-in), `src/core/i18n/access-strings.ts`
- Test: `test/server/access-routes.test.ts`, `test/server/remote.test.ts`, `test/server/pwa.test.ts`, `test/adapters/config-file.test.ts`, `test/web/client.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–13.
- Produces:
  ```ts
  // adapters/config-file.ts — both keep the other fields of `tunnel` and of the file; in editTunnel a null or '' value removes the field
  export function editTunnel(fields: Partial<Record<TunnelField, unknown>>): EditResult
  export function setTunnelOn(on: boolean): EditResult
  // services/remote-access.ts
  export interface RemoteAccess { view(): Promise<AccessView>; op(body: unknown): Promise<{ status: number; body: unknown }> }
  export function createRemoteAccess(d: { cfg: Config; webPort: number; access: Access; supervisor: Supervisor; tunnel: TunnelListener }): RemoteAccess
  // server/routes/access.ts
  export function accessRoutes(r: RemoteAccess): Route[]   // GET /api/access; POST /api/access, guard ['board-header', 'origin']
  // core/payload.ts: BoardPayload gains accessRev?: number (the server always sends it); board-state Options gains accessRev?: () => number
  // web/src/api/client.ts: isBoardPayload accepts accessRev undefined | number
  ```

**`POST /api/access` ops** (answers `{ ok: true, … }` 200, or a refusal 409 `{ ok: false, error, … }`, unknown op 400):
- `{ op: 'tunnel', fields, confirm? }`: each given field's `fieldProblem` → 409 `{ field, error }`, nothing written; `domain` set to another value while `access.hasPasskeysOrLogins()` and not `confirm` → 409 `{ confirm: 'domain', error: t('access.domainSure') }`; with `confirm` → `access.domainChanged()` first; then `editTunnel`. `domain` is lowercased and trimmed before its check.
- `{ op: 'on' }`: `tunnelProblems` or `!access.ready()` → 409 with the first problem's message or `t('access.err.notReady')`; else `setTunnelOn(true)`. `{ op: 'off' }` → `setTunnelOn(false)`.
- `{ op: 'key-generate', replace? }`: the generated key exists and not `replace` → 409 `{ confirm: 'key', error: t('access.keySure') }`; else `generateKey('agent-board@' + hostname())`.
- `{ op: 'hostkey-forget' }`, `{ op: 'test' }` (→ `{ ok: true, steps }`), `{ op: 'password', password }`, `{ op: 'totp-begin' }` (→ `{ ok: true, secret, uri }`, with the tunnel's domain), `{ op: 'totp-confirm', code }`, `{ op: 'passkey-remove', id }`, `{ op: 'login-end', id }`, `{ op: 'logins-end-all' }`, `{ op: 'lockout-lift' }`.

**`view()`** builds `AccessView`: the settings, `tunnelProblems`, `blocked` (the reason On is refused, or null), `listenPort = tunnelPort`, `supervisor.status()`, `sshBin()`, the key (`keyPath`, `generated = !conf.key`, `exists`, `publicKeyOf` when it exists, its error), `hostKeyFingerprint()`, and `access.view()`.

**Wiring (`app.ts`):** after `Bun.serve` succeeds: `const supervisor = createSupervisor({ plan, spawn: spawnSsh, stray: { read: readPidRecord, write: writePidRecord, end: endStraySsh }, clock: realClock, network: networkSignature, probes, probe: nonce => fetchProbe(probeOrigin(conf().domain), nonce), testPlan, checkKey: () => publicKeyOf(keyPath(conf())), sshFound: () => sshBin(), openProbeListener, onChange: accessChanged, log })`, where `conf()` is `tunnelConfig(cfg.tunnel)` and `lineTo(target)` is `{ conf, bin: sshBin() ?? 'ssh', args: sshArgs({ conf, key: keyPath(conf), knownHosts: knownHostsFile(), target }), forward: forwardSpec(conf.socket, target) }` (a missing ssh then fails to spawn and shows as `noSsh`); `plan()` is null unless `tunnel.listening()` is a port, and is then `lineTo(that port)`; `testPlan(target)` is null while `tunnelProblems` finds any, else `lineTo(target)`, whether the tunnel is on or not; `process.on('exit', supervisor.killNow)` (removed in `close()`); `void tunnel.sync().then(() => supervisor.sync())`; `refresh()`: `tunnel.configChanged()` then `supervisor.sync()`; `access`'s `onChange` and the listener's also `supervisor.sync()`; `close()`: `await supervisor.close()` before `tunnel.close()`. `accessRev`: a counter that `accessChanged()` (any change of `access`, the supervisor's status, the tunnel's config) increments, then `board.publish()`.

**The fake as Caddy:** with `ssh.proxyPort` in its state, the fake ssh in `forward` mode also listens on `127.0.0.1:<proxyPort>` and passes each request on to `127.0.0.1:<the -R target port>`, body streamed, with `Host: <ssh.domain>`, `X-Forwarded-Proto: https`, `X-Forwarded-For: 203.0.113.9`. A proxy port still taken (a stray fake about to be ended) is tried again for 2 s; the fake goes on without it after that.

**New keys:** `access.domainSure` en `Changing the domain removes every passkey (they belong to the old one) and ends every login. Change it?`; `access.keySure` en `A new key replaces this one: the server needs its public key before the tunnel works again. Replace it?`; `access.err.notReady` en `Set up the password and the code first`.

- [ ] **Step 1: Write the failing tests.**
  `test/adapters/config-file.test.ts`: `editTunnel({ host: 'ssh.example.com' })` keeps a hand-written `tunnel.note` and every other field; `setTunnelOn(true)` keeps the rest.
  `test/web/client.test.ts`: `isBoardPayload` accepts `accessRev` 3 and undefined, refuses `'3'`.
  `test/server/remote.test.ts` ("what acts on the computer's screen…" test) and `test/server/pwa.test.ts`: `/api/access` and `/api/%61ccess` from a phone → 403 `{ error: 'local' }`, GET and POST.
  `test/server/access-routes.test.ts` (sandbox, `extra` env `BOARD_SSH_BIN_PATH` and `BOARD_SSH_KEYGEN_BIN_PATH` = `await fakeSshBin()`, `FAKE_SSH_STATE`, `FAKE_SSH_LOG`, `BOARD_TUNNEL_PROBE_ORIGIN = http://127.0.0.1:<proxyPort>`, `TEST_LIVE_CONFIG: '1'` with config.json written as `test/server/remote.test.ts`'s CLI test does):
  - nothing set up: the view has the default settings, problems for host, user and domain, `blocked` set, `login.password` and `totp` false; `{ op: 'on' }` → 409;
  - config.json edited by hand to `tunnel: { on: true, host: '-oProxyCommand=calc', user: 'boardtunnel', domain: 'board.example.com' }` with access seeded: after a reload the fake's log has no ssh call, the tunnel port refuses, the view's problems name `host`;
  - `{ op: 'tunnel', fields: { host: '-oProxyCommand=calc' } }` → 409 with `field: 'host'`, config.json byte for byte as before; good fields → saved;
  - `totp-begin` → a secret and a URI; `GET /api/access` and `/api/board` never contain the secret; `totp-confirm` with the code → `totp: true`; `password` → `password: true`;
  - `key-generate` → the view's key `exists`, `publicKey` `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEKEY agent-board@…`; again without `replace` → 409 `confirm: 'key'`;
  - `test` with the tunnel off → three ✓ (the fake proxies the probe to the test's probe-only listener); afterwards the fake's log has one ssh call and its process is gone;
  - `on` → the payload's `accessRev` changes; the fake's log gets an ssh call whose args equal `sshArgs(…)` for these settings (the key, known_hosts, `-R /var/lib/boardtunnel/board.sock:127.0.0.1:<tunnelPort>`); the view's state becomes `connected`; `GET <proxy>/api/hello` (through the fake) answers the reduced hello; `test` now → three ✓ and the log still has only that one ssh call; the view's `hostKey` is `SHA256:FAKEfingerprint (ED25519)`;
  - `off` → the ssh's pid no longer runs, state `off`, the tunnel port refuses;
  - with a seeded login and passkey: `tunnel` with a new domain → 409 `confirm: 'domain'`; with `confirm: true` → the passkeys gone, the login's token gets 401;
  - **a board killed hard, then another:** board A with the tunnel on until `connected`; `proc.kill()`; board B on the same ports and state → B's view `connected`, A's ssh pid (from `ssh-pid.json` before B) no longer runs, one fake ssh process runs.
- [ ] **Step 2: Run** the five test files. Expected: FAIL.
- [ ] **Step 3: Implement** the config edits, the service, the routes, the wiring, the payload field, the guard, the fake's proxy and the keys.
- [ ] **Step 4: Run** them, and `bun test test/server/tunnel.test.ts test/server/tunnel-files.test.ts test/server/routes.test.ts`: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/services/remote-access.ts src/server/routes/access.ts src/server/app.ts src/adapters/config-file.ts src/core/payload.ts src/server/board-state.ts web/src/api/client.ts src/core/i18n/access-strings.ts test/support/fake-ssh.ts test/server/access-routes.test.ts test/server/remote.test.ts test/server/pwa.test.ts test/adapters/config-file.test.ts test/web/client.test.ts
git commit -m "Set up remote access from the local board only, and run the tunnel's ssh in the board that holds the web port"
```

---

### Task 15: `board tunnel` and `board doctor`

**Spec:** "`board tunnel` and `board doctor`", Calls 13, 29.

**Files:**
- Create: `src/services/tunnel-facts.ts`
- Modify: `src/entrypoints/cli.ts` (header comment, `USAGE`, `tunnel()`, `doctor`), `src/core/tunnel.ts` (`tunnelChecks`), `src/core/i18n/access-strings.ts`
- Test: `test/entrypoints/tunnel-cli.test.ts`, `test/core/tunnel.test.ts`

**Interfaces:**
- Consumes: `setTunnelOn` (Task 14), `accessReady` (Task 7), `sshBin`, `publicKeyOf`, `keyPath` (Task 9), `tunnelProblems`, `AccessView`.
- Produces:
  ```ts
  // core/tunnel.ts
  export interface TunnelFacts {
    ssh: string | null
    key: { ok: true } | { ok: false; error: string; hint: TunnelHint | null }
    problems: TunnelProblem[]
    ready: boolean
    /** From the running board's GET /api/access; null when no board answers. */
    status: TunnelStatus | null
  }
  export function tunnelChecks(f: TunnelFacts, t: Translator): SetupCheck[]   // ids tunnel-ssh, tunnel-key, tunnel-fields, tunnel-login, tunnel-state, tunnel-probe
  // services/tunnel-facts.ts
  export async function tunnelFacts(cfg: Config, webPort: number): Promise<TunnelFacts>
  ```

**Rules:**
- `board tunnel` (status, from `GET http://127.0.0.1:<webPort>/api/access`, 3 s; English):
  - off: `tunnel off · Settings → Remote access… on the web board sets it up`;
  - on: `tunnel <state> since <HH:MM> · https://<domain>`, then `attempt <n>, next try <HH:MM:SS>: <error>` (reconnecting), `error: <error>` and `fix: <hint text>` (error), `warning: the domain did not reach this board: <detail>` (a failed probe), `socket <socket> · ssh <binary>`;
  - no board answering: `tunnel on · the board does not run` or the off line.
- `board tunnel on`: `tunnelProblems` → the first message (exit 1); not `accessReady()` → `Set up the password and the code first: Settings → Remote access… on the web board` (exit 1); else `setTunnelOn(true)` → `ok · tunnel on: the board opens it in a few seconds; \`board tunnel\` says how it stands`. `off` → `ok · tunnel off`.
- `board tunnel test` → `POST /api/access { op: 'test' }` (60 s timeout); one line per step: `✓`, `✗` or `–`, then `ssh and the key`, `the server takes the forward`, `through https://<domain>`, and `: <detail>` when there is one, with the hint text under a ✗; no board → `the board does not run: open it first (herdr plugin action invoke agent-board.open)`, exit 1.
- Anything else → `usage: board tunnel [on | off | test]`, exit 1. `USAGE` gains `tunnel [on | off | test]` after `remote […]`.
- `board doctor`: only when `tunnelConfig(cfg.tunnel).on`, `checks.push(...tunnelChecks(await tunnelFacts(cfg, webPort), t))`; off, nothing is asked (no ssh run).
- `tunnelChecks`: `tunnel-ssh` ok with the binary / error `noSsh`'s hint; `tunnel-key` ok / error with the error and the hint text; `tunnel-fields` ok / error listing each problem's message; `tunnel-login` ok / error `Set up the password and the code: Settings → Remote access…`; `tunnel-state` ok `connected`, warn `connecting`/`reconnecting` with the error, error `error` with the hint, warn `the board does not run` when `status` is null; `tunnel-probe` only when `status.probe`: ok, or warn with its detail. Titles are new keys `tunnel.check.*` (English yours, short as `pwa.check.*`).

- [ ] **Step 1: Write the failing tests.**
  `test/core/tunnel.test.ts` gains `tunnelChecks` for: all fine and connected with a good probe (six `ok`); no ssh; a key `keyPermissions`; two problems; not ready; reconnecting; error `publickey`; no board; a failed probe (`warn` with `502`). Ids and levels asserted; titles in `en` and `ru` differ.
  `test/entrypoints/tunnel-cli.test.ts` (sandbox, the fake for both binaries through `box.run('cli', { args, env })`):
  - `board tunnel` with nothing → the off line;
  - `board tunnel on` with no fields → `Server: needed`, exit 1; with `host: '-oProxyCommand=calc'` written by hand → the host's message, exit 1; fields written, no login → `Set up the password and the code first…`, exit 1, config.json's `tunnel.on` still absent;
  - `board doctor` with that hand-written host and `tunnel.on` → the `tunnel-fields` error line holds the host's message;
  - with `seedAccess` → `ok · tunnel on…`, config.json's `tunnel.on` true and a hand-written `tunnel.note` kept; `board tunnel off` → `ok · tunnel off`;
  - with a board running (`serveBoard` with `TEST_LIVE_CONFIG`) and the tunnel on → `board tunnel` prints `tunnel connected since` and the socket line; `board tunnel test` prints three `✓` lines;
  - `board tunnel sideways` → the usage, exit 1;
  - `board doctor` with the tunnel off has no line starting `tunnel`; with it on and no board → the `tunnel-state` warning line.
- [ ] **Step 2: Run** `bun test test/entrypoints/tunnel-cli.test.ts test/core/tunnel.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the command, the facts, the checks and the keys.
- [ ] **Step 4: Run** them and `bun test test/entrypoints/cli.test.ts test/entrypoints/doctor.test.ts`: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add src/entrypoints/cli.ts src/services/tunnel-facts.ts src/core/tunnel.ts src/core/i18n/access-strings.ts test/entrypoints/tunnel-cli.test.ts test/core/tunnel.test.ts
git commit -m "Add board tunnel to show, turn on and off and test the tunnel, and check it in board doctor"
```

---

### Task 16: The Remote access panel: Settings item and the Tunnel part (web)

**Spec:** "What the owner sees" (1), "The 'Remote access…' panel" (Tunnel), "Live updates" (Call 28), Call 14; "Constraints" (styles).

**Files:**
- Create: `web/src/components/Qr.tsx`, `web/src/components/access/AccessPanel.tsx`, `web/src/components/access/TunnelSection.tsx`, `web/src/components/access/Snippets.tsx`, `web/src/models/access.ts`, `web/src/hooks/useAccess.ts`, `web/styles/access.css`
- Modify: `web/src/components/phones/PhonesPanel.tsx` (uses `Qr` with `className="phones-qr"`), `web/src/components/panel/Panel.tsx` (kind `access`, label `access.title`), `web/src/models/settings-menu.ts`, `web/src/hooks/useSettingsMenu.ts`, `web/src/components/SidePanels.tsx`, `web/src/App.tsx`, `web/index.html` (`styles/access.css` after `styles/segments.css`), `src/core/i18n/access-strings.ts`
- Test: `test/web/access-panel.test.tsx`, `test/web/settings.test.tsx`, `test/server/routes.test.ts` (the page's links), `test/web/phones-panel.test.tsx` (unchanged, must pass)

**Interfaces:**
- Consumes: `AccessView`, `TunnelStatus`, `TestStep` (core types), the snippet functions (Task 3), `tunnelPort`, `GET/POST /api/access` (Task 14), `data.accessRev`, `remotePage()`.
- Produces:
  ```ts
  // web/src/components/Qr.tsx
  export function Qr({ text, className }: { text: string; className: string }): JSX.Element
  // web/src/models/access.ts
  export function isAccessView(v: unknown): v is AccessView
  export function statusLine(s: TunnelStatus, t: Translator, now: number): string
  export function stepLine(s: TestStep, t: Translator): string   // '✓ …', '✗ …: detail', '– …'
  export function hintText(hint: StepHint | null | undefined, t: Translator): string
  /** What a field's edit sends: null when unchanged; else { value }: numbers for the ports ('' gives null for `port`, clearing it), the domain lowercased, strings trimmed. */
  export function fieldEdit(field: TunnelField, now: string | number | null, typed: string): { value: unknown } | null
  // web/src/hooks/useAccess.ts
  export type AccessSend = (op: string, body?: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  export function useAccess(open: boolean): { view: AccessView | null; send: AccessSend; steps: TestStep[] | null; testing: boolean }
  // web/src/components/access/AccessPanel.tsx
  export interface AccessPanelProps { open: boolean; onClose(): void }
  export function AccessPanel(p: AccessPanelProps): JSX.Element
  /** The panel's body for a given view (what the tests draw). */
  export function AccessBody(p: { view: AccessView; send: AccessSend; steps: TestStep[] | null; testing: boolean }): JSX.Element
  // settings-menu.ts: SettingsNow gains access?: boolean → { id: 'access', label: t('set.access') } after phones; SettingPick gains { kind: 'access' }
  // useSettingsMenu.ts: SettingsDeps gains access?(): boolean; openAccess?(): void; useSettingsMenu(menu, openProfiles, openPhones, openAccess = () => {}); access: () => !remotePage()
  // SidePanels: access?: AccessPanelProps, drawn when given
  ```

**Rules:**
- **Mounted on first open:** `App` keeps `access` (open) and `accessMounted` (set on the first open); `SidePanels` gets `access` only once mounted and only when `!remotePage()`. Until then the page's markup is today's (`test/web/panel.test.tsx`'s `<App>` list stays as it is).
- **`useAccess`:** `GET /api/access` when it opens and whenever `data.accessRev` changes while open; `send` posts `{ op, ...body }` through `api.post`, toasts a refusal with `errorText`, returns the reply (also a 409's, so the caller can see `confirm`), refetches after. Test runs `send('test')` and keeps `steps`.
- **The Tunnel part** (`.access-tunnel`), top to bottom:
  - the reach line (`.access-reach`, **exact**): en `Through the domain, a login gets the board as a phone does, and the terminal: a shell on this PC with your rights. The board's own files (its settings, logins and keys) are not served through the domain, but the terminal, or a session started from it, reaches them and everything else on this PC. Treat a login like your own shell.` ru `Через домен вход даёт доску, как телефону, и терминал: оболочку на этом компьютере с вашими правами. Собственные файлы доски (её настройки, входы и ключи) через домен не отдаются, но терминал или запущенная из него сессия достают и их, и всё остальное на этом компьютере. Относитесь ко входу как к своей оболочке.`;
  - the status (`.access-status`): `statusLine` (e.g. `Connected since 14:05`, `Reconnecting: attempt 3, next try 14:05:12. <error>`, `Error since 14:05: <error>` and the hint under it, `Off`, `Connecting…`); a failed probe as `.access-warn`: `The domain did not reach this board: <detail>`; the ssh binary used (`view.tunnel.ssh`), or the `noSsh` hint when there is none;
  - On / Off: On disabled with `blocked` shown in `.access-why`; Off when on;
  - Test connection: a button (disabled while testing) and, after, `.access-steps` with one `<li>` per `stepLine`, the hint under a ✗;
  - the fields (`.access-field` each a `<label>` with `tunnel.field.*` and an input with that `aria-label`; problems under their field as `.access-problem`), saved on Enter or blur through `fieldEdit` as `{ op: 'tunnel', fields: { [field]: value } }`, Escape puts the value back; a 409 with `confirm: 'domain'` asks twice (the second click sends `confirm: true`);
  - the key (`.access-key`): its path (or "the board's own key"), Generate key (two clicks when one exists, `access.keySure`'s text on the first, then `replace: true`), the public key and `keysLine(publicKey)` each in `<code>` with Copy (`navigator.clipboard.writeText`, a toast); the server's key `hostKey` with Forget;
  - the snippets (`Snippets.tsx`, `<details>` each, `<pre><code>`, Copy): the server commands (`serverCommands(user || 'boardtunnel', socket)`), the keys file and its line (`keysFile(user)`, `keysLine(publicKey)`), the sshd block, the Caddyfile; nginx in a closed `<details>` with the note that the folder's group is then nginx's.
- **CSS** (`web/styles/access.css`, class selectors only): sections spaced as `.phones-body`'s, fields as the Profiles panel's, `.access-warn` and `.access-problem` in the danger color variable the sheets already use, `<pre>` scrollable, monospace, wrapped.
- **New keys** (English yours, short): `set.access` en `Remote access…` ru `Удалённый доступ…`; `access.title` en `Remote access`; the status words, buttons, labels and snippet titles used above.

- [ ] **Step 1: Write the failing tests.**
  `test/web/settings.test.tsx`: `settingsMenu({ ...now, access: true })` has `{ id: 'access', label: 'Remote access…' }` after `phones` (and `Удалённый доступ…` in Russian); without `access` the ids are today's; `settingPicked('access')` → `{ kind: 'access' }`.
  `test/server/routes.test.ts`: the page's link list gains `'styles/access.css'` before `'app.js'`.
  `test/web/access-panel.test.tsx` (`AccessBody` drawn with `renderInBoard` in a `PanelProvider`, views built from a `VIEW` fixture):
  - nothing set up: three `.access-problem` (`Server: needed`, `User: needed`, `Domain: needed`), On disabled with the reason in `.access-why`, the status `Off`;
  - connected since a fixed time with a failed probe (`502`): the status text, and `.access-warn` `The domain did not reach this board: 502`;
  - reconnecting (attempt 3) and error (`publickey`, with the hint text);
  - the key with a public key: its `<code>`, the line `restrict,port-forwarding ssh-ed25519 …`, the host key with Forget;
  - the snippets hold `reverse_proxy unix//var/lib/boardtunnel/board.sock`, the domain, `install -d -m 2750 -o boardtunnel -g caddy /var/lib/boardtunnel`; nginx's `<details>` has no `open`;
  - the reach line exactly, in English and Russian;
  - steps `[✓ ssh, ✗ forward listenPath, – domain]` → three `<li>` with the hint under the second;
  - live (as `test/web/profiles-panel.test.tsx`'s `answers` and `livePanel`): typing a host and leaving the field posts `{ op: 'tunnel', fields: { host: 'ssh.example.com' } }`; a 409 `{ ok: false, field: 'host', error }` is toasted; On posts `{ op: 'on' }`; Generate key with a key there asks first and the second click posts `{ op: 'key-generate', replace: true }`; an `accessRev` change while open fetches `/api/access` again;
  - `fieldEdit('sshPort', 22, ' 2222 ')` → `{ value: 2222 }`, `fieldEdit('domain', 'a.b', ' Board.Example.com ')` → `{ value: 'board.example.com' }`, `fieldEdit('port', 12500, '')` → `{ value: null }`, `fieldEdit('host', 'a.b', ' a.b ')` → null.
- [ ] **Step 2: Run** `bun test test/web/access-panel.test.tsx test/web/settings.test.tsx test/server/routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the `Qr` move, the model, the hook, the panel's Tunnel part, the Settings item, the mounting, the sheet, the link and the keys.
- [ ] **Step 4: Run** them and `bun test test/web/phones-panel.test.tsx test/web/panel.test.tsx test/web/single-profile.test.tsx test/web/styles.test.ts test/web/style-attributes.test.ts`: PASS, these unchanged. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add web/src/components/Qr.tsx web/src/components/access web/src/models/access.ts web/src/hooks/useAccess.ts web/styles/access.css web/src/components/phones/PhonesPanel.tsx web/src/components/panel/Panel.tsx web/src/models/settings-menu.ts web/src/hooks/useSettingsMenu.ts web/src/components/SidePanels.tsx web/src/App.tsx web/index.html src/core/i18n/access-strings.ts test/web/access-panel.test.tsx test/web/settings.test.tsx test/server/routes.test.ts
git commit -m "Set up the tunnel from Settings → Remote access… on the local board, with its status, Test connection and the server's snippets"
```

---

### Task 17: The Remote access panel: Login and Active logins (web)

**Spec:** "The 'Remote access…' panel" (Login, Active logins), "Login" (setup on the local board, the TOTP QR code, passkeys listed and removed, the lockout lifted), Calls 18, 22, 26.

**Files:**
- Create: `web/src/components/access/LoginSection.tsx`, `web/src/components/access/LoginsSection.tsx`
- Modify: `web/src/components/access/AccessPanel.tsx` (both sections under the Tunnel part), `web/src/models/access.ts`, `web/styles/access.css`, `src/core/i18n/access-strings.ts`
- Test: `test/web/access-login.test.tsx`

**Interfaces:**
- Consumes: Task 16's `AccessBody`, `useAccess`'s `send`, `Qr`; the ops `password`, `totp-begin`, `totp-confirm`, `passkey-remove`, `login-end`, `logins-end-all`, `lockout-lift`.
- Produces: `LoginSection({ view, send }: { view: AccessView; send: AccessSend })`, `LoginsSection` the same; `models/access.ts` gains `groupKey(secret: string): string` (`ABCD EFGH …`).

**Rules:**
- **Login** (`.access-login`):
  - Password: "set" or "not set"; Set / Change opens an `<input type="password" autocomplete="new-password">` and Save; when one is set the form says first (`access.passwordEnds`, en `Changing the password ends every login.`); a refusal is toasted.
  - Code (TOTP): "set up" or "not set up"; Set up / Set up again → `totp-begin` → the `Qr` of the URI (`className="access-qr"`), the key as `groupKey(secret)` text, a code input (`inputMode="numeric"`, `autocomplete="one-time-code"`) and Check → `totp-confirm`; the secret is dropped from the component's state once confirmed or closed; setting it up again says first that it ends every login.
  - Passkeys: one row each (label, added, last used or "not used yet"), Remove with two clicks; under them the hint (**exact**): en `Passkeys are added on the device: open https://{domain} there, sign in with password and code, then Add a passkey.` ru `Ключи доступа добавляются на самом устройстве: откройте там https://{domain}, войдите паролем и кодом, затем «Добавить ключ доступа».`
  - A lockout: `Sign-in with password and code is locked until {when}` with Lift.
- **Active logins** (`.access-logins`): one row each: label, method (`passkey` / `password and code`), signed in, last active (`ago`), address, End (two clicks); End all (two clicks) when there is one; then "Recent failed attempts": when, address, label, reason (`wrong` / `locked` / `limited` as words).
- Times through the board's `ago` (`web/src/models/card.ts`) and short times as the other panels show them.

- [ ] **Step 1: Write the failing test** `test/web/access-login.test.tsx`:
  - nothing set up: "not set" for both, no passkey rows, the hint with the domain;
  - set up, two passkeys, one used, a lockout: two rows with Remove, the lockout line with Lift;
  - two logins and three attempts: the rows' texts, End and End all, the reasons as words; in Russian too;
  - live: Change password asks with `Changing the password ends every login.` and posts `{ op: 'password', password }`; Set up → `totp-begin` answered `{ ok: true, secret: SECRET_B32, uri }` → one `svg.access-qr` and `GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ` shown; Check posts `{ op: 'totp-confirm', code: '123456' }`; Remove twice posts `{ op: 'passkey-remove', id }`; End twice posts `{ op: 'login-end', id }`; End all twice posts `{ op: 'logins-end-all' }`; Lift posts `{ op: 'lockout-lift' }`;
  - the password input has `type="password"` and `autocomplete="new-password"`.
- [ ] **Step 2: Run** `bun test test/web/access-login.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** both sections, `groupKey`, the CSS and the keys.
- [ ] **Step 4: Run** it and `bun test test/web/access-panel.test.tsx`: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add web/src/components/access web/src/models/access.ts web/styles/access.css src/core/i18n/access-strings.ts test/web/access-login.test.tsx
git commit -m "Set the password and the code, list passkeys and end logins from the Remote access panel"
```

---

### Task 18: Signing in through the domain (web)

**Spec:** "What the owner sees" (2–4), "The page through the domain" (the login screen, offline texts, "Add a passkey for this device", iOS), "Passkeys" (added on the device, the fresh code), Calls 15, 21, 24, 27, 34.

**Files:**
- Create: `web/src/components/remote/LoginScreen.tsx`, `web/src/models/passkey.ts`, `web/src/models/login.ts`
- Modify: `web/src/components/remote/RemoteGate.tsx`, `web/src/models/remote-page.ts`, `web/src/models/settings-menu.ts`, `web/src/hooks/useSettingsMenu.ts`, `web/styles/pwa.css`, `src/core/i18n/access-strings.ts`
- Test: `test/web/login-screen.test.tsx`, `test/web/passkey.test.ts`, `test/web/remote-page.test.ts`, `test/web/settings.test.tsx`

**Interfaces:**
- Consumes: the tunnel listener's routes (Task 12) and their answers; `UNPAIRED`, `helloOf`, `keepLanguage`.
- Produces:
  ```ts
  // web/src/models/remote-page.ts
  export interface PhoneHello { /* today's */ auth: 'pair' | 'login'; signedIn: boolean }   // auth 'pair' unless hello says 'login'
  export function keptAuth(): 'pair' | 'login' | null
  export function keepAuth(auth: 'pair' | 'login'): void
  // web/src/models/passkey.ts (no node: import)
  export function toB64url(bytes: ArrayBuffer | Uint8Array): string
  export function fromB64url(text: string): ArrayBuffer
  export function requestOptions(json: unknown): PublicKeyCredentialRequestOptions | null
  export function creationOptions(json: unknown): PublicKeyCredentialCreationOptions | null
  export function assertionJson(cred: PublicKeyCredential): Record<string, unknown>     // { id, rawId, type, response: { clientDataJSON, authenticatorData, signature, userHandle } }
  export function attestationJson(cred: PublicKeyCredential): Record<string, unknown>   // { id, rawId, type, response: { clientDataJSON, attestationObject, transports } }
  export function passkeyMade(): boolean          // localStorage 'agent-board:passkey-made'
  export function markPasskeyMade(): void
  // web/src/models/login.ts
  export type LoginNote = { kind: 'wrong' } | { kind: 'locked'; until: number } | { kind: 'limited'; retryAfterS: number } | { kind: 'failed'; why: string }
  export function loginNote(status: number, body: unknown, retryAfter: string | null): LoginNote | null   // null for 200
  // settings-menu.ts: SettingsNow gains signOut?: boolean → { id: 'signout', label: t('set.signOut') } last, after a separator; SettingPick { kind: 'signout' }
  // useSettingsMenu.ts: signOut: () => remotePage() && keptAuth() === 'login'; picking it posts /api/logout, then dispatchEvent(new Event(UNPAIRED))
  ```

**Rules:**
- **RemoteGate:** a hello with `auth: 'login'` → `keepAuth('login')`; `signedIn` → the board, else the login screen. Pairing stays as it is for `auth` absent (`'pair'`). The `UNPAIRED` event re-checks (an ended login goes back to the login screen). Offline with `keptAuth() === 'login'`: `offline.aboutDomain` (en `The computer may be asleep, or the board closed. This page tries again by itself.`) instead of the Tailscale text; refused (403) with it: `login.refused` (en `This address does not reach the board.`).
- **Login screen** (`phone-screen` / `phone-card` parts, `AppIcon`):
  - title `login.title` (en `Sign in to the board`);
  - "Sign in with a passkey" first, a primary button, when `window.PublicKeyCredential` exists: `POST /api/login/passkey/options` → `navigator.credentials.get({ publicKey: requestOptions(json) })` → `POST /api/login/passkey` with `assertionJson` → 200: the board;
  - "Use password and code" opens a `<form>`: a hidden `<input name="username" autocomplete="username" value="owner">`, a password input `autocomplete="current-password"`, a code input `inputMode="numeric"`, `autocomplete="one-time-code"`, Sign in; `POST /api/login/password { password, code }`;
  - a failure shows one note (`role="status"`): `wrong` → `login.wrong` (**exact** en `Wrong password or code.` ru `Неверный пароль или код.`), `locked` → `login.locked` with the time, `limited` → `login.limited` with the seconds, a cancelled passkey → nothing, anything else → `login.failed` with the reason;
  - after a password sign-in, when `!passkeyMade()` and `PublicKeyCredential` exists: the offer step: `login.addTitle` (en `Add a passkey for this device`), the note (**exact**, Call 34) en `Enter the next code: the one you signed in with works once only.` ru `Введите следующий код: тот, с которым вы вошли, срабатывает только один раз.`, a code input, Add and Not now; Add: `POST /api/login/passkey/add/options { code }` (403 → `login.wrongCode`, en `That is not the next code.`) → `navigator.credentials.create({ publicKey: creationOptions(json) })` → `POST /api/login/passkey/add` with `attestationJson` → `markPasskeyMade()` → the board. Not now → the board.
  - `pair.install`'s line under the card when not standalone, as the pairing screen has it.
- **pwa.css:** the login screen's own rules (the form's fields, the offer step), class selectors only.
- **Sign out:** `set.signOut` en `Sign out` ru `Выйти`.

- [ ] **Step 1: Write the failing tests.**
  `test/web/passkey.test.ts`: `toB64url([0xfb, 0xff, 0x00])` → `-_8A`, `fromB64url('-_8A')` back to those bytes; `requestOptions` turns `challenge` into an ArrayBuffer and keeps `rpId`, `userVerification: 'required'`, `timeout`; `creationOptions` turns `challenge`, `user.id` and each `excludeCredentials[].id` into ArrayBuffers and keeps the rest; both return null for a body without `challenge`; `assertionJson`/`attestationJson` of fake credential objects give base64url strings.
  `test/web/remote-page.test.ts`: `helloOf({ board: 'agent-board', auth: 'login', signedIn: true, language: 'ru' })` → `auth: 'login'`, `signedIn: true`; a hello without `auth` → `'pair'`, `signedIn: false`; `keepAuth`/`keptAuth` round-trip.
  `test/web/settings.test.tsx`: `signOut: true` → the last item `{ id: 'signout', label: 'Sign out' }`; without it the ids are today's; `settingPicked('signout')` → `{ kind: 'signout' }`.
  `test/web/login-screen.test.tsx`:
  - the screen's markup: the passkey button before "Use password and code"; the form's three inputs with `autocomplete` `username`, `current-password`, `one-time-code`, the code's `inputMode="numeric"`;
  - `loginNote(401, { ok: false, error: 'wrong' }, null)` → `wrong`; `(423, { error: 'locked', until: 5 }, null)` → `locked`; `(429, { error: 'limited' }, '30')` → `limited` 30; 200 → null;
  - live with a fake `fetch`: a 401 shows `Wrong password or code.`; a 200 for a password sign-in with `passkeyMade()` false shows `Add a passkey for this device` and the exact note; Not now gives the board (the gate's child drawn); with `passkeyMade()` true it goes straight to the board;
  - RemoteGate: hello `auth: 'login'`, `signedIn: false` → the login screen; `signedIn: true` → the board; offline with `keptAuth() === 'login'` → the domain's offline text.
- [ ] **Step 2: Run** `bun test test/web/login-screen.test.tsx test/web/passkey.test.ts test/web/remote-page.test.ts test/web/settings.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the models, the screen, the gate's second way in, Sign out, the CSS and the keys.
- [ ] **Step 4: Run** them and `bun test test/web/styles.test.ts test/web/style-attributes.test.ts test/core/pwa.test.ts test/server/pwa.test.ts`: PASS. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add web/src/components/remote/LoginScreen.tsx web/src/models/passkey.ts web/src/models/login.ts web/src/components/remote/RemoteGate.tsx web/src/models/remote-page.ts web/src/models/settings-menu.ts web/src/hooks/useSettingsMenu.ts web/styles/pwa.css src/core/i18n/access-strings.ts test/web/login-screen.test.tsx test/web/passkey.test.ts test/web/remote-page.test.ts test/web/settings.test.tsx
git commit -m "Sign in through the domain with a passkey or a password and code, add a passkey on the device, and sign out"
```

---

### Task 19: The README

**Spec:** "The server" (the README section and its steps), "What this does not cover: the terminal", "Anti-goals" (claiming more than the board does is a failure), "Constraints"; Task 1's results (any fallback it found).

**Files:**
- Modify: `README.md`
- Test: `test/core/tunnel-snippets.test.ts` (the README's snippets are the panel's)

**Interfaces:**
- Consumes: the behaviour of Tasks 2–18; `serverCommands`, `sshdBlock`, `caddyfile`, `keysLine` (Task 3).

- [ ] **Step 1: Write the failing test** in `test/core/tunnel-snippets.test.ts`: `README.md` contains `serverCommands('boardtunnel', TUNNEL_SOCKET)`, `sshdBlock('boardtunnel')` and `caddyfile('board.example.com', TUNNEL_SOCKET)` verbatim, the line `restrict,port-forwarding ssh-ed25519 AAAA… agent-board@<PC>`, and the heading `## Another computer or a tablet, through your own domain`.
- [ ] **Step 2: Run** `bun test test/core/tunnel-snippets.test.ts`. Expected: FAIL (no such section).
- [ ] **Step 3: Edit `README.md`** in the voice of the sections around it:
  - **New section** `## Another computer or a tablet, through your own domain`, right after `### In a phone's browser` (before `## Language`):
    - what it is: the board in any browser at `https://<domain>`, installable as an app, through a reverse SSH tunnel the board keeps open from this PC to your own server, with Caddy in front; no Tailscale, no other platform in the path; the PC opens no port;
    - the picture (the spec's diagram) and why a Unix socket (only Caddy reaches it, no port to take while the tunnel is down);
    - **what a login reaches**, plainly: the board as a phone has it, and the terminal, a shell on this PC with your rights; through it, or a session it starts, a login can read and change anything you can, the board's own files included; the board's routes do not serve its own files (state folder, config folder, the key's folder) through the domain, and that is all they guarantee; so the login is a passkey or a password and a code, with a lockout, 30-day logins and End / End all;
    - on the server (the panel shows the same with your values, each with Copy): 1. DNS; 2. the user and the socket's folder (`serverCommands`), with Task 1's fallbacks if it found any (`usermod -p '*'`, the group variant); 3. the keys file and its line; 4. the sshd `Match` block (`sshdBlock`), then `sudo sshd -t` and reload sshd; 5. the Caddyfile (`caddyfile`), reload Caddy, and why no `encode` in front of the board; 6. firewall: 22, 80, 443 only; 7. nginx, folded into a short paragraph with the headers it needs;
    - on the PC: Settings → Remote access…: the fields, Generate key (the line to paste), Test connection with the tunnel off, the server's key fingerprint to compare with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server, the password and the code (an authenticator app), On;
    - on the tablet: open the domain, "Use password and code", then "Add a passkey for this device" with the next code; Share → Add to Home Screen or Install app;
    - how it keeps itself up (sleep, network change, restarts, the stale socket replaced) and how it says so (status, the warning when the domain does not reach this board), `board tunnel`, `board tunnel on|off|test`, `board doctor`;
    - recovery: no codes, no e-mail; the local board sets a new password or code and lifts a lockout;
    - limits: one tunnel, one PC per domain; the Android app stays on Tailscale.
  - **`## Settings`**: the `tunnel` object and each field (`on`, `host`, `sshPort`, `user`, `key`, `socket`, `domain`, `port`), with their defaults.
  - **`## Agents`** (or wherever `board remote` is listed): `board tunnel [on | off | test]`.
  - **`## Development`**: the new modules in the layout list (`core/tunnel.ts`, `core/tunnel-snippets.ts`, `core/totp.ts`, `core/access.ts`, `core/webauthn.ts`, `core/own-files.ts`, `adapters/ssh.ts`, `adapters/access-store.ts`, `services/access.ts`, `services/tunnel.ts`, `server/tunnel.ts`), and the env variables `BOARD_SSH_BIN_PATH`, `BOARD_SSH_KEYGEN_BIN_PATH`, `BOARD_TUNNEL_PROBE_ORIGIN`.
- [ ] **Step 4: Run** the test: PASS. `git diff --stat` touches only `README.md` and the test. `bun test`, `bun run check`: green.
- [ ] **Step 5: Commit**
```bash
git add README.md test/core/tunnel-snippets.test.ts
git commit -m "Describe remote access through your own domain in the README: the server's setup, the panel, and what a login reaches"
```

---

## After the last task (the owner, by hand)

The spec's "Manual run on the owner's machine and server", in this order:
1. Set up the server from the README; `ls -l` shows `srw-rw---- boardtunnel caddy` in a `drwxr-s--- boardtunnel caddy` folder once the tunnel is on.
2. Generate key, then Test connection with the tunnel off and on; each failure once: a wrong key, a wrong socket path in Caddy, the default mask that shuts Caddy out, a changed host key.
3. Pull the PC's network for a minute: the tunnel is back as soon as the network is (the stale socket replaced).
4. On an iPad: password + code, add a passkey (Face ID) with the next code, sign in with it, install on the home screen. An Android tablet; another Windows PC with Windows Hello; the domain on the PC itself.
5. From the tablet: the quick look of a file in the state folder and of config.json is refused; of an attached picture, shown.
6. Sleep and wake the PC; switch networks; change the board's code while a tablet is open.
7. End and End all while the terminal is open on the tablet; a lockout, then Lift on the PC.
8. Phones over Tailscale still working beside it.

---

# Part 2: Setting up the server from the board (Tasks 20–25)

**Goal:** From a server with the tunnel user in place and Test connection passing, one Look, one plan and one Apply give `https://<domain>` serving the board, on Debian and Ubuntu, with Undo and "Do it myself" as the full alternative.

**Architecture:** Pure core: Look's scripts and parsers (`server-look.ts`), the per-case texts (`server-texts.ts`), the case, plan, record and Undo (`server-plan.ts`), the run script and "Do it myself" rendered from one plan (`server-script.ts`), the admin ssh line and sudo (`server-admin.ts`). One adapter function runs a remote command with the sudo password on stdin. One service (`services/server-setup.ts`) does Look, Apply and Undo behind local-only ops of `POST /api/access`. The panel's "On the server" draws it.

**Spec:** `docs/superpowers/specs/2026-10-21-remote-tunnel-server-setup-design.md` (its numbered Calls are part of it; "Decided with the owner" overrides the Calls).

## Constraints for Tasks 20–25 (on top of the Global Constraints above)

- **Worktree:** `C:/migo/development/projects/external/mokuhub/herdr-agent-board/.claude/worktrees/rt-setup`, branch `rt/setup` (replaces the Global Constraints' worktree line for this part). Commit locally, never push.
- **Never the owner's real server.** No ssh, HTTP or DNS lookup to any host but containers on this PC's Docker Desktop (`127.0.0.1` ports, Docker networks). The Global Constraints' "never run the real ssh" holds for unit, service and web tests; only Task 20 and the integration tests of Task 25 run Windows' real `ssh.exe`, and only at those containers.
- **Docker Desktop** is started by the controller. A task that finds `docker info` failing stops and reports NEEDS_CONTEXT.
- **Certificates:** Pebble (with `pebble-challtestsrv`) in Docker only, never Let's Encrypt or another public CA. The board's Caddyfile names a CA only through the test-only env `BOARD_SETUP_ACME_CA` (directory URL) and `BOARD_SETUP_ACME_CA_ROOT` (a PEM path on the server, mounted read-only into the board's Caddy). Unset: no `acme_ca` line at all.
- **Debian and Ubuntu together, from the start.** Every task that reads, runs on or matches output from the server covers **Debian 13** (sudo, GNU coreutils) and **Ubuntu 26.04** (sudo-rs, Rust coreutils) side by side, with fixtures from both; the integration tests add **Ubuntu 24.04** (classic sudo). Debian 12 and Ubuntu 22.04 go through the same code paths (images only if cheap). Supported list: Debian 12, 13; Ubuntu 22.04, 24.04, 25.10, 26.04. Anything else is "Do it myself".
- **Server scripts:** POSIX `sh`, no bashisms; only coreutils flags GNU and Rust coreutils both take (`base64 -d`, `sha256sum`, `stat -c`, `install`, `timeout`, `wc -l`, `sed -n`, `sort`, `comm`), plus util-linux `flock`, `setsid`, `runuser`; never `tail -f --pid`. Every script's first line is `exec </dev/null`; its second a marker comment `# agent-board: <kind>` (`probe`, `look-1`, `look-2`, `launch`, `run`). Task 20's record wins where it lists other flags.
- **The sudo password** reaches only ssh's stdin, once per request. Never argv, env, a file, `web.log`, the view, the payload, an answer or an error text, on the PC or the server. Tests use the sentinel ``S3cr3t%$'"`Ж`` and assert it appears nowhere but the fake's stdin log, exactly once.
- **Layers:** `src/core/server-*.ts` have no `node:` import (the page renders "Do it myself" from them). Web code imports core only.
- **Texts:** new keys in English and Russian in `src/core/i18n/server-strings.ts` (Task 22 creates it and merges it in `strings.ts` after `ACCESS_STRINGS`); later tasks append. Commands and the server's files are English only.
- **Integration tests** run only with `BOARD_SERVER_IT=1` (test servers) or `BOARD_DOCKER_IT=1` (two proxies); otherwise each file's `describe` is skipped and plain `bun test` starts no container.
- **Verify per task:** only that task's own test files (listed in its last step) and `bun run check`. No full `bun test` per task; the controller runs the whole suite once after Task 25.
- **Parallel tasks:** tasks in one wave may run in separate worktrees. Shared files are named in each task's "Shared" line; edits there are additive (append keys, add a field), so merges stay trivial. `src/core/server-facts.ts` and `src/core/server-shell.ts` are created by Task 20 and by Task 22 with the identical text below, so either order merges cleanly.

### Shared files (verbatim; Tasks 20 and 22 both create them)

`src/core/server-shell.ts`:

```ts
// Shell words for the server's scripts. No node: import.
/** One shell word: '…' with ' as '\''. Throws on a newline or NUL: callers check values first. */
export function shQuote(s: string): string {
  if (/[\n\r\0]/.test(s)) throw new Error('a newline or NUL cannot reach the server')
  return `'${s.replaceAll("'", `'\\''`)}'`
}
export const isContainerId = (s: string): boolean => /^[0-9a-f]{64}$/.test(s)
/** Absolute, with no newline, NUL or `..` part. */
export const isPlainPath = (s: string): boolean =>
  s.startsWith('/') && !/[\n\r\0]/.test(s) && !s.split('/').includes('..')
export const isUnitName = (s: string): boolean => /^[A-Za-z0-9@._-]+\.service$/.test(s)
```

`src/core/server-facts.ts`:

```ts
// What Look found on a server. Types only, no node: import: Task 20 parses into these, Task 22 plans from them.
export type Port = 80 | 443 | 8443 | 8480 | 8481
export type Holder =
  | { kind: 'free' }
  | { kind: 'unit'; unit: string; program: string }
  | { kind: 'container'; id: string; program: string }
  | { kind: 'process'; program: string }
  | { kind: 'split'; programs: string[] }
export interface Distro { id: string; version: string; codename: string; arch: string; supported: boolean }
export interface Network { name: string; driver: string; userDefined: boolean }
export interface Mount { type: 'bind' | 'volume'; source: string; destination: string }
export interface Container {
  id: string
  name: string
  image: string
  cmd: string[]
  hostNetwork: boolean
  networks: Network[]
  mounts: Mount[]
  ports: { private: number; public: number; ip: string }[]
  labels: Record<string, string>
}
export interface Unit { execStart: string[]; execReload: string[]; user: string; group: string; active: string; workingDirectory: string }
export interface DockerFacts { version: string; podman: boolean; rootless: boolean; userns: boolean; containers: Container[] }
export interface HostFacts {
  selinux: 'enforcing' | 'permissive' | 'disabled' | null
  forwarding: boolean
  forwarders: string[]
  fetch: 'curl' | 'wget' | null
  missing: string[]
  sudo: 'sudo' | 'sudo-rs' | null
  coreutils: 'gnu' | 'rust' | null
  conflicts: string[]
}
export interface RoundOne {
  distro: Distro
  ports: Record<Port, Holder>
  docker: DockerFacts | null
  systemd: boolean
  units: { caddy: Unit | null; nginx: Unit | null }
  fence: Record<string, string>
  folder: { mode: string; owner: string; group: string; gid: number; members: string[] } | null
  socket: { mode: string; owner: string; group: string } | null
  record: unknown
  lockHeld: boolean
  host: HostFacts
  dns: { domain: string[]; local: string[] }
}
export interface CaddyFacts {
  where: 'unit' | 'container'
  container: string | null
  config: string
  hostPath: string | null
  mount: 'file' | 'folder' | 'volume' | null
  adapter: string
  resume: boolean
  version: string
  hosts: string[]
  adminOff: boolean
  autoHttpsOff: boolean
  sha256: string
  endsWithNewline: boolean
  address: string
}
export interface NginxFacts { confD: boolean; listen80: string[]; serverNames: string[] }
export interface ServerFacts extends RoundOne { caddy: CaddyFacts | null; nginx: NginxFacts | null }
```

## Review Focus (Tasks 20–25)

1. **sudo-rs on Ubuntu 26.04 with a wrong password:** one attempt, its own lines give the `wrongPassword` hint, no retry, the password in no output. → Task 23 (both flavours' recorded lines), Task 25 (Ubuntu 26.04 image).
2. **Their Caddyfile ending in a brace-less site, or mounted as a single file:** validate fails, nothing reloaded, their file's hash as before; a file mount sees the in-place write. → Task 22 (script order), Task 25 (scenarios).
3. **The PC loses the connection mid-Apply:** the run finishes or rolls back on the server; the panel says "Look again"; the next Look reads the result. → Task 23 (service), Task 25 (cut ssh).
4. **Their paths and names with spaces, quotes, `$`, `%` or Cyrillic** (a compose folder `/srv/my web/`, a network `web_default`): one shell word each in every script. → Task 20 (`shQuote`), Task 22 (scripts use it).
5. **Another board's record on the server vs this board's with a new domain:** the first stops with that record's pair; the second plans an update. → Task 22 (`whose`), Task 23 (Look's answer).

## Waves

| Wave | Tasks (parallel) | Needs merged |
|---|---|---|
| 1 | 20 Spike and Look's parsers · 21 Public port and step 1 · 22 Apply and Undo, every case (core) | nothing |
| 2 | 23 The admin connection, Look, Apply and Undo (service) · 24 The panel's "On the server" | 20, 21, 22 |
| 3 | 25 Test servers end to end, the two-proxies proof, the README | 23, 24 (its images, Pebble harness and two-proxies proof may start after 22) |

Before Task 20, a comment on issue #154 says this part is being built, and by whom (AGENTS.md).

---

### Task 20: Spike on Debian 13 and Ubuntu 26.04, and Look's scripts and parsers (core)

**Spec:** "Look: what the board reads" (both rounds, Call 9), "Choosing the case" (the facts it needs), "The socket's permissions", "sudo", "Installing Docker", "Risks"; the owner's OS decision.

**Files:**
- Create: `test/integration/server/debian13.Dockerfile`, `ubuntu2604.Dockerfile`, `ubuntu2404.Dockerfile` (systemd as PID 1, openssh-server, sudo, curl, ca-certificates; users `admin` (sudo with password `admin-pw`), `nopw` (NOPASSWD), key login for both and for root; build arg `DOCKER=1|0` installs Docker CE from Docker's repository or not); `test/integration/server/scenarios/<name>.sh` (each prepares one scenario inside a running server, as root; names below); `src/core/server-facts.ts` and `src/core/server-shell.ts` (the shared files, verbatim); `src/core/server-look.ts`; `test/fixtures/server-look/{debian13,ubuntu2604}/<scenario>/{round1,round2}.txt`; `test/fixtures/server-look/hand/*.txt` (Podman, rootless, userns `docker info`; garbled outputs); `test/core/server-shell.test.ts`; `test/core/server-look.test.ts`
- Modify: the spec (a "Checked by the spike" block at the end of "Risks and things to watch")
- Shared: none.

**Scenarios** (all on both distributions): `bare` (Docker, nothing on the ports), `nodocker`, `dummy80` (a `python3 -m http.server 80` unit), `caddy-unit` (Caddy from the distribution's package, two sites), `compose-folder` and `compose-file` (official Caddy image in compose on a user network `web_default`, a folder and a single-file mount of the Caddyfile, compose folder `/srv/my web`), `caddy-host` (`network_mode: host`), `caddy-bridge` (default bridge only), `nginx-443` (nginx on 443 alone), `nginx-80-443` (host nginx with `conf.d` included), `apache` (Apache on 80 and 443). Step 1 is done in each as the design's "By hand" commands.

**Interfaces:**
- Produces:
  ```ts
  // src/core/server-shell.ts: the shared file (shQuote, isContainerId, isPlainPath, isUnitName)
  // src/core/server-look.ts
  export const SUPPORTED: Record<'debian' | 'ubuntu', string[]>   // { debian: ['12','13'], ubuntu: ['22.04','24.04','25.10','26.04'] }
  export const DOCKER_CODENAMES: string[]                          // bookworm, trixie, jammy, noble, questing, resolute
  export interface LookInput { user: string; socket: string; domain: string }
  export function lookScript1(i: LookInput): string
  /** null: garbled, cut, a section missing or twice ("Look could not read the server"). */
  export function readRoundOne(out: string): RoundOne | null
  /** The second round for 443's (and 80's) holder; null when nothing needs it. Values from round one narrowed and shQuoted. */
  export function lookScript2(r: RoundOne, i: LookInput): string | null
  export function readServerFacts(r: RoundOne, out: string): ServerFacts | null
  /** The sshd -T keys the tunnel spec's Match block sets that differ from sshdBlock(user)'s. */
  export function fenceDiff(fence: Record<string, string>, user: string): string[]
  ```
- Output format of both rounds: `@@section <name>` lines (`os`, `ports`, `docker`, `systemd`, `fence`, `folder`, `record`, `host`, `dns`; round two `caddy`, `nginx`), each section's raw lines under it, `@@end` last. Their config's text never leaves the server: `caddy adapt`'s JSON is reduced on the server with `grep -o` to the `"host":[…]` arrays, `"admin":{"disabled":true}` and `"automatic_https":{"disable":true}`; `nginx -T` to `include`, `listen`, `server_name` lines.

- [ ] **Step 1: Docker.** `docker info`; failing → NEEDS_CONTEXT (Constraints).
- [ ] **Step 2: Build and start** the Debian 13 and Ubuntu 26.04 images side by side (`--privileged --cgroupns=host`, sshd on `127.0.0.1:2213` and `127.0.0.1:2226`), and each scenario in turn. Windows' `C:\Windows\System32\OpenSSH\ssh.exe` with a scratch key and a scratch `known_hosts` (pinned as `[127.0.0.1]:<port>`).
- [ ] **Step 3: Check the facts, on both**, and note each result (exact lines, exit codes):
  - the tunnel's folder with the tunnel user's own group (`useradd --system --user-group`, `usermod -p '*'`, `install -d -m 2750 -o boardtunnel -g boardtunnel`): a Windows `ssh -R` socket is `srw-rw---- boardtunnel boardtunnel`; a container root with `--cap-drop ALL --group-add <gid>` and the folder mounted `:ro` opens it, without `--group-add` it cannot; after a reconnect (new inode) it opens the new one; `chgrp caddy` + `chmod 2750` keeps setgid; the design's step-1 commands pasted twice give no error the second time; `sshd -t` and `systemctl reload ssh` (or `sshd`) work;
  - host Caddy (`caddy-unit`): `import /etc/caddy/agent-board/board.caddy # agent-board` passes `caddy adapt` and `runuser -u caddy -- caddy validate`; appended after a brace-less last site it fails (the lines); `systemctl reload caddy`; the `grep -o` reductions of `caddy adapt` on the distribution's Caddy version;
  - Caddy in Docker: `cat new > Caddyfile` reaches a file-mounted container, `mv` does not; `docker exec <id> caddy reload --config … --adapter caddyfile`; `alpine/socat` with `--user 65534:<gid> --read-only --cap-drop ALL` on `web_default` reaches the socket and their Caddy reaches it by name; `docker compose down` with the helper on the network: its output and exit code; a host-network container's pid → its id through `/proc/<pid>/cgroup`; `ss -H -ltnp` with Docker's userland proxy on and off;
  - ACME through Pebble on a Docker network (challtestsrv resolving the test domain to the server): the board's Caddy for case 1 (HTTP-01), 1b (`disable_http_challenge`, TLS-ALPN only), 4b (HTTP-01 through host nginx's `conf.d/agent-board.conf`, with 4b's check path) get certificates with `acme_ca` and `acme_ca_root` set;
  - the two proxies, quickly: their Caddy on 443 with the marked block to the helper, and their nginx on 443 with the board's Caddy on 8443, both answering at once (`curl --resolve`); the full proof is Task 25;
  - sudo over the admin line (design "The ssh line", `-T`, `StrictHostKeyChecking=yes`): the remote command `sudo -S -p '' -- sh -c 'eval "$(echo <b64> | base64 -d)"'` arrives unchanged; the password on stdin, then stdin closed, is read; the lines and exit codes of `sudo -n true` without NOPASSWD, a wrong password, `requiretty` (Debian 13's sudo only; note sudo-rs's answer), not in sudoers; `sudo --version`'s first line. **sudo-rs on Ubuntu 26.04 and sudo on Debian 13, each verbatim**;
  - coreutils: on Ubuntu 26.04, that `stat -c '%a %U %G %g'`, `base64 -d`, `sha256sum`, `install -d -m 2750 -o -g`, `timeout -k`, `wc -l`, `sed -n`, `comm`, `sort -u` behave as GNU's; what `tail -f --pid` does there (recorded only); `ls --version`'s first line on each;
  - Docker's repository: `https://download.docker.com/linux/{debian,ubuntu}/dists/<codename>/Release` exists for each of `DOCKER_CODENAMES`; the design's install commands on the `nodocker` server of each distribution, the fingerprint line included (and how to check it without `gpg`);
  - the pins: the current Caddy 2 release and `alpine/socat`, each as `tag@sha256:…` (`docker buildx imagetools inspect`).
  Anything that contradicts the design: record it, and say so in the report.
- [ ] **Step 4: Write the two shared files verbatim and `test/core/server-shell.test.ts`**: `shQuote("it's")` → `'it'\''s'`; ``shQuote('a b%$`"Ж')`` → ``'a b%$`"Ж'``; `shQuote('a\nb')` throws; `isContainerId` true for 64 hex, false for 63, uppercase, or `abc;rm`; `isPlainPath('/srv/my web/Caddyfile')` true, `'srv/x'`, `'/a/../b'`, `'/a\nb'` false. Run `bun test test/core/server-shell.test.ts`: PASS.
- [ ] **Step 5: Write Look's two scripts**, run them over the admin line (`sudo -S`) in every scenario on both servers, and save each output as `test/fixtures/server-look/<distro>/<scenario>/round1.txt` (and `round2.txt` when `lookScript2` is not null). Write the hand fixtures (Podman's, rootless', userns' `docker info`; a round one cut in half; one with `@@section ports` twice).
- [ ] **Step 6: Write the failing parser tests** `test/core/server-look.test.ts`, each on both distributions unless named:
  - `bare`: `distro` `{ id: 'debian', version: '13', codename: 'trixie', supported: true }` / `{ id: 'ubuntu', version: '26.04', codename: 'resolute', supported: true }`; every port `free`; `docker` not null; `host.sudo` `'sudo'` / `'sudo-rs'`; `host.coreutils` `'gnu'` / `'rust'`; `fenceDiff(fence, 'boardtunnel')` `[]`; `folder` `{ mode: '2750', owner: 'boardtunnel', group: 'boardtunnel' }` with a numeric gid; `record` null; `host.missing` `[]`;
  - `nodocker`: `docker` null; `caddy-unit`: `ports[443]` `{ kind: 'unit', unit: 'caddy.service', program: 'caddy' }`, `units.caddy.execStart` holds `--config` and `/etc/caddy/Caddyfile`, `caddy` `{ where: 'unit', config: '/etc/caddy/Caddyfile', hostPath: '/etc/caddy/Caddyfile', hosts: [the two sites], adminOff: false, autoHttpsOff: false }`, `sha256` 64 hex;
  - `compose-file` / `compose-folder`: `ports[443].kind` `container` with a 64-hex id; `caddy.mount` `file` / `folder`, `hostPath` `/srv/my web/Caddyfile`; a network `{ name: 'web_default', userDefined: true }`; compose labels kept;
  - `caddy-host`: `hostNetwork` true, the holder found through the cgroup; `caddy-bridge`: only `{ name: 'bridge', userDefined: false }`; `nginx-80-443`: both ports `nginx.service`, `nginx` `{ confD: true }` with its `listen80`; `apache`: 443's program `apache2`; `dummy80`: 80 `process` or `unit` with program `python3`, 443 `free`;
  - hand: Podman, rootless, userns each set its flag; the cut and the doubled outputs → `readRoundOne` null; `''` → null;
  - `lookScript2` for a `compose-file` round one whose container id was edited to `abc` → null; with a config path `/srv/it's/Caddyfile` → the script holds `'/srv/it'\''s/Caddyfile'`;
  - `lookScript1` and every `lookScript2` write nothing: no match for `/\btee\b|\bmkdir\b|\binstall\b|\brm\b|\bmv\b|\bcp\b|docker (run|pull|start|stop|rm)|caddy validate|systemctl (reload|restart|start|stop)|>\s*\/(?!dev\/null)/`; first line `exec </dev/null`; second `# agent-board: look-1` / `look-2`;
  - `src/core/server-look.ts`, `server-shell.ts`, `server-facts.ts` have no `from 'node:`.
- [ ] **Step 7: Run** `bun test test/core/server-look.test.ts`: FAIL. Implement the parsers. Run `bun test test/core/server-look.test.ts test/core/server-shell.test.ts`: PASS. `bun run check`: clean.
- [ ] **Step 8: Record** in the spec, at the end of "Risks and things to watch": `**Checked by the spike (<date>, Debian 13 <sudo version>, Ubuntu 26.04 <sudo-rs version>, OpenSSH_for_Windows_<version>, Docker <version>):**`, one line per check of Step 3 with the exact lines (sudo's and sudo-rs's side by side), the pins, and anything that changes the design. Stop and remove the containers; keep the Dockerfiles and scenario scripts.
- [ ] **Step 9: Commit**
  ```bash
  git add test/integration/server src/core/server-facts.ts src/core/server-shell.ts src/core/server-look.ts test/fixtures/server-look test/core/server-shell.test.ts test/core/server-look.test.ts docs/superpowers/specs/2026-10-21-remote-tunnel-server-setup-design.md
  git commit -m "Read what a Debian or Ubuntu server runs on its web ports, its Docker and its Caddy without changing anything, as a trial server showed"
  ```

---

### Task 21: The board on another public port, and step 1 without Caddy's group

**Spec:** "Changes elsewhere in the board" (`tunnel.publicPort`, Call 17), "Step 1: by hand, once" (Calls 2, 3), "What this changes in the tunnel spec", "Nobody else notices".

**Files:**
- Modify: `src/core/tunnel.ts`, `src/server/tunnel.ts`, `src/adapters/probe.ts`, `src/server/app.ts` (the probe's origin), `src/services/remote-access.ts` (`FIELDS`), `src/core/access.ts` (the settings' narrowing), `web/src/models/access.ts` (`fieldEdit`), `web/src/components/access/TunnelSection.tsx` (the field), `src/core/tunnel-snippets.ts` (and its header comment), `web/src/components/access/Snippets.tsx` (header comment, the one-paste block, the `chgrp` line), `src/core/i18n/access-strings.ts`, `README.md` (step 2's commands, the `tunnel.publicPort` setting, "The board never touches the server"), `docs/superpowers/specs/2026-10-20-remote-tunnel-design.md` (the lines the server-setup spec lists)
- Test: `test/core/tunnel.test.ts`, `test/server/tunnel.test.ts`, `test/adapters/probe.test.ts`, `test/core/tunnel-snippets.test.ts`, `test/web/access-panel.test.tsx`
- Shared: `src/core/access.ts`, `src/services/remote-access.ts`, `src/core/i18n/access-strings.ts`, `README.md`, `web/src/components/access/*` (Task 24 edits them after).

**Interfaces:**
- Produces:
  ```ts
  // core/tunnel.ts: TunnelConfig gains publicPort: number | null (null: 443); TunnelField gains 'publicPort' (checked as sshPort)
  /** 'https://<domain>', or 'https://<domain>:<publicPort>' unless it is null or 443. */
  export function publicOrigin(c: TunnelConfig): string
  /** The Host the tunnel listener accepts: '<domain>' (and '<domain>:443'), or exactly '<domain>:<publicPort>'. */
  export function publicHosts(c: TunnelConfig): string[]
  // adapters/probe.ts
  export const probeOrigin = (c: TunnelConfig, env?: Record<string, string | undefined>): string   // BOARD_TUNNEL_PROBE_ORIGIN or publicOrigin(c)
  // core/tunnel-snippets.ts
  export function serverCommands(user: string, socket: string, group?: string): string            // group default: user
  export function stepOnePaste(user: string, socket: string, publicKey: string): string
  export function caddyGroupLine(socket: string): string   // 'sudo chgrp caddy <folder> && sudo chmod 2750 <folder>'
  ```

- [ ] **Step 1: Write the failing tests.**
  - `test/core/tunnel.test.ts`: `tunnelConfig(undefined).publicPort` null; `{ publicPort: 8443 }` kept, `'8443'` → null; `fieldProblem('publicPort', 0)` → `Public port is a whole number from 1 to 65535` (`tunnel.field.publicPort` en `Public port`); `publicOrigin` with null, 443, 8443 → `https://board.example.com`, `https://board.example.com`, `https://board.example.com:8443`; `publicHosts` → `['board.example.com', 'board.example.com:443']` / `['board.example.com:8443']`. The existing expectations of `tunnelConfig(undefined)` gain `publicPort: null` and nothing else.
  - `test/server/tunnel.test.ts` (new cases; the file's existing ones unchanged): with `publicPort: 8443`, Host `board.example.com:8443` and Origin `https://board.example.com:8443` reach `/api/hello` and a board route after login; Host `board.example.com` → 403 `{ error: 'host' }`; Origin `https://board.example.com` on a POST → 403 `origin`; a passkey registered through Host `board.example.com` (443) signs in through `:8443`.
  - `test/adapters/probe.test.ts`: `probeOrigin(conf8443, {})` → `https://board.example.com:8443`; with `BOARD_TUNNEL_PROBE_ORIGIN` → that.
  - `test/core/tunnel-snippets.test.ts`: `serverCommands('boardtunnel', TUNNEL_SOCKET)` is exactly
    ```
    sudo useradd --system --user-group --no-create-home --home-dir /nonexistent \
        --shell /usr/sbin/nologin boardtunnel
    # useradd leaves the account locked; an sshd with UsePAM no refuses a locked one, key or not
    sudo usermod -p '*' boardtunnel
    # the socket's folder: the tunnel user makes the socket; its group is the reader's (step 3)
    sudo install -d -m 2750 -o boardtunnel -g boardtunnel /var/lib/boardtunnel
    # the key's file belongs to root, out of the tunnel user's reach
    sudo install -d -m 755 /etc/ssh/authorized_keys
    ```
    and with `group 'caddy'` the install line says `-g caddy`; `stepOnePaste('boardtunnel', TUNNEL_SOCKET, 'ssh-ed25519 AAAA k')` is one `( set -e … )` block holding, in order: `id -u boardtunnel >/dev/null 2>&1 || sudo useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin boardtunnel`, `sudo usermod -p '*' boardtunnel`, `[ -d /var/lib/boardtunnel ] || sudo install -d -m 2750 -o boardtunnel -g boardtunnel /var/lib/boardtunnel`, `sudo install -d -m 755 /etc/ssh/authorized_keys`, `echo 'restrict,port-forwarding ssh-ed25519 AAAA k' | sudo tee /etc/ssh/authorized_keys/boardtunnel >/dev/null`, `grep -qx 'Match User boardtunnel' /etc/ssh/sshd_config || printf '\n%s\n' '<sshdBlock>' | sudo tee -a /etc/ssh/sshd_config >/dev/null`, `sudo sshd -t`, `{ sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd; }` (Task 20's record wins on the reload line); `caddyGroupLine(TUNNEL_SOCKET)` → `sudo chgrp caddy /var/lib/boardtunnel && sudo chmod 2750 /var/lib/boardtunnel`; the README check updated to the new `serverCommands`; the README no longer holds `The board never touches the server`.
  - `test/web/access-panel.test.tsx`: the Public port field is drawn; `fieldEdit('publicPort', null, '8443')` → `{ value: 8443 }`, `fieldEdit('publicPort', 8443, '')` → `{ value: null }`; the snippets show "All of step 1 in one paste" with `stepOnePaste`'s text and the `chgrp` line under the Caddy snippet; `-g boardtunnel` where `-g caddy` was.
- [ ] **Step 2: Run** `bun test test/core/tunnel.test.ts test/server/tunnel.test.ts test/adapters/probe.test.ts test/core/tunnel-snippets.test.ts test/web/access-panel.test.tsx`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** the field, its check and texts (Russian yours), `publicOrigin`/`publicHosts` in the listener's Host and Origin checks and WebAuthn's expected origin (rpId stays the domain), `probeOrigin(conf)` in `app.ts`, the snippets, the panel's field and blocks, the README lines and the tunnel spec's lines (verbatim from the server-setup spec's list).
- [ ] **Step 4: Run** the same files: PASS. `bun run check`: clean.
- [ ] **Step 5: Commit**
  ```bash
  git add src/core/tunnel.ts src/server/tunnel.ts src/adapters/probe.ts src/server/app.ts src/services/remote-access.ts src/core/access.ts web/src/models/access.ts web/src/components/access src/core/tunnel-snippets.ts src/core/i18n/access-strings.ts README.md docs/superpowers/specs/2026-10-20-remote-tunnel-design.md test/core/tunnel.test.ts test/server/tunnel.test.ts test/adapters/probe.test.ts test/core/tunnel-snippets.test.ts test/web/access-panel.test.tsx
  git commit -m "Let the board be reached through the domain on another port, and make step 1 on the server independent of Caddy and pastable at once"
  ```

---

### Task 22: Apply and Undo for every case (core)

**Spec:** "The cases" (1, 1b, 2, 3a, 3b, 4a, 4b, 5), "Choosing the case", "What the board owns on the server", "Whose setup it is" (Call 30), "Validation and rollback, per case", "Apply twice, changes, and interrupted runs", "How a script runs on the server" (detached run, markers, the POSIX follower), "Installing Docker", Calls 8, 10–22, 26–28, 31–33.

**Files:**
- Create: `src/core/server-facts.ts` and `src/core/server-shell.ts` (the shared files, verbatim, if not there), `src/core/server-view.ts`, `src/core/server-texts.ts`, `src/core/server-plan.ts`, `src/core/server-script.ts`, `src/core/i18n/server-strings.ts`, `test/support/server-facts.ts` (builders: `factsFor(c: SetupCase | 'bare' | 'nodocker', distro?: 'debian13' | 'ubuntu2604'): ServerFacts`), `test/core/server-texts.test.ts`, `test/core/server-plan.test.ts`, `test/core/server-script.test.ts`
- Modify: `src/core/i18n/strings.ts` (merge `SERVER_STRINGS`), `src/core/access.ts` (`AccessView.server: ServerView | null`, its narrowing), `src/services/remote-access.ts` (`view()` sends `server: null`), `web/src/models/access.ts` (`isAccessView` takes `server` null or an object)
- Shared: `src/core/access.ts`, `src/services/remote-access.ts`, `web/src/models/access.ts` (one field each).

**Interfaces:**
- Consumes: `ServerFacts`, `shQuote` (the shared files), `sshdBlock`, `socketFolder` (tunnel-snippets).
- Produces:
  ```ts
  // core/server-view.ts
  export type SudoMode = 'root' | 'nopasswd' | 'password' | 'requiretty' | 'none'
  export type AdminHint = 'publickey' | 'tooMany' | 'noHostKey' | 'hostKey' | 'needPassword' | 'wrongPassword' | 'requiretty' | 'notSudoer' | 'network' | 'noSsh' | 'aptLock' | 'pullLimit' | 'changed' | 'busy' | 'lost' | 'unreadable' | 'lookAgain'
  export type ServerPhase = 'idle' | 'looking' | 'plan' | 'applying' | 'undoing' | 'done' | 'failed'
  export interface ServerView {
    admin: { user: string; key: string }
    sudo: SudoMode | null
    phase: ServerPhase
    facts: ServerFacts | null
    choice: Choice | null
    plan: Plan | null
    progress: Progress | null
    hint: AdminHint | null
    error: string | null
    setup: { case: SetupCase; address: string; at: string } | null
    testAfter: TestStep[] | null
  }
  // core/server-texts.ts
  export const CADDY_IMAGE: string   // 'caddy:<2.x.y>@sha256:…' (Task 20's pin, else the current release's)
  export const SOCAT_IMAGE: string   // 'alpine/socat:<v>@sha256:…'
  export interface Acme { ca: string; root: string }   // BOARD_SETUP_ACME_CA, BOARD_SETUP_ACME_CA_ROOT
  export type OwnCaddy = '1' | '1b' | '4a' | '4b'
  export function boardCaddyfile(c: OwnCaddy, w: Wanted, acme?: Acme): string
  export function siteFile(w: Wanted): string                       // /etc/caddy/agent-board/board.caddy
  export const IMPORT_LINE = 'import /etc/caddy/agent-board/board.caddy # agent-board'
  export function markedBlock(w: Wanted, upstream: string): string   // 'agent-board-socket:8080' (3a) | '127.0.0.1:8481' (3b)
  export function nginxFile(w: Wanted, listen80: string[]): string
  export function caddyRunArgs(c: OwnCaddy, w: Wanted, gid: number, runId: string, acme?: Acme): string[]   // argv after `docker`
  export function socatRunArgs(on: { network: string } | { host: true }, w: Wanted, gid: number, runId: string): string[]
  export function dockerInstall(distro: 'debian' | 'ubuntu'): string[]
  // core/server-plan.ts
  export type SetupCase = '1' | '1b' | '2' | '3a' | '3b' | '4a' | '4b'
  export type Manual = 'os' | 'selinux' | 'podman' | 'rootless' | 'userns' | 'requiretty' | 'noSystemd' | 'dockerConflicts'
    | 'caddyJson' | 'caddyResume' | 'adminOff' | 'autoHttpsOff' | 'caddyBaked' | 'caddy1' | 'twoConfigs' | 'bridge' | 'macvlan'
    | 'domainServed' | 'split' | 'other80' | 'otherSetup' | 'interrupted'
  export interface Pair { user: string; socket: string }
  export interface Wanted extends Pair { domain: string; publicPort: number | null; acme?: Acme }
  export type Choice = { case: SetupCase; why: Text } | { case: null; why: Manual[] }
  export interface Text { key: string; params?: Record<string, string> }
  export interface Touch { kind: 'file' | 'line' | 'block' | 'backup' | 'container' | 'volume' | 'image' | 'package' | 'group' | 'reload' | 'network'; what: string }
  export type RecordItem =
    | { kind: 'file'; path: string; sha256: string }
    | { kind: 'line'; file: string; line: string }
    | { kind: 'block'; file: string; begin: string; end: string }
    | { kind: 'backup'; of: string; path: string }
    | { kind: 'group'; path: string; from: string; to: string }
    | { kind: 'container'; name: string; setup: string }
    | { kind: 'volume'; name: string }
    | { kind: 'image'; ref: string; before: boolean }
    | { kind: 'docker'; packages: string[]; files: string[] }
  export interface SetupRecord { v: 1; id: string; at: string; state: 'running' | 'applied' | 'rolled-back' | 'rollback-failed'; case: SetupCase; pair: Pair; domain: string; publicPort: number | null; address: string; items: RecordItem[] }
  export interface PlanStep { id: string; title: Text; why: Text; skipIf: string[]; commands: string[]; check: string[]; undo: string[]; touches: Touch[]; record: RecordItem[]; timeoutS: number }
  export interface Plan { id: string; kind: 'apply' | 'update' | 'undo' | 'nothing'; case: SetupCase; address: string; publicPort: number | null; relies: string[]; steps: PlanStep[]; undoTouches: Touch[]; warnings: Text[]; ticks: ('docker' | 'removeDocker' | 'removeEdited')[] }
  export function setupRecord(json: unknown): SetupRecord | null
  /** 'same': pair, domain and public port the panel's; 'update': the pair the same; 'other': another pair (Call 30). */
  export function whose(r: SetupRecord, w: Wanted): 'same' | 'update' | 'other'
  export function chooseCase(f: ServerFacts, w: Wanted): Choice
  export function buildPlan(f: ServerFacts, w: Wanted, o: { id: string; docker: boolean }): Plan | { case: null; why: Manual[] }
  export function undoPlan(r: SetupRecord, f: ServerFacts, o: { id: string; removeDocker: boolean; removeEdited: boolean }): Plan
  /** For "Do it myself" without Look (Call 28): facts whose unknowns are `<placeholders>`. */
  export function manualFacts(c: SetupCase, distro: 'debian' | 'ubuntu'): ServerFacts
  export function placeholderFinders(c: SetupCase): { placeholder: string; command: string }[]
  // core/server-script.ts
  export function runScript(p: Plan, w: Wanted, run: { id: string; at: string }): string
  /** What the admin line runs for Apply or Undo: writes runs/<id>.sh (0600) from base64, starts it with setsid, follows its log (POSIX), prints `@@exit <code>`. */
  export function launchScript(runId: string, run: string): string
  export interface StepProgress { n: number; id: string; state: 'waiting' | 'running' | 'ok' | 'fail' | 'skipped'; since: number | null; out: string[] }
  export interface Progress { steps: StepProgress[]; undo: { n: number; ok: boolean }[]; result: 'applied' | 'rolled-back' | 'rollback-failed' | 'busy' | 'changed' | null; exit: number | null }
  export function startProgress(p: Plan): Progress
  export function readProgress(pr: Progress, line: string, now: number): Progress
  export interface ManualBlock { title: Text; why: Text; commands: string; check: string; undo: string }
  export function doItMyself(p: Plan): ManualBlock[]
  ```

**Rules:**
- **`chooseCase`**: the spec's table and its "anything else" list, in that order of checks: `os` (not in `SUPPORTED`), the host limits, `interrupted` (record `running`, lock not held → the plan starts with the record's Undo), `otherSetup` (`whose` = `other`), then the holder of 443, then of 80. A record with `whose` = `same` or `update` gives its own case.
- **Steps per case** (ids; each step's `commands` are the spec's commands with `sudo` in front of what needs root, values shQuoted; file writes `printf '%s\n' <text> | sudo tee <path> >/dev/null`; backups `sudo cp -p`; in-place writes `sudo sh -c 'cat <candidate> > <file>'`): first always `guard` (the `relies`: 443's and 80's holders, their config's `sha256`, their container's id; prints `@@changed <what>` and exits 3 when one differs). 1/1b/4a/4b: `docker-install` (only when `docker` is null; `ticks: ['docker']`), `pull-caddy`, `caddyfile`, `volumes`, `run-caddy`, `caddy-up`; 4b adds `nginx-file`, `nginx-check`, `nginx-reload`, `acme-path`. 2: `site-file`, `folder-group` (skipped when the group is Caddy's or Caddy runs as root), `backup`, `candidate`, `validate` (host set = old + domain; `runuser -u caddy -- caddy validate`), `write`, `fetch-before`, `reload`, `fetch-after`. 3a/3b: `pull-socat`, `run-socat`, `reach-helper`, `backup`, `candidate` (folder or volume mount) or none (file mount), `validate` (inside their container), `write`, `fetch-before`, `reload` (`docker exec … caddy reload`), `fetch-after`. Every step's `skipIf` makes Apply twice "nothing to change": a plan whose every step is skipped on the facts gets `kind: 'nothing'`.
- **`update`** (`whose` = `update`): the board's file or block rewritten for the new domain, its container recreated only when its argv's hash (label `agent-board.args`) changed, their Caddy reloaded once; `publicPort` changes with case 4.
- **`undoPlan`**: from the record's items, newest first: a line or block removed **from the file as it is now** (never the backup), then validate, fetch, reload, fetch; containers and volumes by name **and** label; images only with `before: false` and unused; the group back; Docker only with `removeDocker` (offered only when the record installed it and Docker holds nothing else); a file of ours whose `sha256` differs stays unless `removeEdited`; `/etc/agent-board` last. Its last block lists the commands to remove the hand-made parts (Call 32), not run.
- **`runScript`**: line 1 `exec </dev/null`, line 2 `# agent-board: run`, then `set -u`, `umask 077`, `sudo() { "$@"; }`, `exec 9>/etc/agent-board/lock; flock -n 9 || { echo '@@busy'; exit 75; }`, the record written as `running` before step 1 and after each step (items of the steps done; file hashes by `sha256sum` on the server), each step `@@step <n> start`, `skipIf` → `@@step <n> skip`, else `timeout -k 5 <timeoutS> sh -c <shQuote(prelude + commands + check)>` → `@@step <n> ok|fail`; a failure runs the done steps' `undo` newest first, each `@@undo <n> ok|fail`, then `@@result rolled-back|rollback-failed`; all ok → `@@result applied`; a trap writes `runs/<id>.exit`. 20 minutes overall (`timeout` around the whole run in `launchScript`). `BOARD_SETUP_ACME_CA*` reach it only through `w.acme`.
- **`launchScript`**: `mkdir -p /etc/agent-board/runs`, the run written by `base64 -d` to `runs/<id>.sh` (0600), `setsid sh runs/<id>.sh >runs/<id>.log 2>&1 </dev/null &`, then the follower: once a second, the log's new complete lines (`wc -l`, `sed -n "<from>,<to>p"`), until `runs/<id>.exit` exists, then the rest and `@@exit <code>`; runs older than the newest five removed.
- **`doItMyself`**: one block per step, `commands` joined by `\n` exactly as in `runScript`, `check` as commands, `undo`; titles and whys are `server.step.<id>.title|why` keys (English yours, short; Russian yours).

- [ ] **Step 1: Write the failing tests.**
  - `test/core/server-texts.test.ts`: `boardCaddyfile('1', W)` is exactly the spec's case-1 block (tabs); `'1b'` the spec's 1b text; `'4a'` the spec's 4a text; `'4b'` 4a's plus `http://board.example.com {\n\trespond /.well-known/acme-challenge/agent-board-check "agent-board"\n}`; with `acme` each starts with a global block holding `acme_ca <ca>` and `acme_ca_root <root>` (merged into 1b's and 4a's own); `siteFile`, `markedBlock(W, 'agent-board-socket:8080')` and `nginxFile(W, ['80', '[::]:80'])` exactly the spec's; `caddyRunArgs('1', W, 997, 'r1')` equals the spec's `docker run` argv (`--cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges --group-add 997`, both mounts `:ro` for the socket's folder, volumes, labels, `CADDY_IMAGE`), `'1b'` without `-p 80:80`, `'4a'` `-p 80:80 -p 8443:8443`, `'4b'` `-p 127.0.0.1:8480:80 -p 8443:8443`; `socatRunArgs({ network: 'web_default' }, W, 997, 'r1')` the spec's, `{ host: true }` with `--network host` and `TCP-LISTEN:8481,bind=127.0.0.1,fork,reuseaddr`; `dockerInstall('debian')` and `('ubuntu')` the spec's lines with the distro in the URLs; the images match `/@sha256:[0-9a-f]{64}$/`.
  - `test/core/server-plan.test.ts` (facts from `factsFor`, **each on `debian13` and `ubuntu2604`**): `chooseCase` gives `1` (bare), `1b` (dummy80), `2`, `3a`, `3b`, `4a`, `4b` and `null` with `bridge`, `other80` (apache), `os` (`distro.supported` false), `selinux`, `podman`, `rootless`, `userns`, `domainServed`, `caddyJson`, `adminOff`, `split`; a record with another pair → `otherSetup`; the same pair, another domain → `buildPlan(...).kind` `update`; the same everything with every `skipIf` met → `nothing`; `buildPlan` for each case lists the step ids above in order, `ticks: ['docker']` only for `nodocker`, `address` `https://board.example.com` or `https://board.example.com:8443` (4a, 4b, `publicPort` 8443); values with a space or `'` (`/srv/it's web/Caddyfile`) reach `commands` shQuoted; `undoPlan` of a case-2 record removes the import line from the file as it is now (its command holds `IMPORT_LINE` and no backup path), keeps an edited `board.caddy` unless `removeEdited`, leaves a container named `agent-board-caddy` without the label, keeps an image with `before: true`, offers `removeDocker` only when the record installed Docker; `setupRecord` refuses a wrong `v`, a missing pair, an unknown item kind; `manualFacts('3a', 'ubuntu')` gives a plan whose commands hold `<your Caddyfile>`, and `placeholderFinders('3a')` names `docker ps` and `docker inspect`.
  - `test/core/server-script.test.ts`: `runScript` starts with `exec </dev/null\n# agent-board: run\n`, holds `sudo() { "$@"; }` and `flock -n 9`; every line of every step's `commands` occurs in it and in `doItMyself`'s block for that step; it passes `sh -n` (spawn `sh` from PATH when present, else skip that assertion); it holds none of `tail -f`, `--pid`, `[[`, `function `, `local `, `echo -e`; `launchScript` the same checks and `@@exit`; `readProgress` over `@@step 1 start`, two output lines, `@@step 1 ok`, `@@step 2 start`, `@@step 2 fail`, `@@undo 1 ok`, `@@result rolled-back`, `@@exit 1` → step 1 ok with its two lines, step 2 fail, undo `[{ n: 1, ok: true }]`, result `rolled-back`, exit 1; a step's output keeps its last 200 lines; `@@busy` → result `busy`; `@@changed holder443` → `changed`.
  - The three files and `server-view.ts` have no `from 'node:`; `bun test test/core/i18n.test.ts`'s missing keys stay `[]`.
- [ ] **Step 2: Run** `bun test test/core/server-texts.test.ts test/core/server-plan.test.ts test/core/server-script.test.ts`. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement** the shared types, the view type and its narrowing, the texts, the plan, the scripts and the keys.
- [ ] **Step 4: Run** the three files and `bun test test/core/i18n.test.ts test/web/access-panel.test.tsx`: PASS. `bun run check`: clean.
- [ ] **Step 5: Commit**
  ```bash
  git add src/core/server-facts.ts src/core/server-shell.ts src/core/server-view.ts src/core/server-texts.ts src/core/server-plan.ts src/core/server-script.ts src/core/i18n/server-strings.ts src/core/i18n/strings.ts src/core/access.ts src/services/remote-access.ts web/src/models/access.ts test/support/server-facts.ts test/core/server-texts.test.ts test/core/server-plan.test.ts test/core/server-script.test.ts
  git commit -m "Plan a server's setup for each case from what Look found, with its rollback, its Undo and the same steps to do by hand"
  ```

---

### Task 23: The admin connection, and Look, Apply and Undo through it (service)

**Spec:** "The admin connection" (who and which key, the ssh line, sudo, how a script runs, output and logs), "Look", "Apply", "Undo", the hints table, "Changes elsewhere in the board" (ops, config.json, `AccessView.server`), Calls 5–11, 20, 23, 24, 29, 30.

**Files:**
- Create: `src/core/server-admin.ts`, `src/services/server-setup.ts`, `test/core/server-admin.test.ts`, `test/adapters/ssh-admin.test.ts`, `test/services/server-setup.test.ts`
- Modify: `src/adapters/ssh.ts` (`spawnRemote`), `test/support/fake-ssh.ts` (the admin server), `src/adapters/config-file.ts` (`editTunnelAdmin`, `setTunnelSetup`), `src/services/remote-access.ts` (the `server-*` ops, `view().server`), `src/server/app.ts` (wiring), `src/core/i18n/server-strings.ts` (hint texts)
- Shared: `src/services/remote-access.ts`, `src/core/i18n/server-strings.ts` (Task 24 appends its keys there too).

**Interfaces:**
- Consumes: Task 20 (`lookScript1`, `readRoundOne`, `lookScript2`, `readServerFacts`), Task 21 (`publicOrigin`, `TunnelConfig.publicPort`), Task 22 (everything in `server-plan.ts`, `server-script.ts`, `ServerView`), `sshBin`, `knownHostsFile`, `fieldProblem`, the supervisor's `test()`.
- Produces:
  ```ts
  // core/server-admin.ts (no node: import)
  export interface Admin { user: string; key: string }
  export function adminConfig(v: unknown): Admin                      // config.json tunnel.admin; '' for missing
  export function adminProblems(a: Admin): { field: 'user' | 'key'; message: string }[]   // fieldProblem('user'|'key') rules; empty user → needed
  export function adminSshArgs(o: { conf: TunnelConfig; admin: Admin; knownHosts: string; command: string; platform?: string }): string[]
  export const PROBE_SCRIPT: string                                   // as the admin, no sudo: '@@uid <n>', then '@@sudo ok' or '@@sudo <sudo -n's first line>', '@@flavor <sudo --version first line>'
  export function readProbe(lines: readonly string[]): { mode: SudoMode; flavor: 'sudo' | 'sudo-rs' | null } | null
  export function remoteCommand(script: string, mode: SudoMode): string
  export function adminHint(lines: readonly string[]): AdminHint | null
  // adapters/ssh.ts
  export interface RemoteRun { onLine(fn: (line: string) => void): void; done: Promise<{ code: number | null; error: string | null }>; kill(): void }
  /** stdout and stderr by line; `stdin` written then closed (null: closed at once); killed after timeoutMs. No shell. */
  export function spawnRemote(bin: string, args: string[], stdin: string | null, timeoutMs: number): RemoteRun
  // adapters/config-file.ts
  export function editTunnelAdmin(a: Partial<Admin>): EditResult
  export function setTunnelSetup(s: { case: SetupCase; address: string; at: string } | null): EditResult
  // services/server-setup.ts
  export interface ServerSetupDeps {
    cfg: Config
    webPort: number
    ssh(): string | null
    knownHosts(): string
    hostKeyPinned(): Promise<boolean>
    spawn: typeof spawnRemote
    test(): Promise<TestStep[]>
    onChange(): void
    log(text: string): void
    now(): number
    newId(): string
    acme?: Acme
  }
  export type Answer = { status: number; body: unknown }
  export interface ServerSetup {
    view(): ServerView
    admin(body: { user?: unknown; key?: unknown }): Answer
    look(o: { password?: unknown }): Promise<Answer>
    apply(o: { plan?: unknown; docker?: unknown; password?: unknown }): Promise<Answer>
    undoLook(o: { password?: unknown }): Promise<Answer>
    undo(o: { plan?: unknown; removeDocker?: unknown; removeEdited?: unknown; password?: unknown }): Promise<Answer>
    cancel(): Answer
  }
  export function createServerSetup(d: ServerSetupDeps): ServerSetup
  ```
- **Ops** (`POST /api/access`, local-only already): `server-admin { user, key }`, `server-look { password? }`, `server-apply { plan, docker?, password? }`, `server-undo-look { password? }`, `server-undo { plan, removeDocker?, removeEdited?, password? }`, `server-cancel`. 200 `{ ok: true }`; refused 409 `{ ok: false, hint, error, need? }` (`need: 'password'` when sudo asks one and none came); 400 for a malformed body. No answer echoes its body.

**Rules:**
- **`adminSshArgs`**, in order: `-F none -T`, `-i <sshPathArg(key)> -o IdentitiesOnly=yes` only when `key` is set, `-o BatchMode=yes`, `-o StrictHostKeyChecking=yes`, `-o UserKnownHostsFile="<sshPathArg(knownHosts)>"`, `-o ConnectTimeout=15`, `-o ServerAliveInterval=15`, `-o ServerAliveCountMax=4`, `-o ForwardAgent=no`, `-o ForwardX11=no`, `-o ClearAllForwardings=yes`, `-p <sshPort>`, `<admin>@<host>`, `<command>`.
- **`remoteCommand`**: `root` → `sh -c 'eval "$(echo <b64> | base64 -d)"'`; `nopasswd` → `sudo -n -- ` + that; `password` → `sudo -S -p '' -- ` + that; `requiretty` and `none` throw. `<b64>` is standard base64 of the UTF-8 script, no line breaks.
- **`adminHint`** (first match): `Permission denied (publickey` → `publickey`; `Too many authentication failures` → `tooMany`; `Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED` → `hostKey`; sudo's and sudo-rs's own lines as Task 20 recorded them for a password required → `needPassword`, a wrong password → `wrongPassword`, `requiretty` → `requiretty`, not in sudoers → `notSudoer`; `Could not get lock|Waiting for cache lock` → `aptLock`; `toomanyrequests` → `pullLimit`; `@@changed` → `changed`; `@@busy` → `busy`; the tunnel's network lines → `network`.
- **Look:** admin fields, tunnel host and SSH port, ssh found, a pinned host key (`noHostKey` otherwise, nothing spawned). A password with `\n` or `\r` → 400, nothing spawned. The probe (no sudo, nothing on stdin) → mode and flavour; `password` without one → 409 `need: 'password'`; `requiretty`/`none` → 409 with that hint. Then round one and round two with `remoteCommand(script, mode)`, the password on stdin when `mode` is `password` (`password + '\n'`, once per spawn), each 60 s at most. Unreadable → `unreadable`. Then `chooseCase`/`buildPlan` (or `undoPlan` for `undoLook`), `Wanted` from the tunnel settings (`publicPort`) and `acme` from deps; phase `plan`; a `tunnel.setup` missing from config.json is filled from a record whose `whose` is not `other`.
- **Apply / Undo:** the plan's id must be the last Look's (kept in memory: a board restart → 409 `lookAgain`); `docker` must be true when `plan.ticks` has `docker`; one run at a time (409 `busy`). Spawn `remoteCommand(launchScript(runId, runScript(plan, w, run)), mode)`; answer 200 at once; each line → `readProgress`, a line holding the password replaced by `••••` before it is kept; `onChange` per marker; `web.log` one line per step (`server setup <step id> ok|fail <seconds>s`), never output. `@@result applied` → `setTunnelSetup`, case 4 → `editTunnel({ publicPort: 8443 })`, then `test()` every 10 s until the domain step passes or 120 s (`testAfter`), phase `done`; Undo applied → `setTunnelSetup(null)`, `publicPort` back to null when the record had 8443. ssh ending without `@@exit` → phase `failed`, hint `lost`.
- **The fake admin server** (`test/support/fake-ssh.ts`): argv with `StrictHostKeyChecking=yes` and no `-R` is the admin shape. No line in the quoted `UserKnownHostsFile` → `Host key verification failed.`, 255. State `admin: { uid?: number; sudo?: 'nopasswd' | 'password' | 'requiretty' | 'notSudoer'; flavor?: 'sudo' | 'sudo-rs'; password?: string; publickey?: boolean; fixture?: string; run?: { lines: string[]; dropAfter?: number } }`. It decodes the base64 in the last argument, reads the `# agent-board: <kind>` line and answers: `probe` the `@@` lines for `uid`/`sudo`/`flavor`; `look-1`/`look-2` `<fixture>/round1.txt`/`round2.txt`; `launch` the `run.lines`, cut after `dropAfter` (exit 255). For `sudo -S`: reads stdin to EOF, appends it as a JSON line to `<FAKE_SSH_LOG>.stdin`, a wrong one prints the flavour's recorded wrong-password lines and exits 1. A command that does not start with the mode's exact prefix exits 2 (`fake: unexpected command`).

- [ ] **Step 1: Write the failing tests.**
  - `test/core/server-admin.test.ts`: `adminSshArgs` POSIX and Windows (a key in `C:\Users\Иван Петров\keys\a b%c` → one `-i` value, forward slashes, `%%`); no key → no `-i`, no `IdentitiesOnly`; `remoteCommand` for each mode exactly as above, and decoding its base64 gives the script back; `requiretty` throws; `readProbe` for root, NOPASSWD, password-needed and requiretty lines **of both flavours** (Task 20's lines); `adminHint` for each row above with sudo's and sudo-rs's recorded lines; `adminProblems({ user: '-l', key: '' })` names `user`.
  - `test/adapters/ssh-admin.test.ts` (fake ssh): `spawnRemote` with stdin `pw\n` → the fake's stdin log holds `pw\n` once; with null → stdin closed (the fake reads EOF at once); lines arrive one by one; `timeoutMs` 300 on a `hang` → killed, `done` resolves; the argv log has `-T` and the remote command as one argument.
  - `test/services/server-setup.test.ts` (sandbox, `isolatedHome()`, the fake ssh, fixtures from Task 20, **every Look case on `debian13` and `ubuntu2604`**): root → the commands start `sh -c`, the stdin log empty; NOPASSWD → `sudo -n --`, stdin empty; password needed and none given → 409 `need: 'password'`, only the probe spawned; with the sentinel password → `look` 200, the stdin log has it once per sudo spawn, and the sentinel occurs in no argv, no view (`JSON.stringify(view())`), no answer, no `log` call, no file under the sandbox's state folder; a wrong password (sudo and sudo-rs) → 409 `wrongPassword` after exactly one sudo spawn; no pinned key → `noHostKey`, nothing spawned; `publickey` → that hint; `caddy-unit` → `choice.case` `'2'`, `plan.steps[0].id` `guard`; `compose-folder` → `'3a'`; a fixture record of another pair → `choice` `{ case: null, why: ['otherSetup'] }`; the same pair with another domain → `plan.kind` `update`; apply with a stale plan id → 409 `lookAgain`; `docker` missing for a `nodocker` plan → 409; apply with `run.lines` `@@step 1 start … @@result applied`, `@@exit 0` → phase `done`, config.json `tunnel.setup` written with the case, `testAfter` set; a 4a run → config.json `tunnel.publicPort` 8443, its Undo → removed; `run.dropAfter` mid-run → phase `failed`, hint `lost`; a second apply while one runs → 409 `busy`; `log` got one line per step and no output line.
  - `test/server/access-routes.test.ts` (one new case): `server-look` without a pinned key → 409 `noHostKey`; `server-admin { user: '-l' }` → 409 `field: 'user'`, config.json unchanged.
- [ ] **Step 2: Run** `bun test test/core/server-admin.test.ts test/adapters/ssh-admin.test.ts test/services/server-setup.test.ts test/server/access-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the core module, `spawnRemote`, the fake's admin server, the config edits, the service, the ops, the wiring (`createServerSetup` in `app.ts` with `acme` from `BOARD_SETUP_ACME_CA` and `BOARD_SETUP_ACME_CA_ROOT` when both are set) and the hint texts (`server.hint.<hint>`, the spec's hints table, English as there, Russian yours).
- [ ] **Step 4: Run** the same files: PASS. `bun run check`: clean.
- [ ] **Step 5: Commit**
  ```bash
  git add src/core/server-admin.ts src/services/server-setup.ts src/adapters/ssh.ts src/adapters/config-file.ts src/services/remote-access.ts src/server/app.ts src/core/i18n/server-strings.ts test/support/fake-ssh.ts test/core/server-admin.test.ts test/adapters/ssh-admin.test.ts test/services/server-setup.test.ts test/server/access-routes.test.ts
  git commit -m "Look at the server, apply the plan and undo it over the owner's admin connection, with sudo's password on stdin only"
  ```

---

### Task 24: The panel's "On the server" (web)

**Spec:** "The flow, as the owner sees it" (steps 1–3, the panel sketch, Look, the plan, Apply, Do it myself, Undo), the hints table, Call 4, Call 28, "Testing / Web".

**Files:**
- Create: `web/src/components/access/ServerSetup.tsx` (and parts in the same folder as needed), `web/src/models/server-setup.ts`, `test/web/server-setup.test.tsx`
- Modify: `web/src/components/access/TunnelSection.tsx` ("Snippets" become "On the server": 1 By hand, 2 Test connection, 3 The web server), `web/src/components/access/Snippets.tsx`, `web/src/models/access.ts` (Call 4's line), `web/styles/access.css`, `src/core/i18n/server-strings.ts`
- Shared: `src/core/i18n/server-strings.ts` (append), `web/src/models/access.ts`.

**Interfaces:**
- Consumes: `ServerView` (Task 22), `doItMyself`, `manualFacts`, `placeholderFinders`, `buildPlan` (Task 22), the ops contract of Task 23 (`send('server-look', { password })`, …), `useAccess`'s `send`.
- Produces:
  ```ts
  // web/src/models/server-setup.ts
  export function foundLines(f: ServerFacts, t: Translator): string[]        // distro · Docker · who holds 443 and 80; the fence; the folder
  export function stepState(p: Progress, n: number, now: number, t: Translator): string   // 'waiting' | 'running 12 s' | '✓' | '✗'
  export function manualPlan(c: SetupCase, w: Wanted, distro: 'debian' | 'ubuntu'): Plan
  export function hintLine(h: AdminHint | null, t: Translator, admin: string): string
  // web/src/components/access/ServerSetup.tsx
  export function ServerSetup(p: { view: AccessView; send: AccessSend }): JSX.Element
  ```

**Rules:**
- The sudo password: an `<input type="password" autocomplete="off">` shown when `view.server.sudo === 'password'` or an answer had `need: 'password'`; kept in the component's state only, sent with each Look, Apply, Undo; gone when the panel closes; never in `localStorage`, the URL or a toast. The note under it (**exact** en `kept by this panel while it is open; never saved`).
- Look's findings (`foundLines`), the case line, the address; the plan's numbered steps with what each touches; the Undo line; Docker's tick ("Install Docker from Docker's own repository") keeps Apply off until ticked; a `Manual` choice shows its reasons and "Do it myself" in place of Apply.
- A run: each step waiting / running (with seconds) / ✓ / ✗, output under a `<details>`; a failure: the step, its hint (`hintLine`), the rollback list with ✓, "Look again" and "Do it myself".
- Done: "Set up on <date>: <case>" with Undo (two clicks), then the Undo plan with its ticks (`removeDocker`, `removeEdited`).
- "Do it myself": from the plan when there is one; else a case picker (Nothing on 80 and 443, Caddy as a service, Caddy in Docker, nginx or something else) and `manualPlan`; each block with Copy; placeholders with their finding command.
- Call 4: while `view.server.setup` is null, the domain step's hint gets **exact** en `If the web server is not set up yet, this step fails until it is: Set up the server below.`

- [ ] **Step 1: Write the failing test** `test/web/server-setup.test.tsx` (views built from `factsFor` and Task 22's functions): nothing looked at (fields, Look, Do it myself); password asked (input `type="password"`, `autocomplete="off"`, the exact note; after typing, `localStorage` has no key holding it); findings for case 2 on Debian 13 and case 3a on Ubuntu 26.04; a `Manual` choice (`otherSetup`) with its reason and no Apply; a `nodocker` plan with Apply disabled until the tick, then `send('server-apply', { plan, docker: true, password })`; a run in progress (one ✓, one running); a failure with its hint and two rollback ✓; done with Undo, two clicks → `send('server-undo-look', …)`; Do it myself without Look for "Caddy in Docker" shows `<your Caddyfile>` and `docker ps`; the 8443 address; Call 4's line present while `setup` is null and absent after; the texts in Russian differ.
- [ ] **Step 2: Run** `bun test test/web/server-setup.test.tsx test/web/access-panel.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the model, the component, the three steps in `TunnelSection`, the CSS (class selectors only) and the keys.
- [ ] **Step 4: Run** the same files and `bun test test/web/styles.test.ts test/web/style-attributes.test.ts`: PASS. `bun run check`: clean.
- [ ] **Step 5: Commit**
  ```bash
  git add web/src/components/access web/src/models/server-setup.ts web/src/models/access.ts web/styles/access.css src/core/i18n/server-strings.ts test/web/server-setup.test.tsx
  git commit -m "Set up the server's web server from Settings → Remote access…, or show how to do it by hand"
  ```

---

### Task 25: The test servers end to end, the two-proxies proof, and the README

**Spec:** "Testing" (Integration, The two-proxies proof), "Changes elsewhere in the board" (README), "What this changes in the tunnel spec" (README lines), the owner's OS decision.

**Files:**
- Create: `test/integration/server/harness.ts` (build the images, start a server with a scenario, Pebble + challtestsrv + a `client` container on one Docker network, the server's ssh on a free `127.0.0.1` port, stop and remove everything, also on failure), `test/integration/standin.ts` (the stand-in board: a Unix socket in a folder with the tunnel's mode, answering with the Host and `X-Forwarded-*` it got, an event every 500 ms), `test/integration/server-setup.test.ts`, `test/integration/two-proxies.test.ts`
- Modify: `test/integration/server/*` (fixes the runs need), `README.md`, the spec (a "Checked by the integration tests" block after the spike's; the two-proxies results), `test/core/server-texts.test.ts` (the README check)
- Shared: `README.md`.

**Interfaces:**
- Consumes: everything from Tasks 20–24; a sandboxed board (`sandbox()`, `serveBoard`) with `BOARD_SSH_BIN_PATH` = Windows' `ssh.exe`, `BOARD_SETUP_ACME_CA`, `BOARD_SETUP_ACME_CA_ROOT`, config.json pointing the tunnel at the test server.

- [ ] **Step 1: Write `two-proxies.test.ts`** (`BOARD_DOCKER_IT=1`), plain containers, the board's own texts and flags (`caddyRunArgs`, `socatRunArgs`, `markedBlock`, `boardCaddyfile` plus a `local_certs` global option), their proxies with `tls internal` or a self-signed certificate, the test trusting those roots: topology A (their Caddy on a user network, 443 and 80 on loopback ports, `site.test` and the marked block to `agent-board-socket:8080`), B (their nginx on 443 and 80, the board's Caddy on 8443), C (the board's Caddy alone on 443). For each, both at once: `site.test` answers its page and `board.test` the stand-in with `Host: board.test`, `X-Forwarded-Proto: https`, the test's address rightmost in `X-Forwarded-For`; an event stream's first event within 1 s and ticks for 30 s; 200 interleaved concurrent requests all right; their proxy reloaded (A) or restarted (B) during an open board stream: their site keeps answering, B's board stream untouched; the stand-in stopped → `board.test` 502, `site.test` fine; started again on a new socket file → `board.test` answers with no change to either proxy.
- [ ] **Step 2: Write `server-setup.test.ts`** (`BOARD_SERVER_IT=1`). **Debian 13 and Ubuntu 26.04 run side by side** (one server each at a time, the two in parallel); Ubuntu 24.04 runs `nodocker` (the install path), `bare` and `caddy-unit`; Debian 12 and Ubuntu 22.04 the same three when `BOARD_SERVER_IT_ALL=1`. For each scenario of Task 20 on each server, through the board's ops with the admin `admin` (sudo with a password; `nopw` and root once each per distribution):
  - Look gives the scenario's case (3c, 4c and the faked Podman/rootless/SELinux give their `Manual` reasons and no Apply);
  - Apply → `@@result applied`; their sites answer as before (the test's own fetches from the `client` container, not only the board's); `https://board.test` (or `:8443`) reaches the stand-in through the board's real tunnel with `X-Forwarded-Proto: https` and the caller's address, its certificate from Pebble;
  - Apply again → nothing to change: their files' hashes and the containers' ids the same;
  - Undo → their files' hashes as before Apply; no `agent-board` container, volume, file, line or block left; Docker kept;
  - failures (on both distributions): a broken line put into their Caddyfile before Apply (validate fails, nothing reloaded, hash unchanged); the board's ssh killed mid-Apply (the run finishes or rolls back; the next Look reads the record); their reload made to fail (rollback, their Caddy on its old config); a host made to answer differently after the reload (rollback); their file changed between Look and Apply (`changed`, nothing changed); a wrong sudo password (`wrongPassword`, one attempt, sudo's and sudo-rs's lines);
  - the sentinel password appears in no file under the sandbox and in no file under `/etc/agent-board` or `/var/log` on the server (`grep -r`).
- [ ] **Step 3: Run** `BOARD_DOCKER_IT=1 bun test test/integration/two-proxies.test.ts` and `BOARD_SERVER_IT=1 bun test test/integration/server-setup.test.ts` (long; `--timeout` as needed). Fix what fails in the task that owns the code (core, service or scripts), each fix with a unit test that fails without it. Then `bun test test/integration` without the env: every `describe` skipped, no container started (`docker ps` before and after the same).
- [ ] **Step 4: Write the README** in the voice of the sections around it: "On the server" as the three steps (by hand with the one paste; Test connection; The web server: Look, the plan, Apply, Undo, what is stored and what never is); "Do it myself" with each case's summary (the panel has the commands); the case-3 trade-off in one paragraph; which servers (Debian 12, 13; Ubuntu 22.04–26.04; sudo or sudo-rs; anything else by hand); Settings: `tunnel.admin`, `tunnel.setup`; Development: the new modules and `BOARD_SETUP_ACME_CA`, `BOARD_SETUP_ACME_CA_ROOT`, `BOARD_SERVER_IT`, `BOARD_DOCKER_IT`. In `test/core/server-texts.test.ts`: the README holds `IMPORT_LINE` and `markedBlock` for the defaults verbatim, and the three step headings.
- [ ] **Step 5: Record** in the spec: the two-proxies results and one line per scenario and distribution (case, Apply, again, Undo, failures). Run `bun test test/core/server-texts.test.ts`: PASS. `bun run check`: clean.
- [ ] **Step 6: Commit**
  ```bash
  git add test/integration README.md test/core/server-texts.test.ts docs/superpowers/specs/2026-10-21-remote-tunnel-server-setup-design.md
  git commit -m "Test the server setup end to end on Debian and Ubuntu test servers and prove two proxies serve side by side, and describe it in the README"
  ```
  (Fixes from Step 3 are committed as they come, each with its own plain sentence.)

---

## After Task 25 (the owner, by hand)

The spec's "Manual (the owner)": a throwaway Debian 13 VPS (and Ubuntu 26.04 if at hand) through cases 1, 2 and 3a; then, if the owner wants, the real server: Look only, the plan read together, then Apply.
