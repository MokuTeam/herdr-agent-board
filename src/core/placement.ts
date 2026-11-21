// Where a new session runs (design: docs/design/nodes, 8.1 to 8.3). The owner orders the devices
// once; the board fills them in that order by what each has room for. One pure function over a
// view the placer builds (services/nodes/placer.ts): the order and each device's settings as
// config.json's `nodes` gives them, each device's last status, the placer's reservations and the
// memory gate. Nothing here asks a device or keeps a value between calls.

import { type Lanes, laneLeaves, type Portable, type PortableWhy } from './portable.ts'

/** A device's id; `local` is this computer in this board's own order. */
export type DeviceId = string
export const LOCAL: DeviceId = 'local'

/** One device's settings in `nodes.devices`. A null threshold is no limit of that kind. */
export interface DeviceSettings {
  id: DeviceId
  maxSessions: number | null
  minFreeMemMb: number | null
  /** The 5 minute load per core; not looked at where the platform has no load average. */
  maxLoad: number | null
  tags: readonly string[]
  /** The master's profile id to the node's; a profile it does not name has the same id there. */
  profiles?: Readonly<Record<string, string>> | null
  paused: boolean
  drain: boolean
}

/** The part of config.json's `nodes` placement reads; `NodesConfig` passes as it is. */
export interface PlacementConfig {
  order: readonly DeviceId[]
  whenFull: 'local' | 'wait'
  lanes?: Lanes
  devices: Readonly<Record<DeviceId, DeviceSettings>> | readonly DeviceSettings[]
}

/** A device's status as it reports it (6.3), only the fields placement reads. */
export interface DeviceStatus {
  memAvailableMb: number
  /** 1, 5 and 15 minute load averages; null where the platform has none (Windows). */
  load: readonly [number, number, number] | null
  cpus: number
  sessions: { awake: number; working: number; asleep: number }
  profiles: readonly { id: string; loggedIn: boolean | null }[]
  agents: readonly string[]
  commit: string
  api: number
  at: number
}

/** What the placer knows of one device right now. */
export interface DeviceState {
  /** The last status, or null when none came yet. */
  status: DeviceStatus | null
  /** The link is up. This computer is always online. */
  online: boolean
  /** Starts the placer sent there that the device's sessions do not show yet. */
  reserved: number
  /** The memory gate is closed: see gateNext. */
  gateClosed: boolean
  revoked?: boolean
  /** This board's commit is on its way to the device (#590): a `commit` refusal says so. */
  updating?: boolean
}

export interface PlacementView {
  config: PlacementConfig
  /** The master's own link version and commit: a node runs a start only on the same ones. */
  master: { api: number; commit: string }
  /** By device id, `local` included. A device with no entry has never been heard from. */
  devices: Readonly<Record<DeviceId, DeviceState>>
}

export interface Task {
  lane: string
  profile: string
  agent: string
  /** "Where" in the New session window: a device or a tag. Absent: the whole order. */
  pin?: { device: DeviceId } | { tag: string } | null
  /** Tags the device must have. */
  needs?: readonly string[]
  /** The device that has the folder, `local` for this computer. */
  origin: DeviceId
  /** portable() over the task's facts. */
  portable: Portable
  /** A person pressed the button. */
  byHand: boolean
}

export type Pin = NonNullable<Task['pin']>

/** What keeps a device that fits from taking one more start now (8.2). */
export type Blocker =
  | { device: DeviceId; kind: 'no-status' | 'offline' }
  | { device: DeviceId; kind: 'sessions'; busy: number; max: number }
  /** needMb is the gate's return threshold when it is closed. */
  | { device: DeviceId; kind: 'memory'; freeMb: number; needMb: number }
  /** The 5 minute load per core. */
  | { device: DeviceId; kind: 'load'; perCore: number; max: number }

/** Why a device can never take this task as it is (8.1, step 3). */
export type Unfit =
  | { device: DeviceId; kind: 'not-set-up' | 'revoked' | 'paused' | 'draining' }
  | { device: DeviceId; kind: 'tags'; missing: string[] }
  | { device: DeviceId; kind: 'api'; theirs: number; ours: number }
  /** `updating`: this board's commit is on its way there (#590). */
  | { device: DeviceId; kind: 'commit'; theirs: string; ours: string; updating?: true }
  | { device: DeviceId; kind: 'no-profile' | 'not-logged-in'; profile: string }
  | { device: DeviceId; kind: 'no-agent'; agent: string }

/** Why no device could ever take the task. */
export type Refusal =
  /** The pin names no device in the order (or the order is empty). */
  | { kind: 'no-device'; pin?: Pin }
  /** Every candidate failed step 3, each with its reason, in order. */
  | { kind: 'unfit'; devices: Unfit[] }
  /** The task must stay at its origin and the pin points elsewhere: both are kept for the card. */
  | { kind: 'pinned-away'; pin: Pin; origin: DeviceId; home: PortableWhy }

/**
 * The decision, as data the page words in the board's language: core builds no sentence.
 * `why`: a device had room, the task stays at its origin (`home` says why), or every device was
 * full and a start by hand came here (`whenFull: "local"`).
 */
export type Verdict =
  | { on: DeviceId; why: 'room' | 'home' | 'full'; home?: PortableWhy } // start here
  | { wait: Blocker } // queue it; the first candidate's blocker goes on the launch's card
  | { refuse: Refusal } // no device could ever take it

/** What a node answers a start it does not take (6.4): the placer sends the start to the next device. */
export type NodeTurn = 'full' | 'profile' | 'repo' | 'bundle'

/**
 * A master's start on its launch card (#504), as data the page words (core/i18n/node-strings.ts):
 * the device it goes to, why it stays at its origin, the blocker it waits on, the refusal, and the
 * devices that turned it away on the way.
 */
export interface LaunchPlace {
  /** Where it goes or went; absent while the board chooses. */
  device?: DeviceId
  home?: PortableWhy
  wait?: Blocker
  refuse?: Refusal
  turned?: { device: DeviceId; error: NodeTurn }[]
  /** Refused because 50 starts wait already (8.3). */
  queueFull?: true
}

/** What one start is counted as on its device until the device shows it (8.2). */
export const RESERVED_MB = 800
/** A reservation lets go by itself after this long, in case the device never shows the session. */
export const RESERVATION_MS = 180_000
/** A status older than this is asked again before deciding (needsFresh). */
export const STATUS_MAX_AGE_MS = 45_000
/** The memory gate opens again only this far above its threshold, so a device does not flap. */
export const GATE_RETURN = 1.15

/**
 * The memory test of 8.2 on a free figure: at least `min`, or with the gate closed more than
 * `min × 1.15`, compared as whole numbers (free × 20 against min × 23) so a threshold at
 * equality does not land on either side by a float's rounding.
 */
function memoryPasses(free: number, min: number, closed: boolean): boolean {
  return closed ? free * 20 > min * 23 : free >= min
}

/** One start counted against a device: from the decision until its session shows, it fails or 180 s pass. */
export interface Reservation {
  id: string
  device: DeviceId
  at: number
}

/** The reservations still held: none older than RESERVATION_MS, none whose session the device shows. */
export function liveReservations(
  list: readonly Reservation[],
  now: number,
  shown: ReadonlySet<string> = new Set(),
): Reservation[] {
  return list.filter(r => now - r.at < RESERVATION_MS && !shown.has(r.id))
}

/** How many of the reservations are on one device. */
export function reservedOn(list: readonly Reservation[], device: DeviceId): number {
  return list.reduce((n, r) => n + (r.device === device ? 1 : 0), 0)
}

/**
 * Whether the memory gate is closed after this status. It closes when the device's free memory
 * drops below `minFreeMemMb` and opens only above `minFreeMemMb × 1.15`. Measured memory
 * alone, reservations not counted: they are an estimate that lets go within 180 s, and a gate
 * closed by an estimate would stay closed for a device that never ran short.
 */
export function gateNext(
  settings: Pick<DeviceSettings, 'minFreeMemMb'>,
  status: DeviceStatus | null,
  closed: boolean,
): boolean {
  const min = settings.minFreeMemMb
  if (min === null || !status) return min === null ? false : closed
  return !memoryPasses(status.memAvailableMb, min, closed)
}

/**
 * The devices whose status the placer should ask again (with its 1.5 s limit) before calling
 * place(): this task's candidates that are online and whose status is older than 45 s or missing.
 * A separate question rather than a verdict of place(): place() stays one synchronous decision
 * over what is known, and treats a status still stale when it is called as offline for that
 * decision, which is what 8.2 asks of a device that did not answer. This computer is not listed:
 * the placer reads its own status, it does not ask for it.
 */
export function needsFresh(task: Task, view: PlacementView, now: number): DeviceId[] {
  const route = routeOf(task, view)
  if (!('list' in route)) return []
  return route.list.filter(id => {
    if (id === LOCAL) return false
    const d = view.devices[id]
    const s = settingsOf(view.config, id)
    if (!s || s.paused || s.drain || !d?.online || d.revoked) return false
    return !d.status || now - d.status.at > STATUS_MAX_AGE_MS
  })
}

/**
 * The decision of 8.1: candidates, home, fit, room in order, and what to do when nobody has room.
 * Fills in order, never spreads: the first device with room wins.
 */
export function place(task: Task, view: PlacementView, now: number): Verdict {
  const route = routeOf(task, view)
  if ('refuse' in route) return route
  const { list, home } = route
  const fits: DeviceId[] = []
  const unfit: Unfit[] = []
  for (const id of list) {
    const why = unfitWhy(id, task, view)
    if (why) unfit.push(why)
    else fits.push(id)
  }
  if (!fits.length) return { refuse: { kind: 'unfit', devices: unfit } }
  const blockers: Blocker[] = []
  for (const id of fits) {
    const blocker = roomBlocker(id, view, now)
    if (!blocker) return home ? { on: id, why: 'home', home } : { on: id, why: 'room' }
    blockers.push(blocker)
  }
  if (task.byHand && view.config.whenFull === 'local' && fits.includes(LOCAL))
    return home ? { on: LOCAL, why: 'full', home } : { on: LOCAL, why: 'full' }
  return { wait: blockers[0] as Blocker }
}

/**
 * Steps 1 and 2: the devices the task may go to, in order, and why it stays home when it must.
 * A task that must stay at its origin keeps the owner's pin when the pin allows the origin (the
 * origin itself, or a tag it has); a pin that points elsewhere is refused rather than ignored.
 */
function routeOf(
  task: Task,
  view: PlacementView,
): { list: DeviceId[]; home: PortableWhy | null } | { refuse: Refusal } {
  const pinned = candidates(task, view)
  if (!pinned.length) return { refuse: task.pin ? { kind: 'no-device', pin: task.pin } : { kind: 'no-device' } }
  const home = homeWhy(task, view.config)
  if (!home) return { list: pinned, home: null }
  if (task.pin && !pinned.includes(task.origin))
    return { refuse: { kind: 'pinned-away', pin: task.pin, origin: task.origin, home } }
  return { list: [task.origin], home }
}

/** The order with what 7.1 says of it: devices it does not name after it, `local` last when missing. */
function order(config: PlacementConfig): DeviceId[] {
  const ids = [...config.order]
  for (const s of settingsList(config)) if (!ids.includes(s.id)) ids.push(s.id)
  if (!ids.includes(LOCAL)) ids.push(LOCAL)
  return ids
}

function settingsList(config: PlacementConfig): readonly DeviceSettings[] {
  return Array.isArray(config.devices)
    ? (config.devices as readonly DeviceSettings[])
    : Object.values(config.devices as Readonly<Record<DeviceId, DeviceSettings>>)
}

function settingsOf(config: PlacementConfig, id: DeviceId): DeviceSettings | undefined {
  return settingsList(config).find(s => s.id === id)
}

/** Step 1: the pin's devices, or the whole order. */
function candidates(task: Task, view: PlacementView): DeviceId[] {
  const all = order(view.config)
  const pin = task.pin
  if (!pin) return all
  if ('device' in pin) return all.filter(id => id === pin.device)
  return all.filter(id => (settingsOf(view.config, id)?.tags ?? []).includes(pin.tag))
}

/** Step 2: why the task may run only where its folder is, or null when it may go anywhere. */
function homeWhy(task: Task, config: PlacementConfig): PortableWhy | null {
  if (!laneLeaves(task.lane, config.lanes)) return { kind: 'lane' }
  return task.portable.ok ? null : task.portable.why
}

/** Step 3, nothing to do with load: why the device can never take this task as it is, or null. */
function unfitWhy(device: DeviceId, task: Task, view: PlacementView): Unfit | null {
  const settings = settingsOf(view.config, device)
  const state = view.devices[device]
  if (!settings && device !== LOCAL) return { device, kind: 'not-set-up' }
  if (state?.revoked) return { device, kind: 'revoked' }
  if (settings?.paused) return { device, kind: 'paused' }
  if (settings?.drain) return { device, kind: 'draining' }
  const tags = settings?.tags ?? []
  const missing = (task.needs ?? []).filter(t => !tags.includes(t))
  if (missing.length) return { device, kind: 'tags', missing }
  const status = state?.status
  // Never heard from: nothing it reports says it cannot take the task; it has no room until it answers.
  if (!status) return null
  if (device !== LOCAL) {
    if (status.api !== view.master.api) return { device, kind: 'api', theirs: status.api, ours: view.master.api }
    if (status.commit !== view.master.commit)
      return {
        device,
        kind: 'commit',
        theirs: status.commit,
        ours: view.master.commit,
        ...(state?.updating && { updating: true as const }),
      }
  }
  // The profile map is the master's to a node's: this computer's profiles are its own ids.
  const profile = (device !== LOCAL && settings?.profiles?.[task.profile]) || task.profile
  const there = status.profiles.find(p => p.id === profile)
  if (!there) return { device, kind: 'no-profile', profile }
  // null is a device that cannot tell (an agent with no login of its own to read): not a refusal.
  if (there.loggedIn === false) return { device, kind: 'not-logged-in', profile }
  if (!status.agents.includes(task.agent)) return { device, kind: 'no-agent', agent: task.agent }
  return null
}

/** Step 4, the room test of 8.2: what keeps a device from taking one more start now, or null. */
export function roomBlocker(device: DeviceId, view: PlacementView, now: number): Blocker | null {
  const state = view.devices[device]
  const status = state?.status
  if (!status) return { device, kind: 'no-status' }
  if (device !== LOCAL && (!state.online || now - status.at > STATUS_MAX_AGE_MS)) return { device, kind: 'offline' }
  const s = settingsOf(view.config, device)
  const reserved = Math.max(0, state.reserved)
  const busy = status.sessions.awake + reserved
  if (s?.maxSessions != null && busy >= s.maxSessions) return { device, kind: 'sessions', busy, max: s.maxSessions }
  if (s?.minFreeMemMb != null) {
    const free = status.memAvailableMb - reserved * RESERVED_MB
    if (!memoryPasses(free, s.minFreeMemMb, state.gateClosed)) {
      const needMb = state.gateClosed ? Math.round(s.minFreeMemMb * GATE_RETURN) : s.minFreeMemMb
      return { device, kind: 'memory', freeMb: free, needMb }
    }
  }
  if (s?.maxLoad != null && status.load && status.cpus > 0) {
    const perCore = status.load[1] / status.cpus
    if (perCore > s.maxLoad) return { device, kind: 'load', perCore, max: s.maxLoad }
  }
  return null
}
