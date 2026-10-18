// The chat's files on the server, as the old page's files.js asks for them: what the paths are
// (stat), a preview, opening a file or folder with the system or a web link in the browser, a
// session checkout's changes and its project's past sessions. Every answer is narrowed before use;
// a refusal comes back as an `error` (with its HTTP status), as the old page had it.
import type { Translator } from '../../../src/core/types.ts'
import type { FolderEntry, PathInfo, Preview } from '../models/files.ts'
import type { Changes, HistoryHit, HistoryReply } from '../models/quick-look.ts'
import { isReply, postJson, type Reply, replyOf } from './client.ts'

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const numOrNull = (v: unknown): number | null | undefined => (v === null ? null : num(v))
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** A refusal as the page shows it: the server's own words, else its status; or why it was not reached. */
export type Refused = Reply & { error: string; httpStatus?: number }

/** POST with the board's header; the answer whatever it says, a refusal with its `error`. */
export async function filesPost(path: string, body: unknown, t: Translator): Promise<Reply> {
  try {
    const res = await postJson(path, body)
    const value = await replyOf(res)
    const r = isReply(value) ? value : {}
    if (res.ok) return r
    const refused: Refused = {
      ...r,
      httpStatus: res.status,
      error: str(r.error) || t('err.status', { code: res.status }),
    }
    return refused
  } catch (err) {
    return { error: t('err.offline', { why: err instanceof Error ? err.message : String(err) }) }
  }
}

export function pathInfoOf(value: unknown): PathInfo | null {
  if (!isReply(value) || typeof value.raw !== 'string') return null
  return {
    raw: value.raw,
    path: str(value.path) ?? '',
    name: str(value.name) ?? '',
    exists: value.exists === true,
    dir: bool(value.dir),
    kind: str(value.kind),
    line: numOrNull(value.line),
  }
}

function entryOf(value: unknown): FolderEntry | null {
  if (!isReply(value) || typeof value.name !== 'string') return null
  return {
    name: value.name,
    dir: value.dir === true,
    size: numOrNull(value.size),
    mtime: numOrNull(value.mtime),
    kind: str(value.kind),
  }
}

const isRow = (v: unknown): v is string[] => Array.isArray(v) && v.every(c => typeof c === 'string')

/** A preview as the server sent it (adapters/files.ts preview), or a refusal's error. */
export function previewOf(value: unknown): Preview {
  const r = isReply(value) ? value : {}
  const entries = Array.isArray(r.entries) ? r.entries.map(entryOf).filter(e => e !== null) : undefined
  const rows = Array.isArray(r.rows) ? r.rows.filter(isRow) : undefined
  return {
    path: str(r.path),
    name: str(r.name),
    exists: bool(r.exists),
    dir: bool(r.dir),
    size: numOrNull(r.size),
    mtime: numOrNull(r.mtime),
    kind: str(r.kind),
    error: str(r.error),
    entries,
    total: num(r.total),
    text: str(r.text),
    truncated: bool(r.truncated),
    lines: num(r.lines),
    rows,
  }
}

export function changesOf(value: unknown): Changes {
  const r = isReply(value) ? value : {}
  return {
    available: r.available === true,
    root: str(r.root),
    branch: str(r.branch),
    status: str(r.status),
    diff: str(r.diff),
    truncated: bool(r.truncated),
    collectedAt: num(r.collectedAt),
  }
}

function hitOf(value: unknown): HistoryHit | null {
  if (!isReply(value) || typeof value.text !== 'string' || typeof value.excerpt !== 'string') return null
  return {
    session: str(value.session) ?? '',
    role: str(value.role) ?? '',
    text: value.text,
    excerpt: value.excerpt,
    date: str(value.date) ?? null,
    title: str(value.title) ?? '',
  }
}

export function historyOf(value: unknown): HistoryReply {
  const r = isReply(value) ? value : {}
  return {
    results: Array.isArray(r.results) ? r.results.map(hitOf).filter(h => h !== null) : undefined,
    unavailable: bool(r.unavailable),
    truncated: bool(r.truncated),
  }
}

/** The files API, its texts in the page's language. */
export function filesApi(t: () => Translator) {
  return {
    /** What the paths written in `cwd` are; nothing for those the server did not say. */
    async stat(cwd: string, paths: string[]): Promise<PathInfo[]> {
      const r = await filesPost('/api/fs/stat', { cwd, paths }, t())
      return list(r.items)
        .map(pathInfoOf)
        .filter(i => i !== null)
    },
    async preview(path: string): Promise<Preview> {
      return previewOf(await filesPost('/api/fs/preview', { path }, t()))
    },
    /** Opens with the system (`open`) or shows in its folder (`reveal`); the error, if any. */
    async open(path: string, how: 'open' | 'reveal'): Promise<string | null> {
      const r = await filesPost('/api/fs/open', { path, how }, t())
      return str(r.error) ?? null
    },
    /** A web link in the default browser: the refusal, if any. */
    async openUrl(url: string): Promise<{ error: string; httpStatus: number | undefined } | null> {
      const r = await filesPost('/api/open-url', { url }, t())
      const error = str(r.error)
      return error ? { error, httpStatus: num(r.httpStatus) } : null
    },
    /** A session checkout's changes; not available when it could not be read. */
    async changes(key: string): Promise<Changes> {
      const res = await fetch(`/api/session/${encodeURIComponent(key)}/changes`)
      return changesOf(await res.json())
    },
    /** The past sessions of a session's project that match `query`. */
    async history(key: string, query: string): Promise<HistoryReply> {
      const res = await fetch(`/api/session/${encodeURIComponent(key)}/history?q=${encodeURIComponent(query)}`)
      return res.ok ? historyOf(await res.json()) : { unavailable: true }
    },
  }
}

export type FilesApi = ReturnType<typeof filesApi>
