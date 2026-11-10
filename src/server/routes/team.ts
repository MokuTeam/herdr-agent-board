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
// POST /api/team/listen. The owner's switches are GET and POST /api/team/agents (`off`,
// `listener`, and per peer `on`, `lanes`, `muted` and `loop`, its loop pause: #360; GET also says
// `loopDefault`) and .../mute | unmute, the panel's routes. `board team loop` comes to the same
// route.
//
// The owner's passkey (#224, core/team-confirm.ts, services/team-confirm.ts): Send, sending a held
// draft, trusting a changed key, and a change of the switches that widens what agents may do (any
// change of a loop pause among them) are not done at once. Without a passkey they answer 403 { error: 'passkey' }; with one, 428 { confirm }
// with the address of a confirmation window on localhost, and are done when the window answers
// (POST /api/team/confirm/<id>, from that origin only). A confirmed send unlocks sending in the page
// that asked for 30 minutes: it sends the token back in X-Board-Unlock. GET and POST
// /api/team/passkeys list, add and remove the passkeys (adding a later one and removing any
// confirm with one there is).
import { isRecord } from '../../adapters/json-store.ts'
import { audit, changeAgents, readAgents, readDrafts, type SessionRef } from '../../adapters/team-store.ts'
import { categoryInfo } from '../../core/categories.ts'
import { isMessageId, isPeerId, isThreadId, MAX_TEXT, validName } from '../../core/team.ts'
import { agentLimits, TEAM, threadKey, validLoop } from '../../core/team-agents.ts'
import { type OwnerAction, unlocks, widens } from '../../core/team-confirm.ts'
import type { Config } from '../../core/types.ts'
import type { TeamConfirm } from '../../services/team-confirm.ts'
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
function agentsView(cfg: Pick<Config, 'categories' | 'team'>): unknown {
  const s = readAgents()
  const team = typeof cfg.team === 'object' && cfg.team !== null ? (cfg.team as Record<string, unknown>) : {}
  return {
    off: s.off,
    listener: s.listener,
    peers: s.peers,
    paused: s.paused,
    // The loop pause of a peer without its own (#360).
    loopDefault: agentLimits(team.agentLimits).loopRun,
    lanes: cfg.categories.map(c => ({ id: c.id, title: categoryInfo(cfg, c.id).title })),
  }
}

/**
 * One change of the owner's switches: `listener`, `off` (all agents), or for `peer` (an id or
 * `team`) `on`, `lanes` (ids of this board's lanes), `loop` (its own loop pause, 1 to 100, or null
 * for the board's default: #360) and, for the team, `muted`. Checked whole first; `apply` makes it
 * and audits it.
 */
function agentsChange(
  cfg: Pick<Config, 'categories'>,
  body: Record<string, unknown>,
): { ok: true; apply: () => void } | { ok: false; error: string } {
  if (body.listener !== undefined) {
    const listener = body.listener === null ? null : sessionFrom(body.listener)
    if (body.listener !== null && !listener) return { ok: false, error: 'body' }
    return {
      ok: true,
      apply() {
        changeAgents(s => {
          s.listener = listener
        })
        audit('listener', null, { by: 'ui', ...(listener && { session: listener.key }) })
      },
    }
  }
  if (body.off !== undefined) {
    if (typeof body.off !== 'boolean') return { ok: false, error: 'body' }
    const off = body.off
    return {
      ok: true,
      apply() {
        changeAgents(s => {
          s.off = off
        })
        audit('agents', null, { off, by: 'ui' })
      },
    }
  }
  if (!isTarget(body.peer)) return { ok: false, error: 'peer' }
  const peer = body.peer
  const known = new Set(cfg.categories.map(c => c.id))
  if (body.on !== undefined && typeof body.on !== 'boolean') return { ok: false, error: 'body' }
  if (body.muted !== undefined && typeof body.muted !== 'boolean') return { ok: false, error: 'body' }
  if (body.loop !== undefined && body.loop !== null && !validLoop(body.loop)) return { ok: false, error: 'loop' }
  if (body.lanes !== undefined && !(Array.isArray(body.lanes) && body.lanes.every(l => known.has(l))))
    return { ok: false, error: 'lanes' }
  return {
    ok: true,
    apply() {
      changeAgents(s => {
        const p = s.peers[peer] ?? { on: false, lanes: [] }
        if (typeof body.on === 'boolean') p.on = body.on
        if (Array.isArray(body.lanes)) p.lanes = [...new Set(body.lanes as string[])]
        if (typeof body.muted === 'boolean') p.muted = body.muted
        if (validLoop(body.loop)) p.loop = body.loop
        else if (body.loop === null) delete p.loop
        s.peers[peer] = p
      })
      audit('agents', peer === TEAM ? null : peer, {
        by: 'ui',
        ...(typeof body.on === 'boolean' && { on: body.on }),
        ...(Array.isArray(body.lanes) && { lanes: (body.lanes as string[]).join(',') }),
        ...(typeof body.muted === 'boolean' && { muted: body.muted }),
        ...(body.loop !== undefined && { loop: validLoop(body.loop) ? body.loop : 'default' }),
      })
    },
  }
}

/** The peer an owner action is about, for the audit. */
function peerOf(a: OwnerAction): string | null {
  if (a.kind === 'send') return a.to === TEAM ? null : a.to
  if (a.kind === 'trust') return a.peer
  if (a.kind === 'agents') return typeof a.change.peer === 'string' && a.change.peer !== TEAM ? a.change.peer : null
  return null
}

export function teamRoutes(
  team: TeamService,
  router?: TeamRouter,
  cfg?: Pick<Config, 'categories' | 'team'>,
  /** The owner's switches changed (the team chat's mute among them): the unread count follows (#355). */
  onAgents?: () => void,
  confirm?: TeamConfirm,
): Route[] {
  const lanes = (): Pick<Config, 'categories' | 'team'> => cfg ?? { categories: [] }

  /** Why a gated action may not go now (403 without a passkey, 428 with its confirmation), or null. */
  function held(req: Request, action: OwnerAction): Response | null {
    if (!confirm) return null
    if (unlocks(action) && confirm.unlocked(req.headers.get('x-board-unlock'))) return null
    if (!confirm.hasPasskey()) return json(403, { ok: false, error: 'passkey' })
    if (!confirm.safe()) return json(503, { ok: false, error: 'loopback' })
    const id = confirm.pend(action)
    return json(428, { ok: false, error: 'confirm', id, confirm: confirm.urlOf(id) })
  }

  /** Does an owner action: at once when it needs no confirmation, or once the window confirmed it. */
  async function perform(a: OwnerAction): Promise<{ status: number; body: Record<string, unknown> }> {
    if (a.kind === 'send') {
      const r = await team.send(a.to, a.text, a.thread)
      return { status: r.ok ? 200 : 400, body: { ...r } }
    }
    if (a.kind === 'draft') {
      const r = await team.sendDraft(a.id)
      return { status: r.ok ? 200 : r.error === 'draft' ? 404 : 400, body: { ...r } }
    }
    if (a.kind === 'trust')
      return team.trust(a.peer)
        ? { status: 200, body: { ok: true } }
        : { status: 404, body: { ok: false, error: 'peer' } }
    if (a.kind === 'agents') {
      const c = agentsChange(lanes(), a.change)
      if (!c.ok) return { status: 400, body: c }
      c.apply()
      onAgents?.()
      return { status: 200, body: { ok: true } }
    }
    // A passkey added or removed: the confirmation did it.
    return { status: 200, body: { ok: true } }
  }

  /** What the confirmation window shows, in the board's words: names from the roster, never the asker's. */
  function describe(a: OwnerAction): Record<string, unknown> {
    if (a.kind === 'send') {
      const id = a.thread?.id
      const known = id ? team.threads().find(t => t.key === threadKey(a.to, id)) : undefined
      const thread = a.thread?.title ?? known?.title
      const link = a.thread?.link ?? known?.link ?? undefined
      return {
        kind: a.kind,
        who: a.to === TEAM ? null : team.nameOf(a.to),
        text: a.text,
        ...(thread && { thread }),
        ...(link && { link }),
      }
    }
    if (a.kind === 'draft') {
      const d = readDrafts().find(x => x.id === a.id)
      return { kind: a.kind, ...(d && { who: d.to === TEAM ? null : team.nameOf(d.to), text: d.text }) }
    }
    if (a.kind === 'trust') {
      const p = team.view()?.roster.find(r => r.peer === a.peer)
      return { kind: a.kind, who: team.nameOf(a.peer), ...(p && { fingerprint: p.fingerprint }) }
    }
    if (a.kind === 'agents') {
      const c = a.change
      const titles = new Map(lanes().categories.map(x => [x.id, categoryInfo(lanes(), x.id).title]))
      const listener = isRecord(c.listener) && typeof c.listener.key === 'string' ? c.listener.key : null
      // Every field the change carries, each said on its own: nothing it does stays off the window.
      return {
        kind: a.kind,
        ...(typeof c.peer === 'string' && (c.peer === TEAM ? { team: true } : { who: team.nameOf(c.peer) })),
        ...(c.off === false && { allOn: true }),
        ...(typeof c.on === 'boolean' && { on: c.on }),
        ...(Array.isArray(c.lanes) && { lanes: c.lanes.map(l => titles.get(l as string) ?? String(l)) }),
        ...(c.loop !== undefined && { loop: c.loop }),
        ...(typeof c.muted === 'boolean' && { muted: c.muted }),
        // The session by the board's own name for it, never the one the asker gave.
        ...(listener && { listener: router?.sessionName(listener) ?? `a session (${listener.slice(0, 8)})` }),
      }
    }
    if (a.kind === 'passkey-remove')
      return { kind: a.kind, label: confirm?.passkeys().find(p => p.id === a.id)?.label ?? null }
    return { kind: a.kind }
  }

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
      async handle(req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        if (typeof body.to !== 'string' || typeof body.text !== 'string') return json(400, { ok: false, error: 'body' })
        if (!isTarget(body.to)) return json(400, { ok: false, error: 'peer' })
        const thread = threadFrom(body.thread)
        if (thread === null) return json(400, { ok: false, error: 'thread' })
        // What the send would refuse is refused before it waits for a passkey.
        const words = body.text.trim()
        if (!words || words.length > MAX_TEXT) return json(400, { ok: false, error: 'text' })
        const action: OwnerAction = { kind: 'send', to: body.to, text: body.text, ...(thread && { thread }) }
        const wait = held(req, action)
        if (wait) return wait
        const r = await perform(action)
        return json(r.status, r.body)
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
      async handle(req, ctx) {
        if (!team.view() || !router) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const given = isRecord(raw) ? raw.session : undefined
        const session = given === null ? null : sessionFrom(given)
        if (given !== null && !session) return json(400, { ok: false, error: 'body' })
        const caller = sessionFrom(isRecord(raw) ? raw.caller : undefined) ?? undefined
        // A session making itself the listener gets notices of every thread nobody handles and may
        // post outside its lanes: it widens what agents may do, so the owner confirms it (#224).
        // Taking another listener's place stays refused; stepping down is free.
        const now = readAgents().listener
        if (session && now && now.key !== session.key) return json(409, { ok: false, error: 'taken' })
        if (session && now?.key !== session.key) {
          const wait = held(req, { kind: 'agents', change: { listener: session } })
          if (wait) return wait
        }
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
      async handle(req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const change = isRecord(raw) ? raw : {}
        const c = agentsChange(lanes(), change)
        if (!c.ok) return json(400, c)
        // Narrowing is never held back; widening waits for the owner's passkey.
        if (widens(readAgents(), change)) {
          const wait = held(req, { kind: 'agents', change })
          if (wait) return wait
        }
        c.apply()
        onAgents?.()
        return json(200, { ok: true })
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
      async handle(req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const id = ctx.params[0] ?? ''
        if (!isMessageId(id)) return json(400, { ok: false, error: 'draft' })
        if (ctx.params[1] === 'discard')
          return team.discardDraft(id) ? json(200, { ok: true }) : json(404, { ok: false, error: 'draft' })
        if (!readDrafts().some(d => d.id === id)) return json(404, { ok: false, error: 'draft' })
        const wait = held(req, { kind: 'draft', id })
        if (wait) return wait
        const r = await perform({ kind: 'draft', id })
        return json(r.status, r.body)
      },
    },
    {
      method: 'POST',
      path: '/api/team/trust',
      async handle(req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const peer = isRecord(raw) ? raw.peer : undefined
        if (!isPeerId(peer)) return json(404, { ok: false, error: 'peer' })
        const wait = held(req, { kind: 'trust', peer })
        if (wait) return wait
        const r = await perform({ kind: 'trust', peer })
        return json(r.status, r.body)
      },
    },
    ...(confirm ? confirmRoutes(team, confirm, describe, perform) : []),
  ]
}

/**
 * The passkeys and the confirmation window's routes (#224): GET /api/team/passkeys lists them;
 * POST /api/team/passkeys { op: 'add' } or { op: 'remove', id } is confirmed in the window like
 * any gated action. GET /api/team/confirm/<id> is what the window shows and the WebAuthn options;
 * POST /api/team/confirm/<id> is its answer, taken only from the window's origin
 * (http://localhost:<port>): a page on 127.0.0.1 is told the localhost address instead.
 */
function confirmRoutes(
  team: TeamService,
  confirm: TeamConfirm,
  describe: (a: OwnerAction) => Record<string, unknown>,
  perform: (a: OwnerAction) => Promise<{ status: number; body: Record<string, unknown> }>,
): Route[] {
  const ID = /^[A-Za-z0-9_-]{22}$/
  return [
    {
      method: 'GET',
      path: '/api/team/passkeys',
      handle() {
        if (!team.view()) return undefined
        return json(200, { passkeys: confirm.passkeys() })
      },
    },
    {
      method: 'POST',
      path: '/api/team/passkeys',
      async handle(_req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        let action: OwnerAction
        if (body.op === 'add') action = { kind: 'passkey-add' }
        else if (body.op === 'remove' && typeof body.id === 'string') {
          if (!confirm.passkeys().some(p => p.id === body.id)) return json(404, { ok: false, error: 'passkey' })
          action = { kind: 'passkey-remove', id: body.id }
        } else return json(400, { ok: false, error: 'body' })
        const id = confirm.pend(action)
        return json(428, { ok: false, error: 'confirm', id, confirm: confirm.urlOf(id) })
      },
    },
    {
      method: 'GET',
      path: /^\/api\/team\/confirm\/([^/]+)$/,
      handle(_req, ctx) {
        if (!team.view()) return undefined
        const id = ctx.params[0] ?? ''
        if (!confirm.safe()) return json(503, { ok: false, error: 'loopback' })
        const v = ID.test(id) ? confirm.view(id) : null
        if (v === null) return json(404, { ok: false, error: 'gone' })
        if (v === 'passkey') return json(403, { ok: false, error: 'passkey' })
        return json(200, { action: describe(v.action), step: v.step, options: v.options })
      },
    },
    {
      method: 'POST',
      path: /^\/api\/team\/confirm\/([^/]+)$/,
      async handle(req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header')
        if (refused) return refused
        const id = ctx.params[0] ?? ''
        if (!ID.test(id)) return json(404, { ok: false, error: 'gone' })
        // The window's own origin only: WebAuthn's RP ID is localhost, which a page on 127.0.0.1
        // cannot use; it is told where to go instead.
        if (req.headers.get('origin') !== confirm.origin())
          return json(403, { ok: false, error: 'origin', confirm: confirm.urlOf(id) })
        if (!confirm.safe()) return json(503, { ok: false, error: 'loopback' })
        const a = confirm.answer(id, await ctx.rawBody(), req.headers.get('user-agent'))
        if (!a.ok) return json(a.error === 'gone' ? 404 : 403, a)
        if (!a.done) return json(200, { ok: true, done: false })
        const r = await perform(a.action)
        audit('confirmed', peerOf(a.action), { kind: a.action.kind, ok: r.status === 200 })
        // A send the board then refused (the person gone, the text too long) unlocks nothing.
        return json(r.status, { ...r.body, done: true, ...(a.unlock && r.status === 200 && { unlock: a.unlock }) })
      },
    },
  ]
}
