// Pure helpers for the Team panel's sidebar list (#835): folding old read topics per person,
// remembering the fold state in localStorage, and filtering across topics, people and channels.
import { storage } from '../state/storage.ts'
import type { ThreadView } from './team.ts'
import { topicWork } from './work-share.ts'

/** Read topics quiet for longer than this fold under "Older (N)". */
export const OLD_TOPIC_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Epoch ms floor for real timestamps (2000-01-01 UTC). Synthetic fixture ordinals like `lastAt: 2`
 * stay below this floor so unit fixtures without real clocks do not falsely fold.
 */
export const MIN_REAL_TS = Date.UTC(2000, 0, 1)

/** Per-scope fold expansion state kept in this browser's localStorage. */
export const OLDER_OPEN_KEY = 'board.team.olderOpen'

export interface FoldStore {
  read(key: string): string | null
  set(key: string, value: string): void
}

export type ScopeEntry = { key: string; thread: ThreadView | null }

/** Latest activity timestamp (epoch ms) for a thread, preferring its latest message ISO timestamp. */
export function topicActivityMs(thread: ThreadView | null): number {
  if (thread?.last?.ts) {
    const parsed = Date.parse(thread.last.ts)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return thread?.lastAt ?? 0
}

/**
 * Whether a topic folds into "Older (N)": only read topics (never general, never unread, never the
 * currently open thread) whose latest real activity is older than `cutoffMs` (default 7 days).
 */
export function isOldReadTopic(
  entry: ScopeEntry,
  opts: {
    now: number
    unread: Record<string, number>
    selected: string | null
    cutoffMs?: number
  },
): boolean {
  if (!entry.thread || entry.thread.id === 'general') return false
  if ((opts.unread[entry.key] ?? 0) > 0) return false
  if (entry.key === opts.selected) return false
  const at = topicActivityMs(entry.thread)
  if (at < MIN_REAL_TS) return false
  return opts.now - at > (opts.cutoffMs ?? OLD_TOPIC_MS)
}

/** Splits a scope's entries (`scopeThreads` output) into general, visible topics, and folded older topics. */
export function splitScopeEntries(
  entries: readonly ScopeEntry[],
  opts: {
    now: number
    unread: Record<string, number>
    selected: string | null
    cutoffMs?: number
  },
): {
  general: ScopeEntry | null
  visible: ScopeEntry[]
  older: ScopeEntry[]
} {
  const general = entries[0] ?? null
  const visible: ScopeEntry[] = []
  const older: ScopeEntry[] = []
  for (const entry of entries.slice(1)) {
    if (isOldReadTopic(entry, opts)) older.push(entry)
    else visible.push(entry)
  }
  return { general, visible, older }
}

/** Reads the set of expanded scopes from `localStorage` (or an injected store). */
export function loadExpandedScopes(store: FoldStore = storage): Set<string> {
  const raw = store.read(OLDER_OPEN_KEY)
  if (!raw) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

/** Saves the set of expanded scopes to `localStorage` (or an injected store). */
export function saveExpandedScopes(scopes: ReadonlySet<string>, store: FoldStore = storage): void {
  store.set(OLDER_OPEN_KEY, JSON.stringify([...scopes]))
}

/** Returns a new set with `scope` toggled open or closed. */
export function toggleExpandedScope(scopes: ReadonlySet<string>, scope: string): Set<string> {
  const next = new Set(scopes)
  if (next.has(scope)) next.delete(scope)
  else next.add(scope)
  return next
}

export const normalizeQuery = (q: string): string => q.trim().toLocaleLowerCase()

/** Whether a single conversation entry matches the normalized/raw search query. */
export function matchesEntry(entry: ScopeEntry, query: string, displayTitle?: string): boolean {
  const q = normalizeQuery(query)
  if (!q) return true
  const workKey = topicWork(entry.thread)?.key
  const fields = [displayTitle, entry.thread?.title, entry.thread?.peerName, workKey]
  return fields.some(f => typeof f === 'string' && f.toLocaleLowerCase().includes(q))
}

/**
 * Filters a scope's general thread and topics against `query`.
 * When the scope name itself matches (e.g. searching a person's name), their general stays shown
 * together with matching topics (or all of their topics when none match by topic title alone).
 * When only topic titles match, `general` is omitted so only matching topics surface.
 */
export function filterScope(
  entries: readonly ScopeEntry[],
  query: string,
  scopeTitle: string,
): { general: ScopeEntry | null; topics: ScopeEntry[] } {
  const q = normalizeQuery(query)
  const general = entries[0] ?? null
  const allTopics = entries.slice(1)
  if (!q) return { general, topics: allTopics }
  const headMatches = scopeTitle.toLocaleLowerCase().includes(q)
  const matchingTopics = allTopics.filter(e => matchesEntry(e, q))
  if (headMatches) {
    return {
      general,
      topics: matchingTopics.length ? matchingTopics : allTopics,
    }
  }
  return { general: null, topics: matchingTopics }
}
