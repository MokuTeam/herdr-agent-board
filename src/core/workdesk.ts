import { isAbsolute } from 'node:path'
import { DEVICE_ID } from './workdesk-topology.ts'

const DEFAULT_MASTERS = {
  BoxMap: 'BoxMap-master',
  MokuPilot: 'MokuPilot-master',
  CV: 'CV-master',
  Board: 'Board-master',
  Tripio: 'Tripio-master',
  Трипио: 'Tripio-master',
  Hermes: 'Tripio-master',
  LessonPilot: 'LessonPilot-master',
  Workdesk: 'Workdesk-master',
}

export type WorkdeskMcpConfig = {
  executable: string
  args: string[]
  caFile?: string
  intervalSec: number
}

export type WorkdeskConfig = WorkdeskMcpConfig & {
  masters: Map<string, string>
  fallback: string
  routeNodeMasters?: true
  onlyTaskId?: number
  topologyDeviceId?: string
}

export const projectKey = (name: string): string => name.trim().toLowerCase()

export const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

export const validTaskId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0

// biome-ignore lint/suspicious/noControlCharactersInRegex: exclude control characters from local argv paths and names
const localWord = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !/[\x00-\x1f\x7f]/.test(v)

export function workdeskMcpConfig(raw: unknown): WorkdeskMcpConfig | null {
  const config = object(raw)
  if (!config) return null
  const { executable, args = [], caFile, intervalSec = 120 } = config
  if (
    !localWord(executable) ||
    !isAbsolute(executable) ||
    !Array.isArray(args) ||
    !args.every(arg => typeof arg === 'string' && !arg.includes('\0')) ||
    (caFile !== undefined && (!localWord(caFile) || !isAbsolute(caFile))) ||
    typeof intervalSec !== 'number' ||
    !Number.isFinite(intervalSec) ||
    intervalSec < 1 ||
    intervalSec > 86400
  )
    return null
  return { executable, args, intervalSec, ...(caFile !== undefined && { caFile }) }
}

export function workdeskConfig(raw: unknown): WorkdeskConfig | null {
  const config = object(raw)
  const mcp = workdeskMcpConfig(raw)
  if (!config || !mcp) return null
  const { masters = {}, fallback = 'Coordinator-backup', onlyTaskId } = config
  if (!localWord(fallback) || (onlyTaskId !== undefined && !validTaskId(onlyTaskId))) return null
  const routes = object(masters)
  if (!routes) return null
  const mapping = new Map(Object.entries(DEFAULT_MASTERS).map(([project, name]) => [projectKey(project), name]))
  for (const [project, name] of Object.entries(routes)) {
    if (!localWord(project) || !localWord(name)) return null
    mapping.set(projectKey(project), name.trim())
  }
  const device = object(config.topology)?.deviceId
  return {
    ...mcp,
    masters: mapping,
    fallback: fallback.trim(),
    ...(config.routeNodeMasters === true && { routeNodeMasters: true }),
    ...(onlyTaskId !== undefined && { onlyTaskId }),
    ...(typeof device === 'string' && DEVICE_ID.test(device) && { topologyDeviceId: device }),
  }
}

export type WorkdeskProblem =
  | 'config'
  | 'tools'
  | 'connection'
  | 'heartbeat'
  | 'list'
  | 'claim'
  | 'threads'
  | 'master'
  | 'conflict'
  | 'handoff'

export type WorkdeskPayload = {
  queue: number | null
  polledAt: number | null
  problem: WorkdeskProblem | null
}

export const validAssignmentId = (id: unknown): id is string =>
  typeof id === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)

export type WorkdeskExecutorModel = 'codex' | 'claude-opus'

export type WorkdeskTask = {
  id: number
  key?: string
  title: string
  project: string
  description: string
  acceptance: string
  url: string
  status: 'queued' | 'doing' | 'waiting'
  executor: string | null
  executor_model: WorkdeskExecutorModel
  assignment?: { id: string; revision: number }
}

export function workdeskTask(raw: unknown): WorkdeskTask | null {
  const task = object(raw)
  if (!task) return null
  const { id, title, project, description, acceptance, url, status, executor, executor_model = 'codex' } = task
  if (
    !validTaskId(id) ||
    typeof title !== 'string' ||
    !title.trim() ||
    typeof project !== 'string' ||
    typeof description !== 'string' ||
    typeof acceptance !== 'string' ||
    typeof url !== 'string' ||
    (status !== 'queued' && status !== 'doing' && status !== 'waiting') ||
    (executor !== null && typeof executor !== 'string') ||
    (executor_model !== 'codex' && executor_model !== 'claude-opus')
  )
    return null
  const { key, assignment_id, revision } = task
  const assignment = validAssignmentId(assignment_id) && validTaskId(revision) ? { id: assignment_id, revision } : null
  return {
    id,
    title,
    project,
    description,
    acceptance,
    url,
    status,
    executor,
    executor_model,
    ...(typeof key === 'string' && /^[A-Z]{1,12}-[1-9][0-9]{0,15}$/.test(key) && { key }),
    ...(assignment && { assignment }),
  }
}
