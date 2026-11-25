// spawn-agent asks the board (#505, docs/design/nodes 8.5), the logic without the network: which
// starts the board may place, the request spawn-agent posts for one, and what the board's payload
// says became of it, as the line spawn-agent prints. services/launch/spawn-board.ts asks.
import { nodeKey, parseNodeKey } from '../nodes.ts'
import { isPiItem, piSessionId } from '../pi.ts'
import type { Item, LaunchView, Translator } from '../types.ts'
import { deviceName, refusalText } from './place-text.ts'
import type { SpawnOptions } from './spawn-args.ts'

/**
 * Whether the placer may take this start: a new session an agent asks for. Not a resume, a fork,
 * a start in a pane, a Workdesk worker, nor a start that names its session id or its profile
 * folder (the board's own launcher calling, --session-id, --config-dir, --keep-env). Nor one with
 * --trust: the board's starts do not answer the trust dialog for the agent, its card asks the owner.
 */
export const placeable = (o: SpawnOptions): boolean =>
  o.resume === undefined &&
  o.fork === undefined &&
  o.pane === undefined &&
  !o.workdeskWorker &&
  o.sessionId === undefined &&
  o.configDir === undefined &&
  !o.keepEnv &&
  !o.trust

/** The session that runs spawn-agent, as the board shows it: by its Claude or Antigravity id, else by its herdr pane. */
export function callerOf(items: readonly Item[], env: Record<string, string | undefined>): Item | undefined {
  const own = env.CLAUDE_CODE_SESSION_ID || env.ANTIGRAVITY_CONVERSATION_ID
  const pane = env.HERDR_PANE_ID
  const here = items.filter(i => !i.device)
  return (
    (own ? here.find(i => i.key === own || i.session === own) : undefined) ??
    (pane ? here.find(i => i.pane === pane) : undefined)
  )
}

/** What the request names beside the options: the facts spawn-agent found here. */
export interface BoardStartFacts {
  /** The folder, absolute. */
  cwd: string
  message: string
  workspace: { id: string; label?: string }
  /** The caller's lane; absent: the board's 'other'. */
  category?: string
  /** The profile the start is in, as spawn-agent decides it here (core/profiles.ts spawnEnv). */
  profile?: string
  /** The caller's card, when its profile is that one: the board would refuse a parent of another. */
  parent?: string
}

/** `POST /api/launch` for a start an agent asks for: `byHand: false`, so with every device full it waits. */
export function launchBody(o: SpawnOptions, f: BoardStartFacts): Record<string, unknown> {
  return {
    name: o.name,
    cwd: f.cwd,
    ...(o.label?.trim() && { label: o.label.trim() }),
    message: f.message,
    workspace: f.workspace,
    ...(f.category && { category: f.category }),
    ...(f.profile && { profile: f.profile }),
    ...(f.parent && { parent: f.parent }),
    ...(o.model && { model: o.model }),
    ...(o.agent && { agent: o.agent }),
    byHand: false,
  }
}

/** The start as spawn-agent follows it: the launch's id, the session id the board gave it, and what was seen so far. */
export interface Followed {
  id: string
  session: string | null
  name: string
  /** The device the placer sent it to, once a payload said. */
  device: string | null
  /** The launch was in a payload once: one that is gone and left nothing was taken off the board. */
  seen: boolean
}

/**
 * What became of the start. `pending`: not yet (with what was learnt); `here`: it ran on this
 * computer, in that pane (herdr's name for it is asked after); `printed`: the line, exit 0;
 * `failed`: the reason, exit 1.
 */
export type Outcome =
  | { kind: 'pending'; device: string | null; seen: boolean }
  | { kind: 'here'; pane: string; agent: string }
  | { kind: 'printed'; line: string }
  | { kind: 'failed'; error: string }

const DIALOG = new Set(['trust', 'waiting'])

/** Whether a node's item is this session: its key there, its session id, or pi's file named after it. */
function ofSession(i: Item, session: string): boolean {
  const own = parseNodeKey(i.key)?.key ?? i.key
  const sid = parseNodeKey(i.session ?? '')?.key ?? i.session
  return own === session || sid === session || (isPiItem({ ...i, session: sid }) && piSessionId(sid) === session)
}

/** The node that shows the session, by its own launch or its item; null when none does. */
function deviceOf(items: readonly Item[], launches: readonly LaunchView[], session: string): string | null {
  const theirs = launches.find(l => !!l.device && parseNodeKey(l.id)?.key === session)
  return theirs?.device ?? items.find(i => !!i.device && ofSession(i, session))?.device ?? null
}

/** The line for a start the placer sent to a node: its key there is the agent to address. */
export function nodeLine(device: string, pane: string | null, session: string, name: string): string {
  return `pane=@${device}:${pane || session} name=${name} agent=${nodeKey(device, session)} device=${device} session=${session}`
}

/** The line for a start that waits in the placer's queue: what it waits on, as a device and a kind. */
export function queuedLine(l: Pick<LaunchView, 'id' | 'place'>, name: string): string {
  const wait = l.place?.wait
  const turned = l.place?.turned?.[0]
  const why = wait ? `${wait.device}:${wait.kind}` : turned ? `${turned.device}:${turned.error}` : 'none'
  return `queued=${l.id} name=${name} waiting=${why}`
}

/** What the board's payload (its items, launches and devices) says of the start. */
export function outcomeOf(
  payload: { items?: unknown; launches?: unknown; devices?: unknown },
  f: Followed,
  t: Translator,
): Outcome {
  const items = Array.isArray(payload.items) ? (payload.items as Item[]) : []
  const launches = Array.isArray(payload.launches) ? (payload.launches as LaunchView[]) : []
  const devices = Array.isArray(payload.devices)
    ? payload.devices.flatMap(d =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as { id?: unknown }).id === 'string' &&
        typeof (d as { title?: unknown }).title === 'string'
          ? [
              {
                id: (d as { id: string }).id,
                title: (d as { title: string }).title,
                ...(typeof (d as { selfId?: unknown }).selfId === 'string' && {
                  selfId: (d as { selfId: string }).selfId,
                }),
              },
            ]
          : [],
      )
    : undefined
  const own = launches.find(l => l.id === f.id && !l.device)
  const seen = f.seen || !!own
  const session = f.session
  // While the board shows its own launch, that says where it goes: a node that turned it away is no
  // longer it (the placer may run it here). Once the node shows it the launch is gone from the
  // board's list, and the node's own launch or item, found by the session, names the device.
  const device = own ? (own.place?.device ?? null) : (f.device ?? (session ? deviceOf(items, launches, session) : null))
  if (own) {
    if (own.state === 'queued') return { kind: 'printed', line: queuedLine(own, f.name) }
    if (own.state === 'failed') {
      const why = own.place?.refuse
        ? refusalText(own.place.refuse, t, devices)
        : own.place?.queueFull
          ? t('place.queueFull')
          : own.error
      return { kind: 'failed', error: why || 'the board could not start it: see its card on the board' }
    }
    if (DIALOG.has(own.state))
      return {
        kind: 'failed',
        error: `Claude in ${own.pane ?? 'its tab'} waits for a dialog (folder trust?). Answer it on its card on the board, which finishes the start.`,
      }
  }
  if (device && session) {
    const key = nodeKey(device, session)
    const label = deviceName(device, t, devices)
    const theirs = launches.find(l => l.device === device && l.id === key)
    if (theirs?.state === 'failed')
      return { kind: 'failed', error: `on ${label}: ${theirs.error || 'the start failed: see its card on the board'}` }
    if (theirs && DIALOG.has(theirs.state))
      return {
        kind: 'failed',
        error: `Claude on ${label} waits for a dialog (folder trust?). Answer it on its card on the board, which finishes the start.`,
      }
    const item = items.find(i => i.device === device && ofSession(i, session))
    if (item && (!theirs || theirs.state === 'done'))
      return { kind: 'printed', line: nodeLine(device, item.pane, session, f.name) }
    // Done there, its card not on the board yet (pi's is keyed by its file only once pi is up).
    if (theirs?.state === 'done') return { kind: 'printed', line: nodeLine(device, theirs.pane, session, f.name) }
    return { kind: 'pending', device, seen }
  }
  // On this computer: the board's own launcher ran it, and its launch says the pane once it is done.
  const mine = session
    ? items.find(i => !i.device && (i.session === session || (isPiItem(i) && piSessionId(i.session) === session)))
    : undefined
  if (own?.state === 'done' || (!own && mine)) {
    const pane = own?.pane ?? mine?.pane
    if (pane) return { kind: 'here', pane, agent: mine?.agent || own?.agent || 'claude' }
  }
  if (!own && seen && !mine) return { kind: 'failed', error: 'the start was taken off the board' }
  return { kind: 'pending', device, seen }
}
