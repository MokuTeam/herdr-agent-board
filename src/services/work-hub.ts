// Shared threads on the running board (#394, docs/design/threads 11): the side that holds the Team
// service. It sends an entry of a shared thread as a post in the thread's topic: a session's through
// the router's agentPost unchanged (held as a draft for the owner when agents are off for that peer,
// the lane is not shared, the text or a text-like file looks like a secret, the text names an
// unshared lane, the loop pause is reached; refused past the rate limits), the owner's as the owner's, behind
// the passkey when that gate is on. It takes a peer's message in a topic in as an entry
// (work-share.ts ingest), sends what was written while the board was down, follows the drafts it
// left to their end, and reads in a history file once its bytes are here.
//
// Off (threads off, `share: false`, or Team off) it does nothing: `on()` is false, the hello does not
// say `work`, and no hook of it runs any code but that check.
import { readFileSync } from 'node:fs'
import type { BoardDb } from '../adapters/db.ts'
import { readAgents, readAllInbox, readAllOutbox, readDrafts } from '../adapters/team-store.ts'
import {
  entriesWithOut,
  entryById,
  getThread,
  setOut,
  sharedThreads,
  ThreadError,
} from '../adapters/work-thread-store.ts'
import { categoryInfo } from '../core/categories.ts'
import { channelMembers, isPeerId, type ThreadRef, teamConfig } from '../core/team.ts'
import { sharesLane, TEAM, threadKey } from '../core/team-agents.ts'
import type { Config } from '../core/types.ts'
import { scopeWho } from '../core/work-share.ts'
import {
  type EntryOut,
  OWNER,
  type Party,
  requestOf,
  sharedOf,
  sharingOf,
  type ThreadEntry,
  type ThreadHead,
  type ThreadsConfig,
  threadsConfig,
} from '../core/work-threads.ts'
import type { InboundEvent, TeamService } from './team-hub.ts'
import type { TeamRouter } from './team-router.ts'
import {
  historyText,
  importHistory,
  ingest,
  mayTake,
  myPeer,
  outgoing,
  type ShareTarget,
  shareThread,
  targetOf,
  trackTopic,
} from './work-share.ts'
import { type EventSchedule, filePath, type ThreadsCtx, type Written, withThreadsDb } from './work-threads.ts'

/** How a send of an entry ended (what `board thread post` prints after `ok`). */
export type SendOut =
  | { state: 'sent' }
  | { state: 'held'; reason: string; detail?: string }
  | { state: 'confirm' }
  | { state: 'queued'; why: string }
  | { state: 'refused'; error: string }
  | { state: 'local' }

export interface WorkHub {
  /** Threads, their sharing and Team are all on: the hello says `work`. */
  on(): boolean
  /** The hub client's check on a message that carries `work` (11.4). */
  mayTake(m: { from: string; topic: string; ref: ThreadRef }): boolean
  /** A message the hub client kept: an entry of a shared thread, when it is one (true then). */
  inbound(e: InboundEvent): boolean
  /**
   * Sends an entry of a shared thread. `unlocked`: the owner's own entry may go now (the passkey
   * is off, or this page confirmed it); else it waits for the owner (`confirm`).
   */
  send(entry: string, unlocked: boolean): Promise<SendOut>
  /** The owner shares a thread (already confirmed): its head goes to the topic; `history` the earlier entries as a file. */
  share(thread: string, to: string, history: boolean): Promise<{ written: Written; sent: SendOut; history?: SendOut }>
  /** The owner tracks a Team topic as a thread (13.3), in `lane`. */
  track(topic: string, lane: string): Promise<{ written: Written; sent: SendOut }>
  /** "Send history" (4.3): the thread's shared entries as a file through the hub's end-to-end encrypted files. */
  history(thread: string): Promise<SendOut>
  /** Sends what waits, follows the drafts to their end, reads in history files that came. */
  flush(): Promise<void>
  /** The shared threads by their topic's key: the Team list's pill (13.3). */
  topics(): Record<string, { key: string; status: string; id: string }>
  /** Moves when an entry's way to the hub changed: the page reads the thread again. */
  rev(): number
}

interface Options {
  cfg: Pick<Config, 'threads' | 'team' | 'categories'>
  team: TeamService
  router: TeamRouter
  /** Whether the owner's sends wait for the passkey (#224, #367). */
  gated: () => boolean
  log: (line: string) => void
  /** Something a page shows changed. */
  changed: () => void
  schedule?: EventSchedule
  now?: () => number
}

const RATE = /^rate_|^echo$/
/** How long a history file is waited for before its entry stops waiting. */
const HISTORY_WAIT_MS = 2 * 86_400_000

export function createWorkHub({ cfg, team, router, gated, log, changed, schedule, now = Date.now }: Options): WorkHub {
  let outRev = 0
  let flushing = false
  const tcfg = (): ThreadsConfig | null => threadsConfig(cfg.threads)
  const on = (): boolean => !!tcfg()?.share && teamConfig(cfg.team) !== null
  const me = (): string => team.view()?.me.peer ?? myPeer()

  const ctxOf = (db: BoardDb, actor: Party = OWNER): ThreadsCtx & { me: string; nameOf: (p: string) => string } => {
    const c = tcfg()
    if (!c) throw new ThreadError('off', 'threads are off')
    return {
      db,
      cfg: c,
      actor,
      now: now(),
      me: me(),
      nameOf: p => team.nameOf(p),
      ...(schedule && { schedule }),
    }
  }

  const mark = (db: BoardDb, id: string, out: EntryOut | null): void => {
    if (setOut(db, id, out)) {
      outRev++
      changed()
    }
  }

  /** The Team topic of a shared thread on this board. */
  const topicOf = (h: ThreadHead): string | null => sharingOf(h)?.topic ?? null

  /** Sends one entry; its `out` follows. */
  async function sendOne(db: BoardDb, head: ThreadHead, entry: ThreadEntry, unlocked: boolean): Promise<SendOut> {
    const out = outgoing(db, head, entry, me(), ref => filePath(ref))
    if (!out) return { state: 'local' }
    if (!team.view()) return { state: 'queued', why: 'team is off' }
    const work = {
      id: entry.id,
      body: out.work,
      ...(out.work.share && { open: true as const }),
    }
    const thread = out.work.share ? out.target.thread : { id: out.target.thread.id }
    if (entry.author.kind === 'session') {
      const r = await router.agentPost({
        to: out.target.to,
        thread,
        text: out.text,
        session: { key: entry.author.key, name: entry.author.name },
        ...(out.file && { file: { path: out.file.path } }),
        work,
      })
      if (!r.ok) {
        // Past a rate limit it is refused, as the session's post would be (11.3).
        mark(db, entry.id, 'refused')
        return { state: 'refused', error: r.error }
      }
      if (!r.sent) {
        mark(db, entry.id, 'held')
        return { state: 'held', reason: r.reason, ...(r.detail && { detail: r.detail }) }
      }
      mark(db, entry.id, 'sent')
      return { state: 'sent' }
    }
    if (entry.author.kind !== 'owner') return { state: 'local' }
    if (gated() && !unlocked) {
      mark(db, entry.id, 'held')
      return { state: 'confirm' }
    }
    const r = await team.post({ to: out.target.to, thread }, out.text, { by: 'ui' }, out.file, work)
    if (!r.ok) {
      log(`threads: ${head.key} #${entry.n} was not sent: ${r.error}`)
      mark(db, entry.id, 'refused')
      return { state: 'refused', error: r.error }
    }
    mark(db, entry.id, 'sent')
    return { state: 'sent' }
  }

  /** Where the owner shares to: a teammate by name or id, `team`, or a channel by its title or key. */
  function targetFor(word: string, id: string): ShareTarget & { lanesOf: string[] } {
    const view = team.view()
    if (!view) throw new ThreadError('team_off', 'Team is off on this board')
    const w = word.trim()
    const roster = view.roster
    const peer = roster.find(p => p.peer === w || p.name === w || p.name.toLowerCase() === w.toLowerCase())
    if (peer && isPeerId(peer.peer))
      return { kind: 'peer', peer: peer.peer, topic: threadKey(peer.peer, id), lanesOf: [peer.peer] }
    if (w.toLowerCase() === TEAM) return { kind: 'team', topic: threadKey(TEAM, id), lanesOf: roster.map(p => p.peer) }
    const channel = team
      .threads()
      .find(t => t.members && t.by === 'me' && (t.key === w || t.title?.toLowerCase() === w.toLowerCase()))
    if (channel?.members) {
      const members = channelMembers(channel.members)
      if (!members) throw new ThreadError('channel', `${w}: not a channel this board started`)
      return {
        kind: 'channel',
        members,
        topic: threadKey(TEAM, id),
        lanesOf: members.filter(m => m !== view.me.peer),
      }
    }
    throw new ThreadError('to', `"${w}" is no teammate, no channel this board started, and not "team"`)
  }

  /** Whether a lane of this board's is shared with a peer (a peer's thread may sit in it, #394). */
  const laneShared = (lane: string, peer: string): boolean =>
    cfg.categories.some(c => c.id === lane) && sharesLane(readAgents().peers[peer], lane)

  /** The lane rule (11.2): the thread's lane is shared with every one it goes to. */
  function laneFits(lane: string, peers: string[]): void {
    const s = readAgents()
    const out = peers.filter(p => !sharesLane(s.peers[p], lane))
    if (out.length) {
      const title = categoryInfo(cfg, lane).title
      throw new ThreadError(
        'lane',
        `the lane ${title} is not shared with ${out.map(p => team.nameOf(p)).join(', ')}: share it in the Team panel first`,
      )
    }
  }

  async function sendHistory(db: BoardDb, head: ThreadHead): Promise<SendOut> {
    const s = sharedOf(head)
    if (!s) return { state: 'refused', error: 'not_shared' }
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'board-history-'))
    const path = join(dir, `${s.key}-history.json`)
    writeFileSync(path, historyText(db, head, me()))
    const ctx = ctxOf(db)
    const { postEntry } = await import('./work-threads.ts')
    const w = postEntry(ctx, head, { type: 'system', text: 'sent the history of this thread' })
    const { rmSync } = await import('node:fs')
    let r: Awaited<ReturnType<TeamService['post']>>
    try {
      const out = outgoing(db, w.head, w.entry, me(), () => path)
      const target = targetOf(w.head)
      if (!out || !target) return { state: 'local' }
      r = await team.post(
        { to: target.to, thread: { id: head.id } },
        out.text,
        { by: 'ui' },
        { path, name: `${s.key}-history.json` },
        { id: w.entry.id, body: { ...out.work, hist: true } },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    mark(db, w.entry.id, r.ok ? 'sent' : 'refused')
    return r.ok ? { state: 'sent' } : { state: 'refused', error: r.error }
  }

  /** The drafts this board left for its entries, and the posts it made: what became of a held entry. */
  function settleHeld(db: BoardDb, held: ThreadEntry[]): void {
    if (!held.length) return
    const drafts = new Set(readDrafts().flatMap(d => (d.work ? [d.work.id] : [])))
    const posted = new Set<string>()
    for (const list of Object.values(readAllOutbox())) for (const o of list) posted.add(o.post ?? o.msg.id)
    for (const e of held) {
      if (drafts.has(e.id)) continue
      if (posted.has(e.id)) mark(db, e.id, 'sent')
      // The owner's own entry waits for the owner's press; an agent's draft that is gone was discarded.
      else if (e.author.kind === 'session') mark(db, e.id, 'discarded')
    }
  }

  /** History files that came: read in once their bytes are here. */
  function readHistories(db: BoardDb, waiting: ThreadEntry[]): void {
    if (!waiting.length) return
    const inbox = readAllInbox()
    for (const e of waiting) {
      if (e.author.kind !== 'peer') continue
      const from = e.author.peer
      const item = (inbox[from] ?? []).find(i => (i.post ?? i.id) === e.id)
      const f = item?.file
      // Nothing to wait for (no file with it, or the message is gone), or a file that never came.
      if (!f || (f.state === 'pending' && now() - e.at > HISTORY_WAIT_MS)) {
        mark(db, e.id, null)
        continue
      }
      if (f.state === 'pending') continue
      const head = getThread(db, e.thread)
      if (!head || f.state === 'failed' || !f.path) {
        mark(db, e.id, null)
        continue
      }
      try {
        const n = importHistory(ctxOf(db), head, readFileSync(f.path, 'utf8'), from)
        log(`threads: ${head.key}: ${n} entries from ${team.nameOf(from)}'s history`)
      } catch (err) {
        log(`threads: a history file was not read: ${err instanceof Error ? err.message : String(err)}`)
      }
      mark(db, e.id, null)
    }
  }

  return {
    on,
    mayTake(m) {
      if (!on()) return false
      try {
        return withThreadsDb(false, db => mayTake(db, m))
      } catch (err) {
        log(`threads: a shared entry was not checked: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    },

    inbound(e) {
      if (!on() || !e.work || e.held) return false
      const part = e.work
      try {
        const r = withThreadsDb(!!part.body, db => {
          if (!db) return { taken: false as const }
          return ingest(
            { ...ctxOf(db), laneOk: (lane, peer) => laneShared(lane, peer) },
            {
              id: part.id,
              from: e.from,
              text: part.text,
              at: Date.parse(part.ts),
              ref: part.ref,
              topic: e.thread,
              ...(part.agent && { agent: part.agent }),
              ...(part.replyTo && { replyTo: part.replyTo }),
              ...(part.body && { work: part.body }),
            },
          )
        })
        if (r.taken) {
          if (r.refused.length)
            log(`threads: ${r.head.key}: ${team.nameOf(e.from)} may not set ${r.refused.join(', ')}`)
          changed()
        }
        return r.taken
      } catch (err) {
        log(
          `threads: an entry from ${team.nameOf(e.from)} was not kept: ${err instanceof Error ? err.message : String(err)}`,
        )
        return false
      }
    },

    async send(entryId, unlocked) {
      if (!on()) return { state: 'queued', why: 'sharing is off' }
      return withThreadsDb(false, async db => {
        if (!db) return { state: 'local' } as SendOut
        const entry = entryById(db, entryId)
        if (!entry) throw new ThreadError('not_found', 'no such entry')
        const head = getThread(db, entry.thread)
        if (!head) throw new ThreadError('not_found', 'no such thread')
        if (entry.out === 'sent') return { state: 'sent' } as SendOut
        if (entry.out !== 'queued' && entry.out !== 'held') return { state: 'local' } as SendOut
        // An agent's entry held as a draft goes when the owner sends the draft (the Team panel).
        if (entry.out === 'held' && entry.author.kind === 'session') {
          const draft = readDrafts().find(d => d.work?.id === entry.id)
          if (!draft) return { state: 'refused', error: 'draft' } as SendOut
          if (gated() && !unlocked) return { state: 'confirm' } as SendOut
          const r = await team.sendDraft(draft.id)
          if (r.ok) mark(db, entry.id, 'sent')
          return r.ok ? ({ state: 'sent' } as SendOut) : ({ state: 'refused', error: r.error } as SendOut)
        }
        return sendOne(db, head, entry, unlocked)
      })
    },

    async share(word, to, history) {
      if (!on()) throw new ThreadError('share_off', 'sharing threads needs threads, their share and Team on')
      return withThreadsDb(true, async db => {
        if (!db) throw new ThreadError('no_db', 'no database')
        const { findThread } = await import('../adapters/work-thread-store.ts')
        const head = findThread(db, word, null, true)
        const target = targetFor(to, head.id)
        laneFits(head.lane, target.lanesOf)
        if (history && !team.view()?.files)
          throw new ThreadError('files_hub', 'the hub takes no files: share without history')
        const { lanesOf: _l, ...t } = target
        const written = shareThread(ctxOf(db), head, t)
        const sent = await sendOne(db, written.head, written.entry, true)
        const hist = history && sent.state === 'sent' ? await sendHistory(db, written.head) : undefined
        return { written, sent, ...(hist && { history: hist }) }
      })
    },

    async track(topic, lane) {
      if (!on()) throw new ThreadError('share_off', 'tracking a topic needs threads, their share and Team on')
      const t = team.threads().find(x => x.key === topic)
      if (!t || t.id === 'general' || !t.title) throw new ThreadError('topic', 'no such topic on this board')
      const target: ShareTarget & { lanesOf: string[] } = t.members
        ? { kind: 'channel', members: t.members, topic, lanesOf: t.members.filter(m => m !== me()) }
        : t.scope === TEAM
          ? { kind: 'team', topic, lanesOf: (team.view()?.roster ?? []).map(p => p.peer) }
          : { kind: 'peer', peer: t.scope, topic, lanesOf: [t.scope] }
      return withThreadsDb(true, async db => {
        if (!db) throw new ThreadError('no_db', 'no database')
        laneFits(lane.toLowerCase(), target.lanesOf)
        const { lanesOf: _l, ...rest } = target
        const written = trackTopic(ctxOf(db), { id: t.id, title: t.title ?? 'a topic', lane, target: rest })
        const sent = await sendOne(db, written.head, written.entry, true)
        return { written, sent }
      })
    },

    async history(word) {
      if (!on()) return { state: 'queued', why: 'sharing is off' }
      return withThreadsDb(false, async db => {
        if (!db) return { state: 'local' } as SendOut
        const { findThread } = await import('../adapters/work-thread-store.ts')
        const head = findThread(db, word, null, true)
        if (!team.view()?.files) throw new ThreadError('files_hub', 'the hub takes no files')
        return sendHistory(db, head)
      })
    },

    async flush() {
      if (!on() || flushing || team.view()?.state !== 'online') return
      flushing = true
      try {
        await withThreadsDb(false, async db => {
          if (!db) return
          const waiting = entriesWithOut(db, ['queued', 'held', 'import'])
          settleHeld(
            db,
            waiting.filter(e => e.out === 'held'),
          )
          readHistories(
            db,
            waiting.filter(e => e.out === 'import'),
          )
          for (const e of waiting.filter(x => x.out === 'queued')) {
            const head = getThread(db, e.thread)
            if (!head) continue
            // Gone out already (the board stopped between the post and the mark).
            const posted = Object.values(readAllOutbox()).some(list => list.some(o => (o.post ?? o.msg.id) === e.id))
            if (posted) {
              mark(db, e.id, 'sent')
              continue
            }
            // The owner's entries written while the board was down wait for the owner's press when the passkey is on.
            const r = await sendOne(db, head, e, false)
            if (r.state === 'refused' && RATE.test(r.error)) log(`threads: ${head.key} #${e.n}: ${r.error}`)
          }
        })
      } catch (err) {
        log(`threads: sending what waits failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        flushing = false
      }
    },

    topics() {
      if (!on()) return {}
      try {
        return withThreadsDb(false, db => {
          const out: Record<string, { key: string; status: string; id: string }> = {}
          if (!db) return out
          for (const h of sharedThreads(db)) {
            const topic = topicOf(h)
            if (topic) out[topic] = { key: h.key, status: h.status, id: h.id }
          }
          return out
        })
      } catch {
        return {}
      }
    },

    rev: () => outRev,
  }
}

/** A request to share, in words for the owner's confirmation (the board's names, never the agent's alone). */
export function requestWords(h: ThreadHead, nameOf: (p: string) => string, me: string): string | null {
  const r = requestOf(h)
  if (r) return `${r.to}${r.history ? ' (with history)' : ''}`
  const s = sharedOf(h)
  return s ? scopeWho(s, nameOf, me) : null
}
