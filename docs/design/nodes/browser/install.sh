#!/usr/bin/env bash
# Equips an agent-board node with browser profiles, the mokutab and mokubot bridges,
# noVNC on demand and the Bitwarden CLI, all as systemd user units of the node user.
# Idempotent: run it again after changing a setting or the staged files.
#
#   sudo STAGE=/tmp/agent-board-browser bash install.sh
#
# STAGE holds what the script cannot fetch on its own (copied there from the owner's laptop):
#   mokutab/                    the unpacked mokutab extension (app/chrome-extension/dist/chrome-mv3)
#   mokubot/                    the unpacked mokubot extension (netsuite-assistant-extension/dist)
#   mokubot-mcp/                the mokubot MCP server: mcp-server/dist and mcp-server/package.json
#   mokutab-functions/          optional: the owner's mokutab browser functions (~/.mokutab/functions)
#   mokutab-fn-state.json       optional: their run state (fn-runs/fn-state.json), without which they list as drafts
# See README.md beside this file.
set -euo pipefail

NODE_USER=${NODE_USER:-agent-board}
STAGE=${STAGE:-/tmp/agent-board-browser}
CFT_VERSION=${CFT_VERSION:-155.0.8059.39}
# A Chrome for Testing already on the machine (its chrome-linux64 folder) is copied; without one the same
# version is downloaded.
CFT_FROM=${CFT_FROM:-}
# name:display:cdp port[:copy of]. VNC is 5900+display, noVNC 6030+display. The first profile is the one a
# CLI's browser login opens in (BROWSER). A fourth field makes a new profile as a copy of that one, logins
# included: a profile per client for Workato, which keeps the client workspace in the profile's cookie.
# A node passes its own list, the same one on every run: "work:50:9223 personal:51:9224 client-a:52:9225:personal".
PROFILES=${PROFILES:-"work:50:9223 personal:51:9224"}
# One mokutab bridge for every profile: each extension joins it under its profile name, as on a laptop.
# 12306 is mokutab's default; give another one where something else holds it (server-1: 12307).
MOKUTAB_PORT=${MOKUTAB_PORT:-12306}
MOKUTAB_BRIDGE_VERSION=${MOKUTAB_BRIDGE_VERSION:-2.1.0}
MOKUTAB_EXTENSION_ID=${MOKUTAB_EXTENSION_ID:-bpjpdgkeelhkijkllcmogemkmndgeana}
MOKUBOT_HTTP_PORT=${MOKUBOT_HTTP_PORT:-12440}
MOKUBOT_ALLOW_PROD_WRITES=${MOKUBOT_ALLOW_PROD_WRITES:-1}
# 1: the node user may sudo without a password (agents cannot type one); 0: no sudoers drop-in.
SUDO_NOPASSWD=${SUDO_NOPASSWD:-1}
# The mokutab bridge's default profile, where a call that names none goes. Empty: the first one in PROFILES.
DEFAULT_PROFILE=${DEFAULT_PROFILE:-}

say() { printf '== %s\n' "$*"; }

# host_wrapper <profile>: on stdout, the wrapper Chrome starts the profile's native host (the mokutab bridge)
# through, with a state folder per profile (B, PKG). It also hands the bridge the vault for the functions
# that read it (netsuite.login): BW_SESSION from the unlock unit's file when the vault is unlocked (BWDIR),
# and bw's own data folder (BW_APPDATA), which the per-profile XDG_CONFIG_HOME would hide from bw
# ("You are not logged in").
host_wrapper() {
  cat <<EOF
#!/bin/sh
export XDG_STATE_HOME="$B/state/$1/state" XDG_DATA_HOME="$B/state/$1/data" XDG_CONFIG_HOME="$B/state/$1/config"
[ -r "$BWDIR/session.env" ] && { set -a; . "$BWDIR/session.env"; set +a; }
export BITWARDENCLI_APPDATA_DIR="$BW_APPDATA"
mkdir -p "\$XDG_STATE_HOME" "\$XDG_DATA_HOME" "\$XDG_CONFIG_HOME"
exec "$PKG/dist/run_host.sh" "\$@"
EOF
}

# default_profile_json <file> <profile>: on stdout, the bridge's default-profile.json naming <profile>;
# nothing when the file already names it, so a second run keeps its set_at and makes no backup.
default_profile_json() {
  node -e '
    const fs = require("fs"), [file, profile] = process.argv.slice(-2)
    let was
    try { was = JSON.parse(fs.readFileSync(file, "utf8")).profile } catch {}
    if (was !== profile) console.log(JSON.stringify({ profile, set_at: new Date().toISOString() }))
  ' "$1" "$2"
}

# fix_bridge_scripts <pkg>: ensures every dist/*.sh in the mokutab-bridge package is executable
# (npm install --ignore-scripts skips postinstall, and 2.4.0 shipped dist/run_host.sh without +x).
fix_bridge_scripts() {
  local f
  for f in "$1"/dist/*.sh; do
    if [ -f "$f" ]; then chmod +x "$f"; fi
  done
}

# Sourced with INSTALL_SH_FUNCTIONS_ONLY=1 (the repository's tests), the script stops after its functions.
if [ "${INSTALL_SH_FUNCTIONS_ONLY:-}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
NAMES=$(for s in $PROFILES; do echo "${s%%:*}"; done)
[ -n "$DEFAULT_PROFILE" ] || DEFAULT_PROFILE=$(printf '%s\n' "$NAMES" | head -n 1)
printf '%s\n' "$NAMES" | grep -qxF -- "$DEFAULT_PROFILE" || { echo "DEFAULT_PROFILE $DEFAULT_PROFILE is not in PROFILES"; exit 1; }

id "$NODE_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$NODE_USER"
NODE_UID=$(id -u "$NODE_USER")
NODE_HOME=$(getent passwd "$NODE_USER" | cut -d: -f6)
B="$NODE_HOME/browser"
U="$NODE_HOME/.config/systemd/user"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$B/backups/$STAMP"
as_user() { runuser -u "$NODE_USER" -- env HOME="$NODE_HOME" XDG_RUNTIME_DIR="/run/user/$NODE_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$NODE_UID/bus" PATH="$NODE_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }
ucontrol() { as_user systemctl --user "$@"; }

# put <dest> <mode>: writes stdin to dest as the node user; an existing different file is backed up first.
put() {
  local dest=$1 mode=$2 tmp
  tmp=$(mktemp)
  cat >"$tmp"
  if [ -f "$dest" ] && ! cmp -s "$tmp" "$dest"; then
    mkdir -p "$BACKUP"; cp -a "$dest" "$BACKUP/$(echo "$dest" | tr / _)"
  fi
  install -D -o "$NODE_USER" -g "$NODE_USER" -m "$mode" "$tmp" "$dest"
  rm -f "$tmp"
}

for f in mokutab/manifest.json mokubot/manifest.json mokubot-mcp/package.json mokubot-mcp/dist/index.js; do
  [ -e "$STAGE/$f" ] || { echo "missing $STAGE/$f (see README.md)"; exit 1; }
done
command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] \
  || { echo "Node.js 22 or newer is needed (global WebSocket)"; exit 1; }
command -v npm >/dev/null || { echo "npm is needed"; exit 1; }

say "packages"
need=()
for p in xvfb x11vnc novnc websockify unzip; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
APT="apt-get -o Acquire::http::Timeout=30 -o Acquire::Retries=3"
if [ ${#need[@]} -gt 0 ]; then $APT update -qq && DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l $APT install -y -qq "${need[@]}"; fi

say "linger"
loginctl enable-linger "$NODE_USER"
for _ in $(seq 20); do [ -S "/run/user/$NODE_UID/bus" ] && break; sleep 0.5; done

if [ "$SUDO_NOPASSWD" = 1 ]; then
  say "sudoers"
  tmp=$(mktemp)
  printf '# agent-board node user: agents install what they need (written by install.sh)\n%s ALL=(ALL) NOPASSWD:ALL\n' "$NODE_USER" >"$tmp"
  visudo -cqf "$tmp" || { echo "sudoers drop-in does not validate"; exit 1; }
  if [ -f "/etc/sudoers.d/$NODE_USER" ] && ! cmp -s "$tmp" "/etc/sudoers.d/$NODE_USER"; then
    mkdir -p "$BACKUP"; cp -a "/etc/sudoers.d/$NODE_USER" "$BACKUP/etc_sudoers.d_$NODE_USER"
  fi
  install -o root -g root -m 0440 "$tmp" "/etc/sudoers.d/$NODE_USER"; rm -f "$tmp"
  visudo -cq
fi

say "chrome for testing $CFT_VERSION"
CHROME_DIR="$B/chrome/cft-$CFT_VERSION/chrome-linux64"
if [ ! -x "$CHROME_DIR/chrome" ]; then
  mkdir -p "$B/chrome/cft-$CFT_VERSION"
  if [ -n "$CFT_FROM" ] && [ -x "$CFT_FROM/chrome" ]; then
    cp -a "$CFT_FROM" "$B/chrome/cft-$CFT_VERSION/"
  else
    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/c.zip" "https://storage.googleapis.com/chrome-for-testing-public/$CFT_VERSION/linux64/chrome-linux64.zip"
    unzip -q "$tmp/c.zip" -d "$B/chrome/cft-$CFT_VERSION"; rm -rf "$tmp"
  fi
fi
chown -R "$NODE_USER:" "$B"
missing=$(ldd "$CHROME_DIR/chrome" | awk '/not found/{print $1}' || true)
if [ -n "$missing" ]; then
  echo "chrome lacks: $missing; installing its usual libraries"
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l $APT install -y -qq libnss3 libatk-bridge2.0-0t64 libcups2t64 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 fonts-liberation
fi
# Ubuntu 23.10+ forbids unprivileged user namespaces, which Chrome's sandbox needs: allow them for this binary.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  say "apparmor profile for chrome"
  tmp=$(mktemp)
  cat >"$tmp" <<EOF
abi <abi/4.0>,
include <tunables/global>
profile agent-board-chrome $B/chrome/*/chrome-linux64/chrome flags=(unconfined) {
  userns,
  include if exists <local/agent-board-chrome>
}
EOF
  if ! cmp -s "$tmp" /etc/apparmor.d/agent-board-chrome; then
    [ -f /etc/apparmor.d/agent-board-chrome ] && { mkdir -p "$BACKUP"; cp -a /etc/apparmor.d/agent-board-chrome "$BACKUP/"; }
    install -m 0644 "$tmp" /etc/apparmor.d/agent-board-chrome
  fi
  rm -f "$tmp"
  apparmor_parser -r /etc/apparmor.d/agent-board-chrome
fi

say "extensions and the mokubot server"
for e in mokutab mokubot; do
  mkdir -p "$B/extensions/$e"
  cp -a "$STAGE/$e/." "$B/extensions/$e/"
done
mkdir -p "$B/mokubot-mcp"
cp -a "$STAGE/mokubot-mcp/." "$B/mokubot-mcp/"
chown -R "$NODE_USER:" "$B"
as_user npm install --prefix "$B/mokubot-mcp" --omit=dev --ignore-scripts --no-fund --no-audit >/dev/null

if [ -d "$STAGE/mokutab-functions" ]; then
  say "mokutab functions"
  # Every profile's bridge runs as the node user and reads ~/.mokutab/functions. Same names are
  # replaced from the stage; functions saved on the node stay.
  install -d -o "$NODE_USER" -g "$NODE_USER" "$NODE_HOME/.mokutab" "$NODE_HOME/.mokutab/functions"
  cp -a "$STAGE/mokutab-functions/." "$NODE_HOME/.mokutab/functions/"
  chown -R "$NODE_USER:" "$NODE_HOME/.mokutab"
fi

say "bitwarden cli"
[ -x "$NODE_HOME/.local/bin/bw" ] || as_user npm install -g --prefix "$NODE_HOME/.local" --no-fund --no-audit @bitwarden/cli >/dev/null

BWDIR="$NODE_HOME/.config/agent-board-bw"
# Where bw keeps its login and vault: its default for the node user, which the unlock and sync units use too.
BW_APPDATA="$NODE_HOME/.config/Bitwarden CLI"

say "profiles"
NODE_BIN=$(command -v node)
# The mokutab bridge, one install: whichever profile starts first runs it, the others join it.
MT="$B/mokutab/bridge"
PKG="$MT/node_modules/@mokuhub/mokutab-bridge"
if [ "$(as_user node -p "require('$PKG/package.json').version" 2>/dev/null || true)" != "$MOKUTAB_BRIDGE_VERSION" ]; then
  as_user mkdir -p "$MT"
  as_user npm install --prefix "$MT" --ignore-scripts --no-fund --no-audit "@mokuhub/mokutab-bridge@$MOKUTAB_BRIDGE_VERSION" >/dev/null
fi
fix_bridge_scripts "$PKG"
printf '%s\n' "$NODE_BIN" | put "$PKG/dist/node_path.txt" 0644
FIRST=""
for spec in $PROFILES; do
  IFS=: read -r P DISP CDP FROM _ <<<"$spec"
  [ -n "$FIRST" ] || FIRST=$CDP
  # Copied once, while the source Chrome is stopped (the restart below brings it back). The cookies stay
  # readable in the copy because every profile keeps them under --password-store=basic.
  if [ -n "$FROM" ] && [ ! -d "$B/profiles/$P" ]; then
    [ -d "$B/profiles/$FROM" ] || { echo "profile $P: no profile $FROM to copy"; exit 1; }
    ucontrol stop "agent-board-chrome@$FROM.service" 2>/dev/null || true
    cp -a "$B/profiles/$FROM" "$B/profiles/$P"
    rm -f "$B/profiles/$P"/Singleton*
    say "profile $P: copied from $FROM"
  fi
  # The functions' run state: a function that never ran OK here is a hidden draft. Taken once, kept after.
  FNS="$B/state/$P/state/mcp-chrome-bridge/fn-runs"
  if [ -f "$STAGE/mokutab-fn-state.json" ] && [ ! -f "$FNS/fn-state.json" ]; then
    install -D -o "$NODE_USER" -g "$NODE_USER" -m 0644 "$STAGE/mokutab-fn-state.json" "$FNS/fn-state.json"
  fi
  host_wrapper "$P" | put "$B/bin/mokutab-host-$P" 0755
  # Whichever profile starts first runs the bridge with its own state folder, so each one names the default.
  # A stale name there (an old "default") makes the first profile to reconnect the default.
  DP="$B/state/$P/state/mcp-chrome-bridge/default-profile.json"
  DPJ=$(default_profile_json "$DP" "$DEFAULT_PROFILE")
  [ -z "$DPJ" ] || printf '%s\n' "$DPJ" | put "$DP" 0644
  # On Linux Chrome reads native messaging hosts from <user-data-dir>/NativeMessagingHosts.
  put "$B/profiles/$P/NativeMessagingHosts/com.chromemcp.nativehost.json" 0644 <<EOF
{
  "name": "com.chromemcp.nativehost",
  "description": "mokutab bridge ($P)",
  "path": "$B/bin/mokutab-host-$P",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$MOKUTAB_EXTENSION_ID/"]
}
EOF
  put "$B/profiles/$P.env" 0644 <<EOF
PROFILE=$P
DISPLAY_NUM=$DISP
CDP_PORT=$CDP
MOKUTAB_PORT=$MOKUTAB_PORT
VNC_PORT=$((5900 + DISP))
NOVNC_PORT=$((6030 + DISP))
EOF
done

say "helper scripts"
put "$B/bin/chrome-profile" 0755 <<EOF
#!/bin/sh
# chrome-profile <name>: the profile's Chrome on its own display, CDP on 127.0.0.1.
set -e
. "$B/profiles/\$1.env"
export DISPLAY=":\$DISPLAY_NUM"
exec "$CHROME_DIR/chrome" \\
  --user-data-dir="$B/profiles/\$1" \\
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="\$CDP_PORT" \\
  --load-extension="$B/extensions/mokutab,$B/extensions/mokubot" \\
  --disable-features=DisableLoadExtensionCommandLineSwitch \\
  --no-first-run --no-default-browser-check --password-store=basic \\
  --disable-dev-shm-usage --window-position=0,0 --window-size=1920,1080 --start-maximized
EOF

put "$B/bin/mokutab-seed-port.mjs" 0644 <<'EOF'
// mokutab-seed-port.mjs <cdp port> <bridge port> <extension id> <profile name>: points the profile's
// mokutab extension at the shared bridge port under its own profile name; reloads it when that changed.
const [cdp, port, id, name] = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let version
for (let i = 0; i < 60 && !version; i++) {
  try { version = await (await fetch('http://127.0.0.1:' + cdp + '/json/version')).json() } catch { await sleep(1000) }
}
if (!version) { console.error('no CDP on ' + cdp); process.exit(1) }
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
let seq = 0
const waiting = new Map()
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id) } }
const call = (method, params = {}, sessionId) => new Promise(r => {
  const n = ++seq; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params, sessionId }))
})
const { result: t } = await call('Target.createTarget', { url: 'chrome-extension://' + id + '/popup.html', background: true })
const { result: s } = await call('Target.attachToTarget', { targetId: t.targetId, flatten: true })
const want = JSON.stringify({ nativeServerPort: Number(port), profileName: name })
const expr = 'new Promise(async r => { const want = ' + want + '; const was = await chrome.storage.local.get(Object.keys(want));' +
  ' const same = was.nativeServerPort === want.nativeServerPort && was.profileName === want.profileName;' +
  ' if (!same) { await chrome.storage.local.set(want); setTimeout(() => chrome.runtime.reload(), 300) }' +
  ' r((same ? "kept " : "set ") + JSON.stringify(want)) })'
let out
for (let i = 0; i < 20; i++) {
  out = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s.sessionId)
  if (!out.result?.exceptionDetails && out.result?.result) break
  await sleep(500)
}
await call('Target.closeTarget', { targetId: t.targetId }).catch(() => {})
console.log('mokutab', out.result?.result?.value ?? JSON.stringify(out.result?.exceptionDetails ?? out.error))
ws.close()
EOF

put "$B/bin/open-in-chrome.mjs" 0644 <<'EOF'
// open-in-chrome.mjs <url>: opens the URL as a new tab in the browser profile named by
// AGENT_BROWSER_CDP (default 9223, the first profile). Used as BROWSER, so a CLI's browser login lands there.
const url = process.argv[2]
const port = process.env.AGENT_BROWSER_CDP || '9223'
const v = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json()
const ws = new WebSocket(v.webSocketDebuggerUrl)
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
await new Promise(r => { ws.onmessage = r; ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url } })) })
ws.close()
EOF
put "$B/bin/open-in-chrome" 0755 <<EOF
#!/bin/sh
# BROWSER for the node's sessions: a CLI's browser login opens as a tab in the first profile.
AGENT_BROWSER_CDP="\${AGENT_BROWSER_CDP:-$FIRST}" exec "$NODE_BIN" "$B/bin/open-in-chrome.mjs" "\$@"
EOF

# netsuite-login.mjs, put beside these by hand on a node, logged in through system.netsuite.com, which opens a
# session in the user's default account and ends that account's session everywhere else. The mokutab function
# netsuite.login logs in by the account's own URL; the old script goes to the backups.
if [ -f "$B/bin/netsuite-login.mjs" ]; then mkdir -p "$BACKUP"; mv "$B/bin/netsuite-login.mjs" "$BACKUP/"; fi

install -d -o "$NODE_USER" -g "$NODE_USER" -m 0700 "$BWDIR"
put "$B/bin/bw-unlock" 0755 <<EOF
#!/bin/sh
# Unlocks the vault from the 0600 password file and writes BW_SESSION for the herdr unit.
set -e
umask 077
F="$BWDIR/master-password"
[ -f "\$F" ] || { echo "no \$F yet"; exit 0; }
bw login --check >/dev/null 2>&1 || { echo "bw is not logged in yet"; exit 0; }
S=\$(bw unlock --passwordfile "\$F" --raw)
[ -n "\$S" ] || { echo "unlock gave no session"; exit 1; }
printf 'BW_SESSION=%s\n' "\$S" > "$BWDIR/session.env.tmp"
mv "$BWDIR/session.env.tmp" "$BWDIR/session.env"
echo "unlocked"
EOF

put "$B/bin/bw-provision" 0755 <<EOF
#!/bin/sh
# bw-provision: reads {"client_id","client_secret","master_password"} JSON on stdin (the owner's
# secret form), logs bw in with the API key, writes the 0600 password file and unlocks. Prints no value.
set -e
umask 077
J=\$(cat)
get() { printf '%s' "\$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s)[process.argv[1]]||""))' "\$1"; }
if ! bw login --check >/dev/null 2>&1; then
  BW_CLIENTID=\$(get client_id) BW_CLIENTSECRET=\$(get client_secret) bw login --apikey >/dev/null
fi
get master_password > "$BWDIR/master-password.tmp"
[ -s "$BWDIR/master-password.tmp" ] || { rm -f "$BWDIR/master-password.tmp"; echo "no master password given"; exit 1; }
mv "$BWDIR/master-password.tmp" "$BWDIR/master-password"
systemctl --user restart agent-board-bw-unlock.service
systemctl --user start agent-board-bw-sync.service
bw login --check >/dev/null && echo "bw logged in"
EOF

say "systemd user units"
put "$U/agent-board-xvfb@.service" 0644 <<'EOF'
[Unit]
Description=Xvfb display of browser profile %i (agent-board node)

[Service]
EnvironmentFile=%h/browser/profiles/%i.env
ExecStart=/usr/bin/Xvfb :${DISPLAY_NUM} -screen 0 1920x1080x24 -nolisten tcp -noreset
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
put "$U/agent-board-chrome@.service" 0644 <<EOF
[Unit]
Description=Chrome of browser profile %i (agent-board node)
Requires=agent-board-xvfb@%i.service
After=agent-board-xvfb@%i.service agent-board-mokubot-mcp.service

[Service]
EnvironmentFile=%h/browser/profiles/%i.env
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStartPre=/bin/sh -c 'for i in \$(seq 50); do [ -e /tmp/.X11-unix/X\$DISPLAY_NUM ] && exit 0; sleep 0.2; done; exit 1'
ExecStart=%h/browser/bin/chrome-profile %i
ExecStartPost=-$NODE_BIN %h/browser/bin/mokutab-seed-port.mjs \${CDP_PORT} \${MOKUTAB_PORT} $MOKUTAB_EXTENSION_ID \${PROFILE}
Restart=on-failure
RestartSec=5
TimeoutStartSec=120

[Install]
WantedBy=default.target
EOF
put "$U/agent-board-mokubot-mcp.service" 0644 <<EOF
[Unit]
Description=mokubot MCP server, HTTP 127.0.0.1:$MOKUBOT_HTTP_PORT (agent-board node)

[Service]
Environment=MOKUBOT_MCP_HTTP_PORT=$MOKUBOT_HTTP_PORT
Environment=MOKUBOT_MCP_ALLOW_PROD_WRITES=$MOKUBOT_ALLOW_PROD_WRITES
Environment=MOKUBOT_MCP_LOG_FILE=%h/browser/state/mokubot-mcp.log
ExecStart=$NODE_BIN %h/browser/mokubot-mcp/dist/index.js --http
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
put "$U/agent-board-vnc@.service" 0644 <<'EOF'
[Unit]
Description=x11vnc on the display of browser profile %i, 127.0.0.1 only (agent-board node)
Requires=agent-board-xvfb@%i.service
After=agent-board-xvfb@%i.service

[Service]
EnvironmentFile=%h/browser/profiles/%i.env
ExecStart=/usr/bin/x11vnc -display :${DISPLAY_NUM} -localhost -rfbport ${VNC_PORT} -nopw -forever -shared -quiet
SuccessExitStatus=1 2 3 15
Restart=on-failure
EOF
put "$U/agent-board-novnc@.service" 0644 <<'EOF'
[Unit]
Description=noVNC for browser profile %i, 127.0.0.1 only, on demand (agent-board node)
Requires=agent-board-vnc@%i.service
After=agent-board-vnc@%i.service
PartOf=agent-board-vnc@%i.service

[Service]
EnvironmentFile=%h/browser/profiles/%i.env
ExecStart=/usr/bin/websockify --web /usr/share/novnc 127.0.0.1:${NOVNC_PORT} 127.0.0.1:${VNC_PORT}
Restart=on-failure
EOF
put "$U/agent-board-bw-unlock.service" 0644 <<'EOF'
[Unit]
Description=Unlock Bitwarden for agent-board sessions (BW_SESSION into an EnvironmentFile)
Before=herdr.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/browser/bin/bw-unlock

[Install]
WantedBy=default.target
EOF
put "$U/agent-board-bw-sync.service" 0644 <<EOF
[Unit]
Description=bw sync (agent-board node)
After=agent-board-bw-unlock.service

[Service]
Type=oneshot
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-$BWDIR/session.env
ExecStart=/bin/sh -c '[ -n "\$BW_SESSION" ] || { echo "vault not unlocked"; exit 0; }; bw sync'
EOF
put "$U/agent-board-bw-sync.timer" 0644 <<'EOF'
[Unit]
Description=bw sync hourly (agent-board node)

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
put "$U/herdr.service.d/bitwarden.conf" 0644 <<EOF
# BW_SESSION for the node's sessions, written by agent-board-bw-unlock.service.
[Unit]
Wants=agent-board-bw-unlock.service
After=agent-board-bw-unlock.service

[Service]
EnvironmentFile=-$BWDIR/session.env
EOF

# The bundle does not send the master's loopback MCP servers ("bound (local-url)"), so these names are the node's own.
say "mokutab and mokubot-netsuite in the node's .claude.json, BROWSER in its settings"
for CJ in "$NODE_HOME/.claude.json" "$NODE_HOME/.claude-work/.claude.json"; do
if [ -f "$CJ" ]; then
  mkdir -p "$BACKUP"; cp -a "$CJ" "$BACKUP/$(echo "$CJ" | tr / _)"
  as_user node -e '
    const fs = require("fs"), [file, mokutab, mokubot, ...names] = process.argv.slice(1)
    const d = JSON.parse(fs.readFileSync(file, "utf8")); d.mcpServers ||= {}
    d.mcpServers.mokutab = { type: "http", url: "http://127.0.0.1:" + mokutab + "/mcp" }
    for (const n of names) delete d.mcpServers["mokutab-" + n]
    d.mcpServers["mokubot-netsuite"] = { type: "http", url: "http://127.0.0.1:" + mokubot + "/mcp" }
    fs.writeFileSync(file + ".tmp", JSON.stringify(d, null, 2)); fs.renameSync(file + ".tmp", file)
  ' "$CJ" "$MOKUTAB_PORT" "$MOKUBOT_HTTP_PORT" $(for s in $PROFILES; do echo "${s%%:*}"; done)
  if [ "$CJ" = "$NODE_HOME/.claude.json" ]; then SJ="$NODE_HOME/.claude/settings.json"; else SJ="$(dirname "$CJ")/settings.json"; fi
  [ -f "$SJ" ] && as_user node -e '
    const fs = require("fs"), [file, browser] = process.argv.slice(1)
    const s = JSON.parse(fs.readFileSync(file, "utf8")); s.env ||= {}; s.env.BROWSER = browser
    fs.writeFileSync(file + ".tmp", JSON.stringify(s, null, 2) + "\n"); fs.renameSync(file + ".tmp", file)
  ' "$SJ" "$B/bin/open-in-chrome"
fi
done

say "start"
mkdir -p "$B/state"; chown -R "$NODE_USER:" "$B"
ucontrol daemon-reload
units="agent-board-mokubot-mcp.service agent-board-bw-unlock.service agent-board-bw-sync.timer"
for s in $PROFILES; do units="$units agent-board-xvfb@${s%%:*}.service agent-board-chrome@${s%%:*}.service"; done
# shellcheck disable=SC2086
ucontrol enable $units >/dev/null 2>&1
# shellcheck disable=SC2086
ucontrol restart $units
ucontrol --no-pager --plain list-units 'agent-board-*' | head -n 20
[ -d "$BACKUP" ] && echo "backups: $BACKUP"
echo "herdr.service reads BW_SESSION after its next restart (systemctl --user restart herdr: it ends the node's running sessions)."
