// The placer (#504, docs/design/nodes 8): where a new session of this master runs. Around the pure
// decision (core/placement.ts place) it keeps what the decision needs and does what it says:
//
// - The view: config.json's `nodes`, each link's state and last status, this computer's own status
//   read by the very code a node answers with (services/node/status.ts), the reservations, and each
//   device's memory gate (gateNext). A status older than 45 s is asked again first, within 1.5 s
//   (needsFresh). A status whose free memory could not be read is no status for the memory test.
// - The task: its lane, profile, agent, "Where", whether a person asked, the device that has its
//   folder, and whether it may leave (core/portable.ts over git's facts, adapters/git.ts; asked only
//   for a lane that may leave). Its brief's paths in system folders every machine has count as none.
// - The decision, one at a time: each counts against its device at once (a reservation), so seven
//   starts in a second do not all see the same room. A reservation lets go when the device's status
//   counts the session, when the start fails, or after 180 s.
// - The start. Here: the launch pipeline as without nodes. On a node: `POST /api/node/launch` through
//   its link. `full`, `profile`, `repo` and `bundle` send it to the next device (that one left out,
//   place() asked again); a lost answer is sent again with the same id, which the node answers with
//   the launch it has; a node that drops before it acknowledged puts the start back in the queue. One
//   it acknowledged is the node's and never starts elsewhere; its card here goes once the node shows it.
// - The queue (adapters/node-queue.ts): a start that waits is a launch in state `queued` with its
//   blocker, kept on disk. Tried again when a device's payload moves (its status asked then), when this
//   computer's awake sessions drop, and every 15 s while anything waits; an entry that cannot go does
//   not hold back one that can, and a device that turned it away is asked again only once its status
//   moved. Cancel takes it out.
//
// Made by server/app.ts only once `nodes` is on; a board without it never reaches any of this.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { relative, sep } from 'node:path'
import { branchPushed, checkoutFacts, gitInfo, headCommit } from '../../adapters/git.ts'
import { createNodeQueue, type NodeQueue, type NodeSource, type QueueEntry } from '../../adapters/node-queue.ts'
import { knobMs, pace } from '../../adapters/pacing.ts'
import { ROOT } from '../../adapters/paths.ts'
import { t } from '../../core/lang.ts'
import { checkBranch } from '../../core/launch/names.ts'
import { NODE_API } from '../../core/node-door.ts'
import { defaultThresholds, LOCAL, type NodeStatus, type NodesConfig, nodeKey, nodesConfig } from '../../core/nodes.ts'
import {
  type Blocker,
  type DeviceState,
  type DeviceStatus,
  gateNext,
  type LaunchPlace,
  liveReservations,
  type NodeTurn,
  needsFresh,
  type PlacementView,
  place,
  type Refusal,
  type Reservation,
  reservedOn,
  type Task,
  type Verdict,
} from '../../core/placement.ts'
import { everyMachineHas, laneLeaves, type Portable, portable, subdirTravels } from '../../core/portable.ts'
import type { Config, Item } from '../../core/types.ts'
import type { Launches, LaunchPlacer } from '../launch/launches.ts'
import type { LaunchRequest } from '../launch/request.ts'
import { type Launch, newLaunch } from '../launch/run.ts'
import { type Clock, realClock } from '../tunnel.ts'
import type { RemotePart } from './aggregate.ts'
import type { NodeLinks } from './links.ts'

/** The queue is tried again this often while anything waits (8.3; BOARD_NODE_QUEUE_MS in tests). */
export const QUEUE_MS = 15_000
/** A lost answer is sent again this many times, this far apart (paced), while the link is up. */
const RESENDS = 3
const RESEND_MS = 1000
/** A node that clones a repository answers when it is done: a big one takes minutes. */
const LAUNCH_ANSWER_MS = 11 * 60_000
const TURNS: readonly NodeTurn[] = ['full', 'profile', 'repo', 'bundle']

export interface PlacerOptions {
  /** The live config. */
  cfg: Config
  links: Pick<NodeLinks, 'link' | 'onChange'>
  /** The devices' part of the payload (services/nodes/aggregate.ts): what each node shows. */
  remote: () => RemotePart | null
  launches: Pick<Launches, 'runLocal' | 'adopt' | 'changed'>
  /** This computer's sessions now. */
  items: () => Item[]
  /** This computer's own status, by the code a node answers with (services/node/status.ts). */
  ownStatus: () => Promise<NodeStatus | null>
  /** Thresholds config.json does not set, written from a device's first status (config-file.ts editNodes). */
  fillThresholds?: (device: string, given: ReturnType<typeof defaultThresholds>) => void
  log(text: string): void
  queue?: NodeQueue
  clock?: Clock
  hostName?: string
  /** This board's commit, asked once; a node takes work only on the same one (6.5). */
  commit?: () => Promise<string>
  /** git's facts of a folder (adapters/git.ts), handed in so tests can stand in. */
  git?: { checkout: typeof checkoutFacts; info: typeof gitInfo; pushed: typeof branchPushed }
  exists?: (path: string) => boolean
}

export interface Placer extends LaunchPlacer {
  close(): void
}

/** One start the placer holds: deciding, on its way to a node, or waiting. */
interface Held {
  l: Launch
  task: Task
  source: NodeSource | null
  /**
   * Devices that turned it away, with when: one is asked again only once a status of it came after
   * that (its room changed), so a queued start does not knock on a full node at every pass.
   */
  left: Map<string, number>
  busy: boolean
  gone: boolean
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A folder below the checkout as a node names it: forward slashes, '' for the checkout itself. */
function subdirOf(root: string, cwd: string): string | null {
  const below = relative(root, cwd)
  if (!below) return ''
  if (below === '..' || below.startsWith(`..${sep}`)) return null
  return below.split(sep).join('/')
}

export function createPlacer(o: PlacerOptions): Placer {
  const clock = o.clock ?? realClock
  const host = o.hostName ?? hostname()
  const queue = o.queue ?? createNodeQueue()
  const git = o.git ?? { checkout: checkoutFacts, info: gitInfo, pushed: branchPushed }
  const exists = o.exists ?? existsSync
  const held = new Map<string, Held>()
  let reservations: Reservation[] = []
  /**
   * Reserved sessions a node shows: `asking` while a status asked after it showed is on its way,
   * `counted` once one came, which counts it among the node's sessions, so its reservation goes.
   */
  const counting = new Map<string, 'asking' | 'counted'>()
  /** Per device, whether its memory gate is closed, and the status it was last worked out from. */
  const gates = new Map<string, { closed: boolean; at: number }>()
  /** Devices whose missing thresholds were written in this process. */
  const filled = new Set<string>()
  let commit: Promise<string> | null = null
  let deciding: Promise<unknown> = Promise.resolve()
  let timer: unknown = null
  let closed = false
  /** This computer's sessions awake at the last refresh: the queue is tried when that number drops. */
  let lastAwake = Number.POSITIVE_INFINITY
  /** Per device, its last status's own time and when this board first had it (its clock, not the node's). */
  const seen = new Map<string, { at: number; got: number }>()
  const asking = new Set<string>()

  const nodes = (): NodesConfig | null => (closed ? null : nodesConfig(o.cfg.nodes, host))
  const ownCommit = (): Promise<string> => {
    commit ??= (o.commit ?? (async () => (await headCommit(ROOT).catch(() => null)) ?? ''))()
    return commit
  }

  /** Decisions one at a time: each sees the reservations of the one before. */
  function decided<T>(fn: () => Promise<T>): Promise<T> {
    const next = deciding.then(fn, fn)
    deciding = next.catch(() => {})
    return next
  }

  /** Whether a device's sessions include one: an item of it, which its status counts (a launch card it does not). */
  function nodeHasItem(device: string, session: string, part = o.remote()): boolean {
    if (!part) return false
    const key = nodeKey(device, session)
    return part.items.some(i => i.device === device && (i.key === key || i.session === session))
  }

  /** Whether a device shows a session: its launch, or an item of that session (core/node-items.ts prefixes both). */
  function nodeShows(device: string, session: string, part = o.remote()): boolean {
    if (!part) return false
    const key = nodeKey(device, session)
    return (
      part.launches.some(x => x.device === device && x.id === key) ||
      part.items.some(i => i.device === device && (i.key === key || i.session === session))
    )
  }

  /**
   * The reservations still held: a session this computer shows is counted by its own status, read
   * fresh at each decision; a node's once a status asked after it showed came (see the link's watch below).
   */
  function heldReservations(now: number): Reservation[] {
    const local = new Set(o.items().map(i => i.session))
    const counted = new Set<string>()
    for (const r of reservations)
      if (r.device === LOCAL ? local.has(r.id) : counting.get(r.id) === 'counted') counted.add(r.id)
    const live = liveReservations(reservations, now, counted)
    for (const id of counting.keys()) if (!live.some(r => r.id === id)) counting.delete(id)
    reservations = live
    return live
  }

  const release = (session: string): void => {
    reservations = reservations.filter(r => r.id !== session)
    counting.delete(session)
  }

  /** A node's status as placement reads it; one whose free memory could not be read is none where memory is tested. */
  function statusFor(s: NodeStatus | null, minFreeMemMb: number | null): DeviceStatus | null {
    if (!s) return null
    if (s.memAvailableMb === null && minFreeMemMb !== null) return null
    return { ...s, memAvailableMb: s.memAvailableMb ?? 0 }
  }

  /** The thresholds config.json does not set, written once from the device's first status. */
  function fill(cfg: NodesConfig, id: string, s: NodeStatus): void {
    if (filled.has(id) || !o.fillThresholds) return
    const d = cfg.devices[id]
    if (!d || (d.maxSessions !== null && d.minFreeMemMb !== null && d.maxLoad !== null)) return
    filled.add(id)
    try {
      o.fillThresholds(id, defaultThresholds(s))
    } catch (err) {
      o.log(`placer: the thresholds of ${id}: ${messageOf(err)}`)
    }
  }

  async function viewOf(cfg: NodesConfig, left: ReadonlyMap<string, number>): Promise<PlacementView> {
    const now = clock.now()
    const devices: Record<string, DeviceState> = {}
    const own = await o.ownStatus().catch(() => null)
    for (const id of cfg.order) {
      if (left.has(id)) continue
      const settings = cfg.devices[id]
      let status: NodeStatus | null
      let online: boolean
      if (id === LOCAL) {
        // This computer starts as it always did, whatever its profiles' folders say of a login: an
        // owner may log in by a key or a token the folder does not show.
        status = own && { ...own, profiles: own.profiles.map(p => ({ ...p, loggedIn: null })) }
        online = true
      } else {
        const link = o.links.link(id)
        status = link?.view().status ?? null
        online = link?.state().state === 'online'
      }
      if (status) fill(cfg, id, status)
      const placed = statusFor(status, settings?.minFreeMemMb ?? null)
      let gate = gates.get(id) ?? { closed: false, at: 0 }
      if (placed && placed.at !== gate.at && settings) {
        gate = { closed: gateNext(settings, placed, gate.closed), at: placed.at }
        gates.set(id, gate)
      }
      if (placed) {
        // A status's age by this board's clock: a node's own may be off by more than 45 s.
        let got = seen.get(id)
        if (got?.at !== placed.at) {
          got = { at: placed.at, got: now }
          seen.set(id, got)
        }
        placed.at = got.got
      }
      devices[id] = { status: placed, online, reserved: 0, gateClosed: gate.closed }
    }
    const live = heldReservations(now)
    for (const [id, d] of Object.entries(devices)) d.reserved = reservedOn(live, id)
    const order = cfg.order.filter(id => !left.has(id))
    const kept = Object.fromEntries(Object.entries(cfg.devices).filter(([id]) => !left.has(id)))
    return {
      config: { ...cfg, order, devices: kept },
      master: { api: NODE_API, commit: await ownCommit() },
      devices,
    }
  }

  /** The decision for one start, with the statuses it needs asked first; it counts against its device at once. */
  function decide(h: Held): Promise<Verdict | null> {
    return decided(async () => {
      const cfg = nodes()
      if (!cfg || h.gone) return null
      let view = await viewOf(cfg, h.left)
      const stale = needsFresh(h.task, view, clock.now())
      if (stale.length) {
        await Promise.all(stale.map(id => o.links.link(id)?.status()))
        view = await viewOf(cfg, h.left)
      }
      if (h.gone) return null
      const v = place(h.task, view, clock.now())
      if ('on' in v) reservations.push({ id: h.l.sessionGiven ?? '', device: v.on, at: clock.now() })
      return v
    })
  }

  // ---------------------------------------------------------------- what a decision does

  const placeOf = (h: Held): LaunchPlace => {
    h.l.place ??= {}
    return h.l.place
  }

  function entryOf(h: Held, wait?: Blocker): QueueEntry {
    const l = h.l
    const request: LaunchRequest = {
      name: l.name,
      label: l.label,
      cwd: l.cwd,
      category: l.category,
      workspaceId: l.workspaceId,
      workspaceLabel: l.workspaceLabel,
      newWorkspace: l.newWorkspace,
      message: l.message,
      worktree: l.worktree,
      profile: l.profile,
      profileDir: l.profileDir,
      configDir: l.configDir,
      parent: l.parent,
      profileArgs: l.profileArgs,
      profileCommand: l.profileCommand,
      agent: l.agent,
      model: l.model,
      ...(l.pin && { pin: l.pin }),
      ...(l.remote && { remote: l.remote }),
    }
    return {
      id: h.l.id,
      session: h.l.sessionGiven ?? '',
      master: nodes()?.id ?? '',
      at: h.l.startedAt,
      request: request as unknown as Record<string, unknown>,
      task: h.task,
      source: h.source,
      ...(wait && { wait }),
    }
  }

  /** Done with a start: out of the queue's file and the placer. */
  function letGo(h: Held): void {
    held.delete(h.l.id)
    try {
      queue.remove(h.l.id)
    } catch (err) {
      o.log(`placer: the queue: ${messageOf(err)}`)
    }
    timerFollows()
  }

  function runHere(h: Held, v: Extract<Verdict, { on: string }>): void {
    const p = placeOf(h)
    delete p.device
    delete p.wait
    if (v.home) p.home = v.home
    h.l.state = 'starting'
    h.l.step = 'prepare'
    letGo(h)
    o.launches.runLocal(h.l)
  }

  function toQueue(h: Held, wait: Blocker | undefined): void {
    const p = placeOf(h)
    // Waiting already on the same thing: nothing to write.
    if (h.l.state === 'queued' && !p.device && JSON.stringify(p.wait) === JSON.stringify(wait)) return
    delete p.device
    if (wait) p.wait = wait
    else delete p.wait
    let kept = false
    try {
      kept = queue.put(entryOf(h, wait))
    } catch (err) {
      o.log(`placer: the queue: ${messageOf(err)}`)
    }
    if (!kept) {
      // 50 wait already, or the file cannot be written: refused rather than held where a restart loses it.
      p.queueFull = true
      h.l.state = 'failed'
      h.l.error = ''
      letGo(h)
      return
    }
    h.l.state = 'queued'
    timerFollows()
  }

  function refuse(h: Held, r: Refusal): void {
    placeOf(h).refuse = r
    h.l.state = 'failed'
    h.l.error = ''
    letGo(h)
  }

  /** What `POST /api/node/launch` carries (6.4). */
  function bodyOf(h: Held, device: string): unknown {
    const l = h.l
    const cfg = nodes()
    const profile = cfg?.devices[device]?.profiles[l.profile] || l.profile
    return {
      id: l.sessionGiven,
      name: l.name,
      category: l.category,
      profile,
      agent: l.agent,
      model: l.model ?? '',
      message: l.message,
      workspace: l.workspaceLabel,
      source: h.source,
    }
  }

  /** The start on a node: acknowledged, turned away (try the next device), or lost (back to the queue). */
  async function send(h: Held, device: string): Promise<'acked' | 'turned' | 'done'> {
    const session = h.l.sessionGiven ?? ''
    const p = placeOf(h)
    p.device = device
    delete p.wait
    h.l.state = 'starting'
    h.l.step = h.source?.kind === 'repo' ? 'cloning' : 'placing'
    o.launches.changed()
    const body = JSON.stringify(bodyOf(h, device))
    for (let tries = 0; tries <= RESENDS && !h.gone; tries++) {
      if (tries) await new Promise<void>(r => clock.setTimeout(() => r(), Math.round(RESEND_MS * pace())))
      const link = o.links.link(device)
      const up = link?.state().state === 'online'
      if (!link || !up) break
      let res: Response
      try {
        res = await link.fetch('/api/node/launch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(LAUNCH_ANSWER_MS),
        })
      } catch {
        continue
      }
      const answer = (await res.json().catch(() => null)) as { error?: unknown; detail?: unknown } | null
      if (res.status === 202) {
        h.l.state = 'done'
        h.l.doneAt = clock.now()
        letGo(h)
        return 'acked'
      }
      const error = typeof answer?.error === 'string' ? answer.error : ''
      if (res.status === 409 && (TURNS as readonly string[]).includes(error)) {
        release(session)
        p.turned = [...(p.turned ?? []).filter(x => x.device !== device), { device, error: error as NodeTurn }]
        h.left.set(device, clock.now())
        return 'turned'
      }
      // The node's own launch pipeline refused the start: that is its answer, not a lost one. A
      // token the node no longer takes, or its lockout, is a link that is down, not an answer.
      if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403 && res.status !== 429) {
        release(session)
        h.l.state = 'failed'
        h.l.error = typeof answer?.detail === 'string' ? answer.detail : error
        letGo(h)
        return 'done'
      }
      // 5xx, node-offline, a refused token: the answer is lost; the same id again is the same start there.
    }
    release(session)
    if (!h.gone) toQueue(h, { device, kind: 'offline' })
    return 'done'
  }

  /** Decides a start and does what the decision says, trying the next device while nodes turn it away. */
  async function go(h: Held): Promise<void> {
    if (h.busy || h.gone || closed) return
    h.busy = true
    const before = JSON.stringify([h.l.state, h.l.step, h.l.place])
    try {
      // A device that has the session already took it, whatever answer was lost on the way: it is
      // that device's, and never started elsewhere.
      const session = h.l.sessionGiven ?? ''
      const part = o.remote()
      const there = part?.devices.find(d => d.id !== LOCAL && nodeShows(d.id, session, part))
      if (there) {
        placeOf(h).device = there.id
        delete placeOf(h).wait
        h.l.state = 'done'
        h.l.doneAt = clock.now()
        letGo(h)
        return
      }
      // A device that turned it away is asked again once a status of it came since.
      for (const [device, at] of h.left) if ((seen.get(device)?.got ?? 0) > at) h.left.delete(device)
      for (;;) {
        const v = await decide(h)
        if (!v && !h.gone) return nodesGone(h)
        if (!v || h.gone) {
          if (v && 'on' in v) release(h.l.sessionGiven ?? '')
          return
        }
        if ('on' in v) {
          if (v.on === LOCAL) return runHere(h, v)
          if ((await send(h, v.on)) === 'turned') continue
          return
        }
        if ('wait' in v) return toQueue(h, v.wait)
        // Every device that could have taken it turned it away now: it waits for one that may.
        if (h.left.size) return toQueue(h, undefined)
        return refuse(h, v.refuse)
      }
    } catch (err) {
      o.log(`placer: ${h.l.name}: ${messageOf(err)}`)
      release(h.l.sessionGiven ?? '')
      if (!h.gone) toQueue(h, undefined)
    } finally {
      h.busy = false
      if (JSON.stringify([h.l.state, h.l.step, h.l.place]) !== before) o.launches.changed()
    }
  }

  /** `nodes` left config.json while a start was held: it runs here as without nodes, or not at all for a node's folder. */
  function nodesGone(h: Held): void {
    if (h.l.remote) {
      h.l.state = 'failed'
      h.l.error = t('launch.err.cwdMissing', { path: h.l.cwd })
      letGo(h)
      return
    }
    h.l.state = 'starting'
    h.l.step = 'prepare'
    letGo(h)
    o.launches.runLocal(h.l)
  }

  // ---------------------------------------------------------------- the queue

  const waiting = (): Held[] => [...held.values()].filter(h => h.l.state === 'queued' && !h.busy)

  /**
   * Every waiting start once, oldest first. Their decisions run one after another (decided), but
   * none waits for another's start on a node: one that cannot go, or goes slowly, holds back none.
   */
  function kick(): void {
    if (closed) return
    for (const h of waiting().sort((a, b) => a.l.startedAt - b.l.startedAt)) void go(h)
  }

  function timerFollows(): void {
    const any = [...held.values()].some(h => h.l.state === 'queued')
    if (any && timer === null && !closed)
      timer = clock.setInterval(() => kick(), knobMs('BOARD_NODE_QUEUE_MS', QUEUE_MS))
    else if (!any && timer !== null) {
      clock.clearInterval(timer)
      timer = null
    }
  }

  // A device's payload moved (a session showed, went to sleep or ended) or its link came up: its
  // status is asked then. What it says counts the reserved sessions that showed before it was asked,
  // and the queue is tried with it.
  function watch(id: string, after = false): void {
    if (closed || asking.has(id)) return
    const link = o.links.link(id)
    if (!link) return
    // A device heard from for the first time gets the thresholds config.json does not set.
    const cfg = nodes()
    const status = link.view().status
    if (cfg && status) fill(cfg, id, status)
    else if (cfg && !filled.has(id))
      void link
        .status()
        .then(s => {
          const now = nodes()
          if (now && s) fill(now, id, s)
        })
        .catch(() => {})
    const part = o.remote()
    const showing = reservations.filter(r => r.device === id && !counting.has(r.id) && nodeHasItem(id, r.id, part))
    // Right after an answer only what showed meanwhile is asked about: the queue had its try.
    if (!showing.length && (after || !waiting().length)) return
    for (const r of showing) counting.set(r.id, 'asking')
    asking.add(id)
    void link
      .status()
      .catch(() => null)
      .then(status => {
        asking.delete(id)
        for (const r of showing)
          if (status) counting.set(r.id, 'counted')
          else counting.delete(r.id)
        // What showed while that status was on its way is asked about again.
        watch(id, true)
        kick()
      })
  }
  const off = o.links.onChange(watch)

  // ---------------------------------------------------------------- a start the placer takes

  /** What the task is: its lane may leave, its folder travels in git, its brief names nothing of here. */
  async function taskOf(
    l: Launch,
    byHand: boolean,
    cfg: NodesConfig,
  ): Promise<{ task: Task; source: NodeSource | null }> {
    const base = {
      lane: l.category,
      profile: l.profile,
      agent: l.agent,
      byHand,
      ...(l.pin && { pin: l.pin }),
    }
    if (l.remote) {
      // A folder of the pinned node: it starts there or nowhere.
      return {
        task: { ...base, origin: l.remote, portable: { ok: true } },
        source: { kind: 'path', cwd: l.cwd, worktree: l.worktree },
      }
    }
    const home = (p: Portable): { task: Task; source: null } => ({
      task: { ...base, origin: LOCAL, portable: p },
      source: null,
    })
    if (!laneLeaves(l.category, cfg.lanes)) return home({ ok: false, why: { kind: 'lane' } })
    const [facts, info] = await Promise.all([git.checkout(l.cwd), git.info(l.cwd)])
    const branch = info && info.branch !== 'HEAD' ? info.branch : ''
    const subdir = facts ? subdirOf(facts.root, l.cwd) : null
    // A remote a node cannot clone (a folder of this computer) is no remote for this rule.
    const remote = facts?.remote?.address && subdir !== null ? facts.remote.url : null
    const worktree = l.worktree
      ? { branch: branch || 'HEAD', pushed: !!branch && (await git.pushed(facts?.root ?? l.cwd, branch)) }
      : null
    const verdict = portable({
      lane: l.category,
      lanes: cfg.lanes,
      checkout: facts ? { remote, clean: facts.clean, headPushed: facts.headPushed && !!branch } : null,
      worktree,
      brief: l.message,
      exists: path => !everyMachineHas(path) && exists(path),
    })
    if (!verdict.ok || !facts?.remote || subdir === null)
      return home(verdict.ok ? { ok: false, why: { kind: 'no-remote' } } : verdict)
    // A branch or folder name a node does not take stays here rather than failing there.
    if (branch && checkBranch(branch)) return home({ ok: false, why: { kind: 'name', name: branch } })
    if (!subdirTravels(subdir)) return home({ ok: false, why: { kind: 'name', name: subdir } })
    return {
      task: { ...base, origin: LOCAL, portable: verdict },
      source: { kind: 'repo', url: facts.remote.url, ref: branch, subdir, worktree: l.worktree },
    }
  }

  function adopt(e: QueueEntry): void {
    const request = e.request as unknown as LaunchRequest
    const l = newLaunch(request, o.items())
    l.id = e.id
    l.sessionGiven = e.session
    l.startedAt = e.at
    l.state = 'queued'
    l.step = 'placing'
    l.place = e.wait ? { wait: e.wait } : {}
    held.set(l.id, { l, task: e.task, source: e.source, left: new Map(), busy: false, gone: false })
    o.launches.adopt(l)
  }

  // What waited when this board stopped waits again, its own entries only.
  const cfg0 = nodes()
  if (cfg0) {
    let entries: QueueEntry[] = []
    try {
      entries = queue.read(cfg0.id)
    } catch (err) {
      o.log(`placer: the queue: ${messageOf(err)}`)
    }
    for (const e of entries)
      try {
        adopt(e)
      } catch (err) {
        o.log(`placer: the queue's entry ${e.id}: ${messageOf(err)}`)
      }
  }
  timerFollows()
  if (held.size) kick()
  // This computer's thresholds from its own figures, as a node's from its first status.
  void o
    .ownStatus()
    .then(s => {
      const cfg = nodes()
      if (cfg && s) fill(cfg, LOCAL, s)
    })
    .catch(() => {})

  return {
    take(l, byHand) {
      const cfg = nodes()
      l.sessionGiven ??= randomUUID()
      l.state = 'starting'
      l.step = 'placing'
      l.place = {}
      const h: Held = {
        l,
        task: {
          lane: l.category,
          profile: l.profile,
          agent: l.agent,
          byHand,
          origin: LOCAL,
          portable: { ok: false, why: { kind: 'lane' } },
        },
        source: null,
        left: new Map(),
        busy: true,
        gone: false,
      }
      held.set(l.id, h)
      void (async () => {
        try {
          if (cfg) Object.assign(h, await taskOf(l, byHand, cfg))
        } catch (err) {
          o.log(`placer: ${l.name}: ${messageOf(err)}`)
        }
        h.busy = false
        await go(h)
      })()
    },
    cancel(id) {
      const h = held.get(id)
      if (!h) return
      h.gone = true
      release(h.l.sessionGiven ?? '')
      letGo(h)
    },
    shown(l) {
      return !!l.place?.device && !!l.sessionGiven && nodeShows(l.place.device, l.sessionGiven)
    },
    observe(items) {
      const awake = items.filter(i => !i.sleeping).length
      const dropped = awake < lastAwake
      lastAwake = awake
      if (dropped && waiting().length) kick()
    },
    close() {
      closed = true
      off()
      if (timer !== null) clock.clearInterval(timer)
      timer = null
    },
  }
}
