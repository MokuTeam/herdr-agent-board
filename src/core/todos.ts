// Tasks (#202): a list of what is still open across sessions, kept on each session's card. The
// user pins points out of an agent's answer in the sheet (for themself, or as the agent's
// promise); with agents on, an agent records what it hands the user and its own deferred promises
// with `board todo`. An experiment: off unless config.json's `todos` turns it on, and then
// `{ "agents": false }` keeps the agents out of it (no brief line, `board todo add` refused).
//
// #319: each point has a number on its card (`n`, counted up by the card's `todoSeq`), shown as a
// key `<lane>-<session>-<n>` the user and the agent both see; an agent records what it refers to
// (`ref`) and what it waits on (`why`). An agent that sees one of the user's points done proposes
// closing it, with why, and the user confirms or keeps it open; with `autoClose` it closes it.

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
  /** Its number on its card (#319): the end of its key. */
  n?: number
  /** What it is about: a ticket, a file, a link (#319). */
  ref?: string
  /** What it waits on, or why it is open (#319). */
  why?: string
  /** An agent's word that it is done, for the user to confirm (#319): when, and what settled it. */
  proposed?: { at: number; why?: string }
  /** What settled it, as the agent said when it closed it or proposed to. */
  doneWhy?: string
}

export interface TodosConfig {
  /** Agents take part: the brief tells them, `board todo add` works. */
  agents: boolean
  /** Agents close the user's points themselves instead of proposing it (#319). */
  autoClose?: boolean
}

/** config.json's `todos`: `true` is everything on; an object is on, `agents: false` the user's pins only; else off. */
export function todosConfig(raw: unknown): TodosConfig | null {
  if (raw === true) return { agents: true }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const agents = r.agents !== false
  return agents && r.autoClose === true ? { agents, autoClose: true } : { agents }
}

/** The modes Settings → Tasks offers: off, the user's pins only, agents too, agents closing too. */
export const TODO_MODES = ['none', 'mine', 'agents', 'auto'] as const
export type TodoMode = (typeof TODO_MODES)[number]
export const isTodoMode = (v: unknown): v is TodoMode => TODO_MODES.includes(v as TodoMode)
export const todoModeOf = (c: TodosConfig | null): TodoMode =>
  !c ? 'none' : !c.agents ? 'mine' : c.autoClose ? 'auto' : 'agents'

/** The longest point kept: a pinned paragraph is cut there. */
export const TODO_TEXT_MAX = 500
/** The longest `ref` and `why` kept. */
export const TODO_NOTE_MAX = 300
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
    typeof v.at === 'number' &&
    (v.n === undefined || (Number.isInteger(v.n) && (v.n as number) > 0))
  )
}

/** A card's points, whatever its file holds. */
export const todosOf = (raw: unknown): Todo[] => (Array.isArray(raw) ? raw.filter(isTodo) : [])

export type TodoOp =
  | { op: 'add'; text: string; owner: TodoOwner; by: TodoBy; anchor?: Todo['anchor']; ref?: string; why?: string }
  /** `why`: what settled it (an agent's). `auto`: an agent closes the user's point instead of proposing it. */
  | { op: 'done'; id: string; by: TodoBy; why?: string; auto?: boolean }
  | { op: 'reopen'; id: string }
  /** The user keeps a point an agent proposed to close open (#319). */
  | { op: 'keep'; id: string }
  | { op: 'remove'; id: string }

/** A point's text as kept: one line of words, cut at TODO_TEXT_MAX. */
export function cleanTodoText(text: string, max = TODO_TEXT_MAX): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** A `ref` or `why` as kept: one line, cut at TODO_NOTE_MAX; none when empty. */
const note = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : cleanTodoText(text, TODO_NOTE_MAX) || undefined

/**
 * Every point numbered (#319): those without a number (made before numbers, in the order they were
 * made) get the next ones after `seq` and every number given; `seq` is the last number given, kept
 * on the card so a number is never given twice once its point is gone. The same list and `seq`
 * always number the same way, so the board shows the numbers a later change writes.
 */
export function numberTodos(list: readonly Todo[], seq = 0): { list: Todo[]; seq: number } {
  let last = list.reduce((m, x) => Math.max(m, x.n ?? 0), Number.isInteger(seq) && seq > 0 ? seq : 0)
  const order = list
    .filter(x => x.n === undefined)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (!order.length) return { list: [...list], seq: last }
  const given = new Map(order.map(x => [x, ++last]))
  return { list: list.map(x => ({ ...x, n: given.get(x) ?? (x.n as number) })), seq: last }
}

/** A name as a key's part: lower case, words joined by '-'. */
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

/**
 * A point's key (#319): `<lane>-<session>-<n>`, the lane left out when the session's name starts
 * with it already (`genetix-14601-2`, not `genetix-genetix-14601-2`). Without a number: its id.
 */
export function todoKey(session: { category?: string | undefined; name?: string | undefined }, x: Todo): string {
  if (!x.n) return x.id
  const lane = slug(session.category ?? '')
  const name = slug(session.name ?? '')
  const head = !lane ? name : !name || name === lane || name.startsWith(`${lane}-`) ? name || lane : `${lane}-${name}`
  return head ? `${head}-${x.n}` : String(x.n)
}

/**
 * The point a word names (#319): its id, its key or its number alone (`12`, `#12`, `…-12`), the
 * card's own points only. None when nothing, or more than one id, matches.
 */
export function findTodo(list: readonly Todo[], word: string): Todo | undefined {
  const w = word.trim()
  if (!w) return undefined
  const byId = list.find(x => x.id === w)
  if (byId) return byId
  const m = w.match(/(?:^|[-#])(\d+)$/)
  const n = m ? Number(m[1]) : NaN
  return Number.isInteger(n) ? list.find(x => x.n === n) : undefined
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
  seq = 0,
): { list: Todo[]; todo?: Todo; seq: number } | { error: string } {
  const numbered = numberTodos(list, seq)
  let next = numbered.list
  let last = numbered.seq
  let todo: Todo | undefined
  const put = (x: Todo): void => {
    const was = todo
    next = next.map(y => (y === was ? x : y))
    todo = x
  }
  if (op.op === 'add') {
    const text = cleanTodoText(op.text)
    if (!text) return { error: 'todo.err.empty' }
    todo = next.find(
      x => !x.done && x.text === text && x.anchor?.id === op.anchor?.id && x.anchor?.at === op.anchor?.at,
    )
    if (!todo) {
      const ref = note(op.ref)
      const why = note(op.why)
      todo = {
        id: newId(),
        text,
        owner: op.owner,
        by: op.by,
        at: now,
        n: ++last,
        ...(op.anchor && { anchor: op.anchor }),
        ...(ref && { ref }),
        ...(why && { why }),
      }
      next.push(todo)
    }
  } else {
    todo = next.find(x => x.id === op.id)
    if (!todo) return { error: 'todo.err.gone' }
    if (op.op === 'done') {
      const why = note(op.why)
      if (todo.done) {
        // Done already: nothing to change.
      } else if (op.by === 'agent' && todo.owner !== 'agent' && !op.auto) {
        // The user's point: the agent proposes, the user confirms (#319).
        put({ ...todo, proposed: { at: now, ...(why && { why }) } })
      } else {
        const { proposed, ...rest } = todo
        const settled = why ?? proposed?.why
        put({ ...rest, done: now, doneBy: op.by, ...(settled && { doneWhy: settled }) })
      }
    } else if (op.op === 'reopen' || op.op === 'keep') {
      const { done: _d, doneBy: _b, doneWhy: _w, proposed: _p, ...open } = todo
      put(open)
    } else next = next.filter(x => x !== todo)
  }
  return { list: prune(next, now), seq: last, ...(todo && { todo }) }
}

/** An agent's point the user must still confirm done (#319). */
export const isProposed = (x: Todo): boolean => !x.done && !!x.proposed

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
    '- board todo add [--ref <ticket, file or link>] [--why "<what it waits on>"] "<text>": the user keeps a task list across sessions. Record only what you hand the user to do (a step that is theirs, data they must give) and, with --mine, a promise of your own you defer to later ("after the review I\'ll run the migration"). Nothing else: not your working steps, not questions (those are board ask). Give --ref whenever a ticket, a draft file or a link is involved. It prints the task\'s key (<lane>-<session>-<n>): name tasks by their key when you talk about them.',
    `  ${TODO_CLOSE}`,
  ].join('\n')
}

/** How an agent closes points: the brief's line and the open points' line say it. */
const TODO_CLOSE =
  'board todo done <key> --why "<what settled it>": closes your own; on one of the user\'s, it tells the user it is done (they confirm on the board). Do it as soon as you see a task is done (a comment posted, a file sent, an answer given) instead of telling the user to close it. board todo list shows this session\'s open ones.'

/**
 * The open points' line for the agent's next prompt (#319): its open points with their keys, once
 * per change of them (`todosSeen`: their ids and whether each is proposed), so it closes what it
 * sees done. None when there are none and it was told nothing, or nothing changed.
 */
export function todosNews(
  card: { category?: string; name?: string; todos?: unknown; todoSeq?: unknown; todosSeen?: unknown } | null,
): { line: string | null; seen: string } | null {
  if (!card) return null
  const { list } = numberTodos(todosOf(card.todos), Number(card.todoSeq) || 0)
  const open = sortTodos(list).filter(x => !x.done)
  const seen = open.map(x => `${x.id}${x.proposed ? '?' : ''}`).join(',')
  if (seen === (typeof card.todosSeen === 'string' ? card.todosSeen : '')) return null
  if (!open.length) return { line: null, seen }
  const rows = open.map(x => {
    const whose = x.owner === 'agent' ? 'yours' : x.proposed ? "the user's, you proposed it done" : "the user's"
    return `  ${todoKey(card, x)} · ${whose} · ${x.text}${x.ref ? ` · ref ${x.ref}` : ''}`
  })
  return { line: [`[agent-board] This session's open tasks on the board. ${TODO_CLOSE}`, ...rows].join('\n'), seen }
}

/** The open points first, oldest first; then the done ones, newest first. */
export function sortTodos(list: readonly Todo[]): Todo[] {
  const open = list.filter(x => !x.done).sort((a, b) => a.at - b.at)
  const done = list.filter(x => x.done).sort((a, b) => (b.done ?? 0) - (a.done ?? 0))
  return [...open, ...done]
}
