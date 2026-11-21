// Case files (#488, docs/design/threads "Case files"): a thread that holds a long piece of work (a
// ticket, a case, a migration) keeps its outside reference, where it stands (its state) and the
// sessions that worked on it, so a fresh, small session can pick it up from a brief instead of a
// large sleeper being woken to reread its whole conversation. Off unless config.json says
// `"threads": { "cases": true }`.
//
// Pure: the limits, how references match, the sessions read from a feed, the brief's text, the
// lines `show` adds and the nudge. The database side is services/work-cases.ts. The brief is built
// here, from what the caller read, so that anything (a verifier, a page) can read a case the same way.
import { parseNodeKey } from './node-key.ts'
import {
  clip,
  isOpen,
  oneLine,
  type Party,
  PEER_NOTE,
  partyName,
  printable,
  quotedPeer,
  sharingOf,
  sizeText,
  type ThreadEntry,
  type ThreadFile,
  type ThreadHead,
  whenText,
} from './work-threads.ts'

/** A reference: one line. */
export const REF_MAX = 200
/** A state: several lines, kept as written. */
export const STATE_MAX = 2000
export const STATE_LINES = 30
/** `board thread brief`: read once by a new session. */
export const CASE_BRIEF_MAX = 6000
/** Sessions named in `show`'s head; the brief names them all, as far as it has room. */
export const HEAD_SESSIONS = 8
const BRIEF_FILES = 10
const BRIEF_LINKS = 10
const BRIEF_ENTRY_MAX = 300
const BRIEF_REMINDERS = 8

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

/** A reference as given, one line; why not when it is empty or too long. */
export function cleanRef(v: unknown): { ok: true; ref: string } | { ok: false; why: 'empty' | 'long'; length: number } {
  const ref = oneLine(v, 10_000)
  if (!ref) return { ok: false, why: 'empty', length: 0 }
  if (ref.length > REF_MAX) return { ok: false, why: 'long', length: ref.length }
  return { ok: true, ref }
}

/** A state as given: its lines kept, control characters gone; why not when empty or over a cap. */
export function cleanState(
  v: unknown,
): { ok: true; text: string } | { ok: false; why: 'empty' | 'long' | 'lines'; length: number } {
  const text = String(v ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL, '')
    .split('\n')
    .map(l => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text) return { ok: false, why: 'empty', length: 0 }
  if (text.length > STATE_MAX) return { ok: false, why: 'long', length: text.length }
  const lines = text.split('\n').length
  if (lines > STATE_LINES) return { ok: false, why: 'lines', length: lines }
  return { ok: true, text }
}

/** A reference as two references are compared: case folded, spaces and trailing slashes gone. */
export const refKey = (r: string): string => oneLine(r, 10_000).toLowerCase().replace(/\/+$/, '')

/**
 * The id a link ends in: its last path segment when that has a digit in it, as a ticket id has
 * (`https://tracker.example/browse/ABC-12?focus=1` gives `abc-12`); '' for a bare id, and '' when the
 * last segment is a word with no digit, as in `issues?id=5`, whose query names the thing.
 */
export function refTail(r: string): string {
  const k = refKey(r)
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(k)) return ''
  const path = k.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/, '').replace(/[?#].*$/, '')
  const tail = path.split('/').filter(Boolean).at(-1) ?? ''
  return /\d/.test(tail) ? tail : ''
}

/** Whether two references name the same thing: equal once folded, or a link and the id it ends in. */
export function sameRef(a: string, b: string): boolean {
  const x = refKey(a)
  const y = refKey(b)
  if (!x || !y) return false
  if (x === y) return true
  const tx = refTail(a)
  const ty = refTail(b)
  return (!!tx && tx === y) || (!!ty && ty === x)
}

/** ` [same ref: atlas-12 "Fix the login bug"]`, one per thread; nothing for none. */
export function sameRefNote(same: readonly { key: string; title: string }[] | undefined): string[] {
  return (same ?? []).map(s => `[same ref: ${s.key} "${oneLine(s.title, 80)}"]`)
}

/** A thread is a case once it has a reference or a state. */
export const isCase = (h: Pick<ThreadHead, 'ref' | 'state'>): boolean => !!(h.ref || h.state)

/** An entry that carries nothing but case fields: it stays on this board (private), shared thread or not. */
export function caseOnly(e: {
  text?: string
  set?: object
  links?: readonly unknown[]
  files?: readonly unknown[]
}): boolean {
  const keys = Object.keys(e.set ?? {})
  return (
    !e.text && !e.links?.length && !e.files?.length && keys.length > 0 && keys.every(k => k === 'ref' || k === 'state')
  )
}

// ------------------------------------------------------------------ sessions

/** A session that worked on a case, as its feed shows it. */
export interface CaseSession {
  /** Its card key: a Claude session id or `pane-<id>`. */
  key: string
  /** The newest name it wrote or was given under. */
  name: string
  /** It holds the thread now (the assignee). */
  holds: boolean
  /** It held it at some time (assigned by an entry, or holds it now). */
  held: boolean
  /** It created the thread. */
  created: boolean
  /** Entries it wrote. */
  wrote: number
  /** Its newest entry or assignment. */
  last: number
}

/**
 * The sessions of a case: its creator when a session, every session that wrote an entry, every
 * session an entry assigned, the assignee now; the newest first. Read from the feed, never stored.
 */
export function caseSessions(head: ThreadHead, entries: readonly ThreadEntry[]): CaseSession[] {
  const by = new Map<string, CaseSession>()
  const touch = (
    p: Party | null | undefined,
    at: number,
    o: { wrote?: boolean; held?: boolean; created?: boolean },
  ) => {
    if (p?.kind !== 'session') return
    const s = by.get(p.key) ?? {
      key: p.key,
      name: p.name,
      holds: false,
      held: false,
      created: false,
      wrote: 0,
      last: 0,
    }
    if (at >= s.last) {
      s.last = at
      if (p.name) s.name = p.name
    }
    if (o.wrote) s.wrote++
    if (o.held) s.held = true
    if (o.created) s.created = true
    by.set(p.key, s)
  }
  touch(head.createdBy, head.createdAt, { created: true })
  for (const e of entries) {
    touch(e.author, e.at, { wrote: e.type !== 'system' || e.n !== 1 })
    if (e.set?.assignee) touch(e.set.assignee, e.at, { held: true })
  }
  if (head.assignee?.kind === 'session') {
    touch(head.assignee, 0, { held: true })
    const s = by.get(head.assignee.key)
    if (s) s.holds = true
  }
  return [...by.values()].sort((a, b) => b.last - a.last || a.key.localeCompare(b.key))
}

/**
 * The sessions that held the case, the one that holds it now first, then the earlier assignees, the
 * most recently assigned first: whose folder a fresh session of the case starts in (spawn-agent
 * --thread). A session that only wrote in the thread, or created it, never held it.
 */
export function caseHolders(head: ThreadHead, entries: readonly ThreadEntry[]): string[] {
  const out: string[] = []
  if (head.assignee?.kind === 'session') out.push(head.assignee.key)
  for (let i = entries.length - 1; i >= 0; i--) {
    const a = entries[i]?.set?.assignee
    if (a?.kind === 'session' && !out.includes(a.key)) out.push(a.key)
  }
  return out
}

/**
 * The name a fresh session of the case gets when none was asked for: the key, then `key-2`, `key-3`
 * while `taken` (lowercased names of sessions up or asleep) has it, so a message by name finds one.
 */
export function freeName(key: string, taken: ReadonlySet<string>): string {
  let name = key
  for (let n = 2; taken.has(name.toLowerCase()) && n < 100; n++) name = `${key}-${n}`
  return name
}

/** Where a session is now: running on the board, asleep, in the archive, gone (none of those), or not known (the board was not asked). */
export type SessionState = 'up' | 'asleep' | 'archived' | 'gone' | 'unknown'

/**
 * What the board knows of a session now: its state, its live name, the folder it runs or ran in, and
 * the node it runs on (nodes, #508: its key in the feed is device-prefixed), whose folder is that
 * computer's. A node's session the board has no card of is `unknown` there, never `gone`.
 */
export interface SessionLive {
  state: SessionState
  name?: string
  cwd?: string
  device?: string
  /** A node's session while its device is not heard: `state` is from the master's copy of this time. */
  seenAt?: number
}

/**
 * A session's state in words: `up`, `up on server-1`, `last seen up on server-1, 14:05` (its
 * device off line, from the copy), `on server-1, state not known here`.
 */
export function liveWords(l: SessionLive, now: number): string {
  if (!l.device) return l.state
  if (l.state === 'unknown') return `on ${l.device}, state not known here`
  if (l.seenAt !== undefined) return `last seen ${l.state} on ${l.device}, ${whenText(l.seenAt, now)}`
  return `${l.state} on ${l.device}`
}

const liveOf = (live: ReadonlyMap<string, SessionLive> | undefined, key: string): SessionLive =>
  live?.get(key) ?? { state: 'unknown' }

/** A party's name, a session's as the board knows it now when it does (an archived one keeps its record's). */
function nameIn(p: Party | null | undefined, live: ReadonlyMap<string, SessionLive> | undefined): string {
  if (p?.kind === 'session') return live?.get(p.key)?.name || partyName(p)
  return partyName(p)
}

/** A session of a case as `--json` and the routes give it: what the feed says and where it is now. */
export type CaseSessionView = CaseSession & SessionLive

export const caseSessionViews = (
  sessions: readonly CaseSession[],
  live: ReadonlyMap<string, SessionLive> | undefined,
): CaseSessionView[] => sessions.map(s => ({ ...s, ...liveOf(live, s.key) }))

/** A session's key cut for a line: a Claude id to its first 8, a node's with its device kept (`@server-1:0f8fad5b`). */
export function shortKey(key: string): string {
  const cut = (k: string): string => (k.length <= 12 ? k : k.slice(0, 8))
  const node = parseNodeKey(key)
  return node ? `@${node.device}:${cut(node.key)}` : cut(key)
}

/** One session in a line: its name, its key, its state, what it did. `long`: the whole key and the folder. */
function sessionWords(s: CaseSession, l: SessionLive, now: number, long: boolean): string {
  const name = l.name || s.name || shortKey(s.key)
  const key = long ? s.key : shortKey(s.key)
  return [
    `${name} (${key})`,
    liveWords(l, now),
    s.holds ? 'holds it' : s.held ? 'held it' : '',
    long && s.wrote ? `wrote ${s.wrote}` : '',
    long && s.last ? `last ${whenText(s.last, now)}` : '',
    long && l.cwd ? `in ${l.cwd}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * The lines `show` adds to a case's head: its reference, its state (the whole of it on one line,
 * its lines joined with " / ", with the date and the author) and its sessions, the first HEAD_SESSIONS of them. Nothing for a thread that is no case
 * and has no sessions.
 */
export function caseHeadLines(
  head: ThreadHead,
  sessions: readonly CaseSession[],
  live: ReadonlyMap<string, SessionLive> | undefined,
  now: number,
): string[] {
  const out: string[] = []
  if (head.ref) out.push(`ref ${head.ref}`)
  if (head.state)
    out.push(
      `state ${whenText(head.state.at, now)} by ${nameIn(head.state.by, live)}: ${head.state.text.replace(/\s*\n\s*/g, ' / ')}`,
    )
  if (sessions.length) {
    const shown = sessions.slice(0, HEAD_SESSIONS).map(s => sessionWords(s, liveOf(live, s.key), now, false))
    const more = sessions.length - shown.length
    out.push(`sessions: ${shown.join(' · ')}${more > 0 ? ` · and ${more} more` : ''}`)
  }
  return out
}

// ------------------------------------------------------------------ the brief

/** A schedule entry of one of a case's sessions, as the brief names it. */
export interface CaseReminder {
  session: string
  id: string
  next: number
  text: string
  cron?: string
  /** Parked with the session in the archive: it comes back with it. */
  parked?: boolean
}

export interface CaseBriefInput {
  head: ThreadHead
  /** Every entry of the thread, oldest first. */
  entries: readonly ThreadEntry[]
  sessions: readonly CaseSession[]
  live?: ReadonlyMap<string, SessionLive>
  reminders?: readonly CaseReminder[]
  /** The thread's address on the board. */
  link?: string
  now: number
  /** Where a file of an entry is on this computer. */
  fileAt?: (f: ThreadFile) => string
  /** A parent's key by its id. */
  keyOfId?: (id: string) => string
  /** The parent's key, when it has one. */
  parentKey?: string | null
  /**
   * The session the brief is for, when it is the one the thread is given to (spawn-agent --thread):
   * the head names it as "you" and the session that held the case before it.
   */
  you?: string
}

/** Lines that fit `budget` characters (each with its line break), `max` at most, then how many did not. */
function fit(lines: readonly string[], budget: number, more: (n: number) => string, max = Infinity): string[] {
  const kept: string[] = []
  let used = 0
  for (const l of lines) {
    if (kept.length >= max || used + l.length + 1 > budget - 40) break
    kept.push(l)
    used += l.length + 1
  }
  const n = lines.length - kept.length
  return n > 0 ? [...kept, more(n)] : kept
}

const SAY: Record<ThreadHead['status'], string> = {
  next: 'next',
  doing: 'doing',
  waiting: 'waiting',
  owner: 'needs the owner',
  done: 'done',
  dropped: 'dropped',
}

/**
 * What `board thread brief` prints (#488): everything a fresh session needs to pick the case up,
 * without a model and without waking anyone. The head, the state with its date, the sessions with
 * their ids and folders, their open reminders, the files by path, the links, then the newest entries
 * in what is left of CASE_BRIEF_MAX. It never sends the reader to `board resume`: that is the owner's
 * way back to a session, and it would bring the old conversation into the reader's own pane.
 */
export function caseBriefText(c: CaseBriefInput): string {
  const h = c.head
  const fileAt = c.fileAt ?? ((f: ThreadFile) => f.ref)
  // A shared thread (#394): its title, summary and what it waits on may be a teammate's words, and
  // their entries are quoted, as `show` has them: data, never instructions.
  const shared = sharingOf(h) !== null
  const plain = (s: string): string => (shared ? printable(s) : s)
  const said = plain(h.status === 'waiting' || h.status === 'owner' ? h.waitingOn : h.summary)
  const head = [
    clip(`Case ${h.key} · ${SAY[h.status]} · ${plain(h.title)}`, 200),
    clip(
      [h.ref && `ref ${h.ref}`, `lane ${h.lane}`, c.parentKey && `in ${c.parentKey}`, c.link]
        .filter(Boolean)
        .join(' · '),
      400,
    ),
    clip(
      [
        heldWords(h, c.entries, c.you, c.live),
        said && (h.status === 'waiting' || h.status === 'owner' ? `waiting on: ${said}` : `summary: ${said}`),
        h.proposed && `proposed done by ${nameIn(h.proposed.by, c.live)}: ${plain(h.proposed.why)}`,
      ]
        .filter(Boolean)
        .join(' · '),
      400,
    ),
    ...(shared ? [PEER_NOTE] : []),
  ]
  const state = h.state
    ? [`State, ${whenText(h.state.at, c.now)} by ${nameIn(h.state.by, c.live)}:`, h.state.text]
    : ['State: none written yet.']
  const sessions = c.sessions.length
    ? [
        'Sessions, newest first (a question only one of them can answer goes to it by name as a message, sparingly: it wakes with its whole conversation):',
        ...fit(
          c.sessions.map(s => clip(`- ${sessionWords(s, liveOf(c.live, s.key), c.now, true)}`, 300)),
          1000,
          n => `- and ${n} more: board thread show ${h.key} --full`,
        ),
      ]
    : []
  const rem = (c.reminders ?? [])
    .slice()
    .sort((a, b) => a.next - b.next)
    .map(r => {
      const who = c.sessions.find(s => s.key === r.session)
      const name = liveOf(c.live, r.session).name || who?.name || r.session.slice(0, 8)
      const when = r.cron ? `every "${r.cron}", next ${whenText(r.next, c.now)}` : whenText(r.next, c.now)
      return clip(`- ${name}: ${when}${r.parked ? ' (parked in the archive)' : ''}: ${oneLine(r.text, 200)}`, 260)
    })
  const reminders = rem.length
    ? ['Their open reminders:', ...fit(rem, 600, n => `- and ${n} more`, BRIEF_REMINDERS)]
    : []
  const fileLines: string[] = []
  const linkLines: string[] = []
  for (const e of [...c.entries].reverse()) {
    for (const f of e.files ?? []) fileLines.push(clip(`- ${f.name} (${sizeText(f.size)}) ${fileAt(f)} · #${e.n}`, 300))
    for (const l of e.links ?? []) linkLines.push(clip(`- ${l.url} · #${e.n}`, 300))
  }
  const files = fileLines.length
    ? ['Files, newest first:', ...fit(fileLines, 700, n => `- and ${n} more`, BRIEF_FILES)]
    : []
  const links = linkLines.length
    ? ['Links, newest first:', ...fit(linkLines, 500, n => `- and ${n} more`, BRIEF_LINKS)]
    : []
  const footer = [
    `More: board thread show ${h.key} --full (every entry, whole). A past session is the owner's to bring back (board resume); do not resume one yourself.`,
  ]
  const fixed = [head, state, sessions, reminders, files, links, footer]
  const used = fixed.reduce((n, part) => n + part.reduce((m, l) => m + l.length + 1, 0), 0)
  // The newest entries in what is left, each on one line and cut; older ones counted.
  const entryLines = c.entries.map(e =>
    clip(
      `#${e.n} ${whenText(e.at, c.now)} ${entryLine(e, c.keyOfId, c.live)}`.replace(/\s*\n\s*/g, ' '),
      BRIEF_ENTRY_MAX,
    ),
  )
  let budget = CASE_BRIEF_MAX - used - 40
  const kept: string[] = []
  for (let i = entryLines.length - 1; i >= 0; i--) {
    const l = entryLines[i] as string
    if (l.length + 1 > budget - 60) break
    kept.unshift(l)
    budget -= l.length + 1
  }
  const earlier = entryLines.length - kept.length
  const entries =
    kept.length || earlier
      ? [`Last entries${earlier ? ` (${earlier} earlier: board thread show ${h.key} --full)` : ''}:`, ...kept]
      : []
  const text = [...head, ...state, ...sessions, ...reminders, ...files, ...links, ...entries, ...footer].join('\n')
  return clip(text, CASE_BRIEF_MAX)
}

/** Who holds the case, for the brief's head; "you" and the one before when it is for the new holder. */
function heldWords(
  h: ThreadHead,
  entries: readonly ThreadEntry[],
  you: string | undefined,
  live: ReadonlyMap<string, SessionLive> | undefined,
): string {
  if (!h.assignee) return 'held by nobody'
  if (!you || h.assignee.kind !== 'session' || h.assignee.key !== you) return `held by ${nameIn(h.assignee, live)}`
  let before: Party | null = null
  for (let i = entries.length - 1; i >= 0 && !before; i--) {
    const a = entries[i]?.set?.assignee
    if (a && !(a.kind === 'session' && a.key === you)) before = a
  }
  return `held by you (${partyName(h.assignee)})${before ? `, before you by ${nameIn(before, live)}` : ''}`
}

/** An entry in a few words for the brief: its author, what it set, its text. */
function entryLine(e: ThreadEntry, keyOfId?: (id: string) => string, live?: ReadonlyMap<string, SessionLive>): string {
  const s = e.set ?? {}
  const parts: string[] = []
  // A teammate's words (#394) are quoted, nothing in them able to move the cursor, as `show` has them.
  const said = (t: string): string => (e.author.kind === 'peer' ? quotedPeer(t) : t)
  if (e.type === 'system' && e.n === 1) parts.push(`created: ${s.status ?? 'next'}`)
  else if (s.status) parts.push(`→ ${s.status}`)
  if (e.type === 'ask') parts.push(`asks the owner: ${said(e.text)}`)
  else if (e.type === 'answer') parts.push(`answers: ${said(e.text)}`)
  if (s.summary) parts.push(`summary: ${said(s.summary)}`)
  if (s.waitingOn && e.type !== 'ask') parts.push(`waiting on: ${said(s.waitingOn)}`)
  if (s.assignee !== undefined && !(e.type === 'system' && e.n === 1))
    parts.push(s.assignee ? `to ${nameIn(s.assignee, live)}` : 'no assignee')
  if (s.parent) parts.push(`in ${keyOfId ? keyOfId(s.parent) : s.parent.slice(0, 8)}`)
  if (s.ref !== undefined) parts.push(s.ref ? `ref ${s.ref}` : 'no ref')
  if (s.state !== undefined) parts.push('state written (above when newest)')
  if (e.text && e.type !== 'ask' && e.type !== 'answer') parts.push(said(e.text))
  if (e.files?.length) parts.push(`${e.files.length} ${e.files.length === 1 ? 'file' : 'files'}`)
  if (e.links?.length) parts.push(`${e.links.length} ${e.links.length === 1 ? 'link' : 'links'}`)
  const who =
    e.author.kind === 'peer'
      ? `${e.author.agent ? `${printable(e.author.agent)}@` : ''}${printable(e.author.name)}`
      : nameIn(e.author, live)
  return `${who}: ${parts.join(' · ') || '(no change)'}`
}

// ------------------------------------------------------------------ the nudge

/**
 * Whether a session that holds the case `head` left its state behind its work (#488): an open case
 * it is assigned, whose state is missing or older than the session's own last work there (its
 * card's `doingAt`, or its newest entry on the thread that wrote no state). The words for the reply
 * line, or null. It refuses nothing.
 */
export function staleCase(
  head: ThreadHead,
  entries: readonly ThreadEntry[],
  session: string,
  doingAt: number | undefined,
  now: number,
): string | null {
  if (!isOpen(head.status) || !isCase(head)) return null
  if (head.assignee?.kind !== 'session' || head.assignee.key !== session) return null
  const own = entries
    .filter(e => e.author.kind === 'session' && e.author.key === session && e.set?.state === undefined)
    .reduce((m, e) => Math.max(m, e.at), 0)
  const work = Math.max(doingAt ?? 0, own)
  const how = `board thread post ${head.key} --state "<where it stands, what next, what it waits on>"`
  if (!head.state) return `${head.key}: no state yet: ${how}`
  if (head.state.at >= work) return null
  return `${head.key}: state from ${whenText(head.state.at, now)}, older than your work: ${how}`
}

/** The nudges of several cases in one tail for a reply line: three spelled out, then how many more. */
export function nudgeTail(nudges: readonly string[]): string {
  if (!nudges.length) return ''
  const shown = nudges.slice(0, 3)
  const more = nudges.length - shown.length
  return ` · ${shown.join(' · ')}${more > 0 ? ` · and ${more} more cases: board thread list --mine` : ''}`
}
