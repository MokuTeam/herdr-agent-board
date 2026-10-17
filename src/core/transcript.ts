// Reading what Claude Code wrote into a transcript (JSONL lines): the end of it for a card, the
// last turns for the detail view. Pure: the file reading lives with the adapter.

import { type FormQuestion, questionsOf } from './dialogs/question-form.ts'
import { t } from './lang.ts'
import { isNotice, isReminder, type Notice, reminderNotice, taskNotice } from './notices.ts'
import { DEFAULT_PROMPT_FILTERS, type PromptFilter } from './prompt-filters.ts'
import type { ToolCall, TranscriptInfo } from './types.ts'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' ? (v as Rec) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const firstLine = (s: unknown): string =>
  String(s ?? '')
    .split('\n')
    .find(l => l.trim())
    ?.trim() ?? ''
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function parse(line: string): Rec | null {
  try {
    return rec(JSON.parse(line))
  } catch {
    return null
  }
}

/** Clean a prompt for one line on a card: no tags, no envelopes, no line breaks. */
export function cleanPrompt(text: unknown, filters: readonly PromptFilter[] = DEFAULT_PROMPT_FILTERS): string {
  return filters
    .reduce((s, filter) => filter(s), String(text ?? ''))
    .replace(/^[❯>]\s*/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Text the user typed, without the envelopes Claude Code and the hooks wrap around it. */
export function userText(content: unknown, filters: readonly PromptFilter[] = DEFAULT_PROMPT_FILTERS): string {
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map(rec)
            .filter(b => b?.type === 'text')
            .map(b => str(b?.text))
            .join('\n')
        : ''
  const stripped = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(local-command-stdout|local-command-stderr|command-message|command-args)>[\s\S]*?<\/\1>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
  return filters.reduce((s, filter) => filter(s), stripped).trim()
}

/**
 * What a block of the session's message says to the user, as its terminal shows it: the text,
 * and the short updates Claude Code keeps in thinking blocks when the entry has thinkingDisplay
 * "updates" (since 2.1.296), printed in the terminal like any message. Other thinking stays hidden.
 */
export function saidIn(entry: unknown, block: unknown): string {
  const b = rec(block)
  if (b?.type === 'text') return str(b.text).trim()
  if (b?.type === 'thinking' && rec(entry)?.thinkingDisplay === 'updates') return str(b.thinking).trim()
  return ''
}

/** "Bash", "slack · read_channel", "Gmail · search_threads" for a tool name. */
export function toolLabel(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name ?? '')
  if (!m) return name ?? ''
  const server = (m[1] ?? '').replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/, '')
  const tool = m[2] ?? ''
  const short = tool.toLowerCase().startsWith(`${server.toLowerCase()}_`) ? tool.slice(server.length + 1) : tool
  return `${server} · ${short}`
}

/** The file a tool call worked on, in full, for the thread to open; '' for other tools. */
export function toolPath(name: string, input: unknown): string {
  const i = rec(input)
  if (!i) return ''
  return ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name) ? String(i.file_path || i.notebook_path || '') : ''
}

/** The few words that say what a tool call is about: a Bash description, a file name, a query. */
export function toolDetail(name: string, input: unknown): string {
  const i = rec(input)
  if (!i) return ''
  const base = (p: unknown) =>
    String(p ?? '')
      .split(/[\\/]/)
      .pop() ?? ''
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return clip(String(i.description || firstLine(i.command)), 160)
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return base(i.file_path || i.notebook_path)
    case 'Grep':
    case 'Glob':
      return clip(String(i.pattern ?? ''), 120)
    case 'WebFetch':
      try {
        return new URL(String(i.url)).host
      } catch {
        return ''
      }
    case 'Agent':
    case 'Task':
      return String(i.description ?? '')
    case 'AskUserQuestion': {
      const first = Array.isArray(i.questions) ? rec(i.questions[0]) : null
      return String(first?.question ?? '')
    }
    case 'SendMessage': {
      const to = String(i.to ?? '')
      return !to ? '' : /^uds:|pipe/i.test(to) ? t('tool.peer') : `→ ${to}`
    }
    case 'Skill':
      return String(i.skill ?? '')
  }
  for (const k of ['description', 'query', 'question', 'subject', 'text', 'title', 'url', 'name', 'path']) {
    const v = i[k]
    if (typeof v === 'string' && v.trim()) return clip(firstLine(v), 160)
  }
  const any = Object.values(i).find((v): v is string => typeof v === 'string' && !!v.trim() && v.length < 300)
  return any ? clip(firstLine(any), 160) : ''
}

/**
 * The question a message ends with, or '' when it does not end with one: its last sentence or
 * two, without markdown. Code blocks and trailing markup ( **, `, quotes, brackets) are ignored.
 */
export function trailingQuestion(text: unknown): string {
  const body = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[\s*_`)\]»"'”]+$/u, '')
  if (!body.endsWith('?')) return ''
  const para = body.split(/\n\s*\n/).pop() ?? ''
  const sentences = para
    .replace(/[*_`#>]+/g, '')
    .split(/(?<=[.!?…:])\s+/)
    .map(s => s.replace(/^\s*(?:[-•]|\d+\.)\s+/, '').trim())
    .filter(Boolean)
  let q = sentences.pop() ?? ''
  const before = sentences.pop()
  if (before && before.length + q.length < 200) q = `${before} ${q}`
  return clip(q.replace(/\s+/g, ' ').trim(), 300)
}

/** True once the tail holds everything a card needs; the reader widens its window until then. */
export const tailComplete = (info: TranscriptInfo): boolean =>
  !!(info.title && info.prompt && info.lastText && info.tool)

/**
 * What the lines (the end of a transcript) say:
 *   title     Claude's own title of the session (ai-title)
 *   prompt    the user's last prompt
 *   lastText  the agent's last words to the user
 *   tool      the last tool call: { id, name, label, detail, pending, questions }; pending = no
 *             result yet, questions = an AskUserQuestion call's questions
 *   question  the agent's last words end in a question; replied: the user wrote after them
 */
export function parseTranscriptTail(lines: string[]): TranscriptInfo {
  const info: TranscriptInfo = { title: '', prompt: '', lastText: '', question: '', replied: false, tool: null }
  const results = new Set<string>() // tool_use ids that already have a result (seen later in the file)
  for (let i = lines.length - 1; i >= 0 && !tailComplete(info); i--) {
    const line = lines[i]
    if (!line) continue
    if (line.includes('"type":"ai-title"')) {
      if (!info.title) info.title = str(parse(line)?.aiTitle)
      continue
    }
    if (line.includes('"type":"last-prompt"')) {
      if (!info.prompt) info.prompt = cleanPrompt(parse(line)?.lastPrompt)
      continue
    }
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue
    const o = parse(line)
    if (!o || o.isSidechain) continue
    const message = rec(o.message)
    const content = message?.content
    if (o.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          const block = rec(b)
          if (block?.type === 'tool_result') results.add(str(block.tool_use_id))
        }
      }
      // A reminder the board typed in (services/scheduler.ts) or a background task reporting back is not the user answering.
      if (
        !info.lastText &&
        !o.isMeta &&
        rec(o.origin)?.kind !== 'task-notification' &&
        userText(content) &&
        !isNotice(userText(content))
      )
        info.replied = true
      continue
    }
    if (o.type !== 'assistant' || !Array.isArray(content)) continue
    // How full the context is: what the last real request carried, cached parts included.
    const u = rec(message?.usage)
    if (info.context == null && u && message?.model !== '<synthetic>') {
      const num = (v: unknown) => (typeof v === 'number' ? v : 0)
      const tokens = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens)
      if (tokens) info.context = tokens
    }
    for (let j = content.length - 1; j >= 0; j--) {
      const b = rec(content[j])
      if (!b) continue
      if (b.type === 'tool_use' && !info.tool) {
        const name = str(b.name)
        const tool: ToolCall = {
          id: str(b.id),
          name,
          label: toolLabel(name),
          detail: toolDetail(name, b.input),
          pending: !results.has(str(b.id)),
        }
        // The form only while it waits for an answer: every board refresh carries it to the page.
        if (name === 'AskUserQuestion' && tool.pending) tool.questions = questionsOf(b.input)
        info.tool = tool
      } else if (!info.lastText && saidIn(o, b)) {
        info.lastText = clip(saidIn(o, b), 700)
        info.question = trailingQuestion(saidIn(o, b))
      }
    }
  }
  return info
}

export interface UserTurn {
  role: 'user'
  text: string
  at: number
}
export interface AssistantTurn {
  role: 'assistant'
  text: string
  at: number
}
export interface ToolTurn {
  role: 'tool'
  label: string
  detail: string
  path: string
  done: boolean
  at: number
  id?: string
  ask?: Pick<FormQuestion, 'question' | 'header' | 'multiSelect'>[]
  answers?: string[] | null
}
/** A background task reporting back or a board reminder (core/notices.ts), at its time. */
export type NoticeTurn = Notice & { role: 'notice'; at: number }
export type ConversationTurn = UserTurn | AssistantTurn | ToolTurn | NoticeTurn

/** What tells one notice from another: the copy a queued notice leaves when it is sent again matches. */
function noticeKey(n: Notice): string {
  if (isReminder(n)) return JSON.stringify([n.kind, null, n.status, n.name, null, null, n.from, n.note])
  return JSON.stringify([n.kind, n.id, n.status, n.name, n.summary, n.detail, null, n.note])
}

/** The answers Claude Code recorded for a question form, in the order of its questions. */
function askAnswers(ask: readonly { question: string }[], result: unknown): string[] | null {
  const answers = rec(rec(result)?.answers)
  if (!answers) return null
  // Keyed by the full question text, which questionsOf keeps whole.
  return ask.map(q => {
    const a = answers[q.question]
    return typeof a === 'string' ? clip(a, 2000) : ''
  })
}

/**
 * The last `limit` turns of a session for the detail view: the user's prompts, the agent's
 * texts and its tool calls in a line each (done = the call has a result). A question form
 * (AskUserQuestion) carries its questions and, once done, the answers: { ask, answers }, answers
 * null when it was closed without one. Background tasks reporting back and board reminders come
 * as { role: 'notice', ...taskNotice() or reminderNotice() } (core/notices.ts).
 */
export function parseConversation(lines: string[], limit = 40): ConversationTurn[] {
  const items: ConversationTurn[] = []
  const tools = new Map<string, ToolTurn>() // tool_use id -> item
  // A background task reporting back or a board reminder: a line of its own (core/notices.ts). One
  // can be queued into a running turn and then sent again as a turn of its own: shown once. A
  // task id alone is not enough, a monitor or a resumed agent reports again under the same one.
  const shown = new Set<string>()
  const keys = new WeakMap<ConversationTurn, string>() // notice item -> its key
  const notice = (n: Notice, at: number) => {
    const key = noticeKey(n)
    const last = items.at(-1)
    // With an id the copy can come later in the turn; a reminder (no id) only right after itself,
    // since the same reminder text can come every hour.
    if ('id' in n && n.id ? shown.has(key) : !!last && keys.get(last) === key) return
    shown.add(key)
    const item: NoticeTurn = { role: 'notice', ...n, at }
    keys.set(item, key)
    items.push(item)
  }
  for (const line of lines) {
    if (
      !line ||
      !(
        line.includes('"type":"user"') ||
        line.includes('"type":"assistant"') ||
        line.includes('"type":"queued_command"')
      )
    )
      continue
    const o = parse(line)
    if (!o || o.isSidechain || o.isMeta || o.isCompactSummary) continue
    const content = rec(o.message)?.content
    const at = Date.parse(str(o.timestamp)) || 0
    // A prompt sent while the session worked goes into the running turn, and the transcript
    // keeps it as a queued command, not a user line. Other sessions' messages and task
    // notifications arrive the same way; other sessions' messages are not shown.
    if (o.type === 'attachment') {
      const a = rec(o.attachment)
      if (a?.type !== 'queued_command') continue
      const when = Date.parse(str(a.timestamp)) || at
      const task = a.commandMode === 'task-notification' ? taskNotice(a.prompt) : null
      if (task) notice(task, when)
      const text = a.commandMode === 'prompt' && rec(a.origin)?.kind !== 'peer' ? userText(a.prompt) : ''
      const reminder = reminderNotice(text)
      const prev = items.at(-1)
      if (reminder) notice(reminder, when)
      else if (text && !(prev?.role === 'user' && prev.text === clip(text, 3000)))
        items.push({ role: 'user', text: clip(text, 3000), at: when })
      continue
    }
    if (o.type === 'user') {
      if (Array.isArray(content)) {
        for (const raw of content) {
          const b = rec(raw)
          const tool = b?.type === 'tool_result' ? tools.get(str(b.tool_use_id)) : undefined
          if (!b || !tool) continue
          tool.done = true
          if (tool.ask) tool.answers = askAnswers(tool.ask, o.toolUseResult)
        }
        if (content.every(b => rec(b)?.type === 'tool_result')) continue
      }
      const text = userText(content)
      const n = taskNotice(text) ?? reminderNotice(text)
      if (n) notice(n, at)
      else if (text) items.push({ role: 'user', text: clip(text, 3000), at })
    } else if (Array.isArray(content)) {
      for (const raw of content) {
        const b = rec(raw)
        if (!b) continue
        const said = saidIn(o, b)
        if (said) items.push({ role: 'assistant', text: clip(said, 4000), at })
        else if (b.type === 'tool_use') {
          const name = str(b.name)
          const turn: ToolTurn = {
            role: 'tool',
            label: toolLabel(name),
            detail: toolDetail(name, b.input),
            path: toolPath(name, b.input),
            done: false,
            at,
          }
          const ask = name === 'AskUserQuestion' ? questionsOf(b.input) : null
          if (ask)
            Object.assign(turn, {
              id: str(b.id),
              ask: ask.map(({ question, header, multiSelect }) => ({ question, header, multiSelect })),
              answers: null,
            })
          tools.set(str(b.id), turn)
          items.push(turn)
        }
      }
    }
  }
  return items.slice(-limit)
}
