// Antigravity CLI (`agy`) transcripts live at
// `<appDataDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`.
// Each line is a step (`USER_INPUT`, `PLANNER_RESPONSE`, tool result steps such as `GENERIC`).
// Thinking blocks, system wrappers and tool outputs stay out of the conversation thread.
import type { RunningBgTask } from './bg-task.ts'
import { MAX_BG_TASK_DETAIL } from './bg-task.ts'
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
  bgTasks?: RunningBgTask[]
  daemonBgTasks?: RunningBgTask[]
}

interface PendingMeta {
  callId: string
  name: string
  detail: string
  cmd: string
  daemon: boolean
}

const FINISHED_STEP = new Set(['DONE', 'ERROR', 'CANCELED', 'CANCELLED', 'SKIPPED'])

function isDaemonFlag(args: unknown): boolean {
  const a = rec(args)
  if (!a || !Object.hasOwn(a, 'IsDaemon')) return false
  if (a.IsDaemon === true) return true
  const v = unwrapArg(a.IsDaemon).trim().toLowerCase()
  return v === 'true' || v === '1'
}

const BG_TASK_START_RE = /Tool is running as a background task with task id:\s*(\S+)/
const BG_TASK_CREATED_AT_RE = /^Created At:\s*(.+)$/m
const BG_TASK_DESC_RE = /^Task Description:\s*(.+)$/m
const BG_TASK_SYS_DONE_RE =
  /Task id\s+"([^"]+)"\s+(?:finished|was cance[ll]+ed|cance[ll]+ed|failed|errored|completed|stopped|terminated|timed out|ended)\b/gi
const BG_TASK_SYS_SENDER_RE = /\bsender=([^\s<>'"]+)/g
const BG_TASK_STILL_RUNNING_RE = /\b(?:is still running|still running after)\b/i
const BG_TASK_STEP_ID_RE = /\/task-(\d+)$/
const BG_TASK_KILLED_RE = /Task\s+"([^"]+)"\s+cance[ll]+ed\b/gi
const BG_TASK_LIST_EMPTY_RE = /You have 0 background task\(s\) currently running\b/i
const BG_TASK_LIST_HEAD_RE = /You have \d+ background task\(s\) currently running:\s*/i

function clearBgFromSystemMessage(text: string, bgTasks: Map<string, RunningBgTask & { daemon: boolean }>): void {
  for (const m of text.matchAll(BG_TASK_SYS_DONE_RE)) {
    const id = (m[1] ?? '').trim()
    if (id) bgTasks.delete(id)
  }
  if (!BG_TASK_STILL_RUNNING_RE.test(text)) {
    for (const m of text.matchAll(BG_TASK_SYS_SENDER_RE)) {
      const id = (m[1] ?? '').trim()
      if (id) bgTasks.delete(id)
    }
  }
}

function callIdOf(obj: Rec): string {
  for (const key of ['call_id', 'tool_call_id', 'tool_use_id', 'id']) {
    const v = str(obj[key]).trim()
    if (v) return v
  }
  return ''
}

function pendingMatchIndex(pendingMeta: readonly PendingMeta[], entry: Rec, desc = ''): number {
  const cid = callIdOf(entry)
  if (cid) {
    const byId = pendingMeta.findIndex(m => m.callId === cid)
    if (byId >= 0) return byId
  }
  if (desc && pendingMeta.length > 1) {
    const byDesc = pendingMeta.findIndex(m => m.cmd === desc || m.detail === desc)
    if (byDesc >= 0) return byDesc
  }
  return 0
}

function readTranscript(lines: readonly string[]): ParsedTranscript {
  const conversation: ConversationTurn[] = []
  const pendingCalls: ToolTurn[] = []
  const pendingMeta: PendingMeta[] = []
  const bgTasks = new Map<string, RunningBgTask & { daemon: boolean }>()
  let tool: ToolCall | null = null
  let context: number | undefined
  let model: string | undefined
  let modelAt: number | undefined
  let effort: string | null | undefined
  let lastAt = 0

  const settleAll = () => {
    for (const c of pendingCalls) c.done = true
    pendingCalls.length = 0
    pendingMeta.length = 0
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
      const rawContent = str(entry.content)
      for (const sm of rawContent.matchAll(/<SYSTEM_MESSAGE>([\s\S]*?)<\/SYSTEM_MESSAGE>/g)) {
        clearBgFromSystemMessage(sm[1] ?? '', bgTasks)
      }
      const text = agyUserText(rawContent)
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
        const argsRec = rec(call.args)
        const cmd = argsRec ? unwrapArg(argsRec.CommandLine || argsRec.command).trim() : ''
        const turn: ToolTurn = { role: 'tool', label: toolLabel(name), detail, path, done: false, at }
        pendingCalls.push(turn)
        pendingMeta.push({ callId: callIdOf(call), name, detail, cmd, daemon: isDaemonFlag(call.args) })
        conversation.push(turn)
        tool = { id: `${stepIdx}:${j}`, name, label: turn.label, detail, pending: true }
      }
      continue
    }

    const content = str(entry.content)
    const isSystem = type === 'SYSTEM_MESSAGE' || str(entry.source).toUpperCase() === 'SYSTEM'
    if (isSystem) {
      clearBgFromSystemMessage(content, bgTasks)
    } else {
      const bgStart = BG_TASK_START_RE.exec(content)
      if (bgStart) {
        const descMatch = BG_TASK_DESC_RE.exec(content)
        const idx = pendingCalls.length > 0 ? pendingMatchIndex(pendingMeta, entry, descMatch?.[1]?.trim() ?? '') : -1
        const [done] = idx >= 0 ? pendingCalls.splice(idx, 1) : [undefined]
        const [meta] = idx >= 0 ? pendingMeta.splice(idx, 1) : [undefined]
        if (done) done.done = true
        if (pendingCalls.length === 0 && tool) tool.pending = false
        const id = (bgStart[1] ?? '').trim()
        if (id && !FINISHED_STEP.has(status)) {
          const stepIndex = typeof entry.step_index === 'number' ? entry.step_index : null
          const createdMatch = BG_TASK_CREATED_AT_RE.exec(content)
          const startedAt = at || (createdMatch ? Date.parse(createdMatch[1]?.trim() ?? '') || 0 : 0)
          const rawDetail = meta?.detail || descMatch?.[1]?.trim() || ''
          const detail = rawDetail ? clip(firstLine(rawDetail), MAX_BG_TASK_DETAIL) : ''
          bgTasks.set(id, { id, stepIndex, startedAt, detail, daemon: !!meta?.daemon })
        }
        continue
      }

      for (const m of content.matchAll(BG_TASK_KILLED_RE)) {
        const id = (m[1] ?? '').trim()
        if (id) bgTasks.delete(id)
      }
      if (BG_TASK_LIST_EMPTY_RE.test(content)) {
        bgTasks.clear()
      } else {
        const listHead = BG_TASK_LIST_HEAD_RE.exec(content)
        if (listHead) {
          const rest = content.slice(listHead.index + listHead[0].length).trim()
          if (rest.startsWith('[')) {
            let parsed: unknown
            try {
              parsed = JSON.parse(rest)
            } catch {
              const single = /^(\[[\s\S]*?\])(?:\r?\n|$)/.exec(rest)
              if (single) {
                try {
                  parsed = JSON.parse(single[1] ?? '')
                } catch {}
              }
            }
            if (Array.isArray(parsed)) {
              const listed = new Set<string>()
              for (const rawItem of parsed) {
                const item = rec(rawItem)
                const taskId = str(item?.taskId).trim()
                if (!taskId) continue
                listed.add(taskId)
                if (!bgTasks.has(taskId)) {
                  const startTime = Date.parse(str(item?.startTime)) || 0
                  const rawDetail = str(item?.toolSummary || item?.description).trim()
                  const detail = rawDetail ? clip(firstLine(rawDetail), MAX_BG_TASK_DETAIL) : ''
                  const idStep = BG_TASK_STEP_ID_RE.exec(taskId)?.[1]
                  const stepIndex =
                    typeof item?.stepIndex === 'number' && Number.isInteger(item.stepIndex) && item.stepIndex >= 0
                      ? item.stepIndex
                      : idStep
                        ? Number(idStep)
                        : null
                  bgTasks.set(taskId, { id: taskId, stepIndex, startedAt: startTime, detail, daemon: false })
                }
              }
              for (const id of bgTasks.keys()) {
                if (!listed.has(id)) bgTasks.delete(id)
              }
            }
          }
        }
      }
    }

    // Tool result steps (GENERIC, RUN_COMMAND, etc.) resolve pending tool calls in order.
    if (pendingCalls.length > 0 && (!status || FINISHED_STEP.has(status))) {
      const idx = pendingMatchIndex(pendingMeta, entry)
      const [done] = pendingCalls.splice(idx, 1)
      pendingMeta.splice(idx, 1)
      if (done) done.done = true
      if (pendingCalls.length === 0 && tool) tool.pending = false
    }
  }

  const stripDaemon = (daemonFlag: boolean): RunningBgTask[] =>
    [...bgTasks.values()]
      .filter(t => t.daemon === daemonFlag)
      .map(({ daemon: _d, ...rest }) => rest)
      .sort((a, b) => (a.startedAt || Number.POSITIVE_INFINITY) - (b.startedAt || Number.POSITIVE_INFINITY))

  const liveBgTasks = stripDaemon(false)
  const daemonBgTasks = stripDaemon(true)

  return {
    conversation,
    tool,
    ...(context !== undefined && { context }),
    ...(model !== undefined && { model }),
    ...(modelAt !== undefined && { modelAt }),
    ...(effort !== undefined && { effort }),
    ...(lastAt > 0 && { lastAt }),
    ...(liveBgTasks.length > 0 && { bgTasks: liveBgTasks }),
    ...(daemonBgTasks.length > 0 && { daemonBgTasks }),
  }
}

/** The last prompt, answer, question, tool, model and context size for an Antigravity card. */
export function parseAgyTail(lines: readonly string[]): TranscriptInfo {
  const { conversation, tool, context, model, modelAt, effort, lastAt, bgTasks, daemonBgTasks } = readTranscript(lines)
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
    ...(bgTasks !== undefined && { bgTasks }),
    ...(daemonBgTasks !== undefined && { daemonBgTasks }),
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
