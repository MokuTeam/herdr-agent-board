// What Claude Code itself records under one config folder (~/.claude today), read without
// spending a token: the registry of running sessions (sessions/<pid>.json: name, sessionId,
// status), the transcripts (projects/<folder>/<id>.jsonl, where Claude keeps the session's
// ai-title and the user's last prompt) and the usagebar cache (herdr-usagebar/).
// Everything the board reads from Claude goes through one ClaudeHome built from a root folder,
// so several Claude profiles are several homes and nothing else changes.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, type Stats, statSync } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { onLanguage } from '../core/lang.ts'
import { normDir, sameDir } from '../core/launch/names.ts'
import { type Limits, parseLimits } from '../core/limits.ts'
import {
  type ConversationOptions,
  type ConversationTurn,
  parseConversation,
  parseTranscriptTail,
  saidIn,
  tailComplete,
} from '../core/transcript.ts'
import type { TranscriptInfo } from '../core/types.ts'
import { SLOW, statOf } from './folders.ts'

/** A running interactive session as Claude's registry file records it (more fields may exist). */
export interface LiveSession {
  sessionId: string
  kind: string
  pid: number
  name?: string
  cwd?: string
  status?: string
  [extra: string]: unknown
}

export interface HistoryHit {
  session: string
  role: string
  text: string
  excerpt: string
  date: string | null
  source: string
  byteOffset: number
  title: string
}

export interface HistoryResult {
  results: HistoryHit[]
  invalid?: boolean
  unavailable?: boolean
  truncated?: boolean
  scanned?: number
  bytesRead?: number
}

export interface LocalUsage {
  context: { available: boolean; observedAt: number | null; source: string | null }
  limits: Limits
}

export interface ClaudeHome {
  readonly root: string // ~/.claude today; one per profile later
  liveSessions(): Map<string, LiveSession>
  transcriptPath(sessionId: string, cwd: string): string | null
  transcriptInfo(path: string | null): TranscriptInfo | null
  conversation(path: string, limit?: number, opts?: ConversationOptions): ConversationTurn[]
  searchHistory(cwd: string, query: string | null, excludeSession?: string | null): Promise<HistoryResult>
  recentFolders(limit?: number): Promise<string[]>
  localUsage(now?: number): LocalUsage
}

const errorCode = (err: unknown): unknown => (err && typeof err === 'object' && 'code' in err ? err.code : undefined)

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errorCode(err) === 'EPERM'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'

function asLiveSession(value: unknown): LiveSession | null {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || !value.sessionId) return null
  if (value.kind !== 'interactive' || typeof value.pid !== 'number') return null
  return value as LiveSession
}

/** The last `bytes` of a file of `size` bytes, from the first whole line on. */
export function readTail(path: string, size: number, bytes: number): string {
  const start = Math.max(0, size - bytes)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, buf.length, start)
  } finally {
    closeSync(fd)
  }
  const text = buf.toString('utf8')
  return start ? text.slice(text.indexOf('\n') + 1) : text
}

/**
 * A usage file: the usagebar cache, or the board's own status-line copy of it per profile, which
 * has the same shape. Never reads auth, settings, ~/.claude.json, keychains or provider APIs, and
 * never writes a cache.
 */
export function readUsageFile(file: string, now = Date.now()): LocalUsage {
  const context = { available: false, observedAt: null, source: null }
  try {
    const st = lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || st.size > 65536) return { context, limits: parseLimits(null, now) }
    return { context, limits: parseLimits(JSON.parse(readFileSync(file, 'utf8')), now) }
  } catch {
    return { context, limits: parseLimits(null, now) }
  }
}

/** The usagebar cache (claude-limits-latest.json) in a folder (readUsageFile). */
export function readUsageCache(directory: string, now = Date.now()): LocalUsage {
  return readUsageFile(join(directory, 'claude-limits-latest.json'), now)
}

/**
 * The last `limit` turns of a transcript for the detail view (see parseConversation); `sidechain`
 * for a helper's own (adapters/helpers.ts).
 */
export function readConversation(path: string, limit = 40, opts: ConversationOptions = {}): ConversationTurn[] {
  const st = path && statSync(path, { throwIfNoEntry: false })
  if (!st) return []
  // Screenshots and big tool results can fill megabytes: read further back when the window held few turns.
  let items: ConversationTurn[] = []
  for (const bytes of [2 << 20, 8 << 20]) {
    items = parseConversation(readTail(path, st.size, bytes).split('\n'), Number.POSITIVE_INFINITY, opts)
    if (items.filter(i => i.role !== 'tool').length >= limit / 3 || bytes >= st.size) break
  }
  return items.slice(-limit)
}

/** Folder name Claude gives a project: the cwd without trailing slashes, non-alphanumerics as dashes. */
const projectFolder = (cwd: string): string => cwd.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-')

/** The folder a Claude session started in, from its transcript (its first "cwd"); null when it cannot be read. */
export async function cwdOf(file: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(file, 'r')
    const buf = Buffer.alloc(32 << 10)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.subarray(0, bytesRead).toString('utf8'))
    const cwd: unknown = m?.[1] ? JSON.parse(m[1]) : null
    return typeof cwd === 'string' ? cwd : null
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}

const normCwd = (s: string): string =>
  /^[a-z]:/i.test(s) ? s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : s.replace(/\/+$/, '')

export function createClaudeHome(root: string): ClaudeHome {
  const sessionsDir = join(root, 'sessions')
  const projects = join(root, 'projects')
  const pathCache = new Map<string, string>() // session id -> transcript path
  const missCache = new Map<string, number>() // session id -> when a full search found nothing (retried after a minute)
  const tailCache = new Map<string, { mtimeMs: number; size: number; info: TranscriptInfo }>()
  onLanguage(() => tailCache.clear()) // tool details are in the board's language
  let recentCache: { at: number; list: string[] } = { at: 0, list: [] }

  function liveSessions(): Map<string, LiveSession> {
    const byId = new Map<string, LiveSession>()
    let files: string[]
    try {
      files = readdirSync(sessionsDir)
    } catch {
      return byId
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const s = asLiveSession(JSON.parse(readFileSync(join(sessionsDir, file), 'utf8')))
        if (s && alive(s.pid)) byId.set(s.sessionId, s)
      } catch {}
    }
    return byId
  }

  /** The transcript of a session: projects/<cwd with non-alphanumerics as dashes>/<id>.jsonl. */
  function transcriptPath(sessionId: string, cwd: string): string | null {
    const cached = pathCache.get(sessionId)
    if (cached && statSync(cached, { throwIfNoEntry: false })) return cached
    let found: string | null = null
    if (cwd) {
      const guess = join(projects, projectFolder(cwd), `${sessionId}.jsonl`)
      if (statSync(guess, { throwIfNoEntry: false })) found = guess
    }
    if (!found && Date.now() - (missCache.get(sessionId) ?? 0) > 60_000) {
      missCache.set(sessionId, Date.now())
      try {
        for (const entry of readdirSync(projects, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const p = join(projects, entry.name, `${sessionId}.jsonl`)
          if (statSync(p, { throwIfNoEntry: false })) {
            found = p
            break
          }
        }
      } catch {}
    }
    if (found) pathCache.set(sessionId, found)
    return found
  }

  /**
   * What the end of a transcript says (title, prompt, lastText, tool: see parseTranscriptTail),
   * cached until the file changes.
   */
  function transcriptInfo(path: string | null): TranscriptInfo | null {
    if (!path) return null
    const st = statSync(path, { throwIfNoEntry: false })
    if (!st) return null
    const cached = tailCache.get(path)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.info
    let info: TranscriptInfo = {}
    // Big tool results can push everything far back: widen the window once.
    for (const bytes of [256 << 10, 2 << 20]) {
      info = parseTranscriptTail(readTail(path, st.size, bytes).split('\n'))
      if (tailComplete(info) || bytes >= st.size) break
    }
    info.activity = st.mtimeMs
    tailCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, info })
    return info
  }

  /** Explicit local search in a single Claude project. Never scans sibling projects. */
  async function searchHistory(
    cwd: string,
    rawQuery: string | null,
    excludeSession: string | null = null,
  ): Promise<HistoryResult> {
    const query = String(rawQuery ?? '').trim()
    if (!cwd || query.length < 2 || query.length > 100) return { results: [], invalid: true }
    const encoded = projectFolder(cwd)
    const results: HistoryHit[] = []
    let truncated = false
    let bytesRead = 0
    let scanned = 0
    try {
      const base = await realpath(projects)
      const dir = await realpath(join(projects, encoded))
      const rel = relative(base, dir)
      if (rel.startsWith('..') || isAbsolute(rel)) return { results, unavailable: true }
      const entries = await readdir(dir, { withFileTypes: true })
      const files: { name: string; stat: Stats }[] = []
      for (const entry of entries.slice(0, 2000)) {
        if (entry.name !== `${excludeSession}.jsonl` && entry.isFile() && /^[A-Za-z0-9_-]+\.jsonl$/.test(entry.name))
          files.push({ name: entry.name, stat: await lstat(join(dir, entry.name)) })
      }
      files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      truncated = files.length > 200 || entries.length > 2000
      for (const { name, stat: st } of files.slice(0, 200)) {
        if (!st.isFile() || st.isSymbolicLink()) continue
        const length = Math.min(st.size, 1 << 20, (8 << 20) - bytesRead)
        if (length <= 0) {
          truncated = true
          break
        }
        const start = Math.max(0, st.size - length)
        const handle = await open(join(dir, name), 'r')
        let buffer: Buffer
        try {
          buffer = Buffer.alloc(length)
          const read = await handle.read(buffer, 0, length, start)
          buffer = buffer.subarray(0, read.bytesRead)
        } finally {
          await handle.close()
        }
        bytesRead += buffer.length
        scanned++
        if (start) truncated = true
        let offset = start
        for (const [index, line] of buffer.toString('utf8').split('\n').entries()) {
          const byteOffset = offset
          offset += Buffer.byteLength(line) + 1
          if (start && index === 0) continue
          try {
            const row: unknown = JSON.parse(line)
            if (!isRecord(row)) continue
            if (row.isSidechain || row.isMeta || typeof row.cwd !== 'string' || normCwd(row.cwd) !== normCwd(cwd))
              continue
            if (row.type !== 'user' && row.type !== 'assistant') continue
            const content = isRecord(row.message) ? row.message.content : undefined
            const text =
              typeof content === 'string'
                ? content
                : Array.isArray(content)
                  ? content
                      .map(b => saidIn(row, b))
                      .filter(Boolean)
                      .join('\n')
                  : ''
            const at = text.toLowerCase().indexOf(query.toLowerCase())
            if (at < 0) continue
            const date = Date.parse(String(row.timestamp))
            results.push({
              session: name.slice(0, -6),
              role: row.type,
              text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
              excerpt: text.slice(Math.max(0, at - 100), at + query.length + 180),
              date: Number.isFinite(date) ? new Date(date).toISOString() : null,
              source: `${encoded}/${name}`,
              byteOffset,
              title: '',
            })
            if (results.length === 30) {
              truncated = true
              break
            }
          } catch {}
        }
        if (results.length === 30 || bytesRead >= 8 << 20) {
          truncated = true
          break
        }
      }
      // What the quick look shows with a hit: the session's own title, who said it, the whole message.
      for (const r of results) r.title = transcriptInfo(join(dir, `${r.session}.jsonl`))?.title ?? ''
      return { results, truncated, scanned, bytesRead }
    } catch {
      return { results: [], unavailable: true, truncated }
    }
  }

  /**
   * Folders recent Claude sessions on this machine ran in, newest first: the cwd in the newest
   * transcript of each project. Read from the head of the file only, cached for a minute.
   */
  async function recentFolders(limit = 12): Promise<string[]> {
    if (Date.now() - recentCache.at < 60_000) return recentCache.list
    const found: string[] = []
    try {
      const mtime = async (p: string): Promise<number> => (await stat(p).catch(() => null))?.mtimeMs ?? 0
      const all = (await readdir(projects, { withFileTypes: true })).filter(d => d.isDirectory())
      const dirs = (
        await Promise.all(all.map(async d => ({ dir: join(projects, d.name), m: await mtime(join(projects, d.name)) })))
      )
        .sort((a, b) => b.m - a.m)
        .slice(0, 40)
      const temp = normDir(tmpdir())
      const cwds = await Promise.all(
        dirs.map(async ({ dir }) => {
          const files = (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.jsonl'))
          const newest = (await Promise.all(files.map(async f => ({ f, m: await mtime(join(dir, f)) })))).sort(
            (a, b) => b.m - a.m,
          )[0]
          return newest ? cwdOf(join(dir, newest.f)) : null
        }),
      )
      for (const cwd of cwds) {
        if (!cwd || normDir(cwd).startsWith(temp) || found.some(f => sameDir(f, cwd))) continue
        const st = await statOf(cwd, 500)
        if (st && st !== SLOW && st.isDirectory()) found.push(cwd)
        if (found.length >= limit) break
      }
    } catch {}
    recentCache = { at: Date.now(), list: found }
    return found
  }

  return {
    root,
    liveSessions,
    transcriptPath,
    transcriptInfo,
    conversation: readConversation,
    searchHistory,
    recentFolders,
    localUsage: (now = Date.now()) => readUsageCache(join(root, 'herdr-usagebar'), now),
  }
}

let defaultHome: ClaudeHome | undefined
/** The one home for this process: Claude Code's own folder. */
export function defaultClaudeHome(): ClaudeHome {
  defaultHome ??= createClaudeHome(join(homedir(), '.claude'))
  return defaultHome
}
