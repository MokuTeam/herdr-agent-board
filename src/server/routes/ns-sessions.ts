// The NetSuite session store's routes (#860, core/ns-sessions.ts, contract ns-contract-final.md in
// thread agent-board-149): what a MokuTab bridge calls on its own board, at the URL its
// ns-store.json names. On the master the store answers; a node checks the bridge's token itself
// and relays the rest up as the owner (core/master-relay.ts, group ns-sessions), so a laptop's
// bridge reaches the master's store. Any 503 means "no store": the bridge behaves as without one.
//
//   PUT    /entry   publish            token   (also POST /entry)
//   GET    /entry   the values         token
//   POST   /touch   activity, by fp    token
//   POST   /dead    a death, by fp     token
//   POST   /lock    login lock         token
//   DELETE /lock    release by lock_id token   (also POST /unlock)
//   GET    /list    metadata only      token, or X-Board: 1 from this computer (the board's own CLI and page)
//
// Answers: {"ok": true, ...} or {"ok": false, "code", "message"}. Cookie values come in with a
// publish and go out with GET /entry, and nowhere else: no log line, no error, no other answer
// holds one. A remote listener (Tailscale, the tunnel) gets none of it.
import { NS_TOKEN_HEADER } from '../../adapters/ns-store-tokens.ts'
import {
  isNsDeadReason,
  isNsFp,
  NS_LOCK_DEFAULT_S,
  NS_MAX_BODY,
  NsBodyError,
  type NsStore,
  nsAccount,
  nsHolderOf,
  nsLabel,
  nsPublishOf,
  nsUserField,
  nsWhereOf,
} from '../../core/ns-sessions.ts'
import { json, type Route, type RouteContext } from '../http.ts'

export const NS_PREFIX = '/api/ns-sessions'
export const NS_CLIENT_HEADER = 'x-ns-store-client'

export type NsCode =
  | 'bad_request'
  | 'unauthorized'
  | 'none'
  | 'ambiguous_user'
  | 'locked'
  | 'dead_fp'
  | 'store_full'
  | 'store_unavailable'

const MESSAGES: Record<NsCode, string> = {
  bad_request: 'the request is not one the store takes',
  unauthorized: 'missing or unknown X-NS-Store-Token',
  none: 'no live session for this account',
  ambiguous_user: 'more than one live user for this account: name one',
  locked: 'another machine holds the login lock',
  dead_fp: 'this session is dead and is never published again',
  store_full: 'the store holds as many live sessions as it takes',
  store_unavailable: 'the store is not reachable now: behave as without one',
}

const STATUS: Record<NsCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  none: 404,
  ambiguous_user: 409,
  locked: 409,
  dead_fp: 409,
  store_full: 409,
  store_unavailable: 503,
}

/** A failure as the contract has it. `message` never holds a value. */
export const nsFail = (code: NsCode, extra: Record<string, unknown> = {}, message = MESSAGES[code]): Response =>
  json(STATUS[code], { ok: false, code, message, ...extra })

const ok = (body: Record<string, unknown> = {}): Response => json(200, { ok: true, ...body })

export interface NsRoutesDeps {
  /** The store, or null on a pure node (its master holds the store): 503 store_unavailable. */
  store(): NsStore | null
  /** Whether the header's value is one of this computer's bridge tokens. */
  tokenOk(given: string | null): boolean
  log(line: string): void
}

/**
 * Who may call: a node's relayed request (its node checked it), else a bridge's token from this
 * computer, or for the list this board's own page or CLI (X-Board: 1). A wrong token is refused
 * even where none is needed.
 */
export function nsAuthRefusal(
  req: Request,
  ctx: Pick<RouteContext, 'remote' | 'relayFrom'>,
  list: boolean,
  tokenOk: (given: string | null) => boolean,
): Response | null {
  if (ctx.relayFrom) return null
  if (ctx.remote) return nsFail('unauthorized', {}, 'not from a remote listener')
  const given = req.headers.get(NS_TOKEN_HEADER)
  if (given !== null) return tokenOk(given) ? null : nsFail('unauthorized')
  return list && req.headers.get('x-board') === '1' ? null : nsFail('unauthorized')
}

const isList = (req: Request, ctx: Pick<RouteContext, 'path'>): boolean =>
  req.method === 'GET' && ctx.path === `${NS_PREFIX}/list`

/** The relay as the node route uses it (services/node/master-relay.ts). */
export interface NsRelay {
  relay(
    req: Request,
    caller: { rawPath: string; search: string; remote: boolean; refuse: () => null },
  ): Promise<Response | undefined>
}

/**
 * On a node (#860), before the master relay: the bridge's token is checked here, where it was
 * written, and the request goes up as the owner's (the token is what keeps a page of another site
 * out, so no X-Board is asked). What the relay itself answers (the master away, a timeout, a master
 * without the store) is 503 store_unavailable; the store's own answers pass as they came. A node
 * that does not relay leaves it to the routes below (503 there, it holds no store).
 */
export function nsNodeRoute(relay: NsRelay, tokenOk: (given: string | null) => boolean): Route {
  return {
    method: 'ANY',
    path: /^\/api\/ns-sessions(?:\/|$)/,
    async handle(req, ctx) {
      const refused = nsAuthRefusal(req, ctx, isList(req, ctx), tokenOk)
      if (refused) return refused
      const res = await relay.relay(req, {
        rawPath: ctx.rawPath,
        search: ctx.url.search,
        remote: false,
        refuse: () => null,
      })
      if (!res || res.status < 400) return res
      const body: unknown = await res
        .clone()
        .json()
        .catch(() => null)
      if (body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string') return res
      return nsFail('store_unavailable')
    },
  }
}

/** The body as an object, or null (empty, over 64 KB, not JSON, not an object): never its text. */
async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const told = Number(req.headers.get('content-length'))
    if (Number.isFinite(told) && told > NS_MAX_BODY) return null
    const bytes = new Uint8Array(await req.arrayBuffer())
    if (bytes.byteLength > NS_MAX_BODY) return null
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const bad = (field: string): Response => nsFail('bad_request', { field }, `bad ${field}`)

export function nsSessionRoutes(deps: NsRoutesDeps): Route[] {
  function gate(req: Request, ctx: RouteContext): Response | { store: NsStore } {
    const refused = nsAuthRefusal(req, ctx, isList(req, ctx), deps.tokenOk)
    if (refused) return refused
    const store = deps.store()
    return store ? { store } : nsFail('store_unavailable')
  }

  /** Who asked, for the log: the bridge's client line and the node that relayed it. */
  const who = (req: Request, ctx: RouteContext): string => {
    const client = nsLabel(req.headers.get(NS_CLIENT_HEADER), 120)
    return `${client ? ` [${client}]` : ''}${ctx.relayFrom ? ` via ${ctx.relayFrom}` : ''}`
  }

  /** The {account, user} of a body (user may be null), or the field that is wrong. */
  function keyOf(b: Record<string, unknown>): { account: string; user: string | null } | Response {
    const account = nsAccount(b.account)
    if (!account) return bad('account')
    const user = nsUserField(b.user)
    if (user === undefined) return bad('user')
    return { account, user }
  }

  const entry = `${NS_PREFIX}/entry`
  const lock = `${NS_PREFIX}/lock`

  const routes: Route[] = [
    {
      method: 'PUT',
      path: entry,
      async handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const b = await bodyOf(req)
        if (!b) return bad('body')
        let p: ReturnType<typeof nsPublishOf>
        try {
          p = nsPublishOf(b)
        } catch (err) {
          return bad(err instanceof NsBodyError ? err.field : 'body')
        }
        const r = g.store.publish(p)
        if (!r.ok) return nsFail(r.code)
        if (r.stored)
          deps.log(
            `ns-sessions: ${p.account} published fp ${p.fp} gen ${r.generation} by ${p.origin.machine}/${p.origin.profile}${who(req, ctx)}`,
          )
        return ok({ stored: r.stored, generation: r.generation, state: r.state })
      },
    },
    {
      method: 'GET',
      path: entry,
      handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const account = nsAccount(ctx.url.searchParams.get('account'))
        if (!account) return bad('account')
        const raw = ctx.url.searchParams.get('user')
        const user = raw === null || raw === '' ? null : nsUserField(raw)
        if (user === undefined) return bad('user')
        const r = g.store.take(account, user)
        if (r.ok) {
          const { ok: _, ...taken } = r
          return ok(taken)
        }
        return r.code === 'ambiguous_user' ? nsFail('ambiguous_user', { users: r.users }) : nsFail('none')
      },
    },
    {
      method: 'POST',
      path: `${NS_PREFIX}/touch`,
      async handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const b = await bodyOf(req)
        if (!b) return bad('body')
        const account = nsAccount(b.account)
        if (!account) return bad('account')
        if (!isNsFp(b.fp)) return bad('fp')
        const where = nsWhereOf(b.where)
        if (!where) return bad('where')
        return ok(g.store.touch(account, b.fp, where))
      },
    },
    {
      method: 'POST',
      path: `${NS_PREFIX}/dead`,
      async handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const b = await bodyOf(req)
        if (!b) return bad('body')
        const account = nsAccount(b.account)
        if (!account) return bad('account')
        if (!isNsFp(b.fp)) return bad('fp')
        if (!isNsDeadReason(b.reason)) return bad('reason')
        const where = nsWhereOf(b.where)
        if (!where) return bad('where')
        const matched = g.store.dead(account, b.fp, b.reason)
        if (matched)
          deps.log(
            `ns-sessions: ${account} fp ${b.fp} dead (${b.reason}) on ${where.machine}/${where.profile}${who(req, ctx)}`,
          )
        return ok({ matched })
      },
    },
    {
      method: 'POST',
      path: lock,
      async handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const b = await bodyOf(req)
        if (!b) return bad('body')
        const k = keyOf(b)
        if (k instanceof Response) return k
        const holder = nsHolderOf(b.holder)
        if (!holder) return bad('holder')
        const ttl = b.ttl_s === undefined || b.ttl_s === null ? NS_LOCK_DEFAULT_S : b.ttl_s
        if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) return bad('ttl_s')
        const r = g.store.lock(k.account, k.user, holder, ttl)
        if (r.ok) return ok({ lock_id: r.lock_id, until: r.until })
        return nsFail('locked', { holder: r.holder, until: r.until })
      },
    },
    {
      method: 'DELETE',
      path: lock,
      async handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const b = await bodyOf(req)
        if (!b) return bad('body')
        const k = keyOf(b)
        if (k instanceof Response) return k
        const id = nsLabel(b.lock_id, 128)
        if (!id) return bad('lock_id')
        return g.store.unlock(k.account, k.user, id) ? ok() : ok({ released: false })
      },
    },
    {
      method: 'GET',
      path: `${NS_PREFIX}/list`,
      handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const raw = ctx.url.searchParams.get('account')
        const account = raw === null || raw === '' ? null : nsAccount(raw)
        if (raw && !account) return bad('account')
        return ok({ entries: g.store.list(account) })
      },
    },
  ]
  // The same two under POST (review of #868): the contract's PUT /entry and DELETE /lock, and
  // POST /entry and POST /unlock {account, user, lock_id}, answer alike; a bridge may use either.
  const put = routes.find(r => r.method === 'PUT') as Route
  const release = routes.find(r => r.method === 'DELETE') as Route
  return [...routes, { ...put, method: 'POST' }, { ...release, method: 'POST', path: `${NS_PREFIX}/unlock` }]
}
