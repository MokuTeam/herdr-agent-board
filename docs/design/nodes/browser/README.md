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
| `bsd` (Boston SD, Centium too) | :50 | 127.0.0.1:9223 | 5950 | 127.0.0.1:6080 |
| `bb` (Blu Banyan) | :51 | 127.0.0.1:9224 | 5951 | 127.0.0.1:6081 |

- Chrome for Testing 155 is copied from `/opt/nanoclaw-host/browsers/` when it is there, else the same
  version is downloaded; it lives in `~/browser/chrome/`. Profiles are in `~/browser/profiles/<name>/`
  and persist. Windows profiles cannot be copied (DPAPI): each profile is signed in once by hand.
- The mokutab and mokubot extensions are loaded unpacked from `~/browser/extensions/`.
- mokutab: one bridge for every profile, as on a laptop. Chrome on Linux finds the native messaging host
  in `<user-data-dir>/NativeMessagingHosts/`; whichever profile starts first runs the bridge
  (`~/browser/mokutab/bridge`) on `MOKUTAB_PORT` (12306), and the others join it over its WebSocket under
  their profile name. `ExecStartPost` sets each extension's port and profile name over CDP. Where another
  browser on the host holds 12306 (server-1), give `MOKUTAB_PORT=12307`.
- mokubot: one MCP server (`agent-board-mokubot-mcp`, HTTP 127.0.0.1:12440, WebSocket bridge from
  8765); the extensions of both profiles connect to it, and the tools pick the NetSuite account by
  `account_id` (`netsuite_list_accounts`).

- The owner's mokutab browser functions (`chrome_fn_list`): both bridges run as the node user and read
  `~/.mokutab/functions`, so one copy serves every profile. A function that never ran OK on a machine is
  a hidden draft there; the laptop's `fn-state.json`, put into each profile's state once, carries that over.

Units: `agent-board-xvfb@<name>`, `agent-board-chrome@<name>`, `agent-board-mokubot-mcp`, enabled;
`agent-board-vnc@<name>` and `agent-board-novnc@<name>`, on demand.

## The node's sessions find the servers under their usual names

The board's bundle does not send the master's loopback MCP servers (its report says
`bound (local-url)`), so the script writes these into the node user's `~/.claude.json` and the bundle
leaves them alone:

- `mokutab`: `http://127.0.0.1:12306/mcp`; a call names the profile (`bsd`, `bb`) or goes to the first.
- `mokubot-netsuite`: `http://127.0.0.1:12440/mcp`.

Both Claude profiles of the node (`~/.claude.json`, `~/.claude-work/.claude.json`) get them, and their
`settings.json` gets `BROWSER=~/browser/bin/open-in-chrome`: a CLI's browser login (`suitecloud
account:setup`, `gh auth login --web`) opens as a tab in the first profile, where an agent approves it
(for SuiteCloud: the mokutab function `netsuite.sdf_consent`). SuiteCloud's saved logins do not travel
from a Windows laptop (its `credentials` file is bound to that machine), so each account is set up again there.

Avid stays on the laptop (it needs the VPN): no profile for it here.

## Bitwarden unlocks at start and syncs every hour

- `bw` is installed with npm into `~/.local`, logged in with the owner's API key.
- `agent-board-bw-unlock` (oneshot) runs `bw unlock --passwordfile ~/.config/agent-board-bw/master-password`
  and writes `BW_SESSION` into `~/.config/agent-board-bw/session.env` (folder 0700, files 0600).
- `herdr.service.d/bitwarden.conf` gives `herdr` that file as its `EnvironmentFile` and orders it after the
  unlock, so sessions started by the node have `BW_SESSION`. `herdr` reads it on its next restart.
- `agent-board-bw-sync.timer` runs `bw sync` hourly.

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
