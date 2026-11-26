import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { isRecord, readJson, updateJson } from '../../src/adapters/json-store.ts'
import type { WorkdeskTask } from '../../src/core/workdesk.ts'
import type { OwnerEvent } from '../../src/core/workdesk-dialog.ts'

type State = {
  tasks: WorkdeskTask[]
  missing?: boolean
  dropClaim?: number
  conflict?: number
  topology?: boolean
  rejectHeartbeat?: boolean
  invalidList?: boolean
  /** WORKDESK-95: offer grant_task_workflow; `grants` holds what it registered, `fail` fails that many calls. */
  grant?: { grants?: { task_id: number; revision: number; token_hash: string }[]; fail?: number }
  dialog?: {
    events: OwnerEvent[]
    pageSize?: number
    invalidList?: boolean
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
        : [...tools, ...(state.dialog ? dialogTools : []), ...(state.grant ? ['grant_task_workflow'] : [])]
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
    const { after } = params.arguments
    if (dialog.deny === params.name) {
      send(id, response({ code: 'role_denied', status: 403 }, true))
    } else if (params.name === 'list_owner_events') {
      const remaining = dialog.events.filter(e => e.id > after)
      const events = remaining.slice(0, dialog.pageSize ?? params.arguments.limit)
      send(
        id,
        response({
          events,
          cursor: dialog.invalidList ? after + 999 : (events.at(-1)?.id ?? after),
          more: remaining.length > events.length,
        }),
      )
    } else {
      // This path is outside the metadata watcher. Fail tests if it tries to call it.
      send(id, response({ code: 'unexpected_dialog_call', status: 403 }, true))
    }
  }
  if (state.grant && params.name === 'grant_task_workflow') {
    const { task_id, assignment_id, revision, executor, token_hash } = params.arguments
    const live = state.tasks.find(t => t.id === task_id) as Record<string, unknown> | undefined
    const grants = state.grant.grants ?? []
    const prior = grants.find(g => (g.task_id === task_id && g.revision === revision) || g.token_hash === token_hash)
    let answer: unknown
    if ((state.grant.fail ?? 0) > 0) answer = response({ code: 'unavailable', status: 503 }, true)
    else if (
      !live ||
      live.executor !== executor ||
      live.assignment_id !== assignment_id ||
      live.revision !== revision ||
      !/^[a-f0-9]{64}$/.test(token_hash)
    )
      answer = response({ code: 'assignment_mismatch', status: 409 }, true)
    else if (prior)
      answer =
        prior.task_id === task_id && prior.revision === revision && prior.token_hash === token_hash
          ? response({ granted: true, replayed: true })
          : response({ code: 'workflow_grant_conflict', status: 409 }, true)
    else answer = response({ granted: true })
    updateJson(
      statePath,
      current => {
        if (!current?.grant) throw new Error('fixture state was removed')
        const fail = current.grant.fail ?? 0
        const added = !prior && fail === 0 && (answer as { isError: boolean }).isError === false
        return {
          ...current,
          grant: {
            fail: Math.max(0, fail - 1),
            grants: [...(current.grant.grants ?? []), ...(added ? [{ task_id, revision, token_hash }] : [])],
          },
        }
      },
      isState,
    )
    send(id, answer)
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
