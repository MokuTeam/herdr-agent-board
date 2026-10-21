// Wake's start (#119, safeguards 2, 6, 7, 8, 12), what its startup entry runs
// (entrypoints/wake-start.ts) and the board's "Start" and "Start again": makes sure one wake pane
// runs, in a workspace of its own (`Wake`), never in the board's. Off: nothing at all. The old
// herdr-wake plugin installed: held, nothing opened. A wake answering on its port, or its pane there
// with its supervisor's process alive and either parked (crashed, port taken) or started within a
// start's time: nothing to do (a pid alive after that, with nothing answering, is another
// process's: herdr's restart, Fast Startup). Otherwise a pane herdr restored as a bare
// shell (its process gone) is closed, with its tab when nothing but herdr-sidebar's panes is beside
// it, the workspace's leftover tabs too (only wake's shells or sidebar panes in them), and a new
// wake pane opened. herdr gives a pane's id out again after it starts over: the recorded pane is
// taken for wake's only in wake's workspace with no agent in it, in the plugin's folder, and never
// the board's; else it is left alone. The old plugin removed by hand: its takeover runs once, before the new pane opens
// (takeover.ts). An error is logged and recorded in the status file, never thrown.
import { asSnapshot, type HerdrPane, type HerdrSnapshot, type HerdrWorkspace } from '../../adapters/herdr.ts'
import { sameDir } from '../../core/launch/names.ts'
import type { WakeConfig } from '../../core/wake/config.ts'
import { STARTING_MS, type WakeStatusFile } from '../../core/wake/status.ts'

export interface StartDeps {
  herdr<T = unknown>(args: string[], timeoutMs?: number): Promise<T>
  /** Whether the board's wake answers GET /alive on the port (adapters/wake-api.ts wakeAlive); the old router never does. */
  answers(port: number): Promise<boolean>
  readStatus(): WakeStatusFile | null
  writeStatus(s: WakeStatusFile): void
  alive(pid: number): boolean
  log(text: string): void
  sleep(ms: number): Promise<void>
  now(): number
  /** When this computer started (ms): a record from before names a pane and a process of an earlier boot. */
  bootedAt: number
  /** The plugin's folder: the new workspace's and the pane's cwd. */
  root: string
  /**
   * The takeover at wake's first start after the old plugin was removed by hand (takeover.ts
   * takeOverAtFirstStart), run once no wake runs and before its new pane opens; the wake section
   * as it is after it, or null when it did not run. Never throws.
   */
  takeOver?(): Promise<WakeConfig | null>
}

/** The board's own workspace and pane, which wake's start never closes anything of. */
export interface BoardPlace {
  /** The label of the board's workspace: config.json's `workspace`, else `Board`. */
  label: string
  /** The pane board.json names. */
  pane: string | null
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
export async function oldPluginInstalled(deps: Pick<StartDeps, 'herdr'>): Promise<boolean> {
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
/** The workspace a pane is in, by its own field or its tab's. */
export const workspaceOf = (snap: HerdrSnapshot, pane: HerdrPane): string | undefined =>
  pane.workspace_id ?? snap.tabs.find(t => t.tab_id === pane.tab_id)?.workspace_id
/** herdr-sidebar's pane, which that plugin adds to every tab (as entrypoints/open.ts orphanTabs reads it). */
const isSidebar = (p: HerdrPane): boolean =>
  !p.agent && Object.keys(p.tokens ?? {}).some(k => k.startsWith('herdr-sidebar'))

/**
 * Whether a pane is what wake leaves behind: herdr-sidebar's, or one with no agent in the plugin's
 * folder (a wake pane's restored shell). Anything else (an agent, an editor or a server in another
 * folder, a pane herdr says no folder of) is the user's. The start's leftover tabs and the board's
 * close of wake's workspace (control.ts) both go by it.
 */
export const wakeLeftover = (p: HerdrPane, root: string): boolean => isSidebar(p) || (!p.agent && sameDir(p.cwd, root))

/**
 * What closes wake's pane: its whole tab when nothing but herdr-sidebar's panes is beside it, as that
 * plugin adds its pane to every tab; else only the pane (something of the user's is in that tab).
 */
export function closeOfPane(snap: HerdrSnapshot, pane: HerdrPane): string[] {
  const tab = pane.tab_id
  const alone = tab !== undefined && panesOf(snap, tab).every(p => p.pane_id === pane.pane_id || isSidebar(p))
  return alone ? ['tab', 'close', tab] : ['pane', 'close', pane.pane_id]
}

/**
 * The recorded pane when it can be wake's: in a workspace labelled wake's, with no agent in it, in
 * the plugin's folder (`root`), not the board's. Null otherwise, and when it is gone: herdr gives a
 * pane's id out again after it starts over, so such a pane is somebody else's now (an editor or a
 * server of the user's in another folder, say).
 */
export function recordedPane(
  snap: HerdrSnapshot,
  pane: string | undefined,
  label: string,
  board: BoardPlace,
  root: string,
): HerdrPane | null {
  const p = pane === undefined ? undefined : snap.panes.find(x => x.pane_id === pane)
  if (!p || p.agent || p.pane_id === board.pane || !sameDir(p.cwd, root)) return null
  const ws = workspaceOf(snap, p)
  return snap.workspaces.some(w => w.workspace_id === ws && w.label === label) ? p : null
}

/** States in which the supervisor waits on purpose (crashed five times, or its port another program's): nothing answers, yet it runs. */
const PARKED: ReadonlySet<WakeStatusFile['state']> = new Set(['crashed', 'portTaken'])

/**
 * Whether the record is of a wake that no longer runs (asked only once nothing answers on its
 * port): written before this boot (its pid may be another process's now), its supervisor's process
 * gone, or with no process for longer than a start takes (the supervisor writes its own as it
 * starts). With its process alive, only a parked supervisor, or one that started within a start's
 * time (a healthy one's wake answers within its grace), is still wake's: herdr's restart, or a
 * Windows "Shut down" with Fast Startup that keeps the uptime, gives a dead supervisor's pid to
 * another process.
 */
function stale(deps: StartDeps, status: WakeStatusFile): boolean {
  if (status.at < deps.bootedAt) return true
  const age = deps.now() - status.at
  if (status.pid === undefined) return age > STARTING_MS
  if (!deps.alive(status.pid)) return true
  return !PARKED.has(status.state) && age >= STARTING_MS
}

/** Tabs of the workspace with only wake's leftovers in them (wakeLeftover); a tab with anything else is the user's. */
function spareTabs(snap: HerdrSnapshot, workspace: string, root: string): string[] {
  return snap.tabs
    .filter(tab => tab.workspace_id === workspace)
    .map(tab => tab.tab_id)
    .filter(id => {
      const panes = panesOf(snap, id)
      return panes.length > 0 && panes.every(p => wakeLeftover(p, root))
    })
}

export async function startWake(
  deps: StartDeps,
  o: { on: boolean; settings: WakeConfig; board: BoardPlace; again?: boolean },
): Promise<StartResult> {
  if (!o.on) return 'off'
  const status = deps.readStatus()
  /**
   * Whether what this start writes keeps the recorded pane and supervisor: not when the record is of
   * an earlier boot, nor once this start closed that pane or found it is no wake's.
   */
  let keep = status !== null && status.at >= deps.bootedAt
  const kept = (): { pane?: string; pid?: number } =>
    keep && status?.pane !== undefined
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

    let label = o.settings.workspace
    let snap = await snapshotTried(deps)
    const last = recordedPane(snap, status?.pane, label, o.board, deps.root)
    if (status?.pane !== undefined && !last && snap.panes.some(p => p.pane_id === status.pane)) {
      keep = false
      deps.log(`pane ${status.pane} is no wake's now (another workspace or folder, an agent, or the board): left alone`)
    }
    if (last && status && !stale(deps, status) && !o.again) return 'present'
    if (last) {
      await deps.herdr(closeOfPane(snap, last)).catch(err => deps.log(`closing ${last.pane_id}: ${firstLine(err)}`))
      keep = false
      snap = await snapshotTried(deps)
    }

    // The old plugin removed by hand: its config and sleeping list taken over once, now that no wake
    // runs to write its session file, and before the pane that reads them opens.
    const taken = (await deps.takeOver?.()) ?? null
    if (taken) label = taken.workspace

    // A workspace of its own; a new one comes with a shell tab, closed once wake's tab is in. The
    // board's workspace (wake.workspace set to its label, or holding the board's pane) keeps its tabs.
    let ws = snap.workspaces.find(w => w.label === label)
    let firstTab: string | undefined
    const boardsWorkspace = (id: string): boolean =>
      label === o.board.label || snap.panes.some(p => p.pane_id === o.board.pane && workspaceOf(snap, p) === id)
    const leftovers = ws && !boardsWorkspace(ws.workspace_id) ? spareTabs(snap, ws.workspace_id, deps.root) : []
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
    // The new pane's supervisor records itself (its pid and port) as it starts: a record of that
    // pane already there is newer than this one.
    if (!pane || deps.readStatus()?.pane !== pane) write({ state: 'starting', at: deps.now(), ...(pane && { pane }) })
    deps.log(`opened wake's pane${pane ? ` ${pane}` : ''} in workspace ${label}`)
    return 'opened'
  } catch (err) {
    const error = firstLine(err)
    deps.log(`wake's start failed: ${error}`)
    write({ state: 'failed', at: deps.now(), error, ...kept() })
    return 'failed'
  }
}
