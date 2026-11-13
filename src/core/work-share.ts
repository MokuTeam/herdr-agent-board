// Shared threads over the hub (#394, docs/design/threads 11 and 4.3), their pure rules. A shared
// thread is a Team topic with the thread's id; each entry that is not private is a message in it,
// and what a plain message lacks rides in its signed body field `work` (core/team-wire.ts
// WorkBody), sent only to a board whose caps say `work`. Every board that takes part keeps its own
// copy, and the copies come out the same:
//
//   1. Entries are immutable and carry `n`, one more than the highest the writer had seen.
//   2. A head field takes the value of the entry that is last in the order (n, at, author's peer
//      id): foldShared below. Two boards with the same entries get the same head, whatever order the
//      entries arrived in.
//   3. Every entry carries its sender's head after it. A board whose own counter is more than one
//      behind the entry's knows it missed entries: it writes an entry of its own that takes the
//      sender's head fields (`entries missing here`), placed right after the sender's.
//
// What a peer may set (11.4): status, summary, what it waits on, the title, and an assignee that
// is the peer itself (or one of its sessions), a third member of the team, nobody, or this board
// (an offer, 11.6). One of this board's sessions, never: that is the owner's to give.
import {
  MAX_TEXT,
  MAX_WORK_LINE,
  validName,
  validTitle,
  type WorkBody,
  type WorkHead,
  type WorkParty,
  type WorkSet,
  withoutUnprintable,
} from './team.ts'
import {
  applyEntry,
  type EntrySet,
  oneLine,
  type Party,
  partyName,
  type SharedScope,
  sharedOf,
  type ThreadEntry,
  type ThreadHead,
  type ThreadStatus,
  TITLE_MAX,
} from './work-threads.ts'

// ------------------------------------------------------------------ the order (4.3)

/** The peer id an entry's author orders by: this board's own for its sessions and its owner. */
export const authorPeer = (p: Party, me: string): string => (p.kind === 'peer' ? p.peer : me)

/**
 * The entry this board wrote when it found entries missing (rule 3): a private system entry in a
 * peer's name. A peer's own entries are never private, so nothing else looks like it.
 */
export const isAdoption = (e: Pick<ThreadEntry, 'type' | 'private' | 'author'>): boolean =>
  e.type === 'system' && e.private === true && e.author.kind === 'peer'

/** Entries in the order every board folds a shared thread in: (n, at, author's peer id), an adoption after its sender's entry, then the id. */
export function sharedOrder(entries: readonly ThreadEntry[], me: string): ThreadEntry[] {
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return [...entries].sort(
    (a, b) =>
      a.n - b.n ||
      a.at - b.at ||
      cmp(authorPeer(a.author, me), authorPeer(b.author, me)) ||
      Number(isAdoption(a)) - Number(isAdoption(b)) ||
      cmp(a.id, b.id),
  )
}

/** A thread before its first entry: what folding its feed starts from (its id, key, lane, scope and creator kept). */
export const blankHead = (h: ThreadHead): ThreadHead => ({
  ...h,
  title: '',
  summary: '',
  status: 'next',
  waitingOn: '',
  proposed: null,
  assignee: null,
  parent: null,
  doneAt: null,
  rev: 0,
})

/** A shared thread's head: every entry it holds folded in the shared order (rule 2). */
export function foldShared(base: ThreadHead, entries: readonly ThreadEntry[], me: string): ThreadHead {
  let h = blankHead(base)
  for (const e of sharedOrder(entries, me)) h = applyEntry(h, e)
  // A copy that never got the entry with the title keeps the one it was made with.
  return h.title ? h : { ...h, title: base.title }
}

// ------------------------------------------------------------------ out (11.1)

/** A line as the wire takes it: one line, nothing unprintable, at most `max`. */
export const wireLine = (v: unknown, max = MAX_WORK_LINE): string => oneLine(withoutUnprintable(String(v ?? '')), max)

/** A title as the wire takes it; the key when nothing printable is left of it. */
export function wireTitle(v: unknown, key: string): string {
  const t = wireLine(v, TITLE_MAX)
  return validTitle(t) ? t : key
}

/** A session's name as the wire's `agent` takes it, or none. */
function agentName(name: string): string | undefined {
  const n = wireLine(name, 40)
  return validName(n) ? n : undefined
}

/** A party as the wire names it: this board (its owner, or one of its sessions by name), or a peer. */
export function wireParty(p: Party, me: string): WorkParty {
  if (p.kind === 'peer') {
    const agent = p.agent ? agentName(p.agent) : undefined
    return { peer: p.peer, ...(agent && { agent }) }
  }
  if (p.kind === 'owner') return { peer: me }
  const agent = agentName(p.name || p.key.slice(0, 8))
  return { peer: me, ...(agent && { agent }) }
}

/** The key a shared thread goes by on the wire: its sharer's (without the `@name` this board shows). */
export const wireKey = (h: ThreadHead): string => sharedOf(h)?.key ?? h.key.replace(/@.*$/, '')

/** The sender's head after an entry (rule 3). */
export function wireHead(h: ThreadHead): WorkHead {
  return {
    key: wireKey(h),
    title: wireTitle(h.title, wireKey(h)),
    status: h.status,
    summary: wireLine(h.summary),
    rev: h.rev,
  }
}

/**
 * What of an entry's `set` goes to the peers: status, summary, what it waits on, the title and the
 * assignee, each as the wire takes it. Lane and parent are this board's own. A session's `done`
 * that only proposed a close (`proposed`: the thread waits on the owner) changed nothing the peers
 * hold: its status and summary stay here.
 */
export function wireSet(set: EntrySet | undefined, me: string, proposed = false): WorkSet | undefined {
  if (!set) return undefined
  const out: WorkSet = {}
  if (set.status !== undefined && !proposed) out.status = set.status
  if (set.summary !== undefined && !proposed) out.summary = wireLine(set.summary)
  if (set.waitingOn !== undefined) out.waitingOn = wireLine(set.waitingOn)
  if (set.title !== undefined) {
    const t = wireLine(set.title, TITLE_MAX)
    if (validTitle(t)) out.title = t
  }
  if (set.assignee !== undefined) out.assignee = set.assignee === null ? null : wireParty(set.assignee, me)
  return Object.keys(out).length ? out : undefined
}

const SAY: Record<ThreadStatus, string> = {
  next: 'next',
  doing: 'doing',
  waiting: 'blocked on',
  owner: 'blocked on',
  done: 'done',
  dropped: 'dropped',
}

/**
 * The text a board writes for an entry that has none (11.1): for a peer whose board does not keep
 * shared threads it is the whole entry, in the convention the Team skill teaches (`done: ...`,
 * `blocked on: ...`, `next: ...`); a board that does is told by `work.auto` not to show it twice.
 */
export function fallbackLine(
  e: Pick<ThreadEntry, 'type' | 'text' | 'set' | 'links'>,
  h: ThreadHead,
  flags: { share?: boolean; unshare?: boolean } = {},
): string {
  const s = e.set ?? {}
  const key = wireKey(h)
  if (flags.share) {
    const said = h.status === 'waiting' || h.status === 'owner' ? h.waitingOn : h.summary
    return clipText(`shared as a thread: ${key} · ${h.status}${said ? `: ${wireLine(said)}` : ''}`)
  }
  if (flags.unshare) return `stopped sharing ${key}`
  const parts: string[] = []
  if (s.status !== undefined) {
    const said = s.status === 'waiting' || s.status === 'owner' ? (s.waitingOn ?? s.summary) : s.summary
    parts.push(`${SAY[s.status]}: ${wireLine(said || h.summary || h.title)}`)
  } else if (s.summary !== undefined) parts.push(`${SAY[h.status]}: ${wireLine(s.summary)}`)
  else if (s.waitingOn !== undefined) parts.push(`blocked on: ${wireLine(s.waitingOn)}`)
  if (s.title !== undefined) parts.push(`title: ${wireLine(s.title, TITLE_MAX)}`)
  if (s.assignee !== undefined) parts.push(s.assignee ? `assigned to ${partyName(s.assignee)}` : 'unassigned')
  for (const l of e.links ?? []) parts.push(l.url)
  return clipText(parts.join(' · ') || `${key} updated`)
}

const clipText = (s: string): string => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s)

// ------------------------------------------------------------------ in (11.4)

/** What this board knows of a peer, by its id: its roster name. */
export type NameOf = (peer: string) => string

/**
 * A peer's `set` as this board stores it (11.4), and what was refused of it. An assignee that is
 * this board is an offer (`offer`); one that names a session of this board is refused.
 */
export function peerSet(
  set: WorkSet | undefined,
  from: string,
  me: string,
  nameOf: NameOf,
): { set: EntrySet; offer: boolean; refused: string[] } {
  const out: EntrySet = {}
  const refused: string[] = []
  let offer = false
  if (!set) return { set: out, offer, refused }
  if (set.status !== undefined) out.status = set.status
  if (set.summary !== undefined) out.summary = set.summary
  if (set.waitingOn !== undefined) out.waitingOn = set.waitingOn
  if (set.title !== undefined) out.title = set.title
  if (set.assignee !== undefined) {
    const a = set.assignee
    if (a === null) out.assignee = null
    else if (a.peer === me) {
      if (a.agent !== undefined) refused.push('assignee')
      else {
        out.assignee = { kind: 'owner' }
        offer = from !== me
      }
    } else out.assignee = { kind: 'peer', peer: a.peer, name: nameOf(a.peer), ...(a.agent && { agent: a.agent }) }
  }
  return { set: out, offer, refused }
}

/** The adoption's fields: the sender's head (rule 3), the fields that differ from this board's. */
export function adoptedSet(theirs: WorkHead, mine: ThreadHead | null): EntrySet {
  const set: EntrySet = {}
  if (!mine || mine.title !== theirs.title) set.title = theirs.title
  if (!mine || mine.status !== theirs.status) set.status = theirs.status
  if (!mine || mine.summary !== theirs.summary) set.summary = theirs.summary
  return set
}

/** The words of the entry that adopts a sender's head. */
export function missingText(from: number, to: number, who: string): string {
  const span = from >= to ? `#${from}` : `#${from} to #${to}`
  return `entries missing here (${span}); the head is taken from ${who}'s copy`
}

/**
 * The key a peer's thread goes by here (11.5): its own when this board has no thread with it, else
 * with the peer's name after it (`atlas-13@ben`), letters and digits of the name, or of its key.
 */
export function localKey(key: string, taken: (k: string) => boolean, name: string, peer: string): string {
  if (!taken(key)) return key
  const slug =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9_-]+/g, '')
      .slice(0, 32) ||
    peer
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 8) ||
    'peer'
  for (let i = 1; i < 100; i++) {
    const k = `${key}@${slug}${i === 1 ? '' : i}`
    if (!taken(k)) return k
  }
  return `${key}@${slug}${Date.now() % 1000}`
}

/** A shared scope's members as a person reads them: the peer, the team, or the channel's others. */
export function scopeWho(s: SharedScope, nameOf: NameOf, me: string): string {
  if (s.kind === 'peer') return s.peer ? nameOf(s.peer) : 'a peer'
  if (s.kind === 'team') return 'the team'
  return (s.members ?? [])
    .filter(m => m !== me)
    .map(nameOf)
    .join(', ')
}

// ------------------------------------------------------------------ history (4.3, "Send history")

/** A history file's entry: what `Send history` exports of one entry. */
export interface HistoryEntry {
  id: string
  n: number
  at: number
  type: WorkBody['type']
  text: string
  set?: WorkSet
  author: WorkParty
}

export interface HistoryFile {
  v: 1
  thread: string
  key: string
  entries: HistoryEntry[]
}

/** At most this many entries in one history file. */
export const HISTORY_MAX = 2000

/** The shared entries of a thread as `Send history` exports them: never a private one, nor one that came from a copy. */
export function historyOf(h: ThreadHead, entries: readonly ThreadEntry[], me: string): HistoryFile {
  return {
    v: 1,
    thread: h.id,
    key: wireKey(h),
    entries: entries
      .filter(e => !e.private && e.out !== 'copy' && e.out !== 'import')
      .slice(-HISTORY_MAX)
      .map(e => {
        const set = wireSet(e.set, me)
        return {
          id: e.id,
          n: e.n,
          at: e.at,
          type: e.type,
          text: e.text.slice(0, MAX_TEXT),
          ...(set && { set }),
          author: wireParty(e.author, me),
        }
      }),
  }
}
