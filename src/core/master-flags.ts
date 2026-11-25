// Feature flags from the master (#775, epic #763 T2). A master hands its node the features it owns as
// they are on at the master; the node reads them beside its config.json, never in it, because the
// handover took those sections out of the node's config.json (core/master-handover.ts
// OLD_MASTER_STRIP_KEYS) and every gate there would read them "off".
//
// What the node does with them:
// - Card-level features (watches, tasks, decisions) run on the node for its own sessions; a gate of
//   the node reads them as on via the master (withMasterFlags), its server and its `board` command.
// - The master-run ones (threads, calendar, time, journal, presence, team, ...) are never started on
//   the node: its requests go to the master (core/master-relay.ts, the uplink), and the node only
//   tells its sessions about them (the briefs) and shows Settings as the master's.
// A board without `node` never reads them.
//
// Master offline: the flags stay as they last came, with the time they came (`at`); nothing turns
// off because the link went.
//
// No I/O: the node keeps them in adapters/master-flags-store.ts, the master makes them in
// services/nodes/master-flags.ts.

/** The features a master owns, as the handover takes them off a node. */
export const MASTER_FLAG_KEYS = [
  'threads',
  'time',
  'calendar',
  'decisions',
  'journal',
  'presence',
  'team',
  'watches',
  'todos',
  'workdesk',
  'remote',
  'tunnel',
] as const
export type MasterFlagKey = (typeof MASTER_FLAG_KEYS)[number]

/** The features a node's own gates read as on via the master: they run there, for its own sessions. */
export const NODE_GATED_KEYS = ['watches', 'todos', 'decisions'] as const

/** What a master sends: which of its features are on, and the few fields the node's gates and briefs read. */
export interface MasterFlagsWire {
  /** The master's device id, as Settings on the node names it. */
  master: string
  /** The master-owned features that are on at the master. */
  on: MasterFlagKey[]
  /** Threads: whether agents use them, and case files. */
  threads?: { agents: boolean; cases?: true }
  /** Tasks: whether agents keep them, and close them. */
  todos?: { agents: boolean; autoClose?: true }
  /** Decisions: whether a default may answer. */
  decisions?: { defaults: boolean }
}

/** As the node keeps them: the wire, and when they came (ms). */
export interface MasterFlags extends MasterFlagsWire {
  at: number
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const DEVICE = /^[A-Za-z0-9._-]{1,64}$/

/** The flags as a master sent them, or null: only known keys, each field of its kind. */
export function masterFlagsWireOf(raw: unknown): MasterFlagsWire | null {
  if (!isObject(raw)) return null
  const { master, on, threads, todos, decisions } = raw
  if (typeof master !== 'string' || !DEVICE.test(master) || !Array.isArray(on)) return null
  const keys = MASTER_FLAG_KEYS.filter(k => on.includes(k))
  const out: MasterFlagsWire = { master, on: keys }
  if (keys.includes('threads') && isObject(threads) && typeof threads.agents === 'boolean')
    out.threads = { agents: threads.agents, ...(threads.cases === true && { cases: true as const }) }
  if (keys.includes('todos') && isObject(todos) && typeof todos.agents === 'boolean')
    out.todos = { agents: todos.agents, ...(todos.agents && todos.autoClose === true && { autoClose: true as const }) }
  if (keys.includes('decisions') && isObject(decisions) && typeof decisions.defaults === 'boolean')
    out.decisions = { defaults: decisions.defaults }
  return out
}

/** The flags as the node keeps them, or null. */
export function masterFlagsOf(raw: unknown): MasterFlags | null {
  if (!isObject(raw) || typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at < 0) return null
  const wire = masterFlagsWireOf(raw)
  return wire && { ...wire, at: raw.at }
}

/** Whether two sets of flags say the same, whenever they came. */
export const sameFlags = (a: MasterFlagsWire | null, b: MasterFlagsWire | null): boolean =>
  JSON.stringify(a && masterFlagsWireOf(a)) === JSON.stringify(b && masterFlagsWireOf(b))

/**
 * On at the master, as the node's config.json would say it: the value its readers take, always a new
 * object, so the node's board tells what it put in its live config from what config.json has.
 */
function sectionOf(flags: MasterFlagsWire, key: (typeof NODE_GATED_KEYS)[number]): object | undefined {
  if (!flags.on.includes(key)) return undefined
  if (key === 'watches') return {}
  if (key === 'todos') {
    const t = flags.todos
    if (!t || (t.agents && !t.autoClose)) return {}
    return t.agents ? { autoClose: true } : { agents: false }
  }
  return flags.decisions?.defaults === false ? { defaults: false } : {}
}

/** A section the node's own config.json turns on: kept, the master's never goes over it. */
const ownOn = (raw: unknown): boolean => raw === true || (isObject(raw) && raw.on !== false)

/**
 * The node's config with the card-level features (NODE_GATED_KEYS) the master has on and the node's
 * own config.json does not, as the readers take them; the config itself when there is nothing to
 * add. For gates only: what comes back is never written to config.json.
 */
export function withMasterFlags<T extends object>(cfg: T, flags: MasterFlagsWire | null): T {
  if (!flags) return cfg
  const own = cfg as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const key of NODE_GATED_KEYS) {
    if (ownOn(own[key])) continue
    const value = sectionOf(flags, key)
    if (value === undefined) continue
    out ??= { ...own }
    out[key] = value
  }
  return (out ?? cfg) as T
}

/** What a node's briefs say of the master-run features: threads as their reader takes them, calendar, presence. */
export function briefFlags(flags: MasterFlagsWire | null): { threads: unknown; calendar: boolean; presence: boolean } {
  if (!flags) return { threads: undefined, calendar: false, presence: false }
  const t = flags.threads
  return {
    threads: flags.on.includes('threads')
      ? t
        ? { agents: t.agents, ...(t.cases && { cases: true }) }
        : true
      : undefined,
    calendar: flags.on.includes('calendar'),
    presence: flags.on.includes('presence'),
  }
}
