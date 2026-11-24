// The master door on a node (#498, docs/design/nodes 6.1, 6.2): which of the board's routes its
// master may call through it, as data, and the refusal of everything else. No I/O: the door itself
// is server/node-listener.ts.
//
// An allowlist, not a list of refusals: a route the board gains later is not reachable through the
// door until someone adds it here. What is not on the list answers 404, so the door does not say
// what the board has. The routes of later tasks (claim) are added by those tasks.

/** The version of the node link (6.5): the master places work only on a node whose own equals its. */
export const NODE_API = 1

export interface DoorRoute {
  method: 'GET' | 'POST' | 'PUT'
  /**
   * A string matches the path as it came and decoded, both; a RegExp is tested on the path as it
   * came, still percent-encoded, as the board's own RegExp routes are (server/http.ts), so a key
   * with `/` in it (a pi session's file) is one segment there.
   */
  path: string | RegExp
  /** Served on the door only (server/routes/node.ts), not by the board's route list. */
  door?: true
}

/** A session's key in the path as it came: one segment, percent-encoded. */
const KEY = '[^/]+'
/** A Claude session id in a move's path (#616). */
const MOVE_SESSION = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const session = (rest: string): RegExp => new RegExp(`^/api/session/${KEY}${rest}$`)

/** What the master may call (6.2). Not `shell/focus`, `/api/fs/open`, `/api/reveal` or `/api/open-url`: they act on this computer's screen. */
export const DOOR_ROUTES: readonly DoorRoute[] = [
  // Identity and versions, answered before the token (with `node` added) by the door itself.
  { method: 'GET', path: '/api/hello' },
  // The node's payload.
  { method: 'GET', path: '/api/events' },
  { method: 'GET', path: '/api/board' },
  // The card and its sheet.
  { method: 'GET', path: session('') },
  { method: 'GET', path: session('/(changes|history|meter)') },
  {
    method: 'POST',
    path: session('/(answer|permit|stop|sendnow|message|wake|sleep|restart|rename|workspace|card|archive|fork|aside)'),
  },
  // The bulk actions, with the node's own keys.
  { method: 'POST', path: '/api/sleep' },
  { method: 'POST', path: '/api/move' },
  { method: 'POST', path: '/api/archive' },
  { method: 'POST', path: '/api/todos' },
  // The terminal: its stream is a GET, the rest are POSTs.
  { method: 'GET', path: new RegExp(`^/api/term/${KEY}/(agent|shell)/stream$`) },
  { method: 'POST', path: new RegExp(`^/api/term/${KEY}/(agent|shell)/(open|close|input)$`) },
  // File chips, quick look, a file sent with a message.
  { method: 'POST', path: '/api/fs/stat' },
  { method: 'POST', path: '/api/fs/preview' },
  { method: 'POST', path: '/api/fs/dirs' },
  { method: 'GET', path: '/api/fs/raw' },
  { method: 'GET', path: '/api/fs/download' },
  { method: 'GET', path: /^\/uploads\/\d{4}-\d{2}-\d{2}\/[^/]+$/ },
  { method: 'POST', path: '/api/upload' },
  // Schedule entries of the node's sessions.
  { method: 'POST', path: '/api/schedule' },
  // The owner's answer to a secret form of a node session.
  { method: 'POST', path: /^\/api\/secret\/[0-9a-f]{12}$/ },
  // A launch's card: trust, dismiss.
  { method: 'GET', path: '/api/launch/options' },
  { method: 'POST', path: /^\/api\/launch\/[\w-]+\/(trust|dismiss)$/ },
  // The node's facts (6.3) and a start from the master (6.4), on this door only.
  { method: 'GET', path: '/api/node/status', door: true },
  { method: 'POST', path: '/api/node/launch', door: true },
  // The profile bundle (9.3): what the node has, a blob by its hash, the commit.
  { method: 'GET', path: new RegExp(`^/api/node/bundle/${KEY}$`), door: true },
  { method: 'PUT', path: new RegExp(`^/api/node/bundle/${KEY}/blob/[0-9a-f]{64}$`), door: true },
  { method: 'POST', path: new RegExp(`^/api/node/bundle/${KEY}/commit$`), door: true },
  // The secrets the profile needs, for a node its owner lets have them (#604): names and values, never kept on the master.
  { method: 'POST', path: new RegExp(`^/api/node/bundle/${KEY}/secrets$`), door: true },
  // Calls from this node's sessions to the master (#508): their stream, a file a call names by its
  // number, and the master's result.
  { method: 'GET', path: '/api/node/uplink', door: true },
  { method: 'GET', path: /^\/api\/node\/uplink\/[A-Za-z0-9_-]{1,64}\/file\/\d{1,2}$/, door: true },
  { method: 'POST', path: /^\/api\/node\/uplink\/[A-Za-z0-9_-]{1,64}$/, door: true },
  // A secret the owner gives one of the node's sinks with no request (10, item 3).
  { method: 'POST', path: /^\/api\/node\/sink\/[a-z0-9][a-z0-9_-]{0,39}$/, door: true },
  // The master revokes this node (#510, 11.4): its sessions to sleep when asked, then it is forgotten.
  { method: 'POST', path: '/api/node/leave', door: true },
  // A session moved to or from another device (#616): the source's pack, a file of it, the call-off
  // and the finish; the target's check, a blob by its hash, the commit, the settle, its start's state.
  { method: 'POST', path: '/api/node/move/out', door: true },
  { method: 'GET', path: new RegExp(`^/api/node/move/out/${MOVE_SESSION}/file/\\d{1,5}$`), door: true },
  { method: 'POST', path: new RegExp(`^/api/node/move/out/${MOVE_SESSION}/(abort|finish)$`), door: true },
  { method: 'POST', path: '/api/node/move/in/check', door: true },
  { method: 'PUT', path: /^\/api\/node\/move\/in\/blob\/[0-9a-f]{64}$/, door: true },
  { method: 'POST', path: '/api/node/move/in/commit', door: true },
  { method: 'POST', path: '/api/node/move/in/settle', door: true },
  { method: 'GET', path: /^\/api\/node\/move\/in\/launch\/[\w-]{1,64}$/, door: true },
  // The plugin at the master's commit (#590, 6.2): its archive, then `{ commit, sha256 }`.
  { method: 'PUT', path: '/api/node/update/blob', door: true },
  { method: 'POST', path: '/api/node/update', door: true },
  // MokuPilot call agent running on this node (#618): check, start, SSE stream, stdin, MCP reply, close, files, report.
  { method: 'POST', path: '/api/node/pilot-call/check', door: true },
  { method: 'POST', path: '/api/node/pilot-call/start', door: true },
  { method: 'GET', path: /^\/api\/node\/pilot-call\/[A-Za-z0-9_-]{8,64}\/events$/, door: true },
  { method: 'POST', path: /^\/api\/node\/pilot-call\/[A-Za-z0-9_-]{8,64}\/(stdin|mcp-reply|close)$/, door: true },
  { method: 'POST', path: '/api/node/pilot-call/files', door: true },
  { method: 'POST', path: '/api/node/pilot-call/report', door: true },
  // Activate a newly staged relay dial key after claim rotation (#513).
  { method: 'POST', path: '/api/node/relay-key', door: true },
  // Guided master handover (#697): preflight, backup/prepare, bundle, apply, verify, commit, rollback, re-pair.
  { method: 'GET', path: '/api/node/handover/check', door: true },
  { method: 'POST', path: '/api/node/handover/prepare', door: true },
  { method: 'PUT', path: '/api/node/handover/bundle', door: true },
  { method: 'POST', path: '/api/node/handover/apply', door: true },
  { method: 'POST', path: '/api/node/handover/verify', door: true },
  { method: 'POST', path: '/api/node/handover/commit', door: true },
  { method: 'POST', path: '/api/node/handover/rollback', door: true },
  { method: 'POST', path: '/api/node/handover/pair', door: true },
  { method: 'POST', path: '/api/node/handover/unpair', door: true },
]

const allows = (r: DoorRoute, method: string, rawPath: string, path: string): boolean =>
  r.method === method && (typeof r.path === 'string' ? r.path === rawPath && r.path === path : r.path.test(rawPath))

/** The door's route a request is, or null. `path` is `rawPath` decoded. */
export function doorRoute(method: string, rawPath: string, path: string): DoorRoute | null {
  return DOOR_ROUTES.find(r => allows(r, method, rawPath, path)) ?? null
}

/**
 * Why the door does not take a request, or null when it does. Checked on the path as it came and
 * decoded, so an encoded letter (`/api/fs/%6Fpen`, `/api/%72emote`) is no way past it: a string
 * route must be both spellings, and a RegExp one's fixed parts are plain letters in the path as it
 * came. Anything not on the list is 404 `not found`, the board's own answer for a route it lacks.
 */
export function doorRefusal(method: string, rawPath: string, path: string): { status: 404; error: 'not found' } | null {
  return doorRoute(method, rawPath, path) ? null : { status: 404, error: 'not found' }
}

/** The names a request to the door may carry in its Host: this computer's loopback. */
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Whether a Host (lower-cased) names this computer's loopback: 127.0.0.1, localhost or [::1], with
 * any port or none. The port is not checked: a forward the master keeps up lands on whatever local
 * port is free. A page of another site that resolves to loopback carries its own name and fails.
 */
export function loopbackHost(host: string): boolean {
  const m = /^(\[[^\]]*\]|[^:[\]]*)(?::(\d{1,5}))?$/.exec(host)
  return m !== null && LOOPBACK_NAMES.has(m[1] ?? '')
}
