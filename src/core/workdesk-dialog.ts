import {
  object,
  validAssignmentId,
  validTaskId,
  type WorkdeskMcpConfig,
  workdeskConfig,
  workdeskMcpConfig,
} from './workdesk.ts'
import { stableWorkdeskSid } from './workdesk-topology.ts'

export const OWNER_EVENT_LIMIT = 50
export const DIALOG_TOOLS = ['list_owner_events', 'read_owner_messages', 'ack_owner_messages'] as const

type OwnerKind = 'message' | 'choice' | 'rework'
export type OwnerEvent = {
  id: number
  board_task_id: number
  assignment_id: string
  revision: number
  executor: string | null
  board_status: string
  kind: OwnerKind
  created_at: number
}

export type OwnerMessage = {
  id: number
  revision: number
  kind: OwnerKind
  text: string
  question_id: number | null
  option_id: string | null
  created_at: number
}

export type LegacyDialogBinding = {
  taskId: number
  assignmentId: string
  threadId: string
  sessionId: string
}

export type WorkdeskDialogConfig = WorkdeskMcpConfig & {
  legacyBindings: Map<number, LegacyDialogBinding>
  onlyTaskId?: number
  receiver?: 'launcher'
}

/** Use the same transport and credential as W1, with an independent poll interval. */
export function workdeskDialogConfig(raw: unknown, source: unknown): WorkdeskDialogConfig | null {
  const dialog = object(raw)
  const watch = workdeskConfig(source)
  if (!dialog || !watch) return null
  const { intervalSec = 60, legacyBindings: entries = [], onlyTaskId = watch.onlyTaskId, receiver, deliver } = dialog
  const mcp = workdeskMcpConfig({ ...watch, intervalSec })
  if (
    !mcp ||
    !Array.isArray(entries) ||
    (onlyTaskId !== undefined && !validTaskId(onlyTaskId)) ||
    (watch.onlyTaskId !== undefined && onlyTaskId !== watch.onlyTaskId) ||
    (receiver !== undefined && (receiver !== 'launcher' || !validTaskId(onlyTaskId))) ||
    (deliver !== undefined && (receiver !== 'launcher' || typeof deliver !== 'boolean'))
  )
    return null
  const legacyBindings = new Map<number, LegacyDialogBinding>()
  const assignments = new Set<string>()
  const threads = new Set<string>()
  for (const entry of entries) {
    const pin = object(entry)
    if (!pin) return null
    const { taskId, assignmentId, threadId, sessionId } = pin
    if (
      !validTaskId(taskId) ||
      !validAssignmentId(assignmentId) ||
      !validAssignmentId(threadId) ||
      !stableWorkdeskSid(sessionId) ||
      legacyBindings.has(taskId) ||
      assignments.has(assignmentId) ||
      threads.has(threadId)
    )
      return null
    legacyBindings.set(taskId, { taskId, assignmentId, threadId, sessionId })
    assignments.add(assignmentId)
    threads.add(threadId)
  }
  return { ...mcp, legacyBindings, ...(onlyTaskId !== undefined && { onlyTaskId }), ...(receiver && { receiver }) }
}

export type DialogTarget = { task_id: number; assignment_id: string; executor: string; thread_id: string; sid: string }
export const sameDialogTarget = (a: DialogTarget, b: DialogTarget): boolean =>
  a.task_id === b.task_id &&
  a.assignment_id === b.assignment_id &&
  a.executor === b.executor &&
  a.thread_id === b.thread_id &&
  a.sid === b.sid

type Page<T> = { entries: T[]; cursor: number; more: boolean }

export type DialogProblem =
  | 'config'
  | 'connection'
  | 'tools'
  | 'role_denied'
  | 'list'
  | 'invalid_page'
  | 'invalid_cursor'
  | 'store'
  | 'awaiting_claim'
  | 'assignment_unverified'
  | 'legacy_source_unavailable'
  | 'assignment_mismatch'
  | 'executor_changed'
  | 'thread_missing'
  | 'thread_reassigned'
  | 'thread_scope'
  | 'wake'
  | 'session_unavailable'
  | 'threads_disabled'
  | 'protected_delivery_unavailable'
  | 'protected_delivery_failed'
  | 'read'
  | 'ack'

export type DialogStatus = {
  delivery: 'awaiting_recipient' | 'recipient_attached'
  deliverEnabled?: boolean
  pending: number | null
  more: boolean | null
  polledAt: number | null
  problem: DialogProblem | null
  blocked: Partial<Record<DialogProblem, number>>
}

function kindOf(kind: unknown): kind is OwnerKind {
  return kind === 'message' || kind === 'choice' || kind === 'rework'
}

export const validCursor = (n: unknown): n is number => n === 0 || validTaskId(n)

function boardStatus(value: unknown): value is string {
  return value === 'queued' || value === 'doing' || value === 'waiting' || value === 'done' || value === 'failed'
}

function page<T extends { id: number }>(
  raw: Record<string, unknown> | null,
  field: string,
  after: number,
  parse: (value: unknown) => T | null,
): Page<T> | null {
  const rows = raw?.[field]
  const more = raw?.more
  if (!Array.isArray(rows) || rows.length > OWNER_EVENT_LIMIT || typeof more !== 'boolean') return null
  const entries: T[] = []
  let cursor = after
  for (const row of rows) {
    const entry = parse(row)
    if (!entry || entry.id <= cursor) return null
    cursor = entry.id
    entries.push(entry)
  }
  return raw?.cursor === cursor && (!more || entries.length !== 0) ? { entries, cursor, more } : null
}

export function ownerEvents(raw: unknown, after: number): Page<OwnerEvent> | null {
  return page(object(raw), 'events', after, value => {
    const metadata = object(value)
    if (!metadata) return null
    const { id, board_task_id, assignment_id, revision, executor, board_status, kind, created_at } = metadata
    if (
      !validTaskId(id) ||
      !validTaskId(board_task_id) ||
      !validAssignmentId(assignment_id) ||
      !validTaskId(revision) ||
      (executor !== null && (typeof executor !== 'string' || !executor)) ||
      !boardStatus(board_status) ||
      !kindOf(kind) ||
      !validCursor(created_at)
    )
      return null
    return { id, board_task_id, assignment_id, revision, executor, board_status, kind, created_at }
  })
}

export function ownerMessages(
  raw: unknown,
  target: DialogTarget,
  after: number,
): (Page<OwnerMessage> & { revision: number; deliveredThrough: number }) | null {
  const body = object(raw)
  if (
    !body ||
    body.task_id !== target.task_id ||
    body.assignment_id !== target.assignment_id ||
    body.executor !== target.executor ||
    !validTaskId(body.revision) ||
    !boardStatus(body.status) ||
    !validCursor(body.delivered_through) ||
    body.delivered_through < after
  )
    return null
  const revision = body.revision
  const parsed = page(body, 'messages', after, value => {
    const payload = object(value)
    if (!payload) return null
    const { id, revision: messageRevision, kind, text, question_id, option_id, created_at } = payload
    if (
      !validTaskId(id) ||
      !validTaskId(messageRevision) ||
      messageRevision > revision ||
      !kindOf(kind) ||
      typeof text !== 'string' ||
      !validCursor(created_at)
    )
      return null
    if (kind === 'choice') {
      if (!validTaskId(question_id) || typeof option_id !== 'string' || !option_id) return null
    } else if (question_id !== null || option_id !== null) return null
    return { id, revision: messageRevision, kind, text, question_id, option_id, created_at }
  })
  return parsed && { ...parsed, revision, deliveredThrough: body.delivered_through }
}
