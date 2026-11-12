// A harness's task board as threads (#393, docs/design/threads 13.1). MokuPilot and the pi
// task-board package keep one file per agent session, ~/.agent-boards/<harness>/<session>.json, in
// the "agent-board" format, version 1:
//   { format, version, harness, session_id, writer, revision, next_id, updated_at,
//     items: [{ id, text, status: doing|next|done, owner, owner_id, parent_id?, note?,
//               created_at, started_at, done_at, updated_at }] }   (times: ISO 8601)
// `board thread import <file>` makes a thread of each item, and the board mirrors a pi day's file
// one way. Pure: what the file says, item by item; services/thread-import.ts writes the threads.
import { SAFE_NAME, TASK_BOARD_FORMAT, TASK_BOARD_VERSION } from './call-agent.ts'
import { cleanText, clip, oneLine, SUMMARY_MAX, TEXT_MAX, type ThreadStatus, TITLE_MAX } from './work-threads.ts'

export type TaskStatus = 'doing' | 'next' | 'done'
const TASK_STATUSES: ReadonlySet<unknown> = new Set<TaskStatus>(['doing', 'next', 'done'])

/** An item of a task board as a thread takes it. Times in milliseconds, null where the file has none. */
export interface TaskItem {
  id: string
  /** The item's text, whole. */
  text: string
  status: TaskStatus
  /** Who it was handed to: the name, and the session's id when the file gives one. */
  owner: { id: string; name: string } | null
  /** The root item it is a step of; '' for a root, also for a step whose root is not in the file. */
  parent: string
  note: string
  createdAt: number | null
  startedAt: number | null
  doneAt: number | null
  updatedAt: number | null
}

export interface TaskFile {
  harness: string
  session: string
  items: TaskItem[]
  /** Items left out: no id, no text, a status the format does not have, an id seen before. */
  skipped: number
}

/**
 * What an import last read of an item. Run again, an import applies only what changed in the file
 * since then, so a status, a summary or a title set on the board stays until the file changes it.
 */
export interface Seen {
  text: string
  note: string
  status: TaskStatus
  owner: { id: string; name: string } | null
  parent: string
  updatedAt: number | null
}

/** Where an imported thread came from (3.2 `origin`); `mirrored` on one the board copies from pi's file. */
export interface AgentBoardOrigin {
  agentBoard: { harness: string; session: string; id: string; seen?: Seen }
  mirrored?: true
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

/** A time as the file writes it: ISO 8601 (MokuPilot), or a number of seconds or milliseconds. */
export function timeOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? Math.round(v * 1000) : Math.round(v)
  if (typeof v !== 'string' || !v.trim()) return null
  const t = Date.parse(v.trim())
  return Number.isFinite(t) ? t : null
}

/** A refusal of the whole file, with the reason. */
export class TaskFileError extends Error {}

/**
 * The items of a task file. `named`: the harness and session its path says (`<harness>/<session>.json`),
 * used where the file does not say them. Throws TaskFileError for a file that is not a task board,
 * or of a version newer than this reader knows.
 */
export function parseTaskFile(raw: unknown, named: { harness: string; session: string }): TaskFile {
  const d = rec(raw)
  if (!d || d.format !== TASK_BOARD_FORMAT) throw new TaskFileError('not a task board: its format is not "agent-board"')
  const v = d.version
  if (v !== undefined && !(Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= TASK_BOARD_VERSION))
    throw new TaskFileError(`a task board of version ${String(v)}: this board reads version ${TASK_BOARD_VERSION}`)
  const harness = SAFE_NAME.test(str(d.harness)) ? str(d.harness) : named.harness
  const session = SAFE_NAME.test(str(d.session_id)) ? str(d.session_id) : named.session
  if (!SAFE_NAME.test(harness) || !SAFE_NAME.test(session))
    throw new TaskFileError('the file names no harness and session, and its path does not either')
  const items: TaskItem[] = []
  const seen = new Set<string>()
  let skipped = 0
  for (const x of Array.isArray(d.items) ? d.items : []) {
    const r = rec(x)
    const id = oneLine(str(r?.id), 200)
    const text = cleanText(str(r?.text), TEXT_MAX)
    if (!r || !id || !oneLine(text, 10) || !TASK_STATUSES.has(r.status) || seen.has(id)) {
      skipped++
      continue
    }
    seen.add(id)
    const ownerName = oneLine(str(r.owner), 200)
    const ownerId = oneLine(str(r.owner_id), 200)
    items.push({
      id,
      text,
      status: r.status as TaskStatus,
      owner: ownerName || ownerId ? { id: ownerId, name: ownerName } : null,
      parent: oneLine(str(r.parent_id), 200),
      note: oneLine(str(r.note), 10_000),
      createdAt: timeOf(r.created_at),
      startedAt: timeOf(r.started_at),
      doneAt: timeOf(r.done_at),
      updatedAt: timeOf(r.updated_at),
    })
  }
  // One level, as MokuPilot reads its own file: a step whose root is missing or is a step itself is a root.
  const roots = new Set(items.filter(i => !i.parent).map(i => i.id))
  for (const i of items) if (i.parent && (!roots.has(i.parent) || i.parent === i.id)) i.parent = ''
  return { harness, session, items, skipped }
}

/** The title an item's text gives (cut at 80), and the whole text when it had to be cut. */
export function titleOfText(text: string): { title: string; whole: string } {
  const line = oneLine(text, 10_000)
  return line.length > TITLE_MAX ? { title: clip(line, TITLE_MAX), whole: text } : { title: line, whole: '' }
}

/** An item's note as a thread's summary, one line of 160 characters at most. */
export const summaryOfNote = (note: string): string => clip(oneLine(note, 10_000), SUMMARY_MAX)

/** A thread's status as a task board would write it: waiting and needing the owner are still doing. */
export function taskStatusOf(s: ThreadStatus): TaskStatus {
  if (s === 'next') return 'next'
  if (s === 'done' || s === 'dropped') return 'done'
  return 'doing'
}

export const seenOf = (item: TaskItem): Seen => ({
  text: item.text,
  note: item.note,
  status: item.status,
  owner: item.owner,
  parent: item.parent,
  updatedAt: item.updatedAt,
})

export const sameSeen = (a: Seen, b: Seen): boolean => JSON.stringify(a) === JSON.stringify(b)

export const originOf = (
  file: Pick<TaskFile, 'harness' | 'session'>,
  item: TaskItem,
  mirrored: boolean,
): AgentBoardOrigin => ({
  agentBoard: { harness: file.harness, session: file.session, id: item.id, seen: seenOf(item) },
  ...(mirrored && { mirrored: true as const }),
})

function seenFrom(v: unknown): Seen | undefined {
  const s = rec(v)
  if (!s || typeof s.text !== 'string' || typeof s.note !== 'string' || typeof s.parent !== 'string') return undefined
  if (!TASK_STATUSES.has(s.status)) return undefined
  const o = rec(s.owner)
  return {
    text: s.text,
    note: s.note,
    status: s.status as TaskStatus,
    owner: o && typeof o.id === 'string' && typeof o.name === 'string' ? { id: o.id, name: o.name } : null,
    parent: s.parent,
    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : null,
  }
}

/** The item a thread was imported from, or null for a thread made on the board. */
export function agentBoardOf(origin: unknown): AgentBoardOrigin | null {
  const o = rec(origin)
  const a = rec(o?.agentBoard)
  if (!a || typeof a.harness !== 'string' || typeof a.session !== 'string' || typeof a.id !== 'string') return null
  const seen = seenFrom(a.seen)
  return {
    agentBoard: { harness: a.harness, session: a.session, id: a.id, ...(seen && { seen }) },
    ...(o?.mirrored === true && { mirrored: true as const }),
  }
}

/** A thread the board copies from a pi task board: it changes there, never on the board. */
export const isMirrored = (h: { origin?: unknown }): boolean => agentBoardOf(h.origin)?.mirrored === true
