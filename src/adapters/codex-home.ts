// Find a Codex rollout by the session id herdr reports. Discovery is shared across cards;
// transcript reads are bounded and cached by size and mtime, as for pi.
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isCodexSession, parseCodexConversation, parseCodexTail } from '../core/codex.ts'
import { modelProblem } from '../core/launch/model.ts'
import type { TranscriptInfo } from '../core/types.ts'
import { cwdOf as readCwd, readTail, type SessionThread } from './claude-home.ts'
import { readConfigFile } from './config-file.ts'
import { isRecord } from './json-store.ts'

export interface CodexHome {
  /** The folder in the rollout header, rather than the enclosing shell's folder. */
  cwdOf(session: string): Promise<string | null>
  /** Path to the rollout file for `session`, or null when not found. */
  transcriptPath(session: string | null): string | null
  transcriptInfo(session: string | null): TranscriptInfo | null
  sessionThread(session: string, limit?: number): SessionThread
}

const DISCOVERY_MS = 1000
const CARD_WINDOWS = [256 << 10, 2 << 20]
const THREAD_WINDOWS = [2 << 20, 8 << 20]

const codexRoot = (): string => process.env.CODEX_HOME || join(homedir(), '.codex')

/**
 * Where rollouts are looked for: the folder Codex uses here, then the dedicated one for sessions
 * herdr runs (config.json `codexHome`, written by install.ts --codex-home). Without that key the
 * list is the one folder it always was.
 */
function codexRoots(first: string): string[] {
  const dedicated = dedicatedCodexHome()
  return dedicated && dedicated !== first ? [first, dedicated] : [first]
}

/** The dedicated CODEX_HOME for sessions herdr runs (config.json `codexHome`); null when none is set. */
export function dedicatedCodexHome(): string | null {
  const dedicated = readConfigFile()?.codexHome
  return typeof dedicated === 'string' && dedicated ? dedicated : null
}

export async function cachedCodexModels(root = codexRoot()): Promise<Record<string, string[]>> {
  try {
    const cache: unknown = await Bun.file(join(root, 'models_cache.json')).json()
    if (!isRecord(cache) || !Array.isArray(cache.models)) return {}
    return Object.fromEntries(
      cache.models.flatMap(model => {
        if (
          !isRecord(model) ||
          model.visibility !== 'list' ||
          typeof model.slug !== 'string' ||
          modelProblem(model.slug)
        )
          return []
        const levels: unknown[] = Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels
          : []
        return [
          [
            model.slug,
            [
              ...new Set(
                levels.flatMap(level =>
                  isRecord(level) && typeof level.effort === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level.effort)
                    ? [level.effort]
                    : [],
                ),
              ),
            ],
          ],
        ]
      }),
    )
  } catch {
    return {}
  }
}

export function createCodexHome(root = codexRoot()): CodexHome {
  const files = new Map<string, string>()
  const cache = new Map<string, { mtimeMs: number; size: number; info: TranscriptInfo }>()
  let scannedAt = -Infinity

  function discover(dir: string, depth = 0): void {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && depth < 3 && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
        try {
          discover(join(dir, entry.name), depth + 1)
        } catch {} // An unreadable date folder does not hide the others.
      } else if (depth === 3 && entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        const id = entry.name.slice(-42, -6)
        if (isCodexSession(id)) files.set(id.toLowerCase(), join(dir, entry.name))
      }
    }
  }

  function locate(session: string | null) {
    if (!session || !isCodexSession(session)) return null
    const id = session.toLowerCase()
    try {
      let file = files.get(id)
      let st = file ? statSync(file, { throwIfNoEntry: false }) : null
      if (!st?.isFile() && Date.now() - scannedAt >= DISCOVERY_MS) {
        scannedAt = Date.now()
        files.clear()
        for (const base of codexRoots(root))
          try {
            discover(join(base, 'sessions'))
          } catch {} // A folder that is not there hides no other.
        file = files.get(id)
        st = file ? statSync(file, { throwIfNoEntry: false }) : null
      }
      return file && st?.isFile() ? { file, st } : null
    } catch {
      return null // A removed or unreadable rollout leaves a bare card.
    }
  }

  function transcriptInfo(session: string | null): TranscriptInfo | null {
    const found = locate(session)
    if (!found) return null
    const { file, st } = found
    const hit = cache.get(file)
    if (hit?.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info
    try {
      let info: TranscriptInfo = {}
      for (const bytes of CARD_WINDOWS) {
        info = parseCodexTail(readTail(file, st.size, bytes).split('\n'))
        if ((info.prompt && info.lastText) || bytes >= st.size) break
      }
      // A long tool result can move the last user turn outside the bounded tail.
      if (!info.prompt && hit?.info.prompt && st.size >= hit.size) info.prompt = hit.info.prompt
      info.activity = st.mtimeMs
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info })
      return info
    } catch {
      return null
    }
  }

  function sessionThread(session: string, limit = 40): SessionThread {
    const found = locate(session)
    if (!found) return { conversation: [], queued: [] }
    const { file, st } = found
    try {
      let conversation = parseCodexConversation([], limit)
      for (const bytes of THREAD_WINDOWS) {
        conversation = parseCodexConversation(readTail(file, st.size, bytes).split('\n'), limit)
        if (conversation.filter(t => t.role !== 'tool').length >= limit / 3 || bytes >= st.size) break
      }
      return { conversation, queued: [] }
    } catch {
      return { conversation: [], queued: [] }
    }
  }

  return {
    transcriptPath: session => locate(session)?.file ?? null,
    transcriptInfo,
    sessionThread,
    async cwdOf(session) {
      const found = locate(session)
      return found ? readCwd(found.file) : null
    },
  }
}
