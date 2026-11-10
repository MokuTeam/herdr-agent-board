// The peer network (#231, services/team-hub.ts), for the board on this computer only (localOnly
// refuses /api/team on every remote listener): GET /api/team is the view (state, who I am, the
// roster), GET /api/team/thread/<peer> the messages with one peer, POST /api/team/send { to, text }
// asks a peer a question, POST /api/team/trust { peer } accepts a peer's new key. An agent's
// draft is POST /api/team/draft { to, text } (kept, never sent), and a person's POST
// /api/team/draft/<id>/send or /discard settles it. While `team` is
// not on in config.json every one of these answers undefined, so the request goes on as if the
// route were not there (404 for a GET, 405 for a POST), and the POSTs' guards are asked only when
// it is on.
//
// Threads and agents (#216): GET /api/team/threads lists the threads, GET
// /api/team/threads/<scope>/<id> one thread's lines; POST /api/team/send takes an optional
// `thread` ({ id } or { title, link? }) and `to: "team"`. A session's `board team post | reply`
// comes to POST /api/team/post, which marks it as an agent's whatever the body says (the route
// sets the source, never the body: #224) and goes through the router's checks; `board team
// assign | release | listen` come to POST /api/team/threads/<scope>/<id>/assign | release and
// POST /api/team/listen. The owner's switches are GET and POST /api/team/agents and
// .../mute | unmute, the panel's routes. Until #224's passkey a local process can call them as the
// panel does; the audit records them as the panel's.
import { isRecord } from '../../adapters/json-store.ts'
import { audit, changeAgents, readAgents, type SessionRef } from '../../adapters/team-store.ts'
import { categoryInfo } from '../../core/categories.ts'
import { isMessageId, isPeerId, isThreadId, validName } from '../../core/team.ts'
import { TEAM, threadKey } from '../../core/team-agents.ts'
import type { Config } from '../../core/types.ts'
import type { PostTarget, TeamService } from '../../services/team-hub.ts'
import type { TeamRouter } from '../../services/team-router.ts'
import { json, type Route } from '../http.ts'

const isTarget = (v: unknown): v is string => v === TEAM || isPeerId(v)

/** A post's `thread` from a body: absent, { id }, or { title, link? }; null when it is none of them. */
function threadFrom(v: unknown): PostTarget['thread'] | null | undefined {
  if (v === undefined) return undefined
  if (!isRecord(v)) return null
  if (typeof v.id === 'string') return isThreadId(v.id) ? { id: v.id } : null
  if (typeof v.title !== 'string') return null
  if (v.link !== undefined && typeof v.link !== 'string') return null
  return { title: v.title, ...(typeof v.link === 'string' && { link: v.link }) }
}

/** The calling session as the CLI resolved it: a key and, when it is one, a name. */
function sessionFrom(v: unknown): SessionRef | null {
  if (!isRecord(v) || typeof v.key !== 'string' || !v.key || v.key.length > 200) return null
  return { key: v.key, ...(validName(v.name) && { name: v.name }) }
}

/** The owner's agent switches as the panel shows them, with the lanes there are to share. */
function agentsView(cfg: Pick<Config, 'categories'>): unknown {
  const s = readAgents()
  return {
    off: s.off,
    listener: s.listener,
    peers: s.peers,
    paused: s.paused,
    lanes: cfg.categories.map(c => ({ id: c.id, title: categoryInfo(cfg, c.id).title })),
  }
}

/**
 * One change of the owner's switches: `off` (all agents), or for `peer` (an id or `team`) `on`,
 * `lanes` (ids of this board's lanes) and, for the team, `muted`.
 */
function changeAgentsFrom(
  cfg: Pick<Config, 'categories'>,
  body: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  if (body.listener !== undefined) {
    const listener = body.listener === null ? null : sessionFrom(body.listener)
    if (body.listener !== null && !listener) return { ok: false, error: 'body' }
    changeAgents(s => {
      s.listener = listener
    })
    audit('listener', null, { by: 'ui', ...(listener && { session: listener.key }) })
    return { ok: true }
  }
  if (body.off !== undefined) {
    if (typeof body.off !== 'boolean') return { ok: false, error: 'body' }
    const off = body.off
    changeAgents(s => {
      s.off = off
    })
    audit('agents', null, { off, by: 'ui' })
    return { ok: true }
  }
  if (!isTarget(body.peer)) return { ok: false, error: 'peer' }
  const peer = body.peer
  const known = new Set(cfg.categories.map(c => c.id))
  if (body.on !== undefined && typeof body.on !== 'boolean') return { ok: false, error: 'body' }
  if (body.muted !== undefined && typeof body.muted !== 'boolean') return { ok: false, error: 'body' }
  if (body.lanes !== undefined && !(Array.isArray(body.lanes) && body.lanes.every(l => known.has(l))))
    return { ok: false, error: 'lanes' }
  changeAgents(s => {
    const p = s.peers[peer] ?? { on: false, lanes: [] }
    if (typeof body.on === 'boolean') p.on = body.on
    if (Array.isArray(body.lanes)) p.lanes = [...new Set(body.lanes as string[])]
    if (typeof body.muted === 'boolean') p.muted = body.muted
    s.peers[peer] = p
  })
  audit('agents', peer === TEAM ? null : peer, {
    by: 'ui',
    ...(typeof body.on === 'boolean' && { on: body.on }),
    ...(Array.isArray(body.lanes) && { lanes: (body.lanes as string[]).join(',') }),
    ...(typeof body.muted === 'boolean' && { muted: body.muted }),
  })
  return { ok: true }
}

export function teamRoutes(team: TeamService, router?: TeamRouter, cfg?: Pick<Config, 'categories'>): Route[] {
  const lanes = (): Pick<Config, 'categories'> => cfg ?? { categories: [] }
  return [
    {
      method: 'GET',
      path: '/api/team',
      handle() {
        const view = team.view()
        return view ? json(200, view) : undefined
      },
    },
    {
      method: 'GET',
      path: /^\/api\/team\/thread\/([^/]+)$/,
      handle(_req, ctx) {
        if (!team.view()) return undefined
        const peer = ctx.params[0] ?? ''
        if (!isPeerId(peer)) return json(400, { ok: false, error: 'peer' })
        return json(200, { peer, messages: team.thread(peer) })
      },
    },
    {
      method: 'POST',
      path: '/api/team/send',
      async handle(_req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        if (typeof body.to !== 'string' || typeof body.text !== 'string') return json(400, { ok: false, error: 'body' })
        if (!isTarget(body.to)) return json(400, { ok: false, error: 'peer' })
        const thread = threadFrom(body.thread)
        if (thread === null) return json(400, { ok: false, error: 'thread' })
        const r = await team.send(body.to, body.text, thread)
        return json(r.ok ? 200 : 400, r)
      },
    },
    {
      method: 'GET',
      path: '/api/team/threads',
      handle() {
        if (!team.view()) return undefined
        return json(200, { threads: team.threads() })
      },
    },
    {
      method: 'GET',
      path: /^\/api\/team\/threads\/([^/]+)\/([^/]+)$/,
      handle(_req, ctx) {
        if (!team.view()) return undefined
        const [scope = '', id = ''] = ctx.params
        if (!isTarget(scope) || !isThreadId(id)) return json(400, { ok: false, error: 'thread' })
        const key = threadKey(scope, id)
        const thread = team.threads().find(t => t.key === key)
        if (!thread) return json(404, { ok: false, error: 'thread' })
        return json(200, { thread, lines: team.threadLines(key) })
      },
    },
    {
      method: 'POST',
      path: '/api/team/post',
      async handle(_req, ctx) {
        if (!team.view() || !router) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        const session = sessionFrom(body.session)
        if (typeof body.to !== 'string' || typeof body.text !== 'string' || !session)
          return json(400, { ok: false, error: 'body' })
        if (!isTarget(body.to)) return json(400, { ok: false, error: 'peer' })
        const thread = threadFrom(body.thread)
        if (thread === null) return json(400, { ok: false, error: 'thread' })
        const r = await router.agentPost({
          to: body.to,
          ...(thread && { thread }),
          text: body.text,
          session,
          ...(body.claimed === true && { claimed: true }),
        })
        return json(r.ok ? 200 : r.error.startsWith('rate') || r.error === 'echo' ? 429 : 400, r)
      },
    },
    {
      method: 'POST',
      path: /^\/api\/team\/threads\/([^/]+)\/([^/]+)\/(assign|release|mute|unmute)$/,
      async handle(_req, ctx) {
        if (!team.view() || !router) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const [scope = '', id = '', op] = ctx.params
        if (!isTarget(scope) || !isThreadId(id)) return json(400, { ok: false, error: 'thread' })
        const key = threadKey(scope, id)
        if (op === 'mute' || op === 'unmute')
          return team.setThread(key, { muted: op === 'mute' })
            ? json(200, { ok: true })
            : json(404, { ok: false, error: 'thread' })
        const raw = await ctx.rawBody()
        const session = op === 'assign' ? sessionFrom(isRecord(raw) ? raw.session : undefined) : null
        if (op === 'assign' && !session) return json(400, { ok: false, error: 'body' })
        const r = router.assign(key, session)
        return json(r.ok ? 200 : r.error === 'thread' ? 404 : 403, r)
      },
    },
    {
      method: 'POST',
      path: '/api/team/listen',
      async handle(_req, ctx) {
        if (!team.view() || !router) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const given = isRecord(raw) ? raw.session : undefined
        const session = given === null ? null : sessionFrom(given)
        if (given !== null && !session) return json(400, { ok: false, error: 'body' })
        const caller = sessionFrom(isRecord(raw) ? raw.caller : undefined) ?? undefined
        const r = router.listen(session, caller)
        return json(r.ok ? 200 : 409, r)
      },
    },
    {
      method: 'GET',
      path: '/api/team/agents',
      handle() {
        if (!team.view()) return undefined
        return json(200, agentsView(lanes()))
      },
    },
    {
      method: 'POST',
      path: '/api/team/agents',
      async handle(_req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const r = changeAgentsFrom(lanes(), isRecord(raw) ? raw : {})
        return json(r.ok ? 200 : 400, r)
      },
    },
    {
      method: 'POST',
      path: '/api/team/draft',
      async handle(_req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        if (typeof body.to !== 'string' || typeof body.text !== 'string') return json(400, { ok: false, error: 'body' })
        if (!isPeerId(body.to)) return json(400, { ok: false, error: 'peer' })
        const r = team.draft(body.to, body.text)
        return json(r.ok ? 200 : 400, r)
      },
    },
    {
      method: 'POST',
      path: /^\/api\/team\/draft\/([^/]+)\/(send|discard)$/,
      async handle(_req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const id = ctx.params[0] ?? ''
        if (!isMessageId(id)) return json(400, { ok: false, error: 'draft' })
        if (ctx.params[1] === 'discard')
          return team.discardDraft(id) ? json(200, { ok: true }) : json(404, { ok: false, error: 'draft' })
        const r = await team.sendDraft(id)
        return json(r.ok ? 200 : r.error === 'draft' ? 404 : 400, r)
      },
    },
    {
      method: 'POST',
      path: '/api/team/trust',
      async handle(_req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const peer = isRecord(raw) ? raw.peer : undefined
        if (!isPeerId(peer) || !team.trust(peer)) return json(404, { ok: false, error: 'peer' })
        return json(200, { ok: true })
      },
    },
  ]
}
