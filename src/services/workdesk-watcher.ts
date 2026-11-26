import type { StageObservation } from '../adapters/board-event-store.ts'
import { openDb } from '../adapters/db.ts'
import { supportsTopology, WorkdeskToolError, withWorkdeskMcp } from '../adapters/workdesk-mcp.ts'
import { type WorkdeskMaster, workdeskStore } from '../adapters/workdesk-store.ts'
import type { Config, Item } from '../core/types.ts'
import { threadsConfig } from '../core/work-threads.ts'
import {
  object,
  projectKey,
  validTaskId,
  type WorkdeskConfig,
  type WorkdeskPayload,
  type WorkdeskProblem,
  type WorkdeskTask,
  workdeskConfig,
  workdeskTask,
} from '../core/workdesk.ts'
import { type BoardObservation, stableWorkdeskSid, type WorkdeskTopology } from '../core/workdesk-topology.ts'
import { sessionsFor } from './sleep.ts'
import { observeWorkdesk } from './workdesk-topology.ts'

type Options = {
  cfg: Config
  items(): readonly Item[] | null
  nodeItems?(): readonly Item[]
  observation?(): BoardObservation | null
  onChange(): void
  log(message: string): void
  streamDriven?(): boolean
  stageTracking?(): boolean
  stages?(rows: StageObservation[]): void
}

const REQUIRED = ['board_heartbeat', 'list_board_tasks', 'claim_task', 'report_task']
const empty = (): WorkdeskPayload => ({ queue: null, polledAt: null, problem: null })

function masterFor(items: readonly Item[] | null, name: string): WorkdeskMaster | null {
  const matches = sessionsFor(items ?? [], name)
  const item = matches[0]
  if (matches.length !== 1 || !item || (item.agent !== 'claude' && item.agent !== 'codex')) return null
  const sid = item.session
  return { key: item.key, name, lane: item.category, ...(stableWorkdeskSid(sid) && { sid }) }
}

export function createWorkdeskWatcher({
  cfg,
  items,
  nodeItems,
  observation,
  onChange,
  log,
  streamDriven,
  stageTracking,
  stages,
}: Options) {
  let status: WorkdeskPayload | null = null
  let config: WorkdeskConfig | null = null
  let signature = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: AbortController | null = null
  let inFlight: Promise<WorkdeskProblem | null> | null = null
  let lastTasks: Map<number, WorkdeskTask> | null = null
  let loggedProblem = false
  let stopped = false

  function publish(next: WorkdeskPayload | null): void {
    status = next
    if (next?.problem && !loggedProblem) log(`Workdesk watcher: ${next.problem}`)
    loggedProblem = !!next?.problem
    onChange()
  }

  async function poll(
    active: WorkdeskConfig,
    signal: AbortSignal,
    presenceOnly = false,
    targetId?: number,
  ): Promise<WorkdeskProblem | null> {
    let problem: WorkdeskProblem | null = null
    let queue = status?.queue ?? null
    const polledAt = Date.now()
    try {
      await withWorkdeskMcp(active, signal, async mcp => {
        const tools = await mcp.tools()
        const device =
          active.onlyTaskId === undefined && supportsTopology(tools.get('board_heartbeat'))
            ? active.topologyDeviceId
            : undefined
        async function heartbeat(topology: WorkdeskTopology | null = null): Promise<void> {
          if (!tools.has('board_heartbeat') || signal.aborted) return
          try {
            const result = object(await mcp.call('board_heartbeat', topology ? { topology } : {}))
            const ack = object(result?.topology)
            if (
              result?.ok !== true ||
              !Number.isSafeInteger(result.received_at) ||
              (topology &&
                (ack?.version !== 1 ||
                  ack.device_id !== topology.device_id ||
                  ack.observed_at !== topology.observed_at ||
                  typeof ack.accepted !== 'boolean'))
            )
              problem ??= 'heartbeat'
          } catch {
            problem ??= 'heartbeat'
          }
        }

        if (presenceOnly) {
          let topology: WorkdeskTopology | null = null
          if (device && lastTasks) {
            try {
              topology = observeWorkdesk(device, observation?.() ?? null, [...lastTasks.values()])
            } catch {}
          }
          await heartbeat(topology)
          return
        }
        // Older tools and installations keep the original heartbeat-before-queue path.
        if (!device && !streamDriven?.()) await heartbeat()
        let observedTasks: Map<number, WorkdeskTask> | null = null
        try {
          if (!REQUIRED.every(name => tools.has(name))) {
            problem = 'tools'
            return
          }

          const supportsKey = (tool: string) => object(object(tools.get(tool))?.properties)?.include_key !== undefined
          const listKey = supportsKey('list_board_tasks')
          const claimKey = supportsKey('claim_task')
          let listed: unknown
          const includeStage =
            stageTracking?.() === true &&
            object(object(tools.get('list_board_tasks'))?.properties)?.include_stage_started_at != null
          try {
            listed = object(
              await mcp.call('list_board_tasks', {
                ...(listKey && { include_key: true }),
                ...(includeStage && { include_stage_started_at: true }),
              }),
            )?.tasks
          } catch {
            problem ??= 'list'
            return
          }
          if (!Array.isArray(listed)) {
            problem ??= 'list'
            return
          }
          const scoped: WorkdeskTask[] = []
          const observedStages: StageObservation[] = []
          for (const raw of listed) {
            if (active.onlyTaskId && object(raw)?.id !== active.onlyTaskId) continue
            const task = workdeskTask(raw)
            if (task) {
              scoped.push(task)
              const body = object(raw)
              if (
                task.status !== 'queued' &&
                task.assignment &&
                typeof body?.stage === 'string' &&
                validTaskId(body.stage_started_at)
              ) {
                observedStages.push({
                  taskId: task.id,
                  assignmentId: task.assignment.id,
                  revision: task.assignment.revision,
                  stage: body.stage,
                  startedAt: body.stage_started_at,
                })
              }
            } else problem ??= 'list'
          }
          const byId = new Map(scoped.map(task => [task.id, task]))
          const tasks = [...byId.values()]
          if (problem !== 'list' && byId.size === scoped.length) {
            if (device) observedTasks = byId
            signal.throwIfAborted()
            if (includeStage) stages?.(observedStages)
          }
          const eligible = new Set(
            tasks.filter(task => task.status === 'queued' && task.executor === null).map(task => task.id),
          )
          queue = eligible.size
          const threadsOn = threadsConfig(cfg.threads)
          if (!threadsOn) {
            problem ??= 'threads'
            return
          }
          signal.throwIfAborted()

          try {
            const db = openDb()
            if (!db) throw new Error('Workdesk store unavailable')
            try {
              const store = workdeskStore(db)
              store.release(active.onlyTaskId, Date.now())
              for (const task of tasks) {
                if (targetId !== undefined && task.id !== targetId) continue
                signal.throwIfAborted()
                if (!threadsConfig(cfg.threads)) {
                  problem ??= 'threads'
                  return
                }
                const saved = store.find(task.id)
                const resumed = saved && task.executor === saved.executor
                if (saved?.thread_id || (!eligible.has(task.id) && !resumed)) continue

                const name = saved?.executor ?? active.masters.get(projectKey(task.project)) ?? active.fallback
                const local = items()
                const candidates = active.routeNodeMasters && local ? [...local, ...(nodeItems?.() ?? [])] : local
                const master = masterFor(candidates, name)
                if (!master || (saved && master.key !== saved.session_key)) {
                  problem ??= 'master'
                  continue
                }
                if (!store.reserve(task.id, master)) continue
                let claimed: ReturnType<typeof workdeskTask>
                try {
                  claimed = workdeskTask(
                    await mcp.call('claim_task', {
                      task_id: task.id,
                      executor: master.name,
                      ...(claimKey && { include_key: true }),
                    }),
                  )
                } catch (err) {
                  problem ??= err instanceof WorkdeskToolError && err.conflict ? 'conflict' : 'claim'
                  if (err instanceof WorkdeskToolError && err.conflict) eligible.delete(task.id)
                  continue
                }
                signal.throwIfAborted()
                if (!threadsConfig(cfg.threads)) {
                  problem ??= 'threads'
                  return
                }
                if (
                  !claimed ||
                  claimed.id !== task.id ||
                  (task.assignment && claimed.assignment?.id !== task.assignment.id) ||
                  (task.key && claimed.key && claimed.key !== task.key) ||
                  claimed.executor !== master.name ||
                  claimed.status === 'queued'
                ) {
                  problem ??= 'claim'
                  continue
                }
                eligible.delete(task.id)
                store.handoff(
                  claimed.key || !task.key ? claimed : { ...claimed, key: task.key, url: task.url },
                  master,
                  Date.now(),
                )
                observedTasks?.set(claimed.id, claimed)
              }
              store.release(active.onlyTaskId, Date.now())
            } finally {
              db.close()
            }
          } catch {
            problem ??= 'handoff'
            observedTasks = null
          } finally {
            queue = eligible.size
          }
        } finally {
          // A topology failure never gates the preceding claim or thread. Fall back to presence
          // without replacing the device snapshot when any source is partial.
          lastTasks = observedTasks
          if (device && !streamDriven?.()) {
            let topology: WorkdeskTopology | null = null
            if (observedTasks && !signal.aborted && threadsConfig(cfg.threads)) {
              try {
                topology = observeWorkdesk(device, observation?.() ?? null, [...observedTasks.values()])
              } catch {}
            }
            await heartbeat(topology)
          }
        }
      })
    } catch {
      problem ??= 'connection'
    } finally {
      if (!signal.aborted && !presenceOnly) publish({ queue, polledAt, problem })
    }
    return problem
  }

  function start(active: WorkdeskConfig, presenceOnly: boolean, parent?: AbortSignal, targetId?: number) {
    const controller = new AbortController()
    current = controller
    const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal
    inFlight = poll(active, signal, presenceOnly, targetId).finally(() => {
      inFlight = null
      current = null
    })
    return inFlight
  }

  function arm(delay: number): void {
    clearTimeout(timer)
    if (!config || stopped) return
    timer = setTimeout(() => {
      if (!config || stopped) return
      if (inFlight) {
        void inFlight.finally(() => arm(0))
        return
      }
      const active = config
      const started = Date.now()
      void start(active, streamDriven?.() === true).finally(() =>
        arm(config !== active ? 0 : Math.max(0, active.intervalSec * 1000 - (Date.now() - started))),
      )
    }, delay)
  }

  return {
    view: () => status,
    async reconcile(signal: AbortSignal, targetId?: number): Promise<void> {
      while (inFlight) await inFlight
      signal.throwIfAborted()
      if (!config || stopped) throw new Error('Workdesk watcher unavailable')
      const problem = await start(config, false, signal, targetId)
      // A queued card with no local master remains in Workdesk for the next fallback scan.
      // A snapshot is still usable by the v2 relay and other assignments.
      if (
        problem &&
        problem !== 'heartbeat' &&
        problem !== 'conflict' &&
        !(targetId === undefined && problem === 'master')
      )
        throw new Error(`Workdesk reconciliation: ${problem}`)
    },
    configChanged(): void {
      const next = JSON.stringify(cfg.workdesk ?? null)
      if (signature === next) return
      signature = next
      current?.abort()
      lastTasks = null
      config = workdeskConfig(cfg.workdesk)
      if (config) publish(empty())
      else if (cfg.workdesk == null || cfg.workdesk === false) {
        if (status) publish(null)
      } else publish({ ...empty(), problem: 'config' })
      arm(0)
    },
    async stop(): Promise<void> {
      stopped = true
      clearTimeout(timer)
      current?.abort()
      await inFlight
    },
  }
}
