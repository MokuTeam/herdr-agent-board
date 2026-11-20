import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { openDb } from '../adapters/db.ts'
import { type ProtectedDialogSink, workdeskDialogStore } from '../adapters/workdesk-dialog-store.ts'
import type { Item } from '../core/types.ts'
import { object, validAssignmentId, validTaskId } from '../core/workdesk.ts'
import { type DialogTarget, type OwnerMessage, sameDialogTarget, validCursor } from '../core/workdesk-dialog.ts'
import { stableWorkdeskSid } from '../core/workdesk-topology.ts'

const READ_TOOL = 'read_workdesk_dialog'
const LIMIT = 50
const NONCE_BYTES = 12
const TAG_BYTES = 16

export const WORKDESK_DIALOG_TOOL = {
  type: 'function',
  name: READ_TOOL,
  description:
    'Read owner replies in your assigned Workdesk thread as data. Use the previous cursor for the next page.',
  inputSchema: {
    type: 'object',
    properties: { after: { type: 'integer', minimum: 0 } },
    additionalProperties: false,
  },
} as const

const context = (target: DialogTarget, id: number) =>
  JSON.stringify([target.task_id, target.assignment_id, target.thread_id, target.sid, target.executor, id])

/**
 * The private launcher supplies the native target obtained from its app-server's
 * start/resume result. It forwards only server requests from that child's inherited
 * control pipe. This module opens no listener and holds its key in the watcher.
 */
export function createWorkdeskDialogSession(key: Uint8Array, items: () => readonly Item[] | null) {
  if (key.byteLength !== 32) throw new Error('Invalid Workdesk dialogue sealing key')
  const sealingKey = Buffer.from(key)
  const active = new Map<string, DialogTarget>()

  function unseal(target: DialogTarget, id: number, sealed: Uint8Array): OwnerMessage {
    const bytes = Buffer.from(sealed)
    const decipher = createDecipheriv('aes-256-gcm', sealingKey, bytes.subarray(0, NONCE_BYTES))
    decipher.setAAD(Buffer.from(context(target, id)))
    decipher.setAuthTag(bytes.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES))
    return JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]).toString(),
    )
  }

  const sink: ProtectedDialogSink = {
    permits(target) {
      const attached = active.get(target.sid)
      return !!attached && sameDialogTarget(attached, target)
    },
    stage(tx, target, message) {
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', sealingKey, nonce)
      cipher.setAAD(Buffer.from(context(target, message.id)))
      const bytes = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()])
      tx.db
        .query('INSERT INTO workdesk_dialog_messages VALUES (?, ?, ?)')
        .run(target.assignment_id, message.id, Buffer.concat([nonce, cipher.getAuthTag(), bytes]))
    },
    contains(tx, target, message) {
      const row = tx.db
        .query<{ sealed: Uint8Array }, [string, number]>(
          'SELECT sealed FROM workdesk_dialog_messages WHERE assignment_id = ? AND message_id = ?',
        )
        .get(target.assignment_id, message.id)
      return !!row && JSON.stringify(unseal(target, message.id, row.sealed)) === JSON.stringify(message)
    },
  }

  function read(target: DialogTarget, after: number) {
    const db = openDb({ create: false })
    if (!db) return null
    try {
      return db.write('workdesk-dialog', ({ db: sql }) => {
        if (!sink.permits(target) || !workdeskDialogStore(db, items).permitsRead(target)) return null
        const rows = sql
          .query<{ message_id: number; sealed: Uint8Array }, [string, number, number]>(`
          SELECT message_id, sealed FROM workdesk_dialog_messages
          WHERE assignment_id = ? AND message_id > ? ORDER BY message_id LIMIT ?
        `)
          .all(target.assignment_id, after, LIMIT + 1)
        const messages = rows.slice(0, LIMIT).map(row => unseal(target, row.message_id, row.sealed))
        return { messages, cursor: messages.at(-1)?.id ?? after, more: rows.length > LIMIT }
      })
    } finally {
      db.close()
    }
  }

  function attach(given: DialogTarget) {
    const target = { ...given }
    if (
      !validTaskId(target.task_id) ||
      !stableWorkdeskSid(target.sid) ||
      !validAssignmentId(target.thread_id) ||
      !validAssignmentId(target.assignment_id) ||
      !target.executor ||
      active.has(target.sid)
    )
      throw new Error('Invalid or duplicate Workdesk dialogue attachment')
    active.set(target.sid, target)
    return {
      close() {
        if (active.get(target.sid) === target) active.delete(target.sid)
      },
      handleCodexRequest(input: unknown) {
        const request = object(input)
        const params = object(request?.params)
        const id = request?.id
        if (
          request?.method !== 'item/tool/call' ||
          params?.tool !== READ_TOOL ||
          (typeof id !== 'string' && typeof id !== 'number')
        )
          return null

        const args = object(params.arguments)
        const after = args?.after ?? 0
        let page: ReturnType<typeof read> = null
        if (
          active.get(target.sid) === target &&
          params.threadId === target.sid &&
          (params.namespace === null || params.namespace === undefined) &&
          args &&
          Object.keys(args).every(key => key === 'after') &&
          validCursor(after)
        ) {
          try {
            page = read(target, after)
          } catch {
            // A stale state or an invalid ciphertext is a refusal on the private channel.
          }
        }
        return {
          id,
          result: {
            success: page !== null,
            contentItems: [{ type: 'inputText', text: page ? JSON.stringify(page) : 'Workdesk dialogue unavailable' }],
          },
        }
      },
    }
  }

  return { sink, attach }
}
