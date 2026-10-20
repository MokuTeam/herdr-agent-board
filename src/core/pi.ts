// pi (https://pi.dev), the agent the board knows besides Claude Code. herdr reports a pi pane's
// session by its file (`~/.pi/agent/sessions/--<cwd>--/<time>_<id>.jsonl`), which is the
// session's key on the board. Here, without a file read: whether a key is such a file, the id in
// its name, what the end of the file says for a card (its name, the user's last prompt, the
// agent's last words, the last tool call, the context) and the last turns for the session's
// sheet. Pure: the file reading lives with the adapter (adapters/pi-home.ts).
//
// A pi session file is a tree: each entry names its parent, and the session goes on from the
// last entry written. Only the entries on the way from it back to the root are the session as it
// is now; a branch left behind with /tree is not read.
import { posix, win32 } from 'node:path'
import { boardNotice } from './notices.ts'
import { type ConversationTurn, cleanPrompt, type ToolTurn, toolLabel, trailingQuestion } from './transcript.ts'
import type { ToolCall, TranscriptInfo } from './types.ts'

export const PI_AGENT = 'pi'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const firstLine = (s: unknown): string =>
  String(s ?? '')
    .split('\n')
    .find(l => l.trim())
    ?.trim() ?? ''
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const baseName = (p: unknown): string =>
  String(p ?? '')
    .split(/[\\/]/)
    .pop() ?? ''

function parse(line: string): Rec | null {
  try {
    return rec(JSON.parse(line))
  } catch {
    return null
  }
}

/** Whether a session key is a pi session's file (absolute, `.jsonl`), as herdr reports it. */
export function isPiSessionFile(key: unknown): key is string {
  const s = str(key)
  return /\.jsonl$/i.test(s) && (posix.isAbsolute(s) || win32.isAbsolute(s))
}

/** The session id in a pi session file's name (`<time>_<id>.jsonl`); '' when the name has none. */
export function piSessionId(file: unknown): string {
  return /_([^_\\/]+)\.jsonl$/i.exec(str(file))?.[1] ?? ''
}

/** Whether a board item is a pi session the board can read: herdr says pi, and its key is the file. */
export const isPiItem = (item: { agent?: string | undefined; session?: string | null }): boolean =>
  item.agent === PI_AGENT && isPiSessionFile(item.session)

// pi writes an entry's type, id and parent first: read from the start of the line, the rest of a
// line is parsed only for the entries the board uses.
const HEAD = /^\{"type":"([^"]*)","id":"([^"]*)","parentId":(?:null|"([^"]*)")/

interface Head {
  type: string
  id: string
  parent: string | null
}

function headOf(line: string): Head | null {
  const m = HEAD.exec(line)
  if (m) return { type: m[1] ?? '', id: m[2] ?? '', parent: m[3] ?? null }
  // Another key order (an older or a newer pi): the whole line.
  const o = parse(line)
  if (!o || typeof o.id !== 'string') return null
  return { type: str(o.type), id: o.id, parent: typeof o.parentId === 'string' ? o.parentId : null }
}

/**
 * The lines of the session as it is now, newest first: the last entry, its parent, and so on, as
 * far back as `lines` (the end of the file) go. `stop` ends the walk early (the caller has all
 * it needs). The session's name is metadata of the whole file: `named`, when given, is told of
 * the latest session_info entry, on the branch or not, and the walk goes on until it is found.
 */
function walkBranch(
  lines: readonly string[],
  visit: (head: Head, line: string) => void,
  stop: () => boolean,
  named?: (line: string) => void,
): void {
  let want: string | null | undefined // the id of the next entry on the branch; undefined: the last one
  let nameSeen = !named
  for (let i = lines.length - 1; i >= 0 && !(nameSeen && stop()); i--) {
    const line = lines[i]
    if (!line || line.startsWith('{"type":"session",')) continue
    const head = headOf(line)
    if (!head) continue
    if (head.type === 'session_info' && !nameSeen) {
      nameSeen = true
      named?.(line)
    }
    if (want === null) break // the root was reached
    if (want !== undefined && head.id !== want) continue
    // Past what the caller needs, the walk only looks for the name.
    if (stop()) continue
    want = head.parent
    visit(head, line)
  }
}

/** The text of a pi message's content: a string, or its text blocks. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(rec)
    .filter(b => b?.type === 'text')
    .map(b => str(b?.text))
    .join('\n')
}

/** The few words that say what a pi tool call is about: the command, the file, a query. */
export function piToolDetail(name: string, input: unknown): string {
  const i = rec(input)
  if (!i) return ''
  switch (name) {
    case 'bash':
    case 'powershell':
      return clip(firstLine(i.command), 160)
    case 'read':
    case 'edit':
    case 'write':
    case 'ls':
      return baseName(i.path)
    case 'grep':
    case 'find':
      return clip(str(i.pattern), 120)
  }
  for (const k of ['description', 'query', 'question', 'prompt', 'title', 'url', 'name', 'path']) {
    const v = i[k]
    if (typeof v === 'string' && v.trim()) return clip(firstLine(v), 160)
  }
  return ''
}

/** The file a pi tool call worked on, in full, for the thread to open; '' for other tools. */
export function piToolPath(name: string, input: unknown): string {
  return ['read', 'edit', 'write'].includes(name) ? str(rec(input)?.path) : ''
}

/** What the end of a pi session file says for a card, and the session's name (`name`). */
export interface PiInfo extends TranscriptInfo {
  /** The name given to the session (`/name`, `--name`), '' for none. */
  name?: string
}

/** True once the tail holds everything a card needs. */
const tailComplete = (info: PiInfo): boolean => !!(info.prompt && info.lastText && info.tool && info.context != null)

/**
 * What the lines (the end of a pi session file) say, the session as it is now:
 *   name      the session's name (`/name`, `--name`), its latest session_info entry; '' for none
 *   prompt    the user's last prompt
 *   lastText  the agent's last words to the user; question: they end in a question, and
 *             replied: the user wrote after them
 *   tool      the last tool call (pending: no result for it yet)
 *   context   the tokens its last answer's request carried, cached parts included
 * A board reminder typed into the session is not the user answering.
 */
export function parsePiTail(lines: readonly string[]): PiInfo {
  const info: PiInfo = { name: '', title: '', prompt: '', lastText: '', question: '', replied: false, tool: null }
  const results = new Set<string>() // tool calls that have a result (seen later in the file)
  walkBranch(
    lines,
    (head, line) => {
      if (head.type !== 'message') return
      const message = rec(parse(line)?.message)
      const role = str(message?.role)
      if (role === 'toolResult') {
        results.add(str(message?.toolCallId))
        return
      }
      if (role === 'user') {
        const text = textOf(message?.content).trim()
        if (!text || boardNotice(text)) return
        if (!info.prompt) info.prompt = cleanPrompt(text)
        if (!info.lastText) info.replied = true
        return
      }
      if (role !== 'assistant') return
      const u = rec(message?.usage)
      if (info.context == null && u) {
        const tokens = num(u.input) + num(u.cacheRead) + num(u.cacheWrite)
        if (tokens) info.context = tokens
      }
      const content = Array.isArray(message?.content) ? message.content : []
      for (let j = content.length - 1; j >= 0; j--) {
        const b = rec(content[j])
        if (!b) continue
        if (b.type === 'toolCall' && !info.tool) {
          const name = str(b.name)
          const tool: ToolCall = {
            id: str(b.id),
            name,
            label: toolLabel(name),
            detail: piToolDetail(name, b.arguments),
            pending: !results.has(str(b.id)),
          }
          info.tool = tool
        } else if (b.type === 'text' && !info.lastText && str(b.text).trim()) {
          const said = str(b.text).trim()
          info.lastText = clip(said, 700)
          info.question = trailingQuestion(said)
        }
      }
    },
    () => tailComplete(info),
    line => {
      info.name = str(parse(line)?.name).trim()
    },
  )
  return info
}

/**
 * The last `limit` turns of a pi session for its sheet, oldest first: the user's prompts, the
 * agent's texts and its tool calls in a line each (done: the call has a result). A board reminder
 * typed into the session is a notice (core/notices.ts). Thinking, the system prompt and what
 * extensions put into the context are left out.
 */
export function parsePiConversation(lines: readonly string[], limit = 40): ConversationTurn[] {
  const newest: ConversationTurn[] = [] // newest first while the branch is walked back
  const done = new Set<string>() // tool calls with a result: results come after their call
  walkBranch(
    lines,
    (head, line) => {
      if (head.type !== 'message') return
      const o = parse(line)
      const message = rec(o?.message)
      const role = str(message?.role)
      const at = num(message?.timestamp) || Date.parse(str(o?.timestamp)) || 0
      if (role === 'toolResult') {
        done.add(str(message?.toolCallId))
        return
      }
      if (role === 'user') {
        const text = textOf(message?.content).trim()
        const notice = boardNotice(text)
        if (notice) newest.push({ role: 'notice', ...notice, at })
        else if (text) newest.push({ role: 'user', text: clip(text, 3000), at })
        return
      }
      if (role !== 'assistant') return
      const content = Array.isArray(message?.content) ? message.content : []
      for (let j = content.length - 1; j >= 0; j--) {
        const b = rec(content[j])
        if (!b) continue
        if (b.type === 'text' && str(b.text).trim()) {
          newest.push({ role: 'assistant', text: clip(str(b.text).trim(), 4000), at })
        } else if (b.type === 'toolCall') {
          const name = str(b.name)
          const turn: ToolTurn = {
            role: 'tool',
            label: toolLabel(name),
            detail: piToolDetail(name, b.arguments),
            path: piToolPath(name, b.arguments),
            done: done.has(str(b.id)),
            at,
          }
          newest.push(turn)
        }
      }
    },
    () => newest.filter(t => t.role !== 'tool').length >= limit,
  )
  return newest.slice(0, limit).reverse()
}
