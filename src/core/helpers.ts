// A session's helpers: the subagents, forks, workflow agents and in-process teammates Claude Code
// ran for it, as their own files say (adapters/helpers.ts reads them). Pure: the start and the end
// of a helper's transcript, how it stands, what it is, what a card shows of them.

import { toolDetail, toolLabel } from './transcript.ts'
import { promptOf } from './transcript-links.ts'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' ? (v as Rec) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const blocksOf = (content: unknown): unknown[] => (Array.isArray(content) ? content : [])
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function parse(line: string): Rec | null {
  try {
    return rec(JSON.parse(line))
  } catch {
    return null
  }
}

/** Text of a message's content: a string, or its text blocks. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content)
    ? content
        .filter(b => rec(b)?.type === 'text')
        .map(b => rec(b)?.text)
        .join('\n')
    : ''
}

/**
 * What a block of a message says, as the terminal shows it: the text, and the short updates
 * Claude Code keeps in thinking blocks when the entry has thinkingDisplay "updates". The same rule
 * as the session's own (upstream claude.mjs saidIn, from the thinking-updates change).
 */
function saidIn(entry: Rec, block: Rec): string {
  if (block.type === 'text') return str(block.text).trim()
  if (block.type === 'thinking' && entry.thinkingDisplay === 'updates') return str(block.thinking).trim()
  return ''
}

export type HelperKind = 'agent' | 'fork' | 'workflow' | 'teammate'
export type HelperStatus = 'running' | 'idle' | 'done' | 'failed' | 'stopped'
/** Where a helper's transcript ends (tailInfo). */
export type TailEnd = 'end' | 'tool' | 'waiting' | 'background' | 'interrupted' | 'error' | 'none'

/** A call that runs: its tool, label and detail as the thread shows them. */
export interface HelperCall {
  name: string
  label: string
  detail: string
}

export interface HeadInfo {
  startedAt: number | null
  prompt: string
  /** The teammate who asked. */
  from: string
}

/** The start of a helper's transcript: when it started and what it was asked. */
export function headInfo(text: unknown): HeadInfo {
  let startedAt: number | null = null
  let prompt = ''
  let from = ''
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue
    const o = parse(line)
    if (!o) continue
    if (startedAt == null && o.timestamp) startedAt = Date.parse(str(o.timestamp)) || null
    if (o.type !== 'user') continue
    const p = promptOf(textOf(rec(o.message)?.content))
    if (!p?.prompt) continue
    ;({ prompt, from } = p)
    break
  }
  return { startedAt, prompt: clip(prompt, 600), from }
}

export interface TailInfo {
  last: TailEnd
  now: HelperCall | null
  after: string
  tokens: number | null
  result: string
  endedAt: number | null
  /** last: background — how many background tasks of its own are still out. */
  waiting?: number
}

/**
 * Where a helper's transcript ends: what it does now, and how far it got.
 *   last      end (its final answer) | tool (a call runs) | waiting (the model is on it) |
 *             background (its turn ended, a background task of its own is still out: `waiting`
 *             says how many) | interrupted (stopped by the user) | error (an API error) | none
 *   now       the call that runs: { name, label, detail }, or null
 *   after     the last call before the model's turn now, for "thinking after Read"
 *   tokens    the last request's context and answer, as Claude Code counts a subagent's tokens
 *   result    its last words, clipped
 *   endedAt   the time of its last message
 */
export function tailInfo(text: unknown): TailInfo {
  const info: TailInfo = { last: 'none', now: null, after: '', tokens: null, result: '', endedAt: null }
  const results = new Set<string>() // tool_use ids with a result later in the file
  const names = new Map<string, string>() // tool_use id -> tool name, for the result the transcript ends on
  let lastResult: string | null = null // the tool_use id of a result the transcript ends on
  const source = String(text ?? '')
  const lines = source.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue
    const o = parse(line)
    if (!o || (o.type !== 'user' && o.type !== 'assistant')) continue
    const message = rec(o.message)
    const content = message?.content
    if (info.endedAt == null) info.endedAt = Date.parse(str(o.timestamp)) || null
    if (o.type === 'user') {
      const blocks = blocksOf(content)
      for (const b of blocks) if (rec(b)?.type === 'tool_result') results.add(str(rec(b)?.tool_use_id))
      if (info.last === 'none') {
        const said = textOf(content)
        if (/\[Request interrupted by user/.test(said)) info.last = 'interrupted'
        else {
          const first = blocks.map(rec).find(b => b?.type === 'tool_result')
          lastResult = first ? str(first.tool_use_id) : null
          info.last = 'waiting'
        }
      }
      continue
    }
    const synthetic = !!o.isApiErrorMessage || message?.model === '<synthetic>'
    const blocks = blocksOf(content)
    if (info.last === 'none') {
      const reason = message?.stop_reason
      info.last = synthetic
        ? 'error'
        : blocks.some(b => rec(b)?.type === 'tool_use')
          ? 'tool'
          : reason === 'end_turn' || reason === 'stop_sequence' || reason === 'max_tokens'
            ? 'end'
            : 'waiting'
    }
    const u = rec(message?.usage)
    if (info.tokens == null && !synthetic && u) {
      const n =
        num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens)
      if (n) info.tokens = n
    }
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = rec(blocks[j])
      if (!b) continue
      if (b.type === 'tool_use') {
        const name = str(b.name)
        names.set(str(b.id), name)
        if (!info.now && !info.after) {
          const call = { name, label: toolLabel(name), detail: toolDetail(name, b.input) }
          if (results.has(str(b.id))) info.after = call.label
          else info.now = call
        }
      } else if (!info.result && !synthetic && saidIn(o, b)) info.result = clip(saidIn(o, b), 400)
    }
    if (info.tokens != null && (info.now || info.after) && info.result) break
  }
  // A workflow agent ends by handing its structured output back.
  if (info.last === 'waiting' && lastResult && names.get(lastResult) === 'StructuredOutput') info.last = 'end'
  // A helper that ended its turn with a background command still out is not done: Claude Code
  // wakes it with that command's notification. (Agents it started are helpers of their own:
  // helpersOf looks at them.)
  if (info.last === 'end') {
    const out = backgroundTasks(source)
    if (out) Object.assign(info, { last: 'background', waiting: out })
  }
  if (info.last !== 'tool') info.now = null
  return info
}

/** How many background commands a transcript started that have not reported back. */
export function backgroundTasks(text: unknown): number {
  const started = new Set<string>()
  const back: string[] = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.includes('Command running in background') && !line.includes('<task-id>') && !line.includes('"TaskStop"'))
      continue
    const o = parse(line)
    // A task stopped on purpose (TaskStop) does not report back.
    if (o?.type === 'assistant') {
      for (const raw of blocksOf(rec(o.message)?.content)) {
        const b = rec(raw)
        const id = rec(b?.input)?.task_id
        if (b?.type === 'tool_use' && b.name === 'TaskStop' && id) back.push(`<task-id>${String(id)}</task-id>`)
      }
      continue
    }
    const attachment = rec(o?.attachment)
    if (o?.type === 'attachment' && attachment?.commandMode === 'task-notification') {
      back.push(String(attachment.prompt ?? ''))
      continue
    }
    if (o?.type !== 'user') continue
    const content = rec(o.message)?.content
    // Only what the tool itself answered: a file the helper read can hold the same words.
    for (const raw of blocksOf(content)) {
      const b = rec(raw)
      if (b?.type !== 'tool_result') continue
      const said =
        typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? b.content.map(c => rec(c)?.text ?? '').join('')
            : ''
      const m = /^Command running in background with ID: ([\w-]+)/.exec(said.trim())
      if (m?.[1]) started.add(m[1])
    }
    // A notification is a turn of its own, never a tool's result: a meta line marked as one (a
    // banner comes before its tag), or a turn that is nothing else.
    const said = textOf(content).trim()
    if (rec(o.origin)?.kind === 'task-notification' || said.startsWith('<task-notification>')) back.push(said)
  }
  for (const text of back) for (const m of text.matchAll(/<task-id>([\w-]+)<\/task-id>/g)) started.delete(m[1] ?? '')
  return started.size
}

export interface StatusInput {
  meta?: Rec
  tail?: Partial<TailInfo>
  kind: HelperKind
  /** The session's Claude process runs. */
  alive?: boolean
  /** When that process started (ms), or null. */
  since?: number | null
  mtimeMs?: number
  now?: number
}

/**
 * How a helper stands: running | idle (a teammate waiting for a message) | done | failed |
 * stopped. One that never got to its end runs only while its session's process does, and only
 * when that process wrote to it: a helper the previous process left behind (the session slept
 * or restarted) is stopped.
 */
export function helperStatus({
  meta = {},
  tail = {},
  kind,
  alive = false,
  since = null,
  mtimeMs = 0,
  now = Date.now(),
}: StatusInput): HelperStatus {
  if (meta.stoppedByUser) return 'stopped'
  if (tail.last === 'end') return kind === 'teammate' && alive && !(since && mtimeMs < since) ? 'idle' : 'done'
  if (tail.last === 'interrupted') return 'stopped'
  if (tail.last === 'error') return 'failed'
  // Its turn is over but its background work goes on (last: background): like a turn that runs,
  // it is at work while the session's process can still wake it; after an hour without a word,
  // the notification went elsewhere or never came.
  if (tail.last === 'background' && now - mtimeMs > 3_600_000) return 'done'
  if (meta.finished && tail.last !== 'background') return 'done'
  if (!alive || (since && mtimeMs < since)) return 'stopped'
  // Six hours without a word from a call or the model: it hung, or its end went unrecorded.
  if (now - mtimeMs > 6 * 3_600_000) return 'stopped'
  return 'running'
}

/** What a helper is, from its meta file. */
export interface HelperIdentity {
  id: string
  kind: HelperKind
  type: string
  name: string
  description: string
  /** A teammate's own color: a plain color name, else ''. */
  color: string
  model: string
  background: boolean
  /** The helper that started it, or null. */
  parent: string | null
  /** The call that made it. */
  toolUseId: string | null
  /** The workflow run it is an agent of. */
  workflow: string | null
  phase: string
}

/** What a helper is, from its meta file: { kind, type, name, description, ... }. */
export function describe(id: string, meta: Rec = {}, workflow: { run: string } | null = null): HelperIdentity {
  const kind: HelperKind =
    meta.taskKind === 'in_process_teammate'
      ? 'teammate'
      : workflow
        ? 'workflow'
        : meta.isFork || meta.agentType === 'fork'
          ? 'fork'
          : 'agent'
  // A teammate's agentType is its own name; the agent it runs as comes after.
  const type =
    kind === 'teammate'
      ? meta.customAgentType || meta.spawnedAgentType || ''
      : kind === 'agent'
        ? meta.agentType || ''
        : ''
  const color = typeof meta.color === 'string' && /^[a-z]{3,12}$/.test(meta.color) ? meta.color : ''
  return {
    id,
    kind,
    type: String(type).slice(0, 80),
    name: String(meta.name ?? '').slice(0, 80),
    description: clip(String(meta.description ?? ''), 200),
    color,
    model: meta.model && meta.model !== 'inherit' ? String(meta.model).slice(0, 60) : '',
    background: meta.requestShape === 'background',
    parent: typeof meta.parentAgentId === 'string' ? meta.parentAgentId : null,
    toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : null,
    workflow: workflow?.run ?? null,
    phase: String(meta.workflowPhase ?? '').slice(0, 80),
  }
}

/** A helper as the page gets it (no file path). */
export interface PublicHelper extends HelperIdentity {
  status: HelperStatus
  startedAt: number | null
  endedAt: number | null
  activity: number
  prompt: string
  from: string
  now: HelperCall | null
  after: string
  /** Background tasks (and agents of its own) it waits for. */
  waiting: number
  tokens: number | null
  result: string
}

/** A helper as the server keeps it: with its transcript's path. */
export interface Helper extends PublicHelper {
  path: string
}

/** A workflow run of the session. */
export interface WorkflowRun {
  id: string
  name: string
  status: HelperStatus
  summary: string
  startedAt: number
  endedAt: number
  activity: number
  tokens: number | null
  tools: number | null
  agents: number
  taskId: string
}

export interface Helpers {
  helpers: Helper[]
  workflows: WorkflowRun[]
}

/** What a card shows of a session's helpers (summarize). */
export interface HelperSummary {
  running: number
  total: number
  workflows: number
  live: { id: string; kind: HelperKind; label: string; color: string }[]
  at: number
}

/** What a card needs: how many run now, how many there are, the newest few that run. */
export function summarize({
  helpers = [],
  workflows = [],
}: {
  helpers?: PublicHelper[]
  workflows?: WorkflowRun[]
} = {}): HelperSummary | null {
  const live = helpers.filter(h => h.status === 'running')
  const runs = workflows.filter(w => w.status === 'running')
  if (!helpers.length && !workflows.length) return null
  return {
    running: live.length,
    total: helpers.length,
    workflows: runs.length,
    live: live
      .slice(0, 4)
      .map(h => ({ id: h.id, kind: h.kind, label: h.description || h.name || h.type, color: h.color })),
    // Moves whenever a running helper writes: the open sheet reads its helpers again then.
    at: Math.max(0, ...live.map(h => h.activity), ...runs.map(w => w.activity)),
  }
}

/** Helpers as the page gets them: no file paths. */
export const publicHelper = ({ path, ...h }: Helper): PublicHelper => h

/** One helper for its window: how many tool calls it made, its workflow run and its conversation. */
export interface HelperDetail<Turn> {
  helper: PublicHelper & { tools: number }
  workflow: WorkflowRun | null
  conversation: Turn[]
}
