// What pi records about a session, read without spending a token: its session file, which herdr
// reports as the pane's agent_session (core/pi.ts reads the lines). The end of it for a card,
// cached by the file's size and time; the last turns for the session's sheet. pi writes the file
// only once the session has something in it, so a file that is not there yet is an empty session.
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type PiInfo, parsePiConversation, parsePiTail } from '../core/pi.ts'
import { readTail, type SessionThread } from './claude-home.ts'

export interface PiHome {
  /** What the end of the session file says (core/pi.ts parsePiTail); null when there is no file. */
  transcriptInfo(file: string | null): PiInfo | null
  /** The session's last `limit` turns; pi keeps no queue the board can read. */
  sessionThread(file: string, limit?: number): SessionThread
}

const statOf = (file: string) => {
  try {
    return statSync(file, { throwIfNoEntry: false }) ?? null
  } catch {
    return null
  }
}

export function createPiHome(): PiHome {
  const tailCache = new Map<string, { mtimeMs: number; size: number; info: PiInfo }>()

  function transcriptInfo(file: string | null): PiInfo | null {
    if (!file) return null
    const st = statOf(file)
    if (!st?.isFile()) return null
    const cached = tailCache.get(file)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.info
    let info: PiInfo = {}
    // Big tool results can push everything far back: widen the window once.
    for (const bytes of [256 << 10, 2 << 20]) {
      info = parsePiTail(readTail(file, st.size, bytes).split('\n'))
      if ((info.prompt && info.lastText) || bytes >= st.size) break
    }
    info.activity = st.mtimeMs
    tailCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info })
    return info
  }

  function sessionThread(file: string, limit = 40): SessionThread {
    const st = statOf(file)
    if (!st?.isFile()) return { conversation: [], queued: [] }
    let conversation = parsePiConversation([], limit)
    for (const bytes of [2 << 20, 8 << 20]) {
      conversation = parsePiConversation(readTail(file, st.size, bytes).split('\n'), limit)
      if (conversation.filter(i => i.role !== 'tool').length >= limit / 3 || bytes >= st.size) break
    }
    return { conversation, queued: [] }
  }

  return { transcriptInfo, sessionThread }
}

/**
 * A pi session's file by its id (`<time>_<id>.jsonl`) in pi's session folders: the one
 * PI_CODING_AGENT_SESSION_DIR names, and `sessions` in pi's own folder (PI_CODING_AGENT_DIR, else
 * ~/.pi/agent), each with a folder per project in it; null when none has it (#178).
 */
export function findPiSession(id: string, env: Record<string, string | undefined> = process.env): string | null {
  const roots = [
    env.PI_CODING_AGENT_SESSION_DIR,
    join(env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'sessions'),
  ]
  const end = `_${id}.jsonl`.toLowerCase()
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
  }
  for (const root of roots) {
    if (!root) continue
    for (const e of list(root)) {
      if (e.isFile() && e.name.toLowerCase().endsWith(end)) return join(root, e.name)
      if (!e.isDirectory()) continue
      const hit = list(join(root, e.name)).find(f => f.isFile() && f.name.toLowerCase().endsWith(end))
      if (hit) return join(root, e.name, hit.name)
    }
  }
  return null
}
