// A fork of a session from the board: a new session in a new herdr tab that starts with a copy of
// the session's conversation (`claude --resume <id> --fork-session`, with an id of its own), so it
// knows what the session knows while the session itself goes on as it was. It starts through the
// board's launches (launches.ts) like any new session, with the session's folder (the one its
// conversation was recorded in: Claude resumes a session only from there), lane, workspace and
// Claude profile, under the name it is given and with an optional first message. Who it is a fork
// of is in its own transcript, whose copied lines carry `forkedFrom` (core/links.ts).
import { cwdOf } from '../../adapters/claude-home.ts'
import { workspaceList } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { categoryInfo } from '../../core/categories.ts'
import { t } from '../../core/lang.ts'
import { forkName, sessionWorkspace } from '../../core/launch/names.ts'
import { callable } from '../../core/mokupilot.ts'
import type { Config, Item, LaunchView } from '../../core/types.ts'
import type { Deps } from '../deps.ts'
import { herdrCannotResume, launcherFor } from './launcher.ts'
import type { Launches } from './launches.ts'

/** What a fork needs of the board: its launches (to start it, and to show it) and its items now. */
export interface ForkApp {
  launches: Pick<Launches, 'start' | 'list'>
  items(): Item[]
}

export type ForkResult =
  | { ok: true; id: string; name: string; launch: LaunchView | null }
  | { ok: false; error: string; field?: string }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Whether the board can fork a session here, for the page to offer it: the board's spawn-agent
 * and a launcher command taking {fork} can; launch.agent only for Claude without arguments that
 * pick the session.
 */
export function canFork(cfg: Pick<Config, 'launch'>): boolean {
  const launcher = launcherFor(cfg.launch, { fork: true })
  return launcher.kind !== 'herdr' || !herdrCannotResume(cfg.launch ?? {}, [])
}

/**
 * Start a fork of `item` (`body`: { name?, message? }): { ok, id, name, launch } once its launch
 * is on its way (its card shows at once), or { ok: false, error } before anything started. Only a
 * Claude session with an id and a conversation on disk can be forked; its profile is kept, hidden
 * or not, and one the board cannot be sure of is refused (request.ts, as for "New here").
 */
export async function forkSession(deps: Deps, app: ForkApp, item: Item, body: unknown): Promise<ForkResult> {
  const b = isRecord(body) ? body : {}
  if (!callable(item) || !item.session) return { ok: false, error: t('fork.err.notClaude', { name: item.name }) }
  if (!item.transcript) return { ok: false, error: t('fork.err.noTranscript', { session: item.session }) }
  // Claude finds a session by the folder it ran in.
  const cwd = (await cwdOf(item.transcript)) || item.cwd
  let workspaces: { id: string; label: string }[]
  try {
    workspaces = (await workspaceList(8000)).map(w => ({ id: w.id, label: w.label ?? '' }))
  } catch (err) {
    return { ok: false, error: t('fork.err.herdr', { why: messageOf(err) }) }
  }
  const { cfg } = deps
  const items = app.items()
  const workspace = sessionWorkspace({
    workspace: item.workspace,
    category: item.category,
    title: categoryInfo(cfg, item.category).title,
    items,
    workspaces,
    board: (cfg.placement ?? 'workspace') === 'workspace' ? (cfg.workspace ?? 'Board') : '',
  })
  const name = String(b.name ?? '').trim() || forkName(item.name, t('fork.mark'))
  const message = typeof b.message === 'string' ? b.message : ''
  const started = await app.launches.start(
    { name, cwd, category: item.category, workspace, message, parent: item.key },
    items,
    { fork: item.session },
  )
  if (!started.ok) return { ok: false, error: started.error, field: started.field }
  deps.log(`fork ${item.name}: ${name} from ${item.session} in ${cwd}`)
  return { ok: true, id: started.id, name, launch: app.launches.list().find(l => l.id === started.id) ?? null }
}
