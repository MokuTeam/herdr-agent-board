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
