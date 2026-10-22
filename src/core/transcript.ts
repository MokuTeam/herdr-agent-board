// Reading what Claude Code wrote into a transcript (JSONL lines): the end of it for a card, the
// last turns for the detail view. Pure: the file reading lives with the adapter.

import { type FormQuestion, questionsOf } from './dialogs/question-form.ts'
import { t } from './lang.ts'
import { boardNotice, isNotice, type Notice, taskNotice } from './notices.ts'
import { DEFAULT_PROMPT_FILTERS, type PromptFilter } from './prompt-filters.ts'
import {
  type CallLinks,
  linkOf,
  linkResult,
  type Peer,
  peerOf,
  promptOf,
  teammateMessages,
} from './transcript-links.ts'
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

/** The files a meta line of a prompt names as its images ("[Image: source: <path>]"). */
function imageSources(content: unknown): string[] {
  const blocks = Array.isArray(content) ? content.map(b => str(rec(b)?.text)) : [str(content)]
  return blocks.flatMap(text => [...text.matchAll(/\[Image: source: ([^\]\n]+)\]/g)].map(m => m[1] ?? ''))
}

/** A message with its images named again: their "[Image #N]" marks out, their paths on lines under it. */
function withImages(text: string, ids: readonly number[], sources: readonly string[]): string {
  const named = new Set(ids.slice(0, sources.length))
  const rest = text.replace(/\[Image #(\d+)\] ?/g, (mark, n) => (named.has(Number(n)) ? '' : mark))
  return `${rest}\n${sources.join('\n')}`
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
    // Pasted text comes between <pasted_content id="…"> and </pasted_content id="…">: the text only.
    .replace(/<pasted_content id="[^"]*">\n?|\n?<\/pasted_content id="[^"]*">/g, '')
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
 *   lastAt    the time of the newest user or assistant line
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
    if (info.lastAt === undefined && (o.type === 'user' || o.type === 'assistant')) {
      const at = Date.parse(str(o.timestamp))
      if (at) info.lastAt = at
    }
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
  /** Only when the thread's budget cut its text (fitThread). */
  cut?: true
}
export interface AssistantTurn {
  role: 'assistant'
  text: string
  at: number
  /** Only when the thread's budget cut its text (fitThread). */
  cut?: true
}
/** A tool call; one that works with others carries what it is about (core/transcript-links.ts). */
export interface ToolTurn extends CallLinks {
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
/** Another session's or a teammate's message; `cut` only when the thread's budget cut it (fitThread). */
export type PeerTurn = Peer & { role: 'peer'; at: number; cut?: true }
export type ConversationTurn = UserTurn | AssistantTurn | ToolTurn | NoticeTurn | PeerTurn

/**
 * The most message text (prompts, answers and other sessions' messages, in characters) a thread
 * carries (#174). Messages come whole; a thread over it, as one with a pasted log of hundreds of
 * KB, has its longest messages cut to one length until it fits (fitThread), so the detail read on
 * every step stays small. The longest real message measured was under 20,000 characters, the most
 * in one real thread about 60,000.
 */
export const THREAD_TEXT_BUDGET = 100_000

type MessageTurn = UserTurn | AssistantTurn | PeerTurn
const isMessage = (t: ConversationTurn): t is MessageTurn =>
  t.role === 'user' || t.role === 'assistant' || t.role === 'peer'

/** `s` cut to `n` characters with "…" at the end, never between the halves of a character (an emoji). */
function clipWhole(s: string, n: number): string {
  let end = Math.max(n - 1, 0)
  const last = s.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${s.slice(0, end)}…`
}

/**
 * `turns` with their messages within `budget` (THREAD_TEXT_BUDGET): only the longest are cut, all
 * to the same length, and say so (`cut`).
 */
export function fitThread(turns: ConversationTurn[], budget = THREAD_TEXT_BUDGET): ConversationTurn[] {
  const sizes = turns.flatMap(t => (isMessage(t) ? [t.text.length] : []))
  if (sizes.reduce((a, b) => a + b, 0) <= budget) return turns
  // Shortest first: a message that fits in its share of what is left stays whole.
  sizes.sort((a, b) => a - b)
  let left = budget
  let cap = 0
  for (const [i, size] of sizes.entries()) {
    const share = Math.floor(left / (sizes.length - i))
    if (size > share) {
      // At least the "…": a budget under one character a message cannot be kept anyway.
      cap = Math.max(share, 1)
      break
    }
    left -= size
  }
  return turns.map(t => (isMessage(t) && t.text.length > cap ? { ...t, text: clipWhole(t.text, cap), cut: true } : t))
}

export interface ConversationOptions {
  /** A helper's own transcript (adapters/helpers.ts), whose lines are all sidechain lines. */
  sidechain?: boolean
}

/** What tells one notice from another: the copy a queued notice leaves when it is sent again matches. */
function noticeKey(n: Notice): string {
  const field = (name: string): unknown => (name in n ? Reflect.get(n, name) : null)
  return JSON.stringify([
    n.kind,
    field('id'),
    n.status,
    n.name,
    field('summary'),
    field('detail'),
    field('from'),
    n.note,
  ])
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
 * null when it was closed without one. Background tasks reporting back, board reminders and
 * MokuPilot call results come as { role: 'notice', ...taskNotice() or boardNotice() }
 * (core/notices.ts). A call that works
 * with others carries what it is about, for a line of its own: `helper` (Agent: a subagent or a
 * fork, `id` once it started), `workflow`, `send` (SendMessage), `spawn` (spawn-agent started a
 * session). Another session's or a teammate's message is { role: 'peer', from, text }.
 * `sidechain` reads a helper's own transcript (adapters/helpers.ts), whose lines are all
 * sidechain lines.
 */
export function parseConversation(
  lines: string[],
  limit = 40,
  { sidechain = false }: ConversationOptions = {},
): ConversationTurn[] {
  const items: ConversationTurn[] = []
  const tools = new Map<string, ToolTurn>() // tool_use id -> item
  // Another session's message can be queued into a turn and come again as a line of its own.
  const peers = new Set<string>()
  const pipes = new Map<string, string>() // a sender's message pipe -> its name: a reply goes to the pipe
  const peer = (p: Peer, at: number) => {
    // Without an id, the same words twice are two messages unless they come at the same moment.
    const key = p.id || JSON.stringify([p.from, p.text, at])
    if (peers.has(key)) return
    peers.add(key)
    if (p.pipe && p.from) pipes.set(p.pipe, p.from)
    items.push({ role: 'peer', ...p, at })
  }
  // A background task reporting back or a board reminder: a line of its own (core/notices.ts). One
  // can be queued into a running turn and then sent again as a turn of its own: shown once. A
  // task id alone is not enough, a monitor or a resumed agent reports again under the same one.
  const shown = new Set<string>()
  const keys = new WeakMap<ConversationTurn, string>() // notice item -> its key
  // The user's last message, for the images Claude Code names in a meta line of the same prompt.
  let lastUser: { prompt: string; ids: number[]; item: UserTurn } | null = null
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
    // Claude Code keeps another session's message, and in a helper's transcript a task reporting
    // back, as a meta line: they are shown all the same.
    const kind = rec(o?.origin)?.kind
    // Claude Code takes an image's path out of a prompt (an "[Image #16]" in its place) and names the
    // file in a meta line of the same prompt: the path goes back under the message, as it was sent,
    // where its preview comes from.
    if (o?.isMeta && o.turnCompanion && o.type === 'user') {
      const sources = imageSources(rec(o.message)?.content)
      if (sources.length && lastUser && lastUser.prompt === str(o.promptId))
        lastUser.item.text = withImages(lastUser.item.text, lastUser.ids, sources)
      continue
    }
    if (
      !o ||
      (o.isSidechain && !sidechain) ||
      (o.isMeta && kind !== 'peer' && kind !== 'task-notification') ||
      o.isCompactSummary
    )
      continue
    const content = rec(o.message)?.content
    const at = Date.parse(str(o.timestamp)) || 0
    // A prompt sent while the session worked goes into the running turn, and the transcript
    // keeps it as a queued command, not a user line. Other sessions' messages and task
    // notifications arrive the same way.
    if (o.type === 'attachment') {
      const a = rec(o.attachment)
      if (a?.type !== 'queued_command') continue
      const when = Date.parse(str(a.timestamp)) || at
      if (rec(a.origin)?.kind === 'peer') {
        const p = peerOf(a.origin, a.prompt)
        if (p) peer(p, when)
        continue
      }
      const task = a.commandMode === 'task-notification' ? taskNotice(a.prompt) : null
      if (task) notice(task, when)
      const text = a.commandMode === 'prompt' && rec(a.origin)?.kind !== 'peer' ? userText(a.prompt) : ''
      const reminder = boardNotice(text)
      const prev = items.at(-1)
      if (reminder) notice(reminder, when)
      else if (text && !(prev?.role === 'user' && prev.text === text)) items.push({ role: 'user', text, at: when })
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
          linkResult(tool, b, o.toolUseResult)
        }
        if (content.every(b => rec(b)?.type === 'tool_result')) continue
      }
      if (kind === 'peer') {
        const p = peerOf(o.origin, userText(content))
        if (p) peer(p, at)
        continue
      }
      let text = userText(content)
      // A task reporting back can come after a banner that says it is not the user.
      if (kind === 'task-notification' && text.indexOf('<task-notification>') > 0)
        text = text.slice(text.indexOf('<task-notification>'))
      const mates = teammateMessages(text)
      if (mates.length) {
        for (const m of mates) peer(m, at)
        continue
      }
      if (sidechain) {
        // A fork's transcript starts with its parent's call that made it: its own work begins
        // with its directive.
        if (text.trimStart().startsWith('<fork-boilerplate>')) items.length = 0
        const p = promptOf(text)
        if (!p) continue
        text = p.prompt
      }
      const n = taskNotice(text) ?? boardNotice(text)
      if (n) notice(n, at)
      else if (text) {
        const item: UserTurn = { role: 'user', text, at }
        items.push(item)
        const ids = Array.isArray(o.imagePasteIds) ? o.imagePasteIds.filter(n => typeof n === 'number') : []
        lastUser = { prompt: str(o.promptId), ids, item }
      }
    } else if (Array.isArray(content)) {
      for (const raw of content) {
        const b = rec(raw)
        if (!b) continue
        const said = saidIn(o, b)
        if (said) items.push({ role: 'assistant', text: said, at })
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
          const link = linkOf(name, b.input)
          if (link) Object.assign(turn, { id: str(b.id) }, link)
          // A reply to the pipe a message came from goes to whoever sent that message.
          if (link?.send?.to.startsWith('uds:')) link.send.name = pipes.get(link.send.to) ?? ''
          tools.set(str(b.id), turn)
          items.push(turn)
        }
      }
    }
  }
  return items.slice(-limit)
}
