// Threads on the board's page (#392, docs/design/threads 10): what the panel, the card's chips, the
// sheet's fold and the links make of GET /api/threads and GET /api/threads/<key>. Pure; the data
// comes from hooks/useThreads.ts. "Thread" already names a session's conversation and a Team thread
// on the page, so the code says work thread (wt) and the screen says thread.
import type { ColumnId } from '../../../src/core/types.ts'
import {
  applyEntry,
  KEY_IN_TEXT,
  type Party,
  THREAD_KEY,
  type ThreadEntryView,
  type ThreadHead,
  type ThreadRow,
  type ThreadStatus,
} from '../../../src/core/work-threads.ts'
import { COLUMN_COLORS } from './toolbar.ts'

export type { ThreadEntryView, ThreadRow, ThreadStatus, ThreadView } from '../../../src/core/work-threads.ts'

/** Each status is a card column, in its colour (3.4); dropped is gray, with the done ones. */
export const STATUS_COLUMN: Record<ThreadStatus, ColumnId> = {
  next: 'idle',
  doing: 'work',
  waiting: 'ext',
  owner: 'me',
  done: 'done',
  dropped: 'idle',
}
export const statusColor = (s: ThreadStatus): string => COLUMN_COLORS[STATUS_COLUMN[s]]

/** The panel's sections, in order (10.3): Done folds, and holds the dropped ones too. */
export const SECTIONS = ['owner', 'doing', 'waiting', 'next', 'done'] as const
export type SectionId = (typeof SECTIONS)[number]
export const sectionOf = (s: ThreadStatus): SectionId => (s === 'dropped' ? 'done' : s)
/** The statuses the owner's status menu offers. */
export const STATUS_MENU: readonly ThreadStatus[] = ['next', 'doing', 'waiting', 'owner', 'done', 'dropped']

export interface ListFilter {
  /** A lane id, or null for every lane. */
  lane: string | null
  /** Words to look for in the key, the title, the summary and the assignee's name. */
  query: string
}

const nameOf = (p: Party | null): string =>
  !p ? '' : p.kind === 'owner' ? '' : p.kind === 'session' ? p.name || p.key.slice(0, 8) : p.name || p.peer

/** Rows by section, each the newest change first; a sub-thread sits in the section of its own status (9.2). */
export function sectionsOf(rows: readonly ThreadRow[], f: ListFilter): { id: SectionId; rows: ThreadRow[] }[] {
  const words = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const shown = rows.filter(r => {
    if (f.lane && r.lane !== f.lane) return false
    if (!words.length) return true
    const hay = `${r.key} ${r.title} ${r.summary} ${r.waitingOn} ${nameOf(r.assignee)}`.toLowerCase()
    return words.every(w => hay.includes(w))
  })
  return SECTIONS.map(id => ({
    id,
    rows: shown.filter(r => sectionOf(r.status) === id).sort((a, b) => b.updatedAt - a.updatedAt),
  })).filter(s => s.rows.length > 0)
}

/** The lanes the threads are in, the most used first. */
export function lanesOf(rows: readonly ThreadRow[]): string[] {
  const n = new Map<string, number>()
  for (const r of rows) n.set(r.lane, (n.get(r.lane) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([lane]) => lane)
}

/** A card's chips (10.1): the open threads its session is assigned, two at most, then how many more. */
export const CHIPS_MAX = 2
export function chipsOf(rows: readonly ThreadRow[], session: string): { shown: ThreadRow[]; more: number } {
  const mine = rows
    .filter(
      r =>
        r.assignee?.kind === 'session' && r.assignee.key === session && r.status !== 'done' && r.status !== 'dropped',
    )
    // What needs the owner first, then what is being done, then the rest; the newest change first.
    .sort(
      (a, b) =>
        SECTIONS.indexOf(sectionOf(a.status)) - SECTIONS.indexOf(sectionOf(b.status)) || b.updatedAt - a.updatedAt,
    )
  return { shown: mine.slice(0, CHIPS_MAX), more: Math.max(0, mine.length - CHIPS_MAX) }
}

/** A session's threads for its sheet's fold (10.4): assigned to it or created by it, open ones first. */
export function sessionThreads(rows: readonly ThreadRow[], session: string): ThreadRow[] {
  const is = (p: Party | null) => p?.kind === 'session' && p.key === session
  return rows
    .filter(r => is(r.assignee) || is(r.createdBy))
    .sort(
      (a, b) =>
        Number(a.status === 'done' || a.status === 'dropped') - Number(b.status === 'done' || b.status === 'dropped') ||
        b.updatedAt - a.updatedAt,
    )
}

// ------------------------------------------------------------------ links (8)

/** The thread a page was opened for: #thread=<key>, or null. */
export function threadInHash(hash: string): string | null {
  const key = new URLSearchParams(hash.slice(1)).get('thread')?.toLowerCase() ?? ''
  return THREAD_KEY.test(key) ? key : null
}

/** A thread the board was asked to show (the stream's `thread-open`); `n` tells two asks apart. */
export interface ThreadOpen {
  key: string
  n: number
}

/** The key a `thread-open` event names ({ key }), or null for anything else. */
export function threadOpenOf(data: unknown): string | null {
  try {
    const v: unknown = JSON.parse(String(data))
    if (typeof v !== 'object' || v === null || !('key' in v) || typeof v.key !== 'string') return null
    return THREAD_KEY.test(v.key) ? v.key : null
  } catch {
    return null
  }
}

/** Listens for the stream's `thread-open` event: its thread becomes the one to show. */
export function listenForThreadOpens(
  stream: { addEventListener(type: 'thread-open', listener: (event: MessageEvent) => void): void },
  set: (next: (prev: ThreadOpen | null) => ThreadOpen) => void,
): void {
  stream.addEventListener('thread-open', event => {
    const key = threadOpenOf(event.data)
    if (key) set(prev => ({ key, n: (prev?.n ?? 0) + 1 }))
  })
}

/** A link to this board's own page that names a thread or a session, or null for any other link. */
export function boardLinkOf(
  href: string,
  here: { origin: string; pathname: string },
): { thread: string } | { session: string } | null {
  let url: URL
  try {
    url = new URL(href, here.origin)
  } catch {
    return null
  }
  if (url.origin !== here.origin || url.pathname !== here.pathname) return null
  const thread = threadInHash(url.hash)
  if (thread) return { thread }
  const session = new URLSearchParams(url.hash.slice(1)).get('session')
  return session ? { session } : null
}

/** The thread's address on this page, as `board thread link` prints it (8). */
export const threadHref = (key: string, origin: string): string => `${origin}/#thread=${encodeURIComponent(key)}`

/** Text cut into plain parts and the known thread keys in it, which become links. */
export function keyParts(text: string, known: ReadonlySet<string>): (string | { key: string })[] {
  if (!known.size) return [text]
  const out: (string | { key: string })[] = []
  let at = 0
  for (const m of text.matchAll(KEY_IN_TEXT)) {
    const key = m[1] as string
    if (!known.has(key)) continue
    const i = m.index ?? 0
    if (i > at) out.push(text.slice(at, i))
    out.push({ key })
    at = i + key.length
  }
  if (at < text.length) out.push(text.slice(at))
  return out.length ? out : [text]
}

// ------------------------------------------------------------------ the feed

/** One line of the thread's feed as the panel draws it. */
export type FeedItem =
  | { kind: 'day'; at: number }
  | {
      kind: 'status'
      entry: ThreadEntryView
      /** What the entry did, for the line's words. */
      did: 'created' | 'status' | 'proposed' | 'confirmed' | 'kept' | 'closed' | 'fields'
      to: ThreadStatus
    }
  | { kind: 'ask'; entry: ThreadEntryView; open: boolean }
  | { kind: 'message'; entry: ThreadEntryView }

const dayOf = (at: number): string => new Date(at).toDateString()

/**
 * The feed in the order written: a day line where the day changes; an entry with words or files is
 * a message (its status change, if any, a quiet line before it); an entry that only changes fields
 * is a quiet line; a question for the owner is a block, open while it waits for an answer. A
 * proposed close, the owner's confirm and keep open say so, by folding the heads as the board does.
 */
export function feedOf(head: ThreadHead, entries: readonly ThreadEntryView[], openAsk: string | null): FeedItem[] {
  const out: FeedItem[] = []
  let h: ThreadHead | null = null
  let day = ''
  const blank: ThreadHead = {
    ...head,
    title: '',
    summary: '',
    status: 'next',
    waitingOn: '',
    proposed: null,
    assignee: null,
    parent: null,
    doneAt: null,
    rev: 0,
  }
  for (const e of entries) {
    const before: ThreadHead | null = h
    const after: ThreadHead = applyEntry(h ?? blank, { ...e, files: e.files ?? [] } as Parameters<typeof applyEntry>[1])
    h = after
    if (dayOf(e.at) !== day) {
      day = dayOf(e.at)
      out.push({ kind: 'day', at: e.at })
    }
    const set = e.set ?? {}
    const proposed = !!after.proposed && after.proposed !== before?.proposed
    const confirmed = !!before?.proposed && after.status === 'done' && !after.proposed
    const kept = !!before?.proposed && !after.proposed && after.status === 'owner'
    if (e.type === 'ask') {
      out.push({ kind: 'ask', entry: e, open: e.id === openAsk })
      continue
    }
    const created = e.type === 'system' && e.n === 1
    const changed = !before || before.status !== after.status
    const words = !!e.text && e.type !== 'system'
    const did: Extract<FeedItem, { kind: 'status' }>['did'] | null = created
      ? 'created'
      : e.closed
        ? 'closed'
        : proposed
          ? 'proposed'
          : confirmed
            ? 'confirmed'
            : kept
              ? 'kept'
              : set.status !== undefined && changed
                ? 'status'
                : !words && !e.files?.length && !e.links?.length && Object.keys(set).length
                  ? 'fields'
                  : null
    if (did) out.push({ kind: 'status', entry: e, did, to: after.status })
    if (words || e.files?.length || e.links?.length) out.push({ kind: 'message', entry: e })
  }
  return out
}

/** Who wrote an entry, for its mark: the owner's own words are "out", everyone else's "in". */
export const isOwnerParty = (p: Party | null | undefined): boolean => p?.kind === 'owner'
export const partyLabel = (p: Party | null | undefined, you: string): string =>
  !p ? '' : p.kind === 'owner' ? you : p.kind === 'session' ? p.name || p.key.slice(0, 8) : p.name || p.peer
