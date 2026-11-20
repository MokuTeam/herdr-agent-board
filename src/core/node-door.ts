// The master door on a node (#498, docs/design/nodes 6.1, 6.2): which of the board's routes its
// master may call through it, as data, and the refusal of everything else. No I/O: the door itself
// is server/node-listener.ts.
//
// An allowlist, not a list of refusals: a route the board gains later is not reachable through the
// door until someone adds it here. What is not on the list answers 404, so the door does not say
// what the board has. The routes of later tasks (launch, bundle, sink, uplink, update, leave, claim)
// are added by those tasks.

/** The version of the node link (6.5): the master places work only on a node whose own equals its. */
export const NODE_API = 1

export interface DoorRoute {
  method: 'GET' | 'POST'
  /**
   * A string matches the path as it came and decoded, both; a RegExp is tested on the path as it
   * came, still percent-encoded, as the board's own RegExp routes are (server/http.ts), so a key
   * with `/` in it (a pi session's file) is one segment there.
   */
  path: string | RegExp
  /** Served on the door only (GET /api/node/status), not by the board's route list. */
  door?: true
}

/** A session's key in the path as it came: one segment, percent-encoded. */
const KEY = '[^/]+'
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
  // The node's facts (6.3), on this door only.
  { method: 'GET', path: '/api/node/status', door: true },
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
