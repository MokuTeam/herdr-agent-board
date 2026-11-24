// Nodes (#496), their pure rules: config.json's `nodes` (this board is a master) and `node` (this
// board is a node), device ids, the `@<device>:` key prefix that keeps the keys of different
// machines apart, and the thresholds a device starts with. No I/O: the link, the door and the
// placer read these.
//
// Roles are keys. A board without either key sees nothing of this anywhere; one board may hold both:
//   "nodes": { "id": "laptop", "order": ["server-1", "local"], "devices": { "server-1": { ... } } }
//   "node": { "id": "server-1", "port": 12430, "workRoot": "~/work" }
import { type BoardAgyLimits, boardAgyLimitsOf } from './agy-limits.ts'
import { type GitFacts, gitFactsOf } from './git-access.ts'
import { DEVICE_ID, isDevice, LOCAL, parseNodeKey } from './node-key.ts'
import { hasUnprintable } from './team.ts'

// The device id and the prefixed keys live in a leaf module the page can import (core/node-key.ts).
export { DEVICE_ID, LOCAL, parseNodeKey }

/** The node's door, on 127.0.0.1, when `node.port` and a link's `port` do not say. */
export const NODE_PORT = 12430

export type LinkConfig =
  | { kind: 'ssh'; host: string; sshPort: number; user: string; port: number }
  | { kind: 'relay'; socket: string }
  | { kind: 'tailnet'; address: string; port: number }
  | { kind: 'direct'; url: string }

export interface DeviceConfig {
  id: string
  title: string
  /** null: this computer (`local`). */
  link: LinkConfig | null
  /** null until the board writes them from the device's first status. */
  maxSessions: number | null
  minFreeMemMb: number | null
  maxLoad: number | null
  tags: string[]
  /** The master's profile id to the node's; a profile not named keeps its id. No prototype: look ids up as they come. */
  profiles: Record<string, string>
  paused: boolean
  drain: boolean
  /**
   * Revoked by the owner (#510, design 11.4): no placement from the moment it is written, and the
   * link stays only for the one call that tells the node.
   */
  revoked?: true
  /** The node's `secrets.sinks`, sent with the bundle and read there by secretsConfig. */
  sinks: unknown
  /** Per MCP server: false, or { command, args, env }. No prototype. */
  mcp: Record<string, unknown>
  /** Differences the owner has seen and accepts. */
  accept: string[]
  /**
   * Whether a sync also gives the node the secrets its profile needs (#604): the values the bundle
   * replaced by references and the secret files a hook's script reads. `giveSecrets: false` turns
   * it off; absent, it is on: a node is a machine of the owner's (design 10, Trust). Only here when off.
   */
  giveSecrets?: false
}

/**
 * What does not check out. Never a value: config.json may hold what the owner typed by mistake.
 * `key` is the key as written under the section or the device; `id` for a device's own id.
 */
export interface NodesProblem {
  device?: string
  key: string
  why: string
}

export interface NodesConfig {
  /** This board's own device id, as others and the records name it. */
  id: string
  /** Every usable device once, `local` included: the first is filled first. */
  order: string[]
  whenFull: 'local' | 'wait'
  /** The lanes that may leave this computer, lower-cased; an empty list: none. */
  lanes: 'all' | string[]
  relay: { host: string; sshPort: number; user: string } | null
  /**
   * The usable devices, `local` always among them. A device with a problem is not here. No
   * prototype, so a device id taken from a key (`constructor`) finds nothing it was not given.
   */
  devices: Record<string, DeviceConfig>
  problems: NodesProblem[]
}

export interface NodeConfig {
  id: string
  port: number
  workRoot: string
  listen: 'loopback' | 'tailnet'
  tls: boolean
  relay: { host: string; sshPort: number; user: string; socket: string } | null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536
/**
 * A host, a user, an address or a socket name: no spaces, nothing unprintable, and no leading "-"
 * that ssh would read as an option.
 */
const isWord = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 255 && !v.startsWith('-') && !/\s/.test(v) && !hasUnprintable(v)
/** A title or a folder: trimmed, not empty, at most `max` long, nothing unprintable. */
const isText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= max && !hasUnprintable(v)
/** null where config.json has a key, read as the key not being there. */
const given = (v: unknown): boolean => v !== undefined && v !== null
/** A map built from what the owner typed: no prototype, so `__proto__` is a key like any other. */
const bare = <T>(): Record<string, T> => Object.create(null) as Record<string, T>
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

const TOP_KEYS = ['id', 'order', 'whenFull', 'lanes', 'relay', 'devices']
const DEVICE_KEYS = [
  'title',
  'link',
  'maxSessions',
  'minFreeMemMb',
  'maxLoad',
  'tags',
  'profiles',
  'paused',
  'drain',
  'revoked',
  'sinks',
  'mcp',
  'accept',
  'giveSecrets',
]
const LINK_KEYS: Record<LinkConfig['kind'], string[]> = {
  ssh: ['kind', 'host', 'sshPort', 'user', 'port'],
  relay: ['kind', 'socket'],
  tailnet: ['kind', 'address', 'port'],
  direct: ['kind', 'url'],
}
const RELAY_KEYS = ['host', 'sshPort', 'user']
const NODE_KEYS = ['id', 'port', 'workRoot', 'listen', 'tls', 'relay']

type Flag = (key: string, why: string) => void

function unknownKeys(o: Record<string, unknown>, known: readonly string[], at: string, flag: Flag): void {
  for (const k of Object.keys(o)) if (!known.includes(k)) flag(at ? `${at}.${k}` : k, 'unknown')
}

/**
 * A host name made into a device id: lower case, anything outside the rule to "-", the dashes
 * at either end trimmed, cut to 32. Nothing left, or `local`: "board".
 */
export function deviceIdFromHost(host: string): string {
  const id = host
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return id && id !== LOCAL ? id : 'board'
}

/**
 * The thresholds a device is given from its first status (design 7.1); the owner may change them.
 * The status is the node's word: a figure that is not a number counts as the least there is.
 */
export function defaultThresholds(hw: { memTotalMb: number; cpus: number }): {
  maxSessions: number
  minFreeMemMb: number
  maxLoad: number
} {
  const mem = Number.isFinite(hw.memTotalMb) ? hw.memTotalMb : 0
  const cpus = Number.isFinite(hw.cpus) ? Math.max(1, Math.floor(hw.cpus)) : 1
  const bySize = Math.floor((mem - 1500) / 1500)
  return {
    maxSessions: Math.min(Math.max(bySize, 1), 4 * cpus),
    minFreeMemMb: Math.max(1024, Math.round(0.15 * mem)),
    maxLoad: 0.9,
  }
}

/**
 * The thresholds config.json does not set for a device, written into its `nodes` section (the raw
 * object, changed in place) from `given` (defaultThresholds of its first status): only keys that are
 * absent, so a value the owner typed, `null` (no limit) included, stays. `local` gets an entry when
 * it has none; another device only when it is there. Whether anything changed.
 */
export function fillThresholds(
  nodes: Record<string, unknown>,
  device: string,
  given: { maxSessions: number; minFreeMemMb: number; maxLoad: number },
): boolean {
  if (!isObject(nodes.devices)) {
    if (nodes.devices !== undefined || device !== LOCAL) return false
    nodes.devices = {}
  }
  const devices = nodes.devices as Record<string, unknown>
  if (!Object.hasOwn(devices, device)) {
    if (device !== LOCAL) return false
    devices[device] = {}
  }
  const entry = devices[device]
  if (!isObject(entry)) return false
  let changed = false
  for (const key of ['maxSessions', 'minFreeMemMb', 'maxLoad'] as const)
    if (!Object.hasOwn(entry, key)) {
      entry[key] = given[key]
      changed = true
    }
  return changed
}

/**
 * A `direct` link's URL: http(s), no login in it. Plain http only to this computer, as `direct`
 * is for tests and for a loopback forward the owner keeps up himself.
 */
function directUrl(v: unknown): boolean {
  if (!isWord(v)) return false
  try {
    const u = new URL(v)
    if (u.username || u.password) return false
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))
  } catch {
    return false
  }
}

/** A link as config.json has it, or null with what does not check out flagged. */
function linkOf(raw: unknown, relay: boolean, flag: Flag): LinkConfig | null {
  if (!isObject(raw)) {
    flag('link', raw === undefined ? 'required' : 'type')
    return null
  }
  const kind = raw.kind as LinkConfig['kind']
  if (typeof kind !== 'string' || !Object.hasOwn(LINK_KEYS, kind)) {
    flag('link.kind', raw.kind === undefined ? 'required' : 'kind')
    return null
  }
  let ok = true
  const bad: Flag = (key, why) => {
    ok = false
    flag(key, why)
  }
  unknownKeys(raw, LINK_KEYS[kind], 'link', bad)
  const port = (key: string, dflt: number): number => {
    if (raw[key] === undefined) return dflt
    if (!isPort(raw[key])) bad(`link.${key}`, 'port')
    return raw[key] as number
  }
  const word = (key: string): string => {
    if (!isWord(raw[key])) bad(`link.${key}`, raw[key] === undefined ? 'required' : 'type')
    return raw[key] as string
  }
  let link: LinkConfig
  if (kind === 'ssh') {
    link = { kind, host: word('host'), sshPort: port('sshPort', 22), user: word('user'), port: port('port', NODE_PORT) }
  } else if (kind === 'relay') {
    link = { kind, socket: word('socket') }
    if (!relay) bad('link.kind', 'relay')
  } else if (kind === 'tailnet') {
    link = { kind, address: word('address'), port: port('port', NODE_PORT) }
  } else {
    if (!directUrl(raw.url)) bad('link.url', raw.url === undefined ? 'required' : 'url')
    link = { kind, url: raw.url as string }
  }
  return ok ? link : null
}

/**
 * One device as config.json has it, or null with its problems added. A device whose id is this
 * board's own `nodes.id` is refused too: the records name devices by id, and two with one id
 * could not be told apart there.
 */
function deviceOf(
  id: string,
  raw: unknown,
  relay: boolean,
  selfId: string,
  problems: NodesProblem[],
): DeviceConfig | null {
  let ok = true
  const flag: Flag = (key, why) => {
    ok = false
    problems.push({ device: id, key, why })
  }
  if (!DEVICE_ID.test(id)) flag('id', 'id')
  else if (id === selfId) flag('id', 'self')
  if (!isObject(raw)) {
    flag('id', 'type')
    return null
  }
  const o = raw
  unknownKeys(o, DEVICE_KEYS, '', flag)
  let link: LinkConfig | null = null
  if (id === LOCAL) {
    if (o.link !== undefined) flag('link', 'local')
  } else link = linkOf(o.link, relay, flag)
  const num = (key: string, fits: (n: number) => boolean): number | null => {
    const v = o[key]
    if (!given(v)) return null
    if (typeof v !== 'number' || !Number.isFinite(v) || !fits(v)) flag(key, 'number')
    return v as number
  }
  const words = (key: string): string[] => {
    const v = o[key]
    if (v === undefined) return []
    if (!Array.isArray(v) || !v.every(isWord)) {
      flag(key, 'type')
      return []
    }
    return [...new Set(v as string[])]
  }
  const yes = (key: string): boolean => {
    const v = o[key]
    if (v === undefined) return false
    if (typeof v !== 'boolean') flag(key, 'type')
    return v === true
  }
  const title = o.title === undefined ? id : typeof o.title === 'string' ? o.title.trim() : ''
  if (!isText(title, 200)) flag('title', 'type')
  const profiles = bare<string>()
  if (o.profiles !== undefined) {
    if (!isObject(o.profiles)) flag('profiles', 'type')
    else
      for (const [from, to] of Object.entries(o.profiles))
        if (isWord(from) && isWord(to)) profiles[from] = to
        else flag(`profiles.${from}`, 'type')
  }
  const mcp = bare<unknown>()
  if (o.mcp !== undefined) {
    if (!isObject(o.mcp)) flag('mcp', 'type')
    else
      for (const [name, v] of Object.entries(o.mcp))
        if (v === false || isObject(v)) mcp[name] = v
        else flag(`mcp.${name}`, 'type')
  }
  if (o.sinks !== undefined && !isObject(o.sinks)) flag('sinks', 'type')
  if (o.giveSecrets !== undefined && typeof o.giveSecrets !== 'boolean') flag('giveSecrets', 'type')
  const device: DeviceConfig = {
    id,
    title,
    link,
    maxSessions: num('maxSessions', n => Number.isInteger(n) && n >= 1),
    minFreeMemMb: num('minFreeMemMb', n => Number.isInteger(n) && n >= 0),
    maxLoad: num('maxLoad', n => n > 0),
    tags: words('tags'),
    profiles,
    paused: yes('paused'),
    drain: yes('drain'),
    ...(yes('revoked') && { revoked: true as const }),
    sinks: o.sinks ?? {},
    mcp,
    accept: words('accept'),
    ...(o.giveSecrets === false && { giveSecrets: false as const }),
  }
  return ok ? device : null
}

/** An ssh login on the owner's server: `nodes.relay`, and `node.relay` with `socket` among `keys`. */
function relayOf(
  raw: unknown,
  keys: readonly string[],
  problems: NodesProblem[],
): Record<string, string | number> | null {
  if (!isObject(raw)) {
    problems.push({ key: 'relay', why: 'type' })
    return null
  }
  let ok = true
  const flag: Flag = (key, why) => {
    ok = false
    problems.push({ key, why })
  }
  unknownKeys(raw, keys, 'relay', flag)
  for (const k of keys)
    if (k === 'sshPort') {
      if (raw[k] !== undefined && !isPort(raw[k])) flag('relay.sshPort', 'port')
    } else if (!isWord(raw[k])) flag(`relay.${k}`, raw[k] === undefined ? 'required' : 'type')
  if (!ok) return null
  const out: Record<string, string | number> = { host: raw.host as string, sshPort: (raw.sshPort as number) ?? 22 }
  for (const k of keys) if (k !== 'host' && k !== 'sshPort') out[k] = raw[k] as string
  return out
}

/**
 * config.json's `nodes` as the master uses it, or null while it is not on (no key, `false`,
 * anything but an object). A device with an unknown key or a bad value is left out of `devices`
 * and `order` and named in `problems`, never guessed at; a `local` entry with a problem leaves
 * this computer with no thresholds of its own. A bad value of the section's own keys is named too
 * and gives what that key's absence does: `lanes` none, `whenFull` local, no relay, the id from
 * `hostName` ("board" without one). A key set to null counts as absent.
 */
export function nodesConfig(raw: unknown, hostName = ''): NodesConfig | null {
  if (!isObject(raw)) return null
  const problems: NodesProblem[] = []
  const flag: Flag = (key, why) => problems.push({ key, why })
  unknownKeys(raw, TOP_KEYS, '', flag)

  let id = deviceIdFromHost(hostName)
  if (given(raw.id)) {
    if (isDevice(raw.id)) id = raw.id
    else flag('id', raw.id === LOCAL ? 'reserved' : 'id')
  }

  let whenFull: NodesConfig['whenFull'] = 'local'
  if (raw.whenFull === 'wait') whenFull = 'wait'
  else if (given(raw.whenFull) && raw.whenFull !== 'local') flag('whenFull', 'type')

  let lanes: NodesConfig['lanes'] = []
  if (raw.lanes === 'all') lanes = 'all'
  else if (Array.isArray(raw.lanes) && raw.lanes.every(l => typeof l === 'string' && l.trim()))
    lanes = [...new Set((raw.lanes as string[]).map(l => l.trim().toLowerCase()))]
  else if (given(raw.lanes)) flag('lanes', 'type')

  const relay = given(raw.relay) ? (relayOf(raw.relay, RELAY_KEYS, problems) as NodesConfig['relay']) : null

  const devices = bare<DeviceConfig>()
  const named: string[] = []
  if (given(raw.devices) && !isObject(raw.devices)) flag('devices', 'type')
  else if (isObject(raw.devices))
    for (const [dev, v] of Object.entries(raw.devices)) {
      named.push(dev)
      const d = deviceOf(dev, v, relay !== null, id, problems)
      if (d) devices[dev] = d
    }
  devices[LOCAL] ??= deviceOf(LOCAL, {}, false, id, []) as DeviceConfig

  const order: string[] = []
  const listed = !given(raw.order) ? [] : Array.isArray(raw.order) ? raw.order : null
  if (listed === null) flag('order', 'type')
  for (const dev of listed ?? []) {
    if (typeof dev !== 'string') flag('order', 'type')
    else if (order.includes(dev)) problems.push({ key: 'order', why: 'duplicate', device: dev })
    else if (Object.hasOwn(devices, dev)) order.push(dev)
    // a device left out for a problem of its own is named there already
    else if (!named.includes(dev)) problems.push({ key: 'order', why: 'missing', device: dev })
  }
  for (const dev of Object.keys(devices)) if (dev !== LOCAL && !order.includes(dev)) order.push(dev)
  if (!order.includes(LOCAL)) order.push(LOCAL)

  return { id, order, whenFull, lanes, relay, devices, problems }
}

/** config.json's `node` and what does not check out in it. */
function readNode(raw: unknown): { config: NodeConfig | null; problems: NodesProblem[] } {
  if (!isObject(raw)) return { config: null, problems: [] }
  const problems: NodesProblem[] = []
  const flag: Flag = (key, why) => problems.push({ key, why })
  unknownKeys(raw, NODE_KEYS, '', flag)
  if (!isDevice(raw.id)) flag('id', raw.id === undefined ? 'required' : raw.id === LOCAL ? 'reserved' : 'id')
  if (given(raw.port) && !isPort(raw.port)) flag('port', 'port')
  if (given(raw.workRoot) && !isText(raw.workRoot, 1024)) flag('workRoot', 'type')
  if (given(raw.listen) && raw.listen !== 'loopback' && raw.listen !== 'tailnet') flag('listen', 'type')
  if (given(raw.tls) && typeof raw.tls !== 'boolean') flag('tls', 'type')
  const relay = given(raw.relay)
    ? (relayOf(raw.relay, [...RELAY_KEYS, 'socket'], problems) as NodeConfig['relay'])
    : null
  if (relay && (!given(raw.tls) || raw.tls === false)) flag('tls', 'required')
  if (problems.length) return { config: null, problems }
  return {
    config: {
      id: raw.id as string,
      port: (raw.port as number | null | undefined) ?? NODE_PORT,
      workRoot: (raw.workRoot as string | null | undefined) ?? '~/work',
      listen: (raw.listen as NodeConfig['listen'] | null | undefined) ?? 'loopback',
      tls: raw.tls === true,
      relay,
    },
    problems,
  }
}

/**
 * config.json's `node` as the node uses it, or null: no key, `false`, or a section that does not
 * check out (nodeProblems names why). No config, no door.
 */
export function nodeConfig(raw: unknown): NodeConfig | null {
  return readNode(raw).config
}

/** What does not check out in config.json's `node`, for the doctor; empty with no key. */
export function nodeProblems(raw: unknown): NodesProblem[] {
  return readNode(raw).problems
}

/**
 * A key of another device's item as the master's payload and routes carry it: `@server-1:` + key.
 * Throws on a device that is not one and on an empty key, which no item has: whoever takes keys
 * from a node's payload drops an item without one before it gets here.
 */
export function nodeKey(device: string, key: string): string {
  if (!isDevice(device)) throw new Error(`not a device id: ${JSON.stringify(device)}`)
  if (!key) throw new Error('an empty key')
  return `@${device}:${key}`
}

/** Whether a session of this lane may run on another device: `nodes.lanes` is "all" or names it. */
export function laneMayLeave(cfg: NodesConfig, lane: string): boolean {
  return cfg.lanes === 'all' || cfg.lanes.includes(lane.trim().toLowerCase())
}

/**
 * The figures of a status the page shows, rounded as it shows them: the sessions, memory available
 * to the nearest 100 MB, the 5 minute load to one decimal, each profile's login and bundle, the
 * commit and version, the machine's size, and from a node that says them its git facts and programs
 * (#609, the device's row words them). Two statuses with the same key look the same, so one
 * that comes every 30 s with the same key pushes the board to no page (#500). '' for none.
 */
export function statusShown(s: NodeStatus | null): string {
  if (!s) return ''
  const load = s.load?.[1]
  return JSON.stringify([
    s.sessions.awake,
    s.sessions.working,
    s.sessions.asleep,
    s.memAvailableMb === null ? null : Math.round(s.memAvailableMb / 100),
    load === undefined ? null : Math.round(load * 10),
    s.profiles.map(p => [p.id, p.loggedIn, p.bundle?.seq ?? null]),
    s.commit,
    s.version,
    s.memTotalMb,
    s.cpus,
    // Only from a node that says them: a status without them keys as before.
    ...(s.git ? [s.git.identity, s.git.logins.map(l => [l.host, l.user]), s.programs ?? null] : []),
    // Only from a node with agy installed (#647): a status without it keys as before.
    // Bucket observedAt (5 min) and resetsAt (1 min) to avoid 30 s SSE churn while keeping steady() fresh.
    ...(s.agyLimits !== undefined
      ? [
          s.agyLimits
            ? [
                s.agyLimits.observedAt === null ? null : Math.floor(s.agyLimits.observedAt / 300_000),
                s.agyLimits.stale,
                s.agyLimits.planTier ?? null,
                s.agyLimits.windows.map(w => [
                  w.id,
                  Math.round(w.usedPercentage),
                  w.resetsAt === null ? null : Math.round(w.resetsAt / 60_000),
                ]),
              ]
            : null,
        ]
      : []),
  ])
}

/** `GET /api/node/status` on a node's door (6.3; services/node/status.ts makes it, the master's link reads it). */
export interface NodeStatus {
  api: number
  id: string
  version: string
  commit: string
  platform: string
  arch: string
  cpus: number
  memTotalMb: number
  /** null where the platform's answer could not be read: never read as 0. */
  memAvailableMb: number | null
  load: [number, number, number] | null
  sessions: { awake: number; working: number; asleep: number }
  /** Launches still on their way (starting, waiting, a trust dialog). */
  launches: number
  /** null when the folder, or every folder above it, cannot be read. */
  workRootFreeMb: number | null
  /** loggedIn: null where a folder cannot tell (macOS keeps Claude's login in the Keychain). bundle: the applied one, null before the first. */
  profiles: { id: string; loggedIn: boolean | null; bundle: { seq: number; hash: string } | null }[]
  /** The agents a start may name here, by the board's own rule (core/launch/agents.ts). */
  agents: string[]
  /** Which of core/bundle.ts NODE_PROGRAMS the node has (#603); absent from a node of an older board. */
  programs?: string[]
  /** Its git identity and GitHub logins (#609, core/git-access.ts); absent from a node of an older board. */
  git?: GitFacts
  /** Antigravity (Gemini) usage reading (#647), only when agy is installed on this node; null when unknown. */
  agyLimits?: BoardAgyLimits | null
  at: number
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isCount = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0

/** A profile's bundle version in a status: `{ seq, hash }` checked, anything else null. */
const bundleOf = (v: unknown): { seq: number; hash: string } | null =>
  isObject(v) && isCount(v.seq) && typeof v.hash === 'string' && /^[0-9a-f]{64}$/.test(v.hash)
    ? { seq: v.seq as number, hash: v.hash }
    : null

/** A status's `agyLimits` (#647), checked field by field; omitted when absent or non-object garbage. */
const agyLimitsOf = (v: unknown): { agyLimits?: BoardAgyLimits | null } => {
  if (v === undefined) return {}
  if (v === null) return { agyLimits: null }
  if (!isObject(v)) return {}
  return { agyLimits: boardAgyLimitsOf(v) }
}

/** A status's `git` (#609), checked; nothing for a node of an older board. */
const gitOf = (v: unknown): { git?: GitFacts } => {
  const git = gitFactsOf(v)
  return git ? { git } : {}
}

/**
 * A node's status as its door answered it, or null when it is not one. The node's word, checked
 * field by field before the master keeps it: a null where the type has one stays null.
 */
export function nodeStatusOf(raw: unknown): NodeStatus | null {
  if (!isObject(raw)) return null
  const s = raw
  const sessions = s.sessions
  const ok =
    isCount(s.api) &&
    typeof s.id === 'string' &&
    typeof s.version === 'string' &&
    typeof s.commit === 'string' &&
    typeof s.platform === 'string' &&
    typeof s.arch === 'string' &&
    isCount(s.cpus) &&
    isNumber(s.memTotalMb) &&
    (s.memAvailableMb === null || isNumber(s.memAvailableMb)) &&
    (s.load === null || (Array.isArray(s.load) && s.load.length === 3 && s.load.every(isNumber))) &&
    isObject(sessions) &&
    isCount(sessions.awake) &&
    isCount(sessions.working) &&
    isCount(sessions.asleep) &&
    isCount(s.launches) &&
    (s.workRootFreeMb === null || isNumber(s.workRootFreeMb)) &&
    Array.isArray(s.profiles) &&
    s.profiles.every(
      p => isObject(p) && typeof p.id === 'string' && (p.loggedIn === null || typeof p.loggedIn === 'boolean'),
    ) &&
    Array.isArray(s.agents) &&
    s.agents.every(a => typeof a === 'string') &&
    isNumber(s.at)
  if (!ok) return null
  const counts = sessions as Record<string, number>
  return {
    api: s.api as number,
    id: s.id as string,
    version: s.version as string,
    commit: s.commit as string,
    platform: s.platform as string,
    arch: s.arch as string,
    cpus: s.cpus as number,
    memTotalMb: s.memTotalMb as number,
    memAvailableMb: s.memAvailableMb as number | null,
    load: s.load === null ? null : ([...(s.load as number[])] as [number, number, number]),
    sessions: { awake: counts.awake as number, working: counts.working as number, asleep: counts.asleep as number },
    launches: s.launches as number,
    workRootFreeMb: s.workRootFreeMb as number | null,
    profiles: (s.profiles as Record<string, unknown>[]).map(p => ({
      id: p.id as string,
      loggedIn: p.loggedIn as boolean | null,
      bundle: bundleOf(p.bundle),
    })),
    agents: [...(s.agents as string[])],
    ...(Array.isArray(s.programs) &&
      s.programs.every(p => typeof p === 'string') && { programs: [...(s.programs as string[])] }),
    ...gitOf(s.git),
    ...agyLimitsOf(s.agyLimits),
    at: s.at as number,
  }
}

/**
 * Where the master's link to a device stands (services/nodes/link.ts). Offline is 90 s without a
 * byte on the payload stream (6.5); refused is a cause that does not heal by waiting.
 */
export type LinkState = 'connecting' | 'online' | 'offline' | 'refused'

/**
 * Why a link is refused: `token` (none stored, or the node does not take it), `api` (the door's
 * `node.api` is not this board's), `device` (the door is another device's), `host-key` (the
 * node's ssh host key is not the pinned one), `cert` (the door answered with another TLS
 * certificate, or none is pinned), `ssh` (another lasting ssh error: the key refused, its rights,
 * a passphrase), `key` (no link or relay key yet), `not-built` (a link kind not built yet).
 */
export type LinkReason = 'token' | 'api' | 'device' | 'host-key' | 'cert' | 'ssh' | 'key' | 'not-built'

export interface LinkStatus {
  state: LinkState
  since: number
  /** refused: why. */
  reason?: LinkReason
  /** What was said last: an ssh line, an HTTP status, the ssh hint. Never a token. */
  detail?: string
  /** Waiting to try again: the attempt's number and when it starts. */
  attempt?: number
  nextAt?: number
  /** When the payload stream last carried a byte; null before it ever did. */
  heardAt: number | null
}

/** One device as `GET /api/nodes` and `board nodes` show it. */
export interface DeviceView {
  id: string
  title: string
  /** null: this computer. */
  kind: LinkConfig['kind'] | null
  /** null: this computer, which has no link. */
  link: LinkStatus | null
  /** The node's last status; null before one came. */
  status: NodeStatus | null
  /** Whether the node runs this board's commit (6.5); null while either is not known. */
  sameCommit: boolean | null
  /** When its last payload came; null before one did. */
  payloadAt: number | null
  /** Master schedule entries held while this device is offline (#695); absent when 0. */
  held?: number
  /**
   * Only on a revoked device (#510): whether the node was told (it answered `leave`), and whether
   * its token and link key are still kept for that one call.
   */
  revoked?: { told: boolean; kept: boolean }
  /** Only while this board's commit is on its way to the node, or the last try failed (#590). */
  update?: DeviceUpdate
}

/**
 * This board's commit on its way to a node (#590, design 6.5, services/nodes/update.ts):
 * `updating` while the archive goes and the node prepares the new copy, `restarting` once it
 * answered and until its status names the new commit, `failed` with the node's or this board's
 * reason (`error`, a word the page translates, and `detail` as said) until the next try.
 */
export interface DeviceUpdate {
  state: 'updating' | 'restarting' | 'failed'
  /** The commit sent, or to be sent. */
  commit: string
  error?: string
  detail?: string
  at: number
}

// ---------------------------------------------------------------- the panel's edits (#510)

/** The thresholds, switches and title the Devices panel sets per device (`nodes.devices.<id>`). */
const DEVICE_SETTINGS = ['title', 'paused', 'drain', 'giveSecrets', 'maxSessions', 'minFreeMemMb', 'maxLoad'] as const
type DeviceSetting = (typeof DEVICE_SETTINGS)[number]

/**
 * One change of Settings, Devices (design 12), as `POST /api/nodes` carries it: the order, a
 * device's title, switches and thresholds (a threshold set to null is written as null: no limit, which
 * the board's own figures never replace; an empty or null title clears it back to the default), the
 * lanes that may leave this computer, and what a start does when every device is full.
 */
export type NodesEdit =
  | { op: 'order'; ids: string[] }
  | { op: 'set'; id: string; values: Partial<Record<DeviceSetting, string | boolean | number | null>> }
  | { op: 'lanes'; lanes: 'all' | string[]; shown?: string[] }
  | { op: 'whenFull'; whenFull: 'local' | 'wait' }

const EDIT_OPS = ['order', 'set', 'lanes', 'whenFull']

/** What `GET /api/nodes` adds for the panel beside the devices (#510). */
export interface NodesPanelSettings {
  whenFull: NodesConfig['whenFull']
  lanes: NodesConfig['lanes']
  /** The board's lanes when the lanes were last saved; null: never. A lane not among them is new. */
  seen: string[] | null
  /** Per device with a status: the thresholds the board would give it (defaultThresholds), the fields' placeholders. */
  defaults: Record<string, ReturnType<typeof defaultThresholds>>
  /** The device the next plain start would go to (the placer's `next`); null while it would wait. */
  next: string | null
  /** The devices with no token stored yet: a refusal for `token` there means none was given. */
  noToken: string[]
  /** Per device linked by ssh: its server, for the command that logs Claude in there (#509). */
  hosts?: Record<string, { host: string; sshPort: number }>
  /** Per device with any, the secrets its last syncs gave and those still to be given by hand (#604): names only. */
  secrets?: Record<string, { given: string[]; toGive: string[] }>
}

/**
 * A body of `POST /api/nodes` read as a panel edit: the edit, `{ error }` naming the field that
 * is not one, or null for a body of another op (retry, sync), which the route reads as before.
 * Only the shape here; applyNodesEdit holds each value to the rules nodesConfig reads with.
 */
export function nodesEditOf(body: Record<string, unknown>): NodesEdit | { error: string } | null {
  if (typeof body.op !== 'string' || !EDIT_OPS.includes(body.op)) return null
  if (body.op === 'order') {
    const ids = body.ids
    return Array.isArray(ids) && ids.every(i => typeof i === 'string') ? { op: 'order', ids } : { error: 'ids' }
  }
  if (body.op === 'lanes') {
    // `shown`: the lanes the panel listed, kept so that one added later shows as new.
    const words = (v: unknown): v is string[] => Array.isArray(v) && v.every(l => typeof l === 'string')
    if (
      body.shown !== undefined &&
      (!words(body.shown) || body.shown.length > 500 || body.shown.some(l => l.length > 200))
    )
      return { error: 'shown' }
    const shown = body.shown === undefined ? {} : { shown: body.shown as string[] }
    const lanes = body.lanes
    if (lanes === 'all') return { op: 'lanes', lanes, ...shown }
    return words(lanes) ? { op: 'lanes', lanes, ...shown } : { error: 'lanes' }
  }
  if (body.op === 'whenFull')
    return body.whenFull === 'local' || body.whenFull === 'wait'
      ? { op: 'whenFull', whenFull: body.whenFull }
      : { error: 'whenFull' }
  if (typeof body.id !== 'string' || !DEVICE_ID.test(body.id)) return { error: 'id' }
  const values: Partial<Record<DeviceSetting, string | boolean | number | null>> = {}
  for (const key of DEVICE_SETTINGS) {
    if (!Object.hasOwn(body, key)) continue
    const v = body[key]
    const fits =
      key === 'title'
        ? v === null || typeof v === 'string'
        : key === 'paused' || key === 'drain' || key === 'giveSecrets'
          ? typeof v === 'boolean'
          : v === null || typeof v === 'number'
    if (!fits) return { error: key }
    values[key] = v as string | boolean | number | null
  }
  if (Object.keys(values).length === 0) return { error: 'values' }
  // This computer is never paused: a start by hand runs here when every device is full (8.1 step 5).
  if (body.id === LOCAL && 'paused' in values) return { error: 'paused' }
  // Nor given secrets: they are this computer's own.
  if (body.id === LOCAL && 'giveSecrets' in values) return { error: 'giveSecrets' }
  return { op: 'set', id: body.id, values }
}

const problemKey = (p: NodesProblem): string => `${p.device ?? ''}\u0000${p.key}\u0000${p.why}`

/** The field a new problem of an edit is answered with: the key, without the link's or a profile's part. */
const fieldOf = (p: NodesProblem): string => p.key.split('.')[0] as string

/**
 * A panel edit applied to config.json's `nodes` section (the raw object, changed in place), held to
 * the rules nodesConfig reads with: the edit is made on a copy, and a problem the copy has that the
 * section had not refuses it with the field, the section left as it was. A device the section does
 * not hold is refused, except this computer, which gets an entry. `changed`: whether anything moved.
 */
export function applyNodesEdit(
  nodes: Record<string, unknown>,
  edit: NodesEdit,
  hostName = '',
): { changed: boolean } | { error: string } {
  const next = structuredClone(nodes)
  if (edit.op === 'order') next.order = [...edit.ids]
  else if (edit.op === 'whenFull') next.whenFull = edit.whenFull
  else if (edit.op === 'lanes')
    next.lanes = edit.lanes === 'all' ? 'all' : [...new Set(edit.lanes.map(l => l.trim().toLowerCase()))]
  else {
    const hadDevices = next.devices !== undefined
    if (next.devices === undefined && edit.id === LOCAL) next.devices = {}
    if (!isObject(next.devices)) return { error: 'id' }
    const devices = next.devices
    if (!Object.hasOwn(devices, edit.id)) {
      if (edit.id !== LOCAL) return { error: 'id' }
      devices[edit.id] = {}
    }
    const entry = devices[edit.id]
    if (!isObject(entry)) return { error: 'id' }
    // Secrets on is the default: written as the key gone, as an owner who never touched it has it.
    // An empty title or the device's own id goes back to the default too.
    for (const [key, v] of Object.entries(edit.values))
      if (key === 'title') {
        const trimmed = v === null ? '' : (v as string).trim()
        if (trimmed === '' || trimmed === edit.id) delete entry.title
        else entry.title = trimmed
      } else if (key === 'giveSecrets' && v === true) delete entry[key]
      else entry[key] = v
    if (edit.id === LOCAL && Object.keys(entry).length === 0) {
      delete devices[LOCAL]
      if (!hadDevices && Object.keys(devices).length === 0) delete next.devices
    }
  }
  const was = nodesConfig(nodes, hostName)
  // The panel lists the usable devices (nodesConfig's order) and sends each of them once: anything
  // else is a list gone stale. A device left out for a problem of its own keeps a place after them.
  if (edit.op === 'order') {
    const usable = was?.order ?? [LOCAL]
    const ids = edit.ids
    if (new Set(ids).size !== ids.length || ids.length !== usable.length || !ids.every(id => usable.includes(id)))
      return { error: 'ids' }
    const raw = isObject(next.devices) ? Object.keys(next.devices) : []
    next.order = [...ids, ...raw.filter(id => !ids.includes(id))]
  }
  const before = new Set((was?.problems ?? []).map(problemKey))
  const after = nodesConfig(next, hostName)?.problems ?? []
  // A problem the edit brings, or one on the very field it sets (a bad value over a bad value).
  const edited = (p: NodesProblem): boolean =>
    edit.op === 'set' ? p.device === edit.id && fieldOf(p) in edit.values : !p.device && p.key === edit.op
  const fresh = after.find(p => !before.has(problemKey(p)) || edited(p))
  if (fresh) return { error: edit.op === 'set' ? fieldOf(fresh) : edit.op === 'order' ? 'ids' : edit.op }
  const changed = JSON.stringify(next) !== JSON.stringify(nodes)
  if (changed) {
    for (const key of Object.keys(nodes)) delete nodes[key]
    Object.assign(nodes, next)
  }
  return { changed }
}

/**
 * Marks a device revoked in config.json's `nodes` as written (#510, design 11.4):
 * `devices.<id>.revoked: true`. False when there is no such device or it was marked already; the
 * section is changed in place only when it is true.
 */
export function markRevoked(nodes: Record<string, unknown>, id: string): boolean {
  if (id === LOCAL || !isObject(nodes.devices) || !Object.hasOwn(nodes.devices, id)) return false
  const entry = nodes.devices[id]
  if (!isObject(entry) || entry.revoked === true) return false
  entry.revoked = true
  return true
}
