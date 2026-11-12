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
import { configDir, stateDir, uploadsDir } from '../adapters/paths.ts'
import { addEntry, listEntries, updateEntry } from '../adapters/schedule-store.ts'
import {
  audit,
  changeAgents,
  type OutboxItem,
  readAgents,
  readAllInbox,
  readAllOutbox,
  readThreads,
  type SessionRef,
} from '../adapters/team-store.ts'
import { categoryInfo } from '../core/categories.ts'
import { DEFAULT_MAX_FILE_BYTES, GENERAL, isPeerId, MAX_TEXT, type WorkPost } from '../core/team.ts'
import {
  type AgentLimits,
  agentLimits,
  fileScanText,
  laneHit,
  loopFor,
  loopRun,
  noticeText,
  pausedText,
  safeName,
  secretHit,
  sharesLane,
  splitKey,
  TEAM,
  threadKey,
  threadRef,
} from '../core/team-agents.ts'
import type { Config } from '../core/types.ts'
import type { InboundEvent, PostResult, PostTarget, TeamService } from './team-hub.ts'

/** A session as the router needs it: its card key, name and lane. */
export interface RouterItem {
  key: string
  name?: string
  /** The name the board gave the card when it has none of its own. */
  autoName?: string
  category: string
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

  const laneOf = (key: string): string | null => items().find(i => i.key === key)?.category ?? null

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
    async agentPost({ to, thread, text, session, claimed, replyTo, file, work }) {
      const view = team.view()
      if (!view) return { ok: false, error: 'off' }
      if (to !== TEAM && !isPeerId(to)) return { ok: false, error: 'peer' }
      const s = readAgents()
      // A new thread (a title, no id) has no key yet: nothing to loop in, nothing to echo.
      const key = thread?.title !== undefined && thread.id === undefined ? null : threadKey(to, thread?.id ?? GENERAL)
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
      const peer = s.peers[switchesKey(to, key)]
      const name = file && basename(file.path)
      const refused = overLimit(to, key, text, session, name ? { name, size: sizeOf(file.path) } : undefined)
      if (refused) return { ok: false, error: refused }
      const listener = s.listener?.key === session.key
      // A peer with every lane (#386) shares any lane a session is in, and no lane is left to name.
      const has = (lane: string): boolean => sharesLane(peer, lane)
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
      else if (!listener && !has(laneOf(session.key) ?? '')) reason = 'lane'
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
          .filter(c => !has(c.id))
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

    inbound(e) {
      if (e.held) return
      const s = readAgents()
      if (globalOff(s.off)) return
      const parts = splitKey(e.thread)
      if (!parts) return
      const isTeam = parts.scope === TEAM
      // A channel has switches of its own (#355); the team chat's mute is not a channel's.
      const rules = isTeam ? switchesKey(TEAM, e.thread) : e.from
      if (!s.peers[rules]?.on) return
      if (rules === TEAM && s.peers[TEAM]?.muted) return
      const rec = readThreads()[e.thread]
      if (rec?.muted) return
      const t = now()
      if ((s.paused[e.from] ?? 0) > t) return
      const who = safeName(team.nameOf(e.from), e.from)
      // Every message counts, marked or not: the mark is the sender's own word.
      const recent = (readAllInbox()[e.from] ?? []).filter(i => i.receivedAt >= t - HOUR)
      if (recent.length > limits().inboundHour) {
        changeAgents(x => {
          x.paused[e.from] = t + HOUR
        })
        audit('routing_paused', e.from, { minutes: 60 })
        log(`team: routing paused for an hour, too many messages from ${who}`)
        if (s.listener) notify(s.listener, `paused:${e.from}`, pausedText(who, 60), t)
        return
      }
      // A handler that left the board gives the thread back to the listener. An empty board (the
      // first look has not happened yet) proves nothing.
      let handler = rec?.handler ?? null
      const known = items()
      if (handler && known.length && !known.some(i => i.key === handler?.key)) {
        team.setThread(e.thread, { handler: null })
        audit('released', isTeam ? null : e.from, { thread: e.thread, why: 'gone' })
        handler = null
      }
      const target = handler ?? s.listener
      if (!target) return
      const ref = threadRef(parts.scope, parts.id)
      const base = { who, agent: e.via === 'agent', ref, team: isTeam, route: !handler }
      notify(target, e.thread, (count: number) => noticeText({ ...base, count }), t)
    },

    assign(key, session) {
      const parts = splitKey(key)
      if (!parts || !team.threads().some(t => t.key === key)) return { ok: false, error: 'thread' }
      if (session) {
        const s = readAgents()
        const peer = s.peers[switchesKey(parts.scope, key)]
        if (s.listener?.key !== session.key && !sharesLane(peer, laneOf(session.key) ?? ''))
          return { ok: false, error: 'lane' }
      }
      team.setThread(key, { handler: session })
      audit(session ? 'assigned' : 'released', parts.scope === TEAM ? null : parts.scope, {
        thread: key,
        ...(session && { session: session.key }),
      })
      return { ok: true }
    },

    listen(session, caller) {
      const r = changeAgents((x): { ok: true } | { ok: false; error: string } => {
        const now = x.listener
        if (session && now && now.key !== session.key) return { ok: false, error: 'taken' }
        if (!session && now && caller && now.key !== caller.key) return { ok: false, error: 'not_listener' }
        x.listener = session
        return { ok: true }
      })
      if (r.ok) audit('listener', null, session ? { session: session.key } : {})
      return r
    },

    sessionName(key) {
      const item = items().find(i => i.key === key)
      return item?.name || item?.autoName || null
    },
  }

  /**
   * One notice per session and thread at a time: a pending one counts the new message instead,
   * and the next waits out the gap after the last. `text` is given the count.
   */
  function notify(target: SessionRef, thread: string, text: string | ((count: number) => string), t: number): void {
    const words = (n: number): string => (typeof text === 'string' ? text : text(n))
    try {
      const mine = schedule.list().filter(e => e.key === target.key && typeof e.teamThread === 'string' && !e.claim)
      const pending = mine.find(e => e.teamThread === thread)
      if (pending) {
        const n = (typeof pending.teamCount === 'number' ? pending.teamCount : 1) + 1
        if (schedule.update(pending.id, words(n), n)) return
      }
      // A session's own reminders keep their room: past this many waiting notices, a new thread
      // waits in the Team panel only.
      if (mine.length >= MAX_PENDING_NOTICES) {
        audit('notice_dropped', null, { thread, session: target.key })
        return
      }
      const gap = limits().noticeGapMin * 60_000
      const mark = `${target.key}\n${thread}`
      const next = Math.max(t, (lastNotice.get(mark) ?? 0) + gap)
      lastNotice.set(mark, next)
      schedule.add({
        key: target.key,
        ...(target.name && { name: target.name }),
        text: words(1),
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
