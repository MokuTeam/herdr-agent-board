// What the relay setup writes on a server (core/relay-plan.ts, design docs/design/nodes/README.md 20):
// two fenced system users (agent-board-relay-n for nodes behind NAT making remote socket forwards,
// agent-board-relay-m for masters opening local socket forwards and running the enrolment command),
// the sockets folder (2750, owned by n:m), a separate folder for enrolled node public keys (700,
// owned by m:m so n cannot tamper with it), the AuthorizedKeysCommand script, the forced-command
// enrol script, the master keys file, and sshd's Match blocks (drop-in or marked block).
// Disjoint from the tunnel (/etc/agent-board, /var/lib/boardtunnel), backup (/etc/agent-board-backup),
// and node (/etc/agent-board-node) paths and markers. Pure, with no node: import.

import { shQuote } from './server-shell.ts'
import { keysFile } from './tunnel-snippets.ts'

/** The system user that nodes behind NAT connect as to create remote unix socket forwards. */
export const RELAY_NODE_USER = 'agent-board-relay-n' as const
export const RELAY_NODE_COMMENT = 'agent-board relay node'

/** The system user that masters connect as to open unix sockets or run the enrolment script. */
export const RELAY_MASTER_USER = 'agent-board-relay-m' as const
export const RELAY_MASTER_COMMENT = 'agent-board relay master'

/**
 * The folder where node sockets live: mode 2750, owned by agent-board-relay-n and group
 * agent-board-relay-m, so the node user creates sockets and the master user opens them.
 */
export const RELAY_SOCKETS_DIR = '/var/lib/agent-board-relay'

/**
 * The folder where enrolled node public keys live: mode 700, owned by agent-board-relay-m.
 * Kept outside RELAY_SOCKETS_DIR so the node user cannot read, rename or replace it.
 */
export const RELAY_KEYS_DIR = '/var/lib/agent-board-relay-keys'

/** The relay's own config/scripts folder on the server. */
export const RELAY_ETC = '/etc/agent-board-relay'
export const RELAY_KEYS_CMD = `${RELAY_ETC}/keys`
export const RELAY_ENROL_SCRIPT = `${RELAY_ETC}/enrol`
export const RELAY_RECORD = `${RELAY_ETC}/setup.json`
export const RELAY_RUN_LOCK = '/run/agent-board-relay.lock'

export const AUTH_KEYS_DIR = '/etc/ssh/authorized_keys'
export const RELAY_MASTER_KEYS = `${AUTH_KEYS_DIR}/${RELAY_MASTER_USER}`
export const RELAY_FENCE = '/etc/ssh/sshd_config.d/00-agent-board-relay.conf'

/** Block markers for plain sshd_config without Include; must not start with `# >>> agent-board`. */
export const RELAY_BLOCK_BEGIN = '# >>> relay of agent-board'
export const RELAY_BLOCK_END = '# <<< relay of agent-board'

export const ENROL_VERSION = 1
export const RELAY_MAX_KEYS = 256

/** Valid enrolled key file stem (node id / socket key name). */
export const RELAY_KEY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

const KEY_PREFIXES: Readonly<Record<string, string>> = {
  'ssh-ed25519': 'AAAAC3NzaC1lZDI1NTE5',
  'ssh-rsa': 'AAAAB3NzaC1yc2E',
  'ecdsa-sha2-nistp256': 'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY',
  'ecdsa-sha2-nistp384': 'AAAAE2VjZHNhLXNoYTItbmlzdHAzODQ',
  'ecdsa-sha2-nistp521': 'AAAAE2VjZHNhLXNoYTItbmlzdHA1MjE',
}
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/
const hasControl = (s: string): boolean => [...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)

/**
 * Extracts `<type> <base64>` if `raw` is a clean OpenSSH public key line (no options, no newlines,
 * matching key-type base64 prefix, valid base64 length); null otherwise.
 */
export function relayKeyBody(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || hasControl(trimmed)) return null
  const parts = trimmed.split(/\s+/)
  if (parts.length < 2) return null
  const [type = '', body = '', ...rest] = parts
  const prefix = KEY_PREFIXES[type]
  if (!prefix) return null
  if (body.length < 32 || body.length > 4096 || body.length % 4 !== 0) return null
  if (!BASE64_BODY.test(body) || !body.startsWith(prefix)) return null
  const comment = rest.join(' ')
  if (comment.length > 200) return null
  return `${type} ${body}`
}

/** Whether `raw` is a valid OpenSSH public key line accepted by the relay. */
export const isRelayPublicKey = (raw: string): boolean => relayKeyBody(raw) !== null

const NOTE = 'Added by "Relay on the server"; its Undo removes it.'

/**
 * sshd settings for the node user (agent-board-relay-n): keys via AuthorizedKeysCommand run as
 * agent-board-relay-m, remote unix socket forwards only, no TCP forwarding (PermitListen none
 * with AllowTcpForwarding remote), no shell, no TTY.
 */
export function relayNodeFenceSettings(
  keysCmd = RELAY_KEYS_CMD,
  masterUser = RELAY_MASTER_USER,
): (readonly [string, string])[] {
  return [
    ['AuthorizedKeysFile', 'none'],
    ['AuthorizedKeysCommand', `${keysCmd} %u`],
    ['AuthorizedKeysCommandUser', masterUser],
    ['AuthenticationMethods', 'publickey'],
    ['PasswordAuthentication', 'no'],
    ['KbdInteractiveAuthentication', 'no'],
    ['AllowTcpForwarding', 'remote'],
    ['PermitListen', 'none'],
    ['AllowStreamLocalForwarding', 'remote'],
    ['StreamLocalBindUnlink', 'yes'],
    ['StreamLocalBindMask', '0117'],
    ['X11Forwarding', 'no'],
    ['AllowAgentForwarding', 'no'],
    ['PermitTunnel', 'no'],
    ['PermitTTY', 'no'],
    ['PermitUserRC', 'no'],
    ['ForceCommand', '/bin/false'],
    ['ClientAliveInterval', '15'],
    ['ClientAliveCountMax', '2'],
  ]
}

/**
 * sshd settings for the master user (agent-board-relay-m): root-owned AuthorizedKeysFile where
 * each key carries its own `restrict` and `command=` (master forward key uses `/bin/false`, enrol
 * key uses `/etc/agent-board-relay/enrol`), local unix socket forwards only, no TCP forwarding, no
 * shell, no TTY.
 */
export function relayMasterFenceSettings(masterKeys = RELAY_MASTER_KEYS): (readonly [string, string])[] {
  return [
    ['AuthorizedKeysFile', masterKeys],
    ['AuthenticationMethods', 'publickey'],
    ['PasswordAuthentication', 'no'],
    ['KbdInteractiveAuthentication', 'no'],
    ['AllowTcpForwarding', 'no'],
    ['AllowStreamLocalForwarding', 'local'],
    ['X11Forwarding', 'no'],
    ['AllowAgentForwarding', 'no'],
    ['PermitTunnel', 'no'],
    ['PermitTTY', 'no'],
    ['PermitUserRC', 'no'],
    ['ClientAliveInterval', '15'],
    ['ClientAliveCountMax', '2'],
  ]
}

/** Both Match blocks in one text, each ended by `Match all`. */
export function relayFenceBlock(): string {
  const node = [
    `Match User ${RELAY_NODE_USER}`,
    ...relayNodeFenceSettings().map(([k, v]) => `    ${k} ${v}`),
    'Match all',
  ]
  const master = [
    `Match User ${RELAY_MASTER_USER}`,
    ...relayMasterFenceSettings().map(([k, v]) => `    ${k} ${v}`),
    'Match all',
  ]
  return [...node, '', ...master].join('\n')
}

/** The fence in its own sshd_config.d drop-in file. */
export const relayFenceFile = (): string =>
  `# agent-board: sshd's fence for the relay users. ${NOTE}\n${relayFenceBlock()}\n`

/** The fence between relay markers, for sshd_config without Include. */
export const relayFenceMarked = (): string =>
  `${RELAY_BLOCK_BEGIN}: ${NOTE}\n${relayFenceBlock()}\n${RELAY_BLOCK_END}\n`

/** The master key line: local streamlocal forwarding only (plus restrict and command="/bin/false"). */
export function relayMasterKeyLine(publicKey: string): string {
  const body = relayKeyBody(publicKey)
  if (!body) throw new Error('invalid relay master public key')
  return `restrict,port-forwarding,command="/bin/false" ${body}`
}

/** The enrol key line: forced-command enrol script only, no forwarding, no shell. */
export function relayEnrolKeyLine(publicKey: string, enrolScript = RELAY_ENROL_SCRIPT): string {
  const body = relayKeyBody(publicKey)
  if (!body) throw new Error('invalid relay enrol public key')
  return `restrict,command="${enrolScript}" ${body}`
}

/** The master user's authorized_keys file holding both the forward key and the enrol key. */
export const relayMasterKeysFile = (masterKey: string, enrolKey: string): string =>
  `${relayMasterKeyLine(masterKey)}\n${relayEnrolKeyLine(enrolKey)}\n`

/** Shared POSIX key-validation helper used by both `keys` and `enrol` scripts. */
const KEY_CHECK_SH = [
  'validKey() {',
  '  _t=$1; _b=$2',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
  '  [ "${#_b}" -ge 32 ] && [ "${#_b}" -le 4096 ] && [ "$((${#_b} % 4))" -eq 0 ] || return 1',
  '  case "$_t:$_b" in',
  '    ssh-ed25519:AAAAC3NzaC1lZDI1NTE5*) ;;',
  '    ssh-rsa:AAAAB3NzaC1yc2E*) ;;',
  '    ecdsa-sha2-nistp256:AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY*) ;;',
  '    ecdsa-sha2-nistp384:AAAAE2VjZHNhLXNoYTItbmlzdHAzODQ*) ;;',
  '    ecdsa-sha2-nistp521:AAAAE2VjZHNhLXNoYTItbmlzdHA1MjE*) ;;',
  '    *) return 1 ;;',
  '  esac',
  "  printf '%s\\n' \"$_b\" | awk '/^[A-Za-z0-9+\\/]+(=|==)?$/ { ok = 1 } END { exit !ok }'",
  '}',
]

/**
 * AuthorizedKeysCommand script (`/etc/agent-board-relay/keys %u`), run by sshd as
 * `agent-board-relay-m`. Prints `restrict,port-forwarding <type> <base64>` for every valid
 * enrolled `.pub` file when `%u` is `agent-board-relay-n`, and nothing otherwise.
 */
export function relayKeysCommand(keysDir = RELAY_KEYS_DIR, nodeUser = RELAY_NODE_USER): string {
  return [
    '#!/bin/sh',
    `# agent-board: AuthorizedKeysCommand for ${nodeUser}. ${NOTE}`,
    'set -u',
    'set -f',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    'LC_ALL=C; export LC_ALL',
    `[ "\${1:-}" = ${shQuote(nodeUser)} ] || exit 0`,
    `DIR=${shQuote(keysDir)}`,
    '[ -d "$DIR" ] || exit 0',
    ...KEY_CHECK_SH,
    'set +f',
    'for f in "$DIR"/*.pub; do',
    '  set -f',
    '  [ -f "$f" ] && [ ! -L "$f" ] || continue',
    '  IFS= read -r line < "$f" || continue',
    '  case "$line" in *"$(printf \'\\r\')"*) continue ;; esac',
    '  IFS=" "',
    '  set -- $line',
    '  [ $# -ge 2 ] || continue',
    '  validKey "$1" "$2" || continue',
    '  printf \'restrict,port-forwarding %s %s\\n\' "$1" "$2"',
    'done',
    '',
  ].join('\n')
}

export interface EnrolScriptOptions {
  keysDir?: string
  maxKeys?: number
}

/**
 * Forced-command script (`/etc/agent-board-relay/enrol`) for the master's enrol key.
 * Accepts only one-line commands in `SSH_ORIGINAL_COMMAND`:
 * - `check`: prints `@@ok 1`
 * - `list`: prints enrolled key names (sorted, one per line)
 * - `add <name> <type> <base64> [comment]`: validates name and key strictly, writes `<name>.pub` atomically
 * - `remove <name>`: removes `<name>.pub` if present (`@@removed <name>` or `@@missing <name>`)
 * Anything else fails with `@@error ...` and exit 1.
 */
export function relayEnrolScript(opts: EnrolScriptOptions = {}): string {
  const keysDir = opts.keysDir ?? RELAY_KEYS_DIR
  const maxKeys = opts.maxKeys ?? RELAY_MAX_KEYS
  return [
    '#!/bin/sh',
    `# agent-board: forced-command enrolment script for the relay. ${NOTE}`,
    'set -u',
    'set -f',
    'umask 077',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    'LC_ALL=C; export LC_ALL',
    `DIR=${shQuote(keysDir)}`,
    `MAX_KEYS=${maxKeys}`,
    'fail() { echo "@@error $*" >&2; exit 1; }',
    'validName() {',
    '  _n=$1',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    '  [ -n "$_n" ] && [ "${#_n}" -le 64 ] || return 1',
    '  case "$_n" in -*|*[!a-z0-9-]*) return 1 ;; esac',
    '  return 0',
    '}',
    ...KEY_CHECK_SH,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    'cmd=${SSH_ORIGINAL_COMMAND:-}',
    '[ -n "$cmd" ] || fail "missing command"',
    "bad=$(printf '%s' \"$cmd\" | tr -dc '\\000-\\037\\177')",
    '[ -z "$bad" ] || fail "command must be one printable line"',
    'IFS=" "',
    'set -- $cmd',
    '[ $# -ge 1 ] || fail "missing command"',
    'sub=$1; shift',
    'case "$sub" in',
    '  check)',
    '    [ $# -eq 0 ] || fail "check takes no arguments"',
    `    echo "@@ok ${ENROL_VERSION}"`,
    '    ;;',
    '  list)',
    '    [ $# -eq 0 ] || fail "list takes no arguments"',
    '    [ -d "$DIR" ] || exit 0',
    '    set +f',
    '    for f in "$DIR"/*.pub; do',
    '      set -f',
    '      [ -f "$f" ] && [ ! -L "$f" ] || continue',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    '      stem=${f##*/}',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    '      stem=${stem%.pub}',
    '      validName "$stem" && printf \'%s\\n\' "$stem"',
    '    done | sort',
    '    ;;',
    '  add)',
    '    [ $# -ge 3 ] || fail "usage: add <name> <key-type> <base64> [comment]"',
    '    name=$1; ktype=$2; kbody=$3; shift 3',
    '    validName "$name" || fail "invalid key name"',
    '    validKey "$ktype" "$kbody" || fail "invalid public key"',
    '    if [ $# -gt 0 ]; then',
    '      comment="$*"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    '      [ "${#comment}" -le 200 ] || fail "key comment too long"',
    '    fi',
    '    [ -d "$DIR" ] || fail "keys directory missing"',
    '    if [ -L "$DIR/$name.pub" ]; then fail "refusing symlink"; fi',
    '    if command -v flock >/dev/null 2>&1; then',
    '      exec 9>"$DIR/.lock" || fail "could not lock keys directory"',
    '      flock 9 || fail "could not lock keys directory"',
    '    fi',
    '    if [ ! -e "$DIR/$name.pub" ]; then',
    '      count=0',
    '      set +f',
    '      for f in "$DIR"/*.pub; do',
    '        set -f',
    '        [ -f "$f" ] && [ ! -L "$f" ] && count=$((count + 1))',
    '      done',
    '      set -f',
    '      [ "$count" -lt "$MAX_KEYS" ] || fail "too many relay keys (limit $MAX_KEYS)"',
    '    fi',
    '    tmp="$DIR/.part.$$"',
    '    trap \'rm -f "$tmp"\' EXIT',
    '    printf \'%s %s %s\\n\' "$ktype" "$kbody" "$name" > "$tmp" || fail "could not write key"',
    '    chmod 600 "$tmp" || fail "could not set permissions"',
    '    mv -f "$tmp" "$DIR/$name.pub" || fail "could not save key"',
    '    trap - EXIT',
    '    echo "@@added $name"',
    '    ;;',
    '  remove)',
    '    [ $# -eq 1 ] || fail "usage: remove <name>"',
    '    name=$1',
    '    validName "$name" || fail "invalid key name"',
    '    if [ -L "$DIR/$name.pub" ]; then fail "refusing symlink"; fi',
    '    if [ -f "$DIR/$name.pub" ]; then',
    '      rm -f "$DIR/$name.pub" || fail "could not remove key"',
    '      echo "@@removed $name"',
    '    else',
    '      echo "@@missing $name"',
    '    fi',
    '    ;;',
    '  *)',
    '    fail "unknown relay enrol command"',
    '    ;;',
    'esac',
    '',
  ].join('\n')
}

export { keysFile }
