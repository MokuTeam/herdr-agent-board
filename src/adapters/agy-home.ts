// Read what Antigravity CLI (`agy`) records about a session:
//   - `<root>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
//   - `<root>/conversation_summaries.db` (titles, workspace paths, subagent children, history)
// Reads are bounded and cached by mtime and size; a missing or unreadable file or database
// degrades gracefully so the card and live terminal remain available.
import { Database } from 'bun:sqlite'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAgySession, parseAgyConversation, parseAgyTail } from '../core/agy.ts'
import { type Helper, type HelperDetail, type Helpers, publicHelper } from '../core/helpers.ts'
import { sameDir } from '../core/launch/names.ts'
import type { ConversationTurn } from '../core/transcript.ts'
import type { TranscriptInfo } from '../core/types.ts'
import { type HistoryHit, type HistoryResult, readTail, type SessionThread } from './claude-home.ts'

export interface AgyHome {
  readonly root: string
  transcriptPath(session: string | null): string | null
  hasConversation(session: string | null): boolean
  transcriptInfo(session: string | null): TranscriptInfo | null
  sessionThread(session: string, limit?: number): SessionThread
  sessionTitle(session: string | null): string
  sessionCwd(session: string | null): string
  /** Walk `parent_conversation_id` to the root conversation (handles herdr reporting a subagent UUID, #650). */
  rootSession(session: string | null): string | null
  /** Whether any descendant subagent of `session` is currently running (not killed). */
  hasRunningSubagent(session: string | null): boolean
  sessionHelpers(session: string | null): Helpers
  helperDetail(session: string | null, helperId: string): HelperDetail<ConversationTurn> | null
  searchHistory(cwd: string, query: string | null, excludeSession?: string | null): Promise<HistoryResult>
}

interface SummaryRow {
  conversation_id: string
  title: string
  preview: string
  step_count: number
  last_modified_time: string
  workspace_uris: string
  status: string
  agent_name: string
  parent_conversation_id: string
  killed: number
}

const CARD_WINDOWS = [256 << 10, 2 << 20]
const THREAD_WINDOWS = [2 << 20, 8 << 20]

const statOf = (file: string) => {
  try {
    return statSync(file, { throwIfNoEntry: false }) ?? null
  } catch {
    return null
  }
}

/** Parse the first local directory path from `workspace_uris` (JSON array of `file://` URIs). */
function firstWorkspacePath(urisJson: string): string {
  try {
    const parsed: unknown = JSON.parse(urisJson)
    if (!Array.isArray(parsed)) return ''
    for (const entry of parsed) {
      if (typeof entry !== 'string' || !entry) continue
      if (entry.startsWith('file://')) {
        try {
          return fileURLToPath(entry)
        } catch {
          return entry.replace(/^file:\/\//, '')
        }
      }
      return entry
    }
  } catch {}
  return ''
}

function parseTimestamp(value: string): number {
  if (!value) return 0
  // SQLite datetime strings from Go may look like "2026-11-23 12:44:48.836971815+00:00".
  const iso = value.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')
  return Date.parse(iso) || 0
}

export function defaultAgyRoot(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env.ANTIGRAVITY_APP_DATA_DIR || join(home, '.gemini', 'antigravity-cli')
}

export function createAgyHome(root = defaultAgyRoot()): AgyHome {
  const tailCache = new Map<string, { mtimeMs: number; size: number; info: TranscriptInfo }>()
  let dbStamp = ''
  const summaries = new Map<string, SummaryRow>()
  const childrenByParent = new Map<string, SummaryRow[]>()

  function transcriptFile(session: string): string {
    return join(root, 'brain', session, '.system_generated', 'logs', 'transcript.jsonl')
  }

  function transcriptPath(session: string | null): string | null {
    if (!session || !isAgySession(session)) return null
    const file = transcriptFile(session)
    if (statOf(file)?.isFile()) return file
    const lower = session.toLowerCase()
    if (lower !== session) {
      const lowFile = transcriptFile(lower)
      if (statOf(lowFile)?.isFile()) return lowFile
    }
    return null
  }

  function hasConversation(session: string | null): boolean {
    if (!session || !isAgySession(session)) return false
    if (transcriptPath(session)) return true
    if (statOf(join(root, 'conversations', `${session}.db`))?.isFile()) return true
    const lower = session.toLowerCase()
    return lower !== session && statOf(join(root, 'conversations', `${lower}.db`))?.isFile() === true
  }

  /** Reload `conversation_summaries.db` into memory only when the DB or its WAL file changes. */
  function refreshSummaries(): void {
    const dbPath = join(root, 'conversation_summaries.db')
    const mainSt = statOf(dbPath)
    if (!mainSt?.isFile()) {
      if (dbStamp) {
        dbStamp = ''
        summaries.clear()
        childrenByParent.clear()
      }
      return
    }
    const walSt = statOf(`${dbPath}-wal`)
    const stamp = `${mainSt.mtimeMs}:${mainSt.size}|${walSt?.mtimeMs ?? 0}:${walSt?.size ?? 0}`
    if (stamp === dbStamp) return
    let db: Database | null = null
    try {
      db = new Database(dbPath, { readonly: true })
      const rows = db
        .query(
          `SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris,
                  status, agent_name, parent_conversation_id, killed
             FROM conversation_summaries`,
        )
        .all() as SummaryRow[]
      summaries.clear()
      childrenByParent.clear()
      for (const row of rows) {
        const id = row.conversation_id.toLowerCase()
        summaries.set(id, row)
        const parent = (row.parent_conversation_id ?? '').trim().toLowerCase()
        if (parent) {
          const list = childrenByParent.get(parent) ?? []
          list.push(row)
          childrenByParent.set(parent, list)
        }
      }
      dbStamp = stamp
    } catch {
      // Locked, migrating, or unexpected schema: keep the previous cache or empty map.
    } finally {
      try {
        db?.close(false)
      } catch {}
    }
  }

  function summaryOf(session: string | null): SummaryRow | undefined {
    if (!session || !isAgySession(session)) return undefined
    refreshSummaries()
    return summaries.get(session.toLowerCase())
  }

  function sessionTitle(session: string | null): string {
    const row = summaryOf(session)
    return (row?.title || row?.preview || '').trim()
  }

  function sessionCwd(session: string | null): string {
    const row = summaryOf(session)
    return row ? firstWorkspacePath(row.workspace_uris) : ''
  }

  function rootSession(session: string | null): string | null {
    if (!session || !isAgySession(session)) return null
    refreshSummaries()
    let cur = summaries.get(session.toLowerCase())
    if (!cur) return session
    const seen = new Set<string>([cur.conversation_id.toLowerCase()])
    while (cur.parent_conversation_id) {
      const rawParent = cur.parent_conversation_id.trim()
      if (!rawParent || !isAgySession(rawParent)) break
      const parentId = rawParent.toLowerCase()
      if (seen.has(parentId)) break
      seen.add(parentId)
      const parent = summaries.get(parentId)
      if (!parent) return rawParent
      cur = parent
    }
    return cur.conversation_id
  }

  function hasRunningSubagent(session: string | null): boolean {
    if (!session || !isAgySession(session)) return false
    refreshSummaries()
    const rootId = session.toLowerCase()
    const seen = new Set<string>([rootId])
    const queue = [...(childrenByParent.get(rootId) ?? [])]
    while (queue.length) {
      const row = queue.shift() as SummaryRow
      const id = row.conversation_id.toLowerCase()
      if (seen.has(id)) continue
      seen.add(id)
      if (!row.killed && row.status === 'CASCADE_RUN_STATUS_RUNNING') return true
      const kids = childrenByParent.get(id)
      if (kids?.length) queue.push(...kids)
    }
    return false
  }

  function readTailInfo(file: string, st: { mtimeMs: number; size: number }): TranscriptInfo {
    const hit = tailCache.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info
    let info: TranscriptInfo = {}
    for (const bytes of CARD_WINDOWS) {
      info = parseAgyTail(readTail(file, st.size, bytes).split('\n'))
      if ((info.prompt && info.lastText) || bytes >= st.size) break
    }
    if (!info.prompt && hit?.info.prompt && st.size >= hit.size) info.prompt = hit.info.prompt
    info.activity = st.mtimeMs
    tailCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info })
    return info
  }

  function transcriptInfo(session: string | null): TranscriptInfo | null {
    if (!session || !isAgySession(session)) return null
    const file = transcriptFile(session)
    const st = statOf(file)
    const title = sessionTitle(session)
    if (!st?.isFile()) {
      if (!title) return null
      const row = summaryOf(session)
      const activity = row ? parseTimestamp(row.last_modified_time) : 0
      return {
        title,
        prompt: '',
        lastText: '',
        question: '',
        replied: false,
        tool: null,
        ...(activity && { activity }),
      }
    }
    try {
      const info = readTailInfo(file, st)
      return title && !info.title ? { ...info, title } : info
    } catch {
      return null
    }
  }

  function sessionThread(session: string, limit = 40): SessionThread {
    if (!session || !isAgySession(session)) return { conversation: [], queued: [] }
    const file = transcriptFile(session)
    const st = statOf(file)
    if (!st?.isFile()) return { conversation: [], queued: [] }
    try {
      let conversation = parseAgyConversation([], limit)
      for (const bytes of THREAD_WINDOWS) {
        conversation = parseAgyConversation(readTail(file, st.size, bytes).split('\n'), limit)
        if (conversation.filter(t => t.role !== 'tool').length >= limit / 3 || bytes >= st.size) break
      }
      return { conversation, queued: [] }
    } catch {
      return { conversation: [], queued: [] }
    }
  }

  function sessionHelpers(session: string | null): Helpers {
    if (!session || !isAgySession(session)) return { helpers: [], workflows: [] }
    refreshSummaries()
    const kids = childrenByParent.get(session.toLowerCase()) ?? []
    if (!kids.length) return { helpers: [], workflows: [] }
    const helpers: Helper[] = kids.map(row => {
      const path = transcriptFile(row.conversation_id)
      const st = statOf(path)
      const tail = st?.isFile() ? readTailInfo(path, st) : null
      const status = row.killed ? 'stopped' : row.status === 'CASCADE_RUN_STATUS_RUNNING' ? 'running' : 'done'
      const activity = st?.mtimeMs ?? parseTimestamp(row.last_modified_time)
      return {
        id: row.conversation_id,
        kind: 'agent',
        type: row.agent_name || 'subagent',
        name: row.agent_name || '',
        description: (row.title || row.preview || '').trim(),
        color: '',
        model: tail?.model ?? '',
        background: true,
        parent: null,
        toolUseId: null,
        workflow: null,
        phase: '',
        status,
        startedAt: activity || null,
        endedAt: activity || null,
        activity,
        prompt: tail?.prompt ?? '',
        from: '',
        now:
          status === 'running' && tail?.tool
            ? { name: tail.tool.name, label: tail.tool.label ?? tail.tool.name, detail: tail.tool.detail ?? '' }
            : null,
        after: '',
        waiting: 0,
        tokens: tail?.context ?? null,
        result: status === 'done' ? (tail?.lastText ?? '') : '',
        path: st?.isFile() ? path : '',
      }
    })
    helpers.sort((a, b) => b.activity - a.activity)
    return { helpers, workflows: [] }
  }

  function helperDetail(session: string | null, helperId: string): HelperDetail<ConversationTurn> | null {
    const { helpers } = sessionHelpers(session)
    const h = helpers.find(x => x.id.toLowerCase() === helperId.toLowerCase())
    if (!h) return null
    const conversation = h.path ? sessionThread(h.id, 80).conversation : []
    const tools = conversation.filter(t => t.role === 'tool').length
    return {
      helper: { ...publicHelper(h), tools, prompt: h.prompt },
      workflow: null,
      conversation,
    }
  }

  async function searchHistory(
    cwd: string,
    query: string | null,
    excludeSession?: string | null,
  ): Promise<HistoryResult> {
    const needle = String(query ?? '')
      .trim()
      .toLowerCase()
    if (!needle) return { results: [] }
    refreshSummaries()
    const exclude = (excludeSession ?? '').toLowerCase()
    const results: HistoryHit[] = []
    let scanned = 0
    const ordered = [...summaries.values()].sort(
      (a, b) => parseTimestamp(b.last_modified_time) - parseTimestamp(a.last_modified_time),
    )
    for (const row of ordered) {
      if (results.length >= 40) break
      if (row.conversation_id.toLowerCase() === exclude) continue
      if (row.parent_conversation_id) continue
      const rowCwd = firstWorkspacePath(row.workspace_uris)
      if (cwd && rowCwd && !sameDir(cwd, rowCwd)) continue
      scanned++
      const { conversation } = sessionThread(row.conversation_id, 60)
      for (const turn of conversation) {
        if (turn.role !== 'user' && turn.role !== 'assistant') continue
        const idx = turn.text.toLowerCase().indexOf(needle)
        if (idx < 0) continue
        const from = Math.max(0, idx - 80)
        const excerpt = turn.text
          .slice(from, Math.min(turn.text.length, idx + needle.length + 120))
          .replace(/\s+/g, ' ')
          .trim()
        results.push({
          session: row.conversation_id,
          role: turn.role,
          text: turn.text.slice(0, 400),
          excerpt,
          date: row.last_modified_time || null,
          source: 'agy',
          byteOffset: 0,
          title: (row.title || row.preview || '').trim(),
        })
        if (results.length >= 40) break
      }
    }
    return { results, scanned }
  }

  return {
    root,
    transcriptPath,
    hasConversation,
    transcriptInfo,
    sessionThread,
    sessionTitle,
    sessionCwd,
    rootSession,
    hasRunningSubagent,
    sessionHelpers,
    helperDetail,
    searchHistory,
  }
}
