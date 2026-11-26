import { withWorkdeskMcp } from '../adapters/workdesk-mcp.ts'
import type { Config } from '../core/types.ts'
import { object, type WorkdeskMcpConfig, workdeskMcpConfig } from '../core/workdesk.ts'
import type { WorkdeskSystemTask, WorkdeskSystemTasksPayload } from '../core/workdesk-system-tasks.ts'

const TOOL = 'list_tripio_system_tasks'

function parseTask(raw: unknown): WorkdeskSystemTask {
  const task = object(raw)
  if (task?.project !== 'Tripio') throw new Error('Invalid Tripio system task')
  const { key, title, status, updated_at: updatedAt, executor, url } = task
  if (
    typeof key !== 'string' ||
    !/^TRIPIO-[1-9][0-9]{0,15}$/.test(key) ||
    typeof title !== 'string' ||
    !title.trim() ||
    (status !== 'doing' &&
      status !== 'waiting' &&
      status !== 'done' &&
      status !== 'failed' &&
      status !== 'cancelled') ||
    typeof updatedAt !== 'number' ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0 ||
    updatedAt > 8.64e15 ||
    typeof executor !== 'string' ||
    typeof url !== 'string'
  )
    throw new Error('Invalid Tripio system task')
  const link = new URL(url)
  if (
    (link.protocol !== 'https:' && link.protocol !== 'http:') ||
    link.username ||
    link.password ||
    link.hash !== `#tasks/${key}`
  ) {
    throw new Error('Invalid Tripio system task link')
  }
  return { key, title, status, updatedAt, executor, url: link.href }
}

async function readTasks(config: WorkdeskMcpConfig, signal: AbortSignal): Promise<WorkdeskSystemTask[]> {
  return withWorkdeskMcp(config, signal, async mcp => {
    if (!(await mcp.tools()).has(TOOL)) throw new Error('Tripio system task tool unavailable')
    const tasks = new Map<string, WorkdeskSystemTask>()
    const seen = new Set<string>()
    let cursor: string | null = null
    do {
      const page = object(await mcp.call(TOOL, { limit: 100, ...(cursor !== null && { cursor }) }))
      if (!page || !Array.isArray(page.tasks)) throw new Error('Invalid Tripio system task page')
      for (const raw of page.tasks) {
        const task = parseTask(raw)
        const previous = tasks.get(task.key)
        if (!previous || task.updatedAt > previous.updatedAt) tasks.set(task.key, task)
      }
      const next = page.next_cursor
      if (next === null) break
      if (typeof next !== 'string' || !next || seen.has(next) || seen.size >= 99) {
        throw new Error('Invalid Tripio system task cursor')
      }
      seen.add(next)
      cursor = next
    } while (cursor !== null)
    return [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  })
}

export function createWorkdeskSystemTasks(cfg: Pick<Config, 'workdeskSystemTasks'>, onChange: () => void) {
  let view: WorkdeskSystemTasksPayload | null = null
  let config: WorkdeskMcpConfig | null = null
  let signature = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: AbortController | null = null
  let pending: Promise<void> | null = null

  function publish(next: WorkdeskSystemTasksPayload | null): void {
    if (JSON.stringify(view) === JSON.stringify(next)) return
    view = next
    onChange()
  }

  function arm(delay: number): void {
    if (!config || pending) return
    const active = config
    timer = setTimeout(() => {
      const controller = new AbortController()
      current = controller
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])
      pending = readTasks(active, signal)
        .then(tasks => {
          if (!controller.signal.aborted) publish({ state: 'ready', tasks })
        })
        .catch(() => {
          if (!controller.signal.aborted) publish({ state: 'unavailable' })
        })
        .finally(() => {
          pending = null
          current = null
          arm(config === active ? active.intervalSec * 1000 : 0)
        })
    }, delay)
  }

  return {
    view: () => view,
    configChanged(): void {
      const raw = cfg.workdeskSystemTasks
      const next = JSON.stringify(raw ?? null)
      if (signature === next) return
      signature = next
      clearTimeout(timer)
      current?.abort()
      config = workdeskMcpConfig(raw)
      publish(config ? { state: 'loading' } : raw == null || raw === false ? null : { state: 'unavailable' })
      arm(0)
    },
    async stop(): Promise<void> {
      config = null
      clearTimeout(timer)
      current?.abort()
      await pending
    },
  }
}
