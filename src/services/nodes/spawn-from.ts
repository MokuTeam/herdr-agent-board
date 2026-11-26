// spawn-agent on a node (#760): the master places a start a node's session asked for as it places
// one of its own (spawn-board.ts askBoard, #505). The node sends the folder as it names it and what
// only it can read of it (core/launch/spawn-node.ts NodeFolderFacts); the start goes through this
// board's launches with that node as the folder's device, so the placer's rule (core/portable.ts)
// decides over the node's checkout: one that may leave goes anywhere as a repository (this computer
// clones it, services/node/checkout.ts), one that may not stays on the node in its own folder.
//
// --device pins it: `local` or this board's own id is this computer; another device must be one of
// `nodes` with its link online, else the start is refused before anything runs. A profile the node
// names that this board does not have (nor maps to it in `nodes.devices.<node>.profiles`) can run
// only on the node.
//
// The answer is spawn-agent's line, followed here as askBoard follows it, for at most
// SPAWN_FOLLOW_MAX_SEC. Exit SPAWN_NOT_STARTED: refused before any start, so the node may start it
// itself; 1: it may have started, the node must not start it again.
import { hostname } from 'node:os'
import { isRecord } from '../../adapters/json-store.ts'
import { pause } from '../../adapters/pacing.ts'
import { categoryFor, resolveSpawnLane } from '../../core/categories.ts'
import { parentProfile } from '../../core/item-profile.ts'
import { t } from '../../core/lang.ts'
import { type Followed, outcomeOf } from '../../core/launch/spawn-board.ts'
import { SPAWN_FOLLOW_MAX_SEC, SPAWN_NOT_STARTED, spawnCallOf } from '../../core/launch/spawn-node.ts'
import type { UplinkCall, UplinkResult } from '../../core/node-uplink.ts'
import { LOCAL, nodesConfig } from '../../core/nodes.ts'
import type { ProfileSet } from '../../core/profiles.ts'
import type { Config, Item, LaunchView } from '../../core/types.ts'
import type { StartOptions, StartResult } from '../launch/launches.ts'

export interface SpawnFromDeps {
  /** The live config: `nodes` is read at each call. */
  cfg: Config
  /** This board's launches.start, with the board's cards for a parent. */
  start(body: unknown, options: StartOptions): Promise<StartResult>
  /** The board's payload as `GET /api/board` gives it (items, launches, devices); null when it cannot be had. */
  payload(): Promise<Record<string, unknown> | null>
  /** This board's profiles. */
  profiles(): ProfileSet
  /** Whether the link to a device is online now. */
  online(device: string): boolean
  /** herdr's workspaces on this computer, for the caller's workspace by its label. */
  workspaces(): Promise<{ id: string; label: string | undefined }[]>
  /** herdr's name for the agent in a pane of this computer. */
  herdrName(pane: string): Promise<string>
  /**
   * Take this board's launch off it (launches.dismiss, #798): a start refused before anything ran
   * goes back to the node, which starts it itself, so its failed card here would only be a stray.
   */
  dismiss?: (id: string) => void
  /**
   * The start was taken (the board has its launch): told before it is followed, so a call sent again
   * meanwhile (this board started over) is not a second start.
   */
  taken?: () => void
  hostName?: string
}

/** The node's session as the uplink found it (services/nodes/uplink.ts sessionOf). */
export interface SpawnCaller {
  key: string
  item: Item | undefined
  lane: string | null
}

const notStarted = (line: string): UplinkResult => ({ code: SPAWN_NOT_STARTED, out: [], err: [line] })
const failed = (line: string): UplinkResult => ({ code: 1, out: [], err: [line] })
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * This board's profile for a profile id of the node: the one `nodes.devices.<node>.profiles` maps to
 * it, else the same id when this board has it shown; null when it has none.
 */
export function masterProfileOf(
  mapped: Readonly<Record<string, string>> | undefined,
  set: ProfileSet,
  nodeId: string,
): string | null {
  for (const [ours, theirs] of Object.entries(mapped ?? {}))
    if (theirs === nodeId && set.list.some(p => p.id === ours && !p.hidden)) return ours
  // The same id, unless the board's profile of that id is another one of the node's.
  const same = mapped?.[nodeId]
  if (same !== undefined && same !== nodeId) return null
  return set.list.some(p => p.id === nodeId && !p.hidden) ? nodeId : null
}

export async function spawnFrom(
  device: string,
  who: SpawnCaller,
  call: UplinkCall,
  d: SpawnFromDeps,
): Promise<UplinkResult> {
  const req = spawnCallOf(call.argv)
  if (!req) return notStarted("the start the node sent is not one the board's computer reads")
  const nodes = nodesConfig(d.cfg.nodes, d.hostName ?? hostname())
  if (!nodes) return notStarted("the board's computer places no starts now (no nodes in its config.json)")
  const self = nodes.id

  // --device: this computer by either name; another one of `nodes`, online.
  let pin: string | undefined
  if (req.device !== undefined) {
    pin = req.device === self ? LOCAL : req.device
    if (pin !== LOCAL) {
      if (!Object.hasOwn(nodes.devices, pin))
        return notStarted(
          `--device ${req.device}: the board has no such device (it has ${[self, ...nodes.order.filter(id => id !== LOCAL)].join(', ')})`,
        )
      if (nodes.devices[pin]?.revoked) return notStarted(`--device ${req.device}: the device was taken off the board`)
      if (!d.online(pin))
        return notStarted(`--device ${req.device}: the device is offline, so the start cannot go there now`)
    }
  }

  // The profile as this board knows it; a node's own one runs only there.
  const set = d.profiles()
  const asked = req.profile
  const ours = asked === undefined ? null : masterProfileOf(nodes.devices[device]?.profiles, set, asked)
  const nodeProfile = asked !== undefined && ours === null
  if (nodeProfile) {
    if (req.facts === null || (pin !== undefined && pin !== device))
      return notStarted(
        `the profile ${asked} is ${device}'s own, which the board's computer does not have: the start can run only on ${device}`,
      )
    pin = device
  }
  const profile = nodeProfile ? asked : (ours ?? undefined)

  // The node's folder, or (none there) one of the device pinned, or of this computer.
  if (req.facts === null && pin === undefined) return notStarted(`no folder ${req.cwd} on ${device}`)
  if (req.facts === null && pin === device) return notStarted(`no folder ${req.cwd} on ${device}`)

  // Its workspace by label: one this computer has already, for a session that runs here.
  // The folder's last name either way a node writes it (a Windows node's path on a POSIX master).
  const label = (req.workspace || req.cwd.split(/[\\/]/).filter(Boolean).at(-1) || req.name).slice(0, 40)
  const workspace = await d
    .workspaces()
    .then(list => list.find(w => w.label === label))
    .then(
      w => (w ? { id: w.id, label } : { create: label }),
      () => ({ create: label }),
    )
  // The caller's card is the parent only when the board would start in its profile anyway.
  const parent =
    who.item && (nodeProfile || (profile !== undefined && parentProfile(who.item, set.list)?.id === profile))
      ? who.key
      : undefined
  const category = resolveSpawnLane({
    explicit: req.lane,
    folderLane: categoryFor(d.cfg, req.cwd),
    callerLane: who.lane,
  })
  const body = {
    name: req.name,
    cwd: req.cwd,
    ...(req.label?.trim() && { label: req.label.trim() }),
    message: req.message,
    workspace,
    ...(category && { category }),
    ...(profile !== undefined && { profile }),
    ...(parent && { parent }),
    ...(req.model && { model: req.model }),
    ...(req.agent && { agent: req.agent }),
    ...(pin !== undefined && { pin: { device: pin } }),
    byHand: false,
  }
  let started: StartResult
  try {
    started = await d.start(body, {
      byHand: false,
      ...(req.facts !== null && { origin: { device, facts: req.facts, ...(nodeProfile && { nodeProfile: true }) } }),
      ...(req.trust && { trust: true }),
    })
  } catch (err) {
    return failed(
      `the board's computer did not take the start (${messageOf(err)}): see the board before starting it again`,
    )
  }
  if (!started.ok) return notStarted(started.field ? `${started.error} (${started.field})` : started.error)
  d.taken?.()

  // Followed as spawn-agent follows a start on its own board.
  let f: Followed = { id: started.id, session: started.session ?? null, name: req.name, device: null, seen: false }
  const secs = Math.min(req.timeoutSec, SPAWN_FOLLOW_MAX_SEC)
  const deadline = Date.now() + secs * 1000
  while (Date.now() < deadline) {
    const payload = await d.payload()
    if (payload) {
      const r = outcomeOf(payload, f, t)
      if (r.kind === 'printed') return { code: 0, out: [r.line], err: [] }
      if (r.kind === 'failed') {
        if (!refusedBefore(payload, f.id)) return failed(r.error)
        // Nothing ran: the node starts it (no --device) or says why, and no card of it stays here.
        d.dismiss?.(f.id)
        return notStarted(r.error)
      }
      if (r.kind === 'here') {
        const sid = f.session ?? ''
        return {
          code: 0,
          out: [
            `pane=@${self}:${r.pane} name=${req.name} agent=${await d.herdrName(r.pane)} device=${self} session=${sid}`,
          ],
          err: [],
        }
      }
      f = { ...f, device: r.device, seen: r.seen }
    }
    await pause(1000)
  }
  return failed(
    f.device
      ? `the start went to ${f.device} and did not show there within ${secs} s: see its card on the board`
      : `the board did not finish the start within ${secs} s: see its card on the board`,
  )
}

/** Whether the board's launch failed in placement, before anything ran: a refusal or a full queue. */
function refusedBefore(payload: Record<string, unknown>, id: string): boolean {
  const launches = Array.isArray(payload.launches) ? (payload.launches as LaunchView[]) : []
  const own = launches.find(l => isRecord(l) && l.id === id && !l.device)
  return !!own && own.state === 'failed' && !!(own.place?.refuse || own.place?.queueFull || own.place?.checkout)
}
