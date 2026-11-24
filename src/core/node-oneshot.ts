// "Add a computer" (#513, docs/design/nodes 11.2, 20.2): the one-line POSIX sh installer for a
// computer behind NAT (Linux and macOS, current user, no root, no master token). Pure, with no
// node: import: gzip packing is the caller's.
import { BOARD_PORTS } from './node-computer-setup.ts'
import {
  BUN_INSTALLER,
  BUN_VERSION,
  CLAUDE_INSTALLER,
  HERDR_INSTALLER,
  HERDR_MIN,
  herdrUnit,
  PROFILE_BEGIN,
  PROFILE_END,
  profileBlock,
} from './node-install-consts.ts'
import { JOIN_CODE } from './node-join.ts'
import { DEVICE_ID, LOCAL } from './node-key.ts'
import { NODE_PORT } from './nodes.ts'
import { RELAY_KEY_NAME, RELAY_NODE_USER } from './relay-texts.ts'
import { shQuote } from './server-shell.ts'

export const DEFAULT_PLUGIN_REPO = 'https://github.com/MokuTeam/herdr-agent-board.git'
export const LAUNCHD_LABEL = 'dev.herdr.server'

const KEY_END = 'AGENT_BOARD_RELAY_KEY'
const KH_END = 'AGENT_BOARD_KNOWN_HOSTS'
const UNIT_END = 'AGENT_BOARD_HERDR_UNIT'
const PROFILE_MARKER_END = 'AGENT_BOARD_PROFILE_BLOCK'

const hasControl = (s: string): boolean => [...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
const hasLineControl = (s: string): boolean =>
  [...s].some(c => {
    const code = c.charCodeAt(0)
    return (code < 32 && code !== 10) || code === 127
  })
const isWord = (v: string): boolean =>
  v.length > 0 && v.length <= 255 && !v.startsWith('-') && !/\s/.test(v) && !hasControl(v)

export interface NodeOneshotInput {
  relay: {
    host: string
    sshPort: number
    user?: string
    socket: string
    /** Public known_hosts line(s) pinning the relay server's SSH host key. */
    hostKey: string
  }
  /** Private OpenSSH dial key for agent-board-relay-n only (never any master key). */
  dialKey: string
  /** One-time 10-minute join code used only to authenticate the claim and prove the door hello. */
  code: string
  expiresAt: number
  /** Master's git commit sha; empty when unknown. */
  commit?: string
  repoUrl?: string
  /** Optional explicit device id; derived from hostname when omitted. */
  id?: string
  port?: number
  workRoot?: string
}

function assertCleanBlock(label: string, text: string, sentinel: string): void {
  if (!text.trim() || hasLineControl(text)) throw new Error(`invalid ${label}`)
  if (text.split('\n').some(line => line.trim() === sentinel)) throw new Error(`${label} holds ${sentinel}`)
}

function validateInput(i: NodeOneshotInput): {
  host: string
  sshPort: number
  user: string
  socket: string
  hostKey: string
  dialKey: string
  code: string
  expiresAt: number
  commit: string
  repoUrl: string
  id: string
  port: number
  workRoot: string
} {
  const host = i.relay.host.trim()
  const sshPort = i.relay.sshPort
  const user = (i.relay.user ?? RELAY_NODE_USER).trim()
  const socket = i.relay.socket.trim()
  const hostKey = i.relay.hostKey.trim()
  const dialKey = i.dialKey.trimEnd()
  const code = i.code.trim()
  const expiresAt = i.expiresAt
  const commit = (i.commit ?? '').trim()
  const repoUrl = (i.repoUrl ?? DEFAULT_PLUGIN_REPO).trim()
  const id = (i.id ?? '').trim()
  const port = i.port ?? NODE_PORT
  const workRoot = (i.workRoot ?? '~/work').trim()

  if (!isWord(host)) throw new Error('invalid relay host')
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error('invalid relay sshPort')
  if (!isWord(user)) throw new Error('invalid relay user')
  if (!RELAY_KEY_NAME.test(socket)) throw new Error('invalid relay socket')
  assertCleanBlock('relay hostKey', hostKey, KH_END)
  assertCleanBlock('dialKey', dialKey, KEY_END)
  if (!dialKey.includes('BEGIN ') || !dialKey.includes('PRIVATE KEY')) throw new Error('invalid dialKey')
  if (!JOIN_CODE.test(code)) throw new Error('invalid join code')
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) throw new Error('invalid join expiry')
  if (commit && !/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error('invalid commit')
  if (!isWord(repoUrl)) throw new Error('invalid repoUrl')
  if (id && (!DEVICE_ID.test(id) || id === LOCAL)) throw new Error('invalid device id')
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || BOARD_PORTS.includes(port))
    throw new Error('invalid door port')
  if (!workRoot || workRoot.length > 1024 || hasControl(workRoot)) throw new Error('invalid workRoot')

  return { host, sshPort, user, socket, hostKey, dialKey, code, expiresAt, commit, repoUrl, id, port, workRoot }
}

const xmlEscape = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** macOS launchd user agent plist for `herdr server`. */
export function launchdPlist(home: string): string {
  const escHome = xmlEscape(home)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escHome}/.local/bin/herdr</string>`,
    '    <string>server</string>',
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${escHome}/.local/bin:${escHome}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>`,
    '    <key>TERM</key>',
    '    <string>xterm-256color</string>',
    '    <key>DISABLE_AUTOUPDATER</key>',
    '    <string>1</string>',
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${escHome}/Library/Logs/herdr-server.log</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escHome}/Library/Logs/herdr-server.err.log</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/** JS snippet run via `bun -e` to merge `node` into config.json safely (refuses corrupt JSON with exit 3). */
const MERGE_NODE_CONFIG_JS = [
  'const fs=require("fs"),e=process.env,p=e.AB_CFG;',
  'let raw="";try{raw=fs.readFileSync(p,"utf8")}catch(err){if(err&&err.code!=="ENOENT")throw err}',
  'let c={};',
  'if(raw.trim()){try{c=JSON.parse(raw)}catch{console.error("config.json does not parse: left untouched");process.exit(3)}}',
  'if(typeof c!=="object"||c===null||Array.isArray(c)){console.error("config.json is not an object: left untouched");process.exit(3)}',
  'const prev=typeof c.node==="object"&&c.node!==null&&!Array.isArray(c.node)?c.node:{};',
  'c.node={...prev,id:e.AB_ID,port:Number(e.AB_PORT),workRoot:e.AB_WORK,tls:true,relay:{host:e.AB_R_HOST,sshPort:Number(e.AB_R_PORT),user:e.AB_R_USER,socket:e.AB_R_SOCK}};',
  'const tmp=p+".part."+process.pid;',
  'fs.writeFileSync(tmp,JSON.stringify(c,null,2)+"\\n",{mode:0o600});',
  'fs.renameSync(tmp,p);',
].join('')

/** JS snippet run via `bun -e` to write the macOS LaunchAgent plist safely with XML escaping. */
const WRITE_PLIST_JS = [
  'const fs=require("fs"),e=process.env,p=e.AB_PLIST,h=e.HOME||"";',
  'const esc=s=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll("\\"","&quot;");',
  'const eh=esc(h);',
  `const xml=\`<?xml version="1.0" encoding="UTF-8"?>\\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\\n<plist version="1.0">\\n<dict>\\n  <key>Label</key>\\n  <string>${LAUNCHD_LABEL}</string>\\n  <key>ProgramArguments</key>\\n  <array>\\n    <string>\${eh}/.local/bin/herdr</string>\\n    <string>server</string>\\n  </array>\\n  <key>EnvironmentVariables</key>\\n  <dict>\\n    <key>PATH</key>\\n    <string>\${eh}/.local/bin:\${eh}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>\\n    <key>TERM</key>\\n    <string>xterm-256color</string>\\n    <key>DISABLE_AUTOUPDATER</key>\\n    <string>1</string>\\n  </dict>\\n  <key>RunAtLoad</key>\\n  <true/>\\n  <key>KeepAlive</key>\\n  <dict>\\n    <key>SuccessfulExit</key>\\n    <false/>\\n  </dict>\\n  <key>StandardOutPath</key>\\n  <string>\${eh}/Library/Logs/herdr-server.log</string>\\n  <key>StandardErrorPath</key>\\n  <string>\${eh}/Library/Logs/herdr-server.err.log</string>\\n</dict>\\n</plist>\\n\`;`,
  'const tmp=p+".part."+process.pid;fs.writeFileSync(tmp,xml,{mode:0o644});fs.renameSync(tmp,p);',
].join('')

/**
 * Generates the POSIX sh script that installs Bun, herdr, Claude Code and the plugin for the
 * current user (no root), configures the NAT relay and one-time join code, and starts herdr.
 * Never embeds any master token or master relay key.
 */
export function nodeOneshotScript(input: NodeOneshotInput): string {
  const v = validateInput(input)
  const joinJson = JSON.stringify({ code: v.code, expiresAt: v.expiresAt, attempts: 0 })
  return [
    '#!/bin/sh',
    '# agent-board: connect this computer behind NAT as a board node (user install, no root).',
    'set -eu',
    'umask 077',
    'LC_ALL=C; export LC_ALL',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${...}
    'HOME=${HOME:?HOME must be set}',
    'PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH',
    '',
    'say() { printf \'%s\\n\' "$*"; }',
    'fail() { printf \'agent-board: %s\\n\' "$*" >&2; exit 1; }',
    'write_file_mode() {',
    '  _dst=$1; _mode=$2',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    '  _dir=${_dst%/*}',
    '  mkdir -p "$_dir"',
    '  _part="$_dst.part.$$"',
    '  cat > "$_part"',
    '  chmod "$_mode" "$_part"',
    '  mv -f "$_part" "$_dst"',
    '}',
    "ver_extract() { sed -n 's/^[^0-9]*\\([0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\).*$/\\1/p' | head -n 1; }",
    'ver_ge() {',
    '  awk -v a="$1" -v b="$2" \'BEGIN { if (a == "") exit 1; split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 0 }\'',
    '}',
    '',
    'OS=$(uname -s)',
    'case "$OS" in',
    '  Linux|Darwin) ;;',
    '  *) fail "unsupported system: $OS (Linux and macOS only)" ;;',
    'esac',
    'for _c in git curl ssh awk sed; do',
    '  command -v "$_c" >/dev/null 2>&1 || fail "$_c is required on PATH"',
    'done',
    '',
    `RELAY_HOST=${shQuote(v.host)}`,
    `RELAY_SSH_PORT=${shQuote(String(v.sshPort))}`,
    `RELAY_USER=${shQuote(v.user)}`,
    `RELAY_SOCKET=${shQuote(v.socket)}`,
    `NODE_PORT=${shQuote(String(v.port))}`,
    `WORK_ROOT=${shQuote(v.workRoot)}`,
    `REPO_URL=${shQuote(v.repoUrl)}`,
    `TARGET_COMMIT=${shQuote(v.commit)}`,
    `EXPLICIT_ID=${shQuote(v.id)}`,
    `JOIN_JSON=${shQuote(joinJson)}`,
    `BUN_MIN=${shQuote(BUN_VERSION)}`,
    `HERDR_MIN=${shQuote(HERDR_MIN)}`,
    '',
    'BUN_CMD=$(command -v bun 2>/dev/null || true)',
    'BUN_VER=""',
    'if [ -n "$BUN_CMD" ]; then BUN_VER=$("$BUN_CMD" --version 2>/dev/null | ver_extract || true); fi',
    'if [ -z "$BUN_CMD" ] || ! ver_ge "$BUN_VER" "$BUN_MIN"; then',
    '  command -v unzip >/dev/null 2>&1 || fail "unzip is required to install Bun"',
    '  command -v bash >/dev/null 2>&1 || fail "bash is required to install Bun"',
    '  say "Installing Bun $BUN_MIN..."',
    `  curl -fsSL ${shQuote(BUN_INSTALLER)} | bash -s ${shQuote(`bun-v${BUN_VERSION}`)}`,
    '  BUN_CMD="$HOME/.bun/bin/bun"',
    'fi',
    'BUN_VER=$("$BUN_CMD" --version 2>/dev/null | ver_extract || true)',
    'ver_ge "$BUN_VER" "$BUN_MIN" || fail "Bun >= $BUN_MIN could not be installed"',
    '',
    'HERDR_CMD=$(command -v herdr 2>/dev/null || true)',
    'HERDR_VER=""',
    'if [ -n "$HERDR_CMD" ]; then HERDR_VER=$("$HERDR_CMD" --version 2>/dev/null | ver_extract || true); fi',
    'if [ -z "$HERDR_CMD" ] || ! ver_ge "$HERDR_VER" "$HERDR_MIN"; then',
    '  say "Installing herdr..."',
    `  curl -fsSL ${shQuote(HERDR_INSTALLER)} | sh`,
    '  HERDR_CMD="$HOME/.local/bin/herdr"',
    'fi',
    'HERDR_VER=$("$HERDR_CMD" --version 2>/dev/null | ver_extract || true)',
    'ver_ge "$HERDR_VER" "$HERDR_MIN" || fail "herdr >= $HERDR_MIN could not be installed"',
    '',
    'if ! command -v claude >/dev/null 2>&1; then',
    '  command -v bash >/dev/null 2>&1 || fail "bash is required to install Claude Code"',
    '  say "Installing Claude Code..."',
    `  curl -fsSL ${shQuote(CLAUDE_INSTALLER)} | bash`,
    'fi',
    '',
    'PLUGIN_DIR="$HOME/agent-board"',
    'if [ ! -d "$PLUGIN_DIR/.git" ]; then',
    '  if [ -e "$PLUGIN_DIR" ]; then fail "$PLUGIN_DIR exists and is not a git checkout"; fi',
    '  say "Cloning agent-board..."',
    '  git clone "$REPO_URL" "$PLUGIN_DIR"',
    'else',
    '  git -C "$PLUGIN_DIR" fetch --tags origin',
    'fi',
    'if [ -n "$TARGET_COMMIT" ]; then',
    '  if ! git -C "$PLUGIN_DIR" cat-file -e "$TARGET_COMMIT^{commit}" 2>/dev/null; then',
    '    git -C "$PLUGIN_DIR" fetch origin "$TARGET_COMMIT" 2>/dev/null || true',
    '  fi',
    '  if git -C "$PLUGIN_DIR" cat-file -e "$TARGET_COMMIT^{commit}" 2>/dev/null; then',
    '    git -C "$PLUGIN_DIR" checkout --detach "$TARGET_COMMIT"',
    '  else',
    '    say "Note: commit $TARGET_COMMIT is not published on origin; keeping current branch (master will update after claim)."',
    '  fi',
    'fi',
    '(cd "$PLUGIN_DIR" && "$BUN_CMD" install --production)',
    '"$HERDR_CMD" plugin link "$PLUGIN_DIR"',
    '',
    'if [ -n "$EXPLICIT_ID" ]; then',
    '  NODE_ID=$EXPLICIT_ID',
    'else',
    '  RAW_HOST=$(hostname -s 2>/dev/null || hostname 2>/dev/null || printf computer)',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX shell parameter expansion
    '  RAW_HOST=${RAW_HOST%%.*}',
    "  NODE_ID=$(printf '%s' \"$RAW_HOST\" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/^-*//' | cut -c1-32 | sed 's/-*$//')",
    '  if [ -z "$NODE_ID" ] || [ "$NODE_ID" = "local" ]; then NODE_ID=computer; fi',
    'fi',
    '',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${...}
    'CFG_DIR="${APPDATA:-$HOME/.config}/herdr/plugins/config/agent-board"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${...}
    'STATE_DIR="${LOCALAPPDATA:-$HOME/.local/state}/herdr/plugins/agent-board"',
    'NODE_DIR="$STATE_DIR/node"',
    'mkdir -p "$CFG_DIR" "$NODE_DIR"',
    'chmod 700 "$NODE_DIR"',
    '',
    `write_file_mode "$NODE_DIR/relay-key" 600 <<'${KEY_END}'`,
    v.dialKey,
    KEY_END,
    `write_file_mode "$NODE_DIR/relay-known-hosts" 600 <<'${KH_END}'`,
    v.hostKey,
    KH_END,
    'printf \'%s\\n\' "$JOIN_JSON" | write_file_mode "$NODE_DIR/join.json" 600',
    '',
    'CFG_FILE="$CFG_DIR/config.json"',
    `AB_CFG="$CFG_FILE" AB_ID="$NODE_ID" AB_PORT="$NODE_PORT" AB_WORK="$WORK_ROOT" AB_R_HOST="$RELAY_HOST" AB_R_PORT="$RELAY_SSH_PORT" AB_R_USER="$RELAY_USER" AB_R_SOCK="$RELAY_SOCKET" "$BUN_CMD" -e ${shQuote(MERGE_NODE_CONFIG_JS)}`,
    '',
    'say "Installing board hooks and commands..."',
    '"$BUN_CMD" "$PLUGIN_DIR/src/entrypoints/install.ts"',
    '',
    'PROFILE_FILE="$HOME/.profile"',
    'if [ -f "$PROFILE_FILE" ]; then',
    `  awk -v b=${shQuote(PROFILE_BEGIN)} -v e=${shQuote(PROFILE_END)} '$0 == b { s = 1 } !s { print } s && $0 == e { s = 0 }' "$PROFILE_FILE" > "$PROFILE_FILE.tmp.$$"`,
    'else',
    '  : > "$PROFILE_FILE.tmp.$$"',
    'fi',
    `cat <<'${PROFILE_MARKER_END}' >> "$PROFILE_FILE.tmp.$$"`,
    profileBlock().trimEnd(),
    PROFILE_MARKER_END,
    'chmod 644 "$PROFILE_FILE.tmp.$$"',
    'mv -f "$PROFILE_FILE.tmp.$$" "$PROFILE_FILE"',
    '',
    'if [ "$OS" = "Linux" ]; then',
    '  UNIT_FILE="$HOME/.config/systemd/user/herdr.service"',
    `  write_file_mode "$UNIT_FILE" 644 <<'${UNIT_END}'`,
    herdrUnit().trimEnd(),
    UNIT_END,
    '  if command -v systemctl >/dev/null 2>&1; then',
    '    systemctl --user daemon-reload >/dev/null 2>&1 || true',
    '    systemctl --user enable herdr.service >/dev/null 2>&1 || true',
    '    if ! systemctl --user is-active --quiet herdr.service >/dev/null 2>&1; then',
    '      systemctl --user start herdr.service >/dev/null 2>&1 || say "Note: start herdr with: herdr server"',
    '    fi',
    '  fi',
    'else',
    '  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"',
    `  PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"`,
    `  AB_PLIST="$PLIST" "$BUN_CMD" -e ${shQuote(WRITE_PLIST_JS)}`,
    '  if command -v launchctl >/dev/null 2>&1; then',
    '    _uid=$(id -u)',
    `    if ! launchctl print "gui/$_uid/${LAUNCHD_LABEL}" >/dev/null 2>&1; then`,
    '      launchctl bootstrap "gui/$_uid" "$PLIST" >/dev/null 2>&1 || launchctl load -w "$PLIST" >/dev/null 2>&1 || say "Note: start herdr with: herdr server"',
    '    fi',
    '  fi',
    'fi',
    '',
    'say "Done: $NODE_ID is configured and dialing the relay. Click Approve on your master board."',
    '',
  ].join('\n')
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

/** The one-line command the owner pastes into a terminal on the computer behind NAT. */
export function nodeOneLine(script: string, gzip: (bytes: Uint8Array) => Uint8Array): string {
  const b64 = base64(gzip(new TextEncoder().encode(script)))
  return `echo ${b64} | { case $(uname -s) in Darwin) base64 -D;; *) base64 -d;; esac; } | gunzip | sh`
}
