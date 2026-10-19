// The user's messages waiting in Claude Code's queue, read from the transcript (Claude Code logs
// the queue there): the session's detail shows them at the foot of its thread until Claude takes
// them in. Pure: the file reading lives with the adapter (adapters/claude-home.ts sessionThread).
import { boardNotice, taskNotice } from './notices.ts'
import { userText } from './transcript.ts'

/** A message still in the queue, oldest first; `at`: when it was queued (ms). */
export interface QueuedPrompt {
  text: string
  at: number
}

/**
 * The window a queue lives in: nothing from before `since` (when its Claude process started), nor
 * from before `idleSince` (when Claude last said its turn was over, which empties the queue).
 */
export interface QueueWindow {
  since?: number
  idleSince?: number
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' ? (v as Rec) : null)
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function parse(line: string): Rec | null {
  try {
    return rec(JSON.parse(line))
  } catch {
    return null
  }
}

// Turns that reach a session through its queue but are nobody's typing: they have a line of their own in the thread, or none.
const SYSTEM_TAG = /^\s*<(?:task-notification|cross-session-message|agent-message|teammate-message|channel)\b/
const promptText = (p: unknown): string =>
  typeof p === 'string'
    ? p
    : Array.isArray(p)
      ? p
          .map(rec)
          .filter(b => b?.type === 'text')
          .map(b => b?.text)
          .join('\n')
      : ''

// The lines the queue is read from: its operations, the user's lines and attachments, Claude
// Code's system lines, and the calls that set up a scheduled prompt.
const QUEUE_LINE = /"type":"(?:queue-operation|user|attachment|system)"|"name":"(?:CronCreate|ScheduleWakeup)"/

interface Pending {
  content: string
  /** The enqueue's own timestamp, as written: an agents_killed line at the same one marks it. */
  ts: unknown
  at: number
  system: boolean
}

/**
 * The user's messages still waiting in Claude Code's queue: sent while the session worked (in its
 * terminal or from the board) and not taken in yet, [{ text, at }] oldest first. Claude Code logs
 * the queue in the transcript: `enqueue` with the text, then `dequeue` (the turn is over: the
 * message comes next as a user line of its own, which says which one went), `remove` (taken
 * into the running turn, absorbed_mid_turn, and kept as a queued_command attachment), or `popAll`
 * (pulled back into the input box). Task notifications, other sessions' messages, board
 * reminders and scheduled prompts go the same way; they are left out. A queue goes with its
 * Claude process: nothing from before `since` (when it started), nor from before `idleSince`
 * (when it last said its turn was over, which empties the queue).
 */
export function queuedPrompts(text: unknown, { since = 0, idleSince = 0 }: QueueWindow = {}): QueuedPrompt[] {
  const pending: Pending[] = []
  const scheduled = new Set<string>() // prompts a CronCreate or ScheduleWakeup call set up, or that came in as a meta line
  let owed = 0 // dequeues whose user line has not come yet
  const find = (s: string) => pending.findIndex(p => p.content === s)
  const take = (i: number) => {
    if (i >= 0) pending.splice(i, 1)
  }
  const own = (p: Pending): boolean => {
    if (p.system || scheduled.has(p.content) || SYSTEM_TAG.test(p.content) || p.content.startsWith('[Cross-session '))
      return false
    const said = userText(p.content)
    return !!said && !taskNotice(said) && !boardNotice(said)
  }
  for (const line of String(text ?? '').split('\n')) {
    if (!QUEUE_LINE.test(line)) continue
    const o = parse(line)
    if (!o || o.isSidechain) continue
    if (o.type === 'queue-operation') {
      const content = typeof o.content === 'string' ? o.content : ''
      if (o.operation === 'enqueue')
        pending.push({ content, ts: o.timestamp, at: Date.parse(String(o.timestamp)) || 0, system: false })
      else if (o.operation === 'dequeue') owed++
      else if (o.operation === 'remove') take(find(content))
      else if (o.operation === 'popAll') {
        // Back into the input box, all at once, their texts joined.
        const back = pending.filter(p => p.content && content.includes(p.content))
        for (const p of back.length ? back : pending.filter(own)) take(pending.indexOf(p))
      }
    } else if (o.type === 'system') {
      // "Background agent … was stopped by the user" goes into the queue as the agents are killed.
      if (o.subtype === 'agents_killed') for (const p of pending) if (p.ts === o.timestamp) p.system = true
    } else if (o.type === 'attachment') {
      const a = rec(o.attachment)
      if (a?.type === 'queued_command') take(find(promptText(a.prompt)))
    } else if (o.type === 'assistant') {
      const content = rec(o.message)?.content
      for (const raw of Array.isArray(content) ? content : []) {
        const b = rec(raw)
        const input = rec(b?.input)
        if (
          b?.type === 'tool_use' &&
          (b.name === 'CronCreate' || b.name === 'ScheduleWakeup') &&
          typeof input?.prompt === 'string'
        )
          scheduled.add(input.prompt)
      }
    } else if (o.type === 'user') {
      const content = rec(o.message)?.content
      if (Array.isArray(content) && content.every(b => rec(b)?.type === 'tool_result')) continue
      const said = promptText(content)
      if (o.isMeta) scheduled.add(said)
      let i = find(said)
      // A dequeued prompt Claude Code wrote down otherwise (a slash command): the oldest one went.
      if (i < 0 && owed && rec(o.origin)?.kind === 'human') i = pending.findIndex(own)
      take(i)
      if (owed) owed--
    }
  }
  return pending
    .filter(p => p.at >= since && p.at >= idleSince && own(p))
    .map(p => ({ text: clip(userText(p.content), 3000), at: p.at }))
}
