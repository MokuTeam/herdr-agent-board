// What the master sends on to a node (#501, docs/design/nodes 5, 6.2, 12): which requests name a
// key of another device, the path the node knows them by, what is refused for a node key as for a
// phone, and how a bulk request is split by device and its answers put back together. Pure: the
// route that forwards is server/routes/node-proxy.ts.
//
// A key of another device is `@<device>:<key>` (core/nodes.ts nodeKey). It is read from the path
// as it came, one percent-encoded segment decoded, so `/api/session/%40server-1%3As1` and
// `/api/session/@server-1:s1` are the same request. What the node is sent carries its own key.
import { nodeKey, parseNodeKey } from './nodes.ts'

/** The areas whose path names a key: a session and its sheet, its terminal, a launch's card. */
export type KeyedArea = 'session' | 'term' | 'launch'

export interface KeyedPath {
  area: KeyedArea
  device: string
  /** The key the node knows. */
  key: string
  /** What follows the key in the path as it came ('' or `/<more>`). */
  rest: string
}

const KEYED = /^\/api\/(session|term|launch)\/([^/]+)(\/.*)?$/

/** One segment decoded; null when it does not decode. */
function segment(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/** A request path (as it came) that names another device's key, or null for every other path. */
export function keyedPath(rawPath: string): KeyedPath | null {
  const m = KEYED.exec(rawPath)
  if (!m) return null
  const key = segment(m[2] ?? '')
  const at = key === null ? null : parseNodeKey(key)
  return at ? { area: m[1] as KeyedArea, device: at.device, key: at.key, rest: m[3] ?? '' } : null
}

/** The same path for the node: its own key, one segment, percent-encoded. */
export function nodePath(p: Pick<KeyedPath, 'area' | 'key' | 'rest'>): string {
  return `/api/${p.area}/${encodeURIComponent(p.key)}${p.rest}`
}

/**
 * What acts on the screen of the computer the session runs on, which the owner at the master has no
 * use for (12): focusing herdr's pane, a launch's tab or a shell's tab there. Refused 403 desktop for
 * a node key, as for a phone (core/remote.ts desktopOnly).
 */
export function desktopRest(area: KeyedArea, rest: string): boolean {
  if (area === 'session') return rest === '/focus'
  if (area === 'term') return /^\/shell\/focus$/.test(rest)
  return rest === '/focus'
}

/** A key of the request's own, as it came in a body or a query: another device's, or null. */
export function deviceKey(value: unknown): { device: string; key: string } | null {
  return typeof value === 'string' ? parseNodeKey(value) : null
}

/** One target a bulk request asked for, by where it goes. */
export interface Asked {
  /** As the request had it. */
  asked: string
  /** As the node knows it. */
  key: string
}

export interface Split {
  /** This computer's targets, as they came (what is not a string too) and in their order. */
  local: unknown[]
  /** Each device's targets, in the order the devices first come. */
  devices: Map<string, Asked[]>
}

/** A bulk request's targets by device: a key with a device's prefix goes there, everything else stays here. */
export function splitTargets(targets: readonly unknown[]): Split {
  const local: unknown[] = []
  const devices = new Map<string, Asked[]>()
  for (const t of targets) {
    const at = deviceKey(t)
    if (!at) {
      local.push(t)
      continue
    }
    const list = devices.get(at.device) ?? []
    list.push({ asked: t as string, key: at.key })
    devices.set(at.device, list)
  }
  return { local, devices }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A node's key, or a schedule entry's id, as the master names it: `@<device>:` before it; anything else as it is. */
function prefixed(device: string, v: unknown): unknown {
  return typeof v === 'string' && v && !parseNodeKey(v) ? nodeKey(device, v) : v
}

/**
 * One outcome of a node's bulk answer (services/sleep.ts SleepOutcome, services/move.ts MoveOutcome,
 * an archive's done or failed entry) as the master's page reads it: its key and entry ids with the
 * device's prefix, its target as the request asked for it.
 */
export function rekeyOutcome(device: string, raw: unknown, asked: readonly Asked[]): Record<string, unknown> | null {
  if (!isObject(raw)) return null
  const out: Record<string, unknown> = { ...raw }
  if (typeof raw.target === 'string')
    out.target = asked.find(a => a.key === raw.target)?.asked ?? prefixed(device, raw.target)
  for (const field of ['key', 'id'] as const) if (field in raw) out[field] = prefixed(device, raw[field])
  // A move's sleep (when free): its entry and session are the node's too.
  if (isObject(raw.sleep)) {
    const sleep: Record<string, unknown> = { ...raw.sleep }
    for (const field of ['key', 'id', 'target'] as const)
      if (field in sleep) sleep[field] = prefixed(device, sleep[field])
    out.sleep = sleep
  }
  return out
}

/** The outcomes in the order their targets were asked for; one not found among them goes last, as it came. */
export function inAskedOrder<T extends Record<string, unknown>>(
  asked: readonly unknown[],
  outcomes: T[],
  field: 'target' | 'key',
): T[] {
  const at = (o: T): number => {
    const i = asked.indexOf(o[field])
    return i < 0 ? asked.length : i
  }
  return outcomes
    .map((o, i) => ({ o, i }))
    .sort((a, b) => at(a.o) - at(b.o) || a.i - b.i)
    .map(x => x.o)
}

/** What of a request goes on to a node: never a cookie, the caller's Authorization, Origin or a hop header. */
export const FORWARDED_REQUEST_HEADERS: readonly string[] = ['content-type', 'x-filename', 'range', 'accept']

/** What of a node's answer comes back: what the page reads of it, never a cookie or a hop header. */
export const FORWARDED_ANSWER_HEADERS: readonly string[] = [
  'content-type',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'cache-control',
  'content-security-policy',
  'x-content-type-options',
  'retry-after',
]

/** Only `names` of `from`. */
export function pickHeaders(from: Headers, names: readonly string[]): Headers {
  const out = new Headers()
  for (const name of names) {
    const v = from.get(name)
    if (v !== null) out.set(name, v)
  }
  return out
}

/** A query without `drop`, with `set`: what the node's route reads of it. */
export function nodeQuery(search: URLSearchParams, drop: readonly string[], set: Record<string, string> = {}): string {
  const q = new URLSearchParams(search)
  for (const name of drop) q.delete(name)
  for (const [name, value] of Object.entries(set)) q.set(name, value)
  const s = q.toString()
  return s ? `?${s}` : ''
}
