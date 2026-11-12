// Threads (#379, docs/design/threads): a task with a memory, kept by the board. A thread has a key
// (`atlas-12`), a title, a one-line summary, a status, an assignee and a feed of entries; an entry
// has an author, a time, text, links and files, and may change the head's fields. Workers post
// their result to a thread instead of sending a report to their master, and the master hears one
// line (an event, services/work-threads.ts). Off unless config.json's `threads` turns it on.
//
// Pure: the types, the limits, applyEntry (fold an entry into a head), the key rule, the lines the
// command prints, the event's digest and the brief's block. The tables are
// adapters/work-thread-store.ts; writing and telling the watchers services/work-threads.ts. The
// modules are named work-thread: "thread" already means a session's conversation and a Team
// thread in the code.

export const THREAD_STATUSES = ['next', 'doing', 'waiting', 'owner', 'done', 'dropped'] as const
export type ThreadStatus = (typeof THREAD_STATUSES)[number]
export const isThreadStatus = (v: unknown): v is ThreadStatus => THREAD_STATUSES.includes(v as ThreadStatus)
/** Done and dropped threads are closed: hidden from a list unless asked for. */
export const isOpen = (s: ThreadStatus): boolean => s !== 'done' && s !== 'dropped'

/**
 * Who wrote or holds a thread: the person at this board, a session on it (its card key, a Claude
 * session id or `pane-<id>`, and the name it had then), or a teammate's board (phase 4). The board
 * sets it from the path a write came in on, never from what the write says.
 */
export type Party =
  | { kind: 'owner' }
  | { kind: 'session'; key: string; name: string }
  | { kind: 'peer'; peer: string; name: string; agent?: string }

export type EntryType = 'note' | 'ask' | 'answer' | 'system'

/** The head fields an entry may change. `assignee` and `parent` null: cleared. */
export interface EntrySet {
  status?: ThreadStatus
  summary?: string
  title?: string
  waitingOn?: string
  assignee?: Party | null
  parent?: string | null
  lane?: string
}

export interface ThreadLink {
  url: string
  title?: string
}

/** A file of an entry: copied into the state folder (`ref`, relative to it), so a deleted worktree does not take it along. */
export interface ThreadFile {
  name: string
  size: number
  ref: string
}

export interface ThreadEntry {
  id: string
  thread: string
  /** A counter per thread: one more than the highest this board has seen. */
  n: number
  /** The journal seq it was written with: what a session's cursor counts in. */
  seq: number
  at: number
  author: Party
  type: EntryType
  text: string
  set?: EntrySet
  links?: ThreadLink[]
  files?: ThreadFile[]
  replyTo?: string
  private?: boolean
  /** A system entry the board wrote when the last open sub-thread closed: how many there are. */
  closed?: number
}

/** A proposed close: an agent said done on a thread that waits on the owner (3.5). */
export interface Proposed {
  by: Party
  at: number
  why: string
}

/** A thread's head: what applying every entry's `set` in order gives, kept in its row. */
export interface ThreadHead {
  id: string
  key: string
  lane: string
  title: string
  summary: string
  status: ThreadStatus
  waitingOn: string
  proposed: Proposed | null
  assignee: Party | null
  parent: string | null
  scope: 'local'
  createdBy: Party
  createdAt: number
  updatedAt: number
  doneAt: number | null
  /** The highest entry counter applied. */
  rev: number
  origin?: unknown
}

/** What a watch hears of: answers only (the assignee's own watch), status changes and answers, questions too, every entry. */
export const WATCH_WHATS = ['answers', 'status', 'asks', 'all'] as const
export type WatchWhat = (typeof WATCH_WHATS)[number]
/** The levels `board thread watch --what` takes; `answers` is the board's own. */
export const isWatchWhat = (v: unknown): v is Exclude<WatchWhat, 'answers'> =>
  v === 'status' || v === 'asks' || v === 'all'
/** How much each width hears: a watch hears an entry whose level is at most its own. */
export const LEVEL: Record<WatchWhat, number> = { answers: 0, status: 1, asks: 2, all: 3 }
export const wider = (a: WatchWhat, b: WatchWhat): WatchWhat => (LEVEL[a] >= LEVEL[b] ? a : b)

/** A thread's id, `lane:<id>`, or `mine` (the threads the session created or is assigned). */
export type WatchTarget = string
export const laneTarget = (lane: string): WatchTarget => `lane:${lane}`
export const MINE = 'mine'

export interface Watch {
  session: string
  /** The session's name when it set the watch: the schedule entry's. */
  name: string
  target: WatchTarget
  what: WatchWhat
  /** Delivered only while the session is free. */
  idle: boolean
  /** Wakes a sleeping session; off, the event waits until it is awake. */
  wake: boolean
  /** The threads revision when it began: it hears only what was written after. */
  since: number
}

export interface ThreadsConfig {
  /** Sessions write and get the brief's block; false: threads are the owner's. */
  agents: boolean
  /** The least time between two events for one session, in seconds. */
  gapSec: number
  /** Threads may be shared over the hub (phase 4); false keeps them local. */
  share: boolean
}

export const GAP_SEC = 60

/** config.json's `threads`: `true` is everything on; an object is on, with its settings; absent or anything else is off. */
export function threadsConfig(raw: unknown): ThreadsConfig | null {
  if (raw === true) return { agents: true, gapSec: GAP_SEC, share: true }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const events = typeof r.events === 'object' && r.events !== null ? (r.events as Record<string, unknown>) : {}
  const gap = Number(events.gapSec)
  return {
    agents: r.agents !== false,
    gapSec: Number.isFinite(gap) && gap >= 0 ? Math.min(gap, 3600) : GAP_SEC,
    share: r.share !== false,
  }
}

// ------------------------------------------------------------------ limits

export const TITLE_MAX = 80
export const SUMMARY_MAX = 160
export const WAITING_MAX = 160
export const TEXT_MAX = 4000
export const LINKS_MAX = 5
export const FILES_MAX = 5
export const FILE_MAX_BYTES = 5 * 1024 * 1024
export const CHILDREN_MAX = 20
export const LINK_MAX = 500
/** `show` by default: the last 5 entries, each cut to 300 characters, 1,500 in all. */
export const SHOW_LAST = 5
export const SHOW_ENTRY_MAX = 300
export const SHOW_MAX = 1500
/** `list` and `changes`: 20 lines. */
export const LIST_MAX = 20
/** An event: 400 characters, three threads spelled out. */
export const EVENT_MAX = 400
export const EVENT_SPELLED = 3
/** The brief's block. */
export const BRIEF_MAX = 600

// The text goes into a terminal: no control characters (an escape could drive the pane).
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

/** One line: control characters and line breaks gone, spaces folded, cut at `max`. */
export function oneLine(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Text that keeps its lines: control characters gone, cut at `max`. */
export function cleanText(v: unknown, max = TEXT_MAX): string {
  return String(v ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .trim()
    .slice(0, max)
}

/** Cut to `max` characters with an ellipsis. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s
  return max <= 1 ? s.slice(0, Math.max(0, max)) : `${s.slice(0, max - 1).trimEnd()}…`
}

// ------------------------------------------------------------------ keys

/** A lane id as categories have them. */
export const LANE = /^[a-z0-9_-]{1,64}$/
export const keyOf = (lane: string, n: number): string => `${lane}-${n}`
/** A thread's key: a lane id, a dash, a number. */
export const THREAD_KEY = /^[a-z0-9_-]{1,64}-\d{1,9}$/
/** The first characters of an id, as Team's refs are: 8 hex. */
export const ID_REF = /^[0-9a-f]{8}$/
/** The number a key ends in. */
export const keyNumber = (key: string): number => Number(key.slice(key.lastIndexOf('-') + 1)) || 0

// ------------------------------------------------------------------ parties

export const OWNER: Party = { kind: 'owner' }
export const partyName = (p: Party | null | undefined): string =>
  !p ? '' : p.kind === 'owner' ? 'owner' : p.kind === 'session' ? p.name || p.key.slice(0, 8) : p.name || p.peer
export const sameParty = (a: Party | null | undefined, b: Party | null | undefined): boolean => {
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'owner') return true
  if (a.kind === 'session') return a.key === (b as { key: string }).key
  return a.peer === (b as { peer: string }).peer && (a.agent ?? '') === ((b as { agent?: string }).agent ?? '')
}
/** A session's own write: the session `key` wrote it. */
export const isSession = (p: Party | null | undefined, key: string): boolean => p?.kind === 'session' && p.key === key
/** Written on this board (a session or the owner): its words may be typed into a session. */
export const isLocal = (p: Party | null | undefined): boolean => p?.kind === 'session' || p?.kind === 'owner'

export function isParty(v: unknown): v is Party {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  if (p.kind === 'owner') return true
  if (p.kind === 'session') return typeof p.key === 'string' && !!p.key && typeof p.name === 'string'
  if (p.kind === 'peer') return typeof p.peer === 'string' && !!p.peer && typeof p.name === 'string'
  return false
}

// ------------------------------------------------------------------ the fold

/**
 * The head after `entry`. A session's `done` on a thread that waits on the owner is a proposed
 * close: the thread stays with the owner, with the agent's reason, until the owner confirms or keeps
 * it open (3.5); its summary stays, the agent's words are the proposal's reason. What a thread waits
 * on is kept only while it waits (`waiting` or `owner`); reaching `done` stamps doneAt, reopening
 * clears it.
 */
export function applyEntry(head: ThreadHead, entry: ThreadEntry): ThreadHead {
  const s = entry.set ?? {}
  const next: ThreadHead = { ...head, updatedAt: Math.max(head.updatedAt, entry.at), rev: Math.max(head.rev, entry.n) }
  const proposes = s.status === 'done' && head.status === 'owner' && entry.author.kind !== 'owner'
  if (s.title !== undefined) next.title = s.title
  if (s.summary !== undefined && !proposes) next.summary = s.summary
  if (s.lane !== undefined) next.lane = s.lane
  if (s.assignee !== undefined) next.assignee = s.assignee
  if (s.parent !== undefined) next.parent = s.parent
  if (s.status !== undefined) {
    if (proposes) {
      next.proposed = { by: entry.author, at: entry.at, why: s.summary ?? oneLine(entry.text, SUMMARY_MAX) }
    } else {
      next.status = s.status
      next.proposed = null
      if (s.status !== 'waiting' && s.status !== 'owner') next.waitingOn = ''
      if (s.status === 'done') next.doneAt = head.status === 'done' ? head.doneAt : entry.at
      else if (s.status !== 'dropped') next.doneAt = null
    }
  }
  if (s.waitingOn !== undefined && (next.status === 'waiting' || next.status === 'owner')) next.waitingOn = s.waitingOn
  return next
}

/** What a parent's system entry says when its last open sub-thread closed. */
export const closedText = (n: number): string => (n === 1 ? 'its sub-thread closed' : `all ${n} sub-threads closed`)

/** A status the entry really changed (one that only proposed a close did not). */
export const statusChanged = (before: ThreadHead | null, after: ThreadHead): boolean =>
  !before || before.status !== after.status

// ------------------------------------------------------------------ lines

/** The address of a thread on the board (8): its page opens it from phase 2 on. */
export const threadLink = (base: string, key: string): string => `${base}#thread=${encodeURIComponent(key)}`

const STATUS_WORD: Record<ThreadStatus, string> = {
  next: 'next',
  doing: 'doing',
  waiting: 'waiting',
  owner: 'needs the owner',
  done: 'done',
  dropped: 'dropped',
}

/** One line per thread, as `list` prints it: key, status, assignee, title, summary. */
export function listLine(h: ThreadHead): string {
  const status = h.proposed ? `${h.status}, proposed done` : h.status
  return [h.key, status, h.assignee && partyName(h.assignee), h.title, h.waitingOn || h.summary]
    .filter(Boolean)
    .join(' · ')
}

/** What a write prints: `ok · atlas-13 · done · 1 file`. */
export function writeLine(h: ThreadHead, extra: string[] = []): string {
  return ['ok', h.key, h.status, ...(h.proposed ? ['proposed done, the owner confirms'] : []), ...extra]
    .filter(Boolean)
    .join(' · ')
}

const two = (n: number): string => String(n).padStart(2, '0')
/** A time on this computer: 14:03 today, else 2026-11-12 14:03. */
export function whenText(at: number, now: number): string {
  const d = new Date(at)
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`
  const today = new Date(now)
  const same =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return same ? clock : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${clock}`
}

export const sizeText = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`

/** An entry in words: its author, what it set, its text, files and links. `keyOfId` names a parent. */
export function entryWords(
  e: ThreadEntry,
  { keyOfId = (id: string) => id.slice(0, 8), fileAt = (f: ThreadFile) => f.ref } = {} as {
    keyOfId?: (id: string) => string
    fileAt?: (f: ThreadFile) => string
  },
): string {
  const s = e.set ?? {}
  const parts: string[] = []
  if (e.type === 'system' && e.closed) parts.push(closedText(e.closed))
  else if (e.type === 'system' && s.title !== undefined && e.n === 1) parts.push(`created: ${s.status ?? 'next'}`)
  else if (s.status) parts.push(`→ ${s.status}`)
  if (e.type === 'ask') parts.push(`asks the owner: ${e.text}`)
  else if (e.type === 'answer') parts.push(`answers: ${e.text}`)
  if (s.summary !== undefined && s.summary) parts.push(`summary: ${s.summary}`)
  if (s.waitingOn && e.type !== 'ask') parts.push(`waiting on: ${s.waitingOn}`)
  if (s.title !== undefined && !(e.type === 'system' && e.n === 1)) parts.push(`title: ${s.title}`)
  if (s.assignee !== undefined) parts.push(s.assignee ? `to ${partyName(s.assignee)}` : 'no assignee')
  if (s.parent !== undefined) parts.push(s.parent ? `in ${keyOfId(s.parent)}` : 'no parent')
  if (s.lane !== undefined && !(e.type === 'system' && e.n === 1)) parts.push(`lane ${s.lane}`)
  if (e.text && e.type !== 'ask' && e.type !== 'answer' && e.type !== 'system') parts.push(e.text)
  for (const f of e.files ?? []) parts.push(`file ${f.name} (${sizeText(f.size)}) ${fileAt(f)}`)
  for (const l of e.links ?? []) parts.push(`link ${l.url}`)
  if (e.private) parts.push('private')
  return `${partyName(e.author)}: ${parts.join(' · ') || '(no change)'}`
}

export interface ShowOptions {
  now: number
  link?: string
  /** The parent's key, the children counted (done of all), how many entries there are before the ones given. */
  parentKey?: string | null
  children?: { done: number; all: number }
  earlier?: number
  keyOfId?: (id: string) => string
  fileAt?: (f: ThreadFile) => string
  /** No cuts: everything, for a fork or a subagent. */
  full?: boolean
}

/**
 * What `show` prints: the head, then the entries oldest first, each cut to SHOW_ENTRY_MAX and the
 * whole to SHOW_MAX unless `full` (older entries go first when it does not fit; a line says how
 * many are not shown and how to see them).
 */
export function showText(h: ThreadHead, entries: readonly ThreadEntry[], o: ShowOptions): string {
  const head = [
    listLine(h),
    [
      `lane ${h.lane}`,
      o.parentKey && `in ${o.parentKey}`,
      o.children && o.children.all > 0 && `${o.children.done} of ${o.children.all} sub-threads done`,
      h.proposed && `proposed done by ${partyName(h.proposed.by)}: ${h.proposed.why}`,
      `by ${partyName(h.createdBy)} ${whenText(h.createdAt, o.now)}`,
      o.link,
    ]
      .filter(Boolean)
      .join(' · '),
  ]
  const words = { ...(o.keyOfId && { keyOfId: o.keyOfId }), ...(o.fileAt && { fileAt: o.fileAt }) }
  const lines = entries.map(e => `#${e.n} ${whenText(e.at, o.now)} ${entryWords(e, words)}`)
  if (o.full) return [...head, ...lines].join('\n')
  const cut = lines.map(l => clip(l.replace(/\s*\n\s*/g, ' '), SHOW_ENTRY_MAX))
  const headText = head.map(l => clip(l, SHOW_ENTRY_MAX)).join('\n')
  let budget = SHOW_MAX - headText.length
  const kept: string[] = []
  for (let i = cut.length - 1; i >= 0; i--) {
    const line = cut[i] as string
    if (line.length + 1 > budget - 40) break
    kept.unshift(line)
    budget -= line.length + 1
  }
  const hidden = (o.earlier ?? 0) + cut.length - kept.length
  const note = hidden > 0 ? [`(${hidden} earlier: --last <n>, --since <n> or --full)`] : []
  return [headText, ...note, ...kept].join('\n')
}

// ------------------------------------------------------------------ events

/** What changed on one watched thread since a session's cursor, for its event. */
export interface DigestItem {
  head: ThreadHead
  /** The status changed, an answer came, a close was proposed or the last sub-thread closed. */
  status: boolean
  /** The question raised for the owner, when one was (the newest). */
  ask?: string
  /** All its sub-threads closed (their count). */
  closed?: number
  /** New entries seen in all. */
  entries: number
  /** Everything in it was written on this board: its words may be typed in. */
  local: boolean
}

function clause(d: DigestItem, detailMax: number): { text: string; detail: string } {
  const h = d.head
  const detail = (s: string): string => (d.local && s ? clip(s, Math.max(8, detailMax)) : '')
  if (d.status) {
    if (h.proposed && h.status === 'owner') return { text: `${h.key} proposed done`, detail: detail(h.proposed.why) }
    if (d.closed && h.status !== 'done' && h.status !== 'dropped')
      return { text: `${h.key}: ${closedText(d.closed)}`, detail: '' }
    const word = STATUS_WORD[h.status]
    const said = h.status === 'waiting' || h.status === 'owner' ? h.waitingOn : h.summary
    return { text: `${h.key} ${word}`, detail: detail(said) }
  }
  if (d.ask !== undefined) return { text: `${h.key} asks the owner`, detail: detail(d.ask) }
  return { text: `${h.key} +${d.entries}`, detail: '' }
}

/**
 * The event's line (6.5): at most EVENT_SPELLED threads spelled out (status changes first, in the
 * order they came), then "and N more", then where to read more; EVENT_MAX characters at most, the
 * details cut evenly to fit. A peer's words never go in: only a local entry's summary does.
 */
export function digestLine(items: readonly DigestItem[]): string {
  const ordered = [...items.filter(d => d.status), ...items.filter(d => !d.status && d.ask !== undefined)].concat(
    items.filter(d => !d.status && d.ask === undefined),
  )
  const shown = ordered.slice(0, EVENT_SPELLED)
  const more = ordered.length - shown.length
  const tail = `${more > 0 ? ` · and ${more} more` : ''}. More: board thread changes`
  const build = (max: number): string =>
    shown
      .map(d => {
        const c = clause(d, max)
        return c.detail ? `${c.text}: ${c.detail}` : c.text
      })
      .join(' · ') + tail
  let line = build(SUMMARY_MAX)
  for (let max = SUMMARY_MAX; line.length > EVENT_MAX && max > 8; max -= 4) line = build(max)
  return clip(line, EVENT_MAX)
}

/** The tag a thread event is typed with, from the scheduler's `from`: `[board reminder from threads]`. */
export const EVENT_FROM = { key: 'threads', name: 'threads' } as const

// ------------------------------------------------------------------ the brief

/** The brief's block while threads are on and agents take part (5.2): at most BRIEF_MAX characters. */
export function threadsBrief(): string {
  return [
    '- board thread: work handed to you as a thread (a key like atlas-12) is reported in that thread, not in a message to whoever handed it out; they hear one line.',
    '  board thread post <key> [--status doing|waiting|done] [--summary "<one line>"] [--file <report>] ["<note>"]: progress and results, a long report as --file. board thread ask <key> "<question>": it needs the owner. board thread --help for the rest; the agent-board-threads skill for handing work out by thread.',
  ].join('\n')
}
