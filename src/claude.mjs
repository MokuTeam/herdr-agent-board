// What Claude Code itself records, read without spending a token: the registry of running
// sessions (~/.claude/sessions/<pid>.json: name, sessionId, status) and the tail of each
// transcript, where Claude keeps the session's ai-title and the user's last prompt.
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { onLanguage } from './core/lang.ts'
import { parseConversation, parseTranscriptTail, tailComplete } from './core/transcript.ts'
import { CLAUDE_DIR } from './paths.mjs'

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** Running interactive sessions by session id. */
export function liveSessions(dir = join(CLAUDE_DIR, 'sessions')) {
  const byId = new Map()
  let files = []
  try {
    files = readdirSync(dir)
  } catch {
    return byId
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const s = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      if (s.sessionId && s.kind === 'interactive' && alive(s.pid)) byId.set(s.sessionId, s)
    } catch {}
  }
  return byId
}

const pathCache = new Map() // session id -> transcript path
const missCache = new Map() // session id -> when a full search found nothing (retried after a minute)

/** The transcript of a session: projects/<cwd with non-alphanumerics as dashes>/<id>.jsonl. */
export function transcriptPath(sessionId, cwd, projects = join(CLAUDE_DIR, 'projects')) {
  const cached = pathCache.get(sessionId)
  if (cached && statSync(cached, { throwIfNoEntry: false })) return cached
  let found = null
  if (cwd) {
    const guess = join(projects, cwd.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
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

function readTail(path, size, bytes) {
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

const tailCache = new Map() // path -> { mtimeMs, size, info }
onLanguage(() => tailCache.clear()) // tool details are in the board's language

/**
 * What the end of a transcript says (title, prompt, lastText, tool: see parseTranscriptTail),
 * cached until the file changes.
 */
export function transcriptInfo(path) {
  if (!path) return null
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st) return null
  const cached = tailCache.get(path)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.info
  let info
  // Big tool results can push everything far back: widen the window once.
  for (const bytes of [256 << 10, 2 << 20]) {
    info = parseTranscriptTail(readTail(path, st.size, bytes).split('\n'))
    if (tailComplete(info) || bytes >= st.size) break
  }
  info.activity = st.mtimeMs
  tailCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, info })
  return info
}

/** The last `limit` turns of a session for the detail view (see parseConversation). */
export function conversation(path, limit = 40) {
  const st = path && statSync(path, { throwIfNoEntry: false })
  if (!st) return []
  // Screenshots and big tool results can fill megabytes: read further back when the window held few turns.
  let items = []
  for (const bytes of [2 << 20, 8 << 20]) {
    items = parseConversation(readTail(path, st.size, bytes).split('\n'), Infinity)
    if (items.filter(i => i.role !== 'tool').length >= limit / 3 || bytes >= st.size) break
  }
  return items.slice(-limit)
}
