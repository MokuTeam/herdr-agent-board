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
// change of a loop pause among them) wait for it while the owner's switch "Confirm with a
// passkey" is on (#367; off by default, and then they go at once, as before #224). On, they answer
// 428 { confirm } with the address of a confirmation window on localhost, and are done when the
// window answers (POST /api/team/confirm/<id>, from that origin only). A confirmed send unlocks
// sending in the page that asked for 30 minutes: it sends the token back in X-Board-Unlock. GET and
// POST /api/team/passkeys list, add and remove the passkeys (adding a later one and removing any
// confirm with one there is), and turn the switch on and off (each confirmed with one, so on needs
// a passkey there first). What the owner's phone or the domain asks waits for the owner at the
// computer instead (#377): the Team panel lists it (GET /api/team/confirm) and opens its window.
//
// Channels and welcomes (#355): POST /api/team/send's new thread may carry `members` (the panel's
// send only, never an agent's post), a channel takes more with POST
// /api/team/threads/team/<id>/members { add }, and its switches are /api/team/agents by its key.
// GET /api/team/welcome names who joined and is not welcomed yet; POST /api/team/welcome { peer,
// on, lanes, allLanes, channels } settles one, its body checked whole before anything changes.
// Adding a channel's members, and a welcome that widens (Agents on, a lane, every lane: #386, a
// channel), wait for the passkey as the switches do.
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { writeCard } from '../../adapters/cards.ts'
import { editTeamServices } from '../../adapters/config-file.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { uploadsCheck } from '../../adapters/own-files.ts'
import { uploadsDir } from '../../adapters/paths.ts'
import {
  audit,
  changeAgents,
  changeDirectoryState,
  readAgents,
  readDirectoryState,
  readDrafts,
  readPins,
  readThreads,
  type SessionRef,
} from '../../adapters/team-store.ts'
import { markWelcomed, readWelcomed } from '../../adapters/team-welcome.ts'
import { categoryInfo } from '../../core/categories.ts'
import { isMessageId, isPeerId, isThreadId, MAX_TEXT, type ReactionOp, validName } from '../../core/team.ts'
import { agentLimits, splitKey, TEAM, threadKey, validLoop } from '../../core/team-agents.ts'
import { type OwnerAction, unlocks, widens } from '../../core/team-confirm.ts'
import {
  type AddressTarget,
  addressTarget,
  expandAlias,
  leadingMention,
  publishedAliases,
  validAlias,
} from '../../core/team-directory.ts'
import { checkMeta } from '../../core/team-file.ts'
import { normalizeEmoji } from '../../core/team-reactions.ts'
import { changeServices, type ServiceAgent, serviceAgents } from '../../core/team-services.ts'
import { isThreadKey } from '../../core/team-unread.ts'
import { MAX_MEMBERS } from '../../core/team-wire.ts'
import type { Config } from '../../core/types.ts'
import { safeName } from '../../core/upload-name.ts'
import type { TeamConfirm } from '../../services/team-confirm.ts'
import type { PostFile, PostTarget, TeamService } from '../../services/team-hub.ts'
import type { TeamRouter } from '../../services/team-router.ts'
import type { WorkHub } from '../../services/work-hub.ts'
import { json, type Route } from '../http.ts'
import { MAX_UPLOAD } from '../uploads.ts'
import { describeThreadAction, performThreadAction } from './threads.ts'

const isTarget = (v: unknown): v is string => v === TEAM || isPeerId(v)

/** A channel's key (#355): a team thread kept here with a member list (not archived). */
const isChannel = (v: unknown): v is string => {
  if (typeof v !== 'string' || !v.startsWith(`${TEAM}/`)) return false
  const all = readThreads()
  return Object.hasOwn(all, v) && !!all[v]?.members && !all[v]?.archived
}

/**
 * A post's `thread` from a body: absent, { id }, or { title, link? }; null when it is none of them.
 * `members` (a new channel's others, #355) only where `channels` is true: the panel's send, never an
 * agent's post.
 */
function threadFrom(v: unknown, channels = false): PostTarget['thread'] | null | undefined {
  if (v === undefined) return undefined
  if (!isRecord(v)) return null
  if (typeof v.id === 'string') return isThreadId(v.id) && v.members === undefined ? { id: v.id } : null
  if (typeof v.title !== 'string') return null
  if (v.link !== undefined && typeof v.link !== 'string') return null
  if (v.members !== undefined && !(channels && Array.isArray(v.members) && v.members.every(isPeerId))) return null
  return {
    title: v.title,
    ...(typeof v.link === 'string' && { link: v.link }),
    ...(Array.isArray(v.members) && { members: v.members as string[] }),
  }
}

/** The calling session as the CLI resolved it: a key and, when it is one, a name. */
function sessionFrom(v: unknown): SessionRef | null {
  if (!isRecord(v) || typeof v.key !== 'string' || !v.key || v.key.length > 200) return null
  return { key: v.key, ...(validName(v.name) && { name: v.name }) }
}

/**
 * Where a post that starts with `@Name.handle` goes (#832, core/team-directory.ts addressTarget): by
 * the roster and the directories the peers sent.
 */
function addressed(team: TeamService, text: string, target: AddressTarget): ReturnType<typeof addressTarget> {
  // Most posts start with no mention: nothing is read for them.
  if (!leadingMention(text)) return { ok: true, ...target }
  const got = readDirectoryState().got
  return addressTarget(text, target, {
    roster: team.view()?.roster ?? [],
    listed: peer => (Object.hasOwn(got, peer) ? (got[peer]?.list.map(e => e.code) ?? null) : null),
  })
}

function expandedAlias(team: TeamService, text: string): string {
  return expandAlias(text, () => publishedAliases(team.view()?.roster ?? [], team.directories()))
}

/**
 * What teammates can address on this board (#832), for the owner's panel: each session with a
 * handle someone can reach now, its lane and whom. Nothing is read without a peer whose Agents are on.
 */
function exposedView(team: TeamService, router: TeamRouter | undefined) {
  // A peer whose key changed gets no directory until the owner trusts it: not shown as reaching.
  const peers = (team.view()?.roster ?? []).filter(p => p.pin !== 'changed').map(p => p.peer)
  return router?.exposed(peers) ?? []
}

/** The owner's agent switches as the panel shows them, with the lanes there are to share. */
function agentsView(cfg: Pick<Config, 'categories' | 'team'>, exposed?: unknown[]): unknown {
  const s = readAgents()
  const team = typeof cfg.team === 'object' && cfg.team !== null ? (cfg.team as Record<string, unknown>) : {}
  return {
    off: s.off,
    ...(s.mastersOnly && { mastersOnly: true }),
    listener: s.listener,
    peers: s.peers,
    paused: s.paused,
    // The loop pause of a peer without its own (#360).
    loopDefault: agentLimits(team.agentLimits).loopRun,
    lanes: cfg.categories.map(c => ({ id: c.id, title: categoryInfo(cfg, c.id).title })),
    // The owner's service agents (#819): each a card with no pane, in its lane.
    services: serviceAgents(cfg.team),
    ...(exposed?.length && { exposed }),
  }
}

/**
 * One change of the owner's switches: `listener`, `off` (all agents), or for `peer` (an id or
 * `team`) `on`, `lanes` (ids of this board's lanes), `allLanes` (every lane, later ones too: #386),
 * `loop` (its own loop pause, 1 to 100, or null for the board's default: #360) and, for the team,
 * `muted`. Checked whole first; `apply` makes it
 * and audits it.
 */
function agentsChange(
  cfg: Pick<Config, 'categories'>,
  body: Record<string, unknown>,
  router?: TeamRouter,
): { ok: true; apply: () => void } | { ok: false; error: string } {
  if (Object.hasOwn(body, 'mastersOnly')) {
    const { mastersOnly } = body
    if (Object.keys(body).length !== 1 || typeof mastersOnly !== 'boolean') return { ok: false, error: 'body' }
    return {
      ok: true,
      apply() {
        changeAgents(s => {
          if (mastersOnly) s.mastersOnly = true
          else delete s.mastersOnly
        })
        audit('agents', null, { mastersOnly, by: 'ui' })
      },
    }
  }
  if (Object.hasOwn(body, 'master')) {
    const { master } = body
    if (
      Object.keys(body).length !== 1 ||
      !isRecord(master) ||
      typeof master.key !== 'string' ||
      typeof master.on !== 'boolean'
    )
      return { ok: false, error: 'body' }
    const { key, on } = master
    if (!router?.hasSession(key)) return { ok: false, error: 'session' }
    return {
      ok: true,
      apply() {
        writeCard(key, { teamMaster: on ? true : '' })
        audit('agents', null, { session: key, master: on, by: 'ui' })
      },
    }
  }
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
  // A peer, the team, or a channel by its key (#355): a channel has switches of its own.
  if (!isTarget(body.peer) && !isChannel(body.peer)) return { ok: false, error: 'peer' }
  const peer = body.peer
  const channel = peer !== TEAM && !isPeerId(peer)
  if (channel && body.muted !== undefined) return { ok: false, error: 'body' }
  const known = new Set(cfg.categories.map(c => c.id))
  if (body.on !== undefined && typeof body.on !== 'boolean') return { ok: false, error: 'body' }
  if (body.muted !== undefined && typeof body.muted !== 'boolean') return { ok: false, error: 'body' }
  if (body.allLanes !== undefined && typeof body.allLanes !== 'boolean') return { ok: false, error: 'body' }
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
        if (body.allLanes === true) p.allLanes = true
        else if (body.allLanes === false) delete p.allLanes
        if (typeof body.muted === 'boolean') p.muted = body.muted
        if (validLoop(body.loop)) p.loop = body.loop
        else if (body.loop === null) delete p.loop
        s.peers[peer] = p
      })
      audit('agents', peer === TEAM || channel ? null : peer, {
        by: 'ui',
        ...(channel && { thread: peer }),
        ...(typeof body.on === 'boolean' && { on: body.on }),
        ...(Array.isArray(body.lanes) && { lanes: (body.lanes as string[]).join(',') }),
        ...(typeof body.allLanes === 'boolean' && { allLanes: body.allLanes }),
        ...(typeof body.muted === 'boolean' && { muted: body.muted }),
        ...(body.loop !== undefined && { loop: validLoop(body.loop) ? body.loop : 'default' }),
      })
    },
  }
}

/**
 * A file in the board's uploads, as the panel names it for a send (#371): `upload` its place there
 * (`<day>/<saved name>`, as /api/upload answered it) and `name` the name it goes under, by default
 * the saved name without its time. Undefined when the body has none, null when it is no such file:
 * the file is taken by its real path (#467), so a link or junction in the uploads that points out
 * of them is refused.
 */
export function uploadFrom(v: unknown): { path: string; name: string } | null | undefined {
  if (v === undefined) return undefined
  if (!isRecord(v) || typeof v.upload !== 'string') return null
  const m = /^(\d{4}-\d{2}-\d{2})\/([^/]+)$/.exec(v.upload)
  const saved = m?.[2] ?? ''
  if (!m || safeName(saved) !== saved) return null
  const path = join(uploadsDir(), m[1] as string, saved)
  if (!uploadsCheck()(path)) return null
  const name = typeof v.name === 'string' ? v.name : saved.replace(/^\d{6}-/, '')
  return checkMeta({ name, type: 'application/octet-stream', size: 0 }) ? { path, name } : null
}

/**
 * A send's upload as it is when the send goes (#475): a send held for the passkey goes minutes after
 * uploadFrom() checked it, so it is checked again here by its real path and read at once from that
 * path. These bytes go (PostFile.bytes, #415) and the path is not read again, so a link or junction
 * put in its place while the send waited is refused, not followed; one swapped in during the read
 * itself is caught by the real path asked again after it. A file over what /api/upload takes is
 * `file_big` before it is read; `file` when it is no such file now.
 */
function uploadNow(file: { path: string; name: string }): PostFile | 'file' | 'file_big' {
  try {
    const real = realpathSync.native(file.path)
    if (!uploadsCheck()(real)) return 'file'
    if (statSync(real).size > MAX_UPLOAD) return 'file_big'
    const bytes = new Uint8Array(readFileSync(real))
    return realpathSync.native(file.path) === real ? { ...file, bytes } : 'file'
  } catch {
    return 'file'
  }
}

/** A file a session names for its post (#371): an absolute path on this computer; the router checks the rest. */
function agentFileFrom(v: unknown): { path: string } | null | undefined {
  if (v === undefined) return undefined
  if (!isRecord(v) || typeof v.path !== 'string' || v.path.length > 4096 || !isAbsolute(v.path)) return null
  return { path: v.path }
}

/** The peer an owner action is about, for the audit. */
function peerOf(a: OwnerAction): string | null {
  if (a.kind === 'send') return a.to === TEAM ? null : a.to
  if (a.kind === 'trust') return a.peer
  if (a.kind === 'agents') return typeof a.change.peer === 'string' && isPeerId(a.change.peer) ? a.change.peer : null
  if (a.kind === 'welcome') return a.peer
  if (a.kind === 'react') {
    const s = splitKey(a.thread)?.scope
    return s && isPeerId(s) ? s : null
  }
  return null
}

export function teamRoutes(
  team: TeamService,
  router?: TeamRouter,
  cfg?: Pick<Config, 'categories' | 'team'>,
  /** The owner's switches changed (the team chat's mute among them): the unread count follows (#355). */
  onAgents?: () => void,
  confirm?: TeamConfirm,
  /** Shared threads (#394): their owner actions, confirmed here, and the Team list's status pills. */
  work?: WorkHub,
): Route[] {
  const lanes = (): Pick<Config, 'categories' | 'team'> => cfg ?? { categories: [] }

  /**
   * The peers' directories follow a change of the switches (#832): a lane shared or not, Agents on
   * or off. The board's own loop (app.ts) logs what fails there and tries again within a minute.
   */
  function syncDirectory(): void {
    void router?.syncDirectory().catch(() => {})
  }

  /**
   * Why a gated action may not go now (428 with its confirmation), or null: always null while the
   * switch is off (#367). Asked from away (#377: the owner's phone, the domain), it waits for the
   * owner at the computer (GET /api/team/confirm lists it there), and the 428 says so: `where:
   * 'computer'`.
   */
  function held(req: Request, action: OwnerAction): Response | null {
    if (!confirm?.required()) return null
    if (unlocks(action) && confirm.unlocked(req.headers.get('x-board-unlock'))) return null
    if (!confirm.safe()) return json(503, { ok: false, error: 'loopback' })
    const away = confirm.away(req.url)
    const id = confirm.pend(action, away)
    return json(428, {
      ok: false,
      error: 'confirm',
      id,
      confirm: confirm.urlOf(id),
      ...(away && { where: 'computer' }),
    })
  }

  /**
   * Service agents (#819) changed in config.json's `team.services` under its lock, checked again as
   * the list stands then: `{ add: { name, lane } }` or `{ remove: key }`. The board's config follows
   * at once (the watcher reads the same list back), and the change is in the team log.
   */
  function editServices(change: unknown): { status: number; body: Record<string, unknown> } {
    let added: ServiceAgent | undefined
    let removed: ServiceAgent | undefined
    let services: ServiceAgent[] = []
    const r = editTeamServices(now => {
      const c = changeServices(
        now,
        change,
        lanes().categories.map(x => x.id),
      )
      if (c.ok) {
        ;[added, services] = [c.added, c.services]
        removed = now.find(s => !c.services.some(x => x.key === s.key))
      }
      return c
    })
    if (!r.ok) return { status: r.error === 'off' ? 409 : 400, body: r }
    if (cfg && typeof cfg.team === 'object' && cfg.team !== null)
      (cfg.team as Record<string, unknown>).services = services
    const what = added ?? removed
    if (what) audit('service', null, { by: 'ui', op: added ? 'add' : 'remove', key: what.key, lane: what.lane })
    onAgents?.()
    return { status: 200, body: { ok: true, services, ...(added && { added }) } }
  }

  /** Does an owner action: at once when it needs no confirmation, or once the window confirmed it. */
  async function perform(a: OwnerAction): Promise<{ status: number; body: Record<string, unknown> }> {
    if (a.kind.startsWith('thread-'))
      return work ? performThreadAction(work, a) : { status: 409, body: { ok: false, error: 'off' } }
    if (a.kind === 'send') {
      const file = a.file ? uploadNow(a.file) : undefined
      if (typeof file === 'string') return { status: 400, body: { ok: false, error: file } }
      const r = await team.send(a.to, a.text, a.thread, a.replyTo, file)
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
      const c = agentsChange(lanes(), a.change, router)
      if (!c.ok) return { status: 400, body: c }
      c.apply()
      onAgents?.()
      syncDirectory()
      return { status: 200, body: { ok: true } }
    }
    if (a.kind === 'members') {
      const r = team.addMembers(a.key, a.add)
      return { status: r.ok ? 200 : r.error === 'thread' ? 404 : 400, body: { ...r } }
    }
    if (a.kind === 'channel-delete') {
      const r = await team.deleteChannel(a.key)
      if (r.ok) onAgents?.()
      return { status: r.ok ? 200 : r.error === 'thread' ? 404 : r.error === 'not_creator' ? 403 : 400, body: { ...r } }
    }
    if (a.kind === 'channel-leave') {
      const r = await team.leaveChannel(a.key)
      if (r.ok) onAgents?.()
      return { status: r.ok ? 200 : r.error === 'thread' ? 404 : r.error === 'creator' ? 403 : 400, body: { ...r } }
    }
    if (a.kind === 'react') {
      const r = await team.react(a.thread, a.message, a.emoji, a.op, { by: 'ui' })
      return { status: r.ok ? 200 : 400, body: { ...r } }
    }
    if (a.kind === 'welcome') {
      // Checked again as it stands now: the window may answer a while after the ask.
      const w = welcomeFrom(a, team.view()?.roster ?? [], lanes())
      if (!w.ok) return { status: 400, body: w }
      if (w.on !== undefined || w.lanes !== undefined || w.allLanes !== undefined)
        changeAgents(x => {
          const p = x.peers[w.peer] ?? { on: false, lanes: [] }
          if (w.on !== undefined) p.on = w.on
          if (w.lanes !== undefined) p.lanes = w.lanes
          if (w.allLanes === true) p.allLanes = true
          else if (w.allLanes === false) delete p.allLanes
          x.peers[w.peer] = p
        })
      for (const key of w.channels) team.addMembers(key, [w.peer])
      markWelcomed(w.peer, Date.now())
      audit('welcome', w.peer, {
        by: 'ui',
        ...(w.on !== undefined && { on: w.on }),
        ...(w.lanes !== undefined && { lanes: w.lanes.join(',') }),
        ...(w.allLanes !== undefined && { allLanes: w.allLanes }),
        channels: w.channels.length,
      })
      onAgents?.()
      return { status: 200, body: { ok: true } }
    }
    if (a.kind === 'service-add') return editServices({ add: { name: a.name, lane: a.lane } })
    // A passkey added or removed: the confirmation did it.
    return { status: 200, body: { ok: true } }
  }

  /** What the confirmation window shows, in the board's words: names from the roster, never the asker's. */
  function describe(a: OwnerAction): Record<string, unknown> {
    if (a.kind.startsWith('thread-')) return describeThreadAction(a, peer => team.nameOf(peer))
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
        // A new channel: who will read it, by the board's names (#355).
        ...(a.thread?.members && { members: a.thread.members.map(m => team.nameOf(m)) }),
        // A file with it (#371), by the name it goes under.
        ...(a.file && { file: a.file.name }),
      }
    }
    if (a.kind === 'draft') {
      const d = readDrafts().find(x => x.id === a.id)
      return {
        kind: a.kind,
        ...(d && { who: d.to === TEAM ? null : team.nameOf(d.to), text: d.text }),
        ...(d?.file && { file: d.file.name }),
      }
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
      const channelTitle = typeof c.peer === 'string' && isChannel(c.peer) ? (readThreads()[c.peer]?.title ?? '') : null
      return {
        kind: a.kind,
        ...(typeof c.peer === 'string' &&
          (c.peer === TEAM
            ? { team: true }
            : channelTitle !== null
              ? { channel: channelTitle }
              : { who: team.nameOf(c.peer) })),
        ...(c.off === false && { allOn: true }),
        ...(c.mastersOnly === false && { allAgents: true }),
        ...(isRecord(c.master) &&
          typeof c.master.key === 'string' && {
            master: router?.sessionName(c.master.key) ?? c.master.key,
          }),
        ...(typeof c.on === 'boolean' && { on: c.on }),
        ...(Array.isArray(c.lanes) && { lanes: c.lanes.map(l => titles.get(l as string) ?? String(l)) }),
        ...(typeof c.allLanes === 'boolean' && { allLanes: c.allLanes }),
        ...(c.loop !== undefined && { loop: c.loop }),
        ...(typeof c.muted === 'boolean' && { muted: c.muted }),
        // The session by the board's own name for it, never the one the asker gave.
        ...(listener && { listener: router?.sessionName(listener) ?? `a session (${listener.slice(0, 8)})` }),
      }
    }
    if (a.kind === 'welcome') {
      const titles = new Map(lanes().categories.map(x => [x.id, categoryInfo(lanes(), x.id).title]))
      const all = readThreads()
      return {
        kind: a.kind,
        who: team.nameOf(a.peer),
        ...(a.on !== undefined && { on: a.on }),
        ...(a.lanes && { lanes: a.lanes.map(l => titles.get(l) ?? l) }),
        ...(a.allLanes !== undefined && { allLanes: a.allLanes }),
        channels: a.channels.map(k => (Object.hasOwn(all, k) ? (all[k]?.title ?? k) : k)),
      }
    }
    if (a.kind === 'members') {
      const all = readThreads()
      return {
        kind: a.kind,
        channel: Object.hasOwn(all, a.key) ? (all[a.key]?.title ?? '') : '',
        members: a.add.map(m => team.nameOf(m)),
      }
    }
    if (a.kind === 'channel-delete' || a.kind === 'channel-leave') {
      const rec = readThreads()[a.key]
      const me = team.view()?.me.peer
      const members = (rec?.members ?? []).filter(m => m !== me).map(m => team.nameOf(m))
      return {
        kind: a.kind,
        channel: rec?.title ?? '',
        ...(members.length > 0 && { members }),
      }
    }
    if (a.kind === 'service-add')
      return { kind: a.kind, name: a.name, lane: categoryInfo(lanes(), a.lane).title || a.lane }
    if (a.kind === 'passkey-remove')
      return { kind: a.kind, label: confirm?.passkeys().find(p => p.id === a.id)?.label ?? null }
    if (a.kind === 'react') {
      const s = splitKey(a.thread)?.scope ?? ''
      return { kind: a.kind, who: s === TEAM ? null : team.nameOf(s), emoji: a.emoji, op: a.op }
    }
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
        const thread = threadFrom(body.thread, true)
        if (thread === null) return json(400, { ok: false, error: 'thread' })
        const file = uploadFrom(body.file)
        if (file === null) return json(400, { ok: false, error: 'file' })
        // What the send would refuse is refused before it waits for a passkey.
        const text = expandedAlias(team, body.text)
        const words = text.trim()
        if ((!words && !file) || words.length > MAX_TEXT) return json(400, { ok: false, error: 'text' })
        // A reply (#370): a line of the thread it goes to, by its id; the send finds it there.
        if (body.replyTo !== undefined && !isMessageId(body.replyTo)) return json(400, { ok: false, error: 'reply' })
        const replyTo = body.replyTo as string | undefined
        // `@Name.code` first (#832): a peer's agent, in its own topic when this thread is not theirs.
        const a = addressed(team, words, { to: body.to, ...(thread && { thread }), ...(replyTo && { replyTo }) })
        if (!a.ok) return json(400, a)
        const action: OwnerAction = {
          kind: 'send',
          to: a.to,
          text,
          ...(a.thread && { thread: a.thread }),
          ...(a.replyTo && { replyTo: a.replyTo }),
          ...(file && { file }),
        }
        const wait = held(req, action)
        if (wait) return wait
        const r = await perform(action)
        return json(r.status, r.body)
      },
    },
    {
      method: 'POST',
      path: '/api/team/react',
      async handle(req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        if (!isThreadKey(body.thread)) return json(400, { ok: false, error: 'thread' })
        if (!isMessageId(body.message)) return json(400, { ok: false, error: 'message' })
        const emoji = typeof body.emoji === 'string' ? normalizeEmoji(body.emoji) : null
        if (!emoji) return json(400, { ok: false, error: 'emoji' })
        if (body.remove !== undefined && typeof body.remove !== 'boolean')
          return json(400, { ok: false, error: 'body' })
        const op: ReactionOp = body.remove === true ? 'remove' : 'add'
        const line = team.threadLines(body.thread).find(l => l.id === body.message && l.dir !== 'draft' && !l.held)
        if (!line) return json(400, { ok: false, error: 'message' })
        const action: OwnerAction = { kind: 'react', thread: body.thread, message: body.message, emoji, op }
        const wait = held(req, action)
        if (wait) return wait
        const r = await perform(action)
        return json(r.status, r.body)
      },
    },
    {
      method: 'POST',
      path: '/api/team/agent-react',
      async handle(_req, ctx) {
        if (!team.view() || !router) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        const session = sessionFrom(body.session)
        if (!session) return json(400, { ok: false, error: 'body' })
        if (!isThreadKey(body.thread)) return json(400, { ok: false, error: 'thread' })
        if (!isMessageId(body.message)) return json(400, { ok: false, error: 'message' })
        const emoji = typeof body.emoji === 'string' ? normalizeEmoji(body.emoji) : null
        if (!emoji) return json(400, { ok: false, error: 'emoji' })
        if (body.remove !== undefined && typeof body.remove !== 'boolean')
          return json(400, { ok: false, error: 'body' })
        const op: ReactionOp = body.remove === true ? 'remove' : 'add'
        const r = await router.agentReact({
          thread: body.thread,
          message: body.message,
          emoji,
          op,
          session,
          ...(body.claimed === true && { claimed: true }),
        })
        return json(
          r.ok ? 200 : r.error.startsWith('rate') ? 429 : r.error === 'off' || r.error === 'lane' ? 403 : 400,
          r,
        )
      },
    },
    {
      method: 'GET',
      path: '/api/team/threads',
      handle() {
        if (!team.view()) return undefined
        // Each with its latest message for the list (#370), where there is one; a topic that is a
        // shared thread with its key and status (#394), while shared threads are on. Then the
        // agents' drafts that wait for the owner, each with its thread's key (#415).
        const lasts = team.lasts?.() ?? {}
        const shared = work?.on() ? work.topics() : {}
        return json(200, {
          threads: team.threads().map(t => {
            const withLast = Object.hasOwn(lasts, t.key) ? { ...t, last: lasts[t.key] } : t
            return Object.hasOwn(shared, t.key) ? { ...withLast, work: shared[t.key] } : withLast
          }),
          drafts: team.drafts(),
        })
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
        // A topic that is a shared thread says so (#394), as its row in the list does.
        const shared = thread && work?.on() ? work.topics()[key] : undefined
        if (thread)
          return json(200, { thread: shared ? { ...thread, work: shared } : thread, lines: team.threadLines(key) })
        // Nothing written in it yet, but an agent's draft waits there (#370): the draft, no thread.
        const drafts = team.threadLines(key).filter(l => l.dir === 'draft')
        if (!drafts.length) return json(404, { ok: false, error: 'thread' })
        return json(200, { thread: null, lines: drafts })
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
        // A reply to one message (#373): a line of that thread by its id; the router checks it is there.
        if (body.replyTo !== undefined && !isMessageId(body.replyTo)) return json(400, { ok: false, error: 'reply' })
        const replyTo = body.replyTo as string | undefined
        const file = agentFileFrom(body.file)
        if (file === null) return json(400, { ok: false, error: 'file' })
        // `@Name.code` first (#832): a peer's agent, in its own topic when this thread is not theirs.
        const text = expandedAlias(team, body.text)
        const a = addressed(team, text, { to: body.to, ...(thread && { thread }), ...(replyTo && { replyTo }) })
        if (!a.ok) return json(400, a)
        const r = await router.agentPost({
          to: a.to,
          ...(a.thread && { thread: a.thread }),
          ...(a.replyTo && { replyTo: a.replyTo }),
          text,
          session,
          ...(body.claimed === true && { claimed: true }),
          ...(file && { file }),
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
        return json(200, agentsView(lanes(), exposedView(team, router)))
      },
    },
    {
      // The peers' agent directories (#832): whom this board may address as `@Name.code`.
      method: 'GET',
      path: '/api/team/directory',
      handle() {
        if (!team.view()) return undefined
        return json(200, { peers: team.directories() })
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
        if (Object.hasOwn(change, 'publishAlias')) {
          const alias = change.publishAlias
          if (!isRecord(alias) || typeof alias.key !== 'string' || (alias.name !== null && !validAlias(alias.name)))
            return json(400, { ok: false, error: 'name' })
          const key = alias.key
          if (!exposedView(team, router).some(e => e.session.key === key))
            return json(400, { ok: false, error: 'agent' })
          changeDirectoryState(d => {
            if (validAlias(alias.name)) d.aliases[key] = alias.name
            else delete d.aliases[key]
          })
          audit('directory_alias', null, { key, op: alias.name === null ? 'remove' : 'set' })
          onAgents?.()
          syncDirectory()
          return json(200, { ok: true })
        }
        const c = agentsChange(lanes(), change, router)
        if (!c.ok) return json(400, c)
        // Narrowing is never held back; widening waits for the owner's passkey.
        if (widens(readAgents(), change)) {
          const wait = held(req, { kind: 'agents', change })
          if (wait) return wait
        }
        c.apply()
        onAgents?.()
        syncDirectory()
        return json(200, { ok: true })
      },
    },
    {
      // Service agents (#819, core/team-services.ts): { add: { name, lane } } or { remove: key },
      // from the Team panel, on this computer only (localOnly). Written into config.json's
      // `team.services`; the config watcher reloads it and the board gives the card. Registering one
      // shares nothing: what its lane may say to whom stays the owner's switches.
      method: 'POST',
      path: '/api/team/services',
      async handle(req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const body = isRecord(raw) ? raw : {}
        // Checked first, so a wrong name or lane is said at once, not after the owner's passkey.
        const check = changeServices(
          serviceAgents(lanes().team),
          raw,
          lanes().categories.map(x => x.id),
        )
        if (!check.ok) return json(400, check)
        // An added card is an agent in a lane: it widens what agents may post, so the owner confirms it.
        if (check.added) {
          const wait = held(req, { kind: 'service-add', name: check.added.name, lane: check.added.lane })
          if (wait) return wait
        }
        const r = editServices(body)
        return json(r.status, r.body)
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
    {
      // A channel this board started takes more members (#355): { add: [peer ids] }. More boards
      // read it from then on, so it waits for the passkey as widening does.
      method: 'POST',
      path: /^\/api\/team\/threads\/team\/([^/]+)\/members$/,
      async handle(req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const [id = ''] = ctx.params
        if (!isMessageId(id)) return json(400, { ok: false, error: 'thread' })
        const raw = await ctx.rawBody()
        const add = isRecord(raw) ? raw.add : undefined
        if (!Array.isArray(add) || !add.length || !add.every(isPeerId)) return json(400, { ok: false, error: 'body' })
        const key = threadKey(TEAM, id)
        if (!isChannel(key)) return json(404, { ok: false, error: 'thread' })
        const action: OwnerAction = { kind: 'members', key, add }
        const wait = held(req, action)
        if (wait) return wait
        const r = await perform(action)
        return json(r.status, r.body)
      },
    },
    {
      // Delete a channel this board started (#854): removes it locally and sends a signed notice so
      // members archive their copy. Confirmed with the passkey when that switch is on.
      method: 'POST',
      path: /^\/api\/team\/threads\/team\/([^/]+)\/delete$/,
      async handle(req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const [id = ''] = ctx.params
        if (!isMessageId(id)) return json(400, { ok: false, error: 'thread' })
        const key = threadKey(TEAM, id)
        const rec = readThreads()[key]
        if (!rec?.members) return json(404, { ok: false, error: 'thread' })
        if (rec.by !== 'me') return json(403, { ok: false, error: 'not_creator' })
        const action: OwnerAction = { kind: 'channel-delete', key }
        const wait = held(req, action)
        if (wait) return wait
        const r = await perform(action)
        return json(r.status, r.body)
      },
    },
    {
      // Leave a channel another board started (#854): removes it locally and notifies active members.
      // Confirmed with the passkey when that switch is on.
      method: 'POST',
      path: /^\/api\/team\/threads\/team\/([^/]+)\/leave$/,
      async handle(req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const [id = ''] = ctx.params
        if (!isMessageId(id)) return json(400, { ok: false, error: 'thread' })
        const key = threadKey(TEAM, id)
        const rec = readThreads()[key]
        if (!rec?.members) return json(404, { ok: false, error: 'thread' })
        if (rec.by === 'me') return json(403, { ok: false, error: 'creator' })
        const action: OwnerAction = { kind: 'channel-leave', key }
        const wait = held(req, action)
        if (wait) return wait
        const r = await perform(action)
        return json(r.status, r.body)
      },
    },
    {
      // Recover an archived channel back into the active list as read-only (#854).
      method: 'POST',
      path: /^\/api\/team\/threads\/team\/([^/]+)\/restore$/,
      handle(_req, ctx) {
        if (!team.view()) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const [id = ''] = ctx.params
        if (!isMessageId(id)) return json(400, { ok: false, error: 'thread' })
        const key = threadKey(TEAM, id)
        const r = team.restoreChannel(key)
        if (r.ok) onAgents?.()
        return json(r.ok ? 200 : 404, r)
      },
    },
    {
      // Who joined the team since this board began keeping welcomes, and is not welcomed yet (#355).
      method: 'GET',
      path: '/api/team/welcome',
      handle() {
        const view = team.view()
        if (!view) return undefined
        const { since, done } = readWelcomed(Date.now())
        const pins = readPins()
        // A key that changed is not welcomed: it may be someone else's until the owner trusts it.
        const pending = view.roster
          .map(p => p.peer)
          .filter(
            peer => !Object.hasOwn(done, peer) && pins[peer]?.status === 'trusted' && (pins[peer]?.at ?? 0) > since,
          )
        return json(200, { pending })
      },
    },
    {
      // The welcome screen settled (#355): { peer, on?, lanes?, channels? }, checked whole before
      // anything changes; what widens waits for the passkey, then the person's switches, the
      // channels they join, and the mark, in one go.
      method: 'POST',
      path: '/api/team/welcome',
      async handle(req, ctx) {
        const view = team.view()
        if (!view) return undefined
        const refused = ctx.refuse('board-header') ?? ctx.refuse('origin')
        if (refused) return refused
        const raw = await ctx.rawBody()
        const w = welcomeFrom(isRecord(raw) ? raw : {}, view.roster, lanes())
        if (!w.ok) return json(400, w)
        const action: OwnerAction = {
          kind: 'welcome',
          peer: w.peer,
          ...(w.on !== undefined && { on: w.on }),
          ...(w.lanes !== undefined && { lanes: w.lanes }),
          ...(w.allLanes !== undefined && { allLanes: w.allLanes }),
          channels: w.channels,
        }
        if (
          widens(readAgents(), { peer: w.peer, on: w.on, lanes: w.lanes, allLanes: w.allLanes, channels: w.channels })
        ) {
          const wait = held(req, action)
          if (wait) return wait
        }
        const r = await perform(action)
        return json(r.status, r.body)
      },
    },
    ...(confirm ? confirmRoutes(team, confirm, describe, perform) : []),
  ]
}

/** A welcome's body, checked whole: a roster peer, agents on or off, this board's lanes, channels it started. */
function welcomeFrom(
  body: Record<string, unknown>,
  roster: { peer: string }[],
  cfg: Pick<Config, 'categories'>,
):
  | {
      ok: true
      peer: string
      on: boolean | undefined
      lanes: string[] | undefined
      allLanes: boolean | undefined
      channels: string[]
    }
  | { ok: false; error: string } {
  const peer = body.peer
  if (!isPeerId(peer) || !roster.some(p => p.peer === peer)) return { ok: false, error: 'peer' }
  if (readPins()[peer]?.status !== 'trusted') return { ok: false, error: 'changed' }
  if (body.on !== undefined && typeof body.on !== 'boolean') return { ok: false, error: 'body' }
  if (body.allLanes !== undefined && typeof body.allLanes !== 'boolean') return { ok: false, error: 'body' }
  const known = new Set(cfg.categories.map(c => c.id))
  if (body.lanes !== undefined && !(Array.isArray(body.lanes) && body.lanes.every(l => known.has(l))))
    return { ok: false, error: 'lanes' }
  const all = readThreads()
  const channels = body.channels ?? []
  if (
    !Array.isArray(channels) ||
    !channels.every(k => {
      const c = typeof k === 'string' && Object.hasOwn(all, k) ? all[k] : undefined
      return (
        !!c?.members && !c.archived && c.by === 'me' && (c.members.includes(peer) || c.members.length < MAX_MEMBERS)
      )
    })
  )
    return { ok: false, error: 'channels' }
  return {
    ok: true,
    peer,
    on: typeof body.on === 'boolean' ? body.on : undefined,
    lanes: Array.isArray(body.lanes) ? [...new Set(body.lanes as string[])] : undefined,
    allLanes: typeof body.allLanes === 'boolean' ? body.allLanes : undefined,
    channels: [...new Set(channels as string[])],
  }
}

/**
 * The passkeys and the confirmation window's routes (#224): GET /api/team/passkeys lists them and
 * says whether the switch is on (`required`, #367); POST /api/team/passkeys { op: 'add' } or
 * { op: 'remove', id } is confirmed in the window like any gated action, and so are { op: 'on' }
 * (403 { error: 'passkey' } with none to confirm with) and { op: 'off' }; either answers 200 at once
 * when the switch already stands that way. GET /api/team/confirm/<id> is what the window shows and the WebAuthn options;
 * POST /api/team/confirm/<id> is its answer, taken only from the window's origin
 * (http://localhost:<port>): a page on 127.0.0.1 is told the localhost address instead. GET
 * /api/team/confirm lists what was asked from away and waits for the owner here (#377).
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
        return json(200, { passkeys: confirm.passkeys(), required: confirm.required() })
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
        else if (body.op === 'on' || body.op === 'off') {
          const on = body.op === 'on'
          if (confirm.required() === on) return json(200, { ok: true })
          if (on && !confirm.hasPasskey()) return json(403, { ok: false, error: 'passkey' })
          // Off: an agent could not switch it off. On: the passkey shows it signs on this computer
          // before anything waits for it.
          action = { kind: on ? 'passkey-on' : 'passkey-off' }
        } else if (body.op === 'remove' && typeof body.id === 'string') {
          if (!confirm.passkeys().some(p => p.id === body.id)) return json(404, { ok: false, error: 'passkey' })
          action = { kind: 'passkey-remove', id: body.id }
        } else return json(400, { ok: false, error: 'body' })
        const id = confirm.pend(action)
        return json(428, { ok: false, error: 'confirm', id, confirm: confirm.urlOf(id) })
      },
    },
    {
      // What was asked from away and waits for the owner here (#377), for the Team panel: each with
      // the address of its window and what it does, in the board's words. The computer's only
      // (localOnly; not one of the owner's routes away, core/remote.ts ownerTeam). A program on this
      // computer can read it, as it can read the threads; doing any of it still takes the passkey.
      method: 'GET',
      path: '/api/team/confirm',
      handle() {
        if (!team.view()) return undefined
        return json(200, {
          waiting: confirm
            .waiting()
            .map(w => ({ id: w.id, at: w.at, confirm: confirm.urlOf(w.id), action: describe(w.action) })),
        })
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
