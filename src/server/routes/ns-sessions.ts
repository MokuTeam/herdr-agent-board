// The NetSuite session store's routes (#860, core/ns-sessions.ts, contract ns-store-contract-v1.md
// in thread agent-board-149): what a MokuTab bridge calls on its own board, at the URL its
// ns-store-token names (http://127.0.0.1:12422/api/ns-sessions unless its line 2 says another). On the master the store answers; a node checks the bridge's token itself
// and relays the rest up as the owner (core/master-relay.ts, group ns-sessions), so a laptop's
// bridge reaches the master's store. Any 503 means "no store": the bridge behaves as without one.
//
//   POST /entry    publish            token
//   GET  /entry    the values         token
//   POST /touch    activity, by fp    token
//   POST /dead     a death, by fp     token
//   POST /lock     login lock         token
//   POST /unlock   release, by holder token
//   GET  /list     metadata only      token optional (the board's own CLI and page call it without)
//   GET  /events   metadata SSE       token optional (the board's own page)
//   POST /forget   drop an entry      token optional (owner UI)
//   POST /notify   per-account alert  token optional (owner UI)
//
// X-Board: 1 on every call (except GET /events SSE, which refuses cross-site requests).
// The relay carries GET and POST only, so the store has no other method.
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
  type NsWhere,
  nsAccount,
  nsHolderOf,
  nsLabel,
  nsPublishOf,
  nsUserField,
  nsWhereOf,
} from '../../core/ns-sessions.ts'
import { NO_NS_NOTIFY_PREFS, type NsNotifyPrefs, setAccountNotify } from '../../core/ns-sessions-notify.ts'
import { json, type Route, type RouteContext } from '../http.ts'
import { namedEvent } from '../sse.ts'

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

export interface NsPrefsDeps {
  get(): NsNotifyPrefs
  set(account: string, value: boolean | null): NsNotifyPrefs
}

export interface NsRoutesDeps {
  /** The store, or null on a pure node (its master holds the store): 503 store_unavailable. */
  store(): NsStore | null
  /** Whether the header's value is one of this computer's bridge tokens. */
  tokenOk(given: string | null): boolean
  /** Per-account notification preferences (optional; defaults to in-memory for tests). */
  prefs?: NsPrefsDeps
  log(line: string): void
}

export type NsAuthMode = boolean | 'sse'

/**
 * Who may call: a node's relayed request (its node checked it); else X-Board: 1 from this computer
 * (or non-cross-site loopback for EventSource SSE), with a bridge's token, which only owner-UI
 * routes (list, events, forget, notify) may go without. A wrong token is refused even there.
 */
export function nsAuthRefusal(
  req: Request,
  ctx: Pick<RouteContext, 'remote' | 'relayFrom'>,
  mode: NsAuthMode,
  tokenOk: (given: string | null) => boolean,
): Response | null {
  if (ctx.relayFrom) return null
  if (ctx.remote) return nsFail('unauthorized', {}, 'not from a remote listener')
  if (mode === 'sse') {
    if (req.headers.get('sec-fetch-site') === 'cross-site')
      return nsFail('unauthorized', {}, 'cross-site stream refused')
  } else if (req.headers.get('x-board') !== '1') {
    return nsFail('unauthorized', {}, 'X-Board: 1 is missing')
  }
  const given = req.headers.get(NS_TOKEN_HEADER)
  if (given !== null) return tokenOk(given) ? null : nsFail('unauthorized')
  return mode ? null : nsFail('unauthorized')
}

function authModeOf(req: Request, ctx: Pick<RouteContext, 'path'>): NsAuthMode {
  if (req.method === 'GET' && ctx.path === `${NS_PREFIX}/events`) return 'sse'
  if (req.method === 'GET' && ctx.path === `${NS_PREFIX}/list`) return true
  if (req.method === 'POST' && (ctx.path === `${NS_PREFIX}/forget` || ctx.path === `${NS_PREFIX}/notify`)) return true
  return false
}

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
 * out, as X-Board does). What the relay itself answers (the master away, a timeout, a master
 * without the store) is 503 store_unavailable; the store's own answers pass as they came. A node
 * that does not relay leaves it to the routes below (503 there, it holds no store).
 */
export function nsNodeRoute(relay: NsRelay, tokenOk: (given: string | null) => boolean): Route {
  return {
    method: 'ANY',
    path: /^\/api\/ns-sessions(?:\/|$)/,
    async handle(req, ctx) {
      const refused = nsAuthRefusal(req, ctx, authModeOf(req, ctx), tokenOk)
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

/** A bad_request naming the wrong field in its message, never its value. */
const bad = (field: string): Response => nsFail('bad_request', {}, `bad ${field}`)

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-store',
  connection: 'keep-alive',
}

/** Extracts machine/profile from query params or the trailing `<machine>/<profile>` of X-NS-Store-Client. */
function whereFromRequest(req: Request, url: URL): NsWhere | null {
  const qm = url.searchParams.get('machine')
  const qp = url.searchParams.get('profile')
  if (qm || qp) return nsWhereOf({ machine: qm, profile: qp })
  const client = nsLabel(req.headers.get(NS_CLIENT_HEADER), 120)
  if (!client) return null
  const parts = client.trim().split(/\s+/)
  if (parts.length < 2) return null
  const tail = parts.at(-1) ?? ''
  const slash = tail.indexOf('/')
  if (slash <= 0 || slash >= tail.length - 1) return null
  return nsWhereOf({ machine: tail.slice(0, slash), profile: tail.slice(slash + 1) })
}

export function nsSessionRoutes(deps: NsRoutesDeps): Route[] {
  let memPrefs = NO_NS_NOTIFY_PREFS
  const prefs: NsPrefsDeps = deps.prefs ?? {
    get: () => memPrefs,
    set: (account, value) => {
      memPrefs = setAccountNotify(memPrefs, account, value)
      return memPrefs
    },
  }

  type SseClient = ReadableStreamDefaultController<Uint8Array>
  const sseClients = new Set<SseClient>()
  const encoder = new TextEncoder()
  let sseUnsub: (() => void) | null = null
  let ssePing: ReturnType<typeof setInterval> | undefined

  function snapshotOf(store: NsStore): Record<string, unknown> {
    return { entries: store.list(), notify: prefs.get().accounts }
  }

  function broadcastSse(store: NsStore): void {
    if (sseClients.size === 0) return
    const bytes = encoder.encode(namedEvent('sessions', snapshotOf(store)))
    for (const c of [...sseClients]) {
      try {
        c.enqueue(bytes)
      } catch {
        sseClients.delete(c)
      }
    }
    if (sseClients.size === 0) stopSse()
  }

  function stopSse(): void {
    sseUnsub?.()
    sseUnsub = null
    clearInterval(ssePing)
    ssePing = undefined
  }

  function gate(req: Request, ctx: RouteContext): Response | { store: NsStore } {
    const refused = nsAuthRefusal(req, ctx, authModeOf(req, ctx), deps.tokenOk)
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
      method: 'POST',
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
        const r = g.store.take(account, user, whereFromRequest(req, ctx.url))
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
        const matched = g.store.dead(account, b.fp, b.reason, where)
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
      method: 'POST',
      path: `${NS_PREFIX}/unlock`,
      async handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const b = await bodyOf(req)
        if (!b) return bad('body')
        const k = keyOf(b)
        if (k instanceof Response) return k
        const holder = nsHolderOf(b.holder)
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
        const raw = ctx.url.searchParams.get('account')
        const account = raw === null || raw === '' ? null : nsAccount(raw)
        if (raw && !account) return bad('account')
        return ok({ entries: g.store.list(account), notify: prefs.get().accounts })
      },
    },
    {
      method: 'GET',
      path: `${NS_PREFIX}/events`,
      handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const store = g.store
        let client: SseClient | undefined
        const leave = (): void => {
          if (!client) return
          sseClients.delete(client)
          client = undefined
          if (sseClients.size === 0) stopSse()
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            client = controller
            sseClients.add(controller)
            if (sseClients.size === 1) {
              sseUnsub = store.subscribe(() => broadcastSse(store))
              ssePing = setInterval(() => {
                const ping = encoder.encode(': ping\n\n')
                for (const c of [...sseClients]) {
                  try {
                    c.enqueue(ping)
                  } catch {
                    sseClients.delete(c)
                  }
                }
                if (sseClients.size === 0) stopSse()
              }, 20_000)
              ssePing.unref?.()
            }
            try {
              controller.enqueue(encoder.encode(`retry: 2000\n${namedEvent('sessions', snapshotOf(store))}`))
            } catch {
              leave()
            }
          },
          cancel: leave,
        })
        req.signal.addEventListener('abort', leave, { once: true })
        return new Response(stream, { headers: SSE_HEADERS })
      },
    },
    {
      method: 'POST',
      path: `${NS_PREFIX}/forget`,
      async handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const b = await bodyOf(req)
        if (!b) return bad('body')
        const k = keyOf(b)
        if (k instanceof Response) return k
        const removed = g.store.forget(k.account, k.user)
        if (removed) deps.log(`ns-sessions: ${k.account} forgotten${who(req, ctx)}`)
        return ok({ removed })
      },
    },
    {
      method: 'POST',
      path: `${NS_PREFIX}/notify`,
      async handle(req, ctx) {
        const g = gate(req, ctx)
        if (g instanceof Response) return g
        const b = await bodyOf(req)
        if (!b) return bad('body')
        const account = nsAccount(b.account)
        if (!account) return bad('account')
        if (b.notify !== null && typeof b.notify !== 'boolean') return bad('notify')
        const next = prefs.set(account, b.notify)
        broadcastSse(g.store)
        return ok({ account, notify: b.notify, prefs: next.accounts })
      },
    },
  ]
  return routes
}
