// The owner's server as a backup target (#233): what the board puts there, as the scripts that do
// it, and how it reads what they print. Its own user and key, apart from the tunnel's: the user
// can run one program, the drop script, which puts, lists and fetches snapshots and removes none
// but by the rotation; sshd's fence for it in a file of its own (or between markers at the end of
// sshd_config where sshd has no Include); its own folder, /etc/agent-board-backup, apart from the
// tunnel's /etc/agent-board (whose runner removes that folder when a run of its leaves nothing
// there); a record of what Apply made, written as each step is done, which Undo follows and
// nothing else. Undo never removes the snapshots, and no rollback removes a folder that holds one.
//
// The backup goes over plain ssh to sshd, not through the web server, so it is the same whichever
// proxy the tunnel uses, or none. The scripts run as root through the owner's admin connection
// (core/server-admin.ts remoteCommand); "Do it myself" is the Apply script to paste as root. They
// ignore a hangup and a broken pipe: an admin connection that drops mid-run leaves a run that ends
// or rolls back on its own, never half of one. sshd is changed as the tunnel's setup changes it
// (core/server-plan.ts): the config checked with the fence before it is in place and again after,
// the fence in force for the backup user, root's and the admin's own settings as they were, the
// file replaced whole (a copy beside it moved over it), then a reload; any failure puts back what
// the run changed. A block of the board's in sshd_config that is not whole is never touched. Pure,
// with no node: import.
import { FUTURE_MS, GAP_MS, KEEP_ALL_MS, KEEP_DAILY_MS, KEEP_MONTHLY_MS, KEEP_NEWEST } from './backup.ts'
import { shQuote } from './server-shell.ts'

export const BACKUP_USER = 'agent-board-backup'
/** The user's comment: Undo removes only a user that has it, and Apply uses only such a one. */
export const BACKUP_COMMENT = 'agent-board backup'
export const BACKUP_HOME = '/var/lib/agent-board-backup'
export const SNAPSHOTS_DIR = `${BACKUP_HOME}/snapshots`
/** The backup's own folder on the server: the drop script and Apply's record. */
export const BACKUP_ETC = '/etc/agent-board-backup'
export const DROP_FILE = `${BACKUP_ETC}/drop`
export const BACKUP_RECORD = `${BACKUP_ETC}/record`
export const BACKUP_KEYS_DIR = '/etc/ssh/authorized_keys'
export const BACKUP_KEYS = `${BACKUP_KEYS_DIR}/${BACKUP_USER}`
const SSHD_CONFIG = '/etc/ssh/sshd_config'
const SSHD_DIR = '/etc/ssh/sshd_config.d'
export const BACKUP_FENCE = `${SSHD_DIR}/00-agent-board-backup.conf`
/** The markers of the block at the end of sshd_config; not starting as the tunnel's `# >>> agent-board`, which its own Undo looks for. */
export const BACKUP_BLOCK_BEGIN = '# >>> backup-drop of agent-board'
export const BACKUP_BLOCK_END = '# <<< backup-drop of agent-board'
/** The drop script's version: `check` says it, so the board knows an older script is there (2: `put` takes the size). */
export const DROP_VERSION = 2
/** The largest snapshot the drop takes (bytes), how full its folder may get, and the free disk it always leaves (KB). */
export const DROP_MAX_FILE = 64 * 1024 * 1024
export const DROP_MAX_KB = 512 * 1024
export const DROP_RESERVE_KB = 512 * 1024

const FENCE_NOTE = `sshd's fence for the board's backup user. Added by "Back up to the server"; its Undo removes it.`

/** sshd's settings for the backup user: its key only, the drop script and nothing else, no forward of any kind. OpenSSH 7.4 or newer. */
export const FENCE_SETTINGS: readonly (readonly [string, string])[] = [
  ['AuthorizedKeysFile', BACKUP_KEYS],
  ['AuthenticationMethods', 'publickey'],
  ['ForceCommand', DROP_FILE],
  ['DisableForwarding', 'yes'],
  ['AllowTcpForwarding', 'no'],
  ['AllowStreamLocalForwarding', 'no'],
  ['X11Forwarding', 'no'],
  ['AllowAgentForwarding', 'no'],
  ['PermitTunnel', 'no'],
  ['PermitTTY', 'no'],
  ['PermitUserRC', 'no'],
]

export function fenceBlock(): string {
  return [`Match User ${BACKUP_USER}`, ...FENCE_SETTINGS.map(([k, v]) => `    ${k} ${v}`), 'Match all'].join('\n')
}

/** The fence in its own file: a comment line, then the block. */
export const fenceFileText = (): string => `# agent-board: ${FENCE_NOTE}\n${fenceBlock()}\n`

/** The fence between the board's markers, for the end of sshd_config. */
export const fenceMarked = (): string => `${BACKUP_BLOCK_BEGIN}: ${FENCE_NOTE}\n${fenceBlock()}\n${BACKUP_BLOCK_END}\n`

/** The backup key's line in its keys file: nothing but the drop script, even were sshd's fence gone. */
export const backupKeysLine = (publicKey: string): string => `restrict,command="${DROP_FILE}" ${publicKey.trim()}`

// awk regexes without {n} intervals: mawk, Debian's and Ubuntu's awk, does not take them everywhere
const D = '[0-9]'
const H = '[0-9a-f]'
const NAME_AWK = `^${D.repeat(8)}T${D.repeat(6)}Z-${H.repeat(8)}\\.abk$`
/** A snapshot's name as a shell pattern (`case`): one line, nothing else. */
const NAME_GLOB = `${D.repeat(8)}T${D.repeat(6)}Z-${H.repeat(8)}.abk`

/**
 * The rotation in awk, over the folder's names in order (`ls` with LC_ALL=C sorts them by time):
 * the names it removes, one per line. The same rule as core/backup.ts rotationKeeps: the newest
 * KEEP_NEWEST always stay, and nothing goes while the newest is a day past this server's clock or a
 * month past the one before it (a clock set wrong would take everything else). Days count from 1970 by the civil calendar (no
 * mktime: mawk has none).
 */
export function pruneAwk(): string {
  // one line: a shell word carries no newline (server-shell.ts shQuote)
  const s = (ms: number) => Math.floor(ms / 1000)
  return [
    'function days(y, m, d) { if (m <= 2) { y--; m += 12 }; return 365 * y + int(y / 4) - int(y / 100) + int(y / 400) + int((153 * (m - 3) + 2) / 5) + d - 719469 }',
    'function stamp(x) { return days(substr(x, 1, 4) + 0, substr(x, 5, 2) + 0, substr(x, 7, 2) + 0) * 86400 + substr(x, 10, 2) * 3600 + substr(x, 12, 2) * 60 + substr(x, 14, 2) }',
    `$0 ~ /${NAME_AWK}/ { n++; name[n] = $0 }`,
    'END {',
    `if (n == 0 || stamp(name[n]) > now + ${s(FUTURE_MS)} || (n > 1 && stamp(name[n]) - stamp(name[n - 1]) > ${s(GAP_MS)})) exit;`,
    'for (i = 1; i <= n; i++) {',
    'x = name[i]; age = now - stamp(x); day = substr(x, 1, 8); month = substr(x, 1, 6);',
    'fd = !(day in seen_d); fm = !(month in seen_m); seen_d[day] = 1; seen_m[month] = 1;',
    `if (i > n - ${KEEP_NEWEST} || age < ${s(KEEP_ALL_MS)} || (fd && age < ${s(KEEP_DAILY_MS)}) || (fm && age < ${s(KEEP_MONTHLY_MS)})) continue;`,
    'print x',
    '}',
    '}',
  ].join(' ')
}

export interface DropLimits {
  dir: string
  maxFile: number
  maxKb: number
  reserveKb: number
}

const DROP_LIMITS: DropLimits = {
  dir: SNAPSHOTS_DIR,
  maxFile: DROP_MAX_FILE,
  maxKb: DROP_MAX_KB,
  reserveKb: DROP_RESERVE_KB,
}

/**
 * The drop script: all the backup key may run (sshd's ForceCommand, and the key's own `command=`).
 * SSH_ORIGINAL_COMMAND says what, on one line: `put <bytes>` (a snapshot of that size on stdin;
 * one cut short is refused and nothing is kept; named by this server's clock and its hash, never
 * over another; the rotation runs before, so a full folder makes room, and after), `list` (name and
 * size, one a line), `get <name>`, `df` (free and total KB of the folder's disk, and what the folder
 * holds), `check` (its version). The limits are for the tests; the server's are the defaults.
 */
export function dropScript(limits: Partial<DropLimits> = {}): string {
  const l = { ...DROP_LIMITS, ...limits }
  return [
    '#!/bin/sh',
    `# agent-board: what the board's backup key may run, and nothing else. Added by "Back up to the server"; its Undo removes it.`,
    "# put <bytes>: a snapshot from stdin, named by this server's clock and its hash, never over another one;",
    '# list; get <name>; df; check. Nothing removes a snapshot but the rotation around each put: the newest ten,',
    '# every one of the last 48 hours, the first of each day for 60 days, the first of each month for two years.',
    'set -u',
    'umask 077',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    'LC_ALL=C; export LC_ALL',
    `DIR=${shQuote(l.dir)}`,
    `MAX_FILE=${l.maxFile}`,
    `MAX_KB=${l.maxKb}`,
    `RESERVE_KB=${l.reserveKb}`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    'NL=$(printf "\\nx"); NL=${NL%x}',
    'fail() { echo "@@error $*" >&2; exit 1; }',
    // what a put cut off by a kill left behind, an hour old
    'sweep() { find "$DIR" -maxdepth 1 -name ".incoming.*" -mmin +60 -exec rm -f {} + 2>/dev/null; }',
    'prune() {',
    `  ls "$DIR" | awk -v now="$(date -u +%s)" ${shQuote(pruneAwk())} | while read -r old; do rm -f "$DIR/$old"; done`,
    '}',
    'put() {',
    '  case $1 in "" | *[!0-9]*) fail "put needs the snapshot\'s size in bytes" ;; esac',
    '  [ "$1" -gt 0 ] && [ "$1" -le "$MAX_FILE" ] || fail "a snapshot is 1 to $MAX_FILE bytes"',
    '  mkdir -p "$DIR" || fail "cannot make the snapshots folder"',
    '  sweep',
    '  prune',
    '  used=$(du -sk "$DIR" | awk \'{ print $1 }\')',
    '  [ "$used" -lt "$MAX_KB" ] || fail "the snapshots folder is full: $used KB"',
    '  free=$(df -Pk "$DIR" | awk \'NR == 2 { print $4 }\')',
    '  [ "$((free - $1 / 1024))" -gt "$RESERVE_KB" ] || fail "the server\'s disk is nearly full: $free KB free"',
    '  tmp="$DIR/.incoming.$$"',
    '  trap \'rm -f "$tmp"\' EXIT',
    '  head -c $(($1 + 1)) > "$tmp" || fail "could not write the snapshot"',
    '  size=$(wc -c < "$tmp" | tr -d \' \')',
    '  [ "$size" = "$1" ] || fail "the snapshot came cut short or long: $size of $1 bytes"',
    '  [ "$(head -c 4 "$tmp")" = ABK1 ] || fail "not a snapshot of the board"',
    // from stdin: GNU sha256sum starts its line with a backslash for a name that holds one
    '  hash=$( (sha256sum < "$tmp" 2>/dev/null || shasum -a 256 < "$tmp") | cut -c1-8)',
    '  name="$(date -u +%Y%m%dT%H%M%SZ)-$hash.abk"',
    '  if [ ! -e "$DIR/$name" ]; then ln "$tmp" "$DIR/$name" || fail "could not keep the snapshot"; fi',
    '  rm -f "$tmp"',
    '  trap - EXIT',
    '  sync',
    '  echo "@@put $name $size"',
    '  prune',
    '}',
    'list() {',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    '  for f in "$DIR"/*.abk; do [ -f "$f" ] || continue; echo "${f##*/} $(wc -c < "$f" | tr -d \' \')"; done',
    '}',
    'get() {',
    `  case $1 in ${NAME_GLOB}) ;; *) fail "no such snapshot" ;; esac`,
    '  [ -f "$DIR/$1" ] || fail "no such snapshot"',
    '  cat "$DIR/$1"',
    '}',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    'cmd=${SSH_ORIGINAL_COMMAND:-}',
    'case $cmd in',
    '  *"$NL"*) fail "one command, on one line" ;;',
    '  put) fail "put needs the snapshot\'s size in bytes (a board older than this drop script?)" ;;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    '  "put "*) put "${cmd#put }" ;;',
    '  list) list ;;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    '  "get "*) get "${cmd#get }" ;;',
    '  df) mkdir -p "$DIR"; df -Pk "$DIR" | awk \'NR == 2 { printf "@@df %s %s", $4, $2 }\'; echo " $(du -sk "$DIR" | awk \'{ print $1 }\')" ;;',
    `  check) echo "@@ok ${DROP_VERSION}" ;;`,
    '  *) fail "this key only puts, lists and gets the board\'s snapshots" ;;',
    'esac',
    '',
  ].join('\n')
}

// ------------------------------------------------------------------ the root scripts

/** sh that runs as root: no stdin (sudo read its password already), a known PATH and locale, the paths and helpers. */
const PREAMBLE = [
  'exec </dev/null',
  'set -u',
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
  'LC_ALL=C; export LC_ALL',
  `U=${shQuote(BACKUP_USER)}`,
  `HOMEDIR=${shQuote(BACKUP_HOME)}`,
  `SNAP=${shQuote(SNAPSHOTS_DIR)}`,
  `ETCDIR=${shQuote(BACKUP_ETC)}`,
  `DROP=${shQuote(DROP_FILE)}`,
  `REC=${shQuote(BACKUP_RECORD)}`,
  `KEYS=${shQuote(BACKUP_KEYS)}`,
  `KEYSDIR=${shQuote(BACKUP_KEYS_DIR)}`,
  `FENCE=${shQuote(BACKUP_FENCE)}`,
  `CONF=${shQuote(SSHD_CONFIG)}`,
  `CONFD=${shQuote(SSHD_DIR)}`,
  `B0=${shQuote(BACKUP_BLOCK_BEGIN)}`,
  `E0=${shQuote(BACKUP_BLOCK_END)}`,
  `COMMENT=${shQuote(BACKUP_COMMENT)}`,
  'W=$(mktemp -d) || { echo "@@fail could not make a temp folder"; exit 1; }',
  // sshd's settings for root and the admin sudo runs for: kept before, compared after
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
  'admins() { for u in root ${SUDO_USER:-}; do echo "@@ $u"; sshd -T -C "user=$u,host=localhost,addr=127.0.0.1" || return 1; done; }',
  'reload() { if command -v systemctl >/dev/null 2>&1; then systemctl try-reload-or-restart ssh 2>/dev/null || systemctl try-reload-or-restart sshd; elif [ -f /run/sshd.pid ]; then kill -HUP "$(cat /run/sshd.pid)"; else return 1; fi; }',
  // sshd_config includes sshd_config.d/*.conf before any Match: the fence goes in a file of its own
  `includes() { [ -d "$CONFD" ] && awk ${shQuote(`tolower($1) == "match" { exit } tolower($1) == "include" { for (i = 2; i <= NF; i++) if ($i == "${SSHD_DIR}/*.conf" || $i == "sshd_config.d/*.conf") f = 1 } END { exit !f }`)} "$CONF" 2>/dev/null; }`,
  // the board's block in sshd_config: whole (as many ends as beginnings, at most one) or not there
  `whole() { B0="$B0" E0="$E0" awk 'index($0, ENVIRON["B0"]) == 1 { n++ } $0 == ENVIRON["E0"] { m++ } END { exit !(n == m && n <= 1) }' "$CONF"; }`,
  // sshd_config without the board's backup block
  `strip() { B0="$B0" E0="$E0" awk 'index($0, ENVIRON["B0"]) == 1 { s = 1 } !s { print } s && $0 == ENVIRON["E0"] { s = 0 }' "$1"; }`,
  // $1 with the block at its end: no blank line added, a line break only where the file lacks its last one
  'withBlock() { cat "$1"; if [ -s "$1" ] && [ -n "$(tail -c 1 "$1")" ]; then echo; fi; cat "$W/fence.block"; }',
  // sshd_config replaced whole by $1: a copy beside it with its rights, then moved over it (its link followed)
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
  'putConf() { t=$(readlink -f "$CONF") && p="${t%/*}/.${t##*/}.agent-board-backup" && cp -p "$t" "$p" && cat "$1" > "$p" && mv -f "$p" "$t"; }',
  // sshd_config.d copied into $W with the fence file as $1 has it (empty: none), sshd_config's Include pointed at the copy: $W/main
  `candidate() { rm -rf "$W/d"; cp -a "$CONFD" "$W/d" && rm -f "$W/d/\${FENCE##*/}" && { [ -z "$1" ] || cp "$1" "$W/d/\${FENCE##*/}"; } && D="$W/d" awk ${shQuote(`tolower($1) == "include" { for (i = 2; i <= NF; i++) if ($i == "${SSHD_DIR}/*.conf" || $i == "sshd_config.d/*.conf") $i = ENVIRON["D"] "/*.conf" } { print }`)} "$CONF" > "$W/main"; }`,
  // what keeps the fence from being in force for the user (the arguments: -f <file> or nothing):
  // a setting sshd -T does not give, or AllowUsers, AllowGroups, DenyUsers or DenyGroups keeping it out
  `notInForce() { t=$(sshd -T "$@" -C "user=$U,host=localhost,addr=127.0.0.1" 2>&1) || { echo "$t" | head -n 3; return; }; for kv in ${FENCE_SETTINGS.map(([k, v]) => shQuote(`${k.toLowerCase()} ${v}`)).join(' ')}; do printf '%s\\n' "$t" | grep -qxF "$kv" || echo "$kv"; done; printf '%s\\n' "$t" | U="$U" awk ${shQuote('function ok(p) { return p == ENVIRON["U"] || p ~ /[*?]/ } $1 == "allowusers" { a = 1; for (i = 2; i <= NF; i++) if (ok($i)) au = 1 } $1 == "allowgroups" { g = 1; for (i = 2; i <= NF; i++) if (ok($i)) ag = 1 } ($1 == "denyusers" || $1 == "denygroups") { for (i = 2; i <= NF; i++) if ($i == ENVIRON["U"]) print $1 " " $i } END { if (a && !au) print "allowusers leaves " ENVIRON["U"] " out"; if (g && !ag) print "allowgroups leaves " ENVIRON["U"] " out" }')}; }`,
  'firstLines() { head -n 5 "$1" | tr "\\n" " "; }',
]

const heredoc = (marker: string, text: string, to: string): string[] => [
  `cat > ${to} <<'${marker}'`,
  ...text.replace(/\n$/, '').split('\n'),
  marker,
]

/**
 * Look, as root, changing nothing: OpenSSH's version, whether sshd_config includes sshd_config.d,
 * useradd, the backup user, the drop script, the keys file and the fence as the server has them
 * (and a block of the board's that is not whole), Apply's record, the snapshots and the disk,
 * whether sshd's config passes `sshd -t` now, and whether it would with the fence in place and the
 * fence would be in force for the user, checked on copies in a temp folder (`@@candidate`). One
 * `@@` line each.
 */
export function lookScript(publicKey: string | null): string {
  return [
    ...PREAMBLE,
    'trap \'rm -rf "$W"\' EXIT',
    'echo "@@ssh $(ssh -V 2>&1 | head -n 1)"',
    'if includes; then echo "@@include yes"; else echo "@@include no"; fi',
    'if command -v useradd >/dev/null 2>&1; then echo "@@useradd yes"; else echo "@@useradd no"; fi',
    'if p=$(getent passwd "$U"); then',
    '  case $(printf "%s\\n" "$p" | cut -d: -f5) in "$COMMENT"*) echo "@@user ours" ;; *) echo "@@user other" ;; esac',
    'elif getent group "$U" >/dev/null; then echo "@@user group"',
    'else echo "@@user none"; fi',
    ...heredoc('AGENT_BOARD_DROP', dropScript(), '"$W/drop"'),
    'if [ ! -f "$DROP" ]; then echo "@@drop none"; elif cmp -s "$DROP" "$W/drop"; then echo "@@drop same"; else echo "@@drop other"; fi',
    publicKey === null
      ? 'if [ -f "$KEYS" ]; then echo "@@keys other"; else echo "@@keys none"; fi'
      : `if [ ! -f "$KEYS" ]; then echo "@@keys none"; elif [ "$(cat "$KEYS")" = ${shQuote(backupKeysLine(publicKey))} ]; then echo "@@keys same"; else echo "@@keys other"; fi`,
    'if [ -f "$FENCE" ]; then echo "@@fence file"; elif grep -qxF "$E0" "$CONF" 2>/dev/null; then echo "@@fence block"; else echo "@@fence none"; fi',
    'if whole; then echo "@@block whole"; else echo "@@block torn"; fi',
    'if [ -f "$REC" ]; then echo "@@record yes"; else echo "@@record no"; fi',
    'n=0; kb=0; if [ -d "$SNAP" ]; then n=$(ls "$SNAP" | grep -c "\\.abk$"); kb=$(du -sk "$SNAP" | awk \'{ print $1 }\'); fi; echo "@@snapshots $n $kb"',
    'echo "@@df $(df -Pk "$(dirname "$HOMEDIR")" | awk \'NR == 2 { print $4 }\')"',
    'if sshd -t 2>"$W/t"; then echo "@@sshd-t ok"; else echo "@@sshd-t $(firstLines "$W/t")"; fi',
    ...heredoc('AGENT_BOARD_FENCE', fenceFileText(), '"$W/fence"'),
    ...heredoc('AGENT_BOARD_BLOCK', fenceMarked(), '"$W/fence.block"'),
    'if includes; then candidate "$W/fence"; else strip "$CONF" > "$W/stripped"; withBlock "$W/stripped" > "$W/main"; fi',
    'if ! sshd -t -f "$W/main" 2>"$W/t"; then echo "@@candidate $(firstLines "$W/t")"',
    'else bad=$(notInForce -f "$W/main"); if [ -n "$bad" ]; then echo "@@candidate not in force: $(printf "%s" "$bad" | tr "\\n" ",")"; else echo "@@candidate ok"; fi; fi',
    'echo "@@end"',
    '',
  ].join('\n')
}

/**
 * Apply, as root: the backup's own folder and its record (written at once, and again as each step
 * is done, so an Undo after anything finds what was made), the user (made, or the board's own
 * used), its folders, the drop script, the key's line, sshd's fence checked on a copy before it is
 * in place, in force for the user, root's and the admin's settings unchanged, sshd_config replaced
 * whole, a reload. Each step prints `@@step <name>`; a failure prints `@@fail <why>`, puts back
 * everything this run changed (the record as it was; a home it made only while no snapshot is in
 * it) and exits 1. A hangup or a broken pipe does not stop it. Safe to run again: what is there is
 * used, the files written anew, the record keeps what an earlier run made.
 */
export function applyScript(publicKey: string): string {
  return [
    ...PREAMBLE,
    "trap '' HUP PIPE",
    '[ -d /run/sshd ] || install -d -m 755 /run/sshd',
    // what this run made (rolled back on a failure) …
    'made_user=0; had_home=0; made_keysdir=0; made_etc=0; put_drop=0; put_keys=0; fence=; reloaded=0; had_rec=0',
    // … and what the record says was made, by this run or an earlier one (Undo's to remove)
    'rec_user=0; rec_keysdir=0; rec_fence=',
    'if [ -f "$REC" ]; then had_rec=1; cp -p "$REC" "$W/rec.old"; rec_user=$(sed -n "s/^user=//p" "$REC"); rec_keysdir=$(sed -n "s/^keysdir=//p" "$REC"); rec_fence=$(sed -n "s/^fence=//p" "$REC"); fi',
    '[ "$rec_user" = 1 ] || rec_user=0; [ "$rec_keysdir" = 1 ] || rec_keysdir=0',
    'rec() { { echo "user=$rec_user"; echo "keysdir=$rec_keysdir"; echo "fence=$rec_fence"; echo "at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; } > "$REC.part" && mv -f "$REC.part" "$REC"; }',
    'rollback() {',
    '  case $fence in',
    '    file) if [ -f "$W/fence.old" ]; then cp -p "$W/fence.old" "$FENCE"; else rm -f "$FENCE"; fi ;;',
    '    block) [ -f "$W/sshd_config" ] && putConf "$W/sshd_config" ;;',
    '  esac',
    '  if [ "$put_keys" = 1 ]; then if [ -f "$W/keys.old" ]; then cp -p "$W/keys.old" "$KEYS"; else rm -f "$KEYS"; fi; fi',
    '  [ "$made_keysdir" = 1 ] && rmdir "$KEYSDIR" 2>/dev/null',
    '  if [ "$put_drop" = 1 ]; then if [ -f "$W/drop.old" ]; then cp -p "$W/drop.old" "$DROP"; else rm -f "$DROP"; fi; fi',
    // the user this run made goes; its home only when the run made it too and no snapshot is in it
    '  if [ "$made_user" = 1 ]; then',
    '    userdel "$U" 2>/dev/null',
    '    if [ "$had_home" = 0 ] && [ -z "$(ls -A "$SNAP" 2>/dev/null)" ]; then rm -rf "$HOMEDIR"; fi',
    '  fi',
    '  if [ "$had_rec" = 1 ]; then cp -p "$W/rec.old" "$REC"; else rm -f "$REC" "$REC.part"; fi',
    '  [ "$made_etc" = 1 ] && rmdir "$ETCDIR" 2>/dev/null',
    '  [ "$reloaded" = 1 ] && sshd -t && reload',
    '  rm -rf "$W"',
    '}',
    'fail() { echo "@@fail $*"; rollback; exit 1; }',
    '[ "$(id -u)" = 0 ] || fail "this runs as root"',
    'command -v sshd >/dev/null 2>&1 || fail "sshd is not installed here"',
    'command -v useradd >/dev/null 2>&1 || fail "useradd is not there"',
    'echo "@@step check"',
    'sshd -t 2>"$W/t" || fail "sshd\'s config does not pass sshd -t as it is, before any change: $(firstLines "$W/t")"',
    'whole || fail "the board\'s block in $CONF is not whole: put it right by hand first"',
    'admins > "$W/admins.before" || fail "sshd -T does not answer for root or the admin"',
    'echo "@@step record"',
    'if [ ! -d "$ETCDIR" ]; then install -d -m 755 "$ETCDIR" || fail "could not make $ETCDIR"; made_etc=1; fi',
    'rec || fail "could not write $REC"',
    'echo "@@step user"',
    'if p=$(getent passwd "$U"); then',
    '  case $(printf "%s\\n" "$p" | cut -d: -f5) in "$COMMENT"*) ;; *) fail "a user $U is there that the board did not make: remove it or rename it first" ;; esac',
    'else',
    '  [ -d "$HOMEDIR" ] && had_home=1',
    '  useradd --system --user-group --home-dir "$HOMEDIR" --create-home --shell /bin/sh --comment "$COMMENT" "$U" 2>"$W/t" || fail "useradd: $(firstLines "$W/t")"',
    '  made_user=1; rec_user=1',
    '  rec || fail "could not write $REC"',
    // the snapshots an earlier Undo kept belong to the user made now (its uid may differ)
    '  [ "$had_home" = 1 ] && chown -R "$U:$(id -gn "$U")" "$HOMEDIR"',
    'fi',
    // useradd leaves the account locked; an sshd with UsePAM no refuses a locked one, key or not
    'usermod -p "*" "$U" || fail "usermod could not unlock $U for its key"',
    'install -d -m 700 -o "$U" -g "$(id -gn "$U")" "$HOMEDIR" "$SNAP" || fail "could not make $SNAP"',
    'echo "@@step drop"',
    '[ -f "$DROP" ] && cp -p "$DROP" "$W/drop.old"',
    ...heredoc('AGENT_BOARD_DROP', dropScript(), '"$DROP.part"'),
    'chmod 755 "$DROP.part" && chown root:root "$DROP.part" && mv -f "$DROP.part" "$DROP" || fail "could not put the drop script in place"',
    'put_drop=1',
    'echo "@@step keys"',
    'if [ ! -d "$KEYSDIR" ]; then install -d -m 755 "$KEYSDIR" || fail "could not make $KEYSDIR"; made_keysdir=1; rec_keysdir=1; rec || fail "could not write $REC"; fi',
    '[ -f "$KEYS" ] && cp -p "$KEYS" "$W/keys.old"',
    `printf '%s\\n' ${shQuote(backupKeysLine(publicKey))} > "$KEYS.part" && chmod 644 "$KEYS.part" && chown root:root "$KEYS.part" && mv -f "$KEYS.part" "$KEYS" || fail "could not write $KEYS"`,
    'put_keys=1',
    'echo "@@step fence"',
    ...heredoc('AGENT_BOARD_FENCE', fenceFileText(), '"$W/fence"'),
    ...heredoc('AGENT_BOARD_BLOCK', fenceMarked(), '"$W/fence.block"'),
    'if includes; then',
    '  candidate "$W/fence" || fail "could not copy sshd\'s config to check it"',
    '  sshd -t -f "$W/main" 2>"$W/t" || fail "sshd -t refuses the config with the fence: $(firstLines "$W/t")"',
    '  [ -f "$FENCE" ] && cp -p "$FENCE" "$W/fence.old"',
    '  cp "$W/fence" "$FENCE.part" && chmod 644 "$FENCE.part" && mv -f "$FENCE.part" "$FENCE" || fail "could not write $FENCE"',
    '  fence=file',
    'else',
    '  cp -p "$CONF" "$W/sshd_config" || fail "could not keep a copy of sshd_config"',
    '  strip "$CONF" > "$W/stripped"',
    '  withBlock "$W/stripped" > "$W/main"',
    '  sshd -t -f "$W/main" 2>"$W/t" || fail "sshd -t refuses the config with the fence: $(firstLines "$W/t")"',
    '  fence=block',
    '  putConf "$W/main" || fail "could not write $CONF"',
    'fi',
    'rec_fence=$fence',
    'rec || fail "could not write $REC"',
    'sshd -t 2>"$W/t" || fail "sshd -t refuses the config with the fence in place: $(firstLines "$W/t")"',
    'bad=$(notInForce)',
    '[ -z "$bad" ] || fail "sshd\'s fence for $U is not in force: $(printf "%s" "$bad" | tr "\\n" ",")"',
    'admins > "$W/admins.after" || fail "sshd -T does not answer for root or the admin"',
    'cmp -s "$W/admins.before" "$W/admins.after" || fail "the fence would change sshd\'s settings for root or the admin"',
    'echo "@@step reload"',
    'reloaded=1',
    'reload || fail "sshd did not reload"',
    'rec || fail "could not write $REC"',
    'rm -rf "$W"',
    'echo "@@done"',
    '',
  ].join('\n')
}

/**
 * Undo, as root, of what Apply's record says it made: sshd's fence out (checked before it goes and
 * after, root's and the admin's settings unchanged, sshd_config replaced whole, a reload; a failure
 * puts it back), the keys file, the drop script, the user (only one with the board's comment), its
 * home given to root so no later user with its uid gets the snapshots, the record and the backup's
 * folder. The snapshots stay: `@@kept <folder> <count>`. No record: `@@none`. A hangup or a broken
 * pipe does not stop it.
 */
export function undoScript(): string {
  return [
    ...PREAMBLE,
    "trap '' HUP PIPE",
    'trap \'rm -rf "$W"\' EXIT',
    '[ -d /run/sshd ] || install -d -m 755 /run/sshd',
    '[ "$(id -u)" = 0 ] || { echo "@@fail this runs as root"; exit 1; }',
    'if [ ! -f "$REC" ]; then echo "@@none"; exit 0; fi',
    'rec_user=$(sed -n "s/^user=//p" "$REC"); rec_keysdir=$(sed -n "s/^keysdir=//p" "$REC")',
    'sshd -t 2>"$W/t" || { echo "@@fail sshd\'s config does not pass sshd -t as it is: $(firstLines "$W/t")"; exit 1; }',
    'whole || { echo "@@fail the board\'s block in $CONF is not whole: put it right by hand first"; exit 1; }',
    'admins > "$W/admins.before" || { echo "@@fail sshd -T does not answer for root or the admin"; exit 1; }',
    'echo "@@step fence"',
    'changed=',
    'if [ -f "$FENCE" ]; then',
    '  candidate "" || { echo "@@fail could not copy sshd\'s config to check it"; exit 1; }',
    '  sshd -t -f "$W/main" 2>"$W/t" || { echo "@@fail sshd -t refuses the config without the fence: $(firstLines "$W/t")"; exit 1; }',
    '  cp -p "$FENCE" "$W/fence.old" && rm -f "$FENCE" && changed=file',
    'elif grep -qxF "$E0" "$CONF"; then',
    '  cp -p "$CONF" "$W/sshd_config"',
    '  strip "$CONF" > "$W/main"',
    '  sshd -t -f "$W/main" 2>"$W/t" || { echo "@@fail sshd -t refuses the config without the fence: $(firstLines "$W/t")"; exit 1; }',
    '  putConf "$W/main" && changed=block',
    'fi',
    'putBack() { case $changed in file) cp -p "$W/fence.old" "$FENCE" ;; block) putConf "$W/sshd_config" ;; esac; }',
    'if [ -n "$changed" ]; then',
    '  if ! sshd -t 2>"$W/t"; then putBack; echo "@@fail sshd -t refuses the config without the fence: $(firstLines "$W/t")"; exit 1; fi',
    '  admins > "$W/admins.after" || { putBack; echo "@@fail sshd -T does not answer for root or the admin"; exit 1; }',
    '  if ! cmp -s "$W/admins.before" "$W/admins.after"; then putBack; echo "@@fail taking the fence out would change sshd\'s settings for root or the admin"; exit 1; fi',
    '  if ! reload; then putBack; sshd -t && reload; echo "@@fail sshd did not reload"; exit 1; fi',
    'fi',
    'echo "@@step files"',
    'rm -f "$KEYS" "$DROP" "$DROP.part"',
    '[ "$rec_keysdir" = 1 ] && rmdir "$KEYSDIR" 2>/dev/null',
    'echo "@@step user"',
    'if [ "$rec_user" = 1 ] && p=$(getent passwd "$U"); then',
    '  case $(printf "%s\\n" "$p" | cut -d: -f5) in "$COMMENT"*) userdel "$U" || echo "@@warn userdel $U failed" ;; esac',
    'fi',
    '[ -d "$HOMEDIR" ] && ! getent passwd "$U" >/dev/null && chown -R root:root "$HOMEDIR"',
    'n=0; [ -d "$SNAP" ] && n=$(ls "$SNAP" | grep -c "\\.abk$")',
    'rm -f "$REC" "$REC.part"',
    'rmdir "$ETCDIR" 2>/dev/null',
    'echo "@@kept $SNAP $n"',
    'echo "@@done"',
    '',
  ].join('\n')
}

// ------------------------------------------------------------------ what the scripts said

export type Presence = 'none' | 'same' | 'other'

/** Look's findings. */
export interface BackupLook {
  ssh: string
  include: boolean
  /** useradd is there (an Alpine has adduser instead). */
  useradd: boolean
  user: 'none' | 'ours' | 'other' | 'group'
  drop: Presence
  keys: Presence
  fence: 'none' | 'file' | 'block'
  /** A block of the board's in sshd_config that is not whole: nothing is done until it is put right by hand. */
  blockTorn: boolean
  record: boolean
  snapshots: { count: number; kb: number }
  freeKb: number | null
  /** sshd's config passes `sshd -t` now: 'ok', or the first lines of what it said. */
  sshdNow: string
  /** It would with the fence in place and the fence in force: 'ok', or why not. */
  candidate: string
}

/** Look's lines read; null when the script did not get to its end (`@@end`). */
export function readLook(lines: readonly string[]): BackupLook | null {
  if (!lines.includes('@@end')) return null
  const said = (key: string): string | undefined =>
    lines.find(l => l === `@@${key}` || l.startsWith(`@@${key} `))?.slice(key.length + 3)
  const one = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = said(key)?.trim() as T | undefined
    return v && allowed.includes(v) ? v : fallback
  }
  const [count = 0, kb = 0] = (said('snapshots') ?? '').split(' ').map(Number)
  const free = Number(said('df'))
  return {
    ssh: said('ssh')?.trim() ?? '',
    include: said('include')?.trim() === 'yes',
    useradd: said('useradd')?.trim() !== 'no',
    user: one('user', ['none', 'ours', 'other', 'group'], 'other'),
    drop: one('drop', ['none', 'same', 'other'], 'other'),
    keys: one('keys', ['none', 'same', 'other'], 'other'),
    fence: one('fence', ['none', 'file', 'block'], 'none'),
    blockTorn: said('block')?.trim() === 'torn',
    record: said('record')?.trim() === 'yes',
    snapshots: { count: Number.isFinite(count) ? count : 0, kb: Number.isFinite(kb) ? kb : 0 },
    freeKb: Number.isFinite(free) && said('df')?.trim() ? free : null,
    sshdNow: said('sshd-t')?.trim() ?? '',
    candidate: said('candidate')?.trim() ?? '',
  }
}

/** Whether Look's findings say Apply can go on (and why not, a text key with values). */
export function lookVerdict(l: BackupLook): { ok: true } | { ok: false; key: string; vars?: Record<string, string> } {
  if (!l.useradd) return { ok: false, key: 'backup.server.noUseradd' }
  if (l.user === 'other') return { ok: false, key: 'backup.server.userOther', vars: { user: BACKUP_USER } }
  if (l.user === 'group') return { ok: false, key: 'backup.server.groupOther', vars: { user: BACKUP_USER } }
  if (l.blockTorn) return { ok: false, key: 'backup.server.blockTorn' }
  if (l.sshdNow !== 'ok') return { ok: false, key: 'backup.server.sshdBroken', vars: { said: l.sshdNow } }
  if (l.candidate !== 'ok') return { ok: false, key: 'backup.server.candidateBad', vars: { said: l.candidate } }
  return { ok: true }
}

/** Whether the server already has the board's backup set up as this board would (its key, the current drop script, a fence, a record). */
export const lookIsSet = (l: BackupLook): boolean =>
  l.user === 'ours' && l.drop === 'same' && l.keys === 'same' && l.fence !== 'none' && l.record

/** How a run (Apply or Undo) ended: the steps it got through, and its failure or what it kept. */
export interface RunOutcome {
  ok: boolean
  steps: string[]
  fail: string | null
  /** Undo: nothing of the board's was there. */
  none: boolean
  /** Undo: the snapshots left, and where. */
  kept: { dir: string; count: number } | null
  warnings: string[]
}

export function readRun(lines: readonly string[]): RunOutcome {
  const steps = lines.filter(l => l.startsWith('@@step ')).map(l => l.slice(7))
  const fail = lines.find(l => l.startsWith('@@fail '))?.slice(7) ?? null
  const keptLine = lines.find(l => l.startsWith('@@kept '))?.slice(7)
  let kept: RunOutcome['kept'] = null
  if (keptLine) {
    const at = keptLine.lastIndexOf(' ')
    kept = { dir: keptLine.slice(0, at), count: Number(keptLine.slice(at + 1)) || 0 }
  }
  const none = lines.includes('@@none')
  return {
    ok: fail === null && (lines.includes('@@done') || none),
    steps,
    fail,
    none,
    kept,
    warnings: lines.filter(l => l.startsWith('@@warn ')).map(l => l.slice(7)),
  }
}

/** "Do it myself": the Apply script as a file to run as root, and the line that runs it. */
export function doItMyself(publicKey: string): { file: string; script: string; run: string } {
  const file = 'agent-board-backup-setup.sh'
  return { file, script: applyScript(publicKey), run: `sudo sh ${file}` }
}

/** How long the board waits for an ssh to the drop script, in ms: a put of a large snapshot over a slow line. */
export const DROP_TIMEOUT_MS = 10 * 60_000
/** How long a Look, Apply or Undo may take. */
export const RUN_TIMEOUT_MS = 3 * 60_000
