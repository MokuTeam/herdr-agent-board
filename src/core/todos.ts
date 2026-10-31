// Tasks (#202): a list of what is still open across sessions, kept on each session's card. The
// user pins points out of an agent's answer in the sheet (for themself, or as the agent's
// promise); with agents on, an agent records what it hands the user and its own deferred promises
// with `board todo`. An experiment: off unless config.json's `todos` turns it on, and then
// `{ "agents": false }` keeps the agents out of it (no brief line, `board todo add` refused).

/** Whose it is: the user's to do, or the agent's promise. */
export type TodoOwner = 'user' | 'agent'
/** Who did something to it: the user on the board, or the agent with `board todo`. */
export type TodoBy = 'user' | 'agent'

export interface Todo {
  id: string
  /** The point itself, as the message says it (the quote the panel shows). */
  text: string
  owner: TodoOwner
  by: TodoBy
  /** When it was made. */
  at: number
  /** The message it came from: its transcript id (Claude) and its time; none from `board todo`. */
  anchor?: { id?: string; at?: number }
  /** When it was done, and by whom; absent while open. */
  done?: number
  doneBy?: TodoBy
}

export interface TodosConfig {
  /** Agents take part: the brief tells them, `board todo add` works. */
  agents: boolean
}

/** config.json's `todos`: `true` is everything on; an object is on, `agents: false` the user's pins only; else off. */
export function todosConfig(raw: unknown): TodosConfig | null {
  if (raw === true) return { agents: true }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return { agents: (raw as Record<string, unknown>).agents !== false }
}

/** The modes Settings → Tasks offers: off, the user's pins only, agents too. */
export const TODO_MODES = ['none', 'mine', 'agents'] as const
export type TodoMode = (typeof TODO_MODES)[number]
export const isTodoMode = (v: unknown): v is TodoMode => TODO_MODES.includes(v as TodoMode)
export const todoModeOf = (c: TodosConfig | null): TodoMode => (!c ? 'none' : c.agents ? 'agents' : 'mine')

/** The longest point kept: a pinned paragraph is cut there. */
export const TODO_TEXT_MAX = 500
/** Done points kept on a card, newest first; older ones go. */
export const DONE_KEPT = 30
/** Done points go after this long. */
export const DONE_KEPT_MS = 14 * 24 * 3600_000

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function isTodo(v: unknown): v is Todo {
  if (!isRecord(v)) return false
  return (
    typeof v.id === 'string' &&
    typeof v.text === 'string' &&
    (v.owner === 'user' || v.owner === 'agent') &&
    (v.by === 'user' || v.by === 'agent') &&
    typeof v.at === 'number'
  )
}

/** A card's points, whatever its file holds. */
export const todosOf = (raw: unknown): Todo[] => (Array.isArray(raw) ? raw.filter(isTodo) : [])

export type TodoOp =
  | { op: 'add'; text: string; owner: TodoOwner; by: TodoBy; anchor?: Todo['anchor'] }
  | { op: 'done'; id: string; by: TodoBy }
  | { op: 'reopen'; id: string }
  | { op: 'remove'; id: string }

/** A point's text as kept: one line of words, cut at TODO_TEXT_MAX. */
export function cleanTodoText(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > TODO_TEXT_MAX ? `${one.slice(0, TODO_TEXT_MAX - 1)}…` : one
}

/**
 * `list` after `op`, or an error key. Adding the same open point from the same message again
 * changes nothing (a double click). An agent may close only its own promises, never the user's
 * points. Done points past DONE_KEPT or DONE_KEPT_MS go.
 */
export function applyTodo(
  list: readonly Todo[],
  op: TodoOp,
  now: number,
  newId: () => string,
): { list: Todo[]; todo?: Todo } | { error: string } {
  let next = [...list]
  let todo: Todo | undefined
  if (op.op === 'add') {
    const text = cleanTodoText(op.text)
    if (!text) return { error: 'todo.err.empty' }
    todo = next.find(
      x => !x.done && x.text === text && x.anchor?.id === op.anchor?.id && x.anchor?.at === op.anchor?.at,
    )
    if (!todo) {
      todo = { id: newId(), text, owner: op.owner, by: op.by, at: now, ...(op.anchor && { anchor: op.anchor }) }
      next.push(todo)
    }
  } else {
    todo = next.find(x => x.id === op.id)
    if (!todo) return { error: 'todo.err.gone' }
    if (op.op === 'done') {
      if (op.by === 'agent' && todo.owner !== 'agent') return { error: 'todo.err.notYours' }
      if (!todo.done) {
        const done: Todo = { ...todo, done: now, doneBy: op.by }
        next = next.map(x => (x === todo ? done : x))
        todo = done
      }
    } else if (op.op === 'reopen') {
      const { done: _d, doneBy: _b, ...open } = todo
      next = next.map(x => (x === todo ? open : x))
      todo = open
    } else next = next.filter(x => x !== todo)
  }
  return { list: prune(next, now), ...(todo && { todo }) }
}

/** Open points all; done ones within DONE_KEPT_MS, at most DONE_KEPT of them. */
function prune(list: Todo[], now: number): Todo[] {
  const keep = new Set(
    list
      .filter(x => x.done && now - x.done < DONE_KEPT_MS)
      .sort((a, b) => (b.done ?? 0) - (a.done ?? 0))
      .slice(0, DONE_KEPT),
  )
  return list.filter(x => !x.done || keep.has(x))
}

/**
 * The points of a message, as the user may pin them: its list items (bulleted or numbered, at any
 * depth, a task box's "[ ]" dropped), outside code blocks; a message without a list is one point,
 * its first paragraph. Markdown's emphasis marks go; the words stay.
 */
export function messagePoints(text: string): string[] {
  const points: string[] = []
  let fence = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const m = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/)
    if (m?.[1]) points.push(plain(m[1]))
  }
  if (points.length) return points.filter(Boolean)
  const first = text
    .split(/\n\s*\n/)
    .map(p => plain(p))
    .find(Boolean)
  return first ? [cleanTodoText(first)] : []
}

/** Markdown's emphasis and heading marks off, the words kept. */
const plain = (s: string): string =>
  cleanTodoText(
    s
      .replace(/^#+\s+/, '')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'),
  )

/** The brief's line for agents, with agents on. */
export function todosBrief(): string {
  return [
    '- board todo add "<text>": the user keeps a task list across sessions. Record only what you hand the user to do (a step that is theirs, data they must give) and, with --mine, a promise of your own you defer to later ("after the review I\'ll run the migration"). Nothing else: not your working steps, not questions (those are board ask).',
    "  board todo done <id> closes your own; board todo list shows this session's open ones. The user closes theirs on the board.",
  ].join('\n')
}

/** The open points first, oldest first; then the done ones, newest first. */
export function sortTodos(list: readonly Todo[]): Todo[] {
  const open = list.filter(x => !x.done).sort((a, b) => a.at - b.at)
  const done = list.filter(x => x.done).sort((a, b) => (b.done ?? 0) - (a.done ?? 0))
  return [...open, ...done]
}
