// Turns that reach a session as a prompt but were not typed by a person: Claude Code's
// <task-notification> when a background command, agent, monitor or workflow reports back, and
// the board's own reminders (core/schedule-rules.ts promptOf). The detail view shows them as a
// line of their own, and they never count as the user answering.

const DETAIL_LIMIT = 4000

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// Claude Code escapes <, > and & inside the tags; &amp; last, so "&amp;lt;" stays "&lt;".
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }
const unescapeTags = (s: string): string =>
  s.replace(/&(lt|gt|quot|apos|#39);/g, (m, e: string) => ENTITIES[e] ?? m).replace(/&amp;/g, '&')

function tag(text: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)
  return m ? unescapeTags((m[1] ?? '').trim()) : ''
}

export type TaskKind = 'command' | 'agent' | 'monitor' | 'workflow' | 'mcp' | 'task'

// What reported back, by its summary.
const KINDS: [TaskKind, RegExp][] = [
  ['command', /^Background (?:shell )?command\b/],
  ['agent', /^(?:Background )?agents?\b|^\d+ background agents\b|\bbackground agent "/i],
  ['monitor', /^Monitor\b/],
  ['workflow', /^(?:Dynamic )?workflow\b/i],
  ['mcp', /^MCP task\b/],
]

// How a summary usually ends after the task's name; anything else is worth showing (a reason, a limit).
const PLAIN_END =
  /^(?:finished|completed(?: \(exit code -?\d+\))?|failed(?: with exit code -?\d+)?|stream ended|was stopped)\.?$/

/** A background task reporting back (see taskNotice). */
export interface TaskNotice {
  kind: TaskKind
  /** completed | failed | killed | stopped | event (a monitor's new lines) */
  status: string
  /** The task's own description, as quoted in the summary ('' when it has none). */
  name: string
  /** A command's exit code, or null. */
  exit: number | null
  summary: string
  /** What the summary says beyond the usual ending: why it failed, a turn limit. */
  note: string
  /** An agent's final report or a monitor's event lines, clipped. */
  detail: string
  /** The task's output file. */
  file: string
  /** The task's id: a monitor or a resumed agent reports again under the same one. */
  id: string
}

/** A reminder the board typed in (see reminderNotice). */
export interface ReminderNotice {
  kind: 'reminder' | 'schedule'
  status: 'event'
  /** The reminder's text. */
  name: string
  /** The session that set it, '' for the session itself. */
  from: string
  cron: string
  note: string
}

export type Notice = TaskNotice | ReminderNotice

/** A board reminder, not a background task. */
export const isReminder = (n: Notice): n is ReminderNotice => n.kind === 'reminder' || n.kind === 'schedule'

/**
 * A task notification as { kind, status, name, exit, summary, note, detail, file, id }, or null
 * when the text is not one or says nothing.
 *   kind     command | agent | monitor | workflow | mcp | task
 *   status   completed | failed | killed | stopped | event (a monitor's new lines)
 *   name     the task's own description, as quoted in the summary ('' when it has none)
 *   exit     a command's exit code, or null
 *   note     what the summary says beyond the usual ending: why it failed, a turn limit
 *   detail   an agent's final report or a monitor's event lines, clipped
 *   file     the task's output file
 *   id       the task's id: a monitor or a resumed agent reports again under the same one
 */
export function taskNotice(text: unknown): TaskNotice | null {
  const t = String(text ?? '').trim()
  if (!t.startsWith('<task-notification>')) return null
  const summary = tag(t, 'summary')
  if (!summary) return null // nothing to show
  const kind = KINDS.find(([, re]) => re.test(summary))?.[0] ?? 'task'
  const event = tag(t, 'event')
  const status = tag(t, 'status') || (event ? 'event' : 'completed')
  let name = ''
  let rest = ''
  if (kind === 'mcp') {
    const m = /\(([^)]+)\)\s*(.*)$/.exec(summary)
    if (m) [name, rest] = [m[1] ?? '', m[2] ?? '']
  } else if (!/^\d+ background agents\b/i.test(summary)) {
    // From the first quote to the last: a name can hold quotes of its own.
    const m = /^[^"]*"(.*)"([^"]*)$/.exec(summary)
    if (m) [name, rest] = [m[1] ?? '', m[2] ?? '']
  }
  rest = rest.trim().replace(/^failed:\s*/, '')
  const exit = /exit code (-?\d+)/.exec(summary)
  return {
    kind,
    status,
    name: clip(name, 200),
    exit: exit ? Number(exit[1]) : null,
    summary: clip(summary, 300),
    note: name && rest && !PLAIN_END.test(rest) ? clip(rest, 300) : '',
    detail: clip(tag(t, 'result') || event, DETAIL_LIMIT),
    file: tag(t, 'output-file'),
    id: tag(t, 'task-id'),
  }
}

/**
 * A reminder the board typed in (core/schedule-rules.ts promptOf), "[board reminder from X; notes]
 * text" or "[board schedule <id> from X: <cron>; notes] text", as
 * { kind: 'reminder' | 'schedule', status: 'event', name: text, from, cron, note }. Null for
 * anything else.
 */
export function reminderNotice(text: unknown): ReminderNotice | null {
  // A session name may hold brackets of its own: one level of them is fine.
  const m = /^\[board (reminder|schedule)\b((?:[^[\]]|\[[^\]]*\])*)\]\s*([\s\S]*)$/.exec(String(text ?? '').trim())
  if (!m) return null
  const kind = m[1] === 'schedule' ? 'schedule' : 'reminder'
  const [head = '', ...notes] = (m[2] ?? '').split(';')
  let rest = head
  let cron = ''
  if (kind === 'schedule') {
    rest = rest.replace(/^\s*[^\s:]+/, '') // the entry's id
    // The cron is the last five fields; a name may hold ": " too.
    const c = /:\s*((?:\S+\s+){4}\S+)\s*$/.exec(rest)
    if (c) [cron, rest] = [c[1] ?? '', rest.slice(0, c.index)]
  }
  return {
    kind,
    status: 'event',
    name: clip((m[3] ?? '').trim(), 1000),
    from: /^\s*from (.+)$/.exec(rest)?.[1]?.trim() ?? '',
    cron,
    note: clip(notes.join(';').trim(), 300),
  }
}

/** True for a prompt the user did not type: a task notification or a board reminder. */
export const isNotice = (text: unknown): boolean => !!(taskNotice(text) || reminderNotice(text))
