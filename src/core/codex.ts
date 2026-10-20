// Codex rollouts contain response items and event copies of those same messages. Read the
// response items only; system instructions, reasoning and tool outputs stay out of the thread.
import { boardNotice } from './notices.ts'
import { type ConversationTurn, cleanPrompt, type ToolTurn, toolLabel, trailingQuestion } from './transcript.ts'
import type { ToolCall, TranscriptInfo } from './types.ts'

export const CODEX_AGENT = 'codex'
export const isCodexItem = (item: { agent?: string | undefined }): boolean => item.agent === CODEX_AGENT
export const isCodexSession = (id: string): boolean => /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)

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
  if (Array.isArray(kinds) && !kinds.some(k => k === 'user.text' || k === 'unknown')) return ''
  const text = textOf(item.content)
  if (/^<(?:skill|turn_aborted|subagent_notification|recommended_plugins)(?:\s|>)/.test(text)) return ''
  return text
    .replace(/^# AGENTS\.md instructions for [^\n]*\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .trim()
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
}

function readRollout(lines: readonly string[]): Rollout {
  const conversation: ConversationTurn[] = []
  const calls = new Map<string, ToolTurn>()
  let tool: ToolCall | null = null
  let context: number | undefined
  for (const line of lines) {
    const entry = parse(line)
    const item = rec(entry?.payload)
    if (!entry || !item) continue
    if (entry.type === 'event_msg' && item.type === 'token_count') {
      const usage = rec(rec(item.info)?.last_token_usage)
      if (typeof usage?.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) context = usage.input_tokens
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
      const notice = role === 'user' ? boardNotice(text) : null
      conversation.push(notice ? { role: 'notice', ...notice, at } : { role, text, at })
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
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
  return { conversation, tool, ...(context !== undefined && { context }) }
}

/** The last prompt, answer, question, tool and request size for a Codex card. */
export function parseCodexTail(lines: readonly string[]): TranscriptInfo {
  const { conversation, tool, context } = readRollout(lines)
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
  return { title: '', prompt, lastText, question, replied, tool, ...(context !== undefined && { context }) }
}

/** The last turns of a rollout, without its duplicate events or internal context. */
export function parseCodexConversation(lines: readonly string[], limit = 40): ConversationTurn[] {
  return readRollout(lines)
    .conversation.slice(-limit)
    .map(turn => {
      if (turn.role === 'user' || turn.role === 'assistant')
        return { ...turn, text: clip(turn.text, turn.role === 'user' ? 3000 : 4000) }
      return turn
    })
}
