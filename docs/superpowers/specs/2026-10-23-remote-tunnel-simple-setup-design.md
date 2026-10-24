# agent-board: the server set up with one password, or one paste — design

Date: 2026-10-23 · Branch: `feature/remote-tunnel` (PR #168, issue #154), not merged yet. Lands in
the same pull request. A change to the approved `2026-10-21-remote-tunnel-server-setup-design.md`,
called "the setup spec" below; its calls are cited as **(setup call N)**. Calls made in this
document, not the owner's, are numbered in "Calls" at the end and marked **(call N)**.

## Intent

The owner tried the setup on their Debian 13 server (it runs Caddy in Docker with other sites).

- "Look at the server" stopped at once: `root@board.migontech.online: Permission denied
  (publickey,password)`. The board logs in as the admin by key only (setup call 5), and the owner
  logs into this server, like most people with a rented server, as root with the password the
  host gave them. No key of theirs is on the server.
- "Do it myself" showed choices the owner should never have to make ("Caddy in Docker", "on its
  own network" or "on the host's network", Debian or Ubuntu), placeholders to fill in by running
  other commands, and a long list of steps. The owner: "this is all very complicated … what is
  'its own network' and 'the host's network', what nonsense is that? … it should be simpler: maybe
  something like temporary root access, or, if it is copy and paste, it must be very elementary."

The server is the owner's rented host. The board, not the person, finds out what is on it.

## Decided with the owner (2026-10-23)

Played back in chat and approved ("все хорошо"):

- **The main path: one button, "Set up the server".** The owner types the server's address, the
  login (root by default) and its password, the same as for `ssh`. The board logs in once with
  that password (or with a key, when one works), looks at the server by itself, and shows the plan
  in plain words, e.g. "Found Caddy in Docker with sites A and B. I will add
  board.migontech.online and touch nothing else." **Apply**, and it is done: a failure on any step
  rolls back; **Undo** stays.
- **The password lives only in memory while the setup runs, and is saved nowhere.** Afterwards the
  board reaches the server only as its own tunnel user with its own key; it needs root no more.
  So the one button also makes what was step 1 by hand: the tunnel user, the socket's folder, the
  board's key, sshd's fence for that user.
- **The fallback: "Do it myself" is one command.** For an owner who will not give the board a
  password: one block, one Copy. The owner pastes it into their own ssh session on the server as
  root; it finds out everything by itself and does it, and at the end prints "done" or what is
  wrong. No choices on the screen: not Caddy or nginx, not Docker's network, not Debian or Ubuntu.
- **Every guarantee of the setup spec stays**: the owner's sites are never broken (its anti-goal
  1), two proxies can run at once, nothing half-done (anti-goal 2), Debian 13 and Ubuntu from the
  start, the cases 1–4 as they are.

## What this changes in the setup spec

The builder edits the setup spec in the same pull request where these overturn it:

- **Setup call 1** (sshd and the tunnel user stay by hand; the board never edits sshd_config) and
  anti-goal 5's "the board editing sshd_config": the board now makes step 1, with the fence rules
  in "Step 1 by the board" below. Anti-goal 5 becomes: weakening the fence (any sshd setting
  outside the tunnel user's `Match` block, a right for the tunnel user, a folder looser than
  `2750`), or an sshd change that is not validated and reloaded with a rollback.
- **Setup call 3** (step 1 as one paste beside the snippets): step 1's separate snippets and its
  paste leave the panel; both paths make step 1 themselves.
- **Setup call 5**: SSH password login is supported (below). A key still works and is tried first
  when the owner gives no password (call 1).
- **Setup call 6** (Look needs Test connection first, for the pinned host key): the first admin
  login pins the host key (call 2).
- **Setup call 28** ("Do it myself" without Look: the owner picks the case, placeholders): gone.
  "Do it myself" is the one command below.
- **Setup call 32** (Undo leaves what the owner made by hand): the board made it, so Undo removes
  it too (call 6).
- **Case 5's per-step commands** leave the panel's normal path (call 7); they stay, folded, only
  for a server the board does not do (call 10).
- The README's "On the server" part, and the hint for `Permission denied`.

## Goals

- From an empty panel to `https://<domain>` serving the board: the address, the login, the
  password, Set up the server, Apply. Nothing else typed, nothing chosen.
- Or: Copy, paste into the server's root shell, wait for "done", then Test connection.
- The owner never meets the words "network", "case", "container", "Caddyfile" in a choice. They
  may meet them in the plan's details, folded.
- Debian 12, 13; Ubuntu 22.04, 24.04, 25.10, 26.04 on both paths, as the setup spec.
- Windows first-class on the PC side, as before.

## Non-goals

- Logins that need more than a password: one-time codes, two-factor prompts, a password that
  expires at login. These stop with a hint (call 4).
- DNS records: the owner points the domain at the server, as before. Look's DNS warning stays.
- Firewalls, as before.
- Keeping the old "Do it myself" (case chips, placeholders, per-step commands) beside the new one.

## Anti-goals (failure even if it works)

1. **The password stored or seen anywhere**: on disk (PC or server), in config.json, `web.log`,
   the payload, a URL, an answer, a command line on the PC or the server, the server's shell
   history, a file the askpass helper reads. Kept by the page only while the panel is open, as the
   sudo password is today.
2. **Locking the owner out of their own server.** sshd's config changed in a way that refuses the
   owner's next login, or sshd restarted rather than reloaded (a reload keeps every open session).
3. Everything in the setup spec's anti-goals, but no. 5 as amended above.
4. **"Do it myself" changing anything the panel did not describe**, or changing anything on an
   unsupported server: it stops before its first change, and says why.
5. A board that never uses this, or the local board, noticing any change.

## The flow, as the owner sees it

```
Remote access
  Address of the board   [board.migontech.online        ]
  Server                 [board.migontech.online ] port [22]
  Login                  [root      ]   Password [••••••••••]   (or a key: ▸ use a key file)

  [Set up the server]                                        or ▸ Do it myself (one command)

  What I found
    Debian 13 · Caddy in Docker serves 443 and 80: sites a.example.com, b.example.com
  What I will do
    Add board.migontech.online to your Caddy and give it the board's tunnel.
    Make the board's own login on the server (boardtunnel), allowed only to hold the tunnel.
    Your sites are not touched; each is checked before and after.
    ▸ Details (every file, container and line, and how Undo removes it)

  [Apply]   [Cancel]
```

The layout is the builder's; what it says and what it asks are not.

- **The address of the board** is the tunnel's domain; the server's address is filled from it and
  can be changed (a different SSH host or port).
- **Set up the server** = the setup spec's Look, after the login. If Look's case is one the board
  does not do (setup call 25, "anything else"), the plan says why in one line and offers "Do it
  myself", which then also stops with the same reason (it runs the same detection).
- **The plan in plain words**: what was found (one line), what will be done (two or three lines),
  what is not touched. The setup spec's full plan (files, lines, containers, images, backups,
  reloads, what Undo removes, the Docker install tick) moves under "Details". The Docker install
  tick stays required (setup call 19) and sits in the plain part when the plan installs Docker:
  "Docker is not installed: I will install it from Docker's own repository. [ ] OK".
- **Apply** = the setup spec's Apply, now with step 1's parts in the same run (below), then Test
  connection as before (setup call 24).
- **Undo** asks for the password again (it is not kept), then as the setup spec.
- After a successful setup, the panel shows the tunnel's status and "Set up on 23 Oct, 10:04"
  with Undo, as before. The login and password fields fold away.

### Do it myself

```
  ▸ Do it myself (one command)
    Paste this into an ssh session on your server, as root (or a user with sudo).
    It looks at the server, sets up the board's address and its tunnel, and touches nothing of
    yours. It prints what it did, or why it stopped. Safe to paste again.
    ┌──────────────────────────────────────────────────────────┐
    │ echo H4sIAAAA…  | base64 -d | gunzip | sh                 │   [Copy]
    └──────────────────────────────────────────────────────────┘
    ▸ What is inside (the script, readable)
    Then: [Test connection]
```

- The command carries everything the board knows (domain, tunnel user, socket path, public port,
  the board's public key) and the same scripts the board would run. The owner fills in nothing.
- Run as a user with sudo, it re-runs itself with `sudo` (the owner types sudo's password into
  their own terminal, as usual).
- It runs the setup spec's Look on the server, chooses the case by the same rules, prints the plain
  plan ("Found … I will …"), then does it, with the same record, lock, rollback, checks and
  Docker-install rules. Interactive confirmation: it asks "Go ahead? [y/N]" once before its first
  change, reading the answer from the terminal (`/dev/tty`), so a paste is never a silent change;
  the Docker install is part of that one question when the plan has it (call 8).
- At the end: "done: https://board.migontech.online" and "press Test connection on the board", or
  the reason it stopped and what it rolled back.
- **Undo** is one command too, shown after a setup and in "What is inside": it follows the same
  record as the board's Undo.

## The admin login by password

**How the password reaches ssh** is the builder's, within these rules:

- Never on a command line, on disk, in a log, or in a file a helper reads. Windows' OpenSSH, macOS'
  and Linux's ssh read a password only from a terminal or from an askpass program
  (`SSH_ASKPASS` with `SSH_ASKPASS_REQUIRE=force`, OpenSSH 8.4 and later; Windows 11 ships 9.x).
  The expected way: a small askpass helper of the board's (a script run with the board's own Bun)
  that gets the password from the board process over a channel only it can use (a pipe or
  loopback with a one-time token), answers only password prompts (`…password:`), and fails on any
  other prompt (call 4). The builder may find a better way; the rules hold.
- `-o BatchMode=yes` goes, for this login only; `-o PreferredAuthentications=publickey,keyboard-interactive,password`
  and `NumberOfPasswordPrompts=1`: one try per click, as the sudo password (setup call 7), since
  servers may ban an address after a few failures (fail2ban).
- An ssh older than 8.4 (no `SSH_ASKPASS_REQUIRE`): the panel says the board's ssh cannot take a
  password and offers a key or "Do it myself". The builder checks the Windows ssh the board picks.
- **sudo** for a login that is not root: the same password goes to `sudo -S` (setup call 7), unless
  sudo needs none. Only when sudo refuses it does the panel show a second field, sudo's password
  (call 3).
- **Root login refused** (`PermitRootLogin prohibit-password`, common on Ubuntu images): the
  hint says to log in as the user the host gave, with sudo.

**The host key**: the first admin login pins the server's key, as Test connection does today, in
the same known_hosts; "What I found" shows its fingerprint (call 2). A pinned key that changed is
refused, as before.

**A key instead of a password**: "use a key file" (or the agent) as the setup spec has it. With no
password typed, the key is tried; refused, the panel asks for the password.

## Step 1 by the board

Apply's run gets step 1's parts as its first steps, recorded and undone like the rest (setup
"What the board owns", now with these):

- the tunnel user (`useradd --system --user-group …`, `usermod -p '*'`), unless it exists; one
  that exists and was not made by the board is used and not removed by Undo;
- the socket's folder, `2750`, the tunnel user and its group (setup call 2);
- the keys file `/etc/ssh/authorized_keys/<user>` with the board's public key (root's, `644`);
- sshd's fence: the setup spec's `Match User <user>` block, unchanged, in **a file of its own**
  where sshd includes `/etc/ssh/sshd_config.d/*.conf` (Debian 12+, Ubuntu 22.04+ do, at the top
  of sshd_config). If the main file has no such `Include`, the block is appended at the end of
  sshd_config between markers (a `Match` block must come last). The builder checks how OpenSSH
  scopes a `Match` block in an included file (it may end at the file's end, or not) and makes sure
  the block applies to the tunnel user only and that nothing after it is captured;
- `sshd -t` on the result, then a **reload** (`systemctl reload ssh` / `sshd`, as the tunnel
  snippets do), never a restart. `sshd -t` failing: the change is removed and the run rolls back.
  After the reload, the run checks with `sshd -T -C user=<user>,…` that the fence is in force, and
  with `sshd -T -C user=root,…` (or the admin) that the admin's own settings are what they were
  before (the `permitrootlogin`, `passwordauthentication`, `pubkeyauthentication` lines);
  a difference rolls back (anti-goal 2).

Look's `fence` and `folder` checks (setup spec) become what tells the plan which of these are
needed. Then the case's own steps follow, and Test connection at the end.

## "Do it myself": one command

- **Servers the board does not do** (setup call 25 and Look's "anything else": another OS, Apache,
  Traefik, nginx in Docker, Caddy only on the default bridge, Podman, SELinux enforcing, another
  board's setup): the one command stops before any change and prints why. The panel then keeps
  today's expert commands for such a server, folded under "Your server needs steps by hand"
  (call 10): step 1's snippets and the per-step commands with placeholders, as the setup spec's
  case 5 has them, so the owner's 2026-10-21 decision ("any other OS: Do it myself, with the
  commands") still holds. They are never the first thing shown, and never shown for a server the
  board can do.
- **How the board learns what the command did** (call 11). The command prints the address it set
  up. The board needs it only for the public port (case 4 sets 8443): while the panel is in "Do it
  myself" and no setup is recorded, Test connection tries `https://<domain>` and, if the board does
  not answer there, `https://<domain>:8443`; where the board answers, it saves `tunnel.publicPort`
  and shows "Set up by hand". Nothing else changes for Test connection: outside "Do it myself" it
  is today's. The Undo command needs nothing from the board: it follows the server's record.
- **Same scripts, not a second implementation.** The command carries the setup spec's Look
  scripts and every case's Apply script (and Undo's), as the board would run them. What the board
  does in TypeScript between Look and Apply (parsing Look, choosing the case, filling in the plan)
  must also run on the server for this path. The builder chooses how, and says how both paths are
  kept the same (the expected way: the choosing logic written once in a form both use, or the
  board's TS logic compiled to the plan's decision table that the shell script reads; a
  hand-written second copy in sh is the last resort and needs a test that runs both on the same
  Look fixtures and compares).
- **Size**: one paste into a terminal. Compressed (`gzip`, then base64), on one line. The builder
  measures it; it must paste cleanly into Windows Terminal, PuTTY and macOS Terminal over ssh
  (a paste of tens of KB is fine; hundreds is not). If it cannot be made small enough, the command
  is two lines: one writes the script to a root-only file under `/etc/agent-board/`, one runs it.
- **The same server record** as the board's runs, so the board's Undo and Look see a setup made by
  hand, and the next paste is an update or a no-op.
- `gzip`, `base64` and `sh` are on every supported distribution; the command checks and says if
  not.

## Changes elsewhere in the board

- `tunnel.admin { user, key }` in config.json stays (no password, ever).
- The panel's strings (English and Russian), the hints table: `Permission denied` now says "the
  password or the key was refused" (for a password: "check the password; the server may lock the
  login after a few wrong ones").
- The setup spec's "Step 1: by hand, once" and "Step 2: Test connection before Look" leave the
  panel's order; Test connection stays as a button (after a setup, and for "Do it myself").

## Testing

- **Unit**: the askpass helper (password prompts answered, others refused, the password nowhere
  in its argv or files); ssh's argv for a password login (no `BatchMode`, one prompt); the plain
  plan's text per case; the step-1 steps in the plan and the record; the one command's builder
  (what it carries, its size limit).
- **Integration** (the setup spec's Docker harness, `BOARD_SERVER_IT=1`): sshd in the test
  containers with password login for root and for a sudo user. On **Debian 13 and Ubuntu 26.04**,
  and Ubuntu 24.04: the password path from an empty server (no tunnel user) through Apply and Undo,
  for cases 1, 2, 3a, 3b, 4a; the one command (run with `sh` in the container as root, the
  confirmation answered by a test terminal) for the same cases; a wrong password (one try, one
  failure in the journal); root login refused; an `Include`-less sshd_config; the owner's next
  ssh login still works after Apply and after Undo (anti-goal 2).
- **Manual (the owner)**: their Debian 13 server, the password path; then Undo; then the one
  command.

## Tasks (a guess at the split, the builder's to change)

1. The admin password login (adapter, askpass helper, ssh argv, host key pin, hints).
2. Step 1 by the board (plan steps, record, Undo, sshd drop-in or block, checks).
3. The one command (shared choosing logic, the bundle, size, confirmation, record).
4. The panel (one flow, plain plan with Details, "Do it myself" block, strings).
5. Integration lanes for 1–3; README and the setup spec's edits.

1, 2 and 3 can run in parallel; 4 after 1's API settles; 5 at the end.

## Calls

1. **A key is tried before the password** when the owner gives none; with a password typed, the
   board offers both and ssh takes the first the server accepts.
2. **The first admin login pins the host key** (trust on first use), its fingerprint shown in
   "What I found"; a changed key is refused, as before.
3. **One password**: the login's password is also sudo's. When sudo refuses it (the login itself
   went in with a key, or sudo's password differs), the run stops before any change with "sudo
   needs its own password", and only then the panel shows a field for it; the next click sends it
   to `sudo -S`. One sudo try per click, as setup call 7.
4. **Only password prompts are answered**: a one-time code or any other prompt stops the login with
   a hint; no second try in the same click.
5. **sshd's fence in a file of its own** under `sshd_config.d` when included, else a marked block at
   the end of sshd_config; validated, reloaded, its effect and the admin's settings checked, rolled
   back on any difference.
6. **Undo removes step 1's parts the board made** (the tunnel user, folder, keys file, fence), and
   leaves any that were there before.
7. **The old "Do it myself"** (case chips, placeholders, per-step commands) goes; "What is inside"
   shows the one command's script, readable.
8. **The one command asks once before its first change**, on the terminal; a paste never changes
   anything silently.
9. **The login's fields fold away** after a setup; Undo asks for the password again.
10. **Expert commands only for servers the board does not do**, folded; the old case chips and
    per-step commands stay in the code for that and nothing else.
11. **After the one command, Test connection finds the public port** (443, else 8443) only in
    "Do it myself" with no setup recorded, and saves it.

## Left to the builder

- How the password reaches ssh, within the rules above.
- How the choosing logic is shared between the board and the one command.
- Names, the panel's layout, the exact plain texts (short, no jargon, both languages).
- Whether the one command is one line or two (size).
