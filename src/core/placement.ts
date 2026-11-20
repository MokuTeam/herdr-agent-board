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

export type Verdict =
  | { on: DeviceId; why: 'room' | 'home' | 'full'; home?: PortableWhy } // start here; home: why it stays there
  | { wait: string } // queue it; the line goes on the launch's card
  | { refuse: string } // no device could ever take it

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
  const list = homeWhy(task, view.config) ? [task.origin] : candidates(task, view)
  return list.filter(id => {
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
  const pinned = candidates(task, view)
  if (!pinned.length) return { refuse: task.pin ? `no device for ${pinText(task.pin)}` : 'no device in the order' }
  const home = homeWhy(task, view.config)
  const list = home ? [task.origin] : pinned
  const fits: DeviceId[] = []
  const unfit: string[] = []
  for (const id of list) {
    const why = unfitWhy(id, task, view)
    if (why) unfit.push(`${id}: ${why}`)
    else fits.push(id)
  }
  if (!fits.length) return { refuse: unfit.join('; ') }
  const blockers: string[] = []
  for (const id of fits) {
    const blocker = roomBlocker(id, view, now)
    if (!blocker) return home ? { on: id, why: 'home', home } : { on: id, why: 'room' }
    blockers.push(`${id}: ${blocker}`)
  }
  if (task.byHand && view.config.whenFull === 'local' && fits.includes(LOCAL))
    return home ? { on: LOCAL, why: 'full', home } : { on: LOCAL, why: 'full' }
  return { wait: blockers[0] ?? '' }
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

const pinText = (pin: NonNullable<Task['pin']>): string => ('device' in pin ? pin.device : `tag ${pin.tag}`)

/** Step 2: why the task may run only where its folder is, or null when it may go anywhere. */
function homeWhy(task: Task, config: PlacementConfig): PortableWhy | null {
  if (!laneLeaves(task.lane, config.lanes)) return { kind: 'lane' }
  return task.portable.ok ? null : task.portable.why
}

/** Step 3, nothing to do with load: why the device can never take this task as it is, or null. */
function unfitWhy(id: DeviceId, task: Task, view: PlacementView): string | null {
  const settings = settingsOf(view.config, id)
  const state = view.devices[id]
  if (!settings && id !== LOCAL) return 'not set up'
  if (state?.revoked) return 'revoked'
  if (settings?.paused) return 'paused'
  if (settings?.drain) return 'draining'
  const tags = settings?.tags ?? []
  const missing = (task.needs ?? []).filter(t => !tags.includes(t))
  if (missing.length) return `no tag ${missing.join(', ')}`
  const status = state?.status
  // Never heard from: nothing it reports says it cannot take the task; it has no room until it answers.
  if (!status) return null
  if (id !== LOCAL) {
    if (status.api !== view.master.api) return `link version ${status.api}, this board ${view.master.api}`
    if (status.commit !== view.master.commit) return `version ${status.commit}, this board ${view.master.commit}`
  }
  // The profile map is the master's to a node's: this computer's profiles are its own ids.
  const profile = (id !== LOCAL && settings?.profiles?.[task.profile]) || task.profile
  const there = status.profiles.find(p => p.id === profile)
  if (!there) return `no profile ${profile}`
  // null is a device that cannot tell (an agent with no login of its own to read): not a refusal.
  if (there.loggedIn === false) return `profile ${profile} is not logged in`
  if (!status.agents.includes(task.agent)) return `no ${task.agent}`
  return null
}

/** Step 4, the room test of 8.2: what keeps a device from taking one more start now, or null. */
export function roomBlocker(id: DeviceId, view: PlacementView, now: number): string | null {
  const state = view.devices[id]
  const status = state?.status
  if (!status) return 'no status yet'
  if (id !== LOCAL && (!state.online || now - status.at > STATUS_MAX_AGE_MS)) return 'offline'
  const s = settingsOf(view.config, id)
  const reserved = Math.max(0, state.reserved)
  const busy = status.sessions.awake + reserved
  if (s?.maxSessions != null && busy >= s.maxSessions) return `${busy} of ${s.maxSessions} sessions`
  if (s?.minFreeMemMb != null) {
    const free = status.memAvailableMb - reserved * RESERVED_MB
    if (!memoryPasses(free, s.minFreeMemMb, state.gateClosed)) {
      const need = state.gateClosed ? s.minFreeMemMb * GATE_RETURN : s.minFreeMemMb
      return `${Math.round(free)} MB free, needs ${Math.round(need)}`
    }
  }
  if (s?.maxLoad != null && status.load && status.cpus > 0) {
    const perCore = status.load[1] / status.cpus
    if (perCore > s.maxLoad) return `load ${perCore.toFixed(2)} per core, limit ${s.maxLoad}`
  }
  return null
}
