// A device's id and the prefixed keys of its items (#499, #500), on their own: no import, so the page
// script and core/work-cases.ts can split a key without core/nodes.ts, whose core/team.ts would bring
// a crypto shim into every board's page. core/nodes.ts re-exports these.

/** This computer in the master's own `order` and `devices`. Only a word there: what crosses a link names the id. */
export const LOCAL = 'local'

/** A device id. `local` fits it but is reserved. No ":" and no "@", so a prefixed key splits one way only. */
export const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

export const isDevice = (v: unknown): v is string => typeof v === 'string' && DEVICE_ID.test(v) && v !== LOCAL

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

/**
 * Matches a bare session key to the unique `@<device>:<key>` item in `items` when no exact
 * match exists. Returns null when `key` is empty, already prefixed, a machine-local `pane-*`
 * key, an owner service key, directly present in `items`, or matches zero or more than one
 * node item.
 */
export function matchNodeKey(key: string, items: readonly { key: string }[]): string | null {
  if (!key || parseNodeKey(key) || key.startsWith('pane-') || key.startsWith('owner-service-')) return null
  if (items.some(i => i.key === key)) return null
  let hit: string | null = null
  for (const item of items) {
    if (parseNodeKey(item.key)?.key !== key) continue
    if (hit !== null && hit !== item.key) return null
    hit = item.key
  }
  return hit
}

/** The session's full key as the board knows it (`@<device>:<key>` when uniquely matched), else `key`. */
export function resolveBoardKey(key: string, items: readonly { key: string }[]): string {
  return matchNodeKey(key, items) ?? key
}

const UNPRINTABLE = /[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u

/**
 * Validates and normalizes a master's advertised public board URL (#744): https only, no
 * credentials, bounded length, and no control or bidi characters. Returns null when invalid.
 */
export function validMasterUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.length > 512 || UNPRINTABLE.test(s)) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null
    return u.href
  } catch {
    return null
  }
}
