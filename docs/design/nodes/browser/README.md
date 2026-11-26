# A browser and Bitwarden on a server node

`install.sh` equips a Linux node (Ubuntu 24.04 tested, on server-1) with browser profiles that the
node's Claude sessions drive through the mokutab and mokubot MCP servers, noVNC for the owner's
first sign-in, and the Bitwarden CLI. Everything runs as systemd user units of the node user
(`agent-board`, lingering on), beside the `herdr` unit of [section 11.1](../README.md#111-a-server-by-its-password-or-key).
It is a stopgap until the browser node of #514; the board itself is not changed (#613).

## One run of the script sets the node up, a second run changes nothing

On the owner's laptop, stage what the script cannot fetch, then run it as root on the node:

```sh
# laptop (Git Bash), from the folders the extensions are built in
S=/tmp/abstage; rm -rf $S; mkdir -p $S/mokutab $S/mokubot $S/mokubot-mcp
cp -r <MokuTab>/app/chrome-extension/dist/chrome-mv3/. $S/mokutab/
cp -r <MokuAssist>/dist/. $S/mokubot/
cp -r <MokuAssist>/mcp-server/dist <MokuAssist>/mcp-server/package.json $S/mokubot-mcp/
cp -r ~/.mokutab/functions $S/mokutab-functions                        # optional
cp "$LOCALAPPDATA/mcp-chrome-bridge/fn-runs/fn-state.json" $S/mokutab-fn-state.json  # optional
cp docs/design/nodes/browser/install.sh $S/
tar -C $S -czf - . | ssh <server> 'mkdir -p /tmp/agent-board-browser && tar -C /tmp/agent-board-browser -xzf -'

# server
sudo STAGE=/tmp/agent-board-browser bash /tmp/agent-board-browser/install.sh
```

The settings are variables at the top of the script (profiles, ports, versions). Each run backs up a
file it is about to change into `~agent-board/browser/backups/<time>/` and restarts the browser
units; it never restarts `herdr`, because that ends the node's running sessions.

What needs root, and why: `apt-get` (xvfb, x11vnc, novnc, websockify, unzip, and Chrome's libraries
when `ldd` finds some missing), `loginctl enable-linger`, the sudoers drop-in, and an AppArmor profile
that lets Chrome's sandbox use user namespaces (Ubuntu 23.10 and later forbid them by default).

## Each profile is its own Chrome on its own display

| Profile | Display | CDP | VNC | noVNC |
|---|---|---|---|---|
| `bsd` (the owner's main work) | :50 | 127.0.0.1:9223 | 5950 | 127.0.0.1:6080 |
| `bb` (a second employer) | :51 | 127.0.0.1:9224 | 5951 | 127.0.0.1:6081 |
| `pf` (bb's client A in Workato), server-2 | :52 | 127.0.0.1:9225 | 5952 | 127.0.0.1:6082 |
| `legacy` (bb's client B in Workato), server-2 | :53 | 127.0.0.1:9226 | 5953 | 127.0.0.1:6083 |

- Chrome for Testing 155 is copied from `/opt/nanoclaw-host/browsers/` when it is there, else the same
  version is downloaded; it lives in `~/browser/chrome/`. Profiles are in `~/browser/profiles/<name>/`
  and persist. Windows profiles cannot be copied (DPAPI): each profile is signed in once by hand.
- The mokutab and mokubot extensions are loaded unpacked from `~/browser/extensions/`.
- mokutab: one bridge for every profile, as on a laptop. Chrome on Linux finds the native messaging host
  in `<user-data-dir>/NativeMessagingHosts/`; whichever profile starts first runs the bridge
  (`~/browser/mokutab/bridge`) on `MOKUTAB_PORT` (12306), and the others join it over its WebSocket under
  their profile name. `ExecStartPost` sets each extension's port and profile name over CDP. Where another
  browser on the host holds 12306 (server-1), give `MOKUTAB_PORT=12307`.
- The bridge's default profile, where a call that names none goes, is `DEFAULT_PROFILE` (the first one in
  `PROFILES` unless set). The bridge reads it from `~/browser/state/<profile>/state/mcp-chrome-bridge/default-profile.json`
  of whichever profile started it, so the script writes it into each profile's file that names another one.
  A stale name there (server-2 had an old `"default"`) made the first profile to reconnect the default.
- mokubot: one MCP server (`agent-board-mokubot-mcp`, HTTP 127.0.0.1:12440, WebSocket bridge from
  8765); the extensions of both profiles connect to it, and the tools pick the NetSuite account by
  `account_id` (`netsuite_list_accounts`).

- The owner's mokutab browser functions (`chrome_fn_list`): both bridges run as the node user and read
  `~/.mokutab/functions`, so one copy serves every profile. A function that never ran OK on a machine is
  a hidden draft there; the laptop's `fn-state.json`, put into each profile's state once, carries that over.

## A client profile per Workato workspace

Workato keeps the chosen client workspace in the session cookie, so every Workato tab of one profile is
in the same workspace, and an agent that switches it moves every other agent of that profile too. Each
client that agents work on in parallel gets a profile of its own, copied from `bb` with its logins: a
fourth field in `PROFILES` (`pf:52:9225:bb`) copies `~/browser/profiles/bb` once, while bb's Chrome is
stopped, and the run starts the new one with its own display, CDP port, units and mokutab name. Google
SSO and Workato then work in the copy as they do in bb; Workato may still ask to sign in once
(its "Google" button). Then the profile is put in its workspace once:
`workato_switch_environment {"profile":"pf","workspace":<workspace id>}`.

A session working on that client calls `chrome_switch_profile {"profile":"pf"}` at its start (or passes
`profile` on each call) and checks with `workato_session_context`. Another client is one more entry,
such as `clientc:54:9227:bb`, and one script run.

Units: `agent-board-xvfb@<name>`, `agent-board-chrome@<name>`, `agent-board-mokubot-mcp`, enabled;
`agent-board-vnc@<name>` and `agent-board-novnc@<name>`, on demand.

## The node's sessions find the servers under their usual names

The board's bundle does not send the master's loopback MCP servers (its report says
`bound (local-url)`), so the script writes these into the node user's `~/.claude.json` and the bundle
leaves them alone:

- `mokutab`: `http://127.0.0.1:12306/mcp`; a call names the profile (`bsd`, `bb`, `pf`) or goes to the default one.
- `mokubot-netsuite`: `http://127.0.0.1:12440/mcp`.

Both Claude profiles of the node (`~/.claude.json`, `~/.claude-work/.claude.json`) get them, and their
`settings.json` gets `BROWSER=~/browser/bin/open-in-chrome`: a CLI's browser login (`suitecloud
account:setup`, `gh auth login --web`) opens as a tab in the first profile, where an agent approves it
(for SuiteCloud: the mokutab function `netsuite.sdf_consent`). SuiteCloud's saved logins do not travel
from a Windows laptop (its `credentials` file is bound to that machine), so each account is set up again there.

A client reachable only over the laptop's VPN stays on the laptop: no profile for it here.

## Bitwarden unlocks at start and syncs every hour

- `bw` is installed with npm into `~/.local`, logged in with the owner's API key.
- `agent-board-bw-unlock` (oneshot) runs `bw unlock --passwordfile ~/.config/agent-board-bw/master-password`
  and writes `BW_SESSION` into `~/.config/agent-board-bw/session.env` (folder 0700, files 0600).
- `herdr.service.d/bitwarden.conf` gives `herdr` that file as its `EnvironmentFile` and orders it after the
  unlock, so sessions started by the node have `BW_SESSION`. `herdr` reads it on its next restart.
- `agent-board-bw-sync.timer` runs `bw sync` hourly.
- The mokutab bridge gets the vault from its native host wrapper (`~/browser/bin/mokutab-host-<profile>`):
  Chrome starts the bridge, not `herdr`, so the wrapper reads `session.env` itself when it is there and sets
  `BITWARDENCLI_APPDATA_DIR=~/.config/Bitwarden CLI`, since the wrapper's per-profile `XDG_CONFIG_HOME` would
  otherwise send bw to an empty folder ("You are not logged in"). The vault functions (`netsuite.login`) need
  both. A bridge reads a new session when Chrome starts it again (the Chrome unit's restart).

NetSuite logins go through the mokutab function `netsuite.login`, which opens the account's own URL
(`https://<account>.app.netsuite.com/`). A `~/browser/bin/netsuite-login.mjs` put there by hand (server-2) is
moved to the backups: it logged in through `system.netsuite.com`, which opens a session in the user's default
account and ends that account's session everywhere else.

The master password sits in a file on the server. That is accepted only because the owner is the
only person on it.

## The node user may sudo without a password

`/etc/sudoers.d/agent-board`: `agent-board ALL=(ALL) NOPASSWD:ALL`, validated with `visudo -c`. A session
on the node has no one to type a password, so a password-protected rule would stop every install it
tries. `SUDO_NOPASSWD=0` leaves the drop-in out.

## After the first sign-in, three things to set in each profile

Found on server-1, not yet in the script:

- mokubot's MCP bridge is opt-in per profile (`mcpSettings.enabled`, or the legacy `mcpBridgeEnabled`, in the
  extension's storage; the "MCP bridge" switch in the MokuBot panel). Until it is on, `netsuite_list_accounts`
  lists nothing. It connects while a NetSuite tab is open.
- Chrome Sync brings the account's extensions, each with processes of its own. On an 8 GB host with
  another browser on it the two profiles pushed the machine into swap. Turn off "Extensions" in
  Sync's settings and disable the extensions that came with it; keep mokutab and mokubot.
- A Google Workspace account makes the profile managed: choose to merge into the existing profile, so
  the account stays in the profile the units start.

## What the owner does by hand, once

Commands on the server run as the node user: `sudo -iu agent-board`, then
`export XDG_RUNTIME_DIR=/run/user/$(id -u)` for `systemctl --user`.

1. Bitwarden: `bw login --apikey` (client_id and client_secret from the web vault: Account settings,
   Security, Keys, API key). Then the password file, typed and never echoed:
   `(umask 077; read -rs -p 'Master password: ' p; printf '%s' "$p" > ~/.config/agent-board-bw/master-password; unset p; echo)`,
   then `systemctl --user restart agent-board-bw-unlock` and `journalctl --user -u agent-board-bw-unlock -n 3 -o cat` (says `unlocked`).
   When no node session is running: `systemctl --user restart herdr`.
2. Google sign-in per profile: `systemctl --user start agent-board-novnc@bsd agent-board-novnc@bb` on the
   server; `ssh -N -L 6080:127.0.0.1:6080 -L 6081:127.0.0.1:6081 <server>` on the laptop; open
   http://127.0.0.1:6080/vnc.html (bsd) and http://127.0.0.1:6081/vnc.html (bb), sign in to Chrome with the
   profile's Google account and turn Sync on, then sign in to NetSuite and Workato. Afterwards
   `systemctl --user stop agent-board-vnc@bsd agent-board-vnc@bb`.
