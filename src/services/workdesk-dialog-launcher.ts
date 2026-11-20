import { openDb } from '../adapters/db.ts'
import { getThread } from '../adapters/work-thread-store.ts'
import type { ProtectedDialogSink } from '../adapters/workdesk-dialog-store.ts'
import { workdeskHandoffReader } from '../adapters/workdesk-store.ts'
import { isMirrored } from '../core/thread-import.ts'
import type { Config, Item } from '../core/types.ts'
import { threadsConfig } from '../core/work-threads.ts'
import { object } from '../core/workdesk.ts'
import { workdeskDialogConfig } from '../core/workdesk-dialog.ts'
import { createWorkdeskDialogSession } from './workdesk-dialog-session.ts'

type Attachment = ReturnType<ReturnType<typeof createWorkdeskDialogSession>['attach']>
type Recipient = { attachment: Attachment; sink: ProtectedDialogSink; signature: string; readOnly: boolean }

/**
 * Opt-in child-process IPC. The trusted parent owns the Codex App Server pipes and
 * supplies its native thread/start or thread/resume result. There is no CLI or HTTP
 * action that can attach a recipient. The launcher must protect its own IPC endpoint.
 */
export function connectWorkdeskDialogLauncher(cfg: Config, items: () => readonly Item[] | null, onChange: () => void) {
  let recipient: Recipient | null = null
  const pin = () => {
    if (!threadsConfig(cfg.threads)) return
    const config = workdeskDialogConfig(cfg.workdeskDialog, cfg.workdesk)
    if (config?.receiver === 'launcher' && config.onlyTaskId !== undefined)
      return config.legacyBindings.get(config.onlyTaskId)
  }
  const active = () => (recipient?.signature === JSON.stringify(pin()) ? recipient : null)
  const delivery = () => {
    const bound = active()
    return bound?.readOnly === false && object(cfg.workdeskDialog)?.deliver === true ? bound : null
  }
  const sink: ProtectedDialogSink = {
    permits: target => delivery()?.sink.permits(target) ?? false,
    stage(tx, target, message) {
      const bound = delivery()
      if (!bound) throw new Error('Workdesk dialogue recipient detached')
      bound.sink.stage(tx, target, message)
    },
    contains: (tx, target, message) => delivery()?.sink.contains(tx, target, message) ?? false,
  }
  function detach(): void {
    if (!recipient) return
    recipient.attachment.close()
    recipient = null
    onChange()
  }

  function attach(msg: Record<string, unknown>): boolean {
    const expected = pin()
    const native = object(object(msg.session)?.thread)?.id
    const key = msg.sealingKey
    if (!expected || native !== expected.sessionId || typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key))
      return false
    const db = openDb({ create: false })
    if (!db) return false
    try {
      const handoff = workdeskHandoffReader(db)(expected.taskId)
      const thread = getThread(db, expected.threadId)
      if (
        handoff?.session_key !== native ||
        handoff.thread_id !== expected.threadId ||
        thread?.scope !== 'local' ||
        isMirrored(thread) ||
        thread.assignee?.kind !== 'session' ||
        thread.assignee.key !== native ||
        thread.assignee.name !== handoff.executor
      )
        return false
      const session = createWorkdeskDialogSession(Buffer.from(key, 'base64url'), items)
      const attachment = session.attach({
        task_id: expected.taskId,
        assignment_id: expected.assignmentId,
        thread_id: expected.threadId,
        sid: native,
        executor: handoff.executor,
      })
      detach()
      recipient = {
        attachment,
        sink: session.sink,
        signature: JSON.stringify(expected),
        readOnly: msg.readOnly !== false || object(cfg.workdeskDialog)?.deliver !== true,
      }
      onChange()
      return true
    } finally {
      db.close()
    }
  }

  function receive(value: unknown): void {
    const msg = object(value)
    if (msg?.kind !== 'workdesk-dialog' || typeof msg.id !== 'number' || !Number.isSafeInteger(msg.id)) return
    let result: unknown = null
    try {
      if (msg.op === 'attach') result = attach(msg)
      else if (msg.op === 'tool') result = delivery()?.attachment.handleCodexRequest(msg.request) ?? null
      else if (msg.op === 'detach') detach()
    } catch {
      // A refusal contains no credential or owner data.
    }
    if (process.connected)
      process.send?.({ kind: 'workdesk-dialog', id: msg.id, result }, undefined, undefined, () => {})
  }

  let listening = false
  function configChanged(): void {
    if (recipient && !active()) detach()
    const enabled = Boolean(pin() && typeof process.send === 'function' && process.connected)
    if (listening === enabled) return
    listening = enabled
    if (enabled) {
      process.on('message', receive)
      process.on('disconnect', detach)
    } else {
      process.off('message', receive)
      process.off('disconnect', detach)
    }
  }
  configChanged()
  return {
    sink,
    ready: () => Boolean(active()),
    delivering: () => Boolean(delivery()),
    configChanged,
    close() {
      if (listening) {
        process.off('message', receive)
        process.off('disconnect', detach)
        listening = false
      }
      detach()
    },
  }
}
