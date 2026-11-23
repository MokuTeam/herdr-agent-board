// Antigravity CLI (`agy`) transcripts live at
// `<appDataDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`.
// Each line is a step (`USER_INPUT`, `PLANNER_RESPONSE`, tool result steps such as `GENERIC`).
// Thinking blocks, system wrappers and tool outputs stay out of the conversation thread.
import { boardNotice } from './notices.ts'
import {
  type ConversationTurn,
  cleanPrompt,
  fitThread,
  type ToolTurn,
  toolLabel,
  trailingQuestion,
} from './transcript.ts'
import type { ToolCall, TranscriptInfo } from './types.ts'

export const AGY_AGENT = 'agy'
export const isAgyItem = (item: { agent?: string | undefined }): boolean => item.agent === AGY_AGENT
export const isAgySession = (id: string): boolean => /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const firstLine = (s: string): string =>
  s
    .split('\n')
    .find(l => l.trim())
    ?.trim() ?? ''
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? ''

function parse(line: string): Rec | null {
  try {
    return rec(JSON.parse(line))
  } catch {
    return null
  }
}

/**
 * Antigravity transcripts encode tool call argument values as JSON strings
 * (e.g. `"\"/path/to/file\""`), or plain strings in tests/older builds.
 */
function unwrapArg(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'string') return parsed
    } catch {}
  }
  return value
}

/** Extract the user's message from an Antigravity `USER_INPUT` step's content. */
export function agyUserText(content: unknown): string {
  const raw = str(content)
  if (!raw.trim()) return ''
  const requests = [...raw.matchAll(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g)]
    .map(m => (m[1] ?? '').trim())
    .filter(Boolean)
  if (requests.length) return requests.join('\n')
  return raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, '')
    .replace(/<ENVIRONMENT_CONTEXT>[\s\S]*?<\/ENVIRONMENT_CONTEXT>/g, '')
    .trim()
}

/** Extract the reasoning effort suffix from an Antigravity model id (e.g. `gemini-4-neon-high` -> `high`). */
export function agyEffortOf(model: string): string | null {
  const m = /-(low|medium|high|xhigh|max)$/i.exec(model.trim())
  return m?.[1]?.toLowerCase() ?? null
}

const FILE_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'view_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'view_file_outline',
  'view_code_item',
])

/** Full path for file tools so the web board can link file chips; '' for other tools. */
export function agyToolPath(name: string, args: unknown): string {
  if (!FILE_TOOLS.has(name)) return ''
  const a = rec(args)
  if (!a) return ''
  for (const key of ['Path', 'TargetFile', 'AbsolutePath', 'File', 'path', 'file_path']) {
    const v = unwrapArg(a[key]).trim()
    if (v) return v
  }
  return ''
}

/** Short human-readable summary of an Antigravity tool call for cards and threads. */
export function agyToolDetail(name: string, args: unknown): string {
  const a = rec(args)
  if (!a) return ''
  switch (name) {
    case 'run_command': {
      const summary = unwrapArg(a.toolSummary).trim()
      if (summary) return clip(firstLine(summary), 160)
      const cmd = unwrapArg(a.CommandLine || a.command).trim()
      return cmd ? clip(firstLine(cmd), 160) : ''
    }
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'view_file':
    case 'write_to_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'list_dir': {
      const p = unwrapArg(a.Path || a.TargetFile || a.AbsolutePath || a.DirectoryPath || a.path).trim()
      return p ? baseName(p) : ''
    }
    case 'grep_search':
    case 'find_by_name':
    case 'search_web': {
      const q = unwrapArg(a.Query || a.Pattern || a.query || a.pattern).trim()
      return q ? clip(firstLine(q), 120) : ''
    }
    case 'invoke_subagent': {
      const role = unwrapArg(a.Role || a.Prompt).trim()
      return role ? clip(firstLine(role), 160) : ''
    }
    case 'ask_question': {
      const raw = a.questions
      let list: unknown = raw
      if (typeof raw === 'string') {
        try {
          list = JSON.parse(raw)
        } catch {}
      }
      const first = Array.isArray(list) ? rec(list[0]) : null
      const q = str(first?.question).trim()
      if (q) return clip(firstLine(q), 160)
      break
    }
  }
  for (const key of [
    'toolSummary',
    'Description',
    'description',
    'Query',
    'query',
    'Prompt',
    'prompt',
    'Role',
    'Title',
    'title',
    'Url',
    'url',
    'Path',
    'path',
    'CommandLine',
    'Message',
    'message',
  ]) {
    const v = unwrapArg(a[key]).trim()
    if (v) return clip(firstLine(v), 160)
  }
  return ''
}

interface ParsedTranscript {
  conversation: ConversationTurn[]
  tool: ToolCall | null
  context?: number
  model?: string
  modelAt?: number
  effort?: string | null
  lastAt?: number
}

const FINISHED_STEP = new Set(['DONE', 'ERROR', 'CANCELED', 'CANCELLED', 'SKIPPED'])

function readTranscript(lines: readonly string[]): ParsedTranscript {
  const conversation: ConversationTurn[] = []
  const pendingCalls: ToolTurn[] = []
  let tool: ToolCall | null = null
  let context: number | undefined
  let model: string | undefined
  let modelAt: number | undefined
  let effort: string | null | undefined
  let lastAt = 0

  const settleAll = () => {
    for (const c of pendingCalls) c.done = true
    pendingCalls.length = 0
    if (tool) tool.pending = false
  }

  for (const line of lines) {
    if (!line.trim()) continue
    const entry = parse(line)
    if (!entry) continue
    const type = str(entry.type)
    const status = str(entry.status).toUpperCase()
    const at = Date.parse(str(entry.created_at)) || 0

    if (type === 'USER_INPUT') {
      settleAll()
      const text = agyUserText(entry.content)
      if (!text) continue
      if (at > lastAt) lastAt = at
      const notice = boardNotice(text)
      conversation.push(notice ? { role: 'notice', ...notice, at } : { role: 'user', text, at })
      continue
    }

    if (type === 'PLANNER_RESPONSE') {
      settleAll()
      const entryModel = str(entry.model).trim()
      if (entryModel) {
        model = entryModel
        effort = agyEffortOf(entryModel)
        if (at) modelAt = at
      }
      const inTokens = num(entry.input_tokens) + num(entry.cache_read_tokens)
      if (inTokens > 0) context = inTokens

      const text = str(entry.content).trim()
      if (text) {
        if (at > lastAt) lastAt = at
        conversation.push({ role: 'assistant', text, at })
      }

      const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : []
      const stepIdx = typeof entry.step_index === 'number' ? entry.step_index : conversation.length
      for (let j = 0; j < calls.length; j++) {
        const call = rec(calls[j])
        if (!call) continue
        const name = str(call.name)
        if (!name) continue
        const detail = agyToolDetail(name, call.args)
        const path = agyToolPath(name, call.args)
        const turn: ToolTurn = { role: 'tool', label: toolLabel(name), detail, path, done: false, at }
        pendingCalls.push(turn)
        conversation.push(turn)
        tool = { id: `${stepIdx}:${j}`, name, label: turn.label, detail, pending: true }
      }
      continue
    }

    // Tool result steps (GENERIC, RUN_COMMAND, etc.) resolve pending tool calls in order.
    if (pendingCalls.length > 0 && (!status || FINISHED_STEP.has(status))) {
      const done = pendingCalls.shift()
      if (done) done.done = true
      if (pendingCalls.length === 0 && tool) tool.pending = false
    }
  }

  return {
    conversation,
    tool,
    ...(context !== undefined && { context }),
    ...(model !== undefined && { model }),
    ...(modelAt !== undefined && { modelAt }),
    ...(effort !== undefined && { effort }),
    ...(lastAt > 0 && { lastAt }),
  }
}

/** The last prompt, answer, question, tool, model and context size for an Antigravity card. */
export function parseAgyTail(lines: readonly string[]): TranscriptInfo {
  const { conversation, tool, context, model, modelAt, effort, lastAt } = readTranscript(lines)
  let prompt = ''
  let lastText = ''
  let question = ''
  let replied = false
  for (let i = conversation.length - 1; i >= 0; i--) {
    const turn = conversation[i]
    if (turn?.role === 'user') {
      if (!prompt) prompt = cleanPrompt(turn.text)
      if (!lastText) replied = true
    } else if (turn?.role === 'assistant' && !lastText) {
      lastText = clip(turn.text, 700)
      question = trailingQuestion(turn.text)
    }
    if (prompt && lastText) break
  }
  return {
    title: '',
    prompt,
    lastText,
    question,
    replied,
    tool,
    ...(context !== undefined && { context }),
    ...(model !== undefined && { model }),
    ...(modelAt !== undefined && { modelAt }),
    ...(effort !== undefined && { effort }),
    ...(lastAt !== undefined && { lastAt }),
  }
}

/**
 * The last turns of an Antigravity transcript for the session sheet, without thinking or
 * system metadata wrappers; messages whole, within the thread's budget (fitThread).
 */
export function parseAgyConversation(lines: readonly string[], limit = 40): ConversationTurn[] {
  return fitThread(readTranscript(lines).conversation.slice(-limit))
}

/**
 * Whether an Antigravity transcript records a canceled step at `since` (ms) or later:
 * used by Stop (`services/turn.ts`) beside herdr's idle/done status.
 */
export function agyInterruptedSince(transcript: unknown, since: number): boolean {
  for (const line of String(transcript ?? '').split('\n')) {
    if (!line.includes('CANCELED') && !line.includes('CANCELLED')) continue
    const entry = parse(line)
    if (!entry) continue
    const status = str(entry.status).toUpperCase()
    const reason = str(entry.termination_reason).toUpperCase()
    if (status !== 'CANCELED' && status !== 'CANCELLED' && reason !== 'USER_CANCELED') continue
    const at = Date.parse(str(entry.created_at))
    if (at >= since) return true
  }
  return false
}
