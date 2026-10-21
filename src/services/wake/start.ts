// Wake's start (#119, safeguards 2, 6, 7, 8, 12), what its startup entry runs
// (entrypoints/wake-start.ts) and the board's "Start" and "Start again": makes sure one wake pane
// runs, in a workspace of its own (`Wake`), never in the board's. Off: nothing at all. The old
// herdr-wake plugin installed: held, nothing opened. A wake answering on its port, or its pane there
// with its supervisor's process alive: nothing to do. Otherwise a pane herdr restored as a bare
// shell (its process gone) is closed, with its tab when nothing of the user's is in it, the
// workspace's leftover tabs too (only shells or sidebar panes; never a tab with an agent), and a
// new wake pane opened. An error is logged and recorded in the status file, never thrown.
import { asSnapshot, type HerdrSnapshot, type HerdrWorkspace } from '../../adapters/herdr.ts'
import { lastBoard } from '../../core/board-pane.ts'
import type { WakeConfig } from '../../core/wake/config.ts'
import type { WakeStatusFile } from '../../core/wake/status.ts'

export interface StartDeps {
  herdr<T = unknown>(args: string[], timeoutMs?: number): Promise<T>
  /** Whether a wake answers GET /status on the port (core/wake/status.ts isWakeStatus). */
  answers(port: number): Promise<boolean>
  readStatus(): WakeStatusFile | null
  writeStatus(s: WakeStatusFile): void
  alive(pid: number): boolean
  log(text: string): void
  sleep(ms: number): Promise<void>
  now(): number
  /** The plugin's folder: the new workspace's and the pane's cwd. */
  root: string
}

export type StartResult = 'off' | 'held' | 'answers' | 'present' | 'opened' | 'failed'

/** The entrypoint ends by then whatever herdr does (BOARD_WAKE_START_DEADLINE_MS in tests). */
export const START_DEADLINE_MS = 20_000

/** The old plugin, while it is installed the new wake holds back. */
const OLD_PLUGIN = 'herdr-wake'
/** `herdr api snapshot` is tried this long after the first try (herdr may still be coming up). */
const SNAPSHOT_TRIES_MS = [0, 500, 1000, 2000]

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const firstLine = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).split(/\r?\n/).find(line => line.trim()) ?? 'unknown error'

/** What `herdr workspace create` and `herdr plugin pane open` answer, as far as this reads them. */
interface Created {
  workspace?: HerdrWorkspace
  tab?: { tab_id?: string }
}
interface Opened {
  plugin_pane?: { pane?: { pane_id?: string } }
}

/** `herdr plugin list --json`: whether herdr-wake is among the plugins (any answer naming it, when it has no list). */
async function oldPluginInstalled(deps: StartDeps): Promise<boolean> {
  const answer = await deps.herdr(['plugin', 'list', '--json'])
  const plugins = record(answer)?.plugins
  if (Array.isArray(plugins)) return plugins.some(p => record(p)?.plugin_id === OLD_PLUGIN)
  return JSON.stringify(answer ?? null).includes(OLD_PLUGIN)
}

/** `herdr api snapshot`, tried at 0, 0.5, 1 and 2 s; the last error when none answers. */
async function snapshotTried(deps: StartDeps): Promise<HerdrSnapshot> {
  const first = deps.now()
  let error: unknown
  for (const at of SNAPSHOT_TRIES_MS) {
    const wait = first + at - deps.now()
    if (wait > 0) await deps.sleep(wait)
    try {
      return asSnapshot(await deps.herdr(['api', 'snapshot']))
    } catch (err) {
      error = err
    }
  }
  throw error
}

/** The panes of a tab. */
const panesOf = (snap: HerdrSnapshot, tab: string) => snap.panes.filter(p => p.tab_id === tab)

/** Tabs of the workspace whose panes are all shells or sidebar panes (no agent): nothing of the user's work in them. */
function spareTabs(snap: HerdrSnapshot, workspace: string): string[] {
  return snap.tabs
    .filter(tab => tab.workspace_id === workspace)
    .map(tab => tab.tab_id)
    .filter(id => {
      const panes = panesOf(snap, id)
      return panes.length > 0 && panes.every(p => !p.agent)
    })
}

export async function startWake(
  deps: StartDeps,
  o: { on: boolean; settings: WakeConfig; again?: boolean },
): Promise<StartResult> {
  if (!o.on) return 'off'
  const status = deps.readStatus()
  /** The recorded pane once this start closed it: no longer wake's pane. */
  let closed: string | null = null
  /** The recorded pane and supervisor, kept in what this start writes unless it closed that pane. */
  const kept = (): { pane?: string; pid?: number } =>
    status?.pane !== undefined && status.pane !== closed
      ? { pane: status.pane, ...(status.pid !== undefined && { pid: status.pid }) }
      : {}
  const write = (s: WakeStatusFile): void => {
    try {
      deps.writeStatus(s)
    } catch (err) {
      deps.log(`could not write wake's status: ${firstLine(err)}`)
    }
  }

  try {
    if (await oldPluginInstalled(deps)) {
      write({ state: 'held', at: deps.now(), ...kept() })
      deps.log('held: the herdr-wake plugin is installed, wake leaves it the work')
      return 'held'
    }
    if (status?.state === 'held') {
      write({ state: 'stopped', at: deps.now(), ...kept() })
      deps.log('the herdr-wake plugin is gone: wake no longer held')
    }
    if (!o.again && (await deps.answers(o.settings.port))) return 'answers'

    let snap = await snapshotTried(deps)
    const recorded = status?.pane ? { pane: status.pane, ...(status.pid !== undefined && { pid: status.pid }) } : null
    const last = lastBoard(recorded, snap.panes, deps.alive)
    if (last && !last.stale && !o.again) return 'present'
    if (last) {
      // Its whole tab, as other plugins add their panes to every tab; only the pane when the tab
      // has an agent in it (the user moved the pane there).
      const tab = snap.panes.find(p => p.pane_id === last.pane)?.tab_id
      const mine = tab !== undefined && panesOf(snap, tab).every(p => p.pane_id === last.pane || !p.agent)
      const close = mine ? ['tab', 'close', tab] : ['pane', 'close', last.pane]
      await deps.herdr(close).catch(err => deps.log(`closing ${last.pane}: ${firstLine(err)}`))
      closed = last.pane
      snap = await snapshotTried(deps)
    }

    // A workspace of its own; a new one comes with a shell tab, closed once wake's tab is in.
    const label = o.settings.workspace
    let ws = snap.workspaces.find(w => w.label === label)
    let firstTab: string | undefined
    const leftovers = ws ? spareTabs(snap, ws.workspace_id) : []
    if (!ws) {
      const created = await deps.herdr<Created | null>([
        'workspace',
        'create',
        '--label',
        label,
        '--cwd',
        deps.root,
        '--no-focus',
      ])
      ws = created?.workspace
      firstTab = created?.tab?.tab_id
    }
    if (!ws) throw new Error('herdr workspace create: no workspace in the answer')
    const opened = await deps.herdr<Opened | null>([
      'plugin',
      'pane',
      'open',
      '--plugin',
      'agent-board',
      '--entrypoint',
      'wake',
      '--placement',
      'tab',
      '--workspace',
      ws.workspace_id,
      '--cwd',
      deps.root,
      '--no-focus',
    ])
    const pane = opened?.plugin_pane?.pane?.pane_id
    if (pane)
      for (const tab of firstTab ? [firstTab] : leftovers) await deps.herdr(['tab', 'close', tab]).catch(() => {})
    write({ state: 'starting', at: deps.now(), ...(pane && { pane }) })
    deps.log(`opened wake's pane${pane ? ` ${pane}` : ''} in workspace ${label}`)
    return 'opened'
  } catch (err) {
    const error = firstLine(err)
    deps.log(`wake's start failed: ${error}`)
    write({ state: 'failed', at: deps.now(), error, ...kept() })
    return 'failed'
  }
}
