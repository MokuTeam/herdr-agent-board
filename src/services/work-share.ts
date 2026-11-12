// Shared threads over the hub (#394, docs/design/threads 11, core/work-share.ts): what changes in
// the board's database when a thread is shared, unshared, offered and taken, when a peer's entry
// comes in, and what an entry of this board sends. Sending itself is the board's (services/
// work-hub.ts), which holds the Team service; everything here works on the database alone, so the
// `board thread` command and the tests use it as they are.
//
// The party of a write comes from the path it came in on (3.2): a peer's entry is the peer's, with
// the session name its board signed only when an agent wrote it. A peer's words are data: they are
// stored and shown framed as quoted, and no event carries them (core/work-threads.ts digestLine).
import { type BoardDb, openDb } from '../adapters/db.ts'
import { readKey } from '../adapters/team-store.ts'
import {
  appendEntry,
  createShared,
  createThread,
  entriesOf,
  entryById,
  getThread,
  keyTaken,
  MAX_PEER_ENTRIES,
  peerEntries,
  refoldShared,
  setScope,
  ThreadError,
} from '../adapters/work-thread-store.ts'
import { GENERAL, isPeerId, MAX_TEXT, readWork, type ThreadRef, validName, type WorkBody } from '../core/team.ts'
import {
  adoptedSet,
  fallbackLine,
  foldShared,
  HISTORY_MAX,
  type HistoryFile,
  historyOf,
  isAdoption,
  localKey,
  missingText,
  type NameOf,
  peerSet,
  sharedOrder,
  wireHead,
  wireKey,
  wireSet,
  wireTitle,
} from '../core/work-share.ts'
import {
  cleanText,
  type EntrySet,
  LANE,
  OWNER,
  type Party,
  requestOf,
  type SharedScope,
  sameParty,
  sharedOf,
  sharingOf,
  type ThreadEntry,
  type ThreadHead,
  type ThreadScope,
  TITLE_MAX,
} from '../core/work-threads.ts'
import { postEntry, type ThreadsCtx, tellWatchers, type Written } from './work-threads.ts'

/** This board's peer id: what its own entries order by on a shared thread; '' before it has a key. */
export const myPeer = (): string => readKey()?.pub ?? ''

const byOf = (p: Party): string => JSON.stringify(p)

// ------------------------------------------------------------------ in (11.4)

/** A message in a Team topic, as the hub client kept it, for the thread with the topic's id. */
export interface InboundWork {
  /** The entry's id: the post's (a team post's first copy's), else the message's. */
  id: string
  from: string
  /** The session name the sender's board signed, when an agent wrote it. */
  agent?: string
  text: string
  /** The sender's time (it orders entries, 4.3). */
  at: number
  ref: ThreadRef
  /** The topic's key on this board's Team. */
  topic: string
  replyTo?: string
  work?: WorkBody
}

export type Ingested =
  | { taken: true; head: ThreadHead; entry: ThreadEntry; refused: string[] }
  | { taken: false; why: 'not_shared' | 'scope' | 'dup' | 'unshared' | 'full' | 'counter' }

/** The scope a topic gives a thread made from it: the sender in a pair, the team, a channel's members. */
function scopeFrom(m: Pick<InboundWork, 'ref' | 'from' | 'topic'>, key: string, at: number): SharedScope {
  const base = { topic: m.topic, key, by: m.from, at }
  if (m.ref.members) return { kind: 'channel', members: [...m.ref.members], ...base }
  if (m.ref.group) return { kind: 'team', ...base }
  return { kind: 'peer', peer: m.from, ...base }
}

/** Whether `from` writes in `s` as the topic `m.topic`: the pair's peer, any member of the team, a channel's members. */
export function fromScope(s: SharedScope, m: Pick<InboundWork, 'from' | 'topic' | 'ref'>): boolean {
  if (s.topic !== m.topic) return false
  if (s.kind === 'peer') return s.peer === m.from && !m.ref.group
  if (s.kind === 'team') return m.ref.group === true && !m.ref.members
  return m.ref.group === true && !!s.members?.includes(m.from) && !!m.ref.members?.includes(m.from)
}

/**
 * Whether a message that carries `work` may be kept at all (11.4): on a thread this board knows as
 * shared with that scope, from one of its members; or on a thread it does not know yet (a share, or
 * a member who joined late). Anything else is dropped as a bad frame.
 */
export function mayTake(db: BoardDb | null, m: Pick<InboundWork, 'from' | 'topic' | 'ref'>): boolean {
  if (m.ref.id === GENERAL) return false
  const head = db ? getThread(db, m.ref.id) : null
  if (!head) return !db || !fullFrom(db, m.from)
  const s = sharingOf(head)
  return !!s && fromScope(s, m) && !(db && fullThread(db, head.id))
}

/** Threads one peer may have started on this board at most, whatever their status: a peer cannot fill it with new ones. */
export const MAX_SHARED_BY_PEER = 500

/** How far past this board's counter one entry of a peer may jump (rule 3 still takes a gap that large). */
export const MAX_N_JUMP = 100_000

/** Whether `peer` started as many threads here as it may. */
function fullFrom(db: Pick<BoardDb, 'db'>, peer: string): boolean {
  const r = db.db
    .query(
      "SELECT count(*) AS n FROM threads WHERE json_extract(created_by, '$.kind') = 'peer' AND json_extract(created_by, '$.peer') = ?",
    )
    .get(peer) as { n: number }
  return r.n >= MAX_SHARED_BY_PEER
}

/** Whether a thread holds as many of its peers' entries as it may. */
const fullThread = (db: Pick<BoardDb, 'db'>, thread: string): boolean => peerEntries(db, thread) >= MAX_PEER_ENTRIES

/** The lane a peer's key names: what comes before its number. */
const laneOfKey = (key: string): string => key.replace(/-\d{1,9}$/, '')

/**
 * A peer's message in a topic, as an entry of the thread with the topic's id (11.4, 4.3). A plain
 * reply (a board without `work`) is a note at the end of the feed; one with `work` lands where its
 * counter puts it, and the head is folded again in the shared order. A board whose counter is more
 * than one behind writes the line "entries missing here" and takes the sender's head. A thread this
 * board does not know is made from the first `work` that comes in it; a plain reply in a topic that
 * is no thread is not one.
 */
export function ingest(
  ctx: ThreadsCtx & {
    me: string
    nameOf: NameOf
    /** Whether a peer's thread may sit in the lane its key names (a lane of this board shared with the peer); else `shared`. */
    laneOk?: (lane: string, peer: string) => boolean
  },
  m: InboundWork,
): Ingested {
  const w = m.work
  const author: Party = { kind: 'peer', peer: m.from, name: ctx.nameOf(m.from), ...(m.agent && { agent: m.agent }) }
  let head = getThread(ctx.db, m.ref.id)
  if (!head && !w) return { taken: false, why: 'not_shared' }
  if (!head && w?.unshare) return { taken: false, why: 'not_shared' }
  if (!head && fullFrom(ctx.db, m.from)) return { taken: false, why: 'full' }
  if (head) {
    const s = sharingOf(head)
    if (!s || s.ended !== undefined) return { taken: false, why: s ? 'unshared' : 'not_shared' }
    if (!fromScope(s, m)) return { taken: false, why: 'scope' }
    if (fullThread(ctx.db, head.id)) return { taken: false, why: 'full' }
    // One entry moves the counter by so much at most: no peer uses up a thread's numbers.
    if (w && w.n > head.rev + MAX_N_JUMP) return { taken: false, why: 'counter' }
  } else if (w && w.n > MAX_N_JUMP) return { taken: false, why: 'counter' }
  if (entryById(ctx.db, m.id)) return { taken: false, why: 'dup' }
  // The sender's time orders entries (4.3); one far in the future is held to a day ahead.
  const at = Math.min(Number.isFinite(m.at) ? m.at : ctx.now, ctx.now + DAY)
  const done = ctx.db.write(byOf(author), tx => {
    let fresh = false
    if (!head) {
      const work = w as WorkBody
      const key = localKey(work.head.key, k => keyTaken(ctx.db, k), author.name, m.from)
      // The lane its key names only when it is one this board shares with the peer: no peer puts a
      // thread in a lane of its choosing, nor wakes the watchers of one.
      const lane = laneOfKey(work.head.key)
      head = createShared(tx, {
        id: m.ref.id,
        key,
        lane: LANE.test(lane) && ctx.laneOk?.(lane, m.from) ? lane : SHARED_LANE,
        title: work.head.title,
        author,
        at,
        scope: scopeFrom(m, work.head.key, at),
      })
      fresh = true
    }
    const before = head as ThreadHead
    const s = sharingOf(before) as SharedScope
    let refused: string[] = []
    let offer = false
    let entry: ThreadEntry
    let after: ThreadHead
    if (!w) {
      // A plain reply from a board without `work`: a note, next in this board's feed.
      const r = appendEntry(tx, before.id, { id: m.id, at, author, type: 'note', text: plainText(m.text) }, ctx.me)
      entry = r.entry
      after = r.head
    } else {
      const ps = peerSet(w.set, m.from, ctx.me, ctx.nameOf)
      refused = ps.refused
      offer = ps.offer
      // A peer's system entry carries no words of its own: on this board only the board says things.
      const text = w.auto || w.type === 'system' ? '' : plainText(m.text)
      const r = appendEntry(
        tx,
        before.id,
        {
          id: m.id,
          n: w.n,
          at,
          author,
          type: w.type,
          text,
          set: ps.set,
          ...(m.replyTo && { replyTo: m.replyTo }),
          ...(w.hist && { out: 'import' as const }),
        },
        ctx.me,
      )
      entry = r.entry
      after = r.head
      // Rule 3: entries this board never got. Not for the share itself, whose earlier entries stay
      // on its sharer's board (11.2).
      const missedFrom = fresh ? 1 : before.rev + 1
      if (!(fresh && w.share) && w.n > missedFrom) {
        const a = appendEntry(
          tx,
          before.id,
          {
            n: w.n,
            at,
            author,
            type: 'system',
            text: missingText(missedFrom, w.n - 1, author.name),
            set: adoptedSet(w.head, fresh ? null : before),
            private: true,
          },
          ctx.me,
        )
        after = a.head
      }
      if (w.unshare && s.by === m.from) setScope(tx, before.id, { ...s, ended: at })
    }
    // An offer (11.6): this board assigned by a peer waits for Take or Decline; assigned elsewhere, it is gone.
    const now = sharingOf(after) ?? s
    if (offer && after.assignee?.kind === 'owner') setScope(tx, before.id, { ...now, offer: { by: m.from, at } })
    else if (now.offer && after.assignee?.kind !== 'owner') {
      const { offer: _gone, ...rest } = now
      setScope(tx, before.id, rest)
    }
    return { head: getThread(tx, before.id) ?? after, entry, refused }
  })
  tellWatchers({ ...ctx, actor: author }, [done.head])
  return { taken: true, ...done }
}

const DAY = 86_400_000

/** The lane of a peer's thread whose key names no lane this board shares with that peer. */
export const SHARED_LANE = 'shared'

/** A peer's text as an entry keeps it: lines kept, control characters gone, cut at Team's limit. */
const plainText = (t: string): string => cleanText(t, MAX_TEXT)

// ------------------------------------------------------------------ out (11.1)

/** Where a shared thread's message goes: a peer or the team, the topic by the thread's id, a channel's members. */
export interface OutTarget {
  to: string
  thread: { id: string; title: string; members?: string[] }
}

export function targetOf(h: ThreadHead): OutTarget | null {
  const s = sharingOf(h)
  if (!s) return null
  const thread = {
    id: h.id,
    title: wireTitle(h.title, wireKey(h)),
    ...(s.kind === 'channel' && s.members && { members: s.members }),
  }
  if (s.kind === 'peer') return s.peer ? { to: s.peer, thread } : null
  return { to: 'team', thread }
}

/** A shared entry as it goes out: its text (the board's line when it has none) and its `work`. */
export interface Outgoing {
  target: OutTarget
  text: string
  work: WorkBody
  /** The entry's file, on this computer (one per entry on a shared thread). */
  file?: { path: string; name: string }
}

/**
 * What an entry of this board sends (11.1): its counter and type, the fields the peers hold (none
 * that only proposed a close), the head as it was after it, and a text for every peer (its own,
 * or the line the board writes, marked `auto`). Null for a private entry, a peer's, or a thread
 * that is not shared.
 */
export function outgoing(
  db: BoardDb,
  head: ThreadHead,
  entry: ThreadEntry,
  me: string,
  filePathOf: (ref: string) => string,
): Outgoing | null {
  const target = targetOf(head)
  if (!target || entry.private || entry.author.kind === 'peer') return null
  // The head as it was right after the entry: every entry up to it, in the shared order.
  const all = sharedOrder(entriesOf(db, head.id), me)
  const upTo = all.slice(0, all.findIndex(e => e.id === entry.id) + 1)
  const after = foldShared(head, upTo.length ? upTo : [entry], me)
  const before = foldShared(head, upTo.slice(0, -1), me)
  const proposed =
    entry.author.kind === 'session' &&
    entry.set?.status === 'done' &&
    before.status === 'owner' &&
    after.status === 'owner'
  const set = wireSet(entry.set, me, proposed)
  const s = sharingOf(head)
  const flags = {
    ...(entry.type === 'system' && s && entry.at === s.at && s.by === 'me' && isShareEntry(entry) && { share: true }),
    ...(s?.ended !== undefined && entry.at === s.ended && { unshare: true }),
  } as { share?: true; unshare?: true }
  // The share and the unshare say what happened in the board's words: a board without `work` reads
  // them as a topic's lines, one with it shows its own.
  const own = flags.share || flags.unshare ? '' : entry.text
  const text = own || fallbackLine(entry, after, flags)
  const file = entry.files?.[0]
  return {
    target,
    text,
    work: {
      n: entry.n,
      type: entry.type,
      ...(set && { set }),
      head: wireHead(after),
      ...(!own && { auto: true as const }),
      ...flags,
    },
    ...(file && { file: { path: filePathOf(file.ref), name: file.name } }),
  }
}

/** The system entry that shared a thread: it sets every head field the peers hold (shareThread). */
const SHARE_TEXT = 'shared'
const isShareEntry = (e: ThreadEntry): boolean => e.type === 'system' && e.text === SHARE_TEXT

// ------------------------------------------------------------------ sharing (11.2)

/** Where an owner shares a thread: a peer, the team, or a channel (its members and its topic's key). */
export interface ShareTarget {
  kind: 'peer' | 'team' | 'channel'
  peer?: string
  members?: string[]
  /** The Team topic's key on this board: `<peer>/<thread id>`, `team/<thread id>`. */
  topic: string
}

function notShared(h: ThreadHead): void {
  if (sharingOf(h) && !sharingOf(h)?.ended) throw new ThreadError('shared', `${h.key} is shared already`)
}

/**
 * An agent's `board thread share` (11.2): a request on the thread for the owner, who confirms it on
 * the board (with the passkey when that gate is on) or declines it. Nothing goes to the hub.
 */
export function requestShare(ctx: ThreadsCtx, head: ThreadHead, to: string, history: boolean): Written {
  if (!ctx.cfg.share) throw new ThreadError('share_off', 'threads stay on this board: config.json says share: false')
  notShared(head)
  const word = cleanText(to, 80).replace(/\s+/g, ' ')
  if (!word) throw new ThreadError('usage', 'usage: board thread share <key> <name|team|channel> [--history]')
  const scope: ThreadScope = { kind: 'local', request: { to: word, history, by: ctx.actor, at: ctx.now } }
  const w = postEntry(ctx, head, {
    type: 'note',
    text: `asks to share with ${word}${history ? ', with its history' : ''}`,
  })
  ctx.db.write(byOf(ctx.actor), tx => setScope(tx, head.id, scope))
  return { ...w, head: getThread(ctx.db, head.id) ?? w.head }
}

/** The owner declines an agent's request to share: the thread stays local. */
export function declineShare(ctx: ThreadsCtx, head: ThreadHead): Written {
  if (ctx.actor.kind !== 'owner') throw new ThreadError('owner_only', 'only the owner answers a request to share')
  if (!requestOf(head)) throw new ThreadError('no_request', `nobody asked to share ${head.key}`)
  ctx.db.write(byOf(ctx.actor), tx => setScope(tx, head.id, 'local'))
  return postEntry(ctx, { ...head, scope: 'local' }, { type: 'note', text: 'share declined' })
}

/**
 * The owner shares a thread (11.2): its scope becomes the topic with the thread's id, and one
 * system entry carries the head as it is now; the entries before it stay on this board. Sending it
 * is the caller's (work-hub.ts). Refused for an agent, a mirrored thread, one shared already.
 */
export function shareThread(ctx: ThreadsCtx & { me: string }, head: ThreadHead, target: ShareTarget): Written {
  if (ctx.actor.kind !== 'owner') throw new ThreadError('owner_only', 'only the owner shares a thread')
  if (!ctx.cfg.share) throw new ThreadError('share_off', 'threads stay on this board: config.json says share: false')
  notShared(head)
  if (head.parent) throw new ThreadError('nested', `${head.key} is a sub-thread: share its parent`)
  const key = head.key.replace(/@.*$/, '')
  const scope: SharedScope = {
    kind: target.kind,
    ...(target.peer && { peer: target.peer }),
    ...(target.members && { members: [...target.members] }),
    topic: target.topic,
    key,
    by: 'me',
    at: ctx.now,
  }
  ctx.db.write(byOf(ctx.actor), tx => setScope(tx, head.id, scope))
  const shared = { ...head, scope }
  const set: EntrySet = {
    title: head.title,
    status: head.status,
    summary: head.summary,
    ...(head.waitingOn && { waitingOn: head.waitingOn }),
    ...(head.assignee && { assignee: head.assignee }),
  }
  return postEntry({ ...ctx, me: ctx.me }, shared, { type: 'system', text: SHARE_TEXT, set })
}

/**
 * The owner stops sharing (11.2): one system entry says so to the peers, and from then on nothing
 * goes out or is taken in; the feed stays.
 */
export function unshareThread(ctx: ThreadsCtx & { me: string }, head: ThreadHead): Written {
  if (ctx.actor.kind !== 'owner') throw new ThreadError('owner_only', 'only the owner stops sharing a thread')
  const s = sharedOf(head)
  if (!s) throw new ThreadError('not_shared', `${head.key} is not shared`)
  const ended = ctx.now
  ctx.db.write(byOf(ctx.actor), tx => setScope(tx, head.id, { ...s, ended }))
  return postEntry(
    { ...ctx, me: ctx.me },
    { ...head, scope: { ...s, ended } },
    {
      type: 'system',
      text: 'stopped sharing',
      out: 'queued',
    },
  )
}

/** The owner takes a peer's offer (11.6): this board holds the thread and is on it. */
export function takeOffer(ctx: ThreadsCtx & { me: string }, head: ThreadHead): Written {
  const s = offerOf(ctx, head)
  const w = postEntry(ctx, head, { set: { assignee: OWNER, status: 'doing' } })
  clearOffer(ctx, w.head, s)
  return { ...w, head: getThread(ctx.db, head.id) ?? w.head }
}

/** The owner declines a peer's offer: nobody holds it, and the peer reads why. */
export function declineOffer(ctx: ThreadsCtx & { me: string }, head: ThreadHead, why = ''): Written {
  const s = offerOf(ctx, head)
  const text = cleanText(why, 500)
  const w = postEntry(ctx, head, { text: text ? `declined: ${text}` : 'declined', set: { assignee: null } })
  clearOffer(ctx, w.head, s)
  return { ...w, head: getThread(ctx.db, head.id) ?? w.head }
}

function offerOf(ctx: ThreadsCtx, head: ThreadHead): SharedScope {
  if (ctx.actor.kind !== 'owner') throw new ThreadError('owner_only', 'only the owner takes or declines an offer')
  const s = sharedOf(head)
  if (!s?.offer) throw new ThreadError('no_offer', `nobody offered ${head.key} to this board`)
  return s
}

function clearOffer(ctx: ThreadsCtx, head: ThreadHead, s: SharedScope): void {
  const { offer: _gone, ...rest } = sharingOf(head) ?? s
  ctx.db.write(byOf(ctx.actor), tx => setScope(tx, head.id, rest))
}

/** A thread from a Team topic (13.3, "Track as a thread"): the topic's id is the thread's, its title the thread's. */
export function trackTopic(
  ctx: ThreadsCtx & { me: string },
  input: { id: string; title: string; lane: string; target: ShareTarget },
): Written {
  if (ctx.actor.kind !== 'owner') throw new ThreadError('owner_only', 'only the owner tracks a topic as a thread')
  if (getThread(ctx.db, input.id)) throw new ThreadError('exists', 'that topic is a thread already')
  const lane = input.lane.toLowerCase()
  if (!LANE.test(lane)) throw new ThreadError('lane', `"${input.lane}" is not a lane id`)
  const title = cleanText(input.title, TITLE_MAX).replace(/\s+/g, ' ') || 'a topic'
  const made = ctx.db.write(byOf(ctx.actor), tx =>
    createThread(tx, { id: input.id, lane, title, status: 'doing', author: ctx.actor, at: ctx.now }),
  )
  return shareThread(ctx, made.head, input.target)
}

// ------------------------------------------------------------------ history (4.3)

/** `Send history`: the thread's shared entries as the JSON file the peers import. */
export function historyText(db: BoardDb, head: ThreadHead, me: string): string {
  return JSON.stringify(historyOf(head, entriesOf(db, head.id), me))
}

/**
 * A peer's history file, read in (4.3): each entry this board does not have, with the author the
 * file names and marked as a copy, since the hub cannot prove who wrote an entry it relayed. An
 * entry the file says this board wrote is not taken; an assignee is held to the peer's rules.
 */
export function importHistory(
  ctx: ThreadsCtx & { me: string; nameOf: NameOf },
  head: ThreadHead,
  raw: string,
  from: string,
): number {
  let file: HistoryFile
  try {
    file = JSON.parse(raw) as HistoryFile
  } catch {
    throw new ThreadError('history', 'the history file is no JSON')
  }
  if (file?.v !== 1 || file.thread !== head.id || !Array.isArray(file.entries))
    throw new ThreadError('history', `the history file is not ${head.key}'s`)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const room = Math.max(0, MAX_PEER_ENTRIES - peerEntries(ctx.db, head.id))
  let n = 0
  ctx.db.write(byOf(OWNER), tx => {
    for (const e of file.entries.slice(0, HISTORY_MAX)) {
      if (n >= room) break
      if (!e || typeof e.id !== 'string' || !uuid.test(e.id) || entryById(ctx.db, e.id)) continue
      // A time not ahead of now, a counter within one jump of this board's (as a message's is).
      if (!Number.isSafeInteger(e.at) || e.at < 0 || e.at > ctx.now + DAY) continue
      // Held to what the wire takes of an entry (11.4): its counter, type and every field of its set.
      const checked = readWork({
        n: e.n,
        type: e.type,
        ...(e.set !== undefined && { set: e.set }),
        head: {
          key: wireKey(head),
          title: wireTitle(head.title, wireKey(head)),
          status: head.status,
          summary: '',
          rev: head.rev + MAX_N_JUMP,
        },
      })
      if (!checked) continue
      const peer = e.author?.peer
      if (!isPeerId(peer) || peer === ctx.me) continue
      const agent = validName(e.author.agent) ? e.author.agent : undefined
      const author: Party = { kind: 'peer', peer, name: ctx.nameOf(peer), ...(agent && { agent }) }
      const { set, offer } = peerSet(checked.set, peer, ctx.me, ctx.nameOf)
      // A copy offers nothing: an offer is a teammate's entry that came itself.
      if (offer) delete set.assignee
      const text = checked.type === 'system' ? '' : plainText(String(e.text ?? ''))
      appendEntry(
        tx,
        head.id,
        { id: e.id, n: checked.n, at: e.at, author, type: checked.type, text, set, out: 'copy' },
        ctx.me,
        true,
      )
      n++
    }
    if (n) refoldShared(tx, head.id, ctx.me)
  })
  postEntry(ctx, getThread(ctx.db, head.id) ?? head, {
    type: 'system',
    text: `history from ${ctx.nameOf(from)}'s copy: ${n} ${n === 1 ? 'entry' : 'entries'} added`,
    private: true,
  })
  return n
}

/** Whether two parties are the same writer (re-exported for the routes). */
export { isAdoption, sameParty }

/** The database for a call outside the board (the tests open their own). */
export const openThreadsDb = (): BoardDb | null => openDb({ create: false })
