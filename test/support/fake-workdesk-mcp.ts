import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { isRecord, readJson, updateJson } from '../../src/adapters/json-store.ts'
import type { WorkdeskTask } from '../../src/core/workdesk.ts'
import type { OwnerEvent, OwnerMessage } from '../../src/core/workdesk-dialog.ts'

type State = {
  tasks: WorkdeskTask[]
  missing?: boolean
  dropClaim?: number
  conflict?: number
  topology?: boolean
  rejectHeartbeat?: boolean
  invalidList?: boolean
  dialog?: {
    events: OwnerEvent[]
    messages: OwnerMessage[]
    assignment: string
    executor: string
    task: number
    revision: number
    delivered: number
    omitMessage?: number
    readDelayMs?: number
    pageSize?: number
    invalidList?: boolean
    dropAck?: 'before' | 'after' | undefined
    deny?: string
  }
}
const isState = (value: unknown): value is State => isRecord(value) && Array.isArray(value.tasks)
const [, , statePath = '', logPath = '', literal = ''] = process.argv
const send = (id: number, result: unknown) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
const tools = ['board_heartbeat', 'list_board_tasks', 'claim_task', 'report_task']
const dialogTools = ['list_owner_events', 'read_owner_messages', 'ack_owner_messages']
const response = (data: unknown, isError = false) => ({ structuredContent: data, isError })

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  const state = readJson(statePath, isState)
  if (!state) process.exit(1)
  appendFileSync(logPath, `${JSON.stringify({ method, params, literal })}\n`)
  if (method === 'initialize') send(id, { protocolVersion: '2024-11-05' })
  if (method === 'tools/list') {
    send(id, {
      tools: (state.missing
        ? ['start_codex_review', 'get_codex_review']
        : [...tools, ...(state.dialog ? dialogTools : [])]
      ).map(name => ({
        name,
        ...(state.topology &&
          name === 'board_heartbeat' && {
            inputSchema: { properties: { topology: { properties: { version: { enum: [1] } } } } },
          }),
      })),
    })
  }
  if (method !== 'tools/call') continue

  if (params.name === 'board_heartbeat') {
    const snapshot = params.arguments.topology
    const ack = snapshot
      ? { version: 1, device_id: snapshot.device_id, observed_at: snapshot.observed_at, accepted: true }
      : undefined
    send(
      id,
      state.rejectHeartbeat
        ? response({ code: 'invalid_topology', status: 400 }, true)
        : response({ ok: true, received_at: Date.now(), ...(ack && { topology: ack }) }),
    )
  }
  if (params.name === 'list_board_tasks') send(id, response({ tasks: state.invalidList ? null : state.tasks }))
  if (state.dialog && dialogTools.includes(params.name)) {
    const dialog = state.dialog
    const { after, through, task_id, assignment_id, executor } = params.arguments
    if (dialog.deny === params.name) {
      send(id, response({ code: 'role_denied', status: 403 }, true))
    } else if (params.name === 'list_owner_events') {
      const remaining = dialog.events.filter(e => e.id > after && e.id > dialog.delivered)
      const events = remaining.slice(0, dialog.pageSize ?? params.arguments.limit)
      send(
        id,
        response({
          events,
          cursor: dialog.invalidList ? after + 999 : (events.at(-1)?.id ?? after),
          more: remaining.length > events.length,
        }),
      )
    } else if (task_id !== dialog.task || assignment_id !== dialog.assignment) {
      send(id, response({ code: 'assignment_mismatch', status: 409 }, true))
    } else if (executor !== dialog.executor) {
      send(id, response({ code: 'conflict', status: 409 }, true))
    } else if (params.name === 'read_owner_messages') {
      if (dialog.readDelayMs) await Bun.sleep(dialog.readDelayMs)
      const remaining = dialog.messages.filter(m => m.id > after && m.id !== dialog.omitMessage)
      const messages = remaining.slice(0, 50)
      send(
        id,
        response({
          task_id,
          assignment_id,
          executor,
          revision: dialog.revision,
          status: 'done',
          delivered_through: dialog.delivered,
          messages,
          cursor: messages.at(-1)?.id ?? after,
          more: remaining.length > 50,
        }),
      )
    } else {
      if (dialog.dropAck === 'before') process.exit(1)
      const next = updateJson(
        statePath,
        live => {
          if (!live?.dialog) throw new Error('fixture dialog removed')
          return {
            ...live,
            dialog: { ...live.dialog, delivered: Math.max(live.dialog.delivered, through), dropAck: undefined },
          }
        },
        isState,
      )
      if (dialog.dropAck === 'after') process.exit(1)
      send(
        id,
        response({
          task_id,
          assignment_id,
          delivered_through: next.dialog?.delivered,
          replayed: through <= dialog.delivered,
        }),
      )
    }
  }
  if (params.name !== 'claim_task') continue

  const { task_id, executor } = params.arguments
  const updated = updateJson(
    statePath,
    live => {
      if (!live) throw new Error('fixture state was removed')
      return {
        ...live,
        tasks: live.tasks.map(task => {
          if (task.id !== task_id || task.executor !== null) return task
          return { ...task, status: 'doing' as const, executor: live.conflict === task_id ? 'Other master' : executor }
        }),
      }
    },
    isState,
  )
  const task = updated.tasks.find(task => task.id === task_id)
  if (task_id === updated.dropClaim && state.tasks.some(t => t.id === task_id && t.executor === null)) process.exit(1)
  if (task?.executor !== executor) send(id, response({ code: 'conflict', status: 409 }, true))
  else send(id, response({ ...task, replayed: state.tasks.some(t => t.id === task_id && t.executor === executor) }))
}
