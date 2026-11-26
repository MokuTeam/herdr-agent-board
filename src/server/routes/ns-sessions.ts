// The NetSuite session store's routes (#860, core/ns-sessions.ts): what a MokuTab bridge calls on
// its own board, http://127.0.0.1:<port>/api/ns-sessions/... On the master the store answers; a
// node checks the bridge's token itself and relays the rest up (core/master-relay.ts, group
// ns-sessions), so a laptop's bridge reaches the master's store; a node that cannot relay answers
// 503 master-offline. Any 503 means "no store": the bridge behaves as without one.
//
//   POST /entry   publish        { account, user, role?, host, cookies, origin, login_at? }   token
//   GET  /entry   the values     ?account=&user=                                             token
//   POST /touch   activity       { account, user, fp, where }
//   POST /dead    a dead session { account, user, fp, reason }
//   POST /lock    login lock     { account, user, holder, ttl_s<=120 }
//   POST /unlock                 { account, user, holder }
//   GET  /list    metadata only
//
// Every call carries X-Board: 1. Cookie values come in with a publish and go out with GET /entry,
// and nowhere else: no log line, no error body, no other answer holds one. A remote listener
// (Tailscale, the tunnel) gets none of it; a node's relayed request is the node's to check.
import { isRecord } from '../../adapters/json-store.ts'
import { NS_TOKEN_HEADER } from '../../adapters/ns-store-tokens.ts'
import {
  isNsDeadReason,
  isNsFp,
  NS_LOCK_MAX_S,
  NsBodyError,
  type NsStore,
  nsAccount,
  nsPublishOf,
  nsUser,
} from '../../core/ns-sessions.ts'
import { hasUnprintable } from '../../core/team.ts'
import { json, type Route, type RouteContext } from '../http.ts'

export const NS_PREFIX = '/api/ns-sessions'
export const NS_ENTRY = `${NS_PREFIX}/entry`

export interface NsRoutesDeps {
  /** The store, or null on a node (its master holds the store): 503 master-offline. */
  store(): NsStore | null
  /** Whether the header's value is one of this computer's bridge tokens. */
  tokenOk(given: string | null): boolean
  log(line: string): void
}

const bad = (field: string): Response => json(400, { ok: false, error: 'body', field })

/** Whether the request names the value endpoint, in either spelling. */
export const nsValuePath = (ctx: Pick<RouteContext, 'path' | 'rawPath'>): boolean =>
  ctx.path === NS_ENTRY || ctx.rawPath === NS_ENTRY

/** The token refusal for a value endpoint asked on this computer (a relayed one was checked by its node). */
export function nsTokenRefusal(
  req: Request,
  ctx: RouteContext,
  tokenOk: (given: string | null) => boolean,
): Response | null {
  if (ctx.relayFrom || !nsValuePath(ctx)) return null
  return tokenOk(req.headers.get(NS_TOKEN_HEADER)) ? null : json(401, { ok: false, error: 'token' })
}

/**
 * On a node (#860), before the master relay: the value endpoint's token checked here, where it was
 * written; the rest goes on to the relay (and, when it does not relay, to the routes below).
 */
export function nsNodeGateRoute(tokenOk: (given: string | null) => boolean): Route {
  return {
    method: 'ANY',
    path: /^\/api\/ns-sessions(?:\/|$)/,
    handle: (req, ctx) => (ctx.remote ? undefined : (nsTokenRefusal(req, ctx, tokenOk) ?? undefined)),
  }
}

const label = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length >= 1 && v.length <= max && !hasUnprintable(v) ? v : null

export function nsSessionRoutes(deps: NsRoutesDeps): Route[] {
  /** What every call passes first: no remote listener, the header, the token, a store here. */
  function gate(req: Request, ctx: RouteContext): Response | { store: NsStore } {
    if (ctx.remote && !ctx.relayFrom) return json(403, { ok: false, error: 'local' })
    if (req.headers.get('x-board') !== '1') return json(403, { ok: false, error: 'header' })
    const refused = nsTokenRefusal(req, ctx, deps.tokenOk)
    if (refused) return refused
    const store = deps.store()
    if (!store) return json(503, { ok: false, error: 'master-offline' })
    return { store }
  }

  /** The body as an object, or null (not JSON, too large, not an object): never its text. */
  async function bodyOf(ctx: RouteContext): Promise<Record<string, unknown> | null> {
    try {
      const raw = await ctx.rawBody()
      return isRecord(raw) ? raw : null
    } catch {
      return null
    }
  }

  /** account and user of a body, or the field that is wrong. */
  function keyOf(b: Record<string, unknown>): { account: string; user: string } | Response {
    const account = nsAccount(b.account)
    if (!account) return bad('account')
    const user = nsUser(b.user)
    if (!user) return bad('user')
    return { account, user }
  }

  const where = (ctx: RouteContext): string => (ctx.relayFrom ? ` (via ${ctx.relayFrom})` : '')

  return [
    {
      method: 'POST',
      path: NS_ENTRY,
      async handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const b = await bodyOf(ctx)
        if (!b) return bad('body')
        let p: ReturnType<typeof nsPublishOf>
        try {
          p = nsPublishOf(b)
        } catch (err) {
          return bad(err instanceof NsBodyError ? err.field : 'body')
        }
        const r = g.store.publish(p)
        if (!r.ok) return json(409, { ok: false, error: 'stale', fp: r.fp })
        if (r.changed)
          deps.log(
            `ns-sessions: ${p.account} published fp ${r.fp} gen ${r.generation} by ${p.origin.machine}/${p.origin.profile}${where(ctx)}`,
          )
        return json(200, { ok: true, fp: r.fp, generation: r.generation, state: r.state })
      },
    },
    {
      method: 'GET',
      path: NS_ENTRY,
      handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const account = nsAccount(ctx.url.searchParams.get('account'))
        if (!account) return bad('account')
        const rawUser = ctx.url.searchParams.get('user')
        const user = rawUser === null || rawUser === '' ? null : nsUser(rawUser)
        if (rawUser && !user) return bad('user')
        const r = g.store.take(account, user)
        if (r.ok) return json(200, r)
        if (r.error === 'ambiguous') return json(409, { ok: false, error: 'ambiguous', users: r.users })
        return json(404, { ok: false, error: 'none' })
      },
    },
    {
      method: 'POST',
      path: `${NS_PREFIX}/touch`,
      async handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const b = await bodyOf(ctx)
        if (!b) return bad('body')
        const k = keyOf(b)
        if (k instanceof Response) return k
        if (!isNsFp(b.fp)) return bad('fp')
        const at = label(b.where, 160)
        if (!at) return bad('where')
        g.store.touch(k.account, k.user, b.fp, at)
        return new Response(null, { status: 204 })
      },
    },
    {
      method: 'POST',
      path: `${NS_PREFIX}/dead`,
      async handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const b = await bodyOf(ctx)
        if (!b) return bad('body')
        const k = keyOf(b)
        if (k instanceof Response) return k
        if (!isNsFp(b.fp)) return bad('fp')
        if (!isNsDeadReason(b.reason)) return bad('reason')
        if (g.store.dead(k.account, k.user, b.fp, b.reason))
          deps.log(`ns-sessions: ${k.account} fp ${b.fp} dead (${b.reason})${where(ctx)}`)
        return new Response(null, { status: 204 })
      },
    },
    {
      method: 'POST',
      path: `${NS_PREFIX}/lock`,
      async handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const b = await bodyOf(ctx)
        if (!b) return bad('body')
        const k = keyOf(b)
        if (k instanceof Response) return k
        const holder = label(b.holder, 128)
        if (!holder) return bad('holder')
        const ttl = b.ttl_s === undefined ? NS_LOCK_MAX_S : b.ttl_s
        if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) return bad('ttl_s')
        const r = g.store.lock(k.account, k.user, holder, ttl)
        if (r.ok) return json(200, { ok: true, until: r.until })
        return json(423, { ok: false, error: 'locked', holder: r.holder, until: r.until })
      },
    },
    {
      method: 'POST',
      path: `${NS_PREFIX}/unlock`,
      async handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const b = await bodyOf(ctx)
        if (!b) return bad('body')
        const k = keyOf(b)
        if (k instanceof Response) return k
        const holder = label(b.holder, 128)
        if (!holder) return bad('holder')
        g.store.unlock(k.account, k.user, holder)
        return new Response(null, { status: 204 })
      },
    },
    {
      method: 'GET',
      path: `${NS_PREFIX}/list`,
      handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        return json(200, g.store.list())
      },
    },
  ]
}
