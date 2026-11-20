// Nodes (#496), their pure rules: config.json's `nodes` (this board is a master) and `node` (this
// board is a node), device ids, the `@<device>:` key prefix that keeps the keys of different
// machines apart, and the thresholds a device starts with. No I/O: the link, the door and the
// placer read these.
//
// Roles are keys. A board without either key sees nothing of this anywhere; one board may hold both:
//   "nodes": { "id": "laptop", "order": ["server-1", "local"], "devices": { "server-1": { ... } } }
//   "node": { "id": "server-1", "port": 12430, "workRoot": "~/work" }

/** This computer in the master's own `order` and `devices`. Only a word there: what crosses a link names the id. */
export const LOCAL = 'local'

/** The node's door, on 127.0.0.1, when `node.port` and a link's `port` do not say. */
export const NODE_PORT = 12430

/** A device id. `local` fits it but is reserved. No ":" and no "@", so a prefixed key splits one way only. */
export const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

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
  /** The master's profile id to the node's; a profile not named keeps its id. */
  profiles: Record<string, string>
  paused: boolean
  drain: boolean
  /** The node's `secrets.sinks`, sent with the bundle and read there by secretsConfig. */
  sinks: unknown
  /** Per MCP server: false, or { command, args, env }. */
  mcp: Record<string, unknown>
  /** Differences the owner has seen and accepts. */
  accept: string[]
}

/** What does not check out. Never a value: config.json may hold what the owner typed by mistake. */
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
  /** The usable devices, `local` always among them. A device with a problem is not here. */
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
/** A host, a user or a socket name: a string with no spaces and nothing that could end a command line. */
const isWord = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 255 && !/[\s\p{Cc}]/u.test(v)
const isDevice = (v: unknown): v is string => typeof v === 'string' && DEVICE_ID.test(v) && v !== LOCAL

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
  'sinks',
  'mcp',
  'accept',
]
const LINK_KEYS: Record<LinkConfig['kind'], string[]> = {
  ssh: ['kind', 'host', 'sshPort', 'user', 'port'],
  relay: ['kind', 'socket'],
  tailnet: ['kind', 'address', 'port'],
  direct: ['kind', 'url'],
}
const RELAY_KEYS = ['host', 'sshPort', 'user']
const NODE_KEYS = ['id', 'port', 'workRoot', 'listen', 'tls', 'relay']

function unknownKeys(o: Record<string, unknown>, known: readonly string[], at: string, out: string[]): void {
  for (const k of Object.keys(o)) if (!known.includes(k)) out.push(at ? `${at}.${k}` : k)
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

/** The thresholds a device is given from its first status (design 7.1); the owner may change them. */
export function defaultThresholds(hw: { memTotalMb: number; cpus: number }): {
  maxSessions: number
  minFreeMemMb: number
  maxLoad: number
} {
  const cpus = Math.max(1, Math.floor(hw.cpus))
  const bySize = Math.floor((hw.memTotalMb - 1500) / 1500)
  return {
    maxSessions: Math.min(Math.max(bySize, 1), 4 * cpus),
    minFreeMemMb: Math.max(1024, Math.round(0.15 * hw.memTotalMb)),
    maxLoad: 0.9,
  }
}

/** A link as config.json has it, or the keys that do not check out. */
function linkOf(raw: unknown, relay: boolean, bad: string[]): LinkConfig | null {
  if (!isObject(raw)) {
    bad.push(raw === undefined ? 'link:required' : 'link:type')
    return null
  }
  const kind = raw.kind as LinkConfig['kind']
  if (typeof kind !== 'string' || !Object.hasOwn(LINK_KEYS, kind)) {
    bad.push('link.kind:kind')
    return null
  }
  const before = bad.length
  const unknown: string[] = []
  unknownKeys(raw, LINK_KEYS[kind], 'link', unknown)
  for (const k of unknown) bad.push(`${k}:unknown`)
  const port = (key: string, dflt: number): number => {
    if (raw[key] === undefined) return dflt
    if (!isPort(raw[key])) bad.push(`link.${key}:port`)
    return raw[key] as number
  }
  const word = (key: string): string => {
    if (!isWord(raw[key])) bad.push(`link.${key}:${raw[key] === undefined ? 'required' : 'type'}`)
    return raw[key] as string
  }
  let link: LinkConfig
  if (kind === 'ssh') {
    link = { kind, host: word('host'), sshPort: port('sshPort', 22), user: word('user'), port: port('port', NODE_PORT) }
  } else if (kind === 'relay') {
    link = { kind, socket: word('socket') }
    if (!relay) bad.push('link.kind:relay')
  } else if (kind === 'tailnet') {
    link = { kind, address: word('address'), port: port('port', NODE_PORT) }
  } else {
    const url = raw.url
    let ok = false
    if (typeof url === 'string' && isWord(url))
      try {
        const u = new URL(url)
        ok = u.protocol === 'http:' || u.protocol === 'https:'
      } catch {}
    if (!ok) bad.push(`link.url:${url === undefined ? 'required' : 'url'}`)
    link = { kind, url: url as string }
  }
  return bad.length === before ? link : null
}

/** One device as config.json has it, or null with its problems added to `problems`. */
function deviceOf(
  id: string,
  raw: unknown,
  relay: boolean,
  selfId: string,
  problems: NodesProblem[],
): DeviceConfig | null {
  const bad: string[] = []
  if (!DEVICE_ID.test(id)) bad.push(':id')
  else if (id === selfId) bad.push(':self')
  const o = isObject(raw) ? raw : {}
  if (!isObject(raw)) bad.push(':type')
  const unknown: string[] = []
  unknownKeys(o, DEVICE_KEYS, '', unknown)
  for (const k of unknown) bad.push(`${k}:unknown`)
  const local = id === LOCAL
  let link: LinkConfig | null = null
  if (local) {
    if (o.link !== undefined) bad.push('link:local')
  } else if (isObject(raw)) link = linkOf(o.link, relay, bad)
  const num = (key: string, ok: (n: number) => boolean): number | null => {
    const v = o[key]
    if (v === undefined || v === null) return null
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) bad.push(`${key}:number`)
    return v as number
  }
  const strings = (key: string): string[] => {
    const v = o[key]
    if (v === undefined) return []
    if (!Array.isArray(v) || !v.every(isWord)) {
      bad.push(`${key}:type`)
      return []
    }
    return [...new Set(v as string[])]
  }
  const flag = (key: string): boolean => {
    const v = o[key]
    if (v === undefined) return false
    if (typeof v !== 'boolean') bad.push(`${key}:type`)
    return v === true
  }
  const title = o.title === undefined ? id : typeof o.title === 'string' && o.title.trim() ? o.title.trim() : null
  if (title === null) bad.push('title:type')
  const profiles: Record<string, string> = {}
  if (o.profiles !== undefined) {
    if (!isObject(o.profiles)) bad.push('profiles:type')
    else
      for (const [from, to] of Object.entries(o.profiles))
        if (isWord(from) && isWord(to)) profiles[from] = to
        else bad.push(`profiles.${from}:type`)
  }
  const mcp: Record<string, unknown> = {}
  if (o.mcp !== undefined) {
    if (!isObject(o.mcp)) bad.push('mcp:type')
    else
      for (const [name, v] of Object.entries(o.mcp))
        if (v === false || isObject(v)) mcp[name] = v
        else bad.push(`mcp.${name}:type`)
  }
  if (o.sinks !== undefined && !isObject(o.sinks)) bad.push('sinks:type')
  const device: DeviceConfig = {
    id,
    title: title ?? id,
    link,
    maxSessions: num('maxSessions', n => Number.isInteger(n) && n >= 1),
    minFreeMemMb: num('minFreeMemMb', n => Number.isInteger(n) && n >= 0),
    maxLoad: num('maxLoad', n => n > 0),
    tags: strings('tags'),
    profiles,
    paused: flag('paused'),
    drain: flag('drain'),
    sinks: o.sinks ?? {},
    mcp,
    accept: strings('accept'),
  }
  for (const b of bad) {
    const at = b.lastIndexOf(':')
    problems.push({ device: id, key: b.slice(0, at), why: b.slice(at + 1) })
  }
  return bad.length ? null : device
}

/** An ssh login on the owner's server: `nodes.relay`, and `node.relay` with its socket. */
function relayOf(raw: unknown, at: string, keys: readonly string[], problems: NodesProblem[]) {
  const bad: string[] = []
  if (!isObject(raw)) {
    problems.push({ key: at, why: 'type' })
    return null
  }
  unknownKeys(raw, keys, at, bad)
  for (const k of bad) problems.push({ key: k, why: 'unknown' })
  let ok = !bad.length
  for (const k of keys)
    if (k === 'sshPort' ? raw[k] !== undefined && !isPort(raw[k]) : !isWord(raw[k])) {
      problems.push({ key: `${at}.${k}`, why: raw[k] === undefined ? 'required' : 'type' })
      ok = false
    }
  if (!ok) return null
  return {
    host: raw.host as string,
    sshPort: (raw.sshPort as number | undefined) ?? 22,
    user: raw.user as string,
    ...(keys.includes('socket') && { socket: raw.socket as string }),
  }
}

/**
 * config.json's `nodes` as the master uses it, or null while it is not on (no key, `false`,
 * anything but an object). A device with an unknown key or a bad value is left out of `devices`
 * and `order` and named in `problems`, never guessed at. A bad value of the section's own keys
 * is named too and gives what a board without the key does: `lanes` none, `whenFull` local,
 * no relay, the id from the host name.
 */
export function nodesConfig(raw: unknown, hostName = ''): NodesConfig | null {
  if (!isObject(raw)) return null
  const problems: NodesProblem[] = []
  const unknown: string[] = []
  unknownKeys(raw, TOP_KEYS, '', unknown)
  for (const k of unknown) problems.push({ key: k, why: 'unknown' })

  let id = deviceIdFromHost(hostName)
  if (raw.id !== undefined) {
    if (isDevice(raw.id)) id = raw.id
    else problems.push({ key: 'id', why: raw.id === LOCAL ? 'reserved' : 'id' })
  }

  let whenFull: NodesConfig['whenFull'] = 'local'
  if (raw.whenFull === 'wait') whenFull = 'wait'
  else if (raw.whenFull !== undefined && raw.whenFull !== 'local') problems.push({ key: 'whenFull', why: 'type' })

  let lanes: NodesConfig['lanes'] = []
  if (raw.lanes === 'all') lanes = 'all'
  else if (Array.isArray(raw.lanes) && raw.lanes.every(l => typeof l === 'string' && l.trim()))
    lanes = [...new Set((raw.lanes as string[]).map(l => l.trim().toLowerCase()))]
  else if (raw.lanes !== undefined && raw.lanes !== null) problems.push({ key: 'lanes', why: 'type' })

  const relay =
    raw.relay === undefined || raw.relay === null
      ? null
      : (relayOf(raw.relay, 'relay', RELAY_KEYS, problems) as NodesConfig['relay'])

  const devices: Record<string, DeviceConfig> = {}
  const named: string[] = []
  if (raw.devices !== undefined && !isObject(raw.devices)) problems.push({ key: 'devices', why: 'type' })
  else
    for (const [dev, v] of Object.entries(raw.devices ?? {})) {
      named.push(dev)
      const d = deviceOf(dev, v, relay !== null, id, problems)
      if (d) devices[dev] = d
    }
  devices[LOCAL] ??= deviceOf(LOCAL, {}, false, id, []) as DeviceConfig

  const order: string[] = []
  const listed = raw.order === undefined ? [] : Array.isArray(raw.order) ? raw.order : null
  if (listed === null) problems.push({ key: 'order', why: 'type' })
  for (const dev of listed ?? []) {
    if (typeof dev !== 'string') problems.push({ key: 'order', why: 'type' })
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
  const unknown: string[] = []
  unknownKeys(raw, NODE_KEYS, '', unknown)
  for (const k of unknown) problems.push({ key: k, why: 'unknown' })
  if (!isDevice(raw.id))
    problems.push({ key: 'id', why: raw.id === undefined ? 'required' : raw.id === LOCAL ? 'reserved' : 'id' })
  if (raw.port !== undefined && !isPort(raw.port)) problems.push({ key: 'port', why: 'port' })
  if (raw.workRoot !== undefined && !(typeof raw.workRoot === 'string' && raw.workRoot.trim()))
    problems.push({ key: 'workRoot', why: 'type' })
  if (raw.listen !== undefined && raw.listen !== 'loopback' && raw.listen !== 'tailnet')
    problems.push({ key: 'listen', why: 'type' })
  if (raw.tls !== undefined && typeof raw.tls !== 'boolean') problems.push({ key: 'tls', why: 'type' })
  const relay =
    raw.relay === undefined || raw.relay === null
      ? null
      : (relayOf(raw.relay, 'relay', [...RELAY_KEYS, 'socket'], problems) as NodeConfig['relay'])
  if (problems.length) return { config: null, problems }
  return {
    config: {
      id: raw.id as string,
      port: (raw.port as number | undefined) ?? NODE_PORT,
      workRoot: (raw.workRoot as string | undefined)?.trim() ?? '~/work',
      listen: (raw.listen as NodeConfig['listen'] | undefined) ?? 'loopback',
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

/** A key of another device's item as the master's payload and routes carry it: `@server-1:` + key. */
export function nodeKey(device: string, key: string): string {
  if (!isDevice(device)) throw new Error(`not a device id: ${JSON.stringify(device)}`)
  if (!key) throw new Error('an empty key')
  return `@${device}:${key}`
}

/**
 * A prefixed key split into its device and the key the node knows, or null for every key this
 * board makes itself: a Claude session id, `pane-<n>`, a pi file path, a Codex thread id never
 * start with "@".
 */
export function parseNodeKey(key: string): { device: string; key: string } | null {
  if (!key.startsWith('@')) return null
  const at = key.indexOf(':')
  if (at < 0) return null
  const device = key.slice(1, at)
  const rest = key.slice(at + 1)
  return isDevice(device) && rest ? { device, key: rest } : null
}

/** Whether a session of this lane may run on another device: `nodes.lanes` is "all" or names it. */
export function laneMayLeave(cfg: NodesConfig, lane: string): boolean {
  return cfg.lanes === 'all' || cfg.lanes.includes(lane.trim().toLowerCase())
}
