import { randomUUID } from 'node:crypto'
import type { ScheduleEntry } from '../core/schedule-rules.ts'
import { isMirrored } from '../core/thread-import.ts'
import type { Item } from '../core/types.ts'
import type { WorkdeskTask } from '../core/workdesk.ts'
import {
  type DialogProblem,
  type DialogTarget,
  type LegacyDialogBinding,
  type OwnerEvent,
  type OwnerMessage,
  sameDialogTarget,
} from '../core/workdesk-dialog.ts'
import { workdeskAgent } from '../core/workdesk-topology.ts'
import { type BoardDb, openDb, type Tx } from './db.ts'
import { addEntry, listEntries, updateEntry } from './schedule-store.ts'
import { appendEntry, getThread } from './work-thread-store.ts'
import { workdeskHandoffReader } from './workdesk-store.ts'

type Handoff = NonNullable<ReturnType<ReturnType<typeof workdeskHandoffReader>>>
type Binding = DialogTarget & { revision: number; acknowledged: number }
type Pending = { board_task_id: number; assignment_id: string; count: number }
type Wake = { id: string; task_id: number; assignment_id: string; schedule_id: string | null; released: number }
const PARKED = 8_640_000_000_000_000
type Resolved = { binding: Binding } | { problem: DialogProblem }

/**
 * Only a protected reader can supply this, after establishing its durable recipient and
 * authenticated read path. It must stage synchronously using tx, never through the common
 * work thread. The board server does not yet have a sink with those guarantees.
 */
export interface ProtectedDialogSink {
  permits(target: DialogTarget): boolean
  stage(tx: Tx, target: DialogTarget, message: OwnerMessage): void
  /** A replay must still be readable by the current protected recipient before it can be ACKed. */
  contains(tx: Tx, target: DialogTarget, message: OwnerMessage): boolean
}

export function workdeskDialogStore(db: BoardDb, items: () => readonly Item[] | null) {
  const cursor = () =>
    db.db.query<{ cursor: number }, []>('SELECT cursor FROM workdesk_dialog_cursor WHERE singleton = 1').get()
      ?.cursor ?? 0
  const findBinding = db.db.query<Binding, [number]>('SELECT * FROM workdesk_dialog_bindings WHERE task_id = ?')

  const latestEvent = db.db.query<{ executor: string | null }, [number, string]>(`
    SELECT executor FROM workdesk_dialog_events WHERE board_task_id = ? AND assignment_id = ? ORDER BY id DESC LIMIT 1
  `)

  function localTarget(handoff: Handoff, target: DialogTarget): DialogProblem | null {
    const thread = getThread(db, target.thread_id)
    if (!thread) return 'thread_missing'
    if (thread.scope !== 'local' || isMirrored(thread)) return 'thread_scope'
    if (
      thread.id !== handoff.thread_id ||
      thread.assignee?.kind !== 'session' ||
      thread.assignee.key !== handoff.session_key ||
      thread.assignee.name !== target.executor
    )
      return 'thread_reassigned'
    const matches = items()?.filter(item => item.session === target.sid || item.key === handoff.session_key) ?? []
    const item = matches[0]
    if (
      matches.length !== 1 ||
      item?.session !== target.sid ||
      item.key !== handoff.session_key ||
      !workdeskAgent(item.agent)
    )
      return 'session_unavailable'
    return null
  }

  function resolve(group: Pending): Resolved {
    const handoff = workdeskHandoffReader(db)(group.board_task_id)
    if (!handoff?.thread_id) return { problem: 'awaiting_claim' }
    const binding = findBinding.get(group.board_task_id)
    if (!binding) return { problem: 'assignment_unverified' }
    if (binding.assignment_id !== group.assignment_id) return { problem: 'assignment_mismatch' }
    const latest = latestEvent.get(group.board_task_id, group.assignment_id)
    if (binding.executor !== handoff.executor || (latest?.executor && latest.executor !== binding.executor))
      return { problem: 'executor_changed' }
    const problem = localTarget(handoff, binding)
    return problem ? { problem } : { binding }
  }

  function current(group: Pending, expected: Binding): Resolved {
    const resolved = resolve(group)
    if ('problem' in resolved) return resolved
    const { binding } = resolved
    return sameDialogTarget(binding, expected) ? resolved : { problem: 'assignment_mismatch' }
  }

  return {
    cursor,
    retain(after: number, entries: OwnerEvent[], through: number): boolean {
      return db.write('workdesk-dialog', ({ db: sql }) => {
        if (cursor() !== after) return false
        const insert = sql.query(`INSERT INTO workdesk_dialog_events
          (id, board_task_id, assignment_id, revision, executor, board_status, kind, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        for (const e of entries)
          insert.run(
            e.id,
            e.board_task_id,
            e.assignment_id,
            e.revision,
            e.executor,
            e.board_status,
            e.kind,
            e.created_at,
          )
        if (entries.length)
          sql
            .query(`INSERT INTO workdesk_dialog_cursor VALUES (1, ?)
                     ON CONFLICT(singleton) DO UPDATE SET cursor = excluded.cursor`)
            .run(through)
        return true
      })
    },
    pending(onlyTaskId?: number): Pending[] {
      return db.db
        .query<Pending, [number | null]>(`
          SELECT board_task_id, assignment_id, COUNT(*) AS count
          FROM workdesk_dialog_events
          WHERE (?1 IS NULL OR board_task_id = ?1)
          GROUP BY board_task_id, assignment_id ORDER BY MIN(id)
        `)
        .all(onlyTaskId ?? null)
    },
    adoptLegacy(group: Pending, pin: LegacyDialogBinding, task: WorkdeskTask): Resolved {
      return db.write('workdesk-dialog', ({ db: sql }) => {
        if (findBinding.get(group.board_task_id)) return resolve(group)
        const handoff = workdeskHandoffReader(db)(pin.taskId)
        if (!handoff?.thread_id) return { problem: 'awaiting_claim' }
        if (handoff.thread_id !== pin.threadId) return { problem: 'thread_reassigned' }
        // Old handoffs can be adopted only when their original key is itself a verified native SID.
        if (handoff.session_key !== pin.sessionId) return { problem: 'session_unavailable' }
        if (
          group.board_task_id !== pin.taskId ||
          group.assignment_id !== pin.assignmentId ||
          task.id !== pin.taskId ||
          task.assignment?.id !== pin.assignmentId
        )
          return { problem: 'assignment_mismatch' }
        if (task.status === 'queued' || task.executor !== handoff.executor) return { problem: 'executor_changed' }
        const binding: Binding = {
          task_id: pin.taskId,
          assignment_id: pin.assignmentId,
          executor: handoff.executor,
          thread_id: pin.threadId,
          sid: pin.sessionId,
          revision: task.assignment.revision,
          acknowledged: 0,
        }
        const problem = localTarget(handoff, binding)
        if (problem) return { problem }
        const latest = latestEvent.get(group.board_task_id, group.assignment_id)
        if (!latest || (latest.executor !== null && latest.executor !== binding.executor))
          return { problem: 'executor_changed' }
        sql
          .query(`INSERT INTO workdesk_dialog_bindings (task_id, assignment_id, executor, thread_id, sid, revision)
                   VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
          .run(
            binding.task_id,
            binding.assignment_id,
            binding.executor,
            binding.thread_id,
            binding.sid,
            binding.revision,
          )
        return resolve(group)
      })
    },
    resolve,
    current,
    permitsRead(target: DialogTarget): boolean {
      const resolved = resolve({ board_task_id: target.task_id, assignment_id: target.assignment_id, count: 0 })
      return 'binding' in resolved && sameDialogTarget(target, resolved.binding)
    },
    notice(group: Pending, expected: Binding, now: number): DialogProblem | null {
      return db.write('workdesk-dialog', tx => {
        const resolved = current(group, expected)
        if ('problem' in resolved) return resolved.problem
        tx.db
          .query(`
          UPDATE workdesk_dialog_bindings
          SET revision = MAX(revision, COALESCE((
            SELECT MAX(revision) FROM workdesk_dialog_events
            WHERE board_task_id = ?1 AND assignment_id = ?2 AND kind = 'rework'
          ), revision))
          WHERE task_id = ?1 AND assignment_id = ?2
        `)
          .run(expected.task_id, expected.assignment_id)
        const updated = tx.db
          .query(`
          UPDATE workdesk_dialog_events SET noticed = 1 WHERE board_task_id = ? AND assignment_id = ? AND noticed = 0
        `)
          .run(expected.task_id, expected.assignment_id)
        if (updated.changes)
          appendEntry(tx, expected.thread_id, {
            type: 'note',
            author: { kind: 'owner' },
            at: now,
            text: 'В Workdesk появилось обновление диалога по этой карточке.',
          })
        return null
      })
    },
    stage(
      group: Pending,
      expected: Binding,
      revision: number,
      messages: OwnerMessage[],
      through: number,
      sink: ProtectedDialogSink,
      queueWake = false,
    ): DialogProblem | null {
      return db.write('workdesk-dialog', tx => {
        const resolved = current(group, expected)
        if ('problem' in resolved) return resolved.problem
        const { binding } = resolved
        if (binding.acknowledged !== expected.acknowledged || binding.revision > revision) return 'invalid_page'
        if (!sink.permits(binding)) return 'protected_delivery_unavailable'
        const known = tx.db
          .query<OwnerEvent, [number, string, number, number]>(`
          SELECT * FROM workdesk_dialog_events
          WHERE board_task_id = ? AND assignment_id = ? AND id > ? AND id <= ?
        `)
          .all(binding.task_id, binding.assignment_id, binding.acknowledged, through)
        const page = new Map(messages.map(message => [message.id, message]))
        if (
          known.some(event => {
            const message = page.get(event.id)
            return message?.kind !== event.kind || message.revision !== event.revision
          })
        )
          return 'invalid_page'
        const receipt = tx.db.query('INSERT OR IGNORE INTO workdesk_dialog_receipts VALUES (?, ?)')
        let added = false
        for (const message of messages) {
          if (receipt.run(binding.assignment_id, message.id).changes) {
            sink.stage(tx, binding, message)
            added = true
          } else if (!sink.contains(tx, binding, message)) throw new Error('Protected Workdesk receipt unavailable')
        }
        if (added && queueWake)
          tx.db
            .query('INSERT INTO workdesk_dialog_wakes (id, task_id, assignment_id) VALUES (?, ?, ?)')
            .run(randomUUID(), binding.task_id, binding.assignment_id)
        tx.db.query('UPDATE workdesk_dialog_bindings SET revision = ? WHERE task_id = ?').run(revision, binding.task_id)
        return null
      })
    },
    wakeAllowed(entry: ScheduleEntry, permits: (target: DialogTarget) => boolean): boolean {
      if (typeof entry.workdeskDialogWake !== 'string') return false
      const row = db.db
        .query<Wake, [string]>('SELECT * FROM workdesk_dialog_wakes WHERE id = ?')
        .get(entry.workdeskDialogWake)
      if (!row || row.schedule_id !== entry.id || row.task_id !== entry.workdeskTaskId) return false
      const resolved = resolve({ board_task_id: row.task_id, assignment_id: row.assignment_id, count: 0 })
      return 'binding' in resolved && resolved.binding.sid === entry.key && permits(resolved.binding)
    },
    releaseWakes(onlyTaskId: number | undefined, now: number, permits: (target: DialogTarget) => boolean): void {
      const rows = db.db
        .query<Wake, [number | null]>(`
        SELECT * FROM workdesk_dialog_wakes WHERE released = 0 AND (?1 IS NULL OR task_id = ?1)
      `)
        .all(onlyTaskId ?? null)
      const get = db.db.query<Wake, [string]>('SELECT * FROM workdesk_dialog_wakes WHERE id = ?')
      for (const row of rows) {
        const scheduleId = db.write('workdesk-dialog', ({ db: sql }) => {
          const fresh = get.get(row.id)
          if (!fresh || fresh.released) return null
          const resolved = resolve({ board_task_id: row.task_id, assignment_id: row.assignment_id, count: 0 })
          if ('problem' in resolved || !permits(resolved.binding)) return null
          if (fresh.schedule_id) return fresh.schedule_id
          const { binding } = resolved
          const thread = getThread(db, binding.thread_id)
          if (!thread) return null
          // Recover a parked file created before the SQLite transaction committed.
          const entry =
            listEntries().find(e => e.workdeskDialogWake === row.id) ??
            addEntry({
              key: binding.sid,
              name: binding.executor,
              by: 'workdesk-dialog',
              text: `В Workdesk есть ответ владельца для ${thread.key}. Для текста вызови защищённое чтение Workdesk.`,
              at: PARKED,
              next: PARKED,
              workdeskDialogWake: row.id,
              workdeskTaskId: row.task_id,
            })
          sql.query('UPDATE workdesk_dialog_wakes SET schedule_id = ? WHERE id = ?').run(entry.id, row.id)
          return entry.id
        })
        if (!scheduleId) continue
        updateEntry(scheduleId, entry =>
          entry.workdeskDialogWake === row.id && entry.next === PARKED ? { ...entry, next: now, at: now } : undefined,
        )
        db.write('workdesk-dialog', ({ db: sql }) =>
          sql.query('UPDATE workdesk_dialog_wakes SET released = 1 WHERE id = ?').run(row.id),
        )
      }
    },
    confirm(expected: Binding, through: number): void {
      db.write('workdesk-dialog', ({ db: sql }) => {
        sql
          .query(`UPDATE workdesk_dialog_bindings SET acknowledged = MAX(acknowledged, ?)
                   WHERE task_id = ? AND assignment_id = ?`)
          .run(through, expected.task_id, expected.assignment_id)
        sql
          .query('DELETE FROM workdesk_dialog_events WHERE board_task_id = ? AND assignment_id = ? AND id <= ?')
          .run(expected.task_id, expected.assignment_id, through)
      })
    },
  }
}

/** Verify the current native recipient of a neutral reminder before waking it. */
export function workdeskDialogWakeAllowed(
  entry: ScheduleEntry,
  items: readonly Item[],
  permits: (target: DialogTarget) => boolean,
): boolean {
  const db = openDb({ create: false })
  if (!db) return false
  try {
    return workdeskDialogStore(db, () => items).wakeAllowed(entry, permits)
  } finally {
    db.close()
  }
}
