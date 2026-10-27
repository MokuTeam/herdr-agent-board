// The route table and what every route shares: JSON answers, the request's JSON body, and the
// guards. Routes are tried in order and the first that answers wins, as main's `if` chain did.
import { isRecord } from '../adapters/json-store.ts'
import { t } from '../core/lang.ts'

/**
 * board-header: POSTs carry `X-Board: 1`, which a page on another site cannot send without a CORS
 * preflight (never granted). origin: a browser's Origin, when it sends one, is this board's.
 * fresh-data: the board's herdr data is recent enough to act on. fs-token: the per-run file token.
 */
export type Guard = 'board-header' | 'origin' | 'fresh-data' | 'fs-token'

export type Body = Record<string, unknown>

export interface RouteContext {
  url: URL
  /** The decoded path. */
  path: string
  /**
   * The path as it came, still percent-encoded: a session key with `/` in it (a pi session's is its
   * file) is one segment only here.
   */
  rawPath: string
  /** The groups of a RegExp path, each decoded ('' for one that did not take part). */
  params: string[]
  /** The TCP peer's address as the listener sees it ('' unknown), asked only by a route that needs it. */
  peer(): string
  /** The JSON body as it parsed ({} when empty), read once: for code that takes any value. */
  rawBody(): Promise<unknown>
  /** The body's fields. main read them off the body, so null fails here (a 500); other non-objects have none. */
  body(): Promise<Body>
  /** A guard's refusal, or null: for the routes that check one after reading the body, as main did. */
  refuse(guard: Guard): Response | null
  /**
   * Whether `target`, a path the request named, is one of the board's own files that this
   * listener does not read (GuardState.ownFiles): asked with the very path the route then reads.
   */
  ownFile(target: string): boolean
}

/** Answers, or returns undefined to let the next route in the table answer. */
export type Handler = (req: Request, ctx: RouteContext) => Promise<Response | undefined> | Response | undefined

export interface Route {
  /** ANY: whatever the method (main's session block matched before it looked at the method). */
  method: 'GET' | 'POST' | 'ANY'
  /**
   * A string matches the whole decoded path; a RegExp is tested on the path as it came (encoded),
   * so `([^/]+)` takes a whole key even when the key has a `/`, and its groups are decoded.
   */
  path: string | RegExp
  /** Checked in this order before the handler runs. */
  guard?: Guard[]
  handle: Handler
}

/** What the guards check against. */
export interface GuardState {
  port: number
  /** Origins besides the board's own on 127.0.0.1: its HTTPS name through `tailscale serve` (core/pwa.ts). */
  origins?: readonly string[]
  token: string
  /** True when the data is too old for actions that go through herdr. */
  stale(): boolean
  /**
   * The board's own files (adapters/own-files.ts), which the routes that read by a path refuse.
   * Set by the tunnel listener only: on the others every path reads as before.
   */
  ownFiles?: (target: string) => boolean
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** A JSON answer that is never cached. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/** Text that is JSON already (the board payload), answered as json() would. */
export function jsonText(text: string): Response {
  return new Response(text, { status: 200, headers: JSON_HEADERS })
}

// The terminal's input: 16 K characters of text, each up to three bytes, and JSON's escapes.
const MAX_BODY = 192 << 10

/**
 * The request's JSON body: {} when empty; over 192 KB or not JSON is an error (a 500). The bytes
 * are counted, and decoded as one stream: a character split between two chunks stays whole (the
 * terminal types what it gets).
 */
export async function readBody(req: Request): Promise<unknown> {
  let data = ''
  if (req.body) {
    const decoder = new TextDecoder()
    let size = 0
    for await (const chunk of req.body) {
      size += chunk.length
      if (size > MAX_BODY) throw new Error('body too large')
      data += decoder.decode(chunk, { stream: true })
    }
    data += decoder.decode()
  }
  if (!data) return {}
  try {
    return JSON.parse(data)
  } catch {
    throw new Error('bad json')
  }
}

/** The fields of a parsed body, as main read them: off null that threw, off other non-objects there were none. */
function fieldsOf(value: unknown): Body {
  if (value === null) throw new TypeError('Cannot read properties of null')
  return isRecord(value) ? value : {}
}

function check(guard: Guard, req: Request, url: URL, state: GuardState): Response | null {
  switch (guard) {
    case 'board-header':
      return req.headers.get('x-board') === '1' ? null : json(403, { error: 'header' })
    case 'origin': {
      const origin = req.headers.get('origin')
      const own =
        origin === `http://127.0.0.1:${state.port}` ||
        origin === `http://localhost:${state.port}` ||
        (!!origin && !!state.origins?.includes(origin))
      return origin && !own ? json(403, { error: 'origin' }) : null
    }
    case 'fresh-data':
      return state.stale() ? json(409, { ok: false, error: t('mobile.readOnly') }) : null
    case 'fs-token':
      return url.searchParams.get('t') === state.token ? null : json(403, { error: 'token' })
  }
}

function matches(route: Route, method: string, path: string, rawPath: string): string[] | null {
  if (route.method !== 'ANY' && route.method !== method) return null
  if (typeof route.path === 'string') return route.path === path ? [path] : null
  const match = route.path.exec(rawPath)
  return match?.map(group => (group === undefined ? '' : decodeURIComponent(group))) ?? null
}

/** The request's TCP peer as `srv` (Bun's server) sees it: '' with none, or one it cannot say. */
export function peerOf(srv: { requestIP(req: Request): { address: string } | null } | undefined, req: Request): string {
  try {
    return srv?.requestIP(req)?.address ?? ''
  } catch {
    return ''
  }
}

/** The first route that answers; 405 when none does. `peer`: the listener's requestIP for this request. */
export async function dispatch(
  routes: Route[],
  req: Request,
  url: URL,
  path: string,
  state: GuardState,
  peer: () => string = () => '',
) {
  let parsed: Promise<unknown> | undefined
  const rawBody = (): Promise<unknown> => {
    parsed ??= readBody(req)
    return parsed
  }
  for (const route of routes) {
    const match = matches(route, req.method, path, url.pathname)
    if (!match) continue
    const ctx: RouteContext = {
      url,
      path,
      rawPath: url.pathname,
      params: match.slice(1),
      peer,
      rawBody,
      body: async () => fieldsOf(await rawBody()),
      refuse: guard => check(guard, req, url, state),
      ownFile: target => !!state.ownFiles?.(target),
    }
    for (const guard of route.guard ?? []) {
      const refused = ctx.refuse(guard)
      if (refused) return refused
    }
    const res = await route.handle(req, ctx)
    if (res) return res
  }
  return json(405, { error: 'method' })
}
