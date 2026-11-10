// The peer network (#231, services/team-hub.ts), for the board on this computer only (localOnly
// refuses /api/team on every remote listener): GET /api/team is the view (state, who I am, the
// roster), GET /api/team/thread/<peer> the messages with one peer, POST /api/team/send { to, text }
// asks a peer a question, POST /api/team/trust { peer } accepts a peer's new key. An agent's
// draft is POST /api/team/draft { to, text } (kept, never sent), and a person's POST
// /api/team/draft/<id>/send or /discard settles it. While `team` is
// not on in config.json every one of these answers undefined, so the request goes on as if the
// route were not there (404 for a GET, 405 for a POST), and the POSTs' guards are asked only when
// it is on.
import { isRecord } from '../../adapters/json-store.ts'
import { isMessageId, isPeerId } from '../../core/team.ts'
import type { TeamService } from '../../services/team-hub.ts'
import { json, type Route } from '../http.ts'

export function teamRoutes(team: TeamService): Route[] {
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
        if (!isPeerId(body.to)) return json(400, { ok: false, error: 'peer' })
        const r = await team.send(body.to, body.text)
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
