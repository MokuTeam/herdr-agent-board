// Calls from a node's sessions to its master (#508, docs/design/nodes 5, 6.2, 10 item 5): what a
// call and its result are on the link, which commands the master takes, and which of them a node
// keeps until the master is reachable. No I/O: the node's side is services/node/uplink.ts, the
// master's services/nodes/uplink.ts.
//
// A call goes up the link as `{ id, cmd, argv, session, lane, files: [{ n, name, size, sha256 }] }`
// and its result comes back as `{ code, out, err }`. Both are read here field by field: neither
// side trusts what the other sends.

import { hasUnprintable } from './team.ts'
import { FILE_MAX_BYTES, FILES_MAX } from './work-threads.ts'

/** The commands a master takes from a node: `board thread` (stage 1, 10 item 6), `board send` (#619), `board agents` (#628), `board time` (#644), shared-state commands (#698), and spawn-agent's start (#760, `spawn`). */
export const UPLINK_COMMANDS: ReadonlySet<string> = new Set([
  'thread',
  'threads',
  'send',
  'agents',
  'time',
  'cal',
  'team',
  'decisions',
  'journal',
  'presence',
  'away',
  'cats',
  'list',
  'remind',
  'every',
  'unschedule',
  'spawn',
])

/** The exit code of a call the master does not take, whatever the node sent. */
export const UPLINK_REFUSED = 126

/**
 * The subcommands of `board thread` that are writes which can wait: kept in the node's outbox
 * until the master is reachable, and delivered once. Every other one is not kept.
 */
export const KEPT_SUBS: ReadonlySet<string> = new Set(['post', 'ask', 'done', 'new', 'set', 'watch', 'unwatch'])

/**
 * The mutating subcommands of `board time` (#644): not kept offline (relative timestamps and
 * conflict checks must run live), but remembered by call id on the master so a retry after a
 * stream hiccup never writes twice.
 */
export const TIME_WRITE_SUBS: ReadonlySet<string> = new Set([
  'add',
  'edit',
  'move',
  'rm',
  'restore',
  'post',
  'unpost',
  'import',
])

/**
 * The mutating subcommands of `board cal` (#698): not kept offline, remembered by call id on the
 * master so a retry after a stream hiccup never writes twice.
 */
export const CAL_WRITE_SUBS: ReadonlySet<string> = new Set(['add', 'edit', 'rm', 'push'])

/**
 * Subcommands of `board team` that are always refused from a node (#698).
 */
export const TEAM_NOT_FROM_NODE: Readonly<Record<string, string>> = {
  join: "board team join sets up this board's team identity: run it on the board's computer, not from a node",
  watch: 'board team watch streams continuously: use board team inbox from a node',
}

/**
 * Whether a `board team` call is refused from a node, and why (#698).
 */
export function teamRefusal(argv: readonly string[]): string | null {
  const sub = argv[0] ?? ''
  if (Object.hasOwn(TEAM_NOT_FROM_NODE, sub)) return TEAM_NOT_FROM_NODE[sub] ?? null
  if (sub === 'listen' && (argv[1] ?? '') !== 'off')
    return 'board team listen is for the owner to confirm: not from a node'
  if (sub === 'loop' && argv.length >= 3)
    return 'board team loop changes an agent switch for the owner to confirm: not from a node'
  return null
}

/**
 * Whether a call is kept in the node's outbox when the master is unreachable (#508, #698).
 */
export function isKeptCall(cmd: string, argv: readonly string[]): boolean {
  if (cmd === 'thread' || cmd === 'threads') return KEPT_SUBS.has(argv[0] ?? '')
  return cmd === 'team' && (argv[0] ?? '') === 'draft'
}

const TEAM_WRITE_SUBS: ReadonlySet<string> = new Set(['draft', 'post', 'reply', 'react', 'assign', 'release', 'listen'])

/**
 * Whether a call's result is remembered by call id on the master so a retry never writes twice (#508, #644, #698).
 */
export function isRememberedCall(cmd: string, argv: readonly string[]): boolean {
  if (isKeptCall(cmd, argv)) return true
  const sub = argv[0] ?? ''
  if (cmd === 'thread' || cmd === 'threads') return sub === 'verdict'
  if (cmd === 'send' || cmd === 'away' || cmd === 'remind' || cmd === 'every' || cmd === 'unschedule') return true
  // spawn-agent's start (#760): a call sent again on a new stream must not start a second session.
  if (cmd === 'spawn') return true
  if (cmd === 'time') return TIME_WRITE_SUBS.has(sub)
  if (cmd === 'cal') return CAL_WRITE_SUBS.has(sub)
  if (cmd === 'team') {
    if (TEAM_WRITE_SUBS.has(sub)) return true
    if (sub === 'thread') {
      const cut = argv.indexOf('--')
      const flags = cut < 0 ? argv.slice(1) : argv.slice(1, cut)
      return flags.includes('--read')
    }
    return false
  }
  if (cmd === 'presence') return argv.length > 0
  return false
}

/**
 * Whether a non-kept uplink call can hit external providers or hubs and needs a longer wait window
 * than a fast local board read (#698).
 */
export function isSlowCall(cmd: string, argv: readonly string[]): boolean {
  const sub = argv[0] ?? ''
  if (cmd === 'cal') return sub === 'sync' || CAL_WRITE_SUBS.has(sub)
  if (cmd === 'team')
    return sub === 'post' || sub === 'reply' || sub === 'assign' || sub === 'release' || sub === 'listen'
  if (cmd === 'time') return sub === 'post' || sub === 'unpost' || sub === 'import'
  return false
}

/**
 * What the master does not run for a node's session, and why: `open` raises the master's own
 * window, `share` is a request the owner confirms (#224: what comes up a link is an agent's), and
 * `import` reads a task board file the call does not carry.
 */
export const NOT_FROM_NODE: Readonly<Record<string, string>> = {
  open: 'board thread open opens the board on its own computer: not from a node',
  share: 'board thread share is for the owner to confirm: not from a node',
  import: 'board thread import is not taken from a node yet',
}

/** How many call ids a master remembers per device, with their results. */
export const UPLINK_SEEN_MAX = 500

/** A call's id: the node's own, also the outbox file's name. */
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/
const SHA256 = /^[0-9a-f]{64}$/
/** The most arguments, and characters in one, a call may carry. */
const ARGV_MAX = 200
const ARG_MAX = 64 * 1024
/** The most lines of a result, and characters in one: the master cuts a longer one to these. */
export const RESULT_LINES_MAX = 2000
export const RESULT_LINE_MAX = 64 * 1024

export const isCallId = (v: unknown): v is string => typeof v === 'string' && CALL_ID.test(v)

/** A file a call names: its number in the call, its name, its size and its SHA-256. */
export interface UplinkFile {
  n: number
  name: string
  size: number
  sha256: string
}

/** The session a verdict runs in on the node, as herdr confirmed it (services/work-verify.ts paneSelf). */
export type UplinkSelf = { key: string } | { why: string }

export interface UplinkCall {
  id: string
  cmd: string
  argv: string[]
  /** The session's key on the node; '' outside a session, which the master refuses. */
  session: string
  /** The lane the node says the session has; the master takes its card's instead when it has one. */
  lane: string | null
  files: UplinkFile[]
  /** For `board thread verdict` (#675): the pane's session as the node's herdr confirmed it. */
  self?: UplinkSelf
  /** For `board team post|reply --session <target>` (#698): session was named explicitly with --session. */
  claimed?: boolean
}

export interface UplinkResult {
  code: number
  out: string[]
  err: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max

/** A file entry of a call, or null. Its name is a name, never a path. */
function fileOf(v: unknown): UplinkFile | null {
  if (!isObject(v)) return null
  const { n, name, size, sha256 } = v
  if (!Number.isInteger(n) || (n as number) < 0 || (n as number) >= FILES_MAX) return null
  if (!isText(name, 255) || !name || /[/\\:]/.test(name) || hasUnprintable(name) || name === '.' || name === '..')
    return null
  if (!Number.isSafeInteger(size) || (size as number) < 0) return null
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return null
  return { n: n as number, name, size: size as number, sha256 }
}

function selfOf(v: unknown): UplinkSelf | null {
  if (!isObject(v)) return null
  const hasKey = Object.hasOwn(v, 'key') && v.key !== undefined
  const hasWhy = Object.hasOwn(v, 'why') && v.why !== undefined
  if (hasKey === hasWhy) return null
  if (hasKey) return isText(v.key, 1024) && v.key && !hasUnprintable(v.key) ? { key: v.key } : null
  return isText(v.why, 512) && v.why && !hasUnprintable(v.why) ? { why: v.why } : null
}

/** A call as it came on the stream, or null when it is not one. */
export function uplinkCallOf(raw: unknown): UplinkCall | null {
  if (!isObject(raw)) return null
  const { id, cmd, argv, session, lane, files, self: rawSelf, claimed } = raw
  if (!isCallId(id) || !isText(cmd, 64)) return null
  if (!Array.isArray(argv) || argv.length > ARGV_MAX || !argv.every(a => isText(a, ARG_MAX))) return null
  if (!isText(session, 1024) || hasUnprintable(session)) return null
  if (lane !== null && lane !== undefined && !isText(lane, 64)) return null
  if (claimed !== undefined && typeof claimed !== 'boolean') return null
  const list = files === undefined ? [] : Array.isArray(files) && files.length <= FILES_MAX ? files.map(fileOf) : null
  if (!list || list.some(f => f === null)) return null
  const got = list as UplinkFile[]
  if (new Set(got.map(f => f.n)).size !== got.length) return null
  const self = rawSelf === undefined || rawSelf === null ? undefined : selfOf(rawSelf)
  if (rawSelf !== undefined && rawSelf !== null && !self) return null
  return {
    id,
    cmd,
    argv: argv as string[],
    session,
    lane: lane ?? null,
    files: got,
    ...(self && { self }),
    ...(claimed !== undefined && { claimed }),
  }
}

/** A result as the master posted it, or null. */
export function uplinkResultOf(raw: unknown): UplinkResult | null {
  if (!isObject(raw)) return null
  const { code, out, err } = raw
  if (!Number.isInteger(code) || (code as number) < 0 || (code as number) > 255) return null
  const lines = (v: unknown): v is string[] =>
    Array.isArray(v) && v.length <= RESULT_LINES_MAX && v.every(l => isText(l, RESULT_LINE_MAX))
  if (!lines(out) || !lines(err)) return null
  return { code: code as number, out, err }
}

/** A file too large for an uplink call, in the words a local command uses. */
export function fileTooBig(name: string, size: number, cmd?: string): string | null {
  if (size <= FILE_MAX_BYTES) return null
  const mb = Math.ceil(size / 1048576)
  if (!cmd || cmd === 'thread' || cmd === 'threads') return `${name}: ${mb} MB; 5 MB at most on a local thread`
  return `${name}: ${mb} MB; 5 MB at most from a node`
}

/** A refusal as a result. */
export const refused = (line: string): UplinkResult => ({ code: UPLINK_REFUSED, out: [], err: [line] })
