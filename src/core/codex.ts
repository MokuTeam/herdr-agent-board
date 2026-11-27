// Codex rollouts contain response items and event copies of those same messages. Read the
// response items only; system instructions, reasoning and tool outputs stay out of the thread.
import { type LostAccess, parseLostAccess } from './lost-access.ts'
import { boardNotice } from './notices.ts'
import type { Naming } from './pi.ts'
import {
  type ConversationTurn,
  cleanPrompt,
  fitThread,
  type ToolTurn,
  toolLabel,
  trailingQuestion,
} from './transcript.ts'
import type { ToolCall, TranscriptInfo } from './types.ts'

export const CODEX_AGENT = 'codex'
export const isCodexItem = (item: { agent?: string | undefined }): boolean => item.agent === CODEX_AGENT
export const isCodexSession = (id: string): boolean => /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)

/**
 * The session id in a `codex resume <id>` command line (argv, program first); null for any other
 * command, `resume` with no id (the picker, `--last`) included.
 */
export function resumedCodexSession(argv: readonly string[]): string | null {
  const program = (argv[0] ?? '')
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.exe$/i, '')
  if (program !== CODEX_AGENT) return null
  const at = argv.indexOf('resume')
  const id = at < 0 ? undefined : argv.slice(at + 1).find(isCodexSession)
  return id && isCodexSession(id) ? id.toLowerCase() : null
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const firstLine = (s: string): string =>
  s
    .split('\n')
    .find(l => l.trim())
    ?.trim() ?? ''

function parse(line: string): Rec | null {
  try {
    return rec(JSON.parse(line))
  } catch {
    return null
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(rec)
    .filter(b => b?.type === 'input_text' || b?.type === 'output_text' || b?.type === 'text')
    .map(b => str(b?.text))
    .join('\n')
    .trim()
}

function userText(item: Rec): string {
  const metadata = rec(item.internal_chat_message_metadata_passthrough)
  const kinds = metadata?.content_item_kinds
  const classified = Array.isArray(kinds) && kinds.length > 0
  if (classified && !kinds.some(k => k === 'user.text' || k === 'unknown')) return ''
  const text = textOf(item.content)
  if (
    !classified &&
    /^<(?:skill|turn_aborted|subagent_notification|recommended_plugins|codex_internal_context)(?:\s|>)/.test(text)
  )
    return ''
  return text
    .replace(/^# AGENTS\.md instructions for [^\n]*\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .trim()
}

/** Whether this rollout record contains the exact user message submitted to Codex. */
export function codexUserEcho(line: string, text: string): boolean {
  const record = parse(line)
  const item = rec(record?.payload)
  return record?.type === 'response_item' && item?.type === 'message' && item.role === 'user' && userText(item) === text
}

function toolInput(item: Rec): Rec | null {
  return parse(str(item.arguments))
}

function toolDetail(item: Rec): string {
  const input = toolInput(item)
  for (const key of ['cmd', 'command', 'description', 'query', 'path', 'file_path', 'url', 'message']) {
    const value = str(input?.[key])
    if (value.trim()) return clip(firstLine(value), 160)
  }
  return clip(firstLine(str(item.input)), 160)
}

interface Rollout {
  conversation: ConversationTurn[]
  tool: ToolCall | null
  context?: number
  /** The model and effort of the last turn (its turn_context), what the card shows. */
  model?: string
  effort?: string
  lostAccess?: LostAccess
}

function codexErrorCode(info: unknown): string {
  if (typeof info === 'string') return info
  const r = rec(info)
  if (!r) return ''
  for (const k of Object.keys(r)) {
    const low = k.toLowerCase()
    if (
      low === 'usage_limit_exceeded' ||
      low === 'usagelimitexceeded' ||
      low === 'rate_limit_exceeded' ||
      low === 'ratelimitexceeded' ||
      low === 'unauthorized' ||
      low === 'authentication_failed'
    ) {
      return low
    }
  }
  if (typeof r.type === 'string' && r.type) return r.type
  if (r.http_status_code === 401 || r.http_status_code === 429) return String(r.http_status_code)
  return ''
}

function codexErrorText(item: Rec): string {
  const base = str(item.message) || str(item.error) || str(item.reason)
  const info = rec(item.codex_error_info)
  if (!info) return base
  const extra = JSON.stringify(info)
  return base ? `${base}\n${extra}` : extra
}

function readRollout(lines: readonly string[]): Rollout {
  const conversation: ConversationTurn[] = []
  const calls = new Map<string, ToolTurn>()
  let tool: ToolCall | null = null
  let context: number | undefined
  let model: string | undefined
  let effort: string | undefined
  let lostAccess: LostAccess | undefined
  for (const line of lines) {
    const entry = parse(line)
    const item = rec(entry?.payload)
    if (!entry || !item) continue
    if (entry.type === 'turn_context') {
      model = str(item.model) || model
      effort = str(item.effort) || str(rec(rec(item.collaboration_mode)?.settings)?.reasoning_effort) || effort
      continue
    }
    if (entry.type === 'event_msg') {
      if (item.type === 'token_count') {
        const usage = rec(rec(item.info)?.last_token_usage)
        if (typeof usage?.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) context = usage.input_tokens
      } else if (item.type === 'error' || item.type === 'turn_aborted') {
        const code = codexErrorCode(item.codex_error_info) || str(item.reason)
        const text = codexErrorText(item)
        const hit = parseLostAccess(text, { errorCode: code, at: Date.parse(str(entry.timestamp)) || 0 })
        if (hit) lostAccess = hit
      }
      continue
    }
    if (entry.type !== 'response_item') continue
    const at = Date.parse(str(entry.timestamp)) || 0
    if (item.type === 'message') {
      const role = item.role
      if (role !== 'user' && role !== 'assistant') continue
      // Some providers put private analysis in message items, rather than reasoning items.
      if (role === 'assistant' && item.channel === 'analysis') continue
      const text = role === 'user' ? userText(item) : textOf(item.content)
      if (!text) continue
      if (role === 'assistant') lostAccess = undefined
      const notice = role === 'user' ? boardNotice(text) : null
      conversation.push(notice ? { role: 'notice', ...notice, at } : { role, text, at })
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      lostAccess = undefined
      const id = str(item.call_id)
      const name = str(item.name)
      const detail = toolDetail(item)
      const turn: ToolTurn = { role: 'tool', label: toolLabel(name), detail, path: '', done: false, at }
      calls.set(id, turn)
      conversation.push(turn)
      tool = { id, name, label: turn.label, detail, pending: true }
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const id = str(item.call_id)
      const call = calls.get(id)
      if (call) call.done = true
      if (tool?.id === id) tool.pending = false
    }
  }
  return {
    conversation,
    tool,
    ...(context !== undefined && { context }),
    ...(model && { model }),
    ...(effort && { effort }),
    ...(lostAccess && { lostAccess }),
  }
}

/** The last prompt, answer, question, tool and request size for a Codex card. */
export function parseCodexTail(lines: readonly string[]): TranscriptInfo {
  const { conversation, tool, context, model, effort, lostAccess } = readRollout(lines)
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
    ...(model && { model }),
    ...(effort && { effort }),
    ...(lostAccess && { lostAccess }),
  }
}

/**
 * The last turns of a rollout, without its duplicate events or internal context; messages whole,
 * within the thread's budget (fitThread).
 */
export function parseCodexConversation(lines: readonly string[], limit = 40): ConversationTurn[] {
  return fitThread(readRollout(lines).conversation.slice(-limit))
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Codex's /rename runs without a turn and prints nothing: the name shows at the end of the status
 * line under the input (`GPT-6.1-Sol low · <folder> · <name>`), cut with … when it is long.
 */
export const CODEX_NAMING: Naming = {
  title: 'Codex',
  command: name => `/rename ${name}`,
  done: /(?!)/,
  // The first 40 characters: a long name is cut in the status line.
  doneFor: name => new RegExp(`·\\s*${escapeRe(name.trim().slice(0, 40)).replace(/\s+/g, '\\s+')}`),
}

/** Codex's input field is on screen: its `›` line, and the status line under it. */
export function codexInputReady(shown: string): boolean {
  if (codexHooksReview(shown)) return false
  // A hook still running (SessionStart) holds the first input back.
  if (/(?:running|starting)\s+[^\n]*\bhooks?\b/i.test(shown)) return false
  return /^\s*›/m.test(shown) && /^\s*\S.*·.*$/m.test(shown.split(/^\s*›/m).pop() ?? '')
}

/** The screen Codex stops at when hooks wait for the user to trust them: "N hooks need review …". */
export const codexHooksReview = (shown: string): boolean => /\bhooks?\s+needs?\s+review\b/i.test(shown)

/**
 * Where a sent prompt is: `typed` (in the input field, Enter not taken), `sent` (in the
 * conversation, the field empty again) or `missing` (dropped, nowhere on screen).
 */
export function codexPromptAt(shown: string, text: string): 'typed' | 'sent' | 'missing' {
  const squeeze = (s: string): string => s.replace(/\s+/g, '')
  const head = squeeze(text.split('\n')[0] ?? '').slice(0, 30)
  const inputs = shown.split('\n').filter(l => /^\s*›/.test(l))
  const last = squeeze((inputs.at(-1) ?? '').replace(/^\s*›/, ''))
  if (/^\[?Pasted/i.test(last) || (head && last.startsWith(head))) return 'typed'
  if (/esc to interrupt|Worked for/.test(shown) || (head && squeeze(shown).includes(head))) return 'sent'
  return 'missing'
}
