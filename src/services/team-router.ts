// Agents of different boards talking through the team hub (#216): what a session's post may do
// without a person, and which session hears of what comes in. It sits beside the hub client
// (team-hub.ts), which stays without Deps: this file reaches sessions only through the schedule
// (the path `board remind` takes, which wakes a sleeping session and waits out a dialog or the
// owner's unsent text), and only with a notice the board writes itself. A peer's text is never in
// it: the session reads that with `board team thread`, as a command's output.
//
// Everything here is off until the owner turns Agents on for a peer (or the team) in
// team-agents.json, and the global off (the panel's, or config.json's `team.agents: false`) wins.
// Off, an agent's post becomes a draft, as before #216, and nothing that comes in reaches a session.

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { archivedFiles, isArchived } from '../adapters/archive-store.ts'
import { readCard } from '../adapters/cards.ts'
import { ownerServices } from '../adapters/owner-services.ts'
import { configDir, stateDir, uploadsDir } from '../adapters/paths.ts'
import { addEntry, listEntries, updateEntry } from '../adapters/schedule-store.ts'
import {
  audit,
  changeAgents,
  changeDirectoryState,
  type OutboxItem,
  readAgents,
  readAllInbox,
  readAllOutbox,
  readDirectoryState,
  readThreads,
  type SessionRef,
} from '../adapters/team-store.ts'
import { categoryInfo } from '../core/categories.ts'
import { parseNodeKey, resolveBoardKey } from '../core/nodes.ts'
import { isOwnerServiceKey } from '../core/owner-services.ts'
import {
  DEFAULT_MAX_FILE_BYTES,
  GENERAL,
  isPeerId,
  MAX_TEXT,
  REACTION_OPS,
  type ReactionOp,
  type WorkPost,
} from '../core/team.ts'
import {
  type AgentLimits,
  addressedText,
  agentLimits,
  fileScanText,
  laneHit,
  loopFor,
  loopRun,
  noticeText,
  pausedText,
  safeName,
  secretHit,
  sharesAnyLane,
  sharesLane,
  splitKey,
  TEAM,
  threadKey,
  threadRef,
  unreachableText,
} from '../core/team-agents.ts'
import { assignHandles, directoryFor, type ReachWorld, reach, sharesHandleLane } from '../core/team-directory.ts'
import { validEmoji } from '../core/team-reactions.ts'
import type { DirectoryEntry } from '../core/team-wire.ts'
import type { Config } from '../core/types.ts'
import type { InboundEvent, PostResult, PostTarget, ReactResult, TeamService } from './team-hub.ts'

/** A session as the router needs it: its card key, name and lane. */
export interface RouterItem {
  key: string
  name?: string
  /** The name the board gave the card when it has none of its own. */
  autoName?: string
  category: string
  /** The owner's service agent (#819): no pane to type a notice into; it waits for its threads through the MCP. */
  service?: true
}

/** A notice in the schedule: what the router reads back and changes. */
export interface NoticeEntry {
  id: string
  key: string
  teamThread?: unknown
  teamCount?: unknown
  claim?: unknown
}

export interface NoticeSchedule {
  list(): NoticeEntry[]
  add(entry: { key: string; name?: string; text: string; next: number; teamThread: string; teamCount: number }): void
  /** Changes a pending notice's text and count; false when it is gone or on its way. */
  update(id: string, text: string, count: number): boolean
}

export type AgentPostResult =
  | (Extract<PostResult, { ok: true }> & { sent: true })
  | { ok: true; sent: false; draft: string; reason: string; detail?: string }
  | { ok: false; error: string; detail?: string }

/**
 * An agent's file read once, whole (#415): its bytes, which the secret check reads and the post
 * sends; nothing reads the path again for the post. `file` when it is no regular file, cannot be
 * read or changed size while it was read; `file_big` past `max`.
 */
export function readAgentFile(
  path: string,
  max: number,
): { ok: true; bytes: Uint8Array } | { ok: false; error: 'file' | 'file_big' } {
  let fd: number | undefined
  try {
    // Without blocking on what is no file (a FIFO would hold the board until a writer came), and only a file.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    const st = fstatSync(fd)
    if (!st.isFile()) return { ok: false, error: 'file' }
    if (st.size > max) return { ok: false, error: 'file_big' }
    // One byte more than it said: a file that grew meanwhile is caught, not cut short.
    const buf = Buffer.alloc(st.size + 1)
    let n = 0
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, n)
      if (got === 0) break
      n += got
    }
    if (n !== st.size) return { ok: false, error: 'file' }
    return { ok: true, bytes: new Uint8Array(buf.buffer, buf.byteOffset, n) }
  } catch {
    return { ok: false, error: 'file' }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** A file's size now, for the echo check; undefined when it cannot be read (the read refuses it then). */
function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

/** A path as compared: its real one (links and junctions followed), in one case on Windows. */
function realOf(path: string): string | null {
  try {
    const real = realpathSync.native(path)
    return process.platform === 'win32' ? real.toLowerCase() : real
  } catch {
    return null
  }
}

/**
 * Whether a file is the board's own (#415): in its state or config folder, where its keys, its
 * settings and its logs are. What came in (the uploads) and a shared thread's files are not: an
 * agent passes those on.
 */
export function boardOwnFile(path: string): boolean {
  const file = realOf(path)
  if (!file) return false
  const inside = (dir: string): boolean => {
    const d = realOf(dir)
    return !!d && (file === d || file.startsWith(d.endsWith(sep) ? d : d + sep))
  }
  if (inside(uploadsDir()) || inside(join(stateDir(), 'thread-files'))) return false
  // Files pulled from a node for a single uplink call live under nodes/<device>/uplink/<callId>/;
  // every other file under nodes/ (tokens, link keys, snapshots) remains off-limits.
  const nodesRoot = realOf(join(stateDir(), 'nodes'))
  if (nodesRoot) {
    const prefix = nodesRoot.endsWith(sep) ? nodesRoot : nodesRoot + sep
    if (file.startsWith(prefix) && /^[^/\\]+[/\\]uplink[/\\][^/\\]+[/\\]/.test(file.slice(prefix.length))) return false
  }
  return inside(stateDir()) || inside(configDir())
}

export interface TeamRouter {
  /**
   * A session's post (`board team post | reply`): sent, held as a draft with the reason, or refused.
   * A file (#371) goes as its text does (#415): held only when the text would be, or when a
   * text-like file looks like it carries a secret.
   */
  agentPost(
    p: PostTarget & {
      text: string
      session: SessionRef
      claimed?: boolean
      file?: { path: string }
      /** A shared thread's entry (#394): it goes, or is held, as any post of the session's does. */
      work?: WorkPost
    },
  ): Promise<AgentPostResult>
  /** A session's reaction (`board team react`): allowed only where the session may post to that thread. */
  agentReact(p: {
    thread: string
    message: string
    emoji: string
    op: ReactionOp
    session: SessionRef
    claimed?: boolean
  }): Promise<ReactResult>
  /** The hub client kept a message: a notice for the session that handles its thread, or the listener. */
  inbound(e: InboundEvent): void
  /** Hands a thread to a session (a lane shared with the peer, or the listener), or back (null). */
  assign(key: string, session: SessionRef | null): { ok: true } | { ok: false; error: string }
  /**
   * A session makes itself the listener, or stops being it (`caller` with `session` null). It does
   * not take the place of another listener: the owner changes that in the switches.
   */
  listen(session: SessionRef | null, caller?: SessionRef): { ok: true } | { ok: false; error: string }
  /** What the board calls a session (its card's name), never what a caller said; null when it has none. */
  sessionName(key: string): string | null
  hasSession(key: string): boolean
  /** Resolves a session reference to the full board key (`@<node>:<key>` for node sessions). */
  resolveSession(session: SessionRef): SessionRef
  /** The directory a peer would get now (#832): every session a message from them could reach. */
  directoryFor(peer: string): DirectoryEntry[]
  /**
   * What the owner's panel shows (#832): each session with a handle that someone of `peers` can
   * reach now, its lane, and whom. Empty without a peer whose Agents are on: nothing is read then.
   */
  exposed(
    peers: string[],
  ): { code: string; alias?: string; session: { key: string; name: string }; lane: string; reaches: string[] }[]
  /**
   * Sends each peer its directory where it changed (#832): to every peer with a session it can
   * reach, and once more to one that had a list before (an empty list takes it back). Nothing is
   * sent while no peer has Agents on and none ever got a list. Resolves how many went.
   */
  syncDirectory(): Promise<number>
}

interface Options {
  team: TeamService
  cfg: Pick<Config, 'team' | 'categories'>
  /** The board's sessions as it last saw them; no herdr call is made for this. */
  items: () => RouterItem[]
  schedule: NoticeSchedule
  now?: () => number
  log?: (line: string) => void
}

const HOUR = 3_600_000
/**
 * Whose switches rule a thread (#355): a channel's own entry, under its key, else its scope's (the
 * pair's peer, or the team for the team chat and its topics).
 */
export function switchesKey(scope: string, key: string | null): string {
  if (scope !== TEAM || !key) return scope
  const all = readThreads()
  return Object.hasOwn(all, key) && all[key]?.members ? key : scope
}

/** Notices waiting for one session at most; the schedule keeps 30 entries a session in all. */
export const MAX_PENDING_NOTICES = 10
const DAY = 24 * HOUR

const teamCfg = (cfg: Pick<Config, 'team'>): Record<string, unknown> =>
  typeof cfg.team === 'object' && cfg.team !== null ? (cfg.team as Record<string, unknown>) : {}

export function createTeamRouter({ team, cfg, items, schedule, now = Date.now, log = () => {} }: Options): TeamRouter {
  const limits = (): AgentLimits => agentLimits(teamCfg(cfg).agentLimits)
  const globalOff = (off: boolean): boolean => off || teamCfg(cfg).agents === false
  /** When a notice last went to a session for a thread, so the next one waits its gap. */
  const lastNotice = new Map<string, number>()
  /** The words of the last addressed notice for a session and thread (#875), kept while it waits. */
  const namedNotice = new Map<string, (count: number) => string>()
  /** The directory look under way (#832): the next one waits for it. */
  let syncing: Promise<number> = Promise.resolve(0)
  /** In-memory reaction timestamps per session for hourly rate limiting (#687). */
  const recentReacts = new Map<string, number[]>()

  const laneOf = (key: string): string | null => items().find(i => i.key === key)?.category ?? null
  const shares = (peer: Parameters<typeof sharesLane>[0], key: string): boolean =>
    isOwnerServiceKey(key) ? sharesAnyLane(peer, cfg.categories) : sharesLane(peer, laneOf(key) ?? '')

  const resolveKey = (key: string, known = items()): string =>
    isOwnerServiceKey(key) ? key : resolveBoardKey(key, known)

  const resolveRef = (ref: SessionRef, known = items()): SessionRef => {
    const key = resolveKey(ref.key, known)
    return key === ref.key ? ref : { ...ref, key }
  }

  const resolveListener = (s: ReturnType<typeof readAgents>, known = items()): SessionRef | null => {
    if (!s.listener) return null
    const next = resolveRef(s.listener, known)
    if (next.key !== s.listener.key) {
      const prev = s.listener.key
      changeAgents(x => {
        if (x.listener?.key === prev) x.listener = { ...x.listener, key: next.key }
      })
      audit('listener', null, { session: next.key, upgraded: prev })
    }
    return next
  }

  /**
   * A service agent (#819) is what the board calls it, never what its call said: its card's name is
   * the one its posts carry ("anna's agent Juno"). Every other session is resolved to its full board
   * key (`@<node>:<key>` when on a node).
   */
  const asCalled = (session: SessionRef): SessionRef | null => {
    if (isOwnerServiceKey(session.key)) return ownerServices().find(s => s.key === session.key) ?? null
    const resolved = resolveRef(session)
    const item = items().find(i => i.key === resolved.key)
    return item?.service && item.name ? { key: resolved.key, name: item.name } : resolved
  }

  /**
   * What the handles reach (#832): the board's sessions now, none archived or being archived (the
   * archive's own records are read, not only the board's last look), their handles and the
   * switches. With `assign`, each session in a lane shared with someone who has Agents on gets its
   * handle, kept in team-directory.json from then on; without, only the handles there count.
   * In masters-only mode the live sessions still reserve their handles when hidden.
   */
  function world(s: ReturnType<typeof readAgents>, assign = false): ReachWorld {
    const archived = archivedFiles()
    const active = items().filter(i => !isArchived(archived, i.key))
    const services = active.some(i => isOwnerServiceKey(i.key)) ? ownerServices() : []
    const sessions = active.flatMap(i => {
      const session = { key: i.key, name: i.name || i.autoName || '', lane: i.category }
      if (!isOwnerServiceKey(i.key)) return [session]
      const service = services.find(s => s.key === i.key)
      return service ? [{ ...session, name: service.name, ownerServiceLanes: cfg.categories }] : []
    })
    const reachable = s.mastersOnly ? sessions.filter(i => readCard(i.key)?.teamMaster === true) : sessions
    const state = readDirectoryState()
    let handles = state.handles
    if (assign && !globalOff(s.off)) {
      const open = Object.entries(s.peers).filter(([p, sw]) => isPeerId(p) && sw?.on)
      // Every session on the board counts as there: one in a lane shared with nobody now keeps its handle.
      const next = assignHandles(
        reachable.filter(x => open.some(([, sw]) => sharesHandleLane(sw, x))),
        handles,
        new Set(sessions.map(x => x.key)),
      )
      if (JSON.stringify(next) !== JSON.stringify(handles)) {
        changeDirectoryState(d => {
          d.handles = next
        })
        handles = next
      }
    }
    return { handles, aliases: state.aliases, off: globalOff(s.off), peers: s.peers, sessions: reachable }
  }

  /**
   * Who named a session in a team thread's message (#875): the sender of that line of `key`, when
   * its copy carried a handle that reaches this session for them now (Agents on for them, the lane
   * shared, not archived); else null.
   */
  function askedBy(key: string, line: string, session: string, s: ReturnType<typeof readAgents>): string | null {
    for (const [from, list] of Object.entries(readAllInbox())) {
      const i = list.find(x => x.id === line && x.thread === key)
      if (!i) continue
      return i.at && !i.held && reach(i.at, from, world(s))?.key === session ? from : null
    }
    return null
  }

  /**
   * Whether everyone a team thread's posts reach may read what `fits` asks of their switches (#875):
   * the thread's own switches (the team's, or the channel's) are on and fit, or every member but
   * `asker` (the team's roster, or the channel's members) has Agents on and fits.
   */
  function everyoneShares(
    key: string,
    asker: string,
    fits: (sw: Parameters<typeof sharesLane>[0]) => boolean,
    s: ReturnType<typeof readAgents>,
  ): boolean {
    const own = s.peers[switchesKey(TEAM, key)]
    if (own?.on && fits(own)) return true
    const members = readThreads()[key]?.members
    return (team.view()?.roster ?? [])
      .filter(p => p.peer !== asker && (!members || members.includes(p.peer)))
      .every(p => !!s.peers[p.peer]?.on && fits(s.peers[p.peer]))
  }

  function nameOf(key: string): string | null {
    const k = resolveKey(key)
    const item = items().find(i => i.key === k)
    return item?.name || item?.autoName || null
  }

  /** The agent's posts kept here, one per post (a team post's copies count once), sent within `since`. */
  function agentPosts(since: number): OutboxItem[] {
    const seen = new Set<string>()
    const out: OutboxItem[] = []
    for (const list of Object.values(readAllOutbox()))
      for (const o of list) {
        const id = o.post ?? o.msg.id
        // A draft the owner sent (pressed) is the owner's word: it counts against no agent's limit.
        if (o.by !== 'agent' || o.pressed || seen.has(id) || Date.parse(o.msg.ts) < since) continue
        seen.add(id)
        out.push(o)
      }
    return out
  }

  /**
   * Why a post may not go now at all (a refusal, not a draft), or null. An echo is the same text
   * with a file of the same name and size, or with no file both times (#415): another file under
   * one caption, or under none, is no echo, nor is the same file changed.
   */
  function overLimit(
    to: string,
    key: string | null,
    text: string,
    session: SessionRef,
    file: { name: string; size: number | undefined } | undefined,
  ): string | null {
    const l = limits()
    const t = now()
    const day = agentPosts(t - DAY)
    const hour = day.filter(o => Date.parse(o.msg.ts) >= t - HOUR)
    if (hour.filter(o => o.session?.key === session.key).length >= l.sessionHour) return 'rate_session'
    const toThis = (o: OutboxItem): boolean =>
      to === TEAM ? !!o.thread?.startsWith(`${TEAM}/`) : o.msg.to === to && !o.thread?.startsWith(`${TEAM}/`)
    if (hour.filter(toThis).length >= l.peerHour) return 'rate_peer'
    if (day.filter(toThis).length >= l.peerDay) return 'rate_day'
    const echo = t - l.echoMin * 60_000
    const same = text.trim()
    if (
      key &&
      day.some(
        o =>
          o.thread === key &&
          Date.parse(o.msg.ts) >= echo &&
          (o.text ?? o.msg.body.text) === same &&
          o.file?.name === file?.name &&
          o.file?.size === file?.size,
      )
    )
      return 'echo'
    return null
  }

  return {
    async agentPost({ to, thread, text, session: given, claimed, replyTo, file, work }) {
      const session = asCalled(given)
      if (!session) return { ok: false, error: 'session' }
      const view = team.view()
      if (!view) return { ok: false, error: 'off' }
      if (to !== TEAM && !isPeerId(to)) return { ok: false, error: 'peer' }
      const s = readAgents()
      // A new thread (a title, no id) has no key yet: nothing to loop in, nothing to echo.
      const key = thread?.title !== undefined && thread.id === undefined ? null : threadKey(to, thread?.id ?? GENERAL)
      if (key && readThreads()[key]?.archived) return { ok: false, error: 'archived' }
      // A reply to one message (#373) names a line of this thread that may be answered: a message
      // either way, not a draft, not one held back. Refused at once, held or not, so a draft the owner
      // would send later does not fail then.
      if (
        replyTo !== undefined &&
        !(key && team.threadLines(key).some(l => l.id === replyTo && l.dir !== 'draft' && !l.held))
      )
        return { ok: false, error: 'reply' }
      // Too long is said with its numbers (#415): the agent can tell how much to cut, or send a file.
      const length = text.trim().length
      if (length > MAX_TEXT) return { ok: false, error: 'text', detail: `${length} of ${MAX_TEXT}` }
      // A session's answer to a message that named it in the team chat or a channel (#875): a reply
      // to that message, weighed by the switches this board keeps for its writer, as an answer in a
      // pair's thread is. Any other post there goes by the team's (or the channel's) switches.
      const asker = to === TEAM && key && replyTo !== undefined ? askedBy(key, replyTo, session.key, s) : null
      const peer = s.peers[asker ?? switchesKey(to, key)]
      const name = file && basename(file.path)
      const refused = overLimit(to, key, text, session, name ? { name, size: sizeOf(file.path) } : undefined)
      if (refused) return { ok: false, error: refused }
      const listener = resolveListener(s)?.key === session.key
      let reason: string | null = null
      let detail: string | undefined
      // A new thread's title and link go out as well as the text: they are checked with it, and a
      // file's name too.
      // A shared thread's entry (#394): its fields go out as well, in `work`, and are checked with it.
      const fields = work
        ? [
            work.body.set?.summary,
            work.body.set?.waitingOn,
            work.body.set?.title,
            work.body.head.title,
            work.body.head.summary,
          ]
        : []
      const words = [text, thread?.title, thread?.link, name, ...fields].filter(w => typeof w === 'string').join('\n')
      let bytes: Uint8Array | undefined
      if (globalOff(s.off) || !peer?.on) reason = 'off'
      else if ((!listener || isOwnerServiceKey(session.key)) && !shares(peer, session.key)) reason = 'lane'
      // An answer on the writer's pass reaches everyone in the thread (#875): the session's lane must
      // be one the thread's own switches share, or one shared with every member who reads it.
      else if (
        (!listener || isOwnerServiceKey(session.key)) &&
        asker &&
        key &&
        !everyoneShares(key, asker, sw => shares(sw, session.key), s)
      )
        reason = 'lane'
      else {
        // The file (#415): one of the board's own (its keys, its settings) is held as a secret;
        // any other is read once, here, and these bytes are what the check reads and the post
        // sends. A text-like file's content runs the secret check the text runs; a binary goes
        // as it is. A file that cannot be read whole is refused: nothing reads the path again.
        let fileSecret: string | null = null
        if (file && boardOwnFile(file.path)) fileSecret = "a file of the board's own (its keys or settings)"
        else if (file) {
          const read = readAgentFile(file.path, view.files?.max ?? DEFAULT_MAX_FILE_BYTES)
          if (!read.ok) return { ok: false, error: read.error }
          bytes = read.bytes
          const inFile = fileScanText(bytes)
          const hit = inFile === null ? null : secretHit(inFile)
          if (hit) fileSecret = `${hit} in the file`
        }
        const secret = secretHit(words) ?? fileSecret
        const others = cfg.categories
          .filter(
            c =>
              !sharesLane(peer, c.id) ||
              (!!asker && !!key && !everyoneShares(key, asker, sw => sharesLane(sw, c.id), s)),
          )
          .map(c => ({ id: c.id, title: categoryInfo(cfg, c.id).title }))
        const lane = secret ? null : laneHit(words, others)
        if (secret) [reason, detail] = ['secret', secret]
        else if (lane) [reason, detail] = ['lane_name', lane]
        else if (key) {
          // What the owner sent from a draft is a person's step: it breaks a run as a person's message does.
          const vias = team
            .threadLines(key)
            .filter(l => l.dir !== 'draft')
            .map(l => (l.pressed ? undefined : l.via))
          if (loopRun(vias, loopFor(peer, limits()))) reason = 'loop'
        }
      }
      if (reason) {
        const d = team.draft(to, text, {
          ...(thread && { thread }),
          reason,
          session,
          ...(replyTo && { replyTo }),
          ...(file && name && { file: { path: file.path, name } }),
          ...(work && { work }),
        })
        if (!d.ok) return d
        audit('held', to === TEAM ? null : to, {
          id: d.id,
          reason,
          session: session.key,
          ...(claimed && { claimed: true }),
        })
        return { ok: true, sent: false, draft: d.id, reason, ...(detail && { detail }) }
      }
      // Not held, a file went through the read above: only those bytes go.
      if (file && (!bytes || !name)) return { ok: false, error: 'file' }
      const r = await team.post(
        { to, ...(thread && { thread }), ...(replyTo && { replyTo }) },
        text,
        { by: 'agent', session, ...(claimed && { claimed: true }) },
        file && name && bytes ? { path: file.path, name, bytes } : undefined,
        work,
      )
      if (!r.ok) return r
      // A topic thread nobody here handled is the poster's now, unless the poster is the listener.
      // A general thread stays the listener's: whatever an older board sends lands there.
      const rec = readThreads()[r.thread]
      if (rec && rec.id !== GENERAL && !rec.handler && !listener) team.setThread(r.thread, { handler: session })
      return { ...r, sent: true }
    },

    async agentReact({ thread, message, emoji, op, session: given, claimed }) {
      const session = asCalled(given)
      if (!session) return { ok: false, error: 'session' }
      const view = team.view()
      if (!view) return { ok: false, error: 'off' }
      const parts = splitKey(thread)
      if (!parts) return { ok: false, error: 'thread' }
      if (readThreads()[thread]?.archived) return { ok: false, error: 'archived' }
      if (!validEmoji(emoji)) return { ok: false, error: 'emoji' }
      if (!REACTION_OPS.some(o => o === op)) return { ok: false, error: 'body' }
      const line = team.threadLines(thread).find(l => l.id === message && l.dir !== 'draft' && !l.held)
      if (!line) return { ok: false, error: 'message' }
      const s = readAgents()
      const peer = s.peers[switchesKey(parts.scope, thread)]
      if (globalOff(s.off) || !peer?.on) return { ok: false, error: 'off' }
      const listener = resolveListener(s)?.key === session.key
      if ((!listener || isOwnerServiceKey(session.key)) && !shares(peer, session.key))
        return { ok: false, error: 'lane' }
      const t = now()
      const maxReacts = limits().sessionHour * 3
      const kept = (recentReacts.get(session.key) ?? []).filter(at => at >= t - HOUR)
      if (kept.length >= maxReacts) {
        recentReacts.set(session.key, kept)
        return { ok: false, error: 'rate_session' }
      }
      const r = await team.react(thread, message, emoji, op, {
        by: 'agent',
        session,
        ...(claimed && { claimed: true }),
      })
      if (r.ok) {
        kept.push(t)
        recentReacts.set(session.key, kept)
      }
      return r
    },

    inbound(e) {
      if (e.held) return
      const s = readAgents()
      if (globalOff(s.off)) return
      const parts = splitKey(e.thread)
      if (!parts) return
      const isTeam = parts.scope === TEAM
      // Addressed to one of this board's agents by its handle (#832): a pair's word, weighed by the
      // switches this board keeps for its writer, in the team chat or a channel too (#875). Under the
      // default policy an empty board (its first look has not happened yet) proves nothing: routed
      // as any other; with masters only (#872) the mapping alone decides.
      const addressed = !!e.at && (!isTeam || !!s.peers[e.from]?.on) && (s.mastersOnly || items().length > 0)
      // A channel has switches of its own (#355); the team chat's mute is not a channel's, and it
      // holds for a message addressed there too.
      const own = isTeam ? switchesKey(TEAM, e.thread) : e.from
      const rules = addressed ? e.from : own
      if (!s.peers[rules]?.on) return
      if (own === TEAM && s.peers[TEAM]?.muted) return
      const rec = readThreads()[e.thread]
      if (rec?.muted || rec?.archived) return
      const t = now()
      if ((s.paused[e.from] ?? 0) > t) return
      const who = safeName(team.nameOf(e.from), e.from)
      const known = items()
      const listener = resolveListener(s, known)
      // Every message counts, marked or not: the mark is the sender's own word.
      const recent = (readAllInbox()[e.from] ?? []).filter(i => i.receivedAt >= t - HOUR)
      if (recent.length > limits().inboundHour) {
        changeAgents(x => {
          x.paused[e.from] = t + HOUR
        })
        audit('routing_paused', e.from, { minutes: 60 })
        log(`team: routing paused for an hour, too many messages from ${who}`)
        if (listener) notify(listener, `paused:${e.from}`, pausedText(who, 60), t)
        return
      }
      // A handler that left the board gives the thread back to the listener. An empty board (the
      // first look has not happened yet) proves nothing.
      let handler = rec?.handler ?? null
      if (handler && known.length) {
        const resolved = resolveRef(handler, known)
        if (resolved.key !== handler.key) {
          team.setThread(e.thread, { handler: resolved })
          handler = resolved
        }
        if (!known.some(i => i.key === handler?.key)) {
          team.setThread(e.thread, { handler: null })
          audit('released', isTeam ? null : e.from, { thread: e.thread, why: 'gone' })
          handler = null
        }
      }
      const ref = threadRef(parts.scope, parts.id)
      // Addressed (#832): the board's mapping, while the session's lane is shared with the sender;
      // anything else goes to the listener with a note, never a guess, and never to an archived
      // session. The notice names the message, so the answer goes to it where it was written (#875).
      if (addressed && e.at) {
        const addr = { who, agent: e.via === 'agent', ref, team: isTeam, code: e.at, message: e.id.slice(0, 8) }
        const hit = reach(e.at, e.from, world(s))
        if (hit) {
          const name = nameOf(hit.key) ?? (hit.name || undefined)
          const session: SessionRef = { key: hit.key, ...(name && { name }) }
          // A pair's topic nobody but the listener handles becomes the session's; one another session
          // handles stays with it, and a general thread stays the listener's (what an older board
          // sends lands there). A team thread or a channel stays as it was (#875): it is everyone's,
          // and the session only hears of this message.
          const takes = !isTeam && parts.id !== GENERAL && (!handler || handler.key === listener?.key)
          if (takes && handler?.key !== session.key) {
            team.setThread(e.thread, { handler: session })
            audit('assigned', isTeam ? null : e.from, { thread: e.thread, session: session.key, why: 'addressed' })
          }
          // A service agent (#819) finds the thread through the MCP's wait: nothing in the schedule.
          // Not yet a team thread or a channel it does not handle (#880).
          if (!known.some(i => i.key === session.key && i.service))
            notify(session, e.thread, (count: number) => addressedText({ ...addr, count }), t, true)
          return
        }
        audit('unreachable', isTeam ? null : e.from, { thread: e.thread, code: e.at })
        if (listener) notify(listener, e.thread, (count: number) => unreachableText({ ...addr, count }), t, true)
        return
      }
      const target = handler ?? listener
      if (!target) return
      // A service agent (#819) has no pane to type a notice into: it asks for its threads through
      // the MCP (`team` wait), which finds them by their unread count. Nothing goes in the schedule.
      if (known.some(i => i.key === target.key && i.service)) return
      const base = { who, agent: e.via === 'agent', ref, team: isTeam, route: !handler }
      notify(target, e.thread, (count: number) => noticeText({ ...base, count }), t)
    },

    assign(key, session) {
      const parts = splitKey(key)
      if (!parts || !team.threads().some(t => t.key === key)) return { ok: false, error: 'thread' }
      if (readThreads()[key]?.archived) return { ok: false, error: 'archived' }
      if (session) {
        if (isOwnerServiceKey(session.key)) {
          session = asCalled(session)
          if (!session) return { ok: false, error: 'session' }
        } else {
          session = resolveRef(session)
        }
        const s = readAgents()
        const peer = s.peers[switchesKey(parts.scope, key)]
        if (resolveListener(s)?.key !== session.key && !shares(peer, session.key)) return { ok: false, error: 'lane' }
      }
      team.setThread(key, { handler: session })
      audit(session ? 'assigned' : 'released', parts.scope === TEAM ? null : parts.scope, {
        thread: key,
        ...(session && { session: session.key }),
      })
      return { ok: true }
    },

    listen(session, caller) {
      const known = items()
      const nextSession = session ? resolveRef(session, known) : null
      const nextCaller = caller ? resolveRef(caller, known) : undefined
      const r = changeAgents((x): { ok: true } | { ok: false; error: string } => {
        const now = x.listener ? resolveRef(x.listener, known) : null
        if (nextSession && now && now.key !== nextSession.key) return { ok: false, error: 'taken' }
        if (!nextSession && now && nextCaller && now.key !== nextCaller.key) return { ok: false, error: 'not_listener' }
        x.listener = nextSession
        return { ok: true }
      })
      if (r.ok) audit('listener', null, nextSession ? { session: nextSession.key } : {})
      return r
    },

    sessionName: nameOf,

    hasSession(key) {
      return items().some(i => i.key === key) && !isArchived(archivedFiles(), key)
    },

    resolveSession: ref => resolveRef(ref),

    directoryFor(peer) {
      return directoryFor(peer, world(readAgents()))
    },

    exposed(peers) {
      const s = readAgents()
      if (globalOff(s.off) || !peers.some(p => s.peers[p]?.on)) return []
      const w = world(s)
      return w.sessions.flatMap(x => {
        const code = w.handles[x.key]
        const reaches = code ? peers.filter(p => reach(code, p, w)) : []
        const alias = w.aliases?.[x.key]
        return code && reaches.length
          ? [{ code, ...(alias && { alias }), session: { key: x.key, name: x.name }, lane: x.lane, reaches }]
          : []
      })
    },

    syncDirectory() {
      // One at a time: a look that starts while one is under way waits for it.
      const next = syncing.then(syncOnce, syncOnce)
      syncing = next.catch(() => 0)
      return next
    },
  }

  async function syncOnce(): Promise<number> {
    const view = team.view()
    // An empty board proves nothing (its first look has not happened yet): no list shrinks for it.
    if (!view || !items().length) return 0
    const s = readAgents()
    const open = !globalOff(s.off) && Object.entries(s.peers).some(([p, sw]) => isPeerId(p) && sw?.on)
    const sent = new Set(team.directorySent())
    if (!open && !sent.size) return 0
    const w = world(s, true)
    let n = 0
    for (const p of view.roster) {
      const list = directoryFor(p.peer, w)
      if (!list.length && !sent.has(p.peer)) continue
      if (await team.offerDirectory(p.peer, list)) n++
    }
    return n
  }

  /**
   * One notice per session and thread at a time: a pending one counts the new message instead,
   * and the next waits out the gap after the last. `text` is given the count. An addressed notice
   * (`named`, #875) keeps its words while it waits: a plain message after it only adds to its count,
   * so the message to answer is not lost.
   */
  function notify(
    target: SessionRef,
    thread: string,
    text: string | ((count: number) => string),
    t: number,
    named = false,
  ): void {
    target = resolveRef(target)
    const mark = `${target.key}\n${thread}`
    if (named && typeof text === 'function') namedNotice.set(mark, text)
    if (isOwnerServiceKey(target.key)) return
    try {
      const bareKey = parseNodeKey(target.key)?.key
      const sameSession = (key: string): boolean =>
        key === target.key || (!!bareKey && !bareKey.startsWith('pane-') && key === bareKey)
      const mine = schedule.list().filter(e => sameSession(e.key) && typeof e.teamThread === 'string' && !e.claim)
      const pending =
        mine.find(e => e.teamThread === thread && e.key === target.key) ?? mine.find(e => e.teamThread === thread)
      const said = named ? undefined : namedNotice.get(mark)
      const words = (n: number): string => (said ? said(n) : typeof text === 'string' ? text : text(n))
      if (pending) {
        const n = (typeof pending.teamCount === 'number' ? pending.teamCount : 1) + 1
        if (schedule.update(pending.id, words(n), n)) return
      }
      // A new notice: a plain one says only what it says.
      if (!named) namedNotice.delete(mark)
      const plain = (n: number): string => (typeof text === 'string' ? text : text(n))
      // A session's own reminders keep their room: past this many waiting notices, a new thread
      // waits in the Team panel only.
      if (mine.length >= MAX_PENDING_NOTICES) {
        audit('notice_dropped', null, { thread, session: target.key })
        return
      }
      const gap = limits().noticeGapMin * 60_000
      const next = Math.max(t, (lastNotice.get(mark) ?? 0) + gap)
      lastNotice.set(mark, next)
      schedule.add({
        key: target.key,
        ...(target.name && { name: target.name }),
        text: plain(1),
        next,
        teamThread: thread,
        teamCount: 1,
      })
      audit('notice', null, { thread, session: target.key })
    } catch (err) {
      log(`team: no notice for ${target.name ?? target.key}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/**
 * The board's schedule as the router uses it: a notice is a one-off reminder "from team", which the
 * scheduler types in as "[board reminder from team] ..." (waking a sleeping session, waiting out a
 * dialog or the owner's unsent text). A notice already on its way is not changed.
 */
export const noticeSchedule: NoticeSchedule = {
  list: () => listEntries(),
  add: e =>
    void addEntry({
      key: e.key,
      ...(e.name && { name: e.name }),
      text: e.text,
      at: e.next,
      next: e.next,
      by: 'team',
      from: { key: TEAM, name: TEAM },
      teamThread: e.teamThread,
      teamCount: e.teamCount,
    }),
  update: (id, text, count) =>
    !!updateEntry(id, entry => (entry.claim ? undefined : { ...entry, text, teamCount: count })),
}
