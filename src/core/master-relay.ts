// The node->master relay, "master relay" (#764, epic #763): what a node passes up to its master over the link, and
// how it travels. No I/O: the node's side is services/node/master-relay.ts, the master's
// services/nodes/master-relay.ts, and both read the declared table here, so the master never takes a path
// only because the node sent it.
//
// The table names the master-owned paths, one group at a time (T1: threads; T4a, #780: time,
// calendar, journal, presence, their settings and the categories). A node also passes up
// a request that names another machine's session (`/api/session/@<device>:<key>/...`), which the
// master hands to its own node proxy.
//
// Only the master dials (the door), so a request rides a stream the master holds open on the node's
// door, as the MokuPilot bridge does (#700):
//   node -> master  `event: req`   { id, method, path, headers, who, idem?, body? | hasBody? }
//                   `event: close` { id }   the caller went away
//   master -> node  POST /api/node/master-relay/res/<id>     { status, headers, body?, more? }
//                   POST /api/node/master-relay/stream/<id>  { data?, done?, error? }   when `more`
//                   GET  /api/node/master-relay/req/<id>/body                         a large body
// Bodies and chunks are base64, so any bytes cross. Each side reads the other's messages field by
// field.
//
// The machines are one mesh of the owner's (epic #763): the master takes a device's relayed requests
// as the owner's unless its owner turned that off for it (`nodes.devices.<id>.owner: false`, a
// switch only the owner at the master or its owner-admin login (#694) can set; then 403
// master-relay-owner, every request). Any process on such a device, an agent too, can be the owner
// by naming no session. Who a relayed request is (`who`), decided by the node and checked again by
// the master, only narrows it:
// - a session: the caller named one of the node's own sessions (`X-Board-Session`), as the uplink's
//   `board` calls do (#508). It reads (threads, any machine's session) but never writes: an HTTP
//   write is recorded as the owner's, and a session writes with `board thread` and `board send`.
// - the owner: the node's own page or a sessionless terminal, held to what the owner may do from
//   away (server/streams.ts remoteRefusal): nothing on the master's screen, and of the panels kept
//   for the master's own computer (localOnly) only the settings of the features it runs for the
//   whole mesh (RELAY_OWNER_SETTINGS, #780), each write of them in the master's admin log.
// - never a Team peer, nor a caller through the node's own remote listeners (403 master-relay-remote).
import { keyedPath } from './node-proxy.ts'
import { hasUnprintable } from './team.ts'

export type RelayMethod = 'GET' | 'POST'

export interface RelayEntry {
  /** The feature group the path belongs to (T4 moves the others one group at a time). */
  group: string
  method: RelayMethod
  /** Tested on the path as it came (still percent-encoded), without the query. */
  path: RegExp
  /** A long answer the caller reads as it comes (SSE). */
  stream?: true
  /**
   * The master answers it for a node only (server/app.ts replayRelayed), never in its route table:
   * the payload's master-run parts and a sessionless terminal's command (#780).
   */
  relayOnly?: true
}

/**
 * The master-owned paths a node relays. A write (POST) carries an idempotency key; a session may
 * use the GETs only. T4a (#780): time, calendar, journal, presence, these features' settings and
 * the categories. Decisions stay on the node until its sessions' questions live on the master (#781).
 */
export const RELAY_TABLE: readonly RelayEntry[] = [
  { group: 'threads', method: 'GET', path: /^\/api\/threads$/ },
  { group: 'threads', method: 'GET', path: /^\/api\/threads\/events$/, stream: true },
  { group: 'threads', method: 'GET', path: /^\/api\/threads\/[^/]+$/ },
  { group: 'threads', method: 'POST', path: /^\/api\/threads$/ },
  { group: 'threads', method: 'POST', path: /^\/api\/threads\/[^/]+$/ },
  { group: 'time', method: 'GET', path: /^\/api\/time$/ },
  { group: 'time', method: 'POST', path: /^\/api\/time$/ },
  { group: 'time', method: 'GET', path: /^\/api\/time-settings$/ },
  { group: 'time', method: 'POST', path: /^\/api\/time-settings$/ },
  { group: 'calendar', method: 'GET', path: /^\/api\/calendar$/ },
  { group: 'calendar', method: 'POST', path: /^\/api\/calendar$/ },
  { group: 'calendar', method: 'GET', path: /^\/api\/calendar-settings$/ },
  { group: 'calendar', method: 'POST', path: /^\/api\/calendar-settings$/ },
  { group: 'calendar', method: 'POST', path: /^\/api\/calendar-reminders$/ },
  { group: 'journal', method: 'GET', path: /^\/api\/journal$/ },
  { group: 'journal', method: 'POST', path: /^\/api\/journal$/ },
  { group: 'presence', method: 'GET', path: /^\/api\/presence$/ },
  { group: 'presence', method: 'POST', path: /^\/api\/presence$/ },
  { group: 'settings', method: 'POST', path: /^\/api\/feature-settings$/ },
  { group: 'settings', method: 'GET', path: /^\/api\/threads-settings$/ },
  { group: 'settings', method: 'POST', path: /^\/api\/threads-settings$/ },
  { group: 'settings', method: 'POST', path: /^\/api\/categories$/ },
  { group: 'payload', method: 'GET', path: /^\/api\/board-slices$/, relayOnly: true },
  { group: 'cli', method: 'POST', path: /^\/api\/node-cli$/, relayOnly: true },
]

/** The relay-only paths (RelayEntry.relayOnly), as the master answers them. */
export const BOARD_SLICES_PATH = '/api/board-slices'
export const NODE_CLI_PATH = '/api/node-cli'

/** The payload's master-run parts a node's page shows as the master has them (#780). */
export const BOARD_SLICE_KEYS = ['time', 'calendar', 'journal', 'presence'] as const
export type BoardSliceKey = (typeof BOARD_SLICE_KEYS)[number]

/** The commands a sessionless terminal on a node runs on the master as the owner (#780). */
export const OWNER_CLI_COMMANDS: ReadonlySet<string> = new Set([
  'time',
  'cal',
  'journal',
  'presence',
  'away',
  'decisions',
  'cats',
])

/** A sessionless terminal's command as the node sends it up: the lane is the one its folder maps to there. */
export interface OwnerCli {
  cmd: string
  argv: string[]
  lane?: string
}

/** A sessionless terminal's command as the node sends it up, or null. */
export function ownerCliOf(raw: unknown): OwnerCli | null {
  if (!isObject(raw)) return null
  const { cmd, argv, lane } = raw
  if (typeof cmd !== 'string' || !OWNER_CLI_COMMANDS.has(cmd)) return null
  if (!Array.isArray(argv) || argv.length > 64) return null
  if (!argv.every(a => typeof a === 'string' && a.length <= 8192 && !a.includes('\0'))) return null
  if (
    lane !== undefined &&
    lane !== null &&
    (typeof lane !== 'string' || !lane || lane.length > 64 || hasUnprintable(lane))
  )
    return null
  return { cmd, argv: argv as string[], ...(typeof lane === 'string' && { lane }) }
}

/** Whether a path is one of the table's (#780). */
export const relayTablePath = (method: string, rawPath: string): boolean =>
  RELAY_TABLE.some(e => e.method === method && e.path.test(rawPath))

/**
 * The settings a relayed owner's request reaches past the master's localOnly (#780): those of the
 * features the master runs for every machine. Nothing else kept for the master's own computer, and
 * never a session's request.
 */
export const RELAY_OWNER_SETTINGS: ReadonlySet<string> = new Set([
  '/api/time-settings',
  '/api/calendar-settings',
  '/api/feature-settings',
  '/api/threads-settings',
])

/** Whether a relayed request by `who` passes the master's localOnly refusal for `rawPath`. */
export const relayOwnerSetting = (method: string, rawPath: string, who: RelayWho | undefined): boolean =>
  who?.kind === 'owner' && RELAY_OWNER_SETTINGS.has(rawPath) && relayTablePath(method, rawPath)

/** What a request is to the relay: a path of the table, or another machine's session. */
export type RelayMatch = { kind: 'table'; entry: RelayEntry } | { kind: 'keyed'; device: string }

/**
 * The relay's reading of a request (its path as it came, no query), or null when it is not the
 * relay's. `skip(device)`: a device whose session keys stay here (this node itself, a node of this
 * board's own when it is a master too).
 */
export function relayMatch(method: string, rawPath: string, skip: (device: string) => boolean): RelayMatch | null {
  if (method !== 'GET' && method !== 'POST') return null
  const entry = RELAY_TABLE.find(e => e.method === method && e.path.test(rawPath))
  if (entry) return { kind: 'table', entry }
  const keyed = keyedPath(rawPath)
  if (keyed?.area !== 'session' || skip(keyed.device)) return null
  return { kind: 'keyed', device: keyed.device }
}

/** The request headers that go up: what the master's routes read. Never a cookie, Origin or Authorization. */
export const RELAY_REQUEST_HEADERS: readonly string[] = ['content-type', 'accept', 'last-event-id', 'x-board']

/** The answer headers that come back. */
export const RELAY_ANSWER_HEADERS: readonly string[] = [
  'content-type',
  'content-disposition',
  'cache-control',
  'x-content-type-options',
  'retry-after',
]

/** The header a caller names the session it is with. */
export const SESSION_HEADER = 'x-board-session'
/** The header a caller keys a write with; one the node makes when there is none. */
export const IDEMPOTENCY_HEADER = 'idempotency-key'

/** A body this large or smaller rides in the request event; a larger one the master fetches. */
export const RELAY_INLINE_BYTES = 64 * 1024
/** The largest request body the node takes (the master's routes take 192 KB). */
export const RELAY_BODY_MAX = 1024 * 1024
/** The largest answer that is not a stream. */
export const RELAY_ANSWER_MAX = 4 * 1024 * 1024
/** The largest stream chunk, before base64. */
export const RELAY_CHUNK_MAX = 512 * 1024

/** The refusals and failures, as the caller reads them. */
export const RELAY_ERRORS = {
  offline: 'node-master-offline',
  timeout: 'master-relay-timeout',
  owner: 'master-relay-owner',
  session: 'master-relay-session',
  sessionWrite: 'master-relay-session-write',
  remote: 'master-relay-remote',
  path: 'master-relay-path',
  loop: 'master-relay-loop',
  busy: 'master-relay-busy',
  tooBig: 'master-relay-too-big',
  unknown: 'master-relay-unknown',
  idemMismatch: 'master-relay-idempotency-mismatch',
  badIdem: 'master-relay-bad-idempotency-key',
} as const

/** The plain reason beside each code. */
export const RELAY_MESSAGES: Readonly<Record<string, string>> = {
  [RELAY_ERRORS.offline]:
    'The master board is not reachable from this computer now. This is served by the master; try again once it is back.',
  [RELAY_ERRORS.timeout]: 'The master board did not answer in time.',
  [RELAY_ERRORS.owner]:
    "The master's owner turned off requests from this computer (nodes.devices.<id>.owner: false in the master's config.json).",
  [RELAY_ERRORS.session]: 'The session named in X-Board-Session is not a session of this computer.',
  [RELAY_ERRORS.sessionWrite]: 'A session reads through the relay but does not write: use board thread in the session.',
  [RELAY_ERRORS.remote]: "This is served by the master board: open it on this computer's own page or on the master.",
  [RELAY_ERRORS.path]: 'The master does not take this path from a node.',
  [RELAY_ERRORS.loop]: "A node's own session is not asked through its master.",
  [RELAY_ERRORS.busy]: 'Too many requests from this computer at once.',
  [RELAY_ERRORS.unknown]:
    'The link to the master went before its answer: the write may or may not have been done. Check before trying again, or retry with the same Idempotency-Key.',
  [RELAY_ERRORS.badIdem]: 'Idempotency-Key is 1 to 64 letters, digits, "-" or "_".',
  [RELAY_ERRORS.idemMismatch]: 'This Idempotency-Key was used for another request.',
  [RELAY_ERRORS.tooBig]: 'The request or its answer is too large for the relay.',
}

/** A relay refusal or failure as its JSON body. */
export const relayError = (code: string): { ok: false; error: string; message: string } => ({
  ok: false,
  error: code,
  message: RELAY_MESSAGES[code] ?? code,
})

export type RelayWho = { kind: 'owner' } | { kind: 'session'; key: string }

export interface RelayRequest {
  id: string
  method: RelayMethod
  /** The path as it came, with its query. */
  path: string
  headers: Record<string, string>
  who: RelayWho
  /** A write's idempotency key. */
  idem?: string
  /** The body, base64, when it rides inline. */
  body?: string
  /** The body is fetched from the node. */
  hasBody?: true
  /** A fetched body's SHA-256 (hex): what the master checks it by and keys a write with. */
  bodySha?: string
}

export interface RelayHead {
  status: number
  headers: Record<string, string>
  /** The whole body, base64, when `more` is not set. */
  body?: string
  /** The body follows as stream chunks. */
  more?: true
}

export interface RelayChunk {
  data?: string
  done?: true
  error?: string
}

/** A relay id: a request's, also its stream's. */
const ID = /^[A-Za-z0-9_-]{8,64}$/
export const isRelayId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
/** An idempotency key: the uplink's call id rule (core/node-uplink.ts). */
const IDEM = /^[A-Za-z0-9_-]{1,64}$/
export const isIdemKey = (v: unknown): v is string => typeof v === 'string' && IDEM.test(v)
const B64 = /^[A-Za-z0-9+/]*={0,2}$/
const isB64 = (v: unknown, maxBytes: number): v is string =>
  typeof v === 'string' && v.length % 4 === 0 && v.length <= Math.ceil(maxBytes / 3) * 4 && B64.test(v)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** The longest path, with its query, a request may carry. */
export const RELAY_PATH_MAX = 4096
const HEADER_VALUE_MAX = 4096

/** Only `names`, each a short printable string. */
function headersOf(raw: unknown, names: readonly string[]): Record<string, string> | null {
  if (raw === undefined) return {}
  if (!isObject(raw)) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    const name = k.toLowerCase()
    if (!names.includes(name)) continue
    if (typeof v !== 'string' || v.length > HEADER_VALUE_MAX || /[\r\n\0]/.test(v)) return null
    out[name] = v
  }
  return out
}

function whoOf(raw: unknown): RelayWho | null {
  if (!isObject(raw)) return null
  if (raw.kind === 'owner') return { kind: 'owner' }
  if (
    raw.kind === 'session' &&
    typeof raw.key === 'string' &&
    raw.key &&
    raw.key.length <= 1024 &&
    !hasUnprintable(raw.key)
  )
    return { kind: 'session', key: raw.key }
  return null
}

/** A request as it came on the stream, or null. */
export function relayRequestOf(raw: unknown): RelayRequest | null {
  if (!isObject(raw)) return null
  const { id, method, path, headers, who, idem, body, hasBody, bodySha } = raw
  if (!isRelayId(id) || (method !== 'GET' && method !== 'POST')) return null
  if (
    typeof path !== 'string' ||
    !path.startsWith('/api/') ||
    path.length > RELAY_PATH_MAX ||
    /[\s\0#]/.test(path) ||
    !plainPath(rawPathOf(path))
  )
    return null
  const h = headersOf(headers, RELAY_REQUEST_HEADERS)
  const w = whoOf(who)
  if (!h || !w) return null
  if (idem !== undefined && !isIdemKey(idem)) return null
  if (body !== undefined && !isB64(body, RELAY_INLINE_BYTES)) return null
  if (hasBody !== undefined && hasBody !== true) return null
  if (body !== undefined && hasBody) return null
  if (hasBody !== true ? bodySha !== undefined : typeof bodySha !== 'string' || !/^[0-9a-f]{64}$/.test(bodySha))
    return null
  return {
    id,
    method,
    path,
    headers: h,
    who: w,
    ...(idem !== undefined && { idem }),
    ...(body !== undefined && { body }),
    ...(hasBody === true && { hasBody: true as const, bodySha: bodySha as string }),
  }
}

/** An answer's head as the master posted it, or null. */
export function relayHeadOf(raw: unknown): RelayHead | null {
  if (!isObject(raw)) return null
  const { status, headers, body, more } = raw
  if (!Number.isInteger(status) || (status as number) < 200 || (status as number) > 599) return null
  const h = headersOf(headers, RELAY_ANSWER_HEADERS)
  if (!h) return null
  if (more !== undefined && more !== true) return null
  if (body !== undefined && (more || !isB64(body, RELAY_ANSWER_MAX))) return null
  return {
    status: status as number,
    headers: h,
    ...(body !== undefined && { body }),
    ...(more === true && { more: true as const }),
  }
}

/** A stream chunk as the master posted it, or null. */
export function relayChunkOf(raw: unknown): RelayChunk | null {
  if (!isObject(raw)) return null
  const { data, done, error } = raw
  if (data !== undefined && !isB64(data, RELAY_CHUNK_MAX)) return null
  if (done !== undefined && done !== true) return null
  if (error !== undefined && (typeof error !== 'string' || error.length > 1024)) return null
  return {
    ...(data !== undefined && { data }),
    ...(done === true && { done: true as const }),
    ...(error !== undefined && { error }),
  }
}

/** The path without its query, as the table tests it. */
/**
 * Whether a path (as it came, no query) is dispatched as it reads: no backslash, no "." or ".."
 * segment in any spelling, nothing a URL parser would fold into another path. The master holds a
 * node's path to the table only once it is plain, so the path it checks is the path it runs.
 */
export function plainPath(raw: string): boolean {
  if (raw.includes('\\') || /%5c/i.test(raw)) return false
  // A letter, digit or -._~ spelled as %XX reads as another path to a string route
  // (`/api/threads/%65vents` is `/api/threads/events`): one spelling only.
  for (const m of raw.matchAll(/%([0-9a-f]{2})/gi))
    if (/[A-Za-z0-9\-._~]/.test(String.fromCharCode(Number.parseInt(m[1] ?? '', 16)))) return false
  for (const seg of raw.split('/')) {
    let word: string
    try {
      word = decodeURIComponent(seg)
    } catch {
      return false
    }
    if (word === '.' || word === '..') return false
  }
  try {
    return new URL(`http://relay.invalid${raw}`).pathname === raw
  } catch {
    return false
  }
}

export const rawPathOf = (path: string): string => {
  const q = path.indexOf('?')
  return q < 0 ? path : path.slice(0, q)
}

/**
 * The path the master runs for a keyed request: a key of the master's own device loses its
 * prefix (the master knows its own sessions by their bare keys); any other stays for the node proxy.
 */
export function masterPath(path: string, selfId: string): string {
  const raw = rawPathOf(path)
  const keyed = keyedPath(raw)
  if (!keyed || !selfId || keyed.device !== selfId) return path
  return `/api/${keyed.area}/${encodeURIComponent(keyed.key)}${keyed.rest}${path.slice(raw.length)}`
}
