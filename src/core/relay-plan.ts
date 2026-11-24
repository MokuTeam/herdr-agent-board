// The relay on a server for machines behind NAT (#511, design docs/design/nodes/README.md 20):
// what Look reads on the server, the plan Apply runs (each step with its skip check, commands,
// check and undo, and what it puts on the record), /etc/agent-board-relay/setup.json and the Undo
// it gives, and the one sh script a plan runs as.
//
// Disjoint from the tunnel (/etc/agent-board, /var/lib/boardtunnel), backup (/etc/agent-board-backup),
// and node (/etc/agent-board-node) setups so the relay can coexist on the same server (including
// the master's own public server, epic #702). Every file is written beside itself and renamed over,
// and the record is updated before a step with what it is about to make. Pure, with no node: import.

import {
  AUTH_KEYS_DIR,
  isRelayPublicKey,
  RELAY_BLOCK_BEGIN,
  RELAY_BLOCK_END,
  RELAY_ENROL_SCRIPT,
  RELAY_ETC,
  RELAY_FENCE,
  RELAY_KEYS_CMD,
  RELAY_KEYS_DIR,
  RELAY_MASTER_COMMENT,
  RELAY_MASTER_KEYS,
  RELAY_MASTER_USER,
  RELAY_NODE_COMMENT,
  RELAY_NODE_USER,
  RELAY_RECORD,
  RELAY_RUN_LOCK,
  RELAY_SOCKETS_DIR,
  relayEnrolScript,
  relayFenceBlock,
  relayFenceFile,
  relayFenceMarked,
  relayKeyBody,
  relayKeysCommand,
  relayMasterFenceSettings,
  relayMasterKeysFile,
  relayNodeFenceSettings,
} from './relay-texts.ts'
import type { Text } from './server-plan.ts'
import { isPlainPath, shQuote } from './server-shell.ts'
import { SSHD_RELOAD } from './tunnel-snippets.ts'

const q = shQuote
const SSHD_CONFIG = '/etc/ssh/sshd_config'
const SSHD_DIR = '/etc/ssh/sshd_config.d'

// ---------------------------------------------------------------------------------------------
// Look

export type UserState = 'none' | 'ours' | 'other' | 'group'
export type Presence = 'none' | 'same' | 'other'
export type FenceState = 'none' | 'file-same' | 'file-other' | 'block-same' | 'block-other'

/** What Look reads on the server, changing nothing. */
export interface RelayFacts {
  os: { id: string; version: string; pretty: string }
  ssh: string
  hostname: string
  sudo: 'root' | 'nopasswd' | 'password' | 'none'
  /** Of sshd, useradd, usermod, userdel, install, flock: the ones on the server. */
  has: string[]
  nodeUser: UserState
  masterUser: UserState
  socketsDir: Presence
  keysDir: Presence
  authKeysDir: boolean
  keysCmd: Presence
  enrol: Presence
  masterKeys: Presence
  fence: FenceState
  blockTorn: boolean
  include: boolean
  sshdNow: string
  candidate: string
  busy: boolean
  record: unknown
  recordTorn: boolean
  enrolled: number
}

export interface RelayLookInput {
  masterKey?: string
  enrolKey?: string
}

const LOOK_TOOLS = ['sshd', 'useradd', 'usermod', 'userdel', 'install', 'flock'] as const
const INCLUDES_AWK = `tolower($1) == "match" { exit } tolower($1) == "include" { for (i = 2; i <= NF; i++) if ($i == "${SSHD_DIR}/*.conf" || $i == "sshd_config.d/*.conf") f = 1 } END { exit !f }`

/** printf of a text's lines, one shell word each. */
const emit = (text: string): string =>
  `printf '%s\\n' ${text
    .replace(/\n$/, '')
    .split('\n')
    .map(l => q(l))
    .join(' ')}`

const fenceWant = (settings: readonly (readonly [string, string])[]): string =>
  settings.map(([k, v]) => `${k.toLowerCase()} ${v}`).join('|')

/**
 * Over sshd -T's lines for a relay user: each expected setting that is missing, and any
 * AllowUsers, AllowGroups, DenyUsers or DenyGroups that keeps the user out.
 */
const NOT_IN_FORCE_AWK = [
  'BEGIN { n = split(ENVIRON["WANT"], want, "|") }',
  '{ got[$0] = 1 }',
  'function ok(p) { return p == ENVIRON["U"] || p ~ /[*?]/ }',
  '$1 == "allowusers" { a = 1; for (i = 2; i <= NF; i++) if (ok($i)) au = 1 }',
  '$1 == "allowgroups" { g = 1; for (i = 2; i <= NF; i++) if (ok($i)) ag = 1 }',
  '($1 == "denyusers" || $1 == "denygroups") { for (i = 2; i <= NF; i++) if ($i == ENVIRON["U"]) print $1 " " $i }',
  'END { for (i = 1; i <= n; i++) if (!(want[i] in got)) print want[i]; if (a && !au) print "allowusers leaves " ENVIRON["U"] " out"; if (g && !ag) print "allowgroups leaves " ENVIRON["U"] " out" }',
].join(' ')

const BLOCK_STRIP_AWK = `index($0, ENVIRON["B0"]) == 1 { s = 1 } !s { print } s && $0 == ENVIRON["E0"] { s = 0 }`
const BLOCK_WHOLE_AWK = `index($0, ENVIRON["B0"]) == 1 { n++ } $0 == ENVIRON["E0"] { m++ } END { exit !(n == m && n <= 1) }`
const BLOCK_EXTRACT_AWK = `index($0, ENVIRON["B0"]) == 1 { s = 1 } s { print } s && $0 == ENVIRON["E0"] { s = 0 }`

/**
 * Look script as root: OS, ssh version, sudo, tools, relay users, sockets/keys dirs,
 * scripts, master authorized_keys, sshd fence, sshd -t now and candidate check, record, enrolled
 * key count. Ends with `@@end`.
 *
 * On socket-activated hosts (e.g. Ubuntu `ssh.socket` before `sshd` has started) `/run/sshd` may
 * not exist yet and `sshd -t` as root fails with `Missing privilege separation directory:
 * /run/sshd`; Look temporarily creates `/run/sshd` only when it was absent and removes it with
 * `rmdir` in its `EXIT` trap so Look leaves the server as it found it.
 */
export function relayLookScript(i: RelayLookInput = {}): string {
  const hasKeys =
    i.masterKey !== undefined &&
    i.enrolKey !== undefined &&
    isRelayPublicKey(i.masterKey) &&
    isRelayPublicKey(i.enrolKey)
  const masterKeysText = hasKeys ? relayMasterKeysFile(i.masterKey as string, i.enrolKey as string) : ''
  const userCheck = (name: string, comment: string, key: string): string =>
    `if p=$(getent passwd ${q(name)}); then if [ "$(printf '%s\\n' "$p" | cut -d: -f5)" = ${q(comment)} ]; then echo "@@${key} ours"; else echo "@@${key} other"; fi; elif getent group ${q(name)} >/dev/null; then echo "@@${key} group"; else echo "@@${key} none"; fi`
  const dirCheck = (path: string, wantStat: string, key: string): string =>
    `if [ -L ${q(path)} ]; then echo "@@${key} other"; elif [ -d ${q(path)} ]; then if [ "$(stat -c '%a %U %G' ${q(path)} 2>/dev/null)" = ${q(wantStat)} ]; then echo "@@${key} same"; else echo "@@${key} other"; fi; elif [ -e ${q(path)} ]; then echo "@@${key} other"; else echo "@@${key} none"; fi`
  const fileCheck = (path: string, wantFile: string, key: string, exec = false): string =>
    `if [ -L ${q(path)} ]; then echo "@@${key} other"; elif [ -f ${q(path)} ]; then if ${exec ? `[ -x ${q(path)} ] && ` : ''}cmp -s ${wantFile} ${q(path)}; then echo "@@${key} same"; else echo "@@${key} other"; fi; elif [ -e ${q(path)} ]; then echo "@@${key} other"; else echo "@@${key} none"; fi`
  return [
    'exec </dev/null',
    '# agent-board: relay look',
    'cd /',
    'set -u',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    'LC_ALL=C; export LC_ALL',
    'W=$(mktemp -d) || { echo "@@fail could not make a temp folder"; exit 1; }',
    'made_run_sshd=0',
    `trap 'if [ "$made_run_sshd" = 1 ]; then rmdir /run/sshd 2>/dev/null || :; fi; rm -rf "$W"' EXIT`,
    `N=${q(RELAY_NODE_USER)}; M=${q(RELAY_MASTER_USER)}`,
    `CONF=${q(SSHD_CONFIG)}; CONFD=${q(SSHD_DIR)}; FENCE=${q(RELAY_FENCE)}`,
    `B0=${q(RELAY_BLOCK_BEGIN)}; E0=${q(RELAY_BLOCK_END)}`,
    'firstLines() { head -n 5 "$1" | tr "\\n" " "; }',
    `includes() { [ -d "$CONFD" ] && awk ${q(INCLUDES_AWK)} "$CONF" 2>/dev/null; }`,
    `whole() { B0="$B0" E0="$E0" awk ${q(BLOCK_WHOLE_AWK)} "$CONF" 2>/dev/null; }`,
    `strip() { B0="$B0" E0="$E0" awk ${q(BLOCK_STRIP_AWK)} "$1"; }`,
    'withBlock() { cat "$1"; if [ -s "$1" ] && [ -n "$(tail -c 1 "$1")" ]; then echo; fi; cat "$W/fence.block"; }',
    `candidate() { rm -rf "$W/d"; cp -a "$CONFD" "$W/d" && rm -f "$W/d/\${FENCE##*/}" && { [ -z "$1" ] || cp "$1" "$W/d/\${FENCE##*/}"; } && D="$W/d" awk ${q(`tolower($1) == "include" { for (i = 2; i <= NF; i++) if ($i == "${SSHD_DIR}/*.conf" || $i == "sshd_config.d/*.conf") $i = ENVIRON["D"] "/*.conf" } { print }`)} "$CONF" > "$W/main"; }`,
    `notInForceN() { t=$(sshd -T "$@" -C "user=$N,host=localhost,addr=127.0.0.1" 2>&1) || { echo "$t" | head -n 3; return; }; printf '%s\\n' "$t" | U="$N" WANT=${q(fenceWant(relayNodeFenceSettings()))} awk ${q(NOT_IN_FORCE_AWK)}; }`,
    `notInForceM() { t=$(sshd -T "$@" -C "user=$M,host=localhost,addr=127.0.0.1" 2>&1) || { echo "$t" | head -n 3; return; }; printf '%s\\n' "$t" | U="$M" WANT=${q(fenceWant(relayMasterFenceSettings()))} awk ${q(NOT_IN_FORCE_AWK)}; }`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    'if [ -r /etc/os-release ]; then ( . /etc/os-release; echo "@@os ${ID:-} ${VERSION_ID:-}"; echo "@@pretty ${PRETTY_NAME:-}" ); fi',
    'echo "@@ssh $(ssh -V 2>&1 | head -n 1)"',
    'echo "@@hostname $(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null)"',
    'if [ "$(id -u)" = 0 ]; then echo "@@sudo root"; elif ! command -v sudo >/dev/null 2>&1; then echo "@@sudo none"; elif sudo -n true 2>/dev/null; then echo "@@sudo nopasswd"; else echo "@@sudo password"; fi',
    `for c in ${LOOK_TOOLS.join(' ')}; do if command -v "$c" >/dev/null 2>&1; then echo "@@has $c"; fi; done`,
    userCheck(RELAY_NODE_USER, RELAY_NODE_COMMENT, 'node-user'),
    userCheck(RELAY_MASTER_USER, RELAY_MASTER_COMMENT, 'master-user'),
    dirCheck(RELAY_SOCKETS_DIR, `2770 ${RELAY_NODE_USER} ${RELAY_MASTER_USER}`, 'sockets-dir'),
    dirCheck(RELAY_KEYS_DIR, `700 ${RELAY_MASTER_USER} ${RELAY_MASTER_USER}`, 'keys-dir'),
    `if [ -d ${q(AUTH_KEYS_DIR)} ]; then echo "@@auth-keys-dir yes"; else echo "@@auth-keys-dir no"; fi`,
    `${emit(relayKeysCommand())} > "$W/keys.want"`,
    fileCheck(RELAY_KEYS_CMD, '"$W/keys.want"', 'keys-cmd', true),
    `${emit(relayEnrolScript())} > "$W/enrol.want"`,
    fileCheck(RELAY_ENROL_SCRIPT, '"$W/enrol.want"', 'enrol', true),
    ...(hasKeys
      ? [
          `${emit(masterKeysText)} > "$W/mkeys.want"`,
          fileCheck(RELAY_MASTER_KEYS, '"$W/mkeys.want"', 'master-keys', false),
        ]
      : [`if [ -e ${q(RELAY_MASTER_KEYS)} ]; then echo "@@master-keys other"; else echo "@@master-keys none"; fi`]),
    `${emit(relayFenceFile())} > "$W/fence"`,
    `${emit(relayFenceMarked())} > "$W/fence.block"`,
    'if [ -L "$FENCE" ]; then echo "@@fence file-other"',
    'elif [ -f "$FENCE" ]; then if cmp -s "$W/fence" "$FENCE" && ! grep -qxF "$E0" "$CONF" 2>/dev/null; then echo "@@fence file-same"; else echo "@@fence file-other"; fi',
    `elif grep -qxF "$E0" "$CONF" 2>/dev/null; then B0="$B0" E0="$E0" awk ${q(BLOCK_EXTRACT_AWK)} "$CONF" > "$W/fence.cur"; if cmp -s "$W/fence.block" "$W/fence.cur"; then echo "@@fence block-same"; else echo "@@fence block-other"; fi`,
    'else echo "@@fence none"; fi',
    'if whole; then echo "@@block whole"; else echo "@@block torn"; fi',
    'if includes; then echo "@@include yes"; else echo "@@include no"; fi',
    'if [ ! -d /run/sshd ] && [ "$(id -u)" = 0 ]; then install -d -m 755 /run/sshd && made_run_sshd=1; fi',
    'if sshd -t 2>"$W/t"; then echo "@@sshd-t ok"; else echo "@@sshd-t $(firstLines "$W/t")"; fi',
    'if includes; then candidate "$W/fence"; else strip "$CONF" > "$W/stripped"; withBlock "$W/stripped" > "$W/main"; fi',
    'if ! sshd -t -f "$W/main" 2>"$W/t"; then echo "@@candidate $(firstLines "$W/t")"',
    'else badN=$(notInForceN -f "$W/main"); badM=$(notInForceM -f "$W/main"); bad=$(printf "%s\\n%s" "$badN" "$badM" | sed "/^$/d" | tr "\\n" ","); if [ -n "$bad" ]; then echo "@@candidate not in force: $bad"; else echo "@@candidate ok"; fi; fi',
    `if [ -e ${q(RELAY_RUN_LOCK)} ] && command -v flock >/dev/null 2>&1 && ! flock -n ${q(RELAY_RUN_LOCK)} true; then echo '@@busy'; fi`,
    `if [ -f ${q(RELAY_RECORD)} ]; then echo "@@record $(tr -d '\\n' < ${q(RELAY_RECORD)})"; fi`,
    `n=0; if [ -d ${q(RELAY_KEYS_DIR)} ]; then for f in ${q(RELAY_KEYS_DIR)}/*.pub; do [ -f "$f" ] && [ ! -L "$f" ] && n=$((n + 1)); done; fi; echo "@@enrolled $n"`,
    'echo "@@end"',
    '',
  ].join('\n')
}

/** Look's lines read; null when the script did not get to its end. */
export function readRelayLook(lines: readonly string[]): RelayFacts | null {
  if (!lines.includes('@@end')) return null
  const said = (key: string): string | undefined =>
    lines.find(l => l === `@@${key}` || l.startsWith(`@@${key} `))?.slice(key.length + 3)
  const one = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = said(key)?.trim() as T | undefined
    return v && allowed.includes(v) ? v : fallback
  }
  const [osId = '', osVersion = ''] = (said('os') ?? '').trim().split(/\s+/)
  let record: unknown = null
  let recordTorn = false
  const raw = said('record')
  if (raw !== undefined) {
    try {
      record = JSON.parse(raw)
    } catch {
      recordTorn = true
    }
  }
  const enrolledNum = Number(said('enrolled')?.trim())
  return {
    os: { id: osId, version: osVersion, pretty: said('pretty')?.trim() ?? '' },
    ssh: said('ssh')?.trim() ?? '',
    hostname: (said('hostname') ?? '').trim().slice(0, 253),
    sudo: one('sudo', ['root', 'nopasswd', 'password', 'none'], 'none'),
    has: LOOK_TOOLS.filter(t => lines.includes(`@@has ${t}`)),
    nodeUser: one('node-user', ['none', 'ours', 'other', 'group'], 'other'),
    masterUser: one('master-user', ['none', 'ours', 'other', 'group'], 'other'),
    socketsDir: one('sockets-dir', ['none', 'same', 'other'], 'other'),
    keysDir: one('keys-dir', ['none', 'same', 'other'], 'other'),
    authKeysDir: said('auth-keys-dir')?.trim() === 'yes',
    keysCmd: one('keys-cmd', ['none', 'same', 'other'], 'other'),
    enrol: one('enrol', ['none', 'same', 'other'], 'other'),
    masterKeys: one('master-keys', ['none', 'same', 'other'], 'other'),
    fence: one('fence', ['none', 'file-same', 'file-other', 'block-same', 'block-other'], 'file-other'),
    blockTorn: said('block')?.trim() === 'torn',
    include: said('include')?.trim() === 'yes',
    sshdNow: said('sshd-t')?.trim() ?? '',
    candidate: said('candidate')?.trim() ?? '',
    busy: lines.includes('@@busy'),
    record,
    recordTorn,
    enrolled: Number.isFinite(enrolledNum) && enrolledNum >= 0 ? Math.floor(enrolledNum) : 0,
  }
}

// ---------------------------------------------------------------------------------------------
// What the panel wants

export interface RelayWanted {
  /** Master key for local unix socket forwarding (agent-board-relay-m). */
  masterKey: string
  /** Enrol key for adding/removing NAT node keys via forced command (agent-board-relay-m). */
  enrolKey: string
}

/** Why the values cannot reach a script; null when they can. */
export function relayWantedProblem(w: RelayWanted): string | null {
  const m = relayKeyBody(w.masterKey)
  if (!m) return 'masterKey'
  const e = relayKeyBody(w.enrolKey)
  if (!e) return 'enrolKey'
  if (m === e) return 'sameKey'
  return null
}

// ---------------------------------------------------------------------------------------------
// The record

export type RecordState = 'running' | 'applied' | 'rollback-failed' | 'undoing' | 'undo-failed'

/** Fixed-kind items a relay setup run creates on the server; Undo acts on these only. */
export type RelayItem =
  | { kind: 'user'; name: typeof RELAY_NODE_USER | typeof RELAY_MASTER_USER }
  | { kind: 'socketsDir' }
  | { kind: 'keysDir' }
  | { kind: 'keysCmd' }
  | { kind: 'enrol' }
  | { kind: 'authKeysDir' }
  | { kind: 'masterKeys' }
  | { kind: 'fence' }

export interface RelayRecord {
  v: 1
  run: string
  at: string
  state: RecordState
  items: RelayItem[]
}

const STATES: readonly RecordState[] = ['running', 'applied', 'rollback-failed', 'undoing', 'undo-failed']
const PLAIN_ID = /^[A-Za-z0-9._-]{1,64}$/
const STAMP = /^[0-9TZ:.+-]{1,40}$/
const isFields = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const itemKey = (i: RelayItem): string => (i.kind === 'user' ? `user ${i.name}` : i.kind)

function relayItem(v: unknown): RelayItem | null {
  if (!isFields(v)) return null
  switch (v.kind) {
    case 'user':
      return v.name === RELAY_NODE_USER || v.name === RELAY_MASTER_USER ? { kind: 'user', name: v.name } : null
    case 'socketsDir':
    case 'keysDir':
    case 'keysCmd':
    case 'enrol':
    case 'authKeysDir':
    case 'masterKeys':
    case 'fence':
      return { kind: v.kind }
    default:
      return null
  }
}

/** The record parsed; null when missing, unreadable or invalid. Unknown items are ignored. */
export function relayRecord(json: unknown): RelayRecord | null {
  if (!isFields(json) || json.v !== 1) return null
  const { run, at, state, items } = json
  if (typeof run !== 'string' || !PLAIN_ID.test(run) || typeof at !== 'string' || !STAMP.test(at)) return null
  if (!STATES.includes(state as RecordState) || !Array.isArray(items)) return null
  const seen = new Map<string, RelayItem>()
  for (const raw of items) {
    const item = relayItem(raw)
    if (item) seen.set(itemKey(item), item)
  }
  return { v: 1, run, at, state: state as RecordState, items: [...seen.values()] }
}

// ---------------------------------------------------------------------------------------------
// Refusals

/**
 * Why Apply cannot run on this server; empty when it may proceed.
 * Does not touch or refuse other setups (tunnel, backup, node).
 */
export function relayRefusals(f: RelayFacts, _w: RelayWanted): Text[] {
  const out: Text[] = []
  const say = (key: string, params?: Record<string, string>): void => void out.push(params ? { key, params } : { key })
  if (f.sudo === 'none') say('relay.refuse.sudo')
  for (const tool of LOOK_TOOLS) if (!f.has.includes(tool)) say('relay.refuse.tool', { tool })
  for (const [state, name] of [
    [f.nodeUser, RELAY_NODE_USER],
    [f.masterUser, RELAY_MASTER_USER],
  ] as const) {
    if (state === 'other') say('relay.refuse.userOther', { user: name })
    if (state === 'group') say('relay.refuse.userGroup', { user: name })
  }
  if (f.busy) say('relay.refuse.busy')
  if (f.blockTorn) say('relay.refuse.blockTorn')
  if (f.sshdNow !== 'ok') say('relay.refuse.sshd', { said: f.sshdNow || '?' })
  else if (!f.blockTorn && f.candidate !== 'ok') say('relay.refuse.candidate', { said: f.candidate || '?' })
  const rec = f.record === null ? null : relayRecord(f.record)
  if (f.recordTorn || (f.record !== null && !rec)) say('relay.refuse.record', { path: RELAY_RECORD })
  if (rec && rec.state !== 'applied') say('relay.refuse.interrupted')
  const has = (kind: RelayItem['kind']): boolean => !!rec?.items.some(i => i.kind === kind)
  if (f.socketsDir === 'other' && !has('socketsDir')) say('relay.refuse.socketsDirOther', { path: RELAY_SOCKETS_DIR })
  if (f.keysDir === 'other' && !has('keysDir')) say('relay.refuse.keysDirOther', { path: RELAY_KEYS_DIR })
  if (f.keysCmd === 'other' && !has('keysCmd')) say('relay.refuse.keysCmdOther', { path: RELAY_KEYS_CMD })
  if (f.enrol === 'other' && !has('enrol')) say('relay.refuse.enrolOther', { path: RELAY_ENROL_SCRIPT })
  if (f.masterKeys === 'other' && !has('masterKeys')) say('relay.refuse.masterKeysOther', { path: RELAY_MASTER_KEYS })
  if ((f.fence === 'file-other' || f.fence === 'block-other') && !has('fence'))
    say('relay.refuse.fenceOther', { path: f.fence === 'file-other' ? RELAY_FENCE : SSHD_CONFIG })
  return out
}

// ---------------------------------------------------------------------------------------------
// The steps

export interface RelayStep {
  id: string
  title: Text
  why: Text
  skipIf: string[]
  commands: string[]
  check: string[]
  undo: string[]
  record: RelayItem[]
  timeoutS: number
  changes: boolean
}

export interface RelayPlan {
  kind: 'apply' | 'undo'
  steps: RelayStep[]
  carried: RelayItem[]
  words: Text[]
  warnings: Text[]
}

const step = (id: string, kind: 'step' | 'undo', parts: Partial<RelayStep>): RelayStep => ({
  id,
  title: { key: `relay.${kind}.${id}` },
  why: { key: `relay.${kind}Why.${id}` },
  skipIf: [],
  commands: [],
  check: [],
  undo: [],
  record: [],
  timeoutS: 60,
  changes: true,
  ...parts,
})

function prelude(): string[] {
  return [
    'set -e',
    'sudo() { "$@"; }',
    `N=${q(RELAY_NODE_USER)}; M=${q(RELAY_MASTER_USER)}`,
    `N_COMMENT=${q(RELAY_NODE_COMMENT)}; M_COMMENT=${q(RELAY_MASTER_COMMENT)}`,
    `SOCKETS=${q(RELAY_SOCKETS_DIR)}; KEYSDIR=${q(RELAY_KEYS_DIR)}`,
    `ETCDIR=${q(RELAY_ETC)}; KEYS_CMD=${q(RELAY_KEYS_CMD)}; ENROL=${q(RELAY_ENROL_SCRIPT)}`,
    `AUTHDIR=${q(AUTH_KEYS_DIR)}; MKEYS=${q(RELAY_MASTER_KEYS)}`,
    `CONF=${q(SSHD_CONFIG)}; CONFD=${q(SSHD_DIR)}; FENCE=${q(RELAY_FENCE)}`,
    `B0=${q(RELAY_BLOCK_BEGIN)}; E0=${q(RELAY_BLOCK_END)}`,
    `ours() { p=$(getent passwd "$1") && [ "$(printf '%s\\n' "$p" | cut -d: -f5)" = "$2" ]; }`,
    'userGone() { pkill -KILL -u "$1" 2>/dev/null || :; i=0; until userdel "$1" 2>/dev/null; do i=$((i + 1)); [ "$i" -lt 10 ] || return 1; sleep 1; done; }',
    'restore() { cp -p "$1" "$2.part" && mv -f "$2.part" "$2"; }',
    `reload() { ${SSHD_RELOAD.replaceAll('sudo ', '')} || { [ -f /run/sshd.pid ] && kill -HUP "$(cat /run/sshd.pid)"; }; }`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    'admins() { for u in root ${SUDO_USER:-}; do echo "@@ $u"; sshd -T -C "user=$u,host=localhost,addr=127.0.0.1" || return 1; done; }',
    `includes() { [ -d "$CONFD" ] && awk ${q(INCLUDES_AWK)} "$CONF" 2>/dev/null; }`,
    `whole() { B0="$B0" E0="$E0" awk ${q(BLOCK_WHOLE_AWK)} "$CONF"; }`,
    `strip() { B0="$B0" E0="$E0" awk ${q(BLOCK_STRIP_AWK)} "$1"; }`,
    'withBlock() { cat "$1"; if [ -s "$1" ] && [ -n "$(tail -c 1 "$1")" ]; then echo; fi; cat "$W/fence.block"; }',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    'putConf() { t=$(readlink -f "$CONF") && p="${t%/*}/.${t##*/}.agent-board-relay" && cp -p "$t" "$p" && cat "$1" > "$p" && mv -f "$p" "$t"; }',
    `candidate() { rm -rf "$W/d"; cp -a "$CONFD" "$W/d" && rm -f "$W/d/\${FENCE##*/}" && { [ -z "$1" ] || cp "$1" "$W/d/\${FENCE##*/}"; } && D="$W/d" awk ${q(`tolower($1) == "include" { for (i = 2; i <= NF; i++) if ($i == "${SSHD_DIR}/*.conf" || $i == "sshd_config.d/*.conf") $i = ENVIRON["D"] "/*.conf" } { print }`)} "$CONF" > "$W/main"; }`,
    `notInForceN() { t=$(sshd -T "$@" -C "user=$N,host=localhost,addr=127.0.0.1" 2>&1) || { echo "$t" | head -n 3; return; }; printf '%s\\n' "$t" | U="$N" WANT=${q(fenceWant(relayNodeFenceSettings()))} awk ${q(NOT_IN_FORCE_AWK)}; }`,
    `notInForceM() { t=$(sshd -T "$@" -C "user=$M,host=localhost,addr=127.0.0.1" 2>&1) || { echo "$t" | head -n 3; return; }; printf '%s\\n' "$t" | U="$M" WANT=${q(fenceWant(relayMasterFenceSettings()))} awk ${q(NOT_IN_FORCE_AWK)}; }`,
    'firstLines() { head -n 5 "$1" | tr "\\n" " "; }',
  ]
}

function applySteps(_f: RelayFacts, w: RelayWanted, carried: readonly RelayItem[]): RelayStep[] {
  const keysText = relayKeysCommand()
  const enrolText = relayEnrolScript()
  const masterKeysText = relayMasterKeysFile(w.masterKey, w.enrolKey)
  const fenceFileText = relayFenceFile()
  const fenceBlockText = relayFenceMarked()
  const hasCarried = (kind: RelayItem['kind']): boolean => carried.some(i => i.kind === kind)

  const usersHolds = ['ours "$N" "$N_COMMENT"', 'ours "$M" "$M_COMMENT"']
  const foldersHolds = [
    '[ -d "$SOCKETS" ] && [ ! -L "$SOCKETS" ] && [ "$(stat -c \'%a %U %G\' "$SOCKETS" 2>/dev/null)" = "2770 $N $M" ]',
    '[ -d "$KEYSDIR" ] && [ ! -L "$KEYSDIR" ] && [ "$(stat -c \'%a %U %G\' "$KEYSDIR" 2>/dev/null)" = "700 $M $M" ]',
  ]
  const scriptsHolds = [
    `${emit(keysText)} > "$W/keys.want"`,
    `${emit(enrolText)} > "$W/enrol.want"`,
    '[ -x "$KEYS_CMD" ] && [ ! -L "$KEYS_CMD" ] && cmp -s "$W/keys.want" "$KEYS_CMD"',
    '[ -x "$ENROL" ] && [ ! -L "$ENROL" ] && cmp -s "$W/enrol.want" "$ENROL"',
    '[ "$(SSH_ORIGINAL_COMMAND=check "$ENROL" 2>/dev/null)" = "@@ok 1" ]',
  ]
  const keysHolds = [
    `${emit(masterKeysText)} > "$W/mkeys.want"`,
    '[ -f "$MKEYS" ] && [ ! -L "$MKEYS" ] && cmp -s "$W/mkeys.want" "$MKEYS"',
  ]
  const fenceHolds = [
    `${emit(fenceFileText)} > "$W/fence"`,
    `${emit(fenceBlockText)} > "$W/fence.block"`,
    `if includes; then [ -f "$FENCE" ] && [ ! -L "$FENCE" ] && cmp -s "$W/fence" "$FENCE" && ! grep -qxF "$E0" "$CONF" 2>/dev/null; else [ ! -e "$FENCE" ] && [ ! -L "$FENCE" ] && grep -qxF "$E0" "$CONF" 2>/dev/null && B0="$B0" E0="$E0" awk ${q(BLOCK_EXTRACT_AWK)} "$CONF" | cmp -s - "$W/fence.block"; fi`,
    '[ -z "$(notInForceN)" ]',
    '[ -z "$(notInForceM)" ]',
  ]

  return [
    step('check', 'step', {
      commands: [
        '[ "$(id -u)" = 0 ] || { echo "this runs as root"; exit 1; }',
        `for c in ${LOOK_TOOLS.join(' ')} awk cmp; do command -v "$c" >/dev/null 2>&1 || { echo "$c is not on this server"; exit 1; }; done`,
        '[ -d /run/sshd ] || install -d -m 755 /run/sshd',
        'sshd -t 2>"$W/t" || { echo "sshd\'s config does not pass sshd -t as it is: $(firstLines "$W/t")"; exit 1; }',
        'whole || { echo "the relay block in $CONF is not whole: fix it by hand first"; exit 1; }',
        'if getent passwd "$N" >/dev/null && ! ours "$N" "$N_COMMENT"; then echo "a user $N is there that the board did not make"; exit 1; fi',
        'if getent passwd "$M" >/dev/null && ! ours "$M" "$M_COMMENT"; then echo "a user $M is there that the board did not make"; exit 1; fi',
        'for u in "$N" "$M"; do if ! getent passwd "$u" >/dev/null && getent group "$u" >/dev/null; then echo "a group $u is there without its user"; exit 1; fi; done',
        'for p in "$SOCKETS" "$KEYSDIR" "$KEYS_CMD" "$ENROL" "$MKEYS" "$FENCE"; do if [ -L "$p" ]; then echo "refusing symlink at $p"; exit 1; fi; done',
        ...(hasCarried('socketsDir')
          ? []
          : [
              'if [ -e "$SOCKETS" ]; then [ -d "$SOCKETS" ] && [ "$(stat -c \'%a %U %G\' "$SOCKETS" 2>/dev/null)" = "2770 $N $M" ] || { echo "$SOCKETS is there with other owner or permissions than the relay expects"; exit 1; }; fi',
            ]),
        ...(hasCarried('keysDir')
          ? []
          : [
              'if [ -e "$KEYSDIR" ]; then [ -d "$KEYSDIR" ] && [ "$(stat -c \'%a %U %G\' "$KEYSDIR" 2>/dev/null)" = "700 $M $M" ] || { echo "$KEYSDIR is there with other owner or permissions than the relay expects"; exit 1; }; fi',
            ]),
      ],
      changes: false,
    }),
    step('users', 'step', {
      skipIf: usersHolds,
      commands: [
        'if ! getent passwd "$N" >/dev/null; then useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --comment "$N_COMMENT" "$N"; touch "$W/made-n"; fi',
        'usermod -p "*" "$N"',
        'if ! getent passwd "$M" >/dev/null; then useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /bin/sh --comment "$M_COMMENT" "$M"; touch "$W/made-m"; fi',
        'usermod -p "*" "$M"',
      ],
      check: usersHolds,
      undo: [
        'if [ -f "$W/made-m" ] && ours "$M" "$M_COMMENT"; then userGone "$M"; fi',
        'if [ -f "$W/made-n" ] && ours "$N" "$N_COMMENT"; then userGone "$N"; fi',
      ],
      record: [
        { kind: 'user', name: RELAY_NODE_USER },
        { kind: 'user', name: RELAY_MASTER_USER },
      ],
    }),
    step('folders', 'step', {
      skipIf: foldersHolds,
      commands: [
        'if [ ! -e "$SOCKETS" ]; then install -d -m 2770 -o "$N" -g "$M" "$SOCKETS"; touch "$W/made-sockets"; else [ -d "$SOCKETS" ] && [ ! -L "$SOCKETS" ] || { echo "$SOCKETS is not a directory"; exit 1; }; stat -c "%a %U %G" "$SOCKETS" > "$W/sockets.old"; chown "$N:$M" "$SOCKETS" && chmod 2770 "$SOCKETS"; touch "$W/changed-sockets"; fi',
        'if [ ! -e "$KEYSDIR" ]; then install -d -m 700 -o "$M" -g "$M" "$KEYSDIR"; touch "$W/made-keysdir"; else [ -d "$KEYSDIR" ] && [ ! -L "$KEYSDIR" ] || { echo "$KEYSDIR is not a directory"; exit 1; }; stat -c "%a %U %G" "$KEYSDIR" > "$W/keysdir.old"; chown "$M:$M" "$KEYSDIR" && chmod 700 "$KEYSDIR"; touch "$W/changed-keysdir"; fi',
      ],
      check: foldersHolds,
      undo: [
        'if [ -f "$W/made-sockets" ]; then rm -rf "$SOCKETS"; elif [ -f "$W/changed-sockets" ] && [ -f "$W/sockets.old" ]; then read -r om ou og < "$W/sockets.old"; chown "$ou:$og" "$SOCKETS" 2>/dev/null || :; chmod "$om" "$SOCKETS" 2>/dev/null || :; fi',
        'if [ -f "$W/made-keysdir" ]; then rm -rf "$KEYSDIR"; elif [ -f "$W/changed-keysdir" ] && [ -f "$W/keysdir.old" ]; then read -r om ou og < "$W/keysdir.old"; chown "$ou:$og" "$KEYSDIR" 2>/dev/null || :; chmod "$om" "$KEYSDIR" 2>/dev/null || :; fi',
      ],
      record: [{ kind: 'socketsDir' }, { kind: 'keysDir' }],
    }),
    step('scripts', 'step', {
      skipIf: scriptsHolds,
      commands: [
        `${emit(keysText)} > "$W/keys.want"`,
        `${emit(enrolText)} > "$W/enrol.want"`,
        'sh -n "$W/keys.want" && sh -n "$W/enrol.want"',
        '[ -f "$KEYS_CMD" ] && cp -p "$KEYS_CMD" "$W/keys.old"',
        '[ -f "$ENROL" ] && cp -p "$ENROL" "$W/enrol.old"',
        'touch "$W/put-scripts"',
        'cp "$W/keys.want" "$KEYS_CMD.part" && chmod 755 "$KEYS_CMD.part" && chown root:root "$KEYS_CMD.part" && mv -f "$KEYS_CMD.part" "$KEYS_CMD"',
        'cp "$W/enrol.want" "$ENROL.part" && chmod 755 "$ENROL.part" && chown root:root "$ENROL.part" && mv -f "$ENROL.part" "$ENROL"',
      ],
      check: scriptsHolds,
      undo: [
        'rm -f "$KEYS_CMD.part" "$ENROL.part"',
        'if [ -f "$W/put-scripts" ]; then',
        '  if [ -f "$W/keys.old" ]; then restore "$W/keys.old" "$KEYS_CMD"; else rm -f "$KEYS_CMD"; fi',
        '  if [ -f "$W/enrol.old" ]; then restore "$W/enrol.old" "$ENROL"; else rm -f "$ENROL"; fi',
        'fi',
      ],
      record: [{ kind: 'keysCmd' }, { kind: 'enrol' }],
    }),
    step('keys', 'step', {
      skipIf: keysHolds,
      commands: [
        'if [ ! -d "$AUTHDIR" ]; then install -d -m 755 "$AUTHDIR"; touch "$W/made-authdir"; fi',
        '[ -f "$MKEYS" ] && cp -p "$MKEYS" "$W/mkeys.old"',
        'touch "$W/put-mkeys"',
        `${emit(masterKeysText)} > "$MKEYS.part"`,
        'chmod 644 "$MKEYS.part" && chown root:root "$MKEYS.part" && mv -f "$MKEYS.part" "$MKEYS"',
      ],
      check: keysHolds,
      undo: [
        'rm -f "$MKEYS.part"',
        'if [ -f "$W/put-mkeys" ]; then if [ -f "$W/mkeys.old" ]; then restore "$W/mkeys.old" "$MKEYS"; else rm -f "$MKEYS"; fi; fi',
        'if [ -f "$W/made-authdir" ]; then rmdir "$AUTHDIR" 2>/dev/null || :; fi',
      ],
      record: [{ kind: 'authKeysDir' }, { kind: 'masterKeys' }],
    }),
    step('fence', 'step', {
      skipIf: fenceHolds,
      commands: [
        '[ -d /run/sshd ] || install -d -m 755 /run/sshd',
        'admins > "$W/admins.before" || { echo "sshd -T does not answer for root or the admin"; exit 1; }',
        `${emit(fenceFileText)} > "$W/fence"`,
        `${emit(fenceBlockText)} > "$W/fence.block"`,
        'if includes; then',
        '  candidate "$W/fence" || { echo "could not copy sshd config"; exit 1; }',
        '  sshd -t -f "$W/main" 2>"$W/t" || { echo "sshd -t refuses the config with the relay fence: $(firstLines "$W/t")"; exit 1; }',
        '  bad=$(notInForceN -f "$W/main"); [ -z "$bad" ] || { echo "sshd fence for $N not in force: $(printf "%s" "$bad" | tr "\\n" ",")"; exit 1; }',
        '  bad=$(notInForceM -f "$W/main"); [ -z "$bad" ] || { echo "sshd fence for $M not in force: $(printf "%s" "$bad" | tr "\\n" ",")"; exit 1; }',
        '  [ -f "$FENCE" ] && cp -p "$FENCE" "$W/fence.old"',
        '  touch "$W/put-fence-file"',
        '  cp "$W/fence" "$FENCE.part" && chmod 644 "$FENCE.part" && mv -f "$FENCE.part" "$FENCE"',
        '  if grep -qxF "$E0" "$CONF" 2>/dev/null; then cp -p "$CONF" "$W/sshd.old"; touch "$W/put-fence-block"; strip "$CONF" > "$W/stripped"; putConf "$W/stripped"; fi',
        'else',
        '  cp -p "$CONF" "$W/sshd.old"',
        '  strip "$CONF" > "$W/stripped"',
        '  withBlock "$W/stripped" > "$W/main"',
        '  sshd -t -f "$W/main" 2>"$W/t" || { echo "sshd -t refuses the config with the relay fence: $(firstLines "$W/t")"; exit 1; }',
        '  bad=$(notInForceN -f "$W/main"); [ -z "$bad" ] || { echo "sshd fence for $N not in force: $(printf "%s" "$bad" | tr "\\n" ",")"; exit 1; }',
        '  bad=$(notInForceM -f "$W/main"); [ -z "$bad" ] || { echo "sshd fence for $M not in force: $(printf "%s" "$bad" | tr "\\n" ",")"; exit 1; }',
        '  touch "$W/put-fence-block"',
        '  putConf "$W/main"',
        '  if [ -f "$FENCE" ]; then cp -p "$FENCE" "$W/fence.old"; touch "$W/put-fence-file"; rm -f "$FENCE"; fi',
        'fi',
        'sshd -t 2>"$W/t" || { echo "sshd -t refuses the config with the relay fence in place: $(firstLines "$W/t")"; exit 1; }',
        'bad=$(notInForceN); [ -z "$bad" ] || { echo "sshd fence for $N is not in force: $(printf "%s" "$bad" | tr "\\n" ",")"; exit 1; }',
        'bad=$(notInForceM); [ -z "$bad" ] || { echo "sshd fence for $M is not in force: $(printf "%s" "$bad" | tr "\\n" ",")"; exit 1; }',
        'admins > "$W/admins.after" || { echo "sshd -T does not answer for root or the admin"; exit 1; }',
        'cmp -s "$W/admins.before" "$W/admins.after" || { echo "the relay fence would change sshd settings for root or the admin"; exit 1; }',
        'reload',
      ],
      check: fenceHolds,
      undo: [
        'rm -f "$FENCE.part"',
        'if [ -f "$W/put-fence-file" ]; then if [ -f "$W/fence.old" ]; then restore "$W/fence.old" "$FENCE"; else rm -f "$FENCE"; fi; fi',
        'if [ -f "$W/put-fence-block" ] && [ -f "$W/sshd.old" ]; then putConf "$W/sshd.old"; fi',
        'if [ -f "$W/put-fence-file" ] || [ -f "$W/put-fence-block" ]; then sshd -t && reload; fi',
      ],
      record: [{ kind: 'fence' }],
    }),
  ]
}

/**
 * The plan to set up the relay on the server, or why it cannot proceed.
 * Every step has a skip check so a second Apply changes nothing.
 */
export function relayPlan(f: RelayFacts, w: RelayWanted): { ok: true; plan: RelayPlan } | { ok: false; why: Text[] } {
  const problem = relayWantedProblem(w)
  if (problem) throw new Error(`not a value for a relay script: ${problem}`)
  const why = relayRefusals(f, w)
  if (why.length) return { ok: false, why }
  const rec = f.record === null ? null : relayRecord(f.record)
  const carried = rec?.items ?? []
  const words: Text[] = [
    ...(f.record !== null ? [{ key: 'relay.setup.already' }] : []),
    { key: 'relay.plan.users', params: { node: RELAY_NODE_USER, master: RELAY_MASTER_USER } },
    { key: 'relay.plan.folders', params: { sockets: RELAY_SOCKETS_DIR, keys: RELAY_KEYS_DIR } },
    { key: 'relay.plan.scripts', params: { keysCmd: RELAY_KEYS_CMD, enrol: RELAY_ENROL_SCRIPT } },
    f.include ? { key: 'relay.plan.fenceFile', params: { path: RELAY_FENCE } } : { key: 'relay.plan.fenceBlock' },
  ]
  return {
    ok: true,
    plan: {
      kind: 'apply',
      steps: applySteps(f, w, carried),
      carried,
      words,
      warnings: [],
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Undo

/**
 * Undo of what the record lists and nothing else: sshd fences out (checked on a copy, root/admin
 * settings unchanged, sshd reloaded), master keys, enrol & keys scripts, folders, and relay users.
 * Every step tolerates its target already being absent.
 */
export function relayUndoPlan(r: RelayRecord, o: { enrolled?: number } = {}): RelayPlan {
  const has = (kind: RelayItem['kind'], name?: string): RelayItem | undefined =>
    r.items.find(i => i.kind === kind && (name === undefined || (i.kind === 'user' && i.name === name)))
  const steps: RelayStep[] = [
    step('check', 'undo', {
      commands: [
        '[ "$(id -u)" = 0 ] || { echo "this runs as root"; exit 1; }',
        'for c in userdel sshd awk cmp; do command -v "$c" >/dev/null 2>&1 || { echo "$c is not on this server"; exit 1; }; done',
        ...(has('fence')
          ? [
              '[ -d /run/sshd ] || install -d -m 755 /run/sshd',
              'sshd -t 2>"$W/t" || { echo "sshd\'s config does not pass sshd -t as it is: $(firstLines "$W/t")"; exit 1; }',
              'whole || { echo "the relay block in $CONF is not whole: fix it by hand first"; exit 1; }',
            ]
          : []),
      ],
      changes: false,
    }),
  ]
  if (has('fence'))
    steps.push(
      step('fence', 'undo', {
        commands: [
          '[ -d /run/sshd ] || install -d -m 755 /run/sshd',
          'admins > "$W/admins.before" || { echo "sshd -T does not answer for root or the admin"; exit 1; }',
          'changed_file=0; changed_block=0',
          'if [ -f "$FENCE" ]; then',
          '  candidate "" || { echo "could not copy sshd config"; exit 1; }',
          '  sshd -t -f "$W/main" 2>"$W/t" || { echo "sshd -t refuses the config without the relay fence: $(firstLines "$W/t")"; exit 1; }',
          '  cp -p "$FENCE" "$W/fence.old" && rm -f "$FENCE" && changed_file=1',
          'fi',
          'if grep -qxF "$E0" "$CONF" 2>/dev/null; then',
          '  cp -p "$CONF" "$W/sshd.old"',
          '  strip "$CONF" > "$W/main"',
          '  sshd -t -f "$W/main" 2>"$W/t" || { echo "sshd -t refuses the config without the relay block: $(firstLines "$W/t")"; exit 1; }',
          '  putConf "$W/main" && changed_block=1',
          'fi',
          'putBack() { if [ "$changed_file" = 1 ]; then restore "$W/fence.old" "$FENCE"; fi; if [ "$changed_block" = 1 ]; then putConf "$W/sshd.old"; fi; }',
          'if [ "$changed_file" = 1 ] || [ "$changed_block" = 1 ]; then',
          '  if ! sshd -t 2>"$W/t"; then putBack; echo "sshd -t refuses the config without the relay fence: $(firstLines "$W/t")"; exit 1; fi',
          '  if ! admins > "$W/admins.after"; then putBack; echo "sshd -T does not answer for root or the admin"; exit 1; fi',
          '  if ! cmp -s "$W/admins.before" "$W/admins.after"; then putBack; echo "taking the relay fence out would change sshd settings for root or the admin"; exit 1; fi',
          '  if ! reload; then putBack; sshd -t && reload; echo "sshd did not reload"; exit 1; fi',
          'fi',
          'rm -f "$FENCE.part"',
        ],
        record: [{ kind: 'fence' }],
      }),
    )
  if (has('masterKeys') || has('authKeysDir'))
    steps.push(
      step('keys', 'undo', {
        commands: [
          ...(has('masterKeys') ? ['rm -f "$MKEYS" "$MKEYS.part"'] : []),
          ...(has('authKeysDir') ? ['rmdir "$AUTHDIR" 2>/dev/null || :'] : []),
        ],
        record: r.items.filter(i => i.kind === 'masterKeys' || i.kind === 'authKeysDir'),
      }),
    )
  if (has('keysCmd') || has('enrol'))
    steps.push(
      step('scripts', 'undo', {
        commands: [
          ...(has('keysCmd') ? ['rm -f "$KEYS_CMD" "$KEYS_CMD.part"'] : []),
          ...(has('enrol') ? ['rm -f "$ENROL" "$ENROL.part"'] : []),
        ],
        record: r.items.filter(i => i.kind === 'keysCmd' || i.kind === 'enrol'),
      }),
    )
  if (has('socketsDir') || has('keysDir'))
    steps.push(
      step('folders', 'undo', {
        commands: [
          ...(has('socketsDir') ? ['rm -rf "$SOCKETS"'] : []),
          ...(has('keysDir') ? ['rm -rf "$KEYSDIR"'] : []),
        ],
        record: r.items.filter(i => i.kind === 'socketsDir' || i.kind === 'keysDir'),
      }),
    )
  if (has('user', RELAY_NODE_USER) || has('user', RELAY_MASTER_USER))
    steps.push(
      step('users', 'undo', {
        commands: [
          ...(has('user', RELAY_NODE_USER)
            ? [
                'if getent passwd "$N" >/dev/null; then if ours "$N" "$N_COMMENT"; then userGone "$N"; else echo "@@warn a user $N is there that the board did not make: left as it is"; fi; fi',
              ]
            : []),
          ...(has('user', RELAY_MASTER_USER)
            ? [
                'if getent passwd "$M" >/dev/null; then if ours "$M" "$M_COMMENT"; then userGone "$M"; else echo "@@warn a user $M is there that the board did not make: left as it is"; fi; fi',
              ]
            : []),
        ],
        record: r.items.filter(i => i.kind === 'user'),
      }),
    )
  const enrolled = o.enrolled ?? 0
  return {
    kind: 'undo',
    steps,
    carried: r.items,
    words: [{ key: 'relay.undoPlan.removes', params: { list: r.items.map(itemWords).join(', ') } }],
    warnings: enrolled > 0 ? [{ key: 'relay.warn.enrolledStay', params: { n: String(enrolled) } }] : [],
  }
}

function itemWords(i: RelayItem): string {
  switch (i.kind) {
    case 'user':
      return `user ${i.name}`
    case 'socketsDir':
      return RELAY_SOCKETS_DIR
    case 'keysDir':
      return RELAY_KEYS_DIR
    case 'keysCmd':
      return RELAY_KEYS_CMD
    case 'enrol':
      return RELAY_ENROL_SCRIPT
    case 'authKeysDir':
      return AUTH_KEYS_DIR
    case 'masterKeys':
      return RELAY_MASTER_KEYS
    case 'fence':
      return RELAY_FENCE
  }
}

// ---------------------------------------------------------------------------------------------
// The run

const MARK = 'AGENT_BOARD_RELAY_END'

function verbatim(name: string, lines: readonly string[]): string[] {
  if (lines.includes(MARK)) throw new Error("a step holds the run's own marker")
  return [`${name}=$(cat <<'${MARK}'`, ...lines, MARK, ')']
}

/**
 * The one sh script a relay plan runs as, as root.
 * Holds flock on /run/agent-board-relay.lock, writes /etc/agent-board-relay/setup.json atomically,
 * rolls back every step on failure, and keeps the record untouched on a no-op re-Apply.
 */
export function relayRunScript(p: RelayPlan, run: { id: string; at: string }): string {
  if (!PLAIN_ID.test(run.id) || !STAMP.test(run.at)) throw new Error('not a plain run id or time')
  const undo = p.kind === 'undo'
  const vars = new Map<string, { name: string; carried: RelayItem | null }>()
  const varOf = (i: RelayItem) => {
    const key = itemKey(i)
    let v = vars.get(key)
    if (!v) {
      v = { name: `I${vars.size + 1}`, carried: null }
      vars.set(key, v)
    }
    return v
  }
  for (const i of p.carried) varOf(i).carried = i
  for (const s of p.steps) for (const i of s.record) varOf(i)
  const carriedWord = (i: RelayItem): string => {
    const v = varOf(i)
    return `${v.name}="$C${v.name}"`
  }
  const recordCond = (i: RelayItem): { absent: string; made: string } | null => {
    switch (i.kind) {
      case 'user':
        return i.name === RELAY_NODE_USER
          ? { absent: '! getent passwd "$N" >/dev/null', made: 'made-n' }
          : { absent: '! getent passwd "$M" >/dev/null', made: 'made-m' }
      case 'socketsDir':
        return { absent: '[ ! -e "$SOCKETS" ]', made: 'made-sockets' }
      case 'keysDir':
        return { absent: '[ ! -e "$KEYSDIR" ]', made: 'made-keysdir' }
      case 'authKeysDir':
        return { absent: '[ ! -d "$AUTHDIR" ]', made: 'made-authdir' }
      default:
        return null
    }
  }
  const head = `{"v":1,"run":${JSON.stringify(run.id)},"at":${JSON.stringify(run.at)},"state":"`
  const mid = '","items":['
  const names = [...vars.values()].map(v => `"$${v.name}"`)
  const out: string[] = [
    'exec </dev/null',
    `# agent-board: relay ${p.kind}`,
    'cd /',
    'set -u',
    'umask 022',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    'LC_ALL=C; export LC_ALL',
    "trap '' HUP PIPE",
    'STOP=0',
    "trap 'STOP=1' INT TERM",
    "command -v flock >/dev/null 2>&1 || { echo 'flock is not on this server: nothing was changed.'; echo '@@result unchanged'; exit 3; }",
    `exec 9>${q(RELAY_RUN_LOCK)}`,
    "flock -n 9 || { echo '@@result busy'; exit 75; }",
    "W=$(mktemp -d) || { echo '@@result unchanged'; exit 3; }",
    'chmod 700 "$W"; export W',
    'trap \'rm -rf "$W"\' EXIT',
    `ETC=${q(RELAY_ETC)}; REC=${q(RELAY_RECORD)}`,
    `N=${q(RELAY_NODE_USER)}; M=${q(RELAY_MASTER_USER)}`,
    `SOCKETS=${q(RELAY_SOCKETS_DIR)}; KEYSDIR=${q(RELAY_KEYS_DIR)}; AUTHDIR=${q(AUTH_KEYS_DIR)}`,
    "NL='",
    "'",
    ...verbatim('P', prelude()),
    ...(vars.size
      ? [
          [...vars.values()]
            .map(v => {
              const init = v.carried ? q(JSON.stringify(v.carried)) : "''"
              return `${v.name}=${init}; C${v.name}=${init}`
            })
            .join('; '),
        ]
      : []),
  ]
  p.steps.forEach((s, i) => {
    const k = i + 1
    out.push(...verbatim(`S${k}`, [...s.commands, ...s.check]))
    if (s.skipIf.length)
      out.push(
        ...verbatim(
          `K${k}`,
          s.skipIf.map(l => `${l} || exit 1`),
        ),
      )
    if (s.undo.length) out.push(...verbatim(`U${k}`, s.undo))
  })
  out.push(
    'rec() {',
    "  it=''",
    ...(names.length ? [`  for x in ${names.join(' ')}; do if [ -n "$x" ]; then it="$it,$x"; fi; done`] : []),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    `  printf '%s%s%s%s%s\\n' ${q(head)} "$1" ${q(mid)} "${'${it#,}'}" ']}' > "$REC.part" && chmod 644 "$REC.part" && mv -f "$REC.part" "$REC"`,
    '}',
    'skips() { timeout -k 5 60 sh -c "$P$NL$1" >/dev/null 2>&1 9>&-; }',
    'does() { timeout -k 5 "$1" sh -c "$P$NL$2" 2>&1 9>&-; }',
    'unchanged() { echo "$1: nothing was changed."; echo "@@result unchanged"; exit 3; }',
  )
  const guard = p.steps[0]
  if (!guard) throw new Error('a plan starts with its guard')
  out.push(
    `echo '@@step ${guard.id} start'`,
    `if does ${guard.timeoutS} "$S1"; then echo '@@step ${guard.id} ok'; else echo '@@step ${guard.id} fail'; echo '@@result unchanged'; exit 3; fi`,
  )
  if (!undo) {
    const backLines: string[] = []
    for (let i = p.steps.length - 1; i >= 1; i--) {
      const s = p.steps[i] as RelayStep
      if (!s.undo.length) continue
      const k = i + 1
      const reset = s.record.map(carriedWord)
      backLines.push(
        `  if [ "$D${k}" = 1 ]; then if does ${s.timeoutS} "$U${k}"; then echo '@@undo ${s.id} ok'; ${reset.length ? `${reset.join('; ')}; ` : ''}else echo '@@undo ${s.id} fail'; R=rollback-failed; fi; fi`,
      )
    }
    out.push(
      'MADE_ETC=0; CHANGED=0',
      p.steps.map((_, i) => `D${i + 1}=0`).join(' '),
      'back() {',
      '  R=rolled-back',
      ...backLines,
      '  if [ "$R" = rolled-back ]; then',
      '    if [ -f "$W/rec.old" ]; then',
      '      { cp -p "$W/rec.old" "$REC.part" && mv -f "$REC.part" "$REC"; } || R=rollback-failed',
      '    else',
      '      rm -f "$REC" "$REC.part"',
      '      if [ "$MADE_ETC" = 1 ]; then rmdir "$ETC" 2>/dev/null || :; fi',
      '    fi',
      '  fi',
      `  if [ "$R" = rollback-failed ]; then rec rollback-failed || echo "The record "${q(RELAY_RECORD)}" could not be written."; fi`,
      '  echo "@@result $R"',
      '  if [ "$R" = rolled-back ]; then exit 1; fi',
      '  exit 2',
      '}',
      'if [ ! -d "$ETC" ]; then install -d -m 755 "$ETC" || unchanged "$ETC could not be made"; MADE_ETC=1; fi',
      'if [ -f "$REC" ]; then cp -p "$REC" "$W/rec.old" || unchanged "The record could not be copied"; fi',
      `if ! rec running; then rm -f "$REC.part"; if [ "$MADE_ETC" = 1 ]; then rmdir "$ETC" 2>/dev/null || :; fi; unchanged "The record "${q(RELAY_RECORD)}" could not be written"; fi`,
    )
    p.steps.forEach((s, i) => {
      if (i === 0) return
      const k = i + 1
      const ahead = s.record.map(item => {
        const v = varOf(item)
        const c = recordCond(item)
        const val = q(JSON.stringify(item))
        return c ? `if [ -z "$${v.name}" ] && ${c.absent}; then ${v.name}=${val}; fi` : `${v.name}=${val}`
      })
      const post = s.record.flatMap(item => {
        const v = varOf(item)
        const c = recordCond(item)
        return c ? [`if [ -z "$C${v.name}" ] && [ ! -f "$W/${c.made}" ]; then ${v.name}=''; fi`] : []
      })
      out.push(
        `echo '@@step ${s.id} start'`,
        `if ${s.skipIf.length ? `skips "$K${k}"` : 'false'}; then echo '@@step ${s.id} skip'; else`,
        ...(ahead.length ? [`  ${ahead.join('; ')}`, '  rec running || back'] : []),
        `  D${k}=1${s.changes ? '; CHANGED=1' : ''}`,
        `  if does ${s.timeoutS} "$S${k}"; then echo '@@step ${s.id} ok'; else echo '@@step ${s.id} fail'; back; fi`,
        ...(post.length ? [`  ${post.join('; ')}`] : []),
        ...(ahead.length ? ['  rec running || back'] : []),
        'fi',
        'if [ "$STOP" = 1 ]; then echo "The run was told to stop: what it did is rolled back."; back; fi',
      )
    })
    out.push(
      'if [ "$CHANGED" = 0 ] && [ -f "$W/rec.old" ]; then { cp -p "$W/rec.old" "$REC.part" && mv -f "$REC.part" "$REC"; } || back; else rec applied || back; fi',
      "echo '@@result applied'",
      'exit 0',
    )
  } else {
    out.push(
      `if [ ! -f "$REC" ]; then echo '@@result none'; exit 0; fi`,
      `rec undoing || unchanged "The record "${q(RELAY_RECORD)}" could not be written"`,
    )
    p.steps.forEach((s, i) => {
      if (i === 0) return
      const k = i + 1
      const off = s.record.map(item => `${varOf(item).name}=''`)
      out.push(
        `echo '@@step ${s.id} start'`,
        `if does ${s.timeoutS} "$S${k}"; then echo '@@step ${s.id} ok'; else echo '@@step ${s.id} fail'; rec undo-failed; echo '@@result undo-failed'; exit 1; fi`,
        ...(off.length ? [off.join('; ')] : []),
        `rec undoing || { echo "The record "${q(RELAY_RECORD)}" could not be written."; echo '@@result undo-failed'; exit 1; }`,
        `if [ "$STOP" = 1 ]; then echo 'The run was told to stop.'; rec undo-failed; echo '@@result undo-failed'; exit 1; fi`,
      )
    })
    out.push('rm -f "$REC" "$REC.part"', 'rmdir "$ETC" 2>/dev/null || :', "echo '@@result undone'", 'exit 0')
  }
  out.push('')
  return out.join('\n')
}

// ---------------------------------------------------------------------------------------------
// What a run said

export type RelayRunResult =
  | 'busy'
  | 'applied'
  | 'rolled-back'
  | 'rollback-failed'
  | 'unchanged'
  | 'undone'
  | 'undo-failed'
  | 'none'

export interface RelayRun {
  result: RelayRunResult | null
  steps: { id: string; state: 'start' | 'skip' | 'ok' | 'fail' }[]
  undone: { id: string; ok: boolean }[]
  warnings: string[]
  said: string[]
}

const SAID_MOST = 200
const RESULTS: readonly RelayRunResult[] = [
  'busy',
  'applied',
  'rolled-back',
  'rollback-failed',
  'unchanged',
  'undone',
  'undo-failed',
  'none',
]

export function readRelayRun(lines: readonly string[]): RelayRun {
  const steps = new Map<string, RelayRun['steps'][number]['state']>()
  const undone: RelayRun['undone'] = []
  const warnings: string[] = []
  const said: string[] = []
  let result: RelayRunResult | null = null
  for (const line of lines) {
    const [tag, a = '', b = ''] = line.split(' ')
    if (tag === '@@step' && (b === 'start' || b === 'skip' || b === 'ok' || b === 'fail')) steps.set(a, b)
    else if (tag === '@@undo') undone.push({ id: a, ok: b === 'ok' })
    else if (tag === '@@result' && RESULTS.includes(a as RelayRunResult)) result = a as RelayRunResult
    else if (tag === '@@warn') warnings.push(line.slice(7))
    else if (!line.startsWith('@@') && line.trim()) said.push(line)
  }
  return {
    result,
    steps: [...steps].map(([id, state]) => ({ id, state })),
    undone,
    warnings,
    said: said.slice(-SAID_MOST),
  }
}

/**
 * Manual fallback script to run on the server as root when admin SSH is not used.
 */
export function doItMyself(
  w: RelayWanted,
  run: { id: string; at: string } = { id: 'manual', at: '1970-01-01T00:00:00Z' },
): { file: string; script: string; run: string } {
  const dummyFacts: RelayFacts = {
    os: { id: 'debian', version: '13', pretty: 'Debian' },
    ssh: '',
    hostname: 'relay',
    sudo: 'root',
    has: [...LOOK_TOOLS],
    nodeUser: 'none',
    masterUser: 'none',
    socketsDir: 'none',
    keysDir: 'none',
    authKeysDir: false,
    keysCmd: 'none',
    enrol: 'none',
    masterKeys: 'none',
    fence: 'none',
    blockTorn: false,
    include: true,
    sshdNow: 'ok',
    candidate: 'ok',
    busy: false,
    record: null,
    recordTorn: false,
    enrolled: 0,
  }
  const built = relayPlan(dummyFacts, w)
  if (!built.ok) throw new Error('could not build manual relay plan')
  const file = 'agent-board-relay-setup.sh'
  return { file, script: relayRunScript(built.plan, run), run: `sudo sh ${file}` }
}

export { isPlainPath, relayFenceBlock }
