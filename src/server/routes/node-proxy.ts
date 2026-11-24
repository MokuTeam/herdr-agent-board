// Requests for another device's card (#501, docs/design/nodes 5, 6.2, 10 item 2, 12): made by
// server/app.ts only once config.json has `nodes`, and put first in the board's route table, which
// the phones' listener and the tunnel share, so they reach it after their own refusals
// (server/streams.ts remoteRefusal). Without `nodes` the table is what it was and this does not exist.
//
// A request that names a key of another device (core/node-proxy.ts) goes to that device's link
// (services/nodes/link.ts) after this board's own guards for its route: the same method, the path
// with the node's own key, the body and the query; the node's status and body come back. The link
// being online stands in for fresh herdr data: what the node acts on is its own herdr, which it
// checks itself. Nothing of the caller's headers goes on but what the route reads
// (core/node-proxy.ts FORWARDED_REQUEST_HEADERS): no cookie, no Authorization, no Origin.
//
// - `/api/session/<key>/...`, `/api/term/<key>/...`, `/api/launch/<id>/...` by the key in the path;
//   focusing a pane or a tab there is 403 desktop, as for a phone.
// - `/api/sleep`, `/api/move`, `/api/archive`: split by device, this computer's part answered by the
//   board's own route, each device's part by its node, the outcomes put back in the asked order.
// - `/api/todos`, `/api/schedule` by the key or entry id in the body; `/api/secret/<id>` when a node's
//   card holds that request, its values crossing this process's memory only, and a line in this
//   board's secrets audit with the names of what went to the device (#507).
// - Files: `/api/fs/(stat|preview|dirs)` with the session's `key` in the body, `/api/fs/(raw|download)`
//   and `/uploads/...` with `?key=`, `/api/upload?key=` into the node's uploads. `/api/fs/open`,
//   `/api/open-url` and `/api/reveal` for a node key are 403 desktop.
// - The terminal's stream and the file bytes take this board's file token on the way in and the
//   node's (from its payload, kept in this process by the link) on the way out.
// - A device that is not reachable: 503 `{ error: 'node-offline', device }`; one refused for its
//   link's version: 503 `node-api`. A device config.json does not have: 404, as a session that is gone.
import { isRecord } from '../../adapters/json-store.ts'
import { t } from '../../core/lang.ts'
import {
  type Asked,
  answerHeaders,
  desktopRest,
  deviceKey,
  FORWARDED_REQUEST_HEADERS,
  inAskedOrder,
  type KeyedPath,
  keyedPath,
  nodePath,
  nodeQuery,
  pickHeaders,
  rekeyOutcome,
  splitTargets,
} from '../../core/node-proxy.ts'
import { type NodesConfig, nodesConfig, parseNodeKey } from '../../core/nodes.ts'
import type { Config, Item } from '../../core/types.ts'
import type { Link } from '../../services/nodes/link.ts'
import type { NodeLinks } from '../../services/nodes/links.ts'
import type { RemoteDelivery, RemoteDeviceState, RemoteSent } from '../../services/scheduler.ts'
import { auditForwarded } from '../../services/secrets.ts'
import { terminalOn } from '../../services/terminals.ts'
import { type Body, type Guard, json, type Route, type RouteContext } from '../http.ts'
import { MAX_UPLOAD } from '../uploads.ts'

export interface NodeProxyApp {
  /** The live config: `nodes` and `terminal` are read at each request. */
  cfg: Config
  links: Pick<NodeLinks, 'link' | 'onChange'>
  /** Another device's item by its prefixed key (server/board-state.ts findAny). */
  find(key: string): Item | undefined
  /** This board's own items: a secret request of its own is answered here, whatever a node holds. */
  own(): Item[]
  /** Every other device's item in the payload now, for a secret form's answer. */
  remote(): Item[]
  /** The board's own routes, without this one: this computer's part of a bulk request. */
  local: readonly Route[]
  /** Starting a MokuPilot call for a node card runs MokuPilot on the master (#618). */
  pilotCall?(req: Request, ctx: RouteContext, p: KeyedPath): Promise<Response>
}

export interface NodeProxy extends RemoteDelivery {
  route: Route
}

/** What a write of the board's page needs here, whatever the route: the header, and the page's own Origin when a browser sends one. */
const WRITE: readonly Guard[] = ['board-header', 'origin']
const SECRET = /^\/api\/secret\/([0-9a-f]{12})$/
const UPLOADS = /^\/uploads\/\d{4}-\d{2}-\d{2}\/[^/]+$/
const BULK: Readonly<Record<string, 'targets' | 'keys'>> = {
  '/api/sleep': 'targets',
  '/api/move': 'targets',
  '/api/archive': 'keys',
}
const BY_KEY = new Set(['/api/todos', '/api/fs/stat', '/api/fs/preview', '/api/fs/dirs'])
const DESKTOP = new Set(['/api/fs/open', '/api/open-url', '/api/reveal'])
const ARCHIVE_OPS: ReadonlySet<unknown> = new Set(['archive', 'return', 'remove'])
/** As the board's own bulk routes: more than a lane shows. */
const MAX_TARGETS = 200

const desktop = (): Response => json(403, { error: 'desktop' })
const gone = (): Response => json(404, { error: t('err.gone') })
const offline = (device: string): Response => json(503, { error: 'node-offline', device })
/** What forward() answers when the link did not carry a request: a node's own routes never answer 503. */
const isOffline = (res: Response): boolean => res.status === 503
const jsonInit = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** The first of `guards` that refuses, or null. */
function refusal(ctx: RouteContext, guards: readonly Guard[]): Response | null {
  for (const g of guards) {
    const r = ctx.refuse(g)
    if (r) return r
  }
  return null
}

/** `res` with only the headers the page reads; `done` once its body ended or was dropped. */
function passed(res: Response, done: () => void): Response {
  const headers = answerHeaders(res.headers)
  if (!res.body) {
    done()
    return new Response(null, { status: res.status, headers })
  }
  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (next.done) {
        done()
        try {
          controller.close()
        } catch {}
        return
      }
      controller.enqueue(next.value)
    },
    cancel() {
      done()
      return reader.cancel().catch(() => {})
    },
  })
  return new Response(body, { status: res.status, headers })
}

export function createNodeProxy(app: NodeProxyApp): NodeProxy {
  // `nodes` as config.json has it now, read again only when the live config holds another value.
  let seen: unknown
  let parsed: NodesConfig | null = null
  const conf = (): NodesConfig | null => {
    if (app.cfg.nodes !== seen) {
      seen = app.cfg.nodes
      parsed = nodesConfig(seen)
    }
    return parsed
  }

  /** The device's link while it can be asked; else the answer that says why not. */
  function reach(device: string): { link: Link } | { refused: Response; code: string } {
    const link = conf()?.devices[device]?.link ? app.links.link(device) : null
    if (!link) return { refused: gone(), code: 'gone' }
    const s = link.state()
    if (s.state === 'refused' && s.reason === 'api')
      return { refused: json(503, { error: 'node-api', device }), code: 'node-api' }
    if (s.state !== 'online') return { refused: offline(device), code: 'node-offline' }
    return { link }
  }

  /**
   * `path` asked of the device through `link`. The answer ends when the caller goes, when the link
   * stops being online, and when the device leaves config.json: a terminal's stream too.
   */
  async function forward(
    device: string,
    link: Link,
    path: string,
    init: RequestInit,
    req?: Request,
  ): Promise<Response> {
    const ac = new AbortController()
    const end = (): void => ac.abort()
    req?.signal.addEventListener('abort', end, { once: true })
    const offState = link.onState(s => {
      if (s.state !== 'online') end()
    })
    const offLinks = app.links.onChange(id => {
      if (id === device && app.links.link(id) !== link) end()
    })
    let ended = false
    const done = (): void => {
      if (ended) return
      ended = true
      offState()
      offLinks()
      req?.signal.removeEventListener('abort', end)
    }
    try {
      const res = await link.fetch(path, { ...init, signal: ac.signal })
      // The link's own word that it has no door now (a pipe that failed while the stream had not
      // gone quiet yet) names the device, as every other offline answer here does.
      if (res.status === 503) {
        const said = await res
          .clone()
          .json()
          .catch(() => null)
        if (isRecord(said) && said.error === 'node-offline' && !('device' in said)) {
          await res.body?.cancel()
          done()
          return offline(device)
        }
      }
      return passed(res, done)
    } catch {
      done()
      return offline(device)
    }
  }

  /** A node's JSON answer, or null when it is none. */
  async function answerOf(res: Response): Promise<unknown> {
    return res.json().catch(() => null)
  }

  async function keyed(req: Request, ctx: RouteContext, p: KeyedPath): Promise<Response> {
    if (p.area === 'term' && !terminalOn(app.cfg)) return json(404, { error: t('term.off') })
    if (desktopRest(p.area, p.rest)) return desktop()
    if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'method' })
    // MokuPilot runs on the master computer, with the call agent running on the node (#618).
    if (p.area === 'session' && p.rest === '/mokupilot' && req.method === 'POST' && app.pilotCall) {
      const refused = refusal(ctx, WRITE)
      if (refused) return refused
      return app.pilotCall(req, ctx, p)
    }
    const stream = p.area === 'term' && req.method === 'GET' && /^\/(agent|shell)\/stream$/.test(p.rest)
    // A terminal's other requests are POSTs, as on this board (routes/terminal.ts).
    if (p.area === 'term' && req.method === 'GET' && !stream) return json(405, { error: 'method' })
    // The stream: this board's token on the way in, EventSource sending no header (routes/terminal.ts).
    const refused = stream ? ctx.refuse('fs-token') : req.method === 'POST' ? refusal(ctx, WRITE) : null
    if (refused) return refused
    const r = reach(p.device)
    if ('refused' in r) return r.refused
    if (stream) {
      const token = r.link.payload()?.fsToken
      if (!token) return offline(p.device)
      return forward(
        p.device,
        r.link,
        `${nodePath(p)}${nodeQuery(ctx.url.searchParams, [], { t: token })}`,
        { method: 'GET' },
        req,
      )
    }
    const init: RequestInit =
      req.method === 'GET'
        ? { method: 'GET', headers: pickHeaders(req.headers, FORWARDED_REQUEST_HEADERS) }
        : jsonInit(await ctx.rawBody())
    // This board's file token is never sent on: the node has a token of its own.
    return forward(p.device, r.link, `${nodePath(p)}${nodeQuery(ctx.url.searchParams, ['t'])}`, init, req)
  }

  /** The node's outcomes of a bulk request, or, when it gave none, one failure for each target it was sent. */
  async function devicePart(
    path: string,
    body: Body,
    field: 'targets' | 'keys',
    device: string,
    asked: Asked[],
  ): Promise<Record<string, unknown>[][]> {
    const sent: Body = { ...body, [field]: asked.map(a => a.key) }
    // A profile of the master's by the node's own id (nodes.devices.<id>.profiles); one not named keeps its id.
    if (path === '/api/move' && typeof body.profile === 'string')
      sent.profile = conf()?.devices[device]?.profiles[body.profile] ?? body.profile
    const r = reach(device)
    let answer: unknown = null
    let code = ''
    if ('refused' in r) code = r.code
    else {
      const res = await forward(device, r.link, path, jsonInit(sent))
      answer = await answerOf(res)
      if (!isRecord(answer)) code = `HTTP ${res.status}`
      else if (typeof answer.error === 'string') code = answer.error
    }
    return outcomesOf(path, answer, asked, code, o => rekeyOutcome(device, o, asked))
  }

  /** `answer`'s outcomes (results, or done and failed for the archive), each made by `rekey`; else a failure for each target. */
  function outcomesOf(
    path: string,
    answer: unknown,
    asked: Asked[],
    code: string,
    rekey: (o: unknown) => Record<string, unknown> | null,
  ): Record<string, unknown>[][] {
    const list = (v: unknown): Record<string, unknown>[] =>
      Array.isArray(v) ? v.map(rekey).filter((o): o is Record<string, unknown> => o !== null) : []
    if (path === '/api/archive') {
      if (isRecord(answer) && Array.isArray(answer.done) && Array.isArray(answer.failed))
        return [list(answer.done), list(answer.failed)]
      return [[], asked.map(a => ({ key: a.asked, error: code || 'error' }))]
    }
    if (isRecord(answer) && Array.isArray(answer.results)) return [list(answer.results)]
    const why = code || 'error'
    return [
      asked.map(a =>
        path === '/api/sleep'
          ? { target: a.asked, result: 'kept', why: 'error', detail: why }
          : { target: a.asked, result: 'refused', why },
      ),
    ]
  }

  async function bulk(
    req: Request,
    ctx: RouteContext,
    path: string,
    field: 'targets' | 'keys',
  ): Promise<Response | undefined> {
    // A body that is no JSON object goes on to the board's own route, which answers it as before.
    const body = await ctx.rawBody().catch(() => undefined)
    if (!isRecord(body)) return undefined
    const all = (Array.isArray(body[field]) ? (body[field] as unknown[]) : []).slice(0, MAX_TARGETS)
    const split = splitTargets(all)
    if (!split.devices.size) return undefined
    const own = app.local.find(r => r.method === 'POST' && r.path === path)
    if (!own) return undefined
    // What the board's own route would refuse is refused for all; a node's part needs its link online, not fresh data here.
    for (const g of own.guard ?? []) {
      if (g === 'fresh-data' && !split.local.length) continue
      const refused = ctx.refuse(g)
      if (refused) return refused
    }
    if (path === '/api/move' && (typeof body.profile !== 'string' || !body.profile)) return undefined
    if (path === '/api/archive' && !ARCHIVE_OPS.has(body.op)) return undefined
    const localAsked: Asked[] = split.local.map(k => ({ asked: String(k), key: String(k) }))
    const localPart = async (): Promise<Record<string, unknown>[][]> => {
      const mine: Body = { ...body, [field]: split.local }
      // What the board's own route throws fails this computer's targets, not the nodes' answers.
      let res: Response | undefined
      try {
        res = await own.handle(req, { ...ctx, rawBody: async () => mine, body: async () => mine })
      } catch {
        return outcomesOf(path, null, localAsked, 'error', o => (isRecord(o) ? o : null))
      }
      const answer = res ? await answerOf(res) : null
      const code = isRecord(answer) && typeof answer.error === 'string' ? answer.error : ''
      return outcomesOf(path, answer, localAsked, code, o => (isRecord(o) ? o : null))
    }
    const parts = await Promise.all([
      split.local.length ? localPart() : Promise.resolve([] as Record<string, unknown>[][]),
      ...[...split.devices].map(([device, asked]) => devicePart(path, body, field, device, asked)),
    ])
    if (path === '/api/archive') {
      const done = inAskedOrder(
        all,
        parts.flatMap(p => p[0] ?? []),
        'key',
      )
      const failed = inAskedOrder(
        all,
        parts.flatMap(p => p[1] ?? []),
        'key',
      )
      return json(done.length || !failed.length ? 200 : 409, {
        ok: !failed.length,
        done,
        failed,
        ...(failed[0] && { error: failed[0].error }),
      })
    }
    return json(200, {
      ok: true,
      results: inAskedOrder(
        all,
        parts.flatMap(p => p[0] ?? []),
        'target',
      ),
    })
  }

  /** A request whose body names a node's key: `field` carries it, the node is sent `send` in its place. */
  async function byBody(ctx: RouteContext, path: string): Promise<Response | undefined> {
    const body = await ctx.rawBody().catch(() => undefined)
    if (!isRecord(body)) return undefined
    if (DESKTOP.has(path)) return deviceKey(body.key) ? desktop() : undefined
    if (path === '/api/todos' && body.op === 'settings') return undefined
    const field = path === '/api/schedule' ? 'id' : 'key'
    const at = deviceKey(body[field])
    if (!at) return undefined
    const refused = ctx.refuse('board-header')
    if (refused) return refused
    const r = reach(at.device)
    if ('refused' in r) return r.refused
    // The file routes read the session's folder from the body: the node knows no key there.
    const { [field]: _, ...rest } = body
    const sent = path.startsWith('/api/fs/') ? rest : { ...rest, [field]: at.key }
    return forward(at.device, r.link, path, jsonInit(sent))
  }

  /** The owner's answer to a secret form a node's card holds (design 10, item 2). Never logged, never kept. */
  async function secret(req: Request, ctx: RouteContext, id: string): Promise<Response | undefined> {
    const holds = (i: Item): boolean => Array.isArray(i.secrets) && i.secrets.some(s => isRecord(s) && s.id === id)
    // A request of this board's own is answered here, as before.
    if (app.own().some(holds)) return undefined
    const item = app.remote().find(holds)
    if (!item?.device) return undefined
    const refused = refusal(ctx, WRITE)
    if (refused) return refused
    let body: unknown
    try {
      body = await ctx.rawBody()
    } catch {
      return json(400, { ok: false, error: t('secret.err.values') })
    }
    const r = reach(item.device)
    if ('refused' in r) return r.refused
    const res = await forward(item.device, r.link, `/api/secret/${id}`, jsonInit(body), req)
    // The master's own audit says values went to the device: the request's names, never a value. A
    // decline sends none, and an answer the link could not carry left nothing here.
    if (!isRecord(body) || body.op !== 'submit' || isOffline(res)) return res
    const view = (item.secrets as unknown[]).find(s => isRecord(s) && s.id === id)
    const v = isRecord(view) ? view : {}
    auditForwarded({
      device: item.device,
      sink: typeof v.sink === 'string' ? v.sink : '',
      fields: Array.isArray(v.fields)
        ? v.fields.flatMap(f => (isRecord(f) && typeof f.name === 'string' ? [f.name] : []))
        : [],
      id,
      key: item.key,
      status: res.status,
    })
    return res
  }

  /** A file sent to a node's session: into the node's uploads, its answer's path the node's own. */
  async function upload(req: Request, ctx: RouteContext): Promise<Response | undefined> {
    const key = ctx.url.searchParams.get('key')
    const at = deviceKey(key)
    if (!at || key === null) return undefined
    const refused = ctx.refuse('board-header')
    if (refused) return refused
    const r = reach(at.device)
    if ('refused' in r) return r.refused
    // Held here (30 MB at most, as the board's own uploads) and sent once.
    const chunks: Uint8Array[] = []
    let size = 0
    if (req.body)
      for await (const chunk of req.body) {
        size += chunk.byteLength
        if (size > MAX_UPLOAD) return json(413, { ok: false, error: t('err.upload.big', { mb: MAX_UPLOAD >> 20 }) })
        chunks.push(chunk)
      }
    const headers = pickHeaders(req.headers, ['x-filename'])
    headers.set('content-type', 'application/octet-stream')
    const res = await forward(
      at.device,
      r.link,
      '/api/upload',
      { method: 'POST', headers, body: Buffer.concat(chunks) },
      req,
    )
    const answer = await answerOf(res)
    if (!isRecord(answer)) return json(res.status, { ok: false, error: `HTTP ${res.status}` })
    // Its link on this board's page: through here, to the node's file.
    if (typeof answer.url === 'string') answer.url = `${answer.url}?key=${encodeURIComponent(key)}`
    return json(res.status, answer)
  }

  /** Bytes of a node's file: `/api/fs/(raw|download)` with this board's token in, the node's out; `/uploads/...`. */
  async function bytes(req: Request, ctx: RouteContext, tokened: boolean): Promise<Response | undefined> {
    const at = deviceKey(ctx.url.searchParams.get('key'))
    if (!at) return undefined
    const refused = tokened ? ctx.refuse('fs-token') : null
    if (refused) return refused
    const r = reach(at.device)
    if ('refused' in r) return r.refused
    let query = nodeQuery(ctx.url.searchParams, ['key', 't'])
    if (tokened) {
      const token = r.link.payload()?.fsToken
      if (!token) return offline(at.device)
      query = nodeQuery(ctx.url.searchParams, ['key'], { t: token })
    }
    const init = { method: 'GET', headers: pickHeaders(req.headers, FORWARDED_REQUEST_HEADERS) }
    return forward(at.device, r.link, `${ctx.rawPath}${query}`, init, req)
  }

  const route: Route = {
    method: 'ANY',
    // Every path: what is not for a node goes on to the board's own routes, which answer it as before.
    path: /^\//,
    async handle(req, ctx) {
      if (!conf()) return undefined
      const p = keyedPath(ctx.rawPath)
      if (p) return keyed(req, ctx, p)
      const { path } = ctx
      if (req.method === 'POST') {
        const field = BULK[path]
        if (field) return bulk(req, ctx, path, field)
        if (BY_KEY.has(path) || DESKTOP.has(path) || path === '/api/schedule') return byBody(ctx, path)
        const s = SECRET.exec(ctx.rawPath)
        if (s) return secret(req, ctx, s[1] ?? '')
        if (path === '/api/upload') return upload(req, ctx)
        return undefined
      }
      if (req.method === 'GET') {
        if (path === '/api/fs/raw' || path === '/api/fs/download') return bytes(req, ctx, true)
        if (UPLOADS.test(ctx.rawPath)) return bytes(req, ctx, false)
      }
      return undefined
    },
  }

  /** How `device` stands for scheduled deliveries (#695): online only once its fresh payload arrived. */
  function deviceState(device: string): RemoteDeviceState {
    const d = conf()?.devices[device]
    if (!d?.link) return 'forgotten'
    if (d.revoked) return 'revoked'
    const link = app.links.link(device)
    if (link?.state().state !== 'online') return 'offline'
    const payload = link.payload()
    if (!payload || payload.stale) return 'offline'
    return 'online'
  }

  return {
    route,
    deviceState,
    async send(key, text, o): Promise<RemoteSent> {
      const at = parseNodeKey(key)
      if (!at) return { ok: false, gone: true, error: 'gone' }
      // Device and link state come before cached session data so an offline snapshot never expires entries.
      const state = deviceState(at.device)
      if (state === 'forgotten') return { ok: false, end: true, error: 'node-forgotten' }
      if (state === 'revoked') return { ok: false, end: true, error: 'node-revoked' }
      if (state === 'offline') return { ok: false, offline: true, error: 'node-offline' }
      const item = app.find(key)
      if (!item) return { ok: false, gone: true, error: 'gone' }
      // As the scheduler holds a session of its own: one that sleeps waits for a noWake entry, one that works for an idle one.
      if (o.noWake && item.sleeping) return { ok: false, asleep: true, error: 'asleep' }
      if (o.idle && item.status === 'working') return { ok: false, busy: true, error: 'busy' }
      const link = app.links.link(at.device)
      if (!link) return { ok: false, offline: true, error: 'node-offline' }
      const res = await forward(
        at.device,
        link,
        nodePath({ area: 'session', key: at.key, rest: '/message' }),
        jsonInit({ text, session: item.session ?? null, requestId: o.requestId, ...(o.draft && { draft: true }) }),
      )
      const answer = await answerOf(res)
      if (res.ok && isRecord(answer) && answer.ok === true) return { ok: true }
      if (isOffline(res)) {
        const nowState = deviceState(at.device)
        if (nowState === 'forgotten') return { ok: false, end: true, error: 'node-forgotten' }
        if (nowState === 'revoked') return { ok: false, end: true, error: 'node-revoked' }
        return { ok: false, offline: true, error: 'node-offline' }
      }
      const a = isRecord(answer) ? answer : {}
      return {
        ok: false,
        error: typeof a.error === 'string' && a.error ? a.error : `HTTP ${res.status}`,
        ...(res.status === 404 && { gone: true }),
        ...(a.busy === true && { busy: true }),
        ...(a.dialog === true && { dialog: true }),
        ...(a.draft === true && { draft: true }),
      }
    },
  }
}
