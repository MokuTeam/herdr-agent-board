// A server becomes a node (#509, design docs/design/nodes/README.md 11.1): what Look reads there,
// the plan Apply runs (each step with its skip check, commands, check and undo, and what it puts on
// the record), the record /etc/agent-board-node/setup.json and the Undo it gives, and the one sh
// script a plan runs as. The steps are what T0 did by hand on a real Ubuntu 24.04 (2026-11-21): the
// node's login user and its slice's ceiling, lingering, Bun, herdr and Claude Code for that user,
// the plugin from the archive the master sent, config.json's `node` and masters.json, the board's
// install, herdr's user unit, the link user fenced in sshd to one forward, and the door's hello.
//
// Made after the backup drop (core/backup-server.ts) and "Set up the server" (core/server-plan.ts),
// with what #166 found in the latter's runner left out: every file is written beside itself and
// renamed over (a kill leaves the old file or the new one, never half), and the record is written
// before a step with what the step is about to make, so an Undo after a run cut short finds it.
// Whatever lands in the node user's home is written by that user (runuser), never by root, so a
// link planted there cannot turn a root write into a write elsewhere. Nothing in a script is a
// secret: the master's token crosses as its hash only, and no password reaches any script. Pure,
// with no node: import. Nothing calls it yet: the service over the admin's ssh comes after T3.

import {
  BUN_BIN,
  BUN_INSTALLER,
  BUN_VERSION,
  type Ceiling,
  CLAUDE_BIN,
  CLAUDE_INSTALLER,
  CONFIG_PATH,
  HERDR_BIN,
  HERDR_INSTALLER,
  HERDR_MIN,
  herdrUnit,
  KEYS_DIR,
  LINK_COMMENT,
  LINK_FENCE,
  LINK_KEYS,
  LINK_USER,
  linkFence,
  linkFenceSettings,
  linkKeysLine,
  MASTERS_PATH,
  NODE_COMMENT,
  NODE_ETC,
  NODE_HOME,
  NODE_PACKAGES,
  NODE_RECORD,
  NODE_USER,
  PLUGIN_DIR,
  PLUGIN_STAMP,
  PROFILE_BEGIN,
  PROFILE_END,
  PROFILE_PATH,
  profileBlock,
  sliceDropIn,
  slicePath,
  UNIT_PATH,
  WORK_DIR,
} from './node-texts.ts'
import { DEVICE_ID, LOCAL } from './nodes.ts'
import { SUPPORTED } from './server-look.ts'
import type { Text } from './server-plan.ts'
import { isPlainPath, shQuote } from './server-shell.ts'
import { SSHD_RELOAD } from './tunnel-snippets.ts'

export type { Ceiling } from './node-texts.ts'

const q = shQuote
const SSHD_CONFIG = '/etc/ssh/sshd_config'
const SSHD_DIR = '/etc/ssh/sshd_config.d'
/** The board's own ports on the node (wake, the web board): the door cannot take either. */
const NODE_BOARD_PORTS = [12421, 12422]
/** The smallest ceiling the plan sets, in MB: below it the server is too small for a node. */
export const MIN_MEMORY_MAX_MB = 1500
/** The free disk under /home a node needs at least, in MB: Bun, herdr, Claude Code, the plugin, and room to work. */
export const MIN_HOME_FREE_MB = 3072
/** The machines Bun, herdr and Claude Code are built for. */
const ARCHES = ['x86_64', 'aarch64']
/** Held by a run while it goes: a second Apply or an Undo meanwhile says busy and changes nothing. */
export const RUN_LOCK = '/run/agent-board-node.lock'
/** How long the last step waits for the node's board to answer its hello, by default. */
export const HELLO_WAIT_S = 120

// ---------------------------------------------------------------------------------------------
// Look

export type UserState = 'none' | 'ours' | 'other' | 'group'
export type Presence = 'none' | 'same' | 'other'
/** What Look reads on the server, as the admin, changing nothing. */
export interface NodeFacts {
  os: { id: string; version: string; pretty: string }
  arch: string
  cpus: number
  memTotalMb: number
  memAvailableMb: number
  swapTotalMb: number
  /** Free disk where the node user's home goes; null when df did not say. */
  homeFreeMb: number | null
  systemd: boolean
  /** How the admin gets root: is root, sudo without a password, sudo with one, or not at all. */
  sudo: 'root' | 'nopasswd' | 'password' | 'none'
  /** Of curl, git, unzip, tar, runuser, loginctl, useradd: the ones on the server. */
  has: string[]
  user: UserState
  linkUser: UserState
  /** The slice drop-in for the node user's uid, the unit in its home, lingering. */
  slice: boolean
  unit: boolean
  linger: boolean
  /** /etc/ssh/authorized_keys is there. */
  keysDir: boolean
  /** The link user's keys file and sshd's fence against what this plan writes. */
  keys: Presence
  fence: Presence
  /** sshd_config includes sshd_config.d/*.conf before any Match line. */
  include: boolean
  /** `sshd -t` now: 'ok', or the first lines of what it said. */
  sshdNow: string
  /** /home/agent-board is there without its user (an Undo kept ~/work): Apply would not own it. */
  homeLeft: boolean
  /** A run of the board's holds the lock now. */
  busy: boolean
  /** The archive's sha256 the node's plugin was unpacked from; null: none. */
  plugin: string | null
  /** The record's JSON as it is on the server; null: none. */
  record: unknown
  /** A record is there that does not parse. */
  recordTorn: boolean
  /** What listens on TCP, by port and program; null when ss is not there. */
  listening: { port: number; name: string }[] | null
  /** The node user's Bun, herdr and Claude Code versions; null: not there (or the user is not). */
  bun: string | null
  herdr: string | null
  claude: string | null
  /** A Bun on the server's own PATH, owned by root: copied for the node user when it is new enough. */
  serverBun: { path: string; version: string } | null
}

export interface NodeLookInput {
  port: number
  /** The master's link key: Look says whether the keys file holds exactly its line. */
  linkKey?: string
}

const LOOK_TOOLS = ['curl', 'git', 'unzip', 'tar', 'runuser', 'loginctl', 'useradd']
/** sshd_config includes sshd_config.d/*.conf before any Match: the fence goes in a drop-in. */
const INCLUDES_AWK = `tolower($1) == "match" { exit } tolower($1) == "include" { for (i = 2; i <= NF; i++) if ($i == "${SSHD_DIR}/*.conf" || $i == "sshd_config.d/*.conf") f = 1 } END { exit !f }`
/** A program's version from its --version line. */
const VER_AWK = 'match($0, /[0-9]+\\.[0-9]+\\.[0-9]+/) { print substr($0, RSTART, RLENGTH); exit }'
/** `ss -Htlnp`: one `@@listen <port> <program>` a line. */
const LISTEN_AWK =
  '{ a = $4; sub(/.*:/, "", a); n = "?"; if (match($0, /users:[(][(]"[^"]*"/)) n = substr($0, RSTART + 9, RLENGTH - 10); print "@@listen " a " " n }'

/** printf of a text's lines, one shell word each: what a step compares with or writes. */
const emit = (text: string): string =>
  `printf '%s\\n' ${text
    .replace(/\n$/, '')
    .split('\n')
    .map(l => q(l))
    .join(' ')}`

/**
 * Look, as the admin, read only: the system and its version, the machine, memory and swap, the
 * disk under /home, systemd, how the admin gets root, the tools, both users, the slice drop-in, the
 * unit, lingering, the keys file, sshd's fence and whether sshd includes drop-ins, `sshd -t`, the
 * record, what listens, and the node user's Bun, herdr and Claude Code (run as that user, never as
 * root). One `@@` line each, `@@end` last.
 */
export function nodeLookScript(i: NodeLookInput): string {
  if (!Number.isInteger(i.port)) throw new Error('not a port')
  const user = (name: string, comment: string, key: string): string =>
    `if p=$(getent passwd ${q(name)}); then if [ "$(printf '%s\\n' "$p" | cut -d: -f5)" = ${q(comment)} ]; then echo "@@${key} ours"; else echo "@@${key} other"; fi; elif getent group ${q(name)} >/dev/null; then echo "@@${key} group"; else echo "@@${key} none"; fi`
  const tool = (bin: string, key: string): string =>
    `if [ "$(id -u)" = 0 ] && [ -n "$uid" ] && [ -x ${q(bin)} ]; then echo "@@${key} $(runuser -u ${q(NODE_USER)} -- ${q(bin)} --version 2>/dev/null | awk ${q(VER_AWK)})"; fi`
  return [
    'exec </dev/null',
    '# agent-board: node look',
    'cd /',
    'set -u',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    'LC_ALL=C; export LC_ALL',
    'W=$(mktemp -d) || { echo "@@fail could not make a temp folder"; exit 1; }',
    `trap 'rm -rf "$W"' EXIT`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    'if [ -r /etc/os-release ]; then ( . /etc/os-release; echo "@@os ${ID:-} ${VERSION_ID:-}"; echo "@@pretty ${PRETTY_NAME:-}" ); fi',
    'echo "@@arch $(uname -m)"',
    'echo "@@cpus $(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)"',
    `awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } /^SwapTotal:/ { s = $2 } END { printf "@@mem %d %d %d\\n", t / 1024, a / 1024, s / 1024 }' /proc/meminfo`,
    `echo "@@home-free $(df -Pk ${q(NODE_HOME.slice(0, NODE_HOME.lastIndexOf('/')))} 2>/dev/null | awk 'NR == 2 { print int($4 / 1024) }')"`,
    'if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then echo "@@systemd yes"; else echo "@@systemd no"; fi',
    'if [ "$(id -u)" = 0 ]; then echo "@@sudo root"; elif ! command -v sudo >/dev/null 2>&1; then echo "@@sudo none"; elif sudo -n true 2>/dev/null; then echo "@@sudo nopasswd"; else echo "@@sudo password"; fi',
    `for c in ${LOOK_TOOLS.join(' ')}; do if command -v "$c" >/dev/null 2>&1; then echo "@@has $c"; fi; done`,
    user(NODE_USER, NODE_COMMENT, 'user'),
    user(LINK_USER, LINK_COMMENT, 'link-user'),
    `uid=$(getent passwd ${q(NODE_USER)} | cut -d: -f3)`,
    `if [ -z "$uid" ] && [ -e ${q(NODE_HOME)} ]; then echo '@@home left'; fi`,
    `if [ "$(id -u)" = 0 ] && [ -n "$uid" ] && [ -f ${q(PLUGIN_STAMP)} ]; then echo "@@plugin $(runuser -u ${q(NODE_USER)} -- cat ${q(PLUGIN_STAMP)} 2>/dev/null)"; fi`,
    `if [ -e ${q(RUN_LOCK)} ] && command -v flock >/dev/null 2>&1 && ! flock -n ${q(RUN_LOCK)} true; then echo '@@busy'; fi`,
    `if [ -n "$uid" ] && [ -f "${slicePath('$uid')}" ]; then echo "@@slice yes"; else echo "@@slice no"; fi`,
    `if [ -f ${q(UNIT_PATH)} ]; then echo "@@unit yes"; else echo "@@unit no"; fi`,
    `if [ -f /var/lib/systemd/linger/${NODE_USER} ]; then echo "@@linger yes"; else echo "@@linger no"; fi`,
    `if [ -d ${q(KEYS_DIR)} ]; then echo "@@keys-dir yes"; else echo "@@keys-dir no"; fi`,
    i.linkKey === undefined
      ? `if [ -f ${q(LINK_KEYS)} ]; then echo "@@keys other"; else echo "@@keys none"; fi`
      : `if [ ! -f ${q(LINK_KEYS)} ]; then echo "@@keys none"; elif [ "$(cat ${q(LINK_KEYS)})" = ${q(linkKeysLine(i.linkKey, i.port))} ]; then echo "@@keys same"; else echo "@@keys other"; fi`,
    `${emit(linkFence(i.port))} > "$W/fence"`,
    `if [ ! -f ${q(LINK_FENCE)} ]; then echo "@@fence none"; elif cmp -s "$W/fence" ${q(LINK_FENCE)}; then echo "@@fence same"; else echo "@@fence other"; fi`,
    `if [ -d ${q(SSHD_DIR)} ] && awk ${q(INCLUDES_AWK)} ${q(SSHD_CONFIG)} 2>/dev/null; then echo "@@include yes"; else echo "@@include no"; fi`,
    `if sshd -t 2>"$W/t"; then echo "@@sshd-t ok"; else echo "@@sshd-t $(head -n 3 "$W/t" | tr '\\n' ' ')"; fi`,
    `if [ -f ${q(NODE_RECORD)} ]; then echo "@@record $(tr -d '\\n' < ${q(NODE_RECORD)})"; fi`,
    `if command -v ss >/dev/null 2>&1; then ss -Htlnp 2>/dev/null | awk ${q(LISTEN_AWK)}; else echo "@@listen-unknown"; fi`,
    tool(BUN_BIN, 'bun'),
    tool(HERDR_BIN, 'herdr'),
    tool(CLAUDE_BIN, 'claude'),
    `if b=$(command -v bun) && [ "$(stat -c %u "$b" 2>/dev/null)" = 0 ]; then echo "@@server-bun $("$b" --version 2>/dev/null | awk ${q(VER_AWK)}) $b"; fi`,
    'echo "@@end"',
    '',
  ].join('\n')
}

const VERSION = /^\d+\.\d+\.\d+$/
/** a is at least b, both x.y.z. */
export function atLeast(a: string | null, b: string): boolean {
  if (!a || !VERSION.test(a)) return false
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] as number) !== (y[i] as number)) return (x[i] as number) > (y[i] as number)
  return true
}

/** Look's lines read; null when the script did not get to its end. */
export function readNodeLook(lines: readonly string[]): NodeFacts | null {
  if (!lines.includes('@@end')) return null
  const said = (key: string): string | undefined =>
    lines.find(l => l === `@@${key}` || l.startsWith(`@@${key} `))?.slice(key.length + 3)
  const one = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = said(key)?.trim() as T | undefined
    return v && allowed.includes(v) ? v : fallback
  }
  const yes = (key: string): boolean => said(key)?.trim() === 'yes'
  const num = (s: string | undefined): number => {
    const n = Number(s)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  }
  const version = (key: string): string | null => {
    const v = said(key)?.trim()
    return v && VERSION.test(v) ? v : null
  }
  const [osId = '', osVersion = ''] = (said('os') ?? '').trim().split(/\s+/)
  const [total, available, swap] = (said('mem') ?? '').trim().split(/\s+/)
  const home = said('home-free')?.trim()
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
  const listening = lines.includes('@@listen-unknown')
    ? null
    : lines
        .filter(l => l.startsWith('@@listen '))
        .map(l => {
          const [, port = '', name = '?'] = l.split(' ')
          return { port: Number(port), name }
        })
        .filter(x => Number.isInteger(x.port) && x.port > 0)
  const sb = said('server-bun')?.trim().split(' ')
  const serverBun =
    sb && sb.length === 2 && VERSION.test(sb[0] as string) && isPlainPath(sb[1] as string)
      ? { version: sb[0] as string, path: sb[1] as string }
      : null
  return {
    os: { id: osId, version: osVersion, pretty: said('pretty')?.trim() ?? '' },
    arch: said('arch')?.trim() ?? '',
    cpus: num(said('cpus')),
    memTotalMb: num(total),
    memAvailableMb: num(available),
    swapTotalMb: num(swap),
    homeFreeMb: home ? num(home) : null,
    systemd: yes('systemd'),
    sudo: one('sudo', ['root', 'nopasswd', 'password', 'none'], 'none'),
    has: LOOK_TOOLS.filter(t => lines.includes(`@@has ${t}`)),
    user: one('user', ['none', 'ours', 'other', 'group'], 'other'),
    linkUser: one('link-user', ['none', 'ours', 'other', 'group'], 'other'),
    slice: yes('slice'),
    unit: yes('unit'),
    linger: yes('linger'),
    keysDir: yes('keys-dir'),
    keys: one('keys', ['none', 'same', 'other'], 'other'),
    fence: one('fence', ['none', 'same', 'other'], 'other'),
    include: yes('include'),
    sshdNow: said('sshd-t')?.trim() ?? '',
    homeLeft: said('home')?.trim() === 'left',
    busy: lines.includes('@@busy'),
    plugin: /^[0-9a-f]{64}$/.test(said('plugin')?.trim() ?? '') ? (said('plugin')?.trim() as string) : null,
    record,
    recordTorn,
    listening,
    bun: version('bun'),
    herdr: version('herdr'),
    claude: version('claude'),
    serverBun,
  }
}

// ---------------------------------------------------------------------------------------------
// The ceiling

/**
 * The ceiling Look's memory gives: MemoryMax the smaller of 60 percent of the memory and what is
 * available now less 1 GB, MemoryHigh 80 percent of that, 512 MB of swap, half the CPU weight of
 * other slices, 3000 tasks. null: under 1500 MB, the server is too small for a node.
 */
export function ceilingFor(f: Pick<NodeFacts, 'memTotalMb' | 'memAvailableMb'>): Ceiling | null {
  const max = Math.min(Math.floor(f.memTotalMb * 0.6), f.memAvailableMb - 1024)
  if (max < MIN_MEMORY_MAX_MB) return null
  return { memoryMaxMb: max, memoryHighMb: Math.floor(max * 0.8), swapMaxMb: 512, cpuWeight: 50, tasksMax: 3000 }
}

/** The figures the owner left or changed, checked: the first that does not hold, as a text. */
export function ceilingProblem(c: Ceiling, f: Pick<NodeFacts, 'memTotalMb'>): Text | null {
  const whole = (n: unknown, lo: number, hi: number): boolean =>
    Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi
  if (!whole(c.memoryMaxMb, MIN_MEMORY_MAX_MB, Math.max(MIN_MEMORY_MAX_MB, f.memTotalMb)))
    return { key: 'node.refuse.memoryMax', params: { min: String(MIN_MEMORY_MAX_MB), total: String(f.memTotalMb) } }
  if (!whole(c.memoryHighMb, 256, c.memoryMaxMb))
    return { key: 'node.refuse.memoryHigh', params: { max: String(c.memoryMaxMb) } }
  if (!whole(c.swapMaxMb, 0, 65536)) return { key: 'node.refuse.swapMax' }
  if (!whole(c.cpuWeight, 1, 10000)) return { key: 'node.refuse.cpuWeight' }
  if (!whole(c.tasksMax, 512, 4194304)) return { key: 'node.refuse.tasksMax' }
  return null
}

// ---------------------------------------------------------------------------------------------
// What the panel wants

/** What Apply is given: the node's id and door, the master's link key and token hash, the plugin's archive on the server, the ceiling. */
export interface NodeWanted {
  id: string
  port: number
  /** The public half of the master's link key for this node. */
  linkKey: string
  /** masters.json's entry: only the token's SHA-256 crosses, never the token. */
  master: { id: string; name: string; tokenHash: string }
  /** Where the master put the plugin's tar archive on the server, and its sha256. */
  plugin: { path: string; sha256: string }
  /** As ceilingFor proposed it, or as the owner changed it. */
  ceiling: Ceiling
  /** The packages tick: git, curl, unzip and ca-certificates with apt. */
  packages: boolean
}

const PUBLIC_KEY = /^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}( [ !#-~]{0,200})?$/
const HEX64 = /^[0-9a-f]{64}$/
const ARCHIVE_PATH = /^\/[A-Za-z0-9._/-]{1,255}$/
const hasControl = (s: string): boolean => [...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)

/** Why the values cannot reach a script; null when they can. They are checked before any script is made from them. */
export function nodeWantedProblem(w: NodeWanted): string | null {
  if (!DEVICE_ID.test(w.id) || w.id === LOCAL) return 'id'
  if (!Number.isInteger(w.port) || w.port < 1024 || w.port > 65535 || NODE_BOARD_PORTS.includes(w.port)) return 'port'
  if (!PUBLIC_KEY.test(w.linkKey.trim())) return 'linkKey'
  if (!DEVICE_ID.test(w.master.id) || w.master.id === LOCAL) return 'master.id'
  const name = w.master.name
  if (typeof name !== 'string' || name.trim() !== name || name.length === 0 || name.length > 64 || hasControl(name))
    return 'master.name'
  if (!HEX64.test(w.master.tokenHash)) return 'master.tokenHash'
  if (!ARCHIVE_PATH.test(w.plugin.path) || !isPlainPath(w.plugin.path)) return 'plugin.path'
  if (!HEX64.test(w.plugin.sha256)) return 'plugin.sha256'
  return null
}

// ---------------------------------------------------------------------------------------------
// The record

export type RecordState = 'running' | 'applied' | 'rollback-failed' | 'undoing' | 'undo-failed'
/** One thing a run of the board made on the server. Each kind names a fixed path, so a record cannot point Undo anywhere else. */
export type NodeItem =
  | { kind: 'user'; name: typeof NODE_USER | typeof LINK_USER }
  | { kind: 'linger' }
  | { kind: 'slice'; uid: number }
  | { kind: 'unit' }
  | { kind: 'keysdir' }
  | { kind: 'keys' }
  | { kind: 'fence' }
/** /etc/agent-board-node/setup.json: what the board's runs made, written as they go. */
export interface NodeRecord {
  v: 1
  run: string
  at: string
  state: RecordState
  node: { id: string; port: number }
  items: NodeItem[]
}

const STATES: readonly RecordState[] = ['running', 'applied', 'rollback-failed', 'undoing', 'undo-failed']
const PLAIN_ID = /^[A-Za-z0-9._-]{1,64}$/
const STAMP = /^[0-9TZ:.+-]{1,40}$/
const isFields = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const itemKey = (i: NodeItem): string => (i.kind === 'user' ? `user ${i.name}` : i.kind)

function nodeItem(v: unknown): NodeItem | null {
  if (!isFields(v)) return null
  switch (v.kind) {
    case 'user':
      return v.name === NODE_USER || v.name === LINK_USER ? { kind: 'user', name: v.name } : null
    case 'slice':
      return Number.isInteger(v.uid) && (v.uid as number) > 0 ? { kind: 'slice', uid: v.uid as number } : null
    case 'linger':
    case 'unit':
    case 'keysdir':
    case 'keys':
    case 'fence':
      return { kind: v.kind }
    default:
      return null
  }
}

/** The record read; null when it is not one of the board's. An item it does not know is left out, so Undo never acts on it. */
export function nodeRecord(json: unknown): NodeRecord | null {
  if (!isFields(json) || json.v !== 1) return null
  const { run, at, state, node, items } = json
  if (typeof run !== 'string' || !PLAIN_ID.test(run) || typeof at !== 'string' || !STAMP.test(at)) return null
  if (!STATES.includes(state as RecordState) || !isFields(node) || !Array.isArray(items)) return null
  if (typeof node.id !== 'string' || !DEVICE_ID.test(node.id) || !Number.isInteger(node.port)) return null
  const seen = new Map<string, NodeItem>()
  for (const raw of items) {
    const item = nodeItem(raw)
    if (item) seen.set(itemKey(item), item)
  }
  return {
    v: 1,
    run,
    at,
    state: state as RecordState,
    node: { id: node.id, port: node.port as number },
    items: [...seen.values()],
  }
}

// ---------------------------------------------------------------------------------------------
// Whether Apply may go on

const needsBunInstall = (f: NodeFacts): boolean =>
  !atLeast(f.bun, BUN_VERSION) && !(f.serverBun && atLeast(f.serverBun.version, BUN_VERSION))

/**
 * Why the board does not make this server a node, in words; empty when it may. Each reason stops
 * Apply before it changes anything: a system or a machine the node is not built for, no systemd,
 * no way to root, a server too small, a user of the board's names it did not make, sshd that reads
 * no drop-ins or does not pass `sshd -t`, the door's port held by another program, a run of the
 * board's that did not finish, or a node of another id already there.
 */
export function nodeRefusals(f: NodeFacts, w: NodeWanted): Text[] {
  const out: Text[] = []
  const say = (key: string, params?: Record<string, string>): void => void out.push(params ? { key, params } : { key })
  const supported = (SUPPORTED as Record<string, string[] | undefined>)[f.os.id]
  if (!supported?.includes(f.os.version))
    say('node.refuse.os', { os: f.os.pretty || `${f.os.id} ${f.os.version}`.trim() || '?' })
  if (!ARCHES.includes(f.arch)) say('node.refuse.arch', { arch: f.arch || '?' })
  if (!f.systemd) say('node.refuse.systemd')
  if (f.sudo === 'none') say('node.refuse.sudo')
  for (const tool of ['runuser', 'loginctl', 'useradd', 'tar'])
    if (!f.has.includes(tool)) say('node.refuse.tool', { tool })
  if (!f.has.includes('curl') && !w.packages) say('node.refuse.curl')
  if (needsBunInstall(f) && !f.has.includes('unzip') && !w.packages) say('node.refuse.unzip')
  if (!ceilingFor(f))
    say('node.refuse.small', {
      total: String(f.memTotalMb),
      available: String(f.memAvailableMb),
      min: String(MIN_MEMORY_MAX_MB),
    })
  else {
    const problem = ceilingProblem(w.ceiling, f)
    if (problem) out.push(problem)
  }
  if (f.homeFreeMb !== null && f.homeFreeMb < MIN_HOME_FREE_MB)
    say('node.refuse.disk', { free: String(f.homeFreeMb), min: String(MIN_HOME_FREE_MB) })
  for (const [state, name] of [
    [f.user, NODE_USER],
    [f.linkUser, LINK_USER],
  ] as const) {
    if (state === 'other') say('node.refuse.userOther', { user: name })
    if (state === 'group') say('node.refuse.userGroup', { user: name })
  }
  if (f.user === 'none' && f.homeLeft) say('node.refuse.homeLeft', { path: NODE_HOME })
  if (f.busy) say('node.refuse.busy')
  if (!f.include) say('node.refuse.include')
  if (f.sshdNow !== 'ok') say('node.refuse.sshd', { said: f.sshdNow || '?' })
  const rec = f.record === null ? null : nodeRecord(f.record)
  if (f.recordTorn || (f.record !== null && !rec)) say('node.refuse.record', { path: NODE_RECORD })
  if (rec && rec.state !== 'applied') say('node.refuse.interrupted')
  if (rec && rec.node.id !== w.id) say('node.refuse.otherNode', { id: rec.node.id })
  const has = (kind: NodeItem['kind']): boolean => !!rec?.items.some(i => i.kind === kind)
  if (f.keys === 'other' && !has('keys')) say('node.refuse.keysOther', { path: LINK_KEYS })
  if (f.fence === 'other' && !has('fence')) say('node.refuse.fenceOther', { path: LINK_FENCE })
  const holder = f.listening?.find(l => l.port === w.port)
  // the node's own board holds the door's port once a run of the board's set it up
  if (holder && !(rec && rec.node.port === w.port && has('unit')))
    say('node.refuse.port', { port: String(w.port), name: holder.name })
  return out
}

// ---------------------------------------------------------------------------------------------
// The steps

/**
 * One step. `skipIf`: lines that all succeed when what the step makes is in place already (a second
 * Apply skips it). `commands` then `check`, under `set -e`. `undo` puts back what this run's
 * `commands` changed (markers in the run's temp folder say what that was); it runs when the step or
 * a later one fails. `record`: what the step makes, on the record before it runs; in Undo, what it
 * takes off. `changes`: false for a step that only looks (the hello).
 */
export interface NodeStep {
  id: string
  title: Text
  why: Text
  skipIf: string[]
  commands: string[]
  check: string[]
  undo: string[]
  record: NodeItem[]
  timeoutS: number
  changes: boolean
}

export interface NodePlan {
  kind: 'apply' | 'undo'
  node: { id: string; port: number }
  steps: NodeStep[]
  /** The record's items from earlier runs, kept on the record this run writes. */
  carried: NodeItem[]
  ceiling: Ceiling | null
  /** The plan in plain words, for the panel. */
  words: Text[]
  warnings: Text[]
}

const step = (id: string, kind: 'step' | 'undo', parts: Partial<NodeStep>): NodeStep => ({
  id,
  title: { key: `node.${kind}.${id}` },
  why: { key: `node.${kind}Why.${id}` },
  skipIf: [],
  commands: [],
  check: [],
  undo: [],
  record: [],
  timeoutS: 60,
  changes: true,
  ...parts,
})

/** config.json gets `node: { id, port }` merged in; one that does not parse is left as it is (exit 3). NODE_MODE=check: exit 0 when it holds that already. */
const MERGE_CONFIG =
  'const fs=require("fs"),e=process.env,t=fs.readFileSync(0,"utf8");let c={};if(t.trim()){try{c=JSON.parse(t)}catch{console.error("config.json does not parse: it is left as it is");process.exit(3)}}if(typeof c!=="object"||c===null||Array.isArray(c)){console.error("config.json is not an object: it is left as it is");process.exit(3)}const n=typeof c.node==="object"&&c.node!==null&&!Array.isArray(c.node)?c.node:{};c.node={...n,id:e.NODE_ID,port:Number(e.NODE_PORT)};const o=JSON.stringify(c,null,2)+"\\n";if(e.NODE_MODE==="check")process.exit(o===t?0:1);process.stdout.write(o)'
/**
 * masters.json (a list) gets this master in the shape adapters/node-store.ts reads (pairedAt in ms,
 * via "install"); an entry of the same id is replaced and keeps when it was paired and last seen.
 * One that does not parse is left as it is.
 */
const MERGE_MASTERS =
  'const fs=require("fs"),e=process.env,t=fs.readFileSync(0,"utf8");let l=[];if(t.trim()){try{l=JSON.parse(t)}catch{console.error("masters.json does not parse: it is left as it is");process.exit(3)}}if(!Array.isArray(l)){console.error("masters.json is not a list: it is left as it is");process.exit(3)}const s=l.find(m=>m&&m.id===e.MASTER_ID);if(e.NODE_MODE==="check")process.exit(s&&s.tokenHash===e.MASTER_HASH&&s.name===e.MASTER_NAME?0:1);const o=l.filter(m=>!(m&&m.id===e.MASTER_ID));o.push({id:e.MASTER_ID,name:e.MASTER_NAME,tokenHash:e.MASTER_HASH,pairedAt:s&&typeof s.pairedAt==="number"?s.pairedAt:Date.now(),seenAt:s&&typeof s.seenAt==="number"?s.seenAt:null,via:"install"});process.stdout.write(JSON.stringify(o,null,2)+"\\n")'
/** The door's hello names this node: `node.api` 1 and its id. */
const HELLO =
  'const e=process.env;let h;try{h=JSON.parse(require("fs").readFileSync(0,"utf8"))}catch{process.exit(1)}process.exit(h&&h.node&&h.node.api===1&&h.node.id===e.NODE_ID?0:1)'

/** The sshd -T lines the fence must give the link user, one string: no value holds a "|". */
const fenceWant = (port: number): string =>
  linkFenceSettings(port)
    .map(([k, v]) => `${k.toLowerCase()} ${v}`)
    .join('|')
/**
 * Over sshd -T's lines for the link user: each of WANT's lines it does not give, and an AllowUsers,
 * AllowGroups, DenyUsers or DenyGroups that keeps the user out. Nothing printed: the fence is in force.
 */
const NOT_IN_FORCE_AWK = [
  'BEGIN { n = split(ENVIRON["WANT"], want, "|") }',
  '{ got[$0] = 1 }',
  'function ok(p) { return p == ENVIRON["L"] || p ~ /[*?]/ }',
  '$1 == "allowusers" { a = 1; for (i = 2; i <= NF; i++) if (ok($i)) au = 1 }',
  '$1 == "allowgroups" { g = 1; for (i = 2; i <= NF; i++) if (ok($i)) ag = 1 }',
  '($1 == "denyusers" || $1 == "denygroups") { for (i = 2; i <= NF; i++) if ($i == ENVIRON["L"]) print $1 " " $i }',
  'END { for (i = 1; i <= n; i++) if (!(want[i] in got)) print want[i]; if (a && !au) print "allowusers leaves " ENVIRON["L"] " out"; if (g && !ag) print "allowgroups leaves " ENVIRON["L"] " out" }',
].join(' ')

/**
 * What every step's sh starts with: `set -e`, the names, and the helpers. asNode runs a command as
 * the node's user with its home, its tools first on PATH and its systemd; putAs writes stdin to a
 * file of that user's (beside it, then renamed); keepOld and putBack keep and restore one in the
 * run's temp folder, which only root can read.
 */
function prelude(port: number): string[] {
  return [
    'set -e',
    'sudo() { "$@"; }',
    `U=${q(NODE_USER)}; L=${q(LINK_USER)}; H=${q(NODE_HOME)}`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    'asNode() { runuser -u "$U" -- env HOME="$H" USER="$U" LOGNAME="$U" PATH="$H/.local/bin:$H/.bun/bin:$PATH" XDG_RUNTIME_DIR="/run/user/${NODE_UID:-0}" DISABLE_AUTOUPDATER=1 "$@"; }',
    `putAs() { asNode sh -c 'mkdir -p "\${1%/*}" && cat > "$1.part" && chmod "$2" "$1.part" && mv -f "$1.part" "$1"' sh "$1" "$2"; }`,
    'sameAs() { asNode cat "$1" 2>/dev/null | cmp -s - "$2"; }',
    'keepOld() { if asNode test -e "$1"; then asNode cat "$1" > "$2"; else rm -f "$2"; fi; }',
    'putBack() { if [ -f "$2" ]; then putAs "$1" "$3" < "$2"; else asNode rm -f "$1"; fi; }',
    `ver() { awk ${q(VER_AWK)}; }`,
    `atLeast() { awk -v a="$1" -v b="$2" 'BEGIN { if (a == "") exit 1; split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 0 }'; }`,
    `ours() { p=$(getent passwd "$1") && [ "$(printf '%s\\n' "$p" | cut -d: -f5)" = "$2" ]; }`,
    // a user with lingering off may still have processes for a moment
    'userGone() { loginctl terminate-user "$1" 2>/dev/null || :; i=0; until userdel "$1" 2>/dev/null; do i=$((i + 1)); [ "$i" -lt 10 ] || return 1; sleep 1; done; }',
    // the master's forward, if one is open, holds a process of the link user
    'linkGone() { pkill -KILL -u "$L" 2>/dev/null || :; userGone "$L"; }',
    // a file put back beside itself and renamed over, as every write here
    'restore() { cp -p "$1" "$2.part" && mv -f "$2.part" "$2"; }',
    `reload() { ${SSHD_RELOAD}; }`,
    // sshd's settings for root and the admin sudo runs for: kept before, compared after
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    'admins() { for u in root ${SUDO_USER:-}; do echo "@@ $u"; sshd -T -C "user=$u,host=localhost,addr=127.0.0.1" || return 1; done; }',
    // sshd_config.d copied with the fence as $1 has it (empty: none), sshd_config's Include pointed at the copy: $W/main
    `candidate() { rm -rf "$W/d"; cp -a ${q(SSHD_DIR)} "$W/d" && rm -f "$W/d/${LINK_FENCE.slice(SSHD_DIR.length + 1)}" && { [ -z "$1" ] || cp "$1" "$W/d/${LINK_FENCE.slice(SSHD_DIR.length + 1)}"; } && D="$W/d" awk ${q(`tolower($1) == "include" { for (i = 2; i <= NF; i++) if ($i == "${SSHD_DIR}/*.conf" || $i == "sshd_config.d/*.conf") $i = ENVIRON["D"] "/*.conf" } { print }`)} ${q(SSHD_CONFIG)} > "$W/main"; }`,
    // what keeps the fence from being in force for the link user (the arguments: -f <file> or nothing)
    `notInForce() { t=$(sshd -T "$@" -C "user=$L,host=localhost,addr=127.0.0.1" 2>&1) || { echo "$t" | head -n 3; return; }; printf '%s\n' "$t" | L="$L" WANT=${q(fenceWant(port))} awk ${q(NOT_IN_FORCE_AWK)}; }`,
    'firstLines() { head -n 3 "$1" | tr "\\n" " "; }',
    `MERGE_CONFIG=${q(MERGE_CONFIG)}`,
    `MERGE_MASTERS=${q(MERGE_MASTERS)}`,
    `HELLO=${q(HELLO)}`,
  ]
}

/** A word that names the node user's uid as the run finds it: the slice's path depends on it. */
const SLICE_FILE_SH = slicePath('$NODE_UID')

function applySteps(f: NodeFacts, w: NodeWanted, waitS: number): NodeStep[] {
  const id = q(w.id)
  const port = String(w.port)
  const sha = q(w.plugin.sha256)
  const arch = q(w.plugin.path)
  const copyBun = !atLeast(f.bun, BUN_VERSION) && f.serverBun && atLeast(f.serverBun.version, BUN_VERSION)
  const bunOk = `v=$(asNode ${q(BUN_BIN)} --version 2>/dev/null | ver) && atLeast "$v" ${BUN_VERSION}`
  const herdrOk = `v=$(asNode ${q(HERDR_BIN)} --version 2>/dev/null | ver) && atLeast "$v" ${HERDR_MIN}`
  const claudeOk = `asNode ${q(CLAUDE_BIN)} --version >/dev/null 2>&1`
  const masterEnv = `MASTER_ID=${q(w.master.id)} MASTER_NAME=${q(w.master.name)} MASTER_HASH=${q(w.master.tokenHash)}`
  const nodeEnv = `NODE_ID=${id} NODE_PORT=${port}`
  // config.json and masters.json as they are now, or empty when there is none
  const readNow = [
    `if asNode test -e ${q(CONFIG_PATH)}; then asNode cat ${q(CONFIG_PATH)} > "$W/cfg.in"; else : > "$W/cfg.in"; fi`,
    `if asNode test -e ${q(MASTERS_PATH)}; then asNode cat ${q(MASTERS_PATH)} > "$W/masters.in"; else : > "$W/masters.in"; fi`,
  ]
  const configHolds = [
    ...readNow,
    `asNode env NODE_MODE=check ${nodeEnv} bun -e "$MERGE_CONFIG" < "$W/cfg.in"`,
    `asNode env NODE_MODE=check ${masterEnv} bun -e "$MERGE_MASTERS" < "$W/masters.in"`,
  ]
  const profileHolds = [
    `${emit(profileBlock())} > "$W/profile.want"`,
    `asNode cat ${q(PROFILE_PATH)} 2>/dev/null | awk -v b=${q(PROFILE_BEGIN)} -v e=${q(PROFILE_END)} '$0 == b { s = 1 } s { print } $0 == e { s = 0 }' | cmp -s - "$W/profile.want"`,
  ]
  const unitHolds = [
    `${emit(herdrUnit())} > "$W/unit.want"`,
    `sameAs ${q(UNIT_PATH)} "$W/unit.want"`,
    'asNode systemctl --user is-enabled --quiet herdr.service',
    'asNode systemctl --user is-active --quiet herdr.service',
  ]
  const linkRecord: NodeItem[] = [
    ...(f.linkUser === 'none' ? [{ kind: 'user', name: LINK_USER } as const] : []),
    ...(f.keysDir ? [] : [{ kind: 'keysdir' } as const]),
    { kind: 'keys' },
    { kind: 'fence' },
  ]
  const linkHolds = [
    `ours "$L" ${q(LINK_COMMENT)}`,
    `[ "$(cat ${q(LINK_KEYS)} 2>/dev/null)" = ${q(linkKeysLine(w.linkKey, w.port))} ]`,
    `${emit(linkFence(w.port))} | cmp -s - ${q(LINK_FENCE)}`,
    '[ -z "$(notInForce)" ]',
  ]
  const steps: NodeStep[] = [
    step('check', 'step', {
      commands: [
        '[ "$(id -u)" = 0 ] || { echo "this runs as root"; exit 1; }',
        'for c in runuser loginctl useradd usermod userdel systemctl sshd tar sha256sum cmp; do command -v "$c" >/dev/null 2>&1 || { echo "$c is not on this server"; exit 1; }; done',
        `sshd -t 2>"$W/t" || { echo "sshd's config does not pass sshd -t as it is, before any change: $(firstLines "$W/t")"; exit 1; }`,
        `if getent passwd "$U" >/dev/null && ! ours "$U" ${q(NODE_COMMENT)}; then echo "a user $U is there that the board did not make"; exit 1; fi`,
        `if getent passwd "$L" >/dev/null && ! ours "$L" ${q(LINK_COMMENT)}; then echo "a user $L is there that the board did not make"; exit 1; fi`,
        'for u in "$U" "$L"; do if ! getent passwd "$u" >/dev/null && getent group "$u" >/dev/null; then echo "a group $u is there without its user: useradd cannot make it"; exit 1; fi; done',
        'if ! getent passwd "$U" >/dev/null && [ -e "$H" ]; then echo "a folder $H is there without its user: move it away first"; exit 1; fi',
      ],
      changes: false,
    }),
    step('user', 'step', {
      skipIf: [`ours "$U" ${q(NODE_COMMENT)}`],
      commands: [
        'if [ ! -e "$H" ]; then touch "$W/made-home"; fi',
        `useradd --create-home --home-dir "$H" --shell /bin/bash --comment ${q(NODE_COMMENT)} "$U"`,
      ],
      check: [`ours "$U" ${q(NODE_COMMENT)}`, '[ -d "$H" ]'],
      undo: [
        `if ours "$U" ${q(NODE_COMMENT)}; then loginctl disable-linger "$U" 2>/dev/null || :; userGone "$U"; fi`,
        // only a home this run made: one that was there is never the run's to remove
        'if [ -f "$W/made-home" ]; then rm -rf "$H"; fi',
      ],
      record: f.user === 'none' ? [{ kind: 'user', name: NODE_USER }] : [],
    }),
    step('slice', 'step', {
      skipIf: [`${emit(sliceDropIn(w.ceiling))} | cmp -s - "${SLICE_FILE_SH}"`],
      commands: [
        '[ -n "$NODE_UID" ] || { echo "the node user has no uid"; exit 1; }',
        `F="${SLICE_FILE_SH}"`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
        'if [ ! -d "${F%/*}" ]; then mkdir -p "${F%/*}"; touch "$W/made-slice-dir"; fi',
        'if [ -f "$F" ]; then cp -p "$F" "$W/slice.old"; fi',
        `${emit(sliceDropIn(w.ceiling))} > "$F.part"`,
        '{ chmod 644 "$F.part" && mv -f "$F.part" "$F"; } || exit 1',
        'touch "$W/put-slice"',
        'systemctl daemon-reload',
      ],
      check: [`${emit(sliceDropIn(w.ceiling))} | cmp -s - "${SLICE_FILE_SH}"`],
      undo: [
        `F="${SLICE_FILE_SH}"`,
        'rm -f "$F.part"',
        'if [ -f "$W/put-slice" ]; then if [ -f "$W/slice.old" ]; then restore "$W/slice.old" "$F"; else rm -f "$F"; fi; fi',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
        'if [ -f "$W/made-slice-dir" ]; then rmdir "${F%/*}" 2>/dev/null || :; fi',
        'systemctl daemon-reload',
      ],
      record: [{ kind: 'slice', uid: 0 }],
    }),
    step('linger', 'step', {
      skipIf: [`[ -f /var/lib/systemd/linger/${NODE_USER} ]`],
      commands: ['loginctl enable-linger "$U"'],
      check: [`[ -f /var/lib/systemd/linger/${NODE_USER} ]`],
      undo: ['loginctl disable-linger "$U"'],
      record: [{ kind: 'linger' }],
    }),
  ]
  if (w.packages)
    steps.push(
      step('packages', 'step', {
        skipIf: [
          `[ "$(dpkg-query -W -f '\${Status}\\n' ${NODE_PACKAGES.join(' ')} 2>/dev/null | grep -c 'install ok installed')" = ${NODE_PACKAGES.length} ]`,
        ],
        commands: [
          'DEBIAN_FRONTEND=noninteractive apt-get update -q',
          `DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ${NODE_PACKAGES.join(' ')}`,
        ],
        timeoutS: 900,
      }),
    )
  steps.push(
    step('profile', 'step', {
      skipIf: profileHolds,
      commands: [
        `keepOld ${q(PROFILE_PATH)} "$W/profile.old"`,
        `{ if [ -f "$W/profile.old" ]; then awk -v b=${q(PROFILE_BEGIN)} -v e=${q(PROFILE_END)} '$0 == b { s = 1 } !s { print } s && $0 == e { s = 0 }' "$W/profile.old"; fi; ${emit(profileBlock())}; } > "$W/profile.new"`,
        `putAs ${q(PROFILE_PATH)} 644 < "$W/profile.new"`,
        'touch "$W/put-profile"',
      ],
      check: profileHolds,
      undo: [`if [ -f "$W/put-profile" ]; then putBack ${q(PROFILE_PATH)} "$W/profile.old" 644; fi`],
    }),
    step('bun', 'step', {
      skipIf: [bunOk],
      commands: [
        `if ! asNode test -e ${q(BUN_BIN)}; then touch "$W/made-bun"; fi`,
        ...(copyBun && f.serverBun
          ? [
              `asNode sh -c 'mkdir -p "$HOME/.bun/bin" && cat > "$HOME/.bun/bin/bun.part" && chmod 755 "$HOME/.bun/bin/bun.part" && mv -f "$HOME/.bun/bin/bun.part" "$HOME/.bun/bin/bun"' < ${q(f.serverBun.path)}`,
            ]
          : [
              `curl -fsSL ${q(BUN_INSTALLER)} > "$W/bun-install"`,
              `asNode bash -s ${q(`bun-v${BUN_VERSION}`)} < "$W/bun-install"`,
            ]),
      ],
      check: [bunOk],
      undo: ['if [ -f "$W/made-bun" ]; then asNode rm -rf "$H/.bun"; fi'],
      timeoutS: 300,
    }),
    step('herdr', 'step', {
      skipIf: [herdrOk],
      commands: [
        `if ! asNode test -e ${q(HERDR_BIN)}; then touch "$W/made-herdr"; fi`,
        `curl -fsSL ${q(HERDR_INSTALLER)} > "$W/herdr-install"`,
        'asNode sh < "$W/herdr-install"',
      ],
      check: [herdrOk],
      undo: [`if [ -f "$W/made-herdr" ]; then asNode rm -f ${q(HERDR_BIN)}; fi`],
      timeoutS: 300,
    }),
    step('claude', 'step', {
      skipIf: [claudeOk],
      commands: [
        `if ! asNode test -e ${q(CLAUDE_BIN)}; then touch "$W/made-claude"; fi`,
        `curl -fsSL ${q(CLAUDE_INSTALLER)} > "$W/claude-install"`,
        'asNode bash < "$W/claude-install"',
      ],
      check: [claudeOk],
      undo: [`if [ -f "$W/made-claude" ]; then asNode rm -rf ${q(CLAUDE_BIN)} "$H/.local/share/claude"; fi`],
      timeoutS: 600,
    }),
    step('plugin', 'step', {
      skipIf: [`[ "$(asNode cat ${q(PLUGIN_STAMP)} 2>/dev/null)" = ${sha} ]`],
      commands: [
        `[ -f ${arch} ] || { echo "the plugin's archive is not at "${arch}; exit 1; }`,
        // one copy, out of every other user's reach, checked and unpacked: the file cannot change between
        `cp ${arch} "$W/plugin.tar" || exit 1`,
        `[ "$(sha256sum < "$W/plugin.tar" | cut -c1-64)" = ${sha} ] || { echo "the archive at "${arch}" is not the one the board sent"; exit 1; }`,
        // unpacked and installed beside the plugin's folder, then moved in; the one before stays as agent-board.old
        `asNode sh -c 'rm -rf "$HOME/agent-board.new" "$HOME/agent-board.old" && mkdir "$HOME/agent-board.new" && tar -xf - -C "$HOME/agent-board.new"' < "$W/plugin.tar"`,
        `asNode sh -c 'cd "$HOME/agent-board.new" && bun install --production'`,
        `asNode sh -c 'if [ -d "$HOME/agent-board" ]; then mv "$HOME/agent-board" "$HOME/agent-board.old"; fi; mv "$HOME/agent-board.new" "$HOME/agent-board"'`,
        'touch "$W/moved-plugin"',
        `printf '%s\\n' ${sha} | putAs ${q(PLUGIN_STAMP)} 644`,
        `asNode herdr plugin link ${q(PLUGIN_DIR)}`,
      ],
      check: [`[ "$(asNode cat ${q(PLUGIN_STAMP)} 2>/dev/null)" = ${sha} ]`],
      undo: [
        'asNode rm -rf "$H/agent-board.new"',
        `if [ -f "$W/moved-plugin" ]; then asNode sh -c 'rm -rf "$HOME/agent-board"; if [ -d "$HOME/agent-board.old" ]; then mv "$HOME/agent-board.old" "$HOME/agent-board"; fi'; fi`,
      ],
      timeoutS: 600,
    }),
    step('config', 'step', {
      skipIf: configHolds,
      commands: [
        ...readNow,
        `keepOld ${q(CONFIG_PATH)} "$W/cfg.old"`,
        `keepOld ${q(MASTERS_PATH)} "$W/masters.old"`,
        `asNode env ${nodeEnv} bun -e "$MERGE_CONFIG" < "$W/cfg.in" > "$W/cfg.new"`,
        `asNode env ${masterEnv} bun -e "$MERGE_MASTERS" < "$W/masters.in" > "$W/masters.new"`,
        'touch "$W/put-config"',
        `putAs ${q(CONFIG_PATH)} 600 < "$W/cfg.new"`,
        `putAs ${q(MASTERS_PATH)} 600 < "$W/masters.new"`,
      ],
      check: configHolds,
      undo: [
        'if [ -f "$W/put-config" ]; then',
        `  putBack ${q(CONFIG_PATH)} "$W/cfg.old" 600`,
        `  putBack ${q(MASTERS_PATH)} "$W/masters.old" 600`,
        'fi',
      ],
    }),
    step('install', 'step', {
      skipIf: [`[ "$(asNode cat "$H/agent-board/.installed-sha256" 2>/dev/null)" = ${sha} ]`],
      commands: [
        `asNode sh -c 'cd "$HOME/agent-board" && bun src/entrypoints/install.ts'`,
        `printf '%s\\n' ${sha} | putAs "$H/agent-board/.installed-sha256" 644`,
      ],
      timeoutS: 300,
    }),
    step('unit', 'step', {
      skipIf: unitHolds,
      commands: [
        // lingering starts the node user's systemd; it may take a moment
        'i=0; until [ -d "/run/user/$NODE_UID/systemd" ]; do i=$((i + 1)); if [ "$i" -ge 30 ]; then echo "the node user\'s systemd did not start"; exit 1; fi; sleep 1; done',
        `keepOld ${q(UNIT_PATH)} "$W/unit.old"`,
        `${emit(herdrUnit())} > "$W/unit.want"`,
        'touch "$W/put-unit"',
        `putAs ${q(UNIT_PATH)} 644 < "$W/unit.want"`,
        'asNode systemctl --user daemon-reload',
        'asNode systemctl --user enable herdr.service',
        // a unit that changed under a running herdr restarts it; else it starts, or stays as it runs
        'if [ -f "$W/unit.old" ] && ! cmp -s "$W/unit.old" "$W/unit.want"; then asNode systemctl --user restart herdr.service; else asNode systemctl --user start herdr.service; fi',
      ],
      check: ['asNode systemctl --user is-active --quiet herdr.service'],
      undo: [
        'if [ -f "$W/put-unit" ]; then',
        '  asNode systemctl --user disable --now herdr.service 2>/dev/null || :',
        `  putBack ${q(UNIT_PATH)} "$W/unit.old" 644`,
        '  asNode systemctl --user daemon-reload 2>/dev/null || :',
        '  if [ -f "$W/unit.old" ]; then asNode systemctl --user enable --now herdr.service; fi',
        'fi',
      ],
      record: [{ kind: 'unit' }],
      timeoutS: 120,
    }),
    step('link', 'step', {
      skipIf: linkHolds,
      commands: [
        '[ -d /run/sshd ] || install -d -m 755 /run/sshd',
        `if ! getent passwd "$L" >/dev/null; then useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --comment ${q(LINK_COMMENT)} "$L"; touch "$W/made-link"; fi`,
        `ours "$L" ${q(LINK_COMMENT)} || { echo "a user $L is there that the board did not make"; exit 1; }`,
        // useradd leaves the account locked; an sshd with UsePAM no refuses a locked one, key or not
        `usermod -p '*' "$L"`,
        `if [ ! -d ${q(KEYS_DIR)} ]; then install -d -m 755 ${q(KEYS_DIR)}; touch "$W/made-keysdir"; fi`,
        `if [ -f ${q(LINK_KEYS)} ]; then cp -p ${q(LINK_KEYS)} "$W/keys.old"; fi`,
        'touch "$W/put-keys"',
        `printf '%s\\n' ${q(linkKeysLine(w.linkKey, w.port))} > ${q(`${LINK_KEYS}.part`)}`,
        `{ chmod 644 ${q(`${LINK_KEYS}.part`)} && mv -f ${q(`${LINK_KEYS}.part`)} ${q(LINK_KEYS)}; } || exit 1`,
        // checked on a copy of sshd's config before it is in place, and again after
        `admins > "$W/admins.before" || { echo "sshd -T does not answer for root or the admin"; exit 1; }`,
        `${emit(linkFence(w.port))} > "$W/fence"`,
        `candidate "$W/fence" || { echo "could not copy sshd's config to check it"; exit 1; }`,
        `sshd -t -f "$W/main" 2>"$W/t" || { echo "sshd -t refuses the config with the fence: $(firstLines "$W/t")"; exit 1; }`,
        `bad=$(notInForce -f "$W/main"); [ -z "$bad" ] || { echo "sshd's fence for $L would not be in force: $(printf '%s' "$bad" | tr '\\n' ',')"; exit 1; }`,
        `if [ -f ${q(LINK_FENCE)} ]; then cp -p ${q(LINK_FENCE)} "$W/fence.old"; fi`,
        'touch "$W/put-fence"',
        `{ cp "$W/fence" ${q(`${LINK_FENCE}.part`)} && chmod 644 ${q(`${LINK_FENCE}.part`)} && mv -f ${q(`${LINK_FENCE}.part`)} ${q(LINK_FENCE)}; } || exit 1`,
        `sshd -t 2>"$W/t" || { echo "sshd -t refuses the config with the fence in place: $(firstLines "$W/t")"; exit 1; }`,
        `bad=$(notInForce); [ -z "$bad" ] || { echo "sshd's fence for $L is not in force: $(printf '%s' "$bad" | tr '\\n' ',')"; exit 1; }`,
        `admins > "$W/admins.after" || { echo "sshd -T does not answer for root or the admin"; exit 1; }`,
        `cmp -s "$W/admins.before" "$W/admins.after" || { echo "the fence would change sshd's settings for root or the admin"; exit 1; }`,
        'reload',
      ],
      check: linkHolds,
      undo: [
        `rm -f ${q(`${LINK_FENCE}.part`)} ${q(`${LINK_KEYS}.part`)}`,
        `if [ -f "$W/put-fence" ]; then if [ -f "$W/fence.old" ]; then restore "$W/fence.old" ${q(LINK_FENCE)}; else rm -f ${q(LINK_FENCE)}; fi; fi`,
        `if [ -f "$W/put-keys" ]; then if [ -f "$W/keys.old" ]; then restore "$W/keys.old" ${q(LINK_KEYS)}; else rm -f ${q(LINK_KEYS)}; fi; fi`,
        `if [ -f "$W/made-keysdir" ]; then rmdir ${q(KEYS_DIR)} 2>/dev/null || :; fi`,
        `if [ -f "$W/made-link" ] && ours "$L" ${q(LINK_COMMENT)}; then linkGone; fi`,
        'if [ -f "$W/put-fence" ]; then sshd -t && reload; fi',
      ],
      record: linkRecord,
    }),
    step('hello', 'step', {
      commands: [
        // as the link user's forward sees it: the door on 127.0.0.1, answering as this node
        `start=$(date +%s); until curl -fsS --max-time 5 http://127.0.0.1:${port}/api/hello > "$W/hello" 2>/dev/null && asNode env NODE_ID=${id} bun -e "$HELLO" < "$W/hello"; do if [ $(($(date +%s) - start)) -ge ${waitS} ]; then echo "the node's board did not answer on 127.0.0.1:${port} as "${id}" within ${waitS} s"; exit 1; fi; sleep 2; done`,
      ],
      timeoutS: waitS + 30,
      changes: false,
    }),
  )
  return steps
}

/**
 * The plan for this server, or why there is none. Every step is in it, each with its skip check, so
 * a second Apply on a node set up as wanted skips them all and changes nothing.
 */
export function nodePlan(
  f: NodeFacts,
  w: NodeWanted,
  o: { waitS?: number } = {},
): { ok: true; plan: NodePlan } | { ok: false; why: Text[] } {
  const problem = nodeWantedProblem(w)
  if (problem) throw new Error(`not a value for a script: ${problem}`)
  const why = nodeRefusals(f, w)
  if (why.length) return { ok: false, why }
  const waitS = o.waitS ?? HELLO_WAIT_S
  const rec = f.record === null ? null : nodeRecord(f.record)
  const c = w.ceiling
  const words: Text[] = [
    { key: 'node.plan.users', params: { user: NODE_USER, link: LINK_USER, port: String(w.port) } },
    {
      key: 'node.plan.ceiling',
      params: {
        max: String(c.memoryMaxMb),
        high: String(c.memoryHighMb),
        swap: String(c.swapMaxMb),
        cpu: String(c.cpuWeight),
        tasks: String(c.tasksMax),
      },
    },
    !atLeast(f.bun, BUN_VERSION) && f.serverBun && atLeast(f.serverBun.version, BUN_VERSION)
      ? { key: 'node.plan.bunCopy', params: { path: f.serverBun.path, version: f.serverBun.version } }
      : { key: 'node.plan.bunInstall', params: { version: BUN_VERSION } },
    { key: 'node.plan.tools', params: { herdr: HERDR_MIN } },
    ...(w.packages ? [{ key: 'node.plan.packages', params: { list: NODE_PACKAGES.join(', ') } }] : []),
  ]
  const warnings: Text[] = []
  if (f.listening === null) warnings.push({ key: 'node.warn.listenUnknown' })
  else {
    const others = [...new Set(f.listening.filter(l => l.port !== w.port).map(l => `${l.name} (${l.port})`))]
    if (others.length) words.push({ key: 'node.plan.untouched', params: { list: others.join(', ') } })
  }
  if (w.packages) warnings.push({ key: 'node.warn.packagesStay' })
  // a running board keeps its code: the update over the link restarts it (design 11.3)
  if (f.plugin && f.plugin !== w.plugin.sha256) warnings.push({ key: 'node.warn.pluginLater' })
  return {
    ok: true,
    plan: {
      kind: 'apply',
      node: { id: w.id, port: w.port },
      steps: applySteps(f, w, waitS),
      carried: rec?.items ?? [],
      ceiling: c,
      words,
      warnings,
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Undo

/**
 * Undo of what the record lists, and nothing else: herdr's unit stopped and removed, lingering off,
 * sshd's fence out (checked on a copy first, root's and the admin's settings unchanged, a reload;
 * put back on a failure), the link user's key and its folder when a run made it, the link user, the
 * slice drop-in, and the node's user with its home. Users go only when a run of the board's made
 * them, and only one with the board's comment; ~/work stays unless `work` is ticked, given to root
 * so no later user with that uid gets it. Every step finds its part gone without failing, so an Undo
 * after a run cut short, or a second Undo, is safe.
 */
export function nodeUndoPlan(r: NodeRecord, o: { work: boolean }): NodePlan {
  const has = (kind: NodeItem['kind'], name?: string): NodeItem | undefined =>
    r.items.find(i => i.kind === kind && (name === undefined || (i.kind === 'user' && i.name === name)))
  const steps: NodeStep[] = [
    step('check', 'undo', {
      commands: [
        '[ "$(id -u)" = 0 ] || { echo "this runs as root"; exit 1; }',
        'for c in runuser loginctl userdel systemctl sshd; do command -v "$c" >/dev/null 2>&1 || { echo "$c is not on this server"; exit 1; }; done',
        ...(has('fence')
          ? [
              `sshd -t 2>"$W/t" || { echo "sshd's config does not pass sshd -t as it is: $(firstLines "$W/t")"; exit 1; }`,
            ]
          : []),
      ],
      changes: false,
    }),
  ]
  if (has('unit'))
    steps.push(
      step('unit', 'undo', {
        commands: [
          'if getent passwd "$U" >/dev/null; then',
          '  asNode systemctl --user disable --now herdr.service 2>/dev/null || :',
          `  asNode rm -f ${q(UNIT_PATH)}`,
          '  asNode systemctl --user daemon-reload 2>/dev/null || :',
          'fi',
        ],
        record: [{ kind: 'unit' }],
      }),
    )
  if (has('linger'))
    steps.push(
      step('linger', 'undo', {
        commands: [`loginctl disable-linger "$U" 2>/dev/null || rm -f /var/lib/systemd/linger/${NODE_USER}`],
        check: [`[ ! -e /var/lib/systemd/linger/${NODE_USER} ]`],
        record: [{ kind: 'linger' }],
      }),
    )
  if (has('fence'))
    steps.push(
      step('fence', 'undo', {
        commands: [
          `if [ -f ${q(LINK_FENCE)} ]; then`,
          '  [ -d /run/sshd ] || install -d -m 755 /run/sshd',
          `  admins > "$W/admins.before" || { echo "sshd -T does not answer for root or the admin"; exit 1; }`,
          `  candidate "" || { echo "could not copy sshd's config to check it"; exit 1; }`,
          `  sshd -t -f "$W/main" 2>"$W/t" || { echo "sshd -t refuses the config without the fence: $(firstLines "$W/t")"; exit 1; }`,
          `  cp -p ${q(LINK_FENCE)} "$W/fence.old" || exit 1`,
          `  rm -f ${q(LINK_FENCE)}`,
          `  back() { restore "$W/fence.old" ${q(LINK_FENCE)}; }`,
          `  if ! sshd -t 2>"$W/t"; then back; echo "sshd -t refuses the config without the fence: $(firstLines "$W/t")"; exit 1; fi`,
          `  if ! admins > "$W/admins.after"; then back; echo "sshd -T does not answer for root or the admin"; exit 1; fi`,
          `  if ! cmp -s "$W/admins.before" "$W/admins.after"; then back; echo "taking the fence out would change sshd's settings for root or the admin"; exit 1; fi`,
          `  if ! reload; then back; sshd -t && reload; echo "sshd did not reload"; exit 1; fi`,
          'fi',
          `rm -f ${q(`${LINK_FENCE}.part`)}`,
        ],
        record: [{ kind: 'fence' }],
      }),
    )
  if (has('keys') || has('keysdir'))
    steps.push(
      step('keys', 'undo', {
        commands: [
          ...(has('keys') ? [`rm -f ${q(LINK_KEYS)} ${q(`${LINK_KEYS}.part`)}`] : []),
          ...(has('keysdir') ? [`rmdir ${q(KEYS_DIR)} 2>/dev/null || :`] : []),
        ],
        record: r.items.filter(i => i.kind === 'keys' || i.kind === 'keysdir'),
      }),
    )
  if (has('user', LINK_USER))
    steps.push(
      step('link-user', 'undo', {
        commands: [
          `if getent passwd "$L" >/dev/null; then if ours "$L" ${q(LINK_COMMENT)}; then linkGone; else echo "@@warn a user $L is there that the board did not make: it is left as it is"; fi; fi`,
        ],
        record: [{ kind: 'user', name: LINK_USER }],
      }),
    )
  const slice = has('slice')
  if (slice?.kind === 'slice' && (!Number.isInteger(slice.uid) || slice.uid <= 0)) throw new Error('not a uid')
  if (slice?.kind === 'slice')
    steps.push(
      step('slice', 'undo', {
        commands: [
          `F=${q(slicePath(slice.uid))}`,
          'rm -f "$F" "$F.part"',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
          'rmdir "${F%/*}" 2>/dev/null || :',
          'systemctl daemon-reload',
        ],
        record: [slice],
      }),
    )
  if (has('user', NODE_USER))
    steps.push(
      step('user', 'undo', {
        commands: [
          'if getent passwd "$U" >/dev/null; then',
          `  if ! ours "$U" ${q(NODE_COMMENT)}; then echo "@@warn a user $U is there that the board did not make: it and its home are left as they are"; exit 0; fi`,
          '  userGone "$U" || { echo "userdel $U failed: its processes did not end"; exit 1; }',
          'fi',
          ...(o.work
            ? ['rm -rf "$H"']
            : [
                `if [ -d ${q(WORK_DIR)} ]; then`,
                `  find "$H" -mindepth 1 -maxdepth 1 ! -name work -exec rm -rf {} +`,
                '  chown -R -h root:root "$H"',
                `  echo "@@kept "${q(WORK_DIR)}`,
                'else',
                '  rm -rf "$H"',
                'fi',
              ]),
        ],
        record: [{ kind: 'user', name: NODE_USER }],
        timeoutS: 120,
      }),
    )
  const words: Text[] = [
    { key: 'node.undoPlan.removes', params: { list: r.items.map(itemWords).join(', ') } },
    has('user', NODE_USER)
      ? { key: o.work ? 'node.undoPlan.workRemoved' : 'node.undoPlan.workKept', params: { path: WORK_DIR } }
      : { key: 'node.undoPlan.userStays', params: { user: NODE_USER } },
  ]
  return { kind: 'undo', node: r.node, steps, carried: r.items, ceiling: null, words, warnings: [] }
}

/** What a record item is, as the plan names it. */
function itemWords(i: NodeItem): string {
  switch (i.kind) {
    case 'user':
      return `user ${i.name}`
    case 'linger':
      return `lingering for ${NODE_USER}`
    case 'slice':
      return slicePath(i.uid)
    case 'unit':
      return UNIT_PATH
    case 'keysdir':
      return KEYS_DIR
    case 'keys':
      return LINK_KEYS
    case 'fence':
      return LINK_FENCE
  }
}

// ---------------------------------------------------------------------------------------------
// The run

/** Ends each step's text in the run: a line no step has. */
const MARK = 'AGENT_BOARD_NODE_END'

/** A variable holding text verbatim: a quoted here-document, so nothing in it is expanded. */
function verbatim(name: string, lines: readonly string[]): string[] {
  if (lines.includes(MARK)) throw new Error("a step holds the run's own marker")
  return [`${name}=$(cat <<'${MARK}'`, ...lines, MARK, ')']
}

/** An item as the shell word of its JSON; the slice's uid is the one the run finds. */
function itemWord(i: NodeItem, live: boolean): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
  if (i.kind === 'slice' && live) return `${q('{"kind":"slice","uid":')}"${'${NODE_UID:-0}'}"${q('}')}`
  return q(JSON.stringify(i))
}

/**
 * The one sh script a plan runs as, as root. Apply: the guard (it changes nothing: when it fails the
 * run says `@@result unchanged` and exits 3), then each step: `@@step <id> start`, `skip` when its
 * skip check holds, else what it will make goes on the record, then its commands and check under a
 * timeout, `ok` or `fail`. A failure runs the undo of every step that ran, newest first (`@@undo
 * <id> ok|fail`): the record as it was before the run when all of them worked (`@@result
 * rolled-back`, exit 1), else the record of what is left (`rollback-failed`, exit 2). All done:
 * `@@result applied`; a run in which every step skipped leaves the record as it was. Undo: each
 * step in turn, its items off the record as it ends; a failure stops there with the record of what
 * is left (`@@result undo-failed`); the end removes the record (`undone`); no record: `none`. The
 * record is always written beside itself and renamed over. A hangup or a broken pipe (the admin's
 * connection gone) does not stop it; INT or TERM let the step going on end, then Apply rolls back and
 * Undo stops. One run at a time, under a lock: another meanwhile says `@@result busy` (exit 75).
 */
export function nodeRunScript(p: NodePlan, run: { id: string; at: string }): string {
  if (!PLAIN_ID.test(run.id) || !STAMP.test(run.at)) throw new Error('not a plain run id or time')
  const undo = p.kind === 'undo'
  // one variable per record item, by its key: what earlier runs made, then what a step makes
  const vars = new Map<string, { name: string; carried: NodeItem | null }>()
  const varOf = (i: NodeItem) => {
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
  const carriedWord = (i: NodeItem): string => {
    const v = varOf(i)
    return `${v.name}=${v.carried ? itemWord(v.carried, false) : "''"}`
  }
  const head = `{"v":1,"run":${JSON.stringify(run.id)},"at":${JSON.stringify(run.at)},"state":"`
  const mid = `","node":${JSON.stringify(p.node)},"items":[`
  const names = [...vars.values()].map(v => `"$${v.name}"`)
  const out: string[] = [
    'exec </dev/null',
    `# agent-board: node ${p.kind}`,
    'cd /',
    'set -u',
    'umask 022',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    'LC_ALL=C; export LC_ALL',
    // the admin's connection gone does not stop a run; told to stop, it rolls back after the step going on
    "trap '' HUP PIPE",
    'STOP=0',
    "trap 'STOP=1' INT TERM",
    "command -v flock >/dev/null 2>&1 || { echo 'flock is not on this server: nothing was changed.'; echo '@@result unchanged'; exit 3; }",
    `exec 9>${q(RUN_LOCK)}`,
    "flock -n 9 || { echo '@@result busy'; exit 75; }",
    "W=$(mktemp -d) || { echo '@@result unchanged'; exit 3; }",
    'chmod 700 "$W"; export W',
    `trap 'rm -rf "$W"' EXIT`,
    `ETC=${q(NODE_ETC)}; REC=${q(NODE_RECORD)}`,
    "NL='",
    "'",
    ...verbatim('P', prelude(p.node.port)),
    ...(vars.size
      ? [[...vars.values()].map(v => `${v.name}=${v.carried ? itemWord(v.carried, false) : "''"}`).join('; ')]
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
    `uidNow() { NODE_UID=$(getent passwd ${q(NODE_USER)} 2>/dev/null | cut -d: -f3); export NODE_UID; }`,
    'skips() { timeout -k 5 60 sh -c "$P$NL$1" >/dev/null 2>&1 9>&-; }',
    'does() { timeout -k 5 "$1" sh -c "$P$NL$2" 2>&1 9>&-; }',
    'unchanged() { echo "$1: nothing was changed."; echo "@@result unchanged"; exit 3; }',
  )
  const guard = p.steps[0]
  if (!guard) throw new Error('a plan starts with its guard')
  const runGuard = [
    'uidNow',
    `echo '@@step ${guard.id} start'`,
    `if does ${guard.timeoutS} "$S1"; then echo '@@step ${guard.id} ok'; else echo '@@step ${guard.id} fail'; echo '@@result unchanged'; exit 3; fi`,
  ]
  if (!undo) {
    const backLines: string[] = []
    for (let i = p.steps.length - 1; i >= 1; i--) {
      const s = p.steps[i] as NodeStep
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
      `  if [ "$R" = rollback-failed ]; then rec rollback-failed || echo "The record "${q(NODE_RECORD)}" could not be written."; fi`,
      '  echo "@@result $R"',
      '  if [ "$R" = rolled-back ]; then exit 1; fi',
      '  exit 2',
      '}',
      ...runGuard,
      'if [ ! -d "$ETC" ]; then install -d -m 755 "$ETC" || unchanged "$ETC could not be made"; MADE_ETC=1; fi',
      'if [ -f "$REC" ]; then cp -p "$REC" "$W/rec.old" || unchanged "The record could not be copied"; fi',
      `if ! rec running; then rm -f "$REC.part"; if [ "$MADE_ETC" = 1 ]; then rmdir "$ETC" 2>/dev/null || :; fi; unchanged "The record "${q(NODE_RECORD)}" could not be written"; fi`,
    )
    p.steps.forEach((s, i) => {
      if (i === 0) return
      const k = i + 1
      const ahead = s.record.map(item => `${varOf(item).name}=${itemWord(item, true)}`)
      out.push(
        `echo '@@step ${s.id} start'`,
        `if ${s.skipIf.length ? `skips "$K${k}"` : 'false'}; then echo '@@step ${s.id} skip'; else`,
        ...(ahead.length ? [`  ${ahead.join('; ')}`, '  rec running || back'] : []),
        `  D${k}=1${s.changes ? '; CHANGED=1' : ''}`,
        `  if does ${s.timeoutS} "$S${k}"; then echo '@@step ${s.id} ok'; else echo '@@step ${s.id} fail'; back; fi`,
        ...(ahead.length ? ['  rec running || back'] : []),
        'fi',
        `if [ "$STOP" = 1 ]; then echo 'The run was told to stop: what it did is rolled back.'; back; fi`,
        // the node user's uid, which later steps name, once the step that makes the user is past
        ...(s.id === 'user' ? ['uidNow'] : []),
      )
    })
    out.push(
      // nothing ran: the record stays as it was, byte for byte
      'if [ "$CHANGED" = 0 ] && [ -f "$W/rec.old" ]; then { cp -p "$W/rec.old" "$REC.part" && mv -f "$REC.part" "$REC"; } || back; else rec applied || back; fi',
      "echo '@@result applied'",
      'exit 0',
    )
  } else {
    out.push(
      ...runGuard,
      `if [ ! -f "$REC" ]; then echo '@@result none'; exit 0; fi`,
      `rec undoing || unchanged "The record "${q(NODE_RECORD)}" could not be written"`,
    )
    p.steps.forEach((s, i) => {
      if (i === 0) return
      const k = i + 1
      const off = s.record.map(item => `${varOf(item).name}=''`)
      out.push(
        `echo '@@step ${s.id} start'`,
        `if does ${s.timeoutS} "$S${k}"; then echo '@@step ${s.id} ok'; else echo '@@step ${s.id} fail'; rec undo-failed; echo '@@result undo-failed'; exit 1; fi`,
        ...(off.length ? [off.join('; ')] : []),
        `rec undoing || { echo "The record "${q(NODE_RECORD)}" could not be written."; echo '@@result undo-failed'; exit 1; }`,
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

export type RunResult =
  | 'busy'
  | 'applied'
  | 'rolled-back'
  | 'rollback-failed'
  | 'unchanged'
  | 'undone'
  | 'undo-failed'
  | 'none'
export interface NodeRun {
  /** null: the run did not get to its end (the connection dropped; Look again to see how it ended). */
  result: RunResult | null
  /** Each step's last word: started, skipped, done or failed. */
  steps: { id: string; state: 'start' | 'skip' | 'ok' | 'fail' }[]
  undone: { id: string; ok: boolean }[]
  warnings: string[]
  /** Undo: the work folder it left. */
  kept: string | null
  /** What the steps printed, for the panel: why one failed. */
  said: string[]
}

/** The lines of what the steps printed kept for the panel: an installer says a lot. */
const SAID_MOST = 200

const RESULTS: readonly RunResult[] = [
  'busy',
  'applied',
  'rolled-back',
  'rollback-failed',
  'unchanged',
  'undone',
  'undo-failed',
  'none',
]

export function readNodeRun(lines: readonly string[]): NodeRun {
  const steps = new Map<string, NodeRun['steps'][number]['state']>()
  const undone: NodeRun['undone'] = []
  const warnings: string[] = []
  const said: string[] = []
  let result: RunResult | null = null
  let kept: string | null = null
  for (const line of lines) {
    const [tag, a = '', b = ''] = line.split(' ')
    if (tag === '@@step' && (b === 'start' || b === 'skip' || b === 'ok' || b === 'fail')) steps.set(a, b)
    else if (tag === '@@undo') undone.push({ id: a, ok: b === 'ok' })
    else if (tag === '@@result' && RESULTS.includes(a as RunResult)) result = a as RunResult
    else if (tag === '@@warn') warnings.push(line.slice(7))
    else if (tag === '@@kept') kept = line.slice(7)
    else if (!line.startsWith('@@') && line.trim()) said.push(line)
  }
  return {
    result,
    steps: [...steps].map(([id, state]) => ({ id, state })),
    undone,
    warnings,
    kept,
    said: said.slice(-SAID_MOST),
  }
}
