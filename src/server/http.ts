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
  /** The groups of a RegExp path ('' for one that did not take part). */
  params: string[]
  /** The JSON body ({} when empty), read once. */
  body(): Promise<Body>
  /** A guard's refusal, or null: for the routes that check one after reading the body, as main did. */
  refuse(guard: Guard): Response | null
}

/** Answers, or returns undefined to let the next route in the table answer. */
export type Handler = (req: Request, ctx: RouteContext) => Promise<Response | undefined> | Response | undefined

export interface Route {
  /** ANY: whatever the method (main's session block matched before it looked at the method). */
  method: 'GET' | 'POST' | 'ANY'
  /** A string matches the whole path; a RegExp is tested as it is. */
  path: string | RegExp
  /** Checked in this order before the handler runs. */
  guard?: Guard[]
  handle: Handler
}

/** What the guards check against. */
export interface GuardState {
  port: number
  token: string
  /** True when the data is too old for actions that go through herdr. */
  stale(): boolean
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

const MAX_BODY = 65_536

/** The request's JSON body: {} when empty; over 64 KB or not JSON is an error (a 500). */
export async function readBody(req: Request): Promise<Body> {
  let data = ''
  if (req.body) {
    const decoder = new TextDecoder()
    for await (const chunk of req.body) {
      data += decoder.decode(chunk, { stream: true })
      if (data.length > MAX_BODY) throw new Error('body too large')
    }
    data += decoder.decode()
  }
  if (!data) return {}
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    throw new Error('bad json')
  }
  // main read fields off whatever parsed: null failed (a 500), other non-objects had none.
  if (value === null) throw new Error('bad json')
  return isRecord(value) ? value : {}
}

function check(guard: Guard, req: Request, url: URL, state: GuardState): Response | null {
  switch (guard) {
    case 'board-header':
      return req.headers.get('x-board') === '1' ? null : json(403, { error: 'header' })
    case 'origin': {
      const origin = req.headers.get('origin')
      const own = origin === `http://127.0.0.1:${state.port}` || origin === `http://localhost:${state.port}`
      return origin && !own ? json(403, { error: 'origin' }) : null
    }
    case 'fresh-data':
      return state.stale() ? json(409, { ok: false, error: t('mobile.readOnly') }) : null
    case 'fs-token':
      return url.searchParams.get('t') === state.token ? null : json(403, { error: 'token' })
  }
}

function matches(route: Route, method: string, path: string): RegExpExecArray | string[] | null {
  if (route.method !== 'ANY' && route.method !== method) return null
  if (typeof route.path === 'string') return route.path === path ? [path] : null
  return route.path.exec(path)
}

/** The first route that answers; 405 when none does. */
export async function dispatch(routes: Route[], req: Request, url: URL, path: string, state: GuardState) {
  let body: Promise<Body> | undefined
  for (const route of routes) {
    const match = matches(route, req.method, path)
    if (!match) continue
    const ctx: RouteContext = {
      url,
      path,
      params: match.slice(1).map(group => group ?? ''),
      body: () => {
        body ??= readBody(req)
        return body
      },
      refuse: guard => check(guard, req, url, state),
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
