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

/** The commands a master takes from a node: `board thread` (stage 1, 10 item 6) and `board send` (#619). */
export const UPLINK_COMMANDS: ReadonlySet<string> = new Set(['thread', 'threads', 'send'])

/** The exit code of a call the master does not take, whatever the node sent. */
export const UPLINK_REFUSED = 126

/**
 * The subcommands of `board thread` that are writes which can wait: kept in the node's outbox
 * until the master is reachable, and delivered once. Every other one is not kept.
 */
export const KEPT_SUBS: ReadonlySet<string> = new Set(['post', 'ask', 'done', 'new', 'set', 'watch', 'unwatch'])

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

export interface UplinkCall {
  id: string
  cmd: string
  argv: string[]
  /** The session's key on the node; '' outside a session, which the master refuses. */
  session: string
  /** The lane the node says the session has; the master takes its card's instead when it has one. */
  lane: string | null
  files: UplinkFile[]
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

/** A call as it came on the stream, or null when it is not one. */
export function uplinkCallOf(raw: unknown): UplinkCall | null {
  if (!isObject(raw)) return null
  const { id, cmd, argv, session, lane, files } = raw
  if (!isCallId(id) || !isText(cmd, 64)) return null
  if (!Array.isArray(argv) || argv.length > ARGV_MAX || !argv.every(a => isText(a, ARG_MAX))) return null
  if (!isText(session, 1024) || hasUnprintable(session)) return null
  if (lane !== null && lane !== undefined && !isText(lane, 64)) return null
  const list = files === undefined ? [] : Array.isArray(files) && files.length <= FILES_MAX ? files.map(fileOf) : null
  if (!list || list.some(f => f === null)) return null
  const got = list as UplinkFile[]
  if (new Set(got.map(f => f.n)).size !== got.length) return null
  return { id, cmd, argv: argv as string[], session, lane: lane ?? null, files: got }
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

/** A file too large for a thread, in the words a local post uses (services/work-threads.ts copyFiles). */
export function fileTooBig(name: string, size: number): string | null {
  return size > FILE_MAX_BYTES ? `${name}: ${Math.ceil(size / 1048576)} MB; 5 MB at most on a local thread` : null
}

/** A refusal as a result. */
export const refused = (line: string): UplinkResult => ({ code: UPLINK_REFUSED, out: [], err: [line] })
